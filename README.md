# 油耗账本（youhao）

自建油耗记录系统：Cloudflare Workers + D1 + Workers Assets，替代小熊油耗 App。
数据存自己的 Cloudflare D1，自定义域名访问，每次记录自动发备份邮件到 163 邮箱，支持 CSV/JSON 导入导出。

## 功能

- **在线录入**：加油记录（13 个字段，与小熊油耗导出一一对应）+ 费用记录（保险/保养/罚款等 6 类）
- **油耗自动计算**：按小熊油耗完全一致的口径服务端重算（见下文「油耗口径」）
- **仪表盘**：平均油耗、总加油量、总花费、月度油耗折线图、月度花费柱状图
- **邮件自动备份**（三条链路）：
  - 每次录入/修改/删除 → 发送「变更摘要」邮件（默认 5 分钟限流一封，连续录入不刷信）
  - 每日 22:00（北京时间）→ 发送全量备份邮件（油耗 CSV + 费用 CSV + JSON 快照三个附件）
  - 网页「备份」按钮 → 手动立即全量备份
- **导入导出**：导出 CSV（表头与小熊油耗一致，Excel 可直接打开）/ 全量 JSON；导入 JSON 全量快照，导入后油耗自动重算
- **PWA**：手机浏览器打开后可「添加到主屏幕」，接近原生 App 体验
- **安全**：Bearer Token 登录；敏感配置全部走 `wrangler secret put`，不进代码库

## 油耗口径（与小熊油耗 100% 一致）

经 133 条历史记录（2017-03 至 2026-10）与原导出文件逐条校验，零差异。规则：

1. 相邻两个「加满」记录构成一段 `[P, F)`；
2. 段油耗 = **P 之后至 F（含 F）的累计加油量 ÷ (odo[F] − odo[P]) × 100**；
3. 段内所有行（P 至 F 前一行）都显示该段油耗，F 行开始显示下一段；
4. P 之后至 F 任一行标记「漏记」→ 该段油耗不可计算（显示「—」）；
5. 第一条记录之前没有加满锚点、最后一段之后没有加满行 → 不可计算。

> 例：04-30 加满 39.58L（里程 1024），之后 05-12 加 20.83L、05-20 加 27.42L，05-30 加满 47.11L（里程 1740）。
> 段油耗 = (20.83+27.42+47.11) ÷ (1740−1024) × 100 = 13.32 L/100km，04-30、05-12、05-20 三行都显示 13.32。

## 本地开发

```bash
cd youhao
npm install
cp .dev.vars.example .dev.vars   # 填入本地测试口令等
npx wrangler d1 migrations apply youhao --local   # 建表
npx wrangler d1 execute youhao --local --file=seed/seed.sql   # 灌入 133+16 条历史数据
npx wrangler dev                 # http://localhost:8787
```

本地 `wrangler dev` 下**发邮件不可用**（miniflare 无 TCP 出站），其余功能完整；登录口令用 `.dev.vars` 里的 `API_TOKEN`。

## 生产部署（一次性，约 15 分钟）

前置条件：域名 DNS 已托管在 Cloudflare；本机已装 Node.js 18+。

```bash
# 1. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 2. 创建 D1 数据库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create youhao

# 3. 执行数据库迁移（远程）
npx wrangler d1 migrations apply youhao --remote

# 4. 灌入历史数据（133 条油耗 + 16 条费用，已按加满链算好油耗）
npx wrangler d1 execute youhao --remote --file=seed/seed.sql

# 5. 设置密钥（不要写进 wrangler.toml）
npx wrangler secret put API_TOKEN      # 网页登录口令，自定义长随机串
npx wrangler secret put SMTP_USER      # 163 邮箱完整地址，如 name@163.com
npx wrangler secret put SMTP_PASS      # 163 授权码（见下）
npx wrangler secret put BACKUP_TO      # 备份收件邮箱，一般同 SMTP_USER

# 6. 部署
npx wrangler deploy
```

### 绑定自定义域名

方式一（推荐，Dashboard）：Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add → Custom Domain，填 `youhao.你的域名.com`，Cloudflare 自动配好证书。

方式二（wrangler）：在 `wrangler.toml` 加

```toml
routes = [{ pattern = "youhao.你的域名.com", custom_domain = true }]
```

再 `npx wrangler deploy`。全程 HTTPS，无需 cloudflared、无需公网 IP、无需开放端口。

### 163 邮箱授权码获取

163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 按提示获取授权码（一串字母）。**授权码不是登录密码**，SMTP 只用授权码。本系统固定走 `smtp.163.com:465` 隐式 TLS。

### 部署前 checklist / 部署后自检

