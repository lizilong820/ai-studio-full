const { db } = require('../database/db');

/**
 * 积分服务
 */

function validateAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('积分数量必须为正整数');
  }
}

const addCreditsTransaction = db.transaction((userId, amount, type, description, relatedId) => {
  if (type === 'refund' && relatedId) {
    const existingRefund = db.prepare(`SELECT id FROM credit_logs
      WHERE user_id = ? AND type = 'refund' AND related_id = ? LIMIT 1`)
      .get(userId, relatedId);
    if (existingRefund) {
      return db.prepare('SELECT credits FROM users WHERE id = ?').get(userId).credits;
    }
  }

  const updateResult = db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?')
    .run(amount, userId);
  if (updateResult.changes !== 1) throw new Error('用户不存在');

  db.prepare(`INSERT INTO credit_logs (user_id, amount, type, description, related_id)
              VALUES (?, ?, ?, ?, ?)`).run(userId, amount, type, description, relatedId);

  return db.prepare('SELECT credits FROM users WHERE id = ?').get(userId).credits;
});

// 给用户加积分
function addCredits(userId, amount, type, description, relatedId = 0) {
  validateAmount(amount);
  return addCreditsTransaction(userId, amount, type, description, relatedId);
}

const deductCreditsTransaction = db.transaction((userId, amount, type, description, relatedId) => {
  const updateResult = db.prepare(`UPDATE users
    SET credits = credits - ?
    WHERE id = ? AND credits >= ?`).run(amount, userId, amount);

  if (updateResult.changes !== 1) {
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('用户不存在');
    return { success: false, balance: user.credits, msg: '积分不足' };
  }

  db.prepare(`INSERT INTO credit_logs (user_id, amount, type, description, related_id)
              VALUES (?, ?, ?, ?, ?)`).run(userId, -amount, type, description, relatedId);

  const balance = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId).credits;
  return { success: true, balance };
});

// 扣减积分
function deductCredits(userId, amount, type, description, relatedId = 0) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { success: false, balance: getBalance(userId), msg: '计费参数无效' };
  }
  return deductCreditsTransaction(userId, amount, type, description, relatedId);
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
