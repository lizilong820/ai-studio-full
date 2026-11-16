const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.AI_STUDIO_DB_PATH
  ? path.resolve(process.env.AI_STUDIO_DB_PATH)
  : path.join(__dirname, 'ai_studio.db');
const db = new Database(dbPath);

// 启用外键
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');
db.pragma('journal_mode = WAL');

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

module.exports = { db, dbPath, getSetting, setSetting };

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

// ============ 持久化生成任务与 Webhook 投递 ============

db.exec(`
  CREATE TABLE IF NOT EXISTS generation_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id INTEGER NOT NULL UNIQUE,
    public_id TEXT NOT NULL UNIQUE,
    job_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'processing', 'retry', 'succeeded', 'failed')),
    phase TEXT DEFAULT '',
    provider_task_id TEXT DEFAULT '',
    progress INTEGER NOT NULL DEFAULT 0,
    run_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
    next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_owner TEXT DEFAULT '',
    lease_expires_at TEXT,
    last_error TEXT DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_generation_jobs_claim
  ON generation_jobs(status, next_run_at, lease_expires_at, id)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS batch_download_tasks (
    public_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    generation_ids JSON NOT NULL CHECK (json_valid(generation_ids)),
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'processing', 'retry', 'done', 'failed')),
    total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
    done_count INTEGER NOT NULL DEFAULT 0 CHECK (done_count >= 0),
    file_path TEXT DEFAULT '',
    error_msg TEXT DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
    next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_owner TEXT DEFAULT '',
    lease_expires_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_download_tasks_claim
  ON batch_download_tasks(status, next_run_at, lease_expires_at, created_at)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    webhook_url TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT '',
    secret TEXT DEFAULT '',
    status INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, webhook_url)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    generation_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'processing', 'retry', 'delivered', 'failed')),
    attempt INTEGER NOT NULL DEFAULT 0,
    next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_owner TEXT DEFAULT '',
    lease_expires_at TEXT,
    last_error TEXT DEFAULT '',
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE,
    UNIQUE(subscription_id, generation_id, event_type)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_claim
  ON webhook_deliveries(status, next_run_at, lease_expires_at, id)`);

// ============ 电商工作流 ============

// 工作流模板（内置模板由 config/workflowTemplates.js 初始化）
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    summary TEXT DEFAULT '',
    category TEXT DEFAULT 'ecommerce',
    emoji TEXT DEFAULT '🛠️',
    badge TEXT DEFAULT '',
    inputs TEXT NOT NULL DEFAULT '[]',
    nodes TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

