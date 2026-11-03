// 自建油耗账本 · Cloudflare Worker 入口
// 路由：/api/* 业务接口；其余路径由 Workers Assets（public/）承接

import { json, err, safeEqual, nowISO, normDatetime, num, str, bool01, toCSV, disposition } from "./util.js";
import * as db from "./db.js";
import { sendMail, smtpProbe } from "./email.js";

const FUEL_GRADES = ["92#", "95#", "98#", "0#", "电"];
const EXPENSE_CATEGORIES = ["裸车和税费", "保险和交通规费", "维修保养", "配件费", "交通罚款", "其它"];

// 导出 CSV 表头与小熊油耗导出一致，保证老用户习惯与再导入兼容
const FUEL_CSV_HEADERS = ["日期时间", "总里程", "机显单价", "加油量", "机显金额", "实付金额", "油号", "加满", "亮灯", "漏记", "油耗", "加油站名称", "备注"];
const EXP_CSV_HEADERS = ["日期时间", "费用类型名称", "金额", "备注"];

function fuelRow(r) {
  return [
    r.filled_at, r.odometer, r.unit_price, r.liters, r.amount_display, r.amount_paid,
    r.fuel_grade, r.is_full ? "是" : "否", r.is_low_light ? "是" : "否", r.is_missed ? "是" : "否",
    r.consumption === null || r.consumption === undefined ? "" : r.consumption,
    r.station || "", r.note || "",
  ];
}
function expRow(r) {
  return [r.occurred_at, r.category, r.amount, r.note || ""];
}

// ---------- 邮件备份 ----------

function summaryText(s, title) {
  return [
    title,
    "",
    `加油记录：${s.fuel_count} 次，共 ${s.liters_total} L，油费实付 ${s.fuel_paid_total} 元`,
    `其他费用：${s.expense_count} 笔，共 ${s.expense_total} 元`,
    `花费合计：${s.total_cost} 元`,
    `平均油耗：${s.avg_consumption === null ? "—" : s.avg_consumption + " L/100km"}（按可计算段加权）`,
    `里程范围：${s.min_odo} ~ ${s.max_odo} km`,
    "",
    "本邮件由「油耗账本」自动发送，数据同时存于 Cloudflare D1，可随时在网页端导出。",
  ].join("\n");
}

async function fullBackupAttachments(dbConn, vehicleId) {
  const data = await db.exportAll(dbConn, vehicleId);
  return [
    { name: "油耗记录.csv", mime: "text/csv", content: toCSV(FUEL_CSV_HEADERS, data.fuel.map(fuelRow)) },
    { name: "费用记录.csv", mime: "text/csv", content: toCSV(EXP_CSV_HEADERS, data.expense.map(expRow)) },
    { name: "全量备份.json", mime: "application/json", content: JSON.stringify({ exported_at: nowISO(), ...data }, null, 2) },
  ];
}

async function sendDailyBackup(env, dbConn, vehicleId, kind = "daily") {
  const to = env.BACKUP_TO || env.SMTP_USER;
  const s = await db.summary(dbConn, vehicleId);
  const attachments = await fullBackupAttachments(dbConn, vehicleId);
  const subject = `油耗账本 · 每日全量备份 ${nowISO().slice(0, 10)}`;
  await sendMail(env, { to, subject, text: summaryText(s, "每日全量备份（附件含油耗/费用 CSV 与 JSON 全量快照）"), attachments });
  await db.logEmail(dbConn, { kind, subject, ok: true });
}

