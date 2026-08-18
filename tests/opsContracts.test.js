const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('database path contract is shared by app and reconciliation', () => {
  assert.match(read('database/db.js'), /process\.env\.AI_STUDIO_DB_PATH/);
  assert.match(read('scripts/reconcile.js'), /process\.env\.AI_STUDIO_DB_PATH/);
  assert.doesNotMatch(read('scripts/reconcile.js'), /process\.env\.DB_PATH/);
});

test('backup script validates source and restored database integrity', () => {
  const source = read('scripts/backup-database.js');
  assert.match(source, /source\.pragma\('integrity_check'/);
  assert.match(source, /source\.backup\(outputPath\)/);
  assert.match(source, /backup\.pragma\('integrity_check'/);
  assert.match(source, /fs\.rmSync\(outputPath/);
});

test('reconcile apply mode requires a verified backup file', () => {
  const source = read('scripts/reconcile.js');
  assert.match(source, /--backup-confirmed/);
  assert.match(source, /--backup-file=/);
  assert.match(source, /integrity_check/);
  assert.match(source, /Backup file must differ from database/);
});

test('health and readiness probes expose request correlation and worker checks', () => {
  const source = read('app.js');
  assert.match(source, /app\.get\('\/healthz'/);
  assert.match(source, /app\.get\('\/readyz'/);
  assert.match(source, /X-Request-Id/);
  assert.match(source, /request_id/);
  assert.match(source, /quick_check/);
  assert.match(source, /isRunning\(\)/);
});

test('release preflight and rollback tools are plan-only', () => {
  const preflight = read('scripts/release-preflight.js');
  const rollback = read('scripts/rollback-plan.js');
  assert.match(preflight, /production_path_is_separate/);
  assert.match(preflight, /working_tree_clean/);
  assert.match(preflight, /production_database_not_targeted/);
  assert.doesNotMatch(preflight, /execFileSync\([^)]*['\"]push['\"]/);
  assert.doesNotMatch(preflight, /execFileSync\([^)]*['\"]deploy['\"]/);
  assert.match(rollback, /status: 'plan-only'/);
  assert.match(rollback, /forbidden_without_authorization/);
  assert.doesNotMatch(rollback, /execFileSync\([^)]*push/);
});

test('media processing uses argument arrays instead of shell interpolation', () => {
  const user = read('routes/user.js');
  const frames = read('utils/videoFrameExtract.js');
  assert.match(user, /execFile\(process\.env\.FFMPEG_PATH/);
  assert.doesNotMatch(user, /exec\(/);
  assert.match(frames, /execFile\(process\.env\.FFMPEG_PATH/);
  assert.match(frames, /execFile\(process\.env\.FFPROBE_PATH/);
  assert.doesNotMatch(frames, /const .*Cmd =|exec\(/);
});

test('stage10 adds tenant and operational query indexes', () => {
  const source = read('database/db.js');
  for (const indexName of [
    'idx_generations_user_id_id',
    'idx_generations_user_studio_id',
    'idx_generations_user_status_id',
    'idx_credit_logs_user_created_at',
    'idx_orders_user_id_id',
    'idx_api_usage_user_created_at'
  ]) {
    assert.match(source, new RegExp(indexName));
  }
});

test('storage report is read-only and reports configured directories', () => {
  const source = read('scripts/storage-report.js');
  assert.match(source, /AI_STUDIO_UPLOADS_DIR/);
  assert.match(source, /AI_STUDIO_TMP_DIR/);
  assert.match(source, /AI_STUDIO_BACKUP_DIR/);
  assert.doesNotMatch(source, /rmSync|unlinkSync|rmdirSync/);
});

test('workers stop submitting state after lease loss', () => {
  const generation = read('workers/generationWorker.js');
  const batch = read('workers/batchDownloadWorker.js');
  assert.match(generation, /if \(!queue\.renewLease\(job, owner, leaseSeconds\)\)/);
  assert.match(generation, /放弃提交状态/);
  assert.match(generation, /signal: controller\.signal/);
  assert.match(batch, /if \(!queue\.renewLease\(task, owner, leaseSeconds\)\)/);
  assert.match(batch, /放弃提交状态/);
  assert.match(batch, /queue\.updateProgress\(task, owner, processed\)/);
});