**部署前请确认：**
- [ ] `wrangler.toml` 里的 `database_id` 已替换为你 `wrangler d1 create youhao` 返回的真实 id（占位符 `REPLACE_WITH_YOUR_DATABASE_ID` 不删会部署失败）
- [ ] 已 `wrangler secret put` 设置 `API_TOKEN` / `SMTP_USER` / `SMTP_PASS` / `BACKUP_TO`
- [ ] 163 邮箱已开启 SMTP 服务并取得授权码

**部署后用自定义域名打开网页自检：**
1. 用 `API_TOKEN` 登录 → 首页应显示 133 条历史加油记录与仪表盘
2. 新增一笔加油 → 是否收到「变更摘要」邮件（看「数据 → 发信记录」）
3. 「数据 → 导出」下载 CSV/JSON，确认下载文件名是中文（已做 RFC 6266 编码）
4. 点「备份」→ 应收到带 CSV + JSON 附件的全量备份邮件
5. 等次日 22:00，或本地用 `curl http://127.0.0.1:8787/cdn-cgi/local/scheduled` 触发，确认每日备份

> 本地已用干净库跑通全链路 22/22 断言（登录鉴权、油耗重算、导入导出、静态资源），核心口径经 133 条历史数据 100% 校验。生产部署只需补上 `database_id` 与四个 secret 即可。

## 从小熊油耗迁移历史数据

历史数据已转换好放在 `seed/seed.sql`（部署第 4 步直接灌入）。以后再导出可随时转换：

```bash
pip install xlrd
python tools/xls2json.py "小熊油耗-xxxxx.xls"        # 生成 seed/seed.sql + seed/youhao-seed.json
```

转换器会输出 `seed/verify-report.txt` 交叉校验报告（重算油耗 vs 原文件油耗列）。
生成的 `youhao-seed.json` 也可在网页「数据 → 导入」中直接粘贴导入（支持 `fuel_records`/`expense_records` 键名）。

## 目录结构

```
youhao/
├── wrangler.toml            # Workers 配置（D1 绑定、Cron、Assets）
├── migrations/0001_init.sql # 建表脚本
├── seed/
│   ├── seed.sql             # 133+16 条历史数据（油耗已算好）
│   ├── youhao-seed.json     # 同内容 JSON 版
│   └── verify-report.txt    # 油耗口径交叉校验报告（零差异）
├── src/
│   ├── worker.js            # 入口：路由、API、Cron 备份
│   ├── db.js                # D1 访问层 + 油耗重算
│   ├── email.js             # 163 SMTP 客户端（cloudflare:sockets）
│   └── util.js              # 工具函数
├── public/                  # 前端 SPA（Workers Assets）
│   ├── index.html / app.js / style.css
│   ├── manifest.webmanifest / icon.svg
├── tools/xls2json.py        # 小熊油耗 xls → 种子数据转换器
└── README.md
```

## Cloudflare 免费额度（个人使用远低于上限）

| 项目 | 免费额度 | 本系统用量级 |
|---|---|---|
| Workers 请求 | 10 万次/天 | 每月几十次 |
| D1 存储 | 5 GB | 几千条记录 < 1 MB |
| D1 读取 | 500 万行/天 | 每天几十行 |
| D1 写入 | 10 万行/天 | 每天几十行 |
| Cron 触发 | 支持 | 每日 1 次 |
| Workers Assets | 支持 | 3 个静态文件 |

## 常见问题

**Q：收不到备份邮件？**
网页「数据 → 发信记录」查看失败原因。常见于：① 授权码错（重新 `wrangler secret put SMTP_PASS`）；② 163 未开启 SMTP 服务；③ 变更邮件处于 5 分钟限流期（等下一封或用「备份」按钮手动触发）。

**Q：Workers 能连 163 SMTP 吗？**
可以。基于 `cloudflare:sockets` 出站 TCP，465 隐式 TLS。平台禁用 25 端口，465/587 不受影响。若 SMTP 偶发超时，不影响数据写入（失败会记录在发信记录里），每日全量备份会重试兜底。

**Q：想换邮箱/换 SMTP？**
`wrangler secret put` 改 `SMTP_USER`/`SMTP_PASS`/`BACKUP_TO` 即可；`SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE` 在 `wrangler.toml` 的 `[vars]` 里改（当前实现仅覆盖 465 隐式 TLS）。

**Q：数据会不会丢？**
D1 为主存储；每次变更和每日全量都会发邮件到 163 邮箱（CSV+JSON 附件）；网页端可随时导出全量 JSON。JSON 快照可直接再导入恢复。

**Q：油耗和我 App 里显示的不一样？**
口径已与原 App 逐条校验一致。若某行显示「—」，表示该段落在漏记段内或缺少加满锚点（原 App 显示 -1）。
