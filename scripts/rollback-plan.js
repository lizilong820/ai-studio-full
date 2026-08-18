const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const productionDir = path.resolve(process.env.AI_STUDIO_PRODUCTION_DIR || '/var/www/ai-studio-full');
const databasePath = path.resolve(process.env.AI_STUDIO_DB_PATH || path.join(productionDir, 'database', 'ai_studio.db'));

function git(args, cwd = projectDir) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

const currentCommit = git(['rev-parse', 'HEAD']);
const productionCommit = fs.existsSync(path.join(productionDir, '.git'))
  ? git(['rev-parse', 'HEAD'], productionDir)
  : null;
const backupPath = `${databasePath}.rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;

const plan = {
  generated_at: new Date().toISOString(),
  status: 'plan-only',
  project_dir: projectDir,
  production_dir: productionDir,
  candidate_commit: currentCommit,
  production_commit: productionCommit,
  database_path: databasePath,
  database_backup_path: backupPath,
  steps: [
    '停止接收新流量，并确认 /healthz 与 /readyz 状态。',
    '保留当前生产 commit、配置文件和数据库备份，不覆盖原始备份。',
    '使用发布记录中的上一稳定 commit 恢复代码，再执行 npm ci 与 npm run check。',
    '使用 SQLite backup 工具创建并校验数据库备份；仅在人工批准后恢复数据库。',
    '启动服务并验证 /healthz、/readyz、登录、生成查询和回调链路。',
    '观察错误率、任务队列、积分流水和磁盘容量后再恢复流量。'
  ],
  forbidden_without_authorization: [
    'git push',
    'merge into main',
    'production deployment',
    'production database mutation',
    'stale pending reconciliation',
    'credit refunds'
  ]
};

process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