// 工作流运行实例：一次运行对应一条记录，节点进度存在 node_states JSON 里
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    template_id INTEGER NOT NULL,
    template_key TEXT NOT NULL DEFAULT '',
    model_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
    inputs TEXT NOT NULL DEFAULT '{}',
    nodes_snapshot TEXT NOT NULL DEFAULT '[]',
    node_states TEXT NOT NULL DEFAULT '[]',
    current_index INTEGER NOT NULL DEFAULT 0,
    total_cost INTEGER NOT NULL DEFAULT 0,
    final_image TEXT DEFAULT '',
    error_msg TEXT DEFAULT '',
    next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    finished_at TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (template_id) REFERENCES workflow_templates(id)
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_id ON workflow_runs(user_id, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_claim ON workflow_runs(status, next_run_at, locked_until, id)');

// 内置模板初始化：按 template_key 幂等写入，不覆盖后台改过的名称/排序/启停状态
try {
  const { WORKFLOW_TEMPLATES } = require('../config/workflowTemplates');
  const existsTemplate = db.prepare('SELECT id FROM workflow_templates WHERE template_key = ?');
  const insertTemplate = db.prepare(`INSERT INTO workflow_templates
    (template_key, name, summary, category, emoji, badge, inputs, nodes, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let seeded = 0;
  for (const tpl of WORKFLOW_TEMPLATES) {
    if (existsTemplate.get(tpl.key)) continue;
    insertTemplate.run(
      tpl.key,
      tpl.name,
      tpl.summary || '',
      tpl.category || 'ecommerce',
      tpl.emoji || '🛠️',
      tpl.badge || '',
      JSON.stringify(tpl.inputs || []),
      JSON.stringify(tpl.nodes || []),
      tpl.sort_order || 0
    );
    seeded += 1;
  }
  if (seeded > 0) console.log(`✅ 已初始化 ${seeded} 个电商工作流模板`);
} catch (error) {
  console.warn('工作流模板初始化失败：' + error.message);
}

// 优化“电商主图套图”：旧版场景图和留白图基于上一节点反复转绘，商品容易变形、比例失真。
// v2：四张图都从用户原图独立生成，改用英文商业摄影提示词。
// v3：不再写“不要站立”这类负面描述（实测反而诱导模型把葡萄立起来），
//     改成“保持原图姿态、只换背景”的正向约束，并用具体摆放动作约束场景。
function syncWorkflowTemplate(templateKey, label) {
  const template = db.prepare('SELECT id FROM workflow_templates WHERE template_key = ?')
    .get(templateKey);
  if (!template) return false;
  const { WORKFLOW_TEMPLATES } = require('../config/workflowTemplates');
  const latest = WORKFLOW_TEMPLATES.find(item => item.key === templateKey);
  if (!latest) return false;
  db.prepare(`UPDATE workflow_templates SET
    summary = ?, inputs = ?, nodes = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?`).run(
    latest.summary || '',
    JSON.stringify(latest.inputs || []),
    JSON.stringify(latest.nodes || []),
    template.id
  );
  console.log(`✅ 已更新${label}`);
  return true;
}

const WORKFLOW_MAIN_IMAGE_SET_KEY = 'workflow_main_image_set_v2';
if (getSetting(WORKFLOW_MAIN_IMAGE_SET_KEY, '') !== '1') {
  try {
    syncWorkflowTemplate('main_image_set', '电商主图套图模板');
    setSetting(WORKFLOW_MAIN_IMAGE_SET_KEY, '1');
  } catch (error) {
    console.warn('电商主图套图模板更新失败：' + error.message);
  }
}

const WORKFLOW_MAIN_IMAGE_SET_POSE_KEY = 'workflow_main_image_set_pose_v1';
if (getSetting(WORKFLOW_MAIN_IMAGE_SET_POSE_KEY, '') !== '1') {
  try {
    syncWorkflowTemplate('main_image_set', '电商主图套图模板（保持商品原姿态）');
    setSetting(WORKFLOW_MAIN_IMAGE_SET_POSE_KEY, '1');
  } catch (error) {
    console.warn('电商主图套图姿态约束更新失败：' + error.message);
  }
}

// ============ 首页工作室卡片 ============

db.exec(`
  CREATE TABLE IF NOT EXISTS studio_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '✨',
    href TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '工具',
    tags TEXT NOT NULL DEFAULT '[]',
    highlight TEXT NOT NULL DEFAULT '',
    highlight_style TEXT NOT NULL DEFAULT '',
    credit TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1 CHECK (status IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_studio_cards_status_sort ON studio_cards(status, sort_order, id)');

// 内置卡片只初始化一次：用 settings 标记，管理员删除后重启不会重新出现
const STUDIO_CARDS_SEED_KEY = 'studio_cards_seeded_v1';
if (getSetting(STUDIO_CARDS_SEED_KEY, '') !== '1') {
  try {
    const existingCards = db.prepare('SELECT COUNT(*) as count FROM studio_cards').get().count;
    if (existingCards === 0) {
      const { DEFAULT_STUDIO_CARDS } = require('../config/studioCardDefaults');
      const insertCard = db.prepare(`INSERT INTO studio_cards
        (title, description, icon, href, category, tags, highlight, highlight_style, credit, keywords, sort_order, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
      const seedCards = db.transaction(cards => {
        for (const card of cards) {
          insertCard.run(
            card.title,
            card.description || '',
            card.icon || '✨',
            card.href,
            card.category,
            JSON.stringify(card.tags || []),
            card.highlight || '',
            card.highlight_style || '',
            card.credit || '',
            JSON.stringify(card.keywords || []),
            card.sort_order || 0
          );
        }
      });
      seedCards(DEFAULT_STUDIO_CARDS);
      console.log(`✅ 已初始化 ${DEFAULT_STUDIO_CARDS.length} 个首页工作室卡片`);
    }
    setSetting(STUDIO_CARDS_SEED_KEY, '1');
  } catch (error) {
    console.warn('首页工作室卡片初始化失败：' + error.message);
  }
}

// 旧版把同一个电商页面拆成了“电商工作流”和“电商套图工作室”两个入口，
// 一次性合并为“电商工作室”。只处理仍保持初始标题和链接的卡片，避免覆盖管理员自定义内容。
const STUDIO_CARDS_MERGE_ECOMMERCE_KEY = 'studio_cards_merge_ecommerce_v1';
if (getSetting(STUDIO_CARDS_MERGE_ECOMMERCE_KEY, '') !== '1') {
  try {
    const workflowCard = db.prepare('SELECT id FROM studio_cards WHERE title = ? AND href = ?')
      .get('电商工作流', 'workflow.html');
    const studioCard = db.prepare('SELECT id FROM studio_cards WHERE title = ? AND href = ?')
      .get('电商套图工作室', 'workflow.html#studio');
    if (workflowCard && studioCard) {
      const { DEFAULT_STUDIO_CARDS } = require('../config/studioCardDefaults');
      const mergedCard = DEFAULT_STUDIO_CARDS[0];
      const mergeCards = db.transaction(() => {
        db.prepare(`UPDATE studio_cards SET
          title = ?, description = ?, icon = ?, href = ?, category = ?, tags = ?,
          highlight = ?, highlight_style = ?, credit = ?, keywords = ?,
          updated_at = datetime('now', 'localtime')
          WHERE id = ?`).run(
          mergedCard.title,
          mergedCard.description || '',
          mergedCard.icon || '✨',
          mergedCard.href,
          mergedCard.category,
          JSON.stringify(mergedCard.tags || []),
          mergedCard.highlight || '',
          mergedCard.highlight_style || '',
          mergedCard.credit || '',
          JSON.stringify(mergedCard.keywords || []),
          workflowCard.id
        );
        db.prepare('DELETE FROM studio_cards WHERE id = ?').run(studioCard.id);
      });
      mergeCards();
      console.log('✅ 已合并重复的电商工作室入口');
    }
    setSetting(STUDIO_CARDS_MERGE_ECOMMERCE_KEY, '1');
  } catch (error) {
    console.warn('电商工作室入口合并失败：' + error.message);
  }
}

// 电商工作室默认进入“直接生图”模式，首页卡片也要直接落到套图表单
const STUDIO_CARDS_DIRECT_KEY = 'studio_cards_ecommerce_direct_v1';
if (getSetting(STUDIO_CARDS_DIRECT_KEY, '') !== '1') {
  try {
    const { DEFAULT_STUDIO_CARDS } = require('../config/studioCardDefaults');
    const card = DEFAULT_STUDIO_CARDS[0];
    const existing = db.prepare('SELECT id FROM studio_cards WHERE title = ? AND href IN (?, ?)')
      .get('电商工作室', 'workflow.html', 'workflow.html#studio');
    if (existing) {
      db.prepare(`UPDATE studio_cards SET
        description = ?, icon = ?, href = ?, category = ?, tags = ?, highlight = ?,
        highlight_style = ?, credit = ?, keywords = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?`).run(
        card.description || '',
        card.icon || '✨',
        card.href,
        card.category,
        JSON.stringify(card.tags || []),
        card.highlight || '',
        card.highlight_style || '',
        card.credit || '',
        JSON.stringify(card.keywords || []),
        existing.id
      );
    }
    setSetting(STUDIO_CARDS_DIRECT_KEY, '1');
  } catch (error) {
    console.warn('电商工作室首页卡片更新失败：' + error.message);
  }
}

// ============ 查询与租户隔离索引 ============

db.exec('CREATE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_generations_user_id_id ON generations(user_id, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_generations_user_studio_id ON generations(user_id, studio_type, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_generations_user_status_id ON generations(user_id, status, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_generations_status_created_at ON generations(status, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_favorites_generation_id ON favorites(generation_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_credit_logs_user_created_at ON credit_logs(user_id, created_at DESC, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_credit_logs_related_type ON credit_logs(user_id, related_id, type)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user_id_id ON orders(user_id, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_remark_pay_method ON orders(remark, pay_method)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status_id ON orders(status, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_param_templates_user_studio_id ON param_templates(user_id, studio_type, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_search_history_user_updated_at ON search_history(user_id, updated_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_search_history_user_keyword ON search_history(user_id, keyword)');
db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_user_created_at ON api_usage(user_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_user_endpoint_created_at ON api_usage(user_id, endpoint, created_at DESC)');
