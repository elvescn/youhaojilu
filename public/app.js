/* 油耗账本 · 前端逻辑 */
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "youhao_token";
  let token = localStorage.getItem(TOKEN_KEY) || "";

  const state = {
    grades: ["92#", "95#", "98#", "0#", "电"],
    categories: ["裸车和税费", "保险和交通规费", "维修保养", "配件费", "交通罚款", "其它"],
    fuelPage: 1, fuelPages: 1,
    expPage: 1, expPages: 1,
    monthly: null,
  };

  // ---------- 工具 ----------

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function fmt(n, d = 2) {
    if (n === null || n === undefined || n === "") return "—";
    const v = Number(n);
    if (!isFinite(v)) return "—";
    return v.toFixed(d).replace(/\.?0+$/, "") || "0";
  }

  function fmtInt(n) {
    if (n === null || n === undefined) return "—";
    return Number(n).toLocaleString("zh-CN");
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function nowLocalInput() {
    const now = new Date();
    const utc8 = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
    const p = (n) => String(n).padStart(2, "0");
    return `${utc8.getFullYear()}-${p(utc8.getMonth() + 1)}-${p(utc8.getDate())}T${p(utc8.getHours())}:${p(utc8.getMinutes())}`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      showLogin("会话已过期，请重新登录");
      throw new Error("unauthorized");
    }
    let data = {};
    try { data = await res.json(); } catch { /* 导出接口返回文件 */ }
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  // ---------- 登录 / 主界面切换 ----------

  function showLogin(msg) {
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    if (msg) $("login-msg").textContent = msg;
  }

  function showApp() {
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    boot();
  }

  $("login-btn").addEventListener("click", async () => {
    const t = $("login-token").value.trim();
    if (!t) { $("login-msg").textContent = "请输入口令"; return; }
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: t }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) { $("login-msg").textContent = data.error || "登录失败"; return; }
      token = t;
      localStorage.setItem(TOKEN_KEY, t);
      $("login-msg").textContent = "";
      showApp();
    } catch (e) {
      $("login-msg").textContent = "网络错误：" + e.message;
    }
  });
  $("login-token").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-btn").click(); });

  $("btn-logout").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    token = "";
    $("login-token").value = "";
    showLogin();
  });

  // ---------- Tab 切换 ----------

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
      if (btn.dataset.tab === "dash") loadDash();
      if (btn.dataset.tab === "fuel") loadFuel();
      if (btn.dataset.tab === "expense") loadExpense();
      if (btn.dataset.tab === "data") loadMailLog();
    });
  });

  // ---------- 启动 ----------

  async function boot() {
    try {
      const data = await api("/api/bootstrap");
      state.grades = data.grades || state.grades;
      state.categories = data.categories || state.categories;
      // 填充筛选项
      const gradeSel = $("fuel-grade");
      gradeSel.innerHTML = '<option value="">全部油号</option>' + state.grades.map((g) => `<option>${esc(g)}</option>`).join("");
      const catSel = $("exp-category");
      catSel.innerHTML = '<option value="">全部类型</option>' + state.categories.map((c) => `<option>${esc(c)}</option>`).join("");
      const fGrade = $("f-grade");
      fGrade.innerHTML = state.grades.map((g) => `<option>${esc(g)}</option>`).join("");
      const fCat = $("f-category");
      fCat.innerHTML = state.categories.map((c) => `<option>${esc(c)}</option>`).join("");
      // 年份筛选
      const years = new Set();
      const st = await api("/api/stats");
      (st.monthly.fuel || []).forEach((r) => years.add(r.month.slice(0, 4)));
      (st.monthly.expenseByMonth && Object.keys(st.monthly.expenseByMonth)).forEach((m) => years.add(m.slice(0, 4)));
      const yearOpts = ['<option value="">全部年份</option>'].concat(
        [...years].sort().reverse().map((y) => `<option>${y}</option>`)
      ).join("");
      $("fuel-year").innerHTML = yearOpts;
      $("exp-year").innerHTML = yearOpts;
      loadDash();
      loadFuel();
    } catch (e) {
      if (e.message !== "unauthorized") toast(e.message);
    }
  }

  // ---------- 仪表盘 ----------

  async function loadDash() {
    try {
      const [st] = await Promise.all([api("/api/stats")]);
      const s = st.summary;
      const cards = [
        ["平均油耗", s.avg_consumption === null ? "—" : fmt(s.avg_consumption), "L/100km · 可计算段加权"],
        ["加油", `${s.fuel_count} 次`, `${fmt(s.liters_total)} L · ${fmtInt(s.fuel_paid_total)} 元`],
        ["其他费用", `${s.expense_count} 笔`, `${fmtInt(s.expense_total)} 元`],
        ["花费合计", fmtInt(s.total_cost), "元"],
        ["行驶里程", fmtInt(s.km_covered), `km（${fmtInt(s.min_odo)} ~ ${fmtInt(s.max_odo)}）`],
      ];
      $("dash-cards").innerHTML = cards.map(([k, v, sub]) =>
        `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)} <small>${esc(sub)}</small></div></div>`
      ).join("");
      state.monthly = st.monthly;
      drawConsumptionChart(st.monthly.fuel || []);
      drawCostChart(st.monthly.fuel || [], st.monthly.expenseByMonth || {});
    } catch (e) {
      if (e.message !== "unauthorized") toast(e.message);
    }
  }

  function setupCanvas(canvas, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(canvas.parentElement.clientWidth - 28, 260);
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, w: cssW, h: cssH };
  }

  function drawConsumptionChart(rows) {
    const canvas = $("chart-consumption");
    const { ctx, w, h } = setupCanvas(canvas, 180);
    const pts = rows.filter((r) => r.consumption !== null && r.consumption !== undefined);
    if (!pts.length) {
      ctx.fillStyle = "#5b6472";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("暂无可计算油耗的月份", w / 2, h / 2);
      return;
    }
    const padL = 40, padR = 12, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const maxV = Math.max(...pts.map((p) => p.consumption)) * 1.15;
    const minV = 0;
    ctx.strokeStyle = "#d8dde5";
    ctx.fillStyle = "#5b6472";
    ctx.font = "11px sans-serif";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + ih - (ih * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText((minV + ((maxV - minV) * i) / 4).toFixed(1), padL - 6, y + 4);
    }
    const X = (i) => padL + (iw * i) / Math.max(pts.length - 1, 1);
    const Y = (v) => padT + ih - ((v - minV) / (maxV - minV)) * ih;
    // 折线
    ctx.strokeStyle = "#185FA5";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => { i ? ctx.lineTo(X(i), Y(p.consumption)) : ctx.moveTo(X(i), Y(p.consumption)); });
    ctx.stroke();
    // 数据点与标签
    pts.forEach((p, i) => {
      ctx.fillStyle = "#185FA5";
      ctx.beginPath(); ctx.arc(X(i), Y(p.consumption), 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#5b6472";
      ctx.textAlign = "center";
      ctx.fillText(p.month.slice(2), X(i), h - 8);
    });
    // 末点数值
    const last = pts[pts.length - 1];
    ctx.fillStyle = "#0C447C";
    ctx.textAlign = "right";
    ctx.fillText(last.consumption.toFixed(2) + " L/100km", w - padR, padT + 4);
  }

  function drawCostChart(fuelRows, expByMonth) {
    const canvas = $("chart-cost");
    const { ctx, w, h } = setupCanvas(canvas, 180);
    const months = fuelRows.map((r) => r.month);
    if (!months.length) {
      ctx.fillStyle = "#5b6472";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("暂无数据", w / 2, h / 2);
      return;
    }
    const expOf = (m) => Object.values(expByMonth[m] || {}).reduce((a, b) => a + b, 0);
    const data = months.map((m) => {
      const f = fuelRows.find((r) => r.month === m);
      return { month: m, fuel: f ? f.paid : 0, exp: expOf(m) };
    });
    const padL = 44, padR = 12, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const maxV = Math.max(...data.map((d) => d.fuel + d.exp)) * 1.15 || 1;
    ctx.strokeStyle = "#d8dde5";
    ctx.fillStyle = "#5b6472";
    ctx.font = "11px sans-serif";
    for (let i = 0; i <= 4; i++) {
      const y = padT + ih - (ih * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(Math.round((maxV * i) / 4).toString(), padL - 6, y + 4);
    }
    const slot = iw / data.length;
    const bw = Math.max(Math.min(slot * 0.32, 26), 4);
    data.forEach((d, i) => {
      const cx = padL + slot * i + slot / 2;
      const hFuel = (d.fuel / maxV) * ih;
      const hExp = (d.exp / maxV) * ih;
      ctx.fillStyle = "#185FA5";
      ctx.fillRect(cx - bw - 2, padT + ih - hFuel, bw, hFuel);
      ctx.fillStyle = "#EF9F27";
      ctx.fillRect(cx + 2, padT + ih - hExp, bw, hExp);
      if (data.length <= 24 || i % Math.ceil(data.length / 12) === 0) {
        ctx.fillStyle = "#5b6472";
        ctx.textAlign = "center";
        ctx.fillText(d.month.slice(2), cx, h - 8);
      }
    });
    // 图例
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#185FA5"; ctx.fillRect(padL, 2, 10, 10);
    ctx.fillStyle = "#5b6472"; ctx.fillText("油费", padL + 14, 11);
    ctx.fillStyle = "#EF9F27"; ctx.fillRect(padL + 52, 2, 10, 10);
    ctx.fillStyle = "#5b6472"; ctx.fillText("其他费用", padL + 66, 11);
  }

  // ---------- 加油记录 ----------

  async function loadFuel() {
    const params = new URLSearchParams({
      page: state.fuelPage, size: 50,
      year: $("fuel-year").value, grade: $("fuel-grade").value, q: $("fuel-q").value.trim(),
    });
    try {
      const data = await api("/api/fuel?" + params);
      state.fuelPages = data.pages;
      state.fuelPage = data.page;
      $("fuel-pageinfo").textContent = `第 ${data.page} / ${data.pages} 页 · 共 ${data.total} 条`;
      const tbody = document.querySelector("#fuel-table tbody");
      if (!data.rows.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty">暂无记录，点右上角「记一笔」开始</td></tr>';
        return;
      }
      tbody.innerHTML = data.rows.map((r) => `
        <tr>
          <td>${esc(r.filled_at.slice(0, 10))}<br><span class="muted">${esc(r.filled_at.slice(11, 16))}</span></td>
          <td class="num">${fmtInt(r.odometer)}</td>
          <td class="num">${fmt(r.liters)} L</td>
          <td class="num">${fmt(r.unit_price)}</td>
          <td class="num">${fmt(r.amount_paid)}</td>
          <td class="num">${r.consumption === null ? "—" : esc(r.consumption)}${r.is_missed ? ' <span class="muted" title="漏记段">*</span>' : ""}${r.is_full ? "" : ' <span class="muted" title="未加满">◇</span>'}</td>
          <td>${esc(r.fuel_grade)}</td>
          <td class="wrap">${esc(r.station)}${r.note ? "<br><span class=muted>" + esc(r.note) + "</span>" : ""}</td>
          <td class="row-actions">
            <button data-edit="${r.id}">改</button>
            <button class="del" data-del="${r.id}">删</button>
          </td>
        </tr>`).join("");
      tbody.querySelectorAll("[data-edit]").forEach((b) =>
        b.addEventListener("click", () => openFuelModal(data.rows.find((r) => String(r.id) === b.dataset.edit))));
      tbody.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", () => delRecord("fuel", b.dataset.del)));
    } catch (e) {
      if (e.message !== "unauthorized") toast(e.message);
    }
  }

  $("fuel-prev").addEventListener("click", () => { if (state.fuelPage > 1) { state.fuelPage--; loadFuel(); } });
  $("fuel-next").addEventListener("click", () => { if (state.fuelPage < state.fuelPages) { state.fuelPage++; loadFuel(); } });
  ["fuel-year", "fuel-grade"].forEach((id) => $(id).addEventListener("change", () => { state.fuelPage = 1; loadFuel(); }));
  let qTimer = null;
  $("fuel-q").addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.fuelPage = 1; loadFuel(); }, 350);
  });
  $("fuel-add").addEventListener("click", () => openFuelModal(null));

  // ---------- 费用记录 ----------

  async function loadExpense() {
    const params = new URLSearchParams({
      page: state.expPage, size: 50,
      year: $("exp-year").value, category: $("exp-category").value,
    });
    try {
      const data = await api("/api/expense?" + params);
      state.expPages = data.pages;
      state.expPage = data.page;
      $("exp-pageinfo").textContent = `第 ${data.page} / ${data.pages} 页 · 共 ${data.total} 条`;
      const tbody = document.querySelector("#exp-table tbody");
      if (!data.rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无费用记录</td></tr>';
        return;
      }
      tbody.innerHTML = data.rows.map((r) => `
        <tr>
          <td>${esc(r.occurred_at.slice(0, 10))}</td>
          <td>${esc(r.category)}</td>
          <td class="num">${fmt(r.amount)}</td>
          <td class="wrap">${esc(r.note)}</td>
          <td class="row-actions">
            <button data-edit="${r.id}">改</button>
            <button class="del" data-del="${r.id}">删</button>
          </td>
        </tr>`).join("");
      tbody.querySelectorAll("[data-edit]").forEach((b) =>
        b.addEventListener("click", () => openExpenseModal(data.rows.find((r) => String(r.id) === b.dataset.edit))));
      tbody.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", () => delRecord("expense", b.dataset.del)));
    } catch (e) {
      if (e.message !== "unauthorized") toast(e.message);
    }
  }

  $("exp-prev").addEventListener("click", () => { if (state.expPage > 1) { state.expPage--; loadExpense(); } });
  $("exp-next").addEventListener("click", () => { if (state.expPage < state.expPages) { state.expPage++; loadExpense(); } });
  ["exp-year", "exp-category"].forEach((id) => $(id).addEventListener("change", () => { state.expPage = 1; loadExpense(); }));
  $("exp-add").addEventListener("click", () => openExpenseModal(null));

  // ---------- 弹窗表单 ----------

  function openModal(kind, record) {
    $("form-msg").textContent = "";
    $("f-id").value = record ? record.id : "";
    $("f-kind").value = kind;
    $("f-datetime").value = record
      ? (kind === "fuel" ? record.filled_at : record.occurred_at).slice(0, 16)
      : nowLocalInput();
    $("fuel-fields").hidden = kind !== "fuel";
    $("fuel-checks").style.display = kind === "fuel" ? "" : "none";
    $("expense-fields").hidden = kind === "fuel";
    $("modal-title").textContent = (record ? "修改" : "新增") + (kind === "fuel" ? "加油记录" : "费用记录");
    if (kind === "fuel") {
      $("f-odometer").value = record ? record.odometer : "";
      $("f-price").value = record && record.unit_price !== null ? record.unit_price : "";
      $("f-liters").value = record ? record.liters : "";
      $("f-amount-display").value = record && record.amount_display !== null ? record.amount_display : "";
      $("f-amount-paid").value = record && record.amount_paid !== null ? record.amount_paid : "";
      $("f-grade").value = record ? record.fuel_grade : "92#";
      $("f-station").value = record ? record.station || "" : "";
      $("f-full").checked = record ? !!record.is_full : true;
      $("f-light").checked = record ? !!record.is_low_light : false;
      $("f-missed").checked = record ? !!record.is_missed : false;
    } else {
      $("f-category").value = record ? record.category : state.categories[0];
      $("f-amount").value = record ? record.amount : "";
    }
    $("f-note").value = record ? record.note || "" : "";
    $("modal").hidden = false;
    setTimeout(() => $("f-datetime").focus(), 50);
  }

  function openFuelModal(record) { openModal("fuel", record); }
  function openExpenseModal(record) { openModal("expense", record); }
  $("modal-cancel").addEventListener("click", () => { $("modal").hidden = true; });
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").hidden = true; });

  // 单价 × 油量 自动带出机显金额
  function autoAmount() {
    const price = parseFloat($("f-price").value);
    const liters = parseFloat($("f-liters").value);
    if (isFinite(price) && isFinite(liters) && !$("f-id").value) {
      const v = Math.round(price * liters * 100) / 100;
      $("f-amount-display").value = v;
      if (!$("f-amount-paid").value) $("f-amount-paid").value = v;
    }
  }
  ["f-price", "f-liters"].forEach((id) => $(id).addEventListener("input", autoAmount));

  $("record-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const kind = $("f-kind").value;
    const id = $("f-id").value;
    const body = { filled_at: $("f-datetime").value, occurred_at: $("f-datetime").value };
    if (kind === "fuel") {
      Object.assign(body, {
        odometer: $("f-odometer").value,
        unit_price: $("f-price").value,
        liters: $("f-liters").value,
        amount_display: $("f-amount-display").value,
        amount_paid: $("f-amount-paid").value,
        fuel_grade: $("f-grade").value,
        is_full: $("f-full").checked,
        is_low_light: $("f-light").checked,
        is_missed: $("f-missed").checked,
        station: $("f-station").value,
        note: $("f-note").value,
      });
    } else {
      Object.assign(body, {
        category: $("f-category").value,
        amount: $("f-amount").value,
        note: $("f-note").value,
      });
    }
    try {
      await api("/api/" + kind + (id ? "/" + id : ""), { method: id ? "PUT" : "POST", body });
      $("modal").hidden = true;
      toast("已保存" + (body.email_skipped ? "" : "，备份邮件将稍后送达"));
      if (kind === "fuel") { state.fuelPage = 1; loadFuel(); } else { state.expPage = 1; loadExpense(); }
      loadDash();
    } catch (err) {
      $("form-msg").textContent = err.message;
    }
  });

  async function delRecord(kind, id) {
    if (!confirm("确定删除这条记录？删除后油耗会按加满链重算。")) return;
    try {
      await api("/api/" + kind + "/" + id, { method: "DELETE" });
      toast("已删除");
      if (kind === "fuel") loadFuel(); else loadExpense();
      loadDash();
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 数据 tab ----------

  $("btn-backup").addEventListener("click", async () => {
    try {
      await api("/api/backup", { method: "POST", body: {} });
      toast("已触发全量备份，发送结果见「数据 → 发信记录」");
      setTimeout(loadMailLog, 4000);
    } catch (e) { toast(e.message); }
  });

  async function loadMailLog() {
    try {
      const data = await api("/api/backup/log");
      const tbody = document.querySelector("#mail-table tbody");
      if (!data.rows.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无发信记录</td></tr>';
        return;
      }
      const kindName = { change: "变更即时", daily: "每日全量", manual: "手动备份", import: "导入完成" };
      tbody.innerHTML = data.rows.map((r) => `
        <tr>
          <td>${esc(r.sent_at.replace("T", " ").slice(0, 19))}</td>
          <td>${esc(kindName[r.kind] || r.kind)}</td>
          <td class="wrap">${esc(r.subject)}${r.error ? '<br><span class="muted">' + esc(r.error) + "</span>" : ""}</td>
          <td>${r.ok ? '<span style="color:var(--ok)">成功</span>' : '<span style="color:var(--danger)">失败</span>'}</td>
        </tr>`).join("");
    } catch (e) {
      if (e.message !== "unauthorized") toast(e.message);
    }
  }

  $("import-btn").addEventListener("click", async () => {
    const msg = $("import-msg");
    msg.textContent = "";
    let payload = null;
    const file = $("import-file").files[0];
    try {
      if (file) {
        const text = await file.text();
        payload = JSON.parse(text);
      } else {
        const text = $("import-text").value.trim();
        if (!text) { msg.textContent = "请选择文件或粘贴 JSON 内容"; return; }
        payload = JSON.parse(text);
      }
      msg.textContent = "正在导入…";
      const data = await api("/api/import", { method: "POST", body: payload });
      msg.textContent = `导入完成：油耗 ${data.imported.nFuel} 条、费用 ${data.imported.nExp} 条，油耗已重算。`;
      toast("导入成功");
      loadFuel(); loadDash();
    } catch (e) {
      msg.textContent = "导入失败：" + e.message;
    }
  });

  // ---------- 入口 ----------

  if (token) showApp(); else showLogin();
})();
