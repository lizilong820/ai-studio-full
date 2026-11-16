const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting } = require('../database/db');
const { adminRequired } = require('../middleware/auth');
const creditService = require('../controllers/creditService');
const studioCardService = require('../controllers/studioCards');

const router = express.Router();

// 仪表盘统计
router.get('/dashboard', adminRequired, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const totalGens = db.prepare('SELECT COUNT(*) as count FROM generations').get().count;
  const totalCreditConsumed = db.prepare("SELECT ABS(SUM(amount)) as total FROM credit_logs WHERE type = 'consume'").get().total || 0;
  const todayGens = db.prepare("SELECT COUNT(*) as count FROM generations WHERE DATE(created_at) = DATE('now','localtime')").get().count;
  const todayNewUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = DATE('now','localtime')").get().count;
  const pendingGens = db.prepare("SELECT COUNT(*) as count FROM generations WHERE status = 'pending'").get().count;
  const totalRecharge = db.prepare("SELECT SUM(amount) as total FROM orders WHERE status = 'paid' OR status = 'manual'").get().total || 0;
  
  // 最近7天生成趋势
  const trendData = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM generations
    WHERE created_at >= datetime('now', '-7 days', 'localtime')
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all();
  
  // 工作室分布
  const studioStats = db.prepare(`
    SELECT studio_type, COUNT(*) as count
    FROM generations
    GROUP BY studio_type
    ORDER BY count DESC
  `).all();
  
  res.success({
    total_users: totalUsers,
    today_new_users: todayNewUsers,
    total_generations: totalGens,
    today_generations: todayGens,
    pending_generations: pendingGens,
    total_credit_consumed: totalCreditConsumed,
    total_recharge: totalRecharge,
    trend_data: trendData,
    studio_stats: studioStats,
  });
});

// ============ 用户管理 ============

router.get('/users', adminRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const keyword = req.query.keyword || '';
  const offset = (page - 1) * pageSize;
  
  let sql = 'SELECT id, username, email, credits, is_admin, status, created_at FROM users';
  let countSql = 'SELECT COUNT(*) as count FROM users';
  const params = [];
  
  if (keyword) {
    sql += ' WHERE username LIKE ? OR email LIKE ?';
    countSql += ' WHERE username LIKE ? OR email LIKE ?';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(pageSize, offset);
  
  const list = db.prepare(sql).all(...params);
  const total = db.prepare(countSql).get(...params.slice(0, countSql.includes('?') ? 2 : 0)).count;
  
  res.success({ list, total, page, pageSize });
});

// 修改用户状态
router.post('/users/:id/status', adminRequired, (req, res) => {
  const userId = req.params.id;
  const { status } = req.body;
  
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  res.success({}, '状态已更新');
});

// 调整用户积分
router.post('/users/:id/credits', adminRequired, (req, res) => {
  const userId = req.params.id;
  const { amount, remark } = req.body;
  
  if (!amount || isNaN(amount)) {
    return res.error('请输入有效的积分数量');
  }
  
  const amt = parseInt(amount);
  if (amt >= 0) {
    const newBalance = creditService.addCredits(userId, amt, 'manual', `管理员手动充值: ${remark || '调整积分'}`);
    res.success({ balance: newBalance }, `已增加 ${amt} 积分`);
  } else {
    const result = creditService.deductCredits(userId, Math.abs(amt), 'manual', `管理员手动扣除: ${remark || '调整积分'}`);
    if (result.success) {
      res.success({ balance: result.balance }, `已扣除 ${Math.abs(amt)} 积分`);
    } else {
      res.error(result.msg);
    }
  }
});

// 重置用户密码
router.post('/users/:id/reset-password', adminRequired, (req, res) => {
  const userId = req.params.id;
  const { password } = req.body;
  
  if (!password || password.length < 6) {
    return res.error('密码至少6位');
  }
  
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  res.success({}, '密码已重置');
});

// ============ 模型管理 ============

