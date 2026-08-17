const crypto = require('crypto');
const { db } = require('../database/db');

/**
 * 积分服务
 */

function normalizeAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('积分数量必须为正数');
  }
  const normalized = Math.round((value + Number.EPSILON) * 100) / 100;
  if (normalized <= 0) throw new Error('积分数量必须至少为0.01');
  return normalized;
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

  const updateResult = db.prepare('UPDATE users SET credits = ROUND(credits + ?, 2) WHERE id = ?')
    .run(amount, userId);
  if (updateResult.changes !== 1) throw new Error('用户不存在');

  db.prepare(`INSERT INTO credit_logs (user_id, amount, type, description, related_id)
              VALUES (?, ?, ?, ?, ?)`).run(userId, amount, type, description, relatedId);

  return db.prepare('SELECT credits FROM users WHERE id = ?').get(userId).credits;
});

// 给用户加积分
function addCredits(userId, amount, type, description, relatedId = 0) {
  return addCreditsTransaction.immediate(
    userId,
    normalizeAmount(amount),
    type,
    description,
    relatedId
  );
}

const deductCreditsTransaction = db.transaction((userId, amount, type, description, relatedId) => {
  const updateResult = db.prepare(`UPDATE users
    SET credits = ROUND(credits - ?, 2)
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
  let normalizedAmount;
  try {
    normalizedAmount = normalizeAmount(amount);
  } catch (err) {
    return { success: false, balance: getBalance(userId), msg: '计费参数无效' };
  }
  return deductCreditsTransaction(userId, normalizedAmount, type, description, relatedId);
}

function normalizeGenerationJob(job) {
  if (job === undefined || job === null) return null;
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error('生成任务参数无效');
  }

  const type = typeof job.type === 'string' ? job.type.trim() : '';
  if (!type || type.length > 100) throw new Error('生成任务类型无效');

  let payload;
  try {
    payload = JSON.stringify(job.payload);
  } catch (err) {
    throw new Error('生成任务 payload 无法序列化');
  }
  if (job.payload === undefined || payload === undefined) {
    throw new Error('生成任务 payload 无效');
  }

  const publicId = job.publicId === undefined || job.publicId === null
    ? crypto.randomUUID()
    : String(job.publicId).trim();
  if (!publicId || publicId.length > 200) throw new Error('生成任务 publicId 无效');

  const maxAttempts = job.maxAttempts === undefined ? 3 : Number(job.maxAttempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error('生成任务 maxAttempts 无效');
  }

  return { type, payload, publicId, maxAttempts };
}

const createGenerationAndDeductTransaction = db.transaction((
  userId,
  studioType,
  modelId,
  params,
  amount,
  description,
  job
) => {
  const updateResult = db.prepare(`UPDATE users
    SET credits = ROUND(credits - ?, 2)
    WHERE id = ? AND credits >= ?`).run(amount, userId, amount);

  if (updateResult.changes !== 1) {
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('用户不存在');
    return { success: false, balance: user.credits, msg: '积分不足' };
  }

  const generation = db.prepare(`INSERT INTO generations
    (user_id, studio_type, model_id, params, credits_used, status)
    VALUES (?, ?, ?, ?, ?, 'pending')`)
    .run(userId, studioType, modelId, params, amount);
  const generationId = generation.lastInsertRowid;

  db.prepare(`INSERT INTO credit_logs (user_id, amount, type, description, related_id)
              VALUES (?, ?, 'consume', ?, ?)`)
    .run(userId, -amount, description, generationId);

  if (job) {
    db.prepare(`INSERT INTO generation_jobs
      (generation_id, public_id, job_type, payload, max_attempts)
      VALUES (?, ?, ?, ?, ?)`)
      .run(generationId, job.publicId, job.type, job.payload, job.maxAttempts);
  }

  const balance = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId).credits;
  return {
    success: true,
    balance,
    taskId: generationId,
    publicTaskId: job ? job.publicId : undefined
  };
});

function createGenerationAndDeduct(userId, studioType, modelId, params, amount, description, job) {
  let normalizedAmount;
  let normalizedJob;
  try {
    normalizedAmount = normalizeAmount(amount);
    normalizedJob = normalizeGenerationJob(job);
  } catch (err) {
    if (job !== undefined && job !== null && err.message.startsWith('生成任务')) throw err;
    return { success: false, balance: getBalance(userId), msg: '计费参数无效' };
  }

  return createGenerationAndDeductTransaction.immediate(
    userId,
    studioType,
    modelId,
    params,
    normalizedAmount,
    description,
    normalizedJob
  );
}

const settleGenerationChargeTransaction = db.transaction((generationId, amount, result) => {
  const generation = db.prepare(`SELECT id, user_id, credits_used, status
    FROM generations WHERE id = ?`).get(generationId);
  if (!generation) throw new Error('生成任务不存在');
  if (generation.status !== 'pending' && generation.status !== 'processing') {
    throw new Error('生成任务状态不允许结算');
  }

  const reservedAmount = normalizeAmount(generation.credits_used);
  const delta = Math.round((amount - reservedAmount + Number.EPSILON) * 100) / 100;

  if (delta > 0) {
    const updateResult = db.prepare(`UPDATE users SET credits = ROUND(credits - ?, 2)
      WHERE id = ? AND credits >= ?`).run(delta, generation.user_id, delta);
    if (updateResult.changes !== 1) throw new Error('积分不足，无法完成实际用量结算');
  } else if (delta < 0) {
    const updateResult = db.prepare('UPDATE users SET credits = ROUND(credits + ?, 2) WHERE id = ?')
      .run(-delta, generation.user_id);
    if (updateResult.changes !== 1) throw new Error('用户不存在');
  }

  const logResult = db.prepare(`UPDATE credit_logs SET amount = ?
    WHERE user_id = ? AND type = 'consume' AND related_id = ?`)
    .run(-amount, generation.user_id, generationId);
  if (logResult.changes !== 1) throw new Error('消费流水不存在或不唯一');

  const generationResult = db.prepare(`UPDATE generations
    SET credits_used = ?, result = ?, status = 'success',
        completed_at = datetime('now','localtime')
    WHERE id = ? AND status IN ('pending', 'processing')`)
    .run(amount, result, generationId);
  if (generationResult.changes !== 1) throw new Error('生成任务结算冲突');

  const balance = db.prepare('SELECT credits FROM users WHERE id = ?')
    .get(generation.user_id).credits;
  return { balance, cost: amount };
});

function settleGenerationCharge(generationId, amount, result) {
  return settleGenerationChargeTransaction.immediate(
    generationId,
    normalizeAmount(amount),
    result
  );
}

function createWebhookDeliveries(generation, eventType, data) {
  const payload = JSON.stringify({
    event: eventType,
    timestamp: new Date().toISOString(),
    data
  });
  db.prepare(`INSERT OR IGNORE INTO webhook_deliveries
    (subscription_id, generation_id, event_type, payload)
    SELECT id, ?, ?, ?
    FROM webhook_subscriptions
    WHERE user_id = ? AND status = 1 AND event_type LIKE ?`)
    .run(generation.id, eventType, payload, generation.user_id, `%${eventType}%`);
}

const failGenerationAndRefundTransaction = db.transaction((generationId, errorMessage, leaseOwner) => {
  const generation = db.prepare(`
    SELECT id, user_id, studio_type, credits_used, status
    FROM generations
    WHERE id = ?
  `).get(generationId);
  if (!generation) throw new Error('生成任务不存在');
  if (generation.status === 'success') throw new Error('成功任务不能退款');

  let job = null;
  if (leaseOwner !== undefined && leaseOwner !== null) {
    job = db.prepare(`SELECT id, public_id FROM generation_jobs
      WHERE generation_id = ? AND status = 'processing' AND lease_owner = ?`)
      .get(generationId, leaseOwner);
    if (!job) throw new Error('生成任务租约已失效');

    const jobResult = db.prepare(`UPDATE generation_jobs
      SET status = 'failed', failure_count = failure_count + 1,
          last_error = ?, finished_at = datetime('now'),
          lease_owner = '', lease_expires_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'processing' AND lease_owner = ?`)
      .run(errorMessage || '生成失败', job.id, leaseOwner);
    if (jobResult.changes !== 1) throw new Error('生成任务失败状态更新冲突');
  }

  const rawCredits = Number(generation.credits_used);
  if (!Number.isFinite(rawCredits) || rawCredits < 0) {
    throw new Error(`任务 ${generationId} 的计费金额无效`);
  }
  const credits = Math.round((rawCredits + Number.EPSILON) * 100) / 100;

  const refunds = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM credit_logs
    WHERE user_id = ? AND type = 'refund' AND related_id = ?
  `).get(generation.user_id, generationId);

  if (refunds.count > 0) {
    const refundedTotal = Math.round((Number(refunds.total) + Number.EPSILON) * 100) / 100;
    if (refunds.count !== 1 || refundedTotal !== credits) {
      throw new Error(`任务 ${generationId} 的退款流水不匹配`);
    }
  } else if (credits > 0) {
    const updateResult = db.prepare('UPDATE users SET credits = ROUND(credits + ?, 2) WHERE id = ?')
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
    const generationResult = db.prepare(`UPDATE generations
      SET status = 'failed', error_msg = ?, completed_at = datetime('now','localtime')
      WHERE id = ? AND status IN ('pending', 'processing')`)
      .run(errorMessage || '生成失败', generationId);
    if (leaseOwner !== undefined && leaseOwner !== null && generationResult.changes !== 1) {
      throw new Error('生成任务失败状态更新冲突');
    }
  }

  if (job) {
    createWebhookDeliveries(generation, 'task.failed', {
      task_id: generation.id,
      public_task_id: job.public_id,
      studio_type: generation.studio_type,
      status: 'failed',
      error_msg: errorMessage || '生成失败'
    });
  }

  return db.prepare('SELECT credits FROM users WHERE id = ?').get(generation.user_id).credits;
});

function failGenerationAndRefund(generationId, errorMessage, leaseOwner) {
  return failGenerationAndRefundTransaction.immediate(generationId, errorMessage, leaseOwner);
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
  createGenerationAndDeduct,
  settleGenerationCharge,
  failGenerationAndRefund,
  getBalance,
  getCreditLogs,
};
