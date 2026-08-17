const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = path.resolve(__dirname, '..', 'tests');
const files = fs.readdirSync(testDir)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join(testDir, name));

if (files.length === 0) {
  console.error('未找到测试文件');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit'
});
process.exitCode = result.status === null ? 1 : result.status;
