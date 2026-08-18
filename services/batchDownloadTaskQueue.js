const crypto = require('crypto');
const { db } = require('../database/db');

const RETRY_BASE_SECONDS = 5;
const RETRY_MAX_SECONDS = 5 * 60;
const FILE_TTL_SECONDS = 30 * 60;

function requireOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('worker owner 无效');
  return owner.trim();
}

function createTask(userId, generationIds, maxAttempts = 3) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('userId 无效');
  if (!Array.isArray(generationIds) || generationIds.length < 1 || generationIds.length > 50) {
    throw new Error('generationIds 无效');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('maxAttempts 无效');
  }

  const publicId = `bdl_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(`INSERT INTO batch_download_tasks
    (public_id, user_id, generation_ids, total, max_attempts)
    VALUES (?, ?, ?, ?, ?)`)
    .run(publicId, userId, JSON.stringify(generationIds), generationIds.length, maxAttempts);
  return publicId;
}

function getTask(publicId, userId) {
  if (typeof publicId !== 'string' || !publicId.trim()) return null;
  if (!Number.isSafeInteger(userId) || userId < 1) return null;
  return db.prepare(`SELECT public_id, user_id, status, total, done_count, file_path,
      error_msg, expires_at, created_at, updated_at
    FROM batch_download_tasks
    WHERE public_id = ? AND user_id = ?`).get(publicId.trim(), userId) || null;
}

const claimNextTransaction = db.transaction((owner, leaseSeconds) => {
  const candidate = db.prepare(`SELECT public_id FROM batch_download_tasks
    WHERE (
      (status IN ('queued', 'retry') AND attempt_count < max_attempts
        AND datetime(next_run_at) <= datetime('now'))
      OR
      (status = 'processing' AND lease_expires_at IS NOT NULL
        AND datetime(lease_expires_at) <= datetime('now'))
    )
    ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END,
      datetime(next_run_at), datetime(created_at), public_id
    LIMIT 1`).get();
  if (!candidate) return null;

  const claimed = db.prepare(`UPDATE batch_download_tasks
    SET status = 'processing', attempt_count = attempt_count + 1,
        done_count = 0, error_msg = '', lease_owner = ?,
        lease_expires_at = datetime('now', '+' || ? || ' seconds'),
        updated_at = datetime('now')
    WHERE public_id = ? AND (
      (status IN ('queued', 'retry') AND attempt_count < max_attempts
        AND datetime(next_run_at) <= datetime('now'))
      OR
      (status = 'processing' AND lease_expires_at IS NOT NULL
        AND datetime(lease_expires_at) <= datetime('now'))
    )`).run(owner, leaseSeconds, candidate.public_id);
  if (claimed.changes !== 1) return null;

  return db.prepare('SELECT * FROM batch_download_tasks WHERE public_id = ?')
    .get(candidate.public_id);
});

function claimNext(owner, leaseSeconds = 60) {
  const normalizedOwner = requireOwner(owner);
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new Error('leaseSeconds 无效');
  }
  const task = claimNextTransaction.immediate(normalizedOwner, leaseSeconds);
  if (!task) return null;
  try {
    return { ...task, generationIds: JSON.parse(task.generation_ids) };
  } catch (error) {
    return { ...task, generationIds: null };
  }
}

function renewLease(task, owner, leaseSeconds) {
  const normalizedOwner = requireOwner(owner);
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new Error('leaseSeconds 无效');
  }
  const result = db.prepare(`UPDATE batch_download_tasks
    SET lease_expires_at = datetime('now', '+' || ? || ' seconds'),
        updated_at = datetime('now')
    WHERE public_id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(leaseSeconds, task.public_id, normalizedOwner);
  return result.changes === 1;
}

function updateProgress(task, owner, doneCount) {
  const normalizedOwner = requireOwner(owner);
  const normalizedDone = Number(doneCount);
  if (!Number.isSafeInteger(normalizedDone) || normalizedDone < 0 || normalizedDone > task.total) {
    throw new Error('doneCount 无效');
  }
  const result = db.prepare(`UPDATE batch_download_tasks
    SET done_count = ?, updated_at = datetime('now')
    WHERE public_id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(normalizedDone, task.public_id, normalizedOwner);
  if (result.changes !== 1) throw new Error('批量下载任务租约已失效');
}

function complete(task, owner, filePath) {
  const normalizedOwner = requireOwner(owner);
  if (typeof filePath !== 'string' || !filePath) throw new Error('filePath 无效');
  const result = db.prepare(`UPDATE batch_download_tasks
    SET status = 'done', done_count = total, file_path = ?, error_msg = '',
        lease_owner = '', lease_expires_at = NULL,
        expires_at = datetime('now', '+' || ? || ' seconds'),
        updated_at = datetime('now')
    WHERE public_id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(filePath, FILE_TTL_SECONDS, task.public_id, normalizedOwner);
  if (result.changes !== 1) throw new Error('批量下载任务租约已失效');
}

function release(task, owner, message = '') {
  const normalizedOwner = requireOwner(owner);
  const result = db.prepare(`UPDATE batch_download_tasks
    SET status = 'retry', attempt_count = MAX(0, attempt_count - 1),
        error_msg = ?, next_run_at = datetime('now'),
        lease_owner = '', lease_expires_at = NULL, updated_at = datetime('now')
    WHERE public_id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(String(message).slice(0, 2000), task.public_id, normalizedOwner);
  if (result.changes !== 1) throw new Error('批量下载任务租约已失效');
}

function failOrRetry(task, owner, error) {
  const normalizedOwner = requireOwner(owner);
  const message = (error && error.message ? error.message : '批量下载失败').slice(0, 2000);
  const isFinal = task.attempt_count >= task.max_attempts;
  const delaySeconds = Math.min(
    RETRY_MAX_SECONDS,
    RETRY_BASE_SECONDS * (2 ** Math.max(0, task.attempt_count - 1))
  );
  const result = db.prepare(`UPDATE batch_download_tasks
    SET status = ?, error_msg = ?,
        next_run_at = datetime('now', '+' || ? || ' seconds'),
        lease_owner = '', lease_expires_at = NULL,
        expires_at = CASE WHEN ? = 'failed'
          THEN datetime('now', '+' || ? || ' seconds') ELSE NULL END,
        updated_at = datetime('now')
    WHERE public_id = ? AND status = 'processing' AND lease_owner = ?`)
    .run(
      isFinal ? 'failed' : 'retry',
      message,
      delaySeconds,
      isFinal ? 'failed' : 'retry',
      FILE_TTL_SECONDS,
      task.public_id,
      normalizedOwner
    );
  if (result.changes !== 1) throw new Error('批量下载任务租约已失效');
  return { failed: isFinal, retryAtSeconds: isFinal ? null : delaySeconds };
}

function listExpired(limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 无效');
  return db.prepare(`SELECT public_id, file_path FROM batch_download_tasks
    WHERE status IN ('done', 'failed') AND expires_at IS NOT NULL
      AND datetime(expires_at) <= datetime('now')
    ORDER BY datetime(expires_at), public_id
    LIMIT ?`).all(limit);
}

function deleteExpired(publicId) {
  return db.prepare(`DELETE FROM batch_download_tasks
    WHERE public_id = ? AND status IN ('done', 'failed')
      AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`)
    .run(publicId).changes === 1;
}

module.exports = {
  createTask,
  getTask,
  claimNext,
  renewLease,
  updateProgress,
  complete,
  release,
  failOrRetry,
  listExpired,
  deleteExpired
};
