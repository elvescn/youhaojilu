// D1 数据访问层 + 油耗重算（与小熊油耗口径完全一致）
//
// 油耗口径（经 133 条历史数据与原文件逐条校验一致）：
//   相邻两个「加满」记录构成一段 [P, F)；
//   段油耗 = P 之后至 F（含 F）的累计加油量 ÷ (odo[F] - odo[P]) × 100；
//   段内所有行（P 至 F 前一行）都显示该段油耗，F 行开始显示下一段；
//   P 之后至 F 任一行标记「漏记」时该段不可计算（NULL）；
//   首行前无加满锚点、末段之后无加满行，均为 NULL。

const FUEL_FIELDS = "id, vehicle_id, filled_at, odometer, unit_price, liters, amount_display, amount_paid, fuel_grade, is_full, is_low_light, is_missed, station, note, consumption, created_at, updated_at";
const EXP_FIELDS = "id, vehicle_id, occurred_at, category, amount, note, created_at, updated_at";

export async function listVehicles(db) {
  const { results } = await db.prepare("SELECT * FROM vehicles ORDER BY id").all();
  return results || [];
}

export async function getVehicle(db, id) {
  return db.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first();
}

// ---- 油耗记录 ----

export async function listFuel(db, { vehicleId = 1, year = null, grade = null, q = null, page = 1, size = 200 } = {}) {
  const where = ["vehicle_id = ?"];
  const args = [vehicleId];
  if (year) { where.push("substr(filled_at,1,4) = ?"); args.push(String(year)); }
  if (grade) { where.push("fuel_grade = ?"); args.push(grade); }
  if (q) { where.push("(station LIKE ? OR note LIKE ?)"); args.push("%" + q + "%", "%" + q + "%"); }
  const whereSql = "WHERE " + where.join(" AND ");
  const cnt = await db.prepare(`SELECT COUNT(*) AS n FROM fuel_records ${whereSql}`).bind(...args).first();
  const total = cnt ? cnt.n : 0;
  const size2 = Math.min(Math.max(Number(size) || 200, 1), 500);
  const pages = Math.max(Math.ceil(total / size2), 1);
  const page2 = Math.min(Math.max(Number(page) || 1, 1), pages);
  const { results } = await db.prepare(
    `SELECT ${FUEL_FIELDS} FROM fuel_records ${whereSql} ORDER BY filled_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...args, size2, (page2 - 1) * size2).all();
  return { total, page: page2, size: size2, pages, rows: results || [] };
}

export async function getFuel(db, id) {
  return db.prepare(`SELECT ${FUEL_FIELDS} FROM fuel_records WHERE id = ?`).bind(id).first();
}

export async function insertFuel(db, r) {
  const res = await db.prepare(
    `INSERT INTO fuel_records (vehicle_id, filled_at, odometer, unit_price, liters, amount_display, amount_paid, fuel_grade, is_full, is_low_light, is_missed, station, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    r.vehicle_id, r.filled_at, r.odometer, r.unit_price, r.liters, r.amount_display,
    r.amount_paid, r.fuel_grade, r.is_full, r.is_low_light, r.is_missed, r.station, r.note
  ).run();
  return res.meta.last_row_id;
}

export async function updateFuel(db, id, r) {
  await db.prepare(
    `UPDATE fuel_records SET vehicle_id=?, filled_at=?, odometer=?, unit_price=?, liters=?, amount_display=?, amount_paid=?, fuel_grade=?, is_full=?, is_low_light=?, is_missed=?, station=?, note=?, updated_at=datetime('now') WHERE id=?`
  ).bind(
    r.vehicle_id, r.filled_at, r.odometer, r.unit_price, r.liters, r.amount_display,
    r.amount_paid, r.fuel_grade, r.is_full, r.is_low_light, r.is_missed, r.station, r.note, id
  ).run();
}

export async function deleteFuel(db, id) {
  await db.prepare("DELETE FROM fuel_records WHERE id = ?").bind(id).run();
}

// ---- 费用记录 ----

export async function listExpense(db, { vehicleId = 1, year = null, category = null, page = 1, size = 200 } = {}) {
  const where = ["vehicle_id = ?"];
  const args = [vehicleId];
  if (year) { where.push("substr(occurred_at,1,4) = ?"); args.push(String(year)); }
  if (category) { where.push("category = ?"); args.push(category); }
  const whereSql = "WHERE " + where.join(" AND ");
  const cnt = await db.prepare(`SELECT COUNT(*) AS n FROM expense_records ${whereSql}`).bind(...args).first();
  const total = cnt ? cnt.n : 0;
  const size2 = Math.min(Math.max(Number(size) || 200, 1), 500);
  const pages = Math.max(Math.ceil(total / size2), 1);
  const page2 = Math.min(Math.max(Number(page) || 1, 1), pages);
  const { results } = await db.prepare(
    `SELECT ${EXP_FIELDS} FROM expense_records ${whereSql} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...args, size2, (page2 - 1) * size2).all();
  return { total, page: page2, size: size2, pages, rows: results || [] };
}

export async function insertExpense(db, r) {
  const res = await db.prepare(
    `INSERT INTO expense_records (vehicle_id, occurred_at, category, amount, note) VALUES (?, ?, ?, ?, ?)`
  ).bind(r.vehicle_id, r.occurred_at, r.category, r.amount, r.note).run();
  return res.meta.last_row_id;
}

export async function updateExpense(db, id, r) {
  await db.prepare(
    `UPDATE expense_records SET vehicle_id=?, occurred_at=?, category=?, amount=?, note=?, updated_at=datetime('now') WHERE id=?`
  ).bind(r.vehicle_id, r.occurred_at, r.category, r.amount, r.note, id).run();
}

export async function deleteExpense(db, id) {
  await db.prepare("DELETE FROM expense_records WHERE id = ?").bind(id).run();
}

// ---- 油耗重算 ----

export async function recomputeConsumption(db, vehicleId = 1) {
  const { results } = await db.prepare(
    "SELECT id, liters, odometer, is_full, is_missed FROM fuel_records WHERE vehicle_id = ? ORDER BY filled_at, id"
  ).bind(vehicleId).all();
  const rows = results || [];
  const consumption = new Array(rows.length).fill(null);
  const fulls = [];
  rows.forEach((r, i) => { if (r.is_full) fulls.push(i); });
  for (let k = 0; k < fulls.length - 1; k++) {
    const p = fulls[k];
    const f = fulls[k + 1];
    if (!(rows[f].odometer > rows[p].odometer)) continue;
    let sum = 0;
    let missed = false;
    for (let i = p + 1; i <= f; i++) {
      sum += rows[i].liters || 0;
      if (rows[i].is_missed) missed = true;
    }
    if (missed) continue;
    const val = Math.round((sum * 100 / (rows[f].odometer - rows[p].odometer)) * 100) / 100;
    for (let i = p; i < f; i++) consumption[i] = val;
  }
  // 始终写入计算值（不跳过「无变化」行）：本地 miniflare D1 在单请求内对先前写入/
  // 删除的可见性不一致，跳过优化会让“应重置为 NULL”的段油耗漏写；始终写入可自愈。
  const stmts = rows.map((r, i) =>
    db.prepare("UPDATE fuel_records SET consumption = ? WHERE id = ?").bind(consumption[i], r.id));
  for (let i = 0; i < stmts.length; i += 40) {
    await db.batch(stmts.slice(i, i + 40));
  }
  return rows.length;
}

// ---- 统计 ----

export async function summary(db, vehicleId = 1) {
  const f = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(liters),0) AS liters, COALESCE(SUM(amount_paid),0) AS paid,
            COALESCE(MAX(odometer),0) AS max_odo, COALESCE(MIN(odometer),0) AS min_odo,
            SUM(CASE WHEN consumption IS NOT NULL THEN 1 ELSE 0 END) AS n_consumption
     FROM fuel_records WHERE vehicle_id = ?`
  ).bind(vehicleId).first();
  const e = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM expense_records WHERE vehicle_id = ?`
  ).bind(vehicleId).first();
  // 平均油耗：按「段」加权 = 总加油量（可计算段）÷ 总里程（可计算段）
  const seg = await db.prepare(
    `WITH ordered AS (
       SELECT id, liters, odometer, is_full, is_missed,
              ROW_NUMBER() OVER (ORDER BY filled_at, id) AS rn
       FROM fuel_records WHERE vehicle_id = ?
     ),
     fulls AS (SELECT rn FROM ordered WHERE is_full = 1),
     segs AS (SELECT rn AS ps, LEAD(rn) OVER (ORDER BY rn) AS pe FROM fulls),
     segval AS (
       SELECT s.ps, s.pe,
              (SELECT SUM(o.liters) FROM ordered o WHERE o.rn > s.ps AND o.rn <= s.pe) AS liters_sum,
              (SELECT o.odometer FROM ordered o WHERE o.rn = s.ps) AS odo_p,
              (SELECT o.odometer FROM ordered o WHERE o.rn = s.pe) AS odo_f,
              (SELECT COUNT(*) FROM ordered o WHERE o.rn > s.ps AND o.rn <= s.pe AND o.is_missed = 1) AS missed
       FROM segs s WHERE s.pe IS NOT NULL
     )
     SELECT COALESCE(SUM(CASE WHEN missed = 0 AND odo_f > odo_p THEN liters_sum END),0) AS liters_ok,
            COALESCE(SUM(CASE WHEN missed = 0 AND odo_f > odo_p THEN odo_f - odo_p END),0) AS km_ok
     FROM segval`
  ).bind(vehicleId).first();
  const avg = seg && seg.km_ok > 0 ? Math.round(seg.liters_ok * 100 / seg.km_ok * 100) / 100 : null;
  return {
    fuel_count: f ? f.n : 0,
    liters_total: f ? Math.round(f.liters * 100) / 100 : 0,
    fuel_paid_total: f ? Math.round(f.paid * 100) / 100 : 0,
    max_odo: f ? f.max_odo : 0,
    min_odo: f ? f.min_odo : 0,
    km_covered: f ? Math.max(f.max_odo - f.min_odo, 0) : 0,
    consumption_count: f ? (f.n_consumption || 0) : 0,
    avg_consumption: avg,
    expense_count: e ? e.n : 0,
    expense_total: e ? Math.round(e.amount * 100) / 100 : 0,
    total_cost: f && e ? Math.round((f.paid + e.amount) * 100) / 100 : 0,
  };
}

export async function monthlyStats(db, vehicleId = 1) {
  const { results } = await db.prepare(
    `SELECT substr(filled_at,1,7) AS month,
            ROUND(SUM(liters),2) AS liters,
            ROUND(SUM(amount_paid),2) AS paid,
            COUNT(*) AS n,
            MAX(odometer) - MIN(odometer) AS km
     FROM fuel_records WHERE vehicle_id = ? GROUP BY month ORDER BY month`
  ).bind(vehicleId).all();
  const fuel = (results || []).map(r => ({
    month: r.month, liters: r.liters, paid: r.paid, count: r.n,
    consumption: r.km > 0 ? Math.round(r.liters * 100 / r.km * 100) / 100 : null,
  }));
  const { results: er } = await db.prepare(
    `SELECT substr(occurred_at,1,7) AS month, category, ROUND(SUM(amount),2) AS amount
     FROM expense_records WHERE vehicle_id = ? GROUP BY month, category ORDER BY month`
  ).bind(vehicleId).all();
  const expByMonth = {};
  for (const r of (er || [])) {
    expByMonth[r.month] = expByMonth[r.month] || {};
    expByMonth[r.month][r.category] = (expByMonth[r.month][r.category] || 0) + r.amount;
  }
  return { fuel, expenseByMonth: expByMonth };
}

// ---- 导出 / 导入 ----

export async function exportAll(db, vehicleId = 1) {
  const { results: fuel } = await db.prepare(
    `SELECT ${FUEL_FIELDS} FROM fuel_records WHERE vehicle_id = ? ORDER BY filled_at, id`
  ).bind(vehicleId).all();
  const { results: expense } = await db.prepare(
    `SELECT ${EXP_FIELDS} FROM expense_records WHERE vehicle_id = ? ORDER BY occurred_at, id`
  ).bind(vehicleId).all();
  return { fuel: fuel || [], expense: expense || [] };
}

export async function importRecords(db, { fuel = [], expense = [] }, vehicleId = 1) {
  let nFuel = 0;
  let nExp = 0;
  for (let i = 0; i < fuel.length; i += 40) {
    const batch = fuel.slice(i, i + 40).map(r => db.prepare(
      `INSERT INTO fuel_records (vehicle_id, filled_at, odometer, unit_price, liters, amount_display, amount_paid, fuel_grade, is_full, is_low_light, is_missed, station, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      vehicleId, r.filled_at, r.odometer, r.unit_price ?? null, r.liters, r.amount_display ?? null,
      r.amount_paid ?? null, r.fuel_grade || "92#", r.is_full ? 1 : 0, r.is_low_light ? 1 : 0,
      r.is_missed ? 1 : 0, r.station || "", r.note || ""
    ));
    await db.batch(batch);
    nFuel += batch.length;
  }
  for (let i = 0; i < expense.length; i += 40) {
    const batch = expense.slice(i, i + 40).map(r => db.prepare(
      `INSERT INTO expense_records (vehicle_id, occurred_at, category, amount, note) VALUES (?, ?, ?, ?, ?)`
    ).bind(vehicleId, r.occurred_at, r.category, r.amount ?? 0, r.note || ""));
    await db.batch(batch);
    nExp += batch.length;
  }
  await recomputeConsumption(db, vehicleId);
  return { nFuel, nExp };
}

// ---- meta / 邮件日志 ----

export async function metaGet(db, k) {
  const row = await db.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first();
  return row ? row.v : null;
}

export async function metaSet(db, k, v) {
  await db.prepare(
    "INSERT INTO meta (k, v, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime('now')"
  ).bind(k, String(v)).run();
}

export async function logEmail(db, { kind, subject, ok, error = "" }) {
  await db.prepare(
    "INSERT INTO email_log (kind, subject, ok, error) VALUES (?, ?, ?, ?)"
  ).bind(kind, subject || "", ok ? 1 : 0, (error || "").slice(0, 500)).run();
}

export async function emailLog(db, limit = 20) {
  const { results } = await db.prepare(
    "SELECT id, sent_at, kind, subject, ok, error FROM email_log ORDER BY id DESC LIMIT ?"
  ).bind(Math.min(Number(limit) || 20, 100)).all();
  return results || [];
}