// 数据变更后的即时摘要邮件（默认 5 分钟限流一封）
async function maybeChangeEmail(ctx, env, dbConn, event, extra, vehicleId = 1) {
  const interval = Number(env.CHANGE_EMAIL_INTERVAL || 300);
  const last = await db.metaGet(dbConn, "last_change_email_at");
  const now = Date.now();
  if (last && now - Number(last) < interval * 1000) return { skipped: true };
  await db.metaSet(dbConn, "last_change_email_at", String(now));
  ctx.waitUntil((async () => {
    try {
      const to = env.BACKUP_TO || env.SMTP_USER;
      const s = await db.summary(dbConn, vehicleId);
      const today = nowISO().slice(0, 10);
      const [fuelRows, expRows] = await Promise.all([
        db.listFuel(dbConn, { vehicleId, page: 1, size: 500 }),
        db.listExpense(dbConn, { vehicleId, page: 1, size: 500 }),
      ]);
      const todayFuel = fuelRows.rows.filter(r => r.filled_at.slice(0, 10) === today);
      const todayExp = expRows.rows.filter(r => r.occurred_at.slice(0, 10) === today);
      const subject = `油耗账本 · ${event} ${today}`;
      const body = [
        `操作：${event}`,
        extra || "",
        "",
        `今日加油 ${todayFuel.length} 笔${todayFuel.length ? "：" + todayFuel.map(r => `${r.filled_at.slice(11, 16)} ${r.liters}L/${r.amount_paid}元`).join("；") : ""}`,
        `今日其他费用 ${todayExp.length} 笔${todayExp.length ? "：" + todayExp.map(r => `${r.category} ${r.amount}元`).join("；") : ""}`,
        "",
        summaryText(s, "—— 当前累计 ——"),
      ].join("\n");
      const attachments = [];
      if (todayFuel.length) {
        attachments.push({ name: `今日油耗-${today}.csv`, mime: "text/csv", content: toCSV(FUEL_CSV_HEADERS, todayFuel.map(fuelRow)) });
      }
      if (todayExp.length) {
        attachments.push({ name: `今日费用-${today}.csv`, mime: "text/csv", content: toCSV(EXP_CSV_HEADERS, todayExp.map(expRow)) });
      }
      await sendMail(env, { to, subject, text: body, attachments });
      await db.logEmail(dbConn, { kind: "change", subject, ok: true });
    } catch (e) {
      await db.logEmail(dbConn, { kind: "change", subject: event, ok: false, error: String(e && e.message || e) });
    }
  })());
  return { queued: true };
}

// ---------- 请求体验证 ----------

function parseFuel(body) {
  const liters = num(body.liters, { min: 0.01, max: 5000, required: true });
  const unitPrice = num(body.unit_price, { min: 0, max: 100 });
  const odometer = num(body.odometer, { min: 0, max: 9999999, required: true });
  let amountDisplay = num(body.amount_display, { min: 0, max: 9999999 });
  if (amountDisplay === null && unitPrice !== null) amountDisplay = Math.round(unitPrice * liters * 100) / 100;
  const amountPaid = num(body.amount_paid, { min: 0, max: 9999999, def: amountDisplay });
  const grade = str(body.fuel_grade, { max: 10, def: "92#" });
  if (!FUEL_GRADES.includes(grade)) throw new Error("油号必须是: " + FUEL_GRADES.join("/"));
  return {
    vehicle_id: num(body.vehicle_id, { min: 1, def: 1 }),
    filled_at: normDatetime(body.filled_at),
    odometer,
    unit_price: unitPrice,
    liters,
    amount_display: amountDisplay,
    amount_paid: amountPaid,
    fuel_grade: grade,
    is_full: bool01(body.is_full === undefined ? true : body.is_full),
    is_low_light: bool01(body.is_low_light),
    is_missed: bool01(body.is_missed),
    station: str(body.station, { max: 100 }),
    note: str(body.note, { max: 2000 }),
  };
}

function parseExpense(body) {
  const category = str(body.category, { max: 50, required: true });
  if (!EXPENSE_CATEGORIES.includes(category)) throw new Error("费用类型必须是: " + EXPENSE_CATEGORIES.join("/"));
  return {
    vehicle_id: num(body.vehicle_id, { min: 1, def: 1 }),
    occurred_at: normDatetime(body.occurred_at),
    category,
    amount: num(body.amount, { min: 0, max: 99999999, required: true }),
    note: str(body.note, { max: 2000 }),
  };
}

