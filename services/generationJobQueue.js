const { db } = require('../database/db');
const creditService = require('../controllers/creditService');

const RETRY_BASE_SECONDS = 5;
const RETRY_MAX_SECONDS = 15 * 60;

function requireOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('worker owner 无效');
  return owner.trim();
}

function parsePayload(job) {
  try {
    return { ...job, payload: JSON.parse(job.payload) };
  } catch (err) {
    // Preserve the claimed job so the worker can fail it and refund once.
    return { ...job, payload: null };
  }
}

function normalizeDelaySeconds(value, fallback = 0) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return fallback;
  return Math.min(Math.ceil(seconds), 24 * 60 * 60);
}

function normalizeProgress(value, fallback) {
  if (value === undefined) return fallback;
  const progress = Number(value);
  if (!Number.isFinite(progress)) return fallback;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

const claimNextTransaction = db.transaction((owner, leaseSeconds) => {
  const candidate = db.prepare(`SELECT generation_jobs.id FROM generation_jobs
    JOIN generations ON generations.id = generation_jobs.generation_id
    WHERE generations.status IN ('pending', 'processing') AND (
      (generation_jobs.status IN ('queued', 'retry')
        AND datetime(generation_jobs.next_run_at) <= datetime('now'))
      OR
      (generation_jobs.status = 'processing'
        AND generation_jobs.lease_expires_at IS NOT NULL
        AND datetime(generation_jobs.lease_expires_at) <= datetime('now'))
    )
    ORDER BY CASE generation_jobs.status WHEN 'processing' THEN 0 ELSE 1 END,
      datetime(generation_jobs.next_run_at), generation_jobs.id
    LIMIT 1`).get();
  if (!candidate) return null;

  const claimed = db.prepare(`UPDATE generation_jobs
    SET failure_count = failure_count + CASE WHEN status = 'processing' THEN 1 ELSE 0 END,
        status = 'processing', lease_owner = ?,
        lease_expires_at = datetime('now', '+' || ? || ' seconds'),
        run_count = run_count + 1,
        started_at = COALESCE(started_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ? AND generation_id IN (
      SELECT id FROM generations WHERE status IN ('pending', 'processing')
    ) AND (
      (status IN ('queued', 'retry') AND datetime(next_run_at) <= datetime('now'))
      OR
      (status = 'processing' AND lease_expires_at IS NOT NULL
        AND datetime(lease_expires_at) <= datetime('now'))
    )`).run(owner, leaseSeconds, candidate.id);
  if (claimed.changes !== 1) return null;

  const job = db.prepare(`SELECT generation_jobs.*, generations.user_id,
      generations.studio_type, generations.model_id, generations.status AS generation_status
    FROM generation_jobs
    JOIN generations ON generations.id = generation_jobs.generation_id
    WHERE generation_jobs.id = ?`).get(candidate.id);

  if (job.generation_status === 'pending') {
    db.prepare(`UPDATE generations SET status = 'processing'
      WHERE id = ? AND status = 'pending'`).run(job.generation_id);
  }

  return job;
});

function claimNext(owner, leaseSeconds = 60) {
  const normalizedOwner = requireOwner(owner);
  const normalizedLease = Number(leaseSeconds);
  if (!Number.isSafeInteger(normalizedLease) || normalizedLease < 1 || normalizedLease > 3600) {
    throw new Error('leaseSeconds 无效');
  }
  const job = claimNextTransaction.immediate(normalizedOwner, normalizedLease);
  return job ? parsePayload(job) : null;
}

function reschedule(job, owner, updates = {}) {
  const normalizedOwner = requireOwner(owner);
  const delaySeconds = normalizeDelaySeconds(updates.delaySeconds, 0);
  const nextRunAt = typeof updates.nextRunAt === 'string' && updates.nextRunAt.trim()
    ? updates.nextRunAt.trim()
    : null;
  const payload = updates.payload === undefined ? null : JSON.stringify(updates.payload);
  if (updates.payload !== undefined && payload === undefined) throw new Error('任务 payload 无效');

  const result = db.prepare(`UPDATE generation_jobs SET
      status = 'retry',
      phase = COALESCE(?, phase),
      provider_task_id = COALESCE(?, provider_task_id),
      progress = ?,
      payload = COALESCE(?, payload),
      next_run_at = CASE WHEN ? IS NOT NULL THEN ?
        ELSE datetime('now', '+' || ? || ' seconds') END,
      last_error = COALESCE(?, last_error),
      lease_owner = '', lease_expires_at = NULL,
      updated_at = datetime('now')
    WHERE id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(
      updates.phase === undefined ? null : String(updates.phase),
      updates.providerTaskId === undefined ? null : String(updates.providerTaskId),
      normalizeProgress(updates.progress, job.progress || 0),
      payload,
      nextRunAt,
      nextRunAt,
      delaySeconds,
      updates.lastError === undefined ? null : String(updates.lastError),
      job.id,
      normalizedOwner
    );
  if (result.changes !== 1) throw new Error('生成任务租约已失效');
  return true;
}

const completeTransaction = db.transaction((job, owner, resultJson) => {
  const current = db.prepare(`SELECT generation_jobs.status AS job_status,
      generation_jobs.lease_owner, generations.status AS generation_status,
      generations.user_id, generations.studio_type
    FROM generation_jobs
    JOIN generations ON generations.id = generation_jobs.generation_id
    WHERE generation_jobs.id = ?`).get(job.id);
  if (!current) throw new Error('生成任务不存在');
  if (current.job_status !== 'processing' || current.lease_owner !== owner) {
    throw new Error('生成任务租约已失效');
  }
  if (!['pending', 'processing'].includes(current.generation_status)) {
    throw new Error('生成任务已进入终态');
  }

  const generationResult = db.prepare(`UPDATE generations
    SET result = ?, status = 'success', error_msg = '',
        completed_at = datetime('now','localtime')
    WHERE id = ? AND status IN ('pending', 'processing')`)
    .run(resultJson, job.generation_id);
  if (generationResult.changes !== 1) throw new Error('生成任务完成状态更新冲突');

  const jobResult = db.prepare(`UPDATE generation_jobs
    SET status = 'succeeded', phase = 'completed', progress = 100,
        lease_owner = '', lease_expires_at = NULL, last_error = '',
        finished_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(job.id, owner);
  if (jobResult.changes !== 1) throw new Error('生成队列完成状态更新冲突');

  const payload = JSON.stringify({
    event: 'task.completed',
    timestamp: new Date().toISOString(),
    data: {
      task_id: job.generation_id,
      public_task_id: job.public_id,
      studio_type: current.studio_type,
      status: 'success',
      result: JSON.parse(resultJson)
    }
  });
  db.prepare(`INSERT OR IGNORE INTO webhook_deliveries
    (subscription_id, generation_id, event_type, payload)
    SELECT id, ?, 'task.completed', ?
    FROM webhook_subscriptions
    WHERE user_id = ? AND status = 1 AND event_type LIKE '%task.completed%'`)
    .run(job.generation_id, payload, current.user_id);

  return true;
});

function complete(job, owner, result) {
  const normalizedOwner = requireOwner(owner);
  const resultJson = JSON.stringify(result);
  if (resultJson === undefined) throw new Error('生成结果无效');
  return completeTransaction.immediate(job, normalizedOwner, resultJson);
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '生成失败';
}

function renewLease(job, owner, leaseSeconds) {
  const normalizedOwner = requireOwner(owner);
  const normalizedLease = Number(leaseSeconds);
  if (!Number.isSafeInteger(normalizedLease) || normalizedLease < 1 || normalizedLease > 3600) {
    throw new Error('leaseSeconds 无效');
  }
  const result = db.prepare(`UPDATE generation_jobs
    SET lease_expires_at = datetime('now', '+' || ? || ' seconds'),
        updated_at = datetime('now')
    WHERE id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(normalizedLease, job.id, normalizedOwner);
  return result.changes === 1;
}

function failOrRetry(job, owner, error) {
  const normalizedOwner = requireOwner(owner);
  const message = getErrorMessage(error).slice(0, 2000);
  const permanent = Boolean(error && error.permanent);
  const nextFailureCount = Number(job.failure_count || 0) + 1;
  const maxAttempts = Number(job.max_attempts || 1);

  if (permanent || nextFailureCount >= maxAttempts) {
    return {
      failed: true,
      balance: creditService.failGenerationAndRefund(
        job.generation_id,
        message,
        normalizedOwner
      )
    };
  }

  const delaySeconds = Math.min(
    RETRY_MAX_SECONDS,
    RETRY_BASE_SECONDS * (2 ** Math.max(0, nextFailureCount - 1))
  );
  const result = db.prepare(`UPDATE generation_jobs
    SET status = 'retry', failure_count = failure_count + 1,
        last_error = ?, next_run_at = datetime('now', '+' || ? || ' seconds'),
        lease_owner = '', lease_expires_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(message, delaySeconds, job.id, normalizedOwner);
  if (result.changes !== 1) throw new Error('生成任务租约已失效');
  return { failed: false, retryAtSeconds: delaySeconds };
}

module.exports = { claimNext, reschedule, complete, renewLease, failOrRetry };
