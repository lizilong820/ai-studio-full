const { db } = require('../database/db');
const { hashApiKey } = require('../utils/apiKey');

// API Key 鉴权中间件
function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['X-API-Key'];

  if (typeof apiKey !== 'string' || apiKey.length < 20 || apiKey.length > 200) {
    return res.status(401).json({
      code: 401,
      msg: '缺少或无效的 API Key'
    });
  }

  const keyHash = hashApiKey(apiKey);
  let keyRecord = db.prepare(`
    SELECT ak.*, u.id as user_id, u.username, u.credits, u.status as user_status
    FROM api_keys ak
    JOIN users u ON ak.user_id = u.id
    WHERE ak.api_key_hash = ?
  `).get(keyHash);

  // 一次性兼容迁移历史明文密钥，成功后立即清空明文。
  if (!keyRecord) {
    const legacy = db.prepare(`
      SELECT ak.*, u.id as user_id, u.username, u.credits, u.status as user_status
      FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE ak.api_key = ? AND ak.api_key_hash IS NULL
    `).get(apiKey);
    if (legacy) {
      db.prepare('UPDATE api_keys SET api_key = ?, api_key_hash = ?, api_key_prefix = ? WHERE id = ? AND api_key_hash IS NULL')
        .run(keyHash, keyHash, apiKey.slice(0, 10), legacy.id);
      keyRecord = db.prepare(`
        SELECT ak.*, u.id as user_id, u.username, u.credits, u.status as user_status
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.id = ? AND ak.api_key_hash = ?
      `).get(legacy.id, keyHash);
    }
  }

  if (!keyRecord) {
    return res.status(401).json({
      code: 401,
      msg: '无效的 API Key'
    });
  }

  if (keyRecord.status !== 1) {
    return res.status(403).json({
      code: 403,
      msg: '该 API Key 已被禁用'
    });
  }

  if (keyRecord.user_status !== 1) {
    return res.status(403).json({
      code: 403,
      msg: '账号已被禁用'
    });
  }

  // 挂载用户和密钥信息到 req
  req.apiUser = {
    id: keyRecord.user_id,
    username: keyRecord.username,
    credits: keyRecord.credits
  };
  req.apiKeyId = keyRecord.id;
  req.apiKey = apiKey;

  // 更新最后使用时间
  db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(keyRecord.id);

  next();
}

// 记录API调用
function recordUsage(user_id, api_key_id, endpoint, studio_type, task_id, status, cost, response_time, error_msg) {
  try {
    db.prepare(`
      INSERT INTO api_usage (user_id, api_key_id, endpoint, studio_type, task_id, status, cost, response_time, error_msg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user_id, api_key_id, endpoint, studio_type, task_id, status, cost, response_time, error_msg || null);
  } catch (err) {
    console.error('记录API调用失败:', err);
  }
}

module.exports = { apiKeyAuth, recordUsage };
