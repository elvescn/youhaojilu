// 邮件发送：Resend HTTP API（HTTPS，不依赖出站 SMTP）
//
// 为什么不用 SMTP：已实测（2026-11-03 诊断）Cloudflare Workers 出口 IP 被
// 163/QQ/Gmail 等主流服务商在 SMTP 问候阶段直接掐断（反垃圾策略），
// cloudflare:sockets 直连 SMTP 此路不通。Resend 走 HTTPS API，Workers 可正常调用。
//
// 所需密钥（wrangler secret put）：
//   RESEND_API_KEY  Resend 控制台创建的 API Key（域名需先在 Resend 验证 DKIM/SPF）
//   BACKUP_TO       备份接收邮箱（任意邮箱均可，如 163 或自建 cloud-mail 域名邮箱）
//   MAIL_FROM       可选，发件人地址，需为 Resend 已验证域名下的地址；
//                   默认 "油耗账本 <youhao@" + 发件域名 + ">"，域名取自 BACKUP_TO 的 @ 后缀。

const API = "https://api.resend.com/emails";
const TIMEOUT = 25000;

function defaultFrom(env) {
  const to = env.BACKUP_TO || "";
  const at = to.lastIndexOf("@");
  const domain = at >= 0 ? to.slice(at + 1) : "example.com";
  return `油耗账本 <youhao@${domain}>`;
}

// 发送一封邮件（正文 + 若干 base64 附件）；抛错由调用方记录
export async function sendMail(env, { to, subject, text, attachments = [] }) {
  const key = env.RESEND_API_KEY;
  if (!key) throw new Error("未配置 RESEND_API_KEY（wrangler secret put）");
  if (!to) throw new Error("未配置收件邮箱 BACKUP_TO");

  const body = {
    from: env.MAIL_FROM || defaultFrom(env),
    to: [to],
    subject,
    text,
    attachments: (attachments || []).map((att) => ({
      filename: att.name,
      content: att.b64 || btoa(unescape(encodeURIComponent(att.content || ""))),
    })),
  };

  const resp = await Promise.race([
    fetch(API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Resend 请求超时")), TIMEOUT)),
  ]);

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`Resend 发送失败（HTTP ${resp.status}）: ${msg}`);
  }
  return { id: data.id || "" };
}
