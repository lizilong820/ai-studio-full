const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const productionDir = path.resolve(process.env.AI_STUDIO_PRODUCTION_DIR || '/var/www/ai-studio-full');
const expectedBranch = process.env.AI_STUDIO_EXPECTED_BRANCH || 'hardening/phases-2-12';
const checks = [];

function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
}

function git(args) {
  return execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' }).trim();
}

try {
  check('git_worktree', git(['rev-parse', '--is-inside-work-tree']) === 'true', projectDir);
  check('branch', git(['branch', '--show-current']) === expectedBranch, git(['branch', '--show-current']));
  check('working_tree_clean', git(['status', '--porcelain']) === '', git(['status', '--short']) || 'clean');
  check('production_path_is_separate', projectDir !== productionDir, `${projectDir} != ${productionDir}`);
  check('package_lock_present', fs.existsSync(path.join(projectDir, 'package-lock.json')), 'package-lock.json');
  check('ci_workflow_present', fs.existsSync(path.join(projectDir, '.github', 'workflows', 'ci.yml')), '.github/workflows/ci.yml');
  check('backup_script_present', fs.existsSync(path.join(projectDir, 'scripts', 'backup-database.js')), 'scripts/backup-database.js');
  check('health_probe_present', fs.readFileSync(path.join(projectDir, 'app.js'), 'utf8').includes("app.get('/healthz'"), 'app.js');
  check('readiness_probe_present', fs.readFileSync(path.join(projectDir, 'app.js'), 'utf8').includes("app.get('/readyz'"), 'app.js');
  check('production_database_not_targeted', !process.env.AI_STUDIO_DB_PATH || path.resolve(process.env.AI_STUDIO_DB_PATH) !== path.join(productionDir, 'database', 'ai_studio.db'), process.env.AI_STUDIO_DB_PATH || 'not configured');
} catch (error) {
  check('preflight_execution', false, error.message);
}

const passed = checks.every(item => item.passed);
process.stdout.write(JSON.stringify({
  generated_at: new Date().toISOString(),
  project_dir: projectDir,
  production_dir: productionDir,
  expected_branch: expectedBranch,
  passed,
  checks
}, null, 2) + '\n');
process.exitCode = passed ? 0 : 1;