// 导入数据规范化：兼容系统导出 JSON 与 tools/xls2json.py 生成的 JSON 键名
function parseImport(payload) {
  const fuelIn = Array.isArray(payload.fuel) ? payload.fuel : (Array.isArray(payload.fuel_records) ? payload.fuel_records : []);
  const expIn = Array.isArray(payload.expense) ? payload.expense : (Array.isArray(payload.expense_records) ? payload.expense_records : []);
  if (fuelIn.length + expIn.length === 0) throw new Error("导入内容为空");
  if (fuelIn.length + expIn.length > 5000) throw new Error("单次导入不能超过 5000 条");
  const fuel = [];
  for (const r of fuelIn) {
    fuel.push({
      filled_at: normDatetime(r.filled_at),
      odometer: num(r.odometer, { min: 0, max: 9999999, required: true }),
      liters: num(r.liters, { min: 0, max: 5000, required: true }),
      unit_price: num(r.unit_price, { min: 0, max: 100 }),
      amount_display: num(r.amount_display, { min: 0, max: 9999999 }),
      amount_paid: num(r.amount_paid, { min: 0, max: 9999999 }),
      fuel_grade: FUEL_GRADES.includes(r.fuel_grade) ? r.fuel_grade : "92#",
      is_full: bool01(r.is_full),
      is_low_light: bool01(r.is_low_light),
      is_missed: bool01(r.is_missed),
      station: str(r.station, { max: 100 }),
      note: str(r.note, { max: 2000 }),
    });
  }
  const expense = [];
  for (const r of expIn) {
    expense.push({
      occurred_at: normDatetime(r.occurred_at),
      category: EXPENSE_CATEGORIES.includes(r.category) ? r.category : "其它",
      amount: num(r.amount, { min: 0, max: 99999999, required: true }),
      note: str(r.note, { max: 2000 }),
    });
  }
  return { fuel, expense };
}