router.get('/models', adminRequired, (req, res) => {
  const list = db.prepare('SELECT * FROM models ORDER BY type, id DESC').all();
  res.success(list);
});

router.post('/models', adminRequired, (req, res) => {
  const { name, type, api_endpoint, api_key, model_identifier, price_per_call, is_default, status, description } = req.body;
  
  if (!name || !type || !api_endpoint || !model_identifier) {
    return res.error('请填写完整的模型信息');
  }
  
  if (is_default) {
    // 取消同类型其他默认
    db.prepare('UPDATE models SET is_default = 0 WHERE type = ?').run(type);
  }
  
  const result = db.prepare(`INSERT INTO models 
    (name, type, api_endpoint, api_key, model_identifier, price_per_call, is_default, status, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, type, api_endpoint, api_key || '', model_identifier, price_per_call || 10, is_default ? 1 : 0, status ?? 1, description || '');
  
  res.success({ id: result.lastInsertRowid }, '模型已添加');
});

router.put('/models/:id', adminRequired, (req, res) => {
  const modelId = req.params.id;
  const { name, type, api_endpoint, api_key, model_identifier, price_per_call, is_default, status, description } = req.body;
  
  if (is_default) {
    db.prepare('UPDATE models SET is_default = 0 WHERE type = ?').run(type);
  }
  
  const fields = [];
  const values = [];
  
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (type !== undefined) { fields.push('type = ?'); values.push(type); }
  if (api_endpoint !== undefined) { fields.push('api_endpoint = ?'); values.push(api_endpoint); }
  if (api_key !== undefined) { fields.push('api_key = ?'); values.push(api_key); }
  if (model_identifier !== undefined) { fields.push('model_identifier = ?'); values.push(model_identifier); }
  if (price_per_call !== undefined) { fields.push('price_per_call = ?'); values.push(price_per_call); }
  if (is_default !== undefined) { fields.push('is_default = ?'); values.push(is_default ? 1 : 0); }
  if (status !== undefined) { fields.push('status = ?'); values.push(status); }
  if (description !== undefined) { fields.push('description = ?'); values.push(description); }
  
  values.push(modelId);
  
  db.prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.success({}, '模型已更新');
});

router.delete('/models/:id', adminRequired, (req, res) => {
  db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  res.success({}, '模型已删除');
});

// 测试模型连接
router.post('/models/:id/test', adminRequired, async (req, res) => {
  const modelId = req.params.id;
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId);
  
  if (!model) {
    return res.error('模型不存在');
  }
  
  const aiAdapter = require('../controllers/aiAdapter');
  const startTime = Date.now();
  
  try {
    if (model.type === 'image') {
      const result = await aiAdapter.generateImage(modelId, 'a simple test image', { n: 1, size: '1024x1024' });
      const elapsed = Date.now() - startTime;
      res.success({ 
        success: true, 
        elapsed_ms: elapsed,
        mock: result.mock || false,
        image_count: result.images?.length || 0,
        message: `连接成功，耗时 ${elapsed}ms`
      });
} else if (model.type === 'video') {
      res.success({
        success: true,
        elapsed_ms: 0,
        mock: true,
        message: '视频模型配置已保存（视频模型暂不支持一键测试，请在视频工作室中验证）'
      });
    } else if (model.type === 'audio') {
      res.success({
        success: true,
        elapsed_ms: 0,
        mock: true,
        message: '音频模型配置已保存（音频工作室开发中，暂不支持一键测试）'
      });
    } else {
      const result = await aiAdapter.generateText(modelId, [
        { role: 'user', content: '请只回复"测试成功"三个字。' }
      ], { temperature: 0, max_tokens: 20 });
      const elapsed = Date.now() - startTime;
      res.success({ 
        success: true, 
        elapsed_ms: elapsed,
        mock: result.mock || false,
        preview: result.text?.slice(0, 100) || '',
        message: `连接成功，耗时 ${elapsed}ms`
      });
    }
  } catch (err) {
    const elapsed = Date.now() - startTime;
    res.error(`连接失败 (${elapsed}ms): ${err.message}`);
  }
});

// ============ 生成记录 ============

router.get('/generations', adminRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const status = req.query.status || '';
  const studio = req.query.studio || '';
  const offset = (page - 1) * pageSize;
  
  let sql = `SELECT g.id, g.user_id, g.studio_type, g.model_id, g.status, g.credits_used, g.created_at, g.completed_at, u.username, m.name as model_name 
             FROM generations g 
             LEFT JOIN users u ON g.user_id = u.id
             LEFT JOIN models m ON g.model_id = m.id
             WHERE 1=1`;
  let countSql = 'SELECT COUNT(*) as count FROM generations WHERE 1=1';
  const params = [];
  
  if (status) {
    sql += ' AND g.status = ?';
    countSql += ' AND status = ?';
    params.push(status);
  }
  if (studio) {
    sql += ' AND g.studio_type = ?';
    countSql += ' AND studio_type = ?';
    params.push(studio);
  }
  
  sql += ' ORDER BY g.id DESC LIMIT ? OFFSET ?';
  params.push(pageSize, offset);
  
  const list = db.prepare(sql).all(...params);
  const total = db.prepare(countSql).get(...params.slice(0, params.length - 2)).count;
  
  // 列表不解析 params/result 大字段，详情页单独查，提升加载速度
  
  res.success({ list, total, page, pageSize });
});

// 单条生成记录详情
router.delete('/generations/:id', adminRequired, (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM generations WHERE id = ?').run(id);
  res.success({}, '已删除');
});

router.delete('/generations', adminRequired, (req, res) => {
  const ids = req.body.ids || [];
  if (!ids.length) return res.error('请选择要删除的记录');
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM generations WHERE id IN (${placeholders})`).run(...ids);
  res.success({}, `已删除 ${ids.length} 条记录`);
});

