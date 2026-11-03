// 通用工具函数

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function err(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

// 恒定时间字符串比较，防时序侧信道
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // 长度不同也走完比较
  let diff = ab.length === bb.length ? 0 : 1;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

// 北京时间（UTC+8）ISO 字符串，如 2026-10-23T19:30:00+08:00
export function nowISO() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19) + "+08:00";
}

// 校验并规范化前端传来的日期时间，缺省返回当前北京时间
export function normDatetime(v) {
  if (v === undefined || v === null || v === "") return nowISO();
  const s = String(v).trim();
  // 接受 2026-10-23T19:30 / 2026-10-23 19:30:00 / 带时区
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error("日期时间格式不正确: " + s);
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se || "00"}+08:00`;
}

export function num(v, { min = null, max = null, required = false, def = null } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error("缺少必填数字字段");
    return def;
  }
  const n = Number(v);
  if (!isFinite(n)) throw new Error("数字格式不正确: " + v);
  if (min !== null && n < min) throw new Error(`数值不能小于 ${min}`);
  if (max !== null && n > max) throw new Error(`数值不能大于 ${max}`);
  return n;
}

export function str(v, { max = 500, def = "" } = {}) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  if (s.length > max) throw new Error(`文本超过 ${max} 字`);
  return s;
}

export function bool01(v) {
  if (v === true || v === 1 || v === "1") return 1;
  if (v === false || v === 0 || v === "0" || v === "" || v === null || v === undefined) return 0;
  if (typeof v === "string" && ["是", "true", "on", "yes"].includes(v.toLowerCase())) return 1;
  return 0;
}

// UTF-8 字符串 -> base64（分块防调用栈溢出）
export function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// CSV 单元格转义；换行保留在引号内
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCSV(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return "\uFEFF" + lines.join("\r\n"); // BOM 便于 Excel 直接打开中文
}

export function withTimeout(p, ms, msg = "操作超时") {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

// 文件名两段式：ASCII 兜底 + RFC 5987/2231 的 UTF-8 百分号编码。
// 用于 HTTP Content-Disposition 与邮件 MIME 附件名，保证各浏览器下载中文文件名正确，
// 规避 dev 端 "wrong value for header content-disposition" 警告及浏览器端 TypeError。
export function safeFilename(name) {
  const ascii = String(name).replace(/[^ -~]/g, "_").replace(/["\\]/g, "_");
  const star = encodeURIComponent(name);
  return { ascii, star };
}

// HTTP Content-Disposition 头值（RFC 6266）
export function disposition(name) {
  const { ascii, star } = safeFilename(name);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}
