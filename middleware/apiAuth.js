const { db } = require('../database/db');

// API Key 鉴权中间件
function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['X-API-Key'];

  if (!apiKey) {
    return res.status(401).json({
      code: 401,
      msg: '缺少 API Key，请在请求头中携带 X-API-Key'
    });
  }

  const keyRecord = db.prepare(`
    SELECT ak.*, u.id as user_id, u.username, u.credits, u.status as user_status
    FROM api_keys ak
    JOIN users u ON ak.user_id = u.id
    WHERE ak.api_key = ?
  `).get(apiKey);

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
