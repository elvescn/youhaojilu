-- 自建油耗账本 · 初始结构
-- 三张业务表 + meta 配置表 + email_log 发信日志

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  plate TEXT DEFAULT '',
  model TEXT DEFAULT '',
  default_fuel_grade TEXT DEFAULT '92#',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 油耗记录：与小熊油耗导出的 13 个字段一一对应
-- consumption 为派生列（服务端按"加满链"口径重算），NULL 表示无法计算
CREATE TABLE IF NOT EXISTS fuel_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL DEFAULT 1 REFERENCES vehicles(id),
  filled_at TEXT NOT NULL,               -- ISO 本地时间，如 2017-03-23T11:12:16+08:00
  odometer REAL NOT NULL,                -- 总里程 km
  unit_price REAL,                       -- 机显单价 元/L
  liters REAL NOT NULL,                  -- 加油量 L
  amount_display REAL,                   -- 机显金额 元（油枪显示）
  amount_paid REAL NOT NULL,             -- 实付金额 元（费用统计用此列）
  fuel_grade TEXT DEFAULT '92#',         -- 92#/95#/98#/0#/电
  is_full INTEGER NOT NULL DEFAULT 1,    -- 加满 0/1（油耗计算参与开关）
  is_low_light INTEGER NOT NULL DEFAULT 0,-- 亮灯加油 0/1
  is_missed INTEGER NOT NULL DEFAULT 0,  -- 漏记 0/1（该段油耗失真标记）
  station TEXT DEFAULT '',               -- 加油站名称
  note TEXT DEFAULT '',                  -- 备注
  consumption REAL,                      -- 派生：L/100km，NULL=不可计算
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_vehicle_time ON fuel_records(vehicle_id, filled_at, id);

-- 费用记录：与小熊油耗导出的 4 个字段对应
CREATE TABLE IF NOT EXISTS expense_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL DEFAULT 1 REFERENCES vehicles(id),
  occurred_at TEXT NOT NULL,             -- ISO 本地时间
  category TEXT NOT NULL,                -- 裸车和税费/保险和交通规费/维修保养/配件费/交通罚款/其它
  amount REAL NOT NULL DEFAULT 0,        -- 金额（允许 0）
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expense_vehicle_time ON expense_records(vehicle_id, occurred_at, id);

-- 键值配置：邮件限流时间戳等
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 发信日志：kind = change(变更即时) / daily(每日全量) / manual(手动)
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  subject TEXT DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT DEFAULT ''
);
