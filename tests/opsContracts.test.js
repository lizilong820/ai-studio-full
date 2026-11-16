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

test('application source is UTF-8 and user-facing errors remain readable', () => {
  const source = read('app.js');
  assert.doesNotMatch(source, /\uFFFD/);
  assert.match(source, /\\u670d\\u52a1\\u5668\\u5185\\u90e8\\u9519\\u8bef/);
  assert.match(source, /\\u63a5\\u53e3\\u4e0d\\u5b58\\u5728/);
  assert.match(source, /corsOrigins\.includes\(origin\)/);
  assert.match(read('scripts/check-syntax.js'), /source\.includes\('\\uFFFD'\)/);
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

test('text API bills provider usage without byte-count false caps', () => {
  const source = read('routes/apiV1.js');
  assert.match(source, /const reservedCost = Math\.max\(/);
  assert.match(source, /Math\.ceil\(\(actualMaxTokens \/ 1000\) \* pricePer1k/);
  assert.match(source, /模型未返回有效 token 用量/);
  assert.ok(!source.includes('模型返回的 token 用量超过预授权上限'));
  assert.ok(!source.includes('promptTokenUpperBound'));
  assert.match(source, /settleGenerationCharge\(/);
  assert.match(source, /refundFailedGeneration\(taskId, err\.message\)/);
});

test('video generation enforces provider duration and validates image signatures', () => {
  const api = read('routes/api.js');
  const apiV1 = read('routes/apiV1.js');
  const adapter = read('controllers/aiAdapter.js');
  const safeHttp = read('utils/safeHttp.js');
  assert.match(api, /name: '时长', min: 1, max: 15, defaultValue: 5/);
  assert.match(apiV1, /name: 'duration', min: 1, max: 15, defaultValue: 5/);
  assert.match(api, /MiniMax H3 模型仅支持 1-15 秒时长/);
  assert.match(apiV1, /MiniMax H3 模型仅支持 1-15 秒时长/);
  assert.match(adapter, /Math\.min\(Math\.max\(duration, 1\), 15\)/);
  assert.doesNotMatch(api, /min: 5, max: 15/);
  assert.doesNotMatch(apiV1, /min: 5, max: 15/);
  assert.doesNotMatch(adapter, /Math\.max\(duration, 5\)/);
  assert.match(api, /isMinimaxLora && actualDuration < 5/);
  assert.match(apiV1, /isMinimaxLora && actualDuration < 5/);
  assert.match(adapter, /isLoraModel && validDuration < 5/);
  assert.match(adapter, /当前加速版仅支持 5-15 秒；1-4 秒请选择同模式标准版/);
  const videoPage = read('public/video-gen.html');
  assert.match(videoPage, /id="durationInput"[^>]*min="1"[^>]*max="15"/);
  assert.match(videoPage, /支持 1-15 秒整数/);
  assert.match(adapter, /buffer\[0\] === 0xff && buffer\[1\] === 0xd8/);
  assert.match(adapter, /图片内容不是有效的 JPEG、PNG 或 GIF/);
  assert.match(adapter, /function getVideoContentUrl\(data\)/);
  assert.match(adapter, /供应商未返回有效视频地址/);
  assert.match(safeHttp, /if \(lookupOptions && lookupOptions\.all\)/);
  assert.match(safeHttp, /目标地址解析失败/);
});

test('homepage studio cards are DB-backed and seeded exactly once', () => {
  const source = read('database/db.js');
  const api = read('routes/api.js');
  const adminRoutes = read('routes/admin.js');
  const service = read('controllers/studioCards.js');

  assert.match(source, /CREATE TABLE IF NOT EXISTS studio_cards/);
  assert.match(source, /idx_studio_cards_status_sort/);
  assert.match(source, /studio_cards_seeded_v1/);
  assert.match(source, /db\.transaction\(cards =>/);

  assert.match(api, /router\.get\('\/studio-cards'/);
  assert.match(api, /studioCardService\.getPublicStudioCards\(\)/);
  assert.match(api, /studioCardService\.searchStudioCards\(keyword\)/);
  assert.doesNotMatch(api, /type: 'workflow', name: '电商工作流'/);

  assert.match(adminRoutes, /router\.get\('\/studio-cards'/);
  assert.match(adminRoutes, /router\.post\('\/studio-cards'/);
  assert.match(adminRoutes, /router\.put\('\/studio-cards\/:id'/);
  assert.match(adminRoutes, /router\.post\('\/studio-cards\/:id\/status'/);
  assert.match(adminRoutes, /router\.delete\('\/studio-cards\/:id'/);

  assert.match(service, /WHERE status = 1 ORDER BY sort_order ASC, id ASC/);
  assert.match(service, /href: card\.href/);
  assert.match(service, /JSON\.stringify\(data\.tags\)/);
});

test('deployment never overwrites runtime uploads', () => {
  const deploy = read('scripts/deploy.sh');
  assert.match(deploy, /--exclude ['"]public\/uploads['"]/);
  assert.match(deploy, /--exclude ['"]public\/audio['"]/);
  assert.match(deploy, /\[ ! -L "\$REMOTE_ROOT\/public\/uploads" \]/);
  assert.match(read('.gitignore'), /public\/uploads\//);
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
