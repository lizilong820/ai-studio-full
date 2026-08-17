const { db } = require('../database/db');

/**
 * 积分服务
 */

// 给用户加积分
function addCredits(userId, amount, type, description, relatedId = 0) {
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('用户不存在');

  const newCredits = user.credits + amount;
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(newCredits, userId);
  
  // 记录流水
  db.prepare(`INSERT INTO credit_logs (user_id, amount, type, description, related_id)
              VALUES (?, ?, ?, ?, ?)`).run(userId, amount, type, description, relatedId);
  
  return newCredits;
}

// 扣减积分
function deductCredits(userId, amount, type, description, relatedId = 0) {
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('用户不存在');
  
  if (user.credits < amount) {
    return { success: false, balance: user.credits, msg: '积分不足' };
  }

  const newCredits = user.credits - amount;
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(newCredits, userId);
  
  // 记录流水 (扣减为负数)
  db.prepare(`INSERT INTO credit_logs (user_id, amount, type, description, related_id)
              VALUES (?, ?, ?, ?, ?)`).run(userId, -amount, type, description, relatedId);
  
  return { success: true, balance: newCredits };
}

// 获取用户积分余额
function getBalance(userId) {
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  return user ? user.credits : 0;
}

// 获取积分流水
function getCreditLogs(userId, page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize;
  const logs = db.prepare(`SELECT * FROM credit_logs WHERE user_id = ? 
    ORDER BY id DESC LIMIT ? OFFSET ?`).all(userId, pageSize, offset);
  
  const total = db.prepare('SELECT COUNT(*) as count FROM credit_logs WHERE user_id = ?').get(userId).count;
  
  return { list: logs, total, page, pageSize };
}

module.exports = {
  addCredits,
  deductCredits,
  getBalance,
  getCreditLogs,
};
