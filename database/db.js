const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.AI_STUDIO_DB_PATH
  ? path.resolve(process.env.AI_STUDIO_DB_PATH)
  : path.join(__dirname, 'ai_studio.db');
const db = new Database(dbPath);

// 启用外键
db.pragma('foreign_keys = ON');

// ============ 建表 ============

// 用户表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT DEFAULT '',
    credits INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    status INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

// 模型表
db.exec(`
  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- image / text
    api_endpoint TEXT NOT NULL,
    api_key TEXT DEFAULT '',
    model_identifier TEXT NOT NULL,
    price_per_call INTEGER DEFAULT 10,
    is_default INTEGER DEFAULT 0,
    status INTEGER DEFAULT 1, -- 1启用 0禁用
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

// 生成记录表
db.exec(`
  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    studio_type TEXT NOT NULL, -- ecommerce / xiaohongshu / poster / copywriting
    model_id INTEGER,
    params TEXT, -- JSON 参数
    result TEXT, -- JSON 结果
    credits_used INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending', -- pending / success / failed
    error_msg TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    completed_at TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// 积分流水表
db.exec(`
  CREATE TABLE IF NOT EXISTS credit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL, -- recharge / consume / refund / manual
    description TEXT DEFAULT '',
    related_id INTEGER DEFAULT 0, -- 关联ID (generation id / order id)
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// 充值套餐表
db.exec(`
  CREATE TABLE IF NOT EXISTS recharge_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    credits INTEGER NOT NULL,
    bonus INTEGER DEFAULT 0,
    status INTEGER DEFAULT 1,
    sort INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

// 订单表
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    package_id INTEGER,
    amount REAL NOT NULL,
    credits INTEGER NOT NULL,
    status TEXT DEFAULT 'pending', -- pending / paid / failed / cancelled / manual
    pay_method TEXT DEFAULT '',
    transaction_id TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    paid_at TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// 系统设置表 (kv)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

// ============ 初始数据 ============

// 检查是否有管理员
const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').get().count;
if (adminCount === 0) {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (adminUsername && adminPassword && Array.from(adminPassword).length >= 12) {
    const hash = bcrypt.hashSync(adminPassword, 10);
    db.prepare(`INSERT INTO users (username, password_hash, is_admin, status)
                VALUES (?, ?, ?, ?)`)
      .run(adminUsername, hash, 1, 1);
    console.log('初始管理员已创建');
  } else {
    console.warn('未创建初始管理员：请同时配置管理员用户名和至少 12 个字符的密码');
  }
}

// 默认设置
const defaultSettings = {
  'site_name': 'AI工作室',
  'register_bonus_credits': '100',
  'default_image_model': '',
  'default_text_model': '',
  'enable_register': '1',
  'per_page': '20',
};

const insertSettingStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSettingStmt.run(key, value);
}

// 示例模型
const modelCount = db.prepare('SELECT COUNT(*) as count FROM models').get().count;
if (modelCount === 0) {
  const insertModel = db.prepare(`INSERT INTO models 
    (name, type, api_endpoint, api_key, model_identifier, price_per_call, is_default, status, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  
  insertModel.run(
    '示例生图模型',
    'image',
    'https://api.example.com/v1/images/generations',
    'sk-example-image-key-please-change',
    'flux-pro',
    15,
    1,
    1,
    '示例生图模型，请在后台修改API配置'
  );
  
  insertModel.run(
    '示例文本模型',
    'text',
    'https://api.example.com/v1/chat/completions',
    'sk-example-text-key-please-change',
    'gpt-4o',
    5,
    1,
    1,
    '示例文本模型，请在后台修改API配置'
  );
  
  console.log('✅ 示例模型已初始化');
}

// 充值套餐
const pkgCount = db.prepare('SELECT COUNT(*) as count FROM recharge_packages').get().count;
if (pkgCount === 0) {
  const insertPkg = db.prepare(`INSERT INTO recharge_packages
    (name, price, credits, bonus, status, sort) VALUES (?, ?, ?, ?, ?, ?)`);
  insertPkg.run('体验套餐', 9.9, 100, 10, 1, 1);
  insertPkg.run('标准套餐', 29.9, 350, 50, 1, 2);
  insertPkg.run('进阶套餐', 99, 1200, 200, 1, 3);
  insertPkg.run('旗舰套餐', 299, 4000, 800, 1, 4);
  console.log('✅ 充值套餐已初始化');
}

// ============ 工具函数 ============

function getSetting(key, defaultValue = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
  if (existing) {
    db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now','localtime') WHERE key = ?").run(value, key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

module.exports = { db, getSetting, setSetting };

// ============ 数据库迁移 (新增列/表) ============

// 1. generations 表加 is_favorite 字段 (收藏)
try {
  db.prepare('ALTER TABLE generations ADD COLUMN is_favorite INTEGER DEFAULT 0').run();
  console.log('✅ generations 表已添加 is_favorite 字段');
} catch (e) { /* 已存在则忽略 */ }

// 2. users 表加 phone / invite_code / invited_by / sign_days / last_sign_at
try {
  db.prepare('ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ""').run();
  console.log('✅ users 表已添加 phone 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE users ADD COLUMN invite_code TEXT DEFAULT ""').run();
  console.log('✅ users 表已添加 invite_code 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE users ADD COLUMN invited_by INTEGER DEFAULT 0').run();
  console.log('✅ users 表已添加 invited_by 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE users ADD COLUMN sign_days INTEGER DEFAULT 0').run();
  console.log('✅ users 表已添加 sign_days 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE users ADD COLUMN last_sign_at TEXT DEFAULT ""').run();
  console.log('✅ users 表已添加 last_sign_at 字段');
} catch (e) {}

// 3. 收藏表 (单独存，便于筛选)
db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    generation_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (generation_id) REFERENCES generations(id),
    UNIQUE(user_id, generation_id)
  )
`);

// 4. 搜索历史表
db.exec(`
  CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 0,
    keyword TEXT NOT NULL,
    search_count INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

// 5. 参数模板表
db.exec(`
  CREATE TABLE IF NOT EXISTS param_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    studio_type TEXT NOT NULL,
    name TEXT NOT NULL,
    params TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// 6. 为现有用户生成邀请码
(function() {
  const users = db.prepare("SELECT id, username FROM users WHERE invite_code = '' OR invite_code IS NULL").all();
  const update = db.prepare('UPDATE users SET invite_code = ? WHERE id = ?');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  users.forEach(u => {
    let code = '';
    const seed = u.id + u.username.length;
    for (let i = 0; i < 6; i++) {
      code += chars[(seed * (i + 1) * 7 + u.id * 3) % chars.length];
    }
    update.run(code, u.id);
  });
  if (users.length > 0) console.log(`✅ 已为 ${users.length} 个用户生成邀请码`);
})();

// ============ API开放平台表 ============

// API密钥表
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '默认密钥',
    api_key TEXT,
    api_key_hash TEXT,
    api_key_prefix TEXT DEFAULT '',
    status INTEGER DEFAULT 1,
    last_used_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

try {
  db.prepare('ALTER TABLE api_keys ADD COLUMN api_key_hash TEXT').run();
} catch (e) {}
try {
  db.prepare('ALTER TABLE api_keys ADD COLUMN api_key_prefix TEXT DEFAULT ""').run();
} catch (e) {}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(api_key_hash) WHERE api_key_hash IS NOT NULL');

// API调用记录表
db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    api_key_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    studio_type TEXT,
    task_id TEXT,
    status TEXT DEFAULT 'success',
    cost INTEGER DEFAULT 0,
    response_time INTEGER DEFAULT 0,
    error_msg TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_user_id ON api_usage(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_api_key_id ON api_usage(api_key_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage(created_at)');

// ============ API开放平台 v1.1 升级 ============

// 1. api_keys 表加 webhook_url / webhook_secret / rate_limit
try {
  db.prepare('ALTER TABLE api_keys ADD COLUMN webhook_url TEXT DEFAULT ""').run();
  console.log('✅ api_keys 表已添加 webhook_url 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE api_keys ADD COLUMN webhook_secret TEXT DEFAULT ""').run();
  console.log('✅ api_keys 表已添加 webhook_secret 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE api_keys ADD COLUMN rate_limit INTEGER DEFAULT 60').run();
  console.log('✅ api_keys 表已添加 rate_limit 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE api_keys ADD COLUMN total_calls INTEGER DEFAULT 0').run();
  console.log('✅ api_keys 表已添加 total_calls 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE api_keys ADD COLUMN total_credits INTEGER DEFAULT 0').run();
  console.log('✅ api_keys 表已添加 total_credits 字段');
} catch (e) {}

// 2. generations 表加 api_key_id / webhook_notified
try {
  db.prepare('ALTER TABLE generations ADD COLUMN api_key_id INTEGER DEFAULT 0').run();
  console.log('✅ generations 表已添加 api_key_id 字段');
} catch (e) {}
try {
  db.prepare('ALTER TABLE generations ADD COLUMN webhook_notified INTEGER DEFAULT 0').run();
  console.log('✅ generations 表已添加 webhook_notified 字段');
} catch (e) {}
