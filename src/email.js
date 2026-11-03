// 163 SMTP 邮件客户端（基于 cloudflare:sockets 出站 TCP，465 隐式 TLS）
//
// 平台约束（已核实）：
//   - connect() 必须在请求处理函数内创建，不能放模块全局作用域；
//   - 单次调用最多 6 个并发 socket，连接超时需自行用 Promise.race 兜底；
//   - 25 端口被平台禁用，465（隐式 TLS）/ 587（STARTTLS）可用；
//   - 本地 wrangler dev（miniflare）无 sockets 实现，故采用动态 import，
//     本地环境下发信功能不可用但不影响其余所有功能。

import { utf8ToB64, withTimeout, safeFilename } from "./util.js";

const IO_TIMEOUT = 20000;
const CONNECT_TIMEOUT = 15000;

let cachedConnect = null;
async function getConnect() {
  if (cachedConnect === null) {
    try {
      const mod = await import("cloudflare:sockets");
      cachedConnect = typeof mod.connect === "function" ? mod.connect : false;
    } catch {
      cachedConnect = false;
    }
  }
  if (!cachedConnect) {
    throw new Error("当前运行环境不支持 SMTP 出站连接（仅 Cloudflare Workers 生产环境可用）");
  }
  return cachedConnect;
}

class SMTPConnection {
  constructor({ host, port, secure, connectTimeout = CONNECT_TIMEOUT, ioTimeout = IO_TIMEOUT }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.connectTimeout = connectTimeout;
    this.ioTimeout = ioTimeout;
    this.stage = "TCP+TLS 连接";
    this.buf = "";
  }

  async open() {
    const connect = await getConnect();
    this.socket = connect({
      hostname: this.host,
      port: this.port,
      secureTransport: this.secure ? "on" : "off",
    });
    await withTimeout(Promise.resolve(this.socket.opened), this.connectTimeout, "SMTP 连接超时（" + this.host + ":" + this.port + "）");
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.decoder = new TextDecoder("utf-8");
    this.encoder = new TextEncoder();
    this.stage = "等待 SMTP 问候(220)";
    const greet = await this.readResponse();
    if (!greet.startsWith("220")) throw new Error("SMTP 问候异常(" + this.host + "): " + greet);
  }

  async writeLine(line) {
    try {
      await this.writer.write(this.encoder.encode(line + "\r\n"));
    } catch (e) {
      throw new Error("SMTP 写入失败（阶段: " + this.stage + "）: " + (e && e.message || e));
    }
  }

