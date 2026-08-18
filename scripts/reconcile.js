const path = require('path');
const Database = require('better-sqlite3');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply-stale-pending');
const backupConfirmed = args.has('--backup-confirmed');
const backupArg = process.argv.find(arg => arg.startsWith('--backup-file='));
const ageArg = process.argv.find(arg => arg.startsWith('--stale-hours='));
const staleHours = ageArg ? Number(ageArg.split('=')[1]) : 24;
const dbPath = process.env.AI_STUDIO_DB_PATH || path.join(__dirname, '..', 'database', 'ai_studio.db');

if (!Number.isInteger(staleHours) || staleHours < 1 || staleHours > 720) {
  throw new Error('--stale-hours must be an integer between 1 and 720');
}
if (apply && (!backupConfirmed || !backupArg)) {
  throw new Error('Apply mode requires --backup-confirmed and --backup-file=PATH');
}

if (apply) {
  const backupPath = path.resolve(backupArg.split('=').slice(1).join('='));
  if (backupPath === path.resolve(dbPath)) throw new Error('Backup file must differ from database');
  const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  const integrity = backupDb.pragma('integrity_check', { simple: true });
  backupDb.close();
  if (integrity !== 'ok') throw new Error('Backup integrity check failed');
}

const db = new Database(dbPath, {
  readonly: !apply,
  fileMustExist: true
});
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');

function report() {
  const orderMismatches = db.prepare(`
    SELECT o.id, o.user_id, o.status, o.credits,
           COUNT(c.id) AS matching_logs,
           COALESCE(SUM(c.amount), 0) AS linked_total
    FROM orders o
    LEFT JOIN credit_logs c
      ON c.user_id = o.user_id
     AND c.related_id = o.id
     AND c.type = 'recharge'
    WHERE o.status IN ('paid', 'manual')
    GROUP BY o.id
    HAVING matching_logs <> 1 OR linked_total <> o.credits
    ORDER BY o.id
  `).all();

  const duplicateRefunds = db.prepare(`
    SELECT user_id, related_id, COUNT(*) AS count, SUM(amount) AS total
    FROM credit_logs
    WHERE type = 'refund' AND related_id > 0
    GROUP BY user_id, related_id
    HAVING COUNT(*) > 1
  `).all();

  const failedRefundMismatches = db.prepare(`
    SELECT g.id, g.user_id, g.credits_used,
           COUNT(c.id) AS refund_count,
           COALESCE(SUM(c.amount), 0) AS refund_total
    FROM generations g
    LEFT JOIN credit_logs c
      ON c.user_id = g.user_id
     AND c.related_id = g.id
     AND c.type = 'refund'
    WHERE g.status = 'failed' AND g.credits_used > 0
    GROUP BY g.id
    HAVING refund_total <> g.credits_used
    ORDER BY g.id
  `).all();

  const stalePending = db.prepare(`
    SELECT g.id, g.user_id, g.studio_type, g.credits_used, g.created_at,
           COUNT(c.id) AS refund_count,
           COALESCE(SUM(c.amount), 0) AS refund_total
    FROM generations g
    LEFT JOIN credit_logs c
      ON c.user_id = g.user_id
     AND c.related_id = g.id
     AND c.type = 'refund'
    WHERE g.status = 'pending'
      AND g.created_at < datetime('now', 'localtime', ?)
    GROUP BY g.id
    ORDER BY g.id
  `).all(`-${staleHours} hours`);

  const balances = db.prepare(`
    SELECT u.id, u.credits, COALESCE(SUM(c.amount), 0) AS log_total,
           u.credits - COALESCE(SUM(c.amount), 0) AS unexplained_opening_balance
    FROM users u
    LEFT JOIN credit_logs c ON c.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id
  `).all();

  return {
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    stale_hours: staleHours,
    order_mismatches: orderMismatches,
    duplicate_refunds: duplicateRefunds,
    failed_refund_mismatches: failedRefundMismatches,
    stale_pending: stalePending,
    balance_observations: balances
  };
}

const reconcileTask = db.transaction(taskId => {
  const task = db.prepare(`
    SELECT id, user_id, credits_used
    FROM generations
    WHERE id = ? AND status = 'pending'
      AND created_at < datetime('now', 'localtime', ?)
  `).get(taskId, `-${staleHours} hours`);
  if (!task) return false;

  const existing = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM credit_logs
    WHERE user_id = ? AND type = 'refund' AND related_id = ?
  `).get(task.user_id, task.id);

  const credits = Number(task.credits_used);
  if (!Number.isFinite(credits) || credits < 0) {
    throw new Error(`Invalid credits_used for task ${task.id}`);
  }

  if (existing.count > 0) {
    if (existing.count !== 1 || Number(existing.total) !== credits) {
      throw new Error(`Refund mismatch for task ${task.id}`);
    }
    db.prepare(`
      UPDATE generations
      SET status = 'failed', error_msg = ?, completed_at = datetime('now', 'localtime')
      WHERE id = ? AND status = 'pending'
    `).run('任务超时，历史退款已存在', task.id);
    return true;
  }

  if (credits > 0) {
    const updated = db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?')
      .run(credits, task.user_id);
    if (updated.changes !== 1) throw new Error(`User missing for task ${task.id}`);
    db.prepare(`
      INSERT INTO credit_logs (user_id, amount, type, description, related_id)
      VALUES (?, ?, 'refund', ?, ?)
    `).run(task.user_id, credits, `历史超时任务退款 - 任务${task.id}`, task.id);
  }

  const finished = db.prepare(`
    UPDATE generations
    SET status = 'failed', error_msg = ?, completed_at = datetime('now', 'localtime')
    WHERE id = ? AND status = 'pending'
  `).run('任务超时，系统已自动退款', task.id);
  if (finished.changes !== 1) throw new Error(`Task state changed for ${task.id}`);
  return true;
});

try {
  const before = report();
  let applied = 0;
  if (apply) {
    for (const task of before.stale_pending) {
      if (reconcileTask.immediate(task.id)) applied += 1;
    }
  }
  const output = apply ? { before, applied, after: report() } : before;
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally {
  db.close();
}
