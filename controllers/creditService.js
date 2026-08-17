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
  return addCreditsTransaction.immediate(userId, amount, type, description, relatedId);
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

const failGenerationAndRefundTransaction = db.transaction((generationId, errorMessage) => {
  const generation = db.prepare(`
    SELECT id, user_id, credits_used, status
    FROM generations
    WHERE id = ?
  `).get(generationId);
  if (!generation) throw new Error('生成任务不存在');
  if (generation.status === 'success') throw new Error('成功任务不能退款');

  const credits = Number(generation.credits_used);
  if (!Number.isFinite(credits) || credits < 0) {
    throw new Error(`任务 ${generationId} 的计费金额无效`);
  }

  const refunds = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM credit_logs
    WHERE user_id = ? AND type = 'refund' AND related_id = ?
  `).get(generation.user_id, generationId);

  if (refunds.count > 0) {
    if (refunds.count !== 1 || Number(refunds.total) !== credits) {
      throw new Error(`任务 ${generationId} 的退款流水不匹配`);
    }
  } else if (credits > 0) {
    const updateResult = db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?')
      .run(credits, generation.user_id);
    if (updateResult.changes !== 1) throw new Error('用户不存在');
    db.prepare(`INSERT INTO credit_logs (user_id, amount, type, description, related_id)
                VALUES (?, ?, 'refund', ?, ?)`).run(
      generation.user_id,
      credits,
      `生成失败退款 - 任务${generationId}`,
      generationId
    );
  }

  if (generation.status === 'pending' || generation.status === 'processing') {
    db.prepare(`UPDATE generations
      SET status = 'failed', error_msg = ?, completed_at = datetime('now','localtime')
      WHERE id = ? AND status IN ('pending', 'processing')`)
      .run(errorMessage || '生成失败', generationId);
  }

  return db.prepare('SELECT credits FROM users WHERE id = ?').get(generation.user_id).credits;
});

function failGenerationAndRefund(generationId, errorMessage) {
  return failGenerationAndRefundTransaction.immediate(generationId, errorMessage);
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
  failGenerationAndRefund,
  getBalance,
  getCreditLogs,
};