// ---------- Worker ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 静态资源（SPA）
      if (!path.startsWith("/api/")) {
        if (env.ASSETS) return env.ASSETS.fetch(request);
        return err("Not Found", 404);
      }

      // 登录验证（免鉴权）
      if (path === "/api/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!safeEqual(String(body.token || ""), env.API_TOKEN || "")) return err("口令不正确", 401);
        return json({ ok: true });
      }

      // 临时 SMTP 诊断（?t=登录口令）：探测 163/qq/gmail 465/587 是否拒绝 Cloudflare 出口。
      // 结果同时写入 email_log（kind=diag），便于远程核对。诊断完成后可删除本段。
      if (path === "/api/_smtpdiag") {
        const t = url.searchParams.get("t") || "";
        if (!safeEqual(t, env.API_TOKEN || "")) return err("未授权", 401);
        const targets = [
          ["smtp.163.com", 465, true],
          ["smtp.163.com", 587, false],
          ["smtp.qq.com", 465, true],
          ["smtp.gmail.com", 465, true],
        ];
        const results = [];
        for (const [h, p, s] of targets) results.push(await smtpProbe(h, p, s));
        const brief = results.map(r => `${r.host}:${r.port} ${r.ok ? "OK" : "FAIL<" + r.steps[r.steps.length - 1].stage + " " + r.steps[r.steps.length - 1].info + ">"}`).join(" | ");
        try {
          await db.logEmail(env.DB, { kind: "diag", subject: "SMTP 探测", ok: results.some(r => r.ok), error: brief.slice(0, 500) });
        } catch {}
        return json({ ok: true, probed_at: nowISO(), brief, results });
      }

      // 统一 Bearer 鉴权
      const auth = request.headers.get("authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!safeEqual(token, env.API_TOKEN || "")) return err("未授权，请先登录", 401);

      const DB = env.DB;
      const method = request.method;

      // 初始化数据
      if (path === "/api/bootstrap" && method === "GET") {
        const [vehicles, summary] = await Promise.all([db.listVehicles(DB), db.summary(DB, 1)]);
        return json({ ok: true, vehicles, summary, grades: FUEL_GRADES, categories: EXPENSE_CATEGORIES });
      }

      // ---- 油耗记录 ----
      if (path === "/api/fuel" && method === "GET") {
        const r = await db.listFuel(DB, {
          year: url.searchParams.get("year"),
          grade: url.searchParams.get("grade"),
          q: url.searchParams.get("q"),
          page: url.searchParams.get("page"),
          size: url.searchParams.get("size"),
        });
        return json({ ok: true, ...r });
      }
      if (path === "/api/fuel" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rec = parseFuel(body);
        const id = await db.insertFuel(DB, rec);
        await db.recomputeConsumption(DB, rec.vehicle_id);
        const row = await db.getFuel(DB, id);
        const em = await maybeChangeEmail(ctx, env, DB, "新增加油记录",
          `${row.filled_at.slice(0, 10)} ${row.liters} L / ${row.amount_paid} 元，里程 ${row.odometer} km${row.consumption !== null ? "，油耗 " + row.consumption + " L/100km" : ""}`, rec.vehicle_id);
        return json({ ok: true, id, record: row, email: em });
      }
      const fuelMatch = path.match(/^\/api\/fuel\/(\d+)$/);
      if (fuelMatch) {
        const id = Number(fuelMatch[1]);
        if (method === "PUT") {
          const body = await request.json().catch(() => ({}));
          const old = await db.getFuel(DB, id);
          if (!old) return err("记录不存在", 404);
          const rec = parseFuel(body);
          await db.updateFuel(DB, id, rec);
          await db.recomputeConsumption(DB, rec.vehicle_id);
          const row = await db.getFuel(DB, id);
          const em = await maybeChangeEmail(ctx, env, DB, "修改加油记录", `记录 #${id} 已更新`, rec.vehicle_id);
          return json({ ok: true, record: row, email: em });
        }
        if (method === "DELETE") {
          const old = await db.getFuel(DB, id);
          if (!old) return err("记录不存在", 404);
          await db.deleteFuel(DB, id);
          await db.recomputeConsumption(DB, old.vehicle_id);
          const em = await maybeChangeEmail(ctx, env, DB, "删除加油记录", `删除 ${old.filled_at.slice(0, 10)} ${old.liters} L 记录`, old.vehicle_id);
          return json({ ok: true, email: em });
        }
      }

      // ---- 费用记录 ----
      if (path === "/api/expense" && method === "GET") {
        const r = await db.listExpense(DB, {
          year: url.searchParams.get("year"),
          category: url.searchParams.get("category"),
          page: url.searchParams.get("page"),
          size: url.searchParams.get("size"),
        });
        return json({ ok: true, ...r });
      }
      if (path === "/api/expense" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rec = parseExpense(body);
        const id = await db.insertExpense(DB, rec);
        const em = await maybeChangeEmail(ctx, env, DB, "新增费用记录", `${rec.occurred_at.slice(0, 10)} ${rec.category} ${rec.amount} 元`, rec.vehicle_id);
        return json({ ok: true, id, email: em });
      }
      const expMatch = path.match(/^\/api\/expense\/(\d+)$/);
      if (expMatch) {
        const id = Number(expMatch[1]);
        if (method === "PUT") {
          const body = await request.json().catch(() => ({}));
          const rec = parseExpense(body);
          const cnt = await DB.prepare("SELECT COUNT(*) AS n FROM expense_records WHERE id = ?").bind(id).first();
          if (!cnt || !cnt.n) return err("记录不存在", 404);
          await db.updateExpense(DB, id, rec);
          const em = await maybeChangeEmail(ctx, env, DB, "修改费用记录", `记录 #${id} 已更新`, rec.vehicle_id);
          return json({ ok: true, email: em });
        }
        if (method === "DELETE") {
          const old = await DB.prepare("SELECT * FROM expense_records WHERE id = ?").bind(id).first();
          if (!old) return err("记录不存在", 404);
          await db.deleteExpense(DB, id);
          const em = await maybeChangeEmail(ctx, env, DB, "删除费用记录", `删除 ${old.occurred_at.slice(0, 10)} ${old.category} 记录`, old.vehicle_id);
          return json({ ok: true, email: em });
        }
      }

      // ---- 统计 ----
      if (path === "/api/stats" && method === "GET") {
        const [summary, monthly] = await Promise.all([db.summary(DB, 1), db.monthlyStats(DB, 1)]);
        return json({ ok: true, summary, monthly });
      }

      // ---- 导出 ----
      if (path === "/api/export" && method === "GET") {
        const format = url.searchParams.get("format") || "json";
        const type = url.searchParams.get("type") || "fuel";
        const data = await db.exportAll(DB, 1);
        const stamp = nowISO().slice(0, 10);
        if (format === "json") {
          return new Response(JSON.stringify({ exported_at: nowISO(), ...data }, null, 2), {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": disposition(`油耗账本-全量备份-${stamp}.json`),
            },
          });
        }
        if (format === "csv") {
          const csv = type === "expense"
            ? toCSV(EXP_CSV_HEADERS, data.expense.map(expRow))
            : toCSV(FUEL_CSV_HEADERS, data.fuel.map(fuelRow));
          return new Response(csv, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": disposition(`${type === "expense" ? "费用记录" : "油耗记录"}-${stamp}.csv`),
            },
          });
        }
        return err("不支持的格式", 400);
      }

      // ---- 导入 ----
      if (path === "/api/import" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const payload = parseImport(body);
        const res = await db.importRecords(DB, payload, 1);
        ctx.waitUntil((async () => {
          try {
            const to = env.BACKUP_TO || env.SMTP_USER;
            const s = await db.summary(DB, 1);
            const subject = `油耗账本 · 导入完成 ${nowISO().slice(0, 10)}`;
            await sendMail(env, { to, subject, text: summaryText(s, `本次导入：油耗 ${res.nFuel} 条、费用 ${res.nExp} 条，已按加满链重算油耗。`) });
            await db.logEmail(DB, { kind: "import", subject, ok: true });
          } catch (e) {
            await db.logEmail(DB, { kind: "import", subject: "导入完成", ok: false, error: String(e && e.message || e) });
          }
        })());
        return json({ ok: true, imported: res });
      }

      // ---- 手动备份 ----
      if (path === "/api/backup" && method === "POST") {
        ctx.waitUntil((async () => {
          try {
            await sendDailyBackup(env, DB, 1, "manual");
          } catch (e) {
            await db.logEmail(DB, { kind: "manual", subject: "手动备份", ok: false, error: String(e && e.message || e) });
          }
        })());
        return json({ ok: true, message: "备份邮件已加入发送队列，请稍后在「发信记录」中查看结果" });
      }
      if (path === "/api/backup/log" && method === "GET") {
        return json({ ok: true, rows: await db.emailLog(DB, 30) });
      }

      return err("接口不存在", 404);
    } catch (e) {
      return err(e && e.message ? e.message : String(e), 400);
    }
  },

  // 每日定时全量备份（wrangler.toml: crons = ["0 14 * * *"]，UTC 14:00 = 北京时间 22:00）
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await sendDailyBackup(env, env.DB, 1, "daily");
      } catch (e) {
        console.error("daily backup failed:", e);
        try {
          await db.logEmail(env.DB, { kind: "daily", subject: "每日全量备份", ok: false, error: String(e && e.message || e) });
        } catch {}
      }
    })());
  },
};
