/* 油耗账本 · 前端逻辑 */
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "youhao_token";
  let token = localStorage.getItem(TOKEN_KEY) || "";

  const state = {
    grades: ["92#", "95#", "98#", "0#", "电"],
    fuelPage: 1, fuelPages: 1,
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
      token = "";
      localStorage.removeItem(TOKEN_KEY);
      updateChrome();
      openLogin("会话已过期，请重新登录");
      throw new Error("unauthorized");
    }
    let data = {};
    try { data = await res.json(); } catch { /* 导出接口返回文件 */ }
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  // ---------- 登录 / 公开浏览 ----------

  // 数据默认公开浏览；登录后才显示 备份/退出/＋记一笔/数据Tab，并解锁增删改
  function updateChrome() {
    const on = !!token;
    $("btn-login").hidden = on;
    $("btn-backup").hidden = !on;
    $("btn-logout").hidden = !on;
    $("fab-add").hidden = !on;
    $("fuel-add").hidden = !on;
    const dataTab = document.querySelector('[data-tab="data"]');
    if (dataTab) dataTab.hidden = !on;
  }

  function openLogin(msg) {
    if (msg) $("login-msg").textContent = msg;
    $("login-view").hidden = false;
    setTimeout(() => $("login-token").focus(), 50);
  }

  function closeLogin() {
    $("login-view").hidden = true;
    $("login-msg").textContent = "";
  }

  function showApp() {
    closeLogin();
    updateChrome();
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
  $("btn-login").addEventListener("click", () => openLogin());
  $("login-cancel").addEventListener("click", closeLogin);

  $("btn-logout").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    token = "";
    $("login-token").value = "";
    updateChrome();
    boot();
  });

  // ---------- Tab 切换 ----------

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === "data" && !token) { openLogin("请先登录后访问数据"); return; }
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
      if (btn.dataset.tab === "dash") loadDash();
      if (btn.dataset.tab === "fuel") loadFuel();
      if (btn.dataset.tab === "data") loadMailLog();
    });
  });

  // ---------- 启动 ----------

  async function boot() {
    try {
      const data = await api("/api/bootstrap");
      state.grades = data.grades || state.grades;
      // 填充筛选项
      const gradeSel = $("fuel-grade");
      gradeSel.innerHTML = '<option value="">全部油号</option>' + state.grades.map((g) => `<option>${esc(g)}</option>`).join("");
      const fGrade = $("f-grade");
      fGrade.innerHTML = state.grades.map((g) => `<option>${esc(g)}</option>`).join("");
      // 年份筛选
      const years = new Set();
      const st = await api("/api/stats");
      (st.monthly.fuel || []).forEach((r) => years.add(r.month.slice(0, 4)));
      const yearOpts = ['<option value="">全部年份</option>'].concat(
        [...years].sort().reverse().map((y) => `<option>${y}</option>`)
      ).join("");
      $("fuel-year").innerHTML = yearOpts;
      loadDash();
      loadFuel();
    } catch (e) {
      if (e.message !== "unauthorized") toast(e.message);
    }
  }

  // ---------- 仪表盘 ----------

  // 图表数据缓存（供悬浮查看用）
  const chartCons = { rows: [], geom: null };
  const chartCost = { rows: [], geom: null };

  // 时间范围过滤：近1年/近3年/全部（以当前日期倒推）
  function filterRange(rows) {
    const mode = $("dash-range").value;
    if (mode === "all" || !rows.length) return rows;
    const months = mode === "1y" ? 12 : 36;
    const now = new Date();
    let y = now.getFullYear(), m = now.getMonth() + 1 - (months - 1);
    while (m <= 0) { m += 12; y--; }
    const cutoff = y + "-" + String(m).padStart(2, "0");
    return rows.filter((r) => r.month >= cutoff);
  }

  async function loadDash() {
    try {
      const [st] = await Promise.all([api("/api/stats")]);
      const s = st.summary;
      const cards = [
        ["平均油耗", s.avg_consumption === null ? "—" : fmt(s.avg_consumption), "L/100km · 可计算段加权"],
        ["加油", `${s.fuel_count} 次`, `${fmt(s.liters_total)} L`],
        ["油费合计", fmtInt(s.fuel_paid_total), "元"],
        ["行驶里程", fmtInt(s.km_covered), `km（${fmtInt(s.min_odo)} ~ ${fmtInt(s.max_odo)}）`],
      ];
      $("dash-cards").innerHTML = cards.map(([k, v, sub]) =>
        `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)} <small>${esc(sub)}</small></div></div>`
      ).join("");
      state.monthly = st.monthly;
      const rows = filterRange(st.monthly.fuel || []);
      drawConsumptionChart(rows, -1);
      drawCostChart(rows, -1);
      chartCons.resetTip && chartCons.resetTip();
      chartCost.resetTip && chartCost.resetTip();
    } catch (e) {
      if (e.message !== "unauthorized") toast(e.message);
    }
  }

  $("dash-range").addEventListener("change", () => {
    if (!state.monthly) return;
    const rows = filterRange(state.monthly.fuel || []);
    drawConsumptionChart(rows, -1);
    drawCostChart(rows, -1);
    chartCons.resetTip && chartCons.resetTip();
    chartCost.resetTip && chartCost.resetTip();
  });

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

  function drawConsumptionChart(rows, hoverIdx = -1) {
    const canvas = $("chart-consumption");
    const { ctx, w, h } = setupCanvas(canvas, 180);
    const pts = rows.filter((r) => r.consumption !== null && r.consumption !== undefined);
    chartCons.rows = pts;
    if (!pts.length) {
      chartCons.geom = null;
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
    chartCons.geom = { padL, iw, n: pts.length };
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
    // 悬浮高亮：竖虚线 + 放大点
    if (hoverIdx >= 0 && hoverIdx < pts.length) {
      ctx.strokeStyle = "rgba(24, 95, 165, .35)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(X(hoverIdx), padT); ctx.lineTo(X(hoverIdx), padT + ih); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 折线
    ctx.strokeStyle = "#185FA5";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => { i ? ctx.lineTo(X(i), Y(p.consumption)) : ctx.moveTo(X(i), Y(p.consumption)); });
    ctx.stroke();
    // 数据点与标签（月份过多时抽稀，避免挤成糊）
    const step = Math.ceil(pts.length / 12);
    pts.forEach((p, i) => {
      const hot = i === hoverIdx;
      ctx.fillStyle = hot ? "#0C447C" : "#185FA5";
      ctx.beginPath(); ctx.arc(X(i), Y(p.consumption), hot ? 5 : 3, 0, Math.PI * 2); ctx.fill();
      if (hot || pts.length <= 13 || i % step === 0 || i === pts.length - 1) {
        ctx.fillStyle = "#5b6472";
        ctx.textAlign = "center";
        ctx.fillText(p.month.slice(2), X(i), h - 8);
      }
    });
    // 末点数值（悬浮时显示悬浮点的数值）
    const show = hoverIdx >= 0 && hoverIdx < pts.length ? pts[hoverIdx] : pts[pts.length - 1];
    ctx.fillStyle = "#0C447C";
    ctx.textAlign = "right";
    ctx.fillText(show.consumption.toFixed(2) + " L/100km", w - padR, padT + 4);
  }

  function drawCostChart(rows, hoverIdx = -1) {
    const canvas = $("chart-cost");
    const { ctx, w, h } = setupCanvas(canvas, 180);
    // 幂等映射：悬浮重绘传入的是已映射过的 chartCost.rows（含 fuel 字段），
    // 首次绘制传入的是后端原始行（含 paid 字段）。`r.fuel ?? r.paid` 兼容两者。
    const data = rows.map((r) => ({ month: r.month, fuel: (r.fuel ?? r.paid) || 0, count: r.count || 0 }));
    chartCost.rows = data;
    if (!data.length) {
      chartCost.geom = null;
      ctx.fillStyle = "#5b6472";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("暂无数据", w / 2, h / 2);
      return;
    }
    const padL = 44, padR = 12, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const maxV = Math.max(...data.map((d) => d.fuel)) * 1.15 || 1;
    chartCost.geom = { padL, iw, n: data.length };
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
    const bw = Math.max(Math.min(slot * 0.5, 26), 4);
    const step = Math.ceil(data.length / 12);
    data.forEach((d, i) => {
      const cx = padL + slot * i + slot / 2;
      const hFuel = (d.fuel / maxV) * ih;
      ctx.fillStyle = "#185FA5";
      ctx.fillRect(cx - bw / 2, padT + ih - hFuel, bw, hFuel);
      if (data.length <= 13 || i % step === 0 || i === data.length - 1) {
        ctx.fillStyle = "#5b6472";
        ctx.textAlign = "center";
        ctx.fillText(d.month.slice(2), cx, h - 8);
      }
    });
    // 悬浮高亮：竖虚线 + 柱顶重描
    if (hoverIdx >= 0 && hoverIdx < data.length) {
      const cx = padL + slot * hoverIdx + slot / 2;
      ctx.strokeStyle = "rgba(24, 95, 165, .35)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + ih); ctx.stroke();
      ctx.setLineDash([]);
      const hF = (data[hoverIdx].fuel / maxV) * ih;
      ctx.fillStyle = "#0C447C";
      ctx.fillRect(cx - bw / 2, padT + ih - hF, bw, hF);
    }
  }

  // 图表悬浮查看：鼠标划过 / 点击 / 手机触摸。
  // 数据保持：提示浮层与高亮在移开后不消失，保留到下次划过别处或切换时间范围/数据。
  function attachChartHover(canvasId, tipId, chart, drawFn, tipFn) {
    const canvas = $(canvasId);
    const tipEl = $(tipId);
    if (!canvas || !tipEl) return;
    const state = { cur: -1 };
    // 供数据重载/切换范围时复位
    chart.resetTip = () => {
      state.cur = -1;
      tipEl.hidden = true;
      drawFn(-1);
    };
    const locate = (clientX) => {
      const g = chart.geom;
      if (!g || !g.n) return -1;
      const rect = canvas.getBoundingClientRect();
      const i = Math.round(((clientX - rect.left - g.padL) / g.iw) * (g.n - 1));
      return i >= 0 && i < g.n ? i : -1;
    };
    const show = (i, cx, cy) => {
      if (i !== state.cur) { state.cur = i; drawFn(i); }
      tipEl.innerHTML = tipFn(i);
      tipEl.hidden = false;
      const pr = tipEl.parentElement.getBoundingClientRect();
      let left = cx - pr.left + 14;
      if (left + 180 > pr.width) left = Math.max(4, cx - pr.left - 194);
      tipEl.style.left = left + "px";
      tipEl.style.top = Math.max(4, cy - pr.top - 54) + "px";
    };
    const move = (clientX, clientY) => {
      const i = locate(clientX);
      if (i >= 0) show(i, clientX, clientY);   // 划出绘图区：保持当前显示，不隐藏
    };
    canvas.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
    // 点击即固定该月数据（移开后继续保持）
    canvas.addEventListener("mousedown", (e) => {
      const i = locate(e.clientX);
      if (i >= 0) show(i, e.clientX, e.clientY);
    });
    // 刻意不监听 mouseleave —— 数据保持
    const touch = (e) => {
      const t = e.touches[0];
      if (!t) return;
      const i = locate(t.clientX);
      if (i >= 0) { e.preventDefault(); show(i, t.clientX, t.clientY); }
    };
    canvas.addEventListener("touchstart", touch, { passive: false });
    canvas.addEventListener("touchmove", touch, { passive: false });
    // touchend 同样不隐藏 —— 手指松开后数据保持
  }

  attachChartHover("chart-consumption", "tip-consumption", chartCons,
    (i) => drawConsumptionChart(chartCons.rows, i),
    (i) => {
      const r = chartCons.rows[i];
      if (!r) return "";
      return `<b>${r.month}</b><br>油耗：${r.consumption === null ? "—" : r.consumption + " L/100km"}<br>加油：${r.liters} L · ${r.count} 次`;
    });
  attachChartHover("chart-cost", "tip-cost", chartCost,
    (i) => drawCostChart(chartCost.rows, i),
    (i) => {
      const r = chartCost.rows[i];
      if (!r) return "";
      return `<b>${r.month}</b><br>油费：${r.fuel} 元<br>加油：${r.count} 次`;
    });

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
        tbody.innerHTML = `<tr><td colspan="9" class="empty">暂无记录${token ? "，点右下角「＋」开始" : ""}</td></tr>`;
        return;
      }
      tbody.innerHTML = data.rows.map((r) => {
        const actions = token
          ? `<td class="row-actions">
              <button data-edit="${r.id}">改</button>
              <button class="del" data-del="${r.id}">删</button>
            </td>`
          : "<td></td>";
        return `
        <tr>
          <td>${esc(r.filled_at.slice(0, 10))}<br><span class="muted">${esc(r.filled_at.slice(11, 16))}</span></td>
          <td class="num">${fmtInt(r.odometer)}</td>
          <td class="num">${fmt(r.liters)} L</td>
          <td class="num">${fmt(r.unit_price)}</td>
          <td class="num">${fmt(r.amount_paid)}</td>
          <td class="num">${r.consumption === null ? "—" : esc(r.consumption)}${r.is_missed ? ' <span class="muted" title="漏记段">*</span>' : ""}${r.is_full ? "" : ' <span class="muted" title="未加满">◇</span>'}</td>
          <td>${esc(r.fuel_grade)}</td>
          <td class="wrap">${esc(r.station)}${r.note ? "<br><span class=muted>" + esc(r.note) + "</span>" : ""}</td>
          ${actions}
        </tr>`;
      }).join("");
      tbody.querySelectorAll("[data-edit]").forEach((b) =>
        b.addEventListener("click", () => openFuelModal(data.rows.find((r) => String(r.id) === b.dataset.edit))));
      tbody.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", () => delRecord(b.dataset.del)));
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
  $("fab-add").addEventListener("click", () => openFuelModal(null));

  // ---------- 弹窗表单 ----------

  function openFuelModal(record) {
    if (!token) { openLogin("请先登录后再记录"); return; }
    $("form-msg").textContent = "";
    $("f-id").value = record ? record.id : "";
    $("f-datetime").value = record ? record.filled_at.slice(0, 16) : nowLocalInput();
    $("modal-title").textContent = (record ? "修改" : "新增") + "加油记录";
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
    $("f-note").value = record ? record.note || "" : "";
    paidTouched = false;
    $("modal").hidden = false;
    setTimeout(() => $("f-datetime").focus(), 50);
  }
  $("modal-cancel").addEventListener("click", () => { $("modal").hidden = true; });
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").hidden = true; });

  // 单价 × 油量 自动带出机显金额，实付金额跟随机显金额
  // 实付一旦被用户手动改过就不再自动覆盖（paidTouched）
  let paidTouched = false;
  $("f-amount-paid").addEventListener("input", () => { paidTouched = true; });
  function autoAmount() {
    const price = parseFloat($("f-price").value);
    const liters = parseFloat($("f-liters").value);
    if (isFinite(price) && isFinite(liters) && !$("f-id").value) {
      const v = Math.round(price * liters * 100) / 100;
      $("f-amount-display").value = v;
      if (!paidTouched) $("f-amount-paid").value = v;
    }
  }
  ["f-price", "f-liters"].forEach((id) => $(id).addEventListener("input", autoAmount));

  $("record-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("f-id").value;
    const body = {
      filled_at: $("f-datetime").value,
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
    };
    try {
      await api("/api/fuel" + (id ? "/" + id : ""), { method: id ? "PUT" : "POST", body });
      $("modal").hidden = true;
      toast("已保存，备份邮件将稍后送达");
      state.fuelPage = 1;
      loadFuel();
      loadDash();
    } catch (err) {
      $("form-msg").textContent = err.message;
    }
  });

  async function delRecord(id) {
    if (!confirm("确定删除这条记录？删除后油耗会按加满链重算。")) return;
    try {
      await api("/api/fuel/" + id, { method: "DELETE" });
      toast("已删除");
      loadFuel();
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

  // 公开浏览：无论是否登录都直接进主界面；登录态只影响增删改/备份按钮
  updateChrome();
  boot();
})();