  async readResponse() {
    while (true) {
      const idx = this.buf.indexOf("\r\n");
      if (idx >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        // 多行响应（如 250-STARTTLS ... 250 OK）：第 4 字符为 '-' 表示后续还有行
        if (line.length >= 4 && line[3] === "-") continue;
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SMTP 连接被对端关闭（阶段: " + this.stage + "）");
      this.buf += this.decoder.decode(value, { stream: true });
    }
  }

  async cmd(line, expect, label) {
    this.stage = label || line.split(" ")[0];
    await this.writeLine(line);
    const resp = await withTimeout(this.readResponse(), this.ioTimeout, "SMTP 响应超时（阶段: " + this.stage + "）");
    const code = parseInt(resp.slice(0, 3), 10);
    if (expect && !expect.includes(code)) {
      throw new Error(`SMTP 命令失败（阶段: ${this.stage}）-> ${resp.slice(0, 120)}`);
    }
    return { code, resp };
  }

  close() {
    try { this.reader && this.reader.releaseLock(); } catch {}
    try { this.writer && this.writer.releaseLock(); } catch {}
    try { this.socket && this.socket.close(); } catch {}
  }
}

function wrapB64(b64, len = 76) {
  return (b64.match(new RegExp(".{1," + len + "}", "g")) || []).join("\r\n");
}

// 构造 multipart/mixed 邮件（正文 + 若干附件）
function buildMessage({ fromName, from, to, subject, text, attachments }) {
  const boundary = "----=_Youhao_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const L = [];
  L.push(`From: "${fromName}" <${from}>`);
  L.push(`To: ${to}`);
  L.push(`Subject: =?UTF-8?B?${utf8ToB64(subject)}?=`);
  L.push("MIME-Version: 1.0");
  L.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  L.push("");
  L.push(`--${boundary}`);
  L.push("Content-Type: text/plain; charset=UTF-8");
  L.push("Content-Transfer-Encoding: base64");
  L.push("");
  L.push(wrapB64(utf8ToB64(text)));
  for (const att of attachments || []) {
    const { ascii, star } = safeFilename(att.name);
    L.push(`--${boundary}`);
    L.push(`Content-Type: ${att.mime || "application/octet-stream"}; charset=UTF-8; name="${ascii}"`);
    L.push(`Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${star}`);
    L.push("Content-Transfer-Encoding: base64");
    L.push("");
    L.push(wrapB64(att.b64 || utf8ToB64(att.content || "")));
  }
  L.push(`--${boundary}--`);
  return L.join("\r\n");
}

// 发送一封邮件；抛错由调用方记录
export async function sendMail(env, { to, subject, text, attachments = [] }) {
  const host = env.SMTP_HOST || "smtp.163.com";
  const port = Number(env.SMTP_PORT || 465);
  const secure = String(env.SMTP_SECURE || "on") === "on";
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  if (!user || !pass) throw new Error("未配置 SMTP_USER / SMTP_PASS（wrangler secret put）");
  const conn = new SMTPConnection({ host, port, secure });
  await conn.open();
  try {
    await conn.cmd(`EHLO ${env.EHLO_NAME || "youhao"}`, [250], "EHLO");
    if (!secure) {
      // 587 STARTTLS：本版本实现未覆盖，明确报错优于静默失败
      throw new Error("仅支持 465 隐式 TLS，请将 SMTP_SECURE 设为 on");
    }
    await conn.cmd("AUTH LOGIN", [334], "AUTH LOGIN 发起");
    await conn.cmd(utf8ToB64(user), [334], "AUTH 用户名");
    await conn.cmd(utf8ToB64(pass), [235], "AUTH 授权码");
    await conn.cmd(`MAIL FROM:<${user}>`, [250], "MAIL FROM");
    await conn.cmd(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await conn.cmd("DATA", [354], "DATA");
    const msg = buildMessage({ fromName: "油耗账本", from: user, to, subject, text, attachments });
    await conn.writeLine(msg.replace(/^\./gm, "..")); // 点转义
    await conn.cmd(".", [250], "正文发送(等待250)");
    await conn.cmd("QUIT", [221], "QUIT");
  } finally {
    conn.close();
  }
  return true;
}

// 只探测不登录：连接 → TLS → 问候 → EHLO。用于诊断服务器是否拒绝 Cloudflare 出口。
export async function smtpProbe(host, port, secure = true) {
  const t0 = Date.now();
  const r = { host, port, tls: secure ? "隐式TLS" : "明文", ok: false, steps: [] };
  let conn = null;
  try {
    conn = new SMTPConnection({ host, port, secure, connectTimeout: 10000, ioTimeout: 8000 });
    await conn.open();
    r.steps.push({ stage: conn.stage, ok: true, ms: Date.now() - t0, info: "问候 220 已收到" });
    const ehlo = await conn.cmd("EHLO youhao-probe", [250], "EHLO");
    r.steps.push({ stage: "EHLO", ok: true, ms: Date.now() - t0, info: ehlo.resp.slice(0, 120) });
    r.ok = true;
  } catch (e) {
    r.steps.push({ stage: conn ? conn.stage : "连接前", ok: false, ms: Date.now() - t0, info: String(e && e.message || e).slice(0, 200) });
  }
  try { conn && conn.close(); } catch {}
  return r;
}
