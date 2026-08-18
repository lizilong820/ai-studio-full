const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const excluded = new Set(['node_modules', '.git', 'database', 'uploads', 'tmp']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile() && fullPath.endsWith('.js')) files.push(fullPath);
  }
}

walk(root);
let failed = false;
for (const file of files.sort()) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('\uFFFD')) {
    failed = true;
    process.stderr.write(`UTF-8 encoding check failed: ${file} contains replacement characters\n`);
  }
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
  }
}

if (failed) process.exitCode = 1;
else console.log(`Syntax check passed: ${files.length} JavaScript files`);