router.get('/generations/:id', adminRequired, (req, res) => {
  const id = req.params.id;
  const gen = db.prepare(`
    SELECT g.*, u.username, m.name as model_name 
    FROM generations g 
    LEFT JOIN users u ON g.user_id = u.id
    LEFT JOIN models m ON g.model_id = m.id
    WHERE g.id = ?
  `).get(id);
  
  if (!gen) {
    return res.error('记录不存在');
  }
  
  if (gen.params) { try { gen.params = JSON.parse(gen.params); } catch (e) {} }
  if (gen.result) { try { gen.result = JSON.parse(gen.result); } catch (e) {} }
  
  res.success(gen);
});

// ============ 充值套餐 ============

router.get('/packages', adminRequired, (req, res) => {
  const list = db.prepare('SELECT * FROM recharge_packages ORDER BY sort, id').all();
  res.success(list);
});

router.post('/packages', adminRequired, (req, res) => {
  const { name, price, credits, bonus, status, sort } = req.body;
  const result = db.prepare(`INSERT INTO recharge_packages (name, price, credits, bonus, status, sort)
    VALUES (?, ?, ?, ?, ?, ?)`).run(name, price, credits, bonus || 0, status ?? 1, sort || 0);
  res.success({ id: result.lastInsertRowid }, '套餐已添加');
});

router.put('/packages/:id', adminRequired, (req, res) => {
  const id = req.params.id;
  const { name, price, credits, bonus, status, sort } = req.body;
  db.prepare(`UPDATE recharge_packages SET name=?, price=?, credits=?, bonus=?, status=?, sort=? WHERE id=?`)
    .run(name, price, credits, bonus || 0, status ?? 1, sort || 0, id);
  res.success({}, '套餐已更新');
});

router.delete('/packages/:id', adminRequired, (req, res) => {
  db.prepare('DELETE FROM recharge_packages WHERE id = ?').run(req.params.id);
  res.success({}, '套餐已删除');
});

// ============ 订单管理 ============

router.get('/orders', adminRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const status = req.query.status || '';
  const offset = (page - 1) * pageSize;
  
  let sql = `SELECT o.*, u.username, p.name as package_name 
             FROM orders o 
             LEFT JOIN users u ON o.user_id = u.id
             LEFT JOIN recharge_packages p ON o.package_id = p.id
             WHERE 1=1`;
  let countSql = 'SELECT COUNT(*) as count FROM orders WHERE 1=1';
  const params = [];
  
  if (status) {
    sql += ' AND o.status = ?';
    countSql += ' AND status = ?';
    params.push(status);
  }
  
  sql += ' ORDER BY o.id DESC LIMIT ? OFFSET ?';
  params.push(pageSize, offset);
  
  const list = db.prepare(sql).all(...params);
  const total = db.prepare(countSql).get(...params.slice(0, params.length - 2)).count;
  
  res.success({ list, total, page, pageSize });
});

// 手动确认订单到账
router.post('/orders/:id/confirm', adminRequired, (req, res) => {
  const orderId = req.params.id;
  const confirmOrder = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return { status: 'missing' };

    const updateResult = db.prepare(`UPDATE orders
      SET status = 'manual', paid_at = datetime('now','localtime')
      WHERE id = ? AND status = 'pending'`).run(orderId);
    if (updateResult.changes !== 1) return { status: 'processed' };

    creditService.addCredits(
      order.user_id,
      order.credits,
      'recharge',
      `充值套餐: ${order.credits}积分`,
      orderId
    );
    return { status: 'confirmed' };
  });

  const result = confirmOrder();
  if (result.status === 'missing') return res.error('订单不存在');
  if (result.status === 'processed') return res.error('订单已支付');

  res.success({}, '订单已确认到账');
});

// ============ 系统设置 ============

router.get('/settings', adminRequired, (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  settings.forEach(s => { result[s.key] = s.value; });
  res.success(result);
});

router.post('/settings', adminRequired, (req, res) => {
  const settings = req.body;
  for (const [key, value] of Object.entries(settings)) {
    setSetting(key, String(value));
  }
  res.success({}, '设置已保存');
});

// ============ 首页工作室卡片 ============

router.get('/studio-cards', adminRequired, (req, res) => {
  res.success(studioCardService.listAllStudioCards());
});

router.post('/studio-cards', adminRequired, (req, res) => {
  const result = studioCardService.createStudioCard(req.body);
  if (result.error) return res.error(result.error);
  res.success({ id: result.id }, '卡片已添加');
});

router.put('/studio-cards/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.error('卡片不存在');

  const result = studioCardService.updateStudioCard(id, req.body);
  if (result.error) return res.error(result.error);
  res.success({ id: result.id }, '卡片已更新');
});

router.post('/studio-cards/:id/status', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.error('卡片不存在');

  const result = studioCardService.setStudioCardStatus(id, req.body.status);
  if (result.error) return res.error(result.error);
  res.success({ status: result.status }, result.status === 1 ? '卡片已显示' : '卡片已隐藏');
});

router.delete('/studio-cards/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.error('卡片不存在');

  const result = studioCardService.deleteStudioCard(id);
  if (result.error) return res.error(result.error);
  res.success({}, '卡片已删除');
});

// ============ 积分流水（管理员查看所有） ============

router.get('/credit-logs', adminRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const userId = req.query.user_id || '';
  const offset = (page - 1) * pageSize;
  
  let sql = `SELECT c.*, u.username FROM credit_logs c LEFT JOIN users u ON c.user_id = u.id WHERE 1=1`;
  let countSql = 'SELECT COUNT(*) as count FROM credit_logs WHERE 1=1';
  const params = [];
  
  if (userId) {
    sql += ' AND c.user_id = ?';
    countSql += ' AND user_id = ?';
    params.push(userId);
  }
  
  sql += ' ORDER BY c.id DESC LIMIT ? OFFSET ?';
  params.push(pageSize, offset);
  
  const list = db.prepare(sql).all(...params);
  const total = db.prepare(countSql).get(...params.slice(0, params.length - 2)).count;
  
  res.success({ list, total, page, pageSize });
});

module.exports = router;
