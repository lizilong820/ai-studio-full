const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const uploadsDir = path.resolve(process.env.AI_STUDIO_UPLOADS_DIR || path.join(projectDir, 'public', 'uploads'));
const tmpDir = path.resolve(process.env.AI_STUDIO_TMP_DIR || path.join(projectDir, 'tmp'));
const backupDir = process.env.AI_STUDIO_BACKUP_DIR
  ? path.resolve(process.env.AI_STUDIO_BACKUP_DIR)
  : null;

function summarize(dir) {
  const summary = { path: dir, exists: fs.existsSync(dir), files: 0, bytes: 0 };
  if (!summary.exists) return summary;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile()) {
        summary.files += 1;
        summary.bytes += fs.statSync(entryPath).size;
      }
    }
  }
  return summary;
}

const reports = [summarize(uploadsDir), summarize(tmpDir)];
if (backupDir) reports.push(summarize(backupDir));
process.stdout.write(JSON.stringify({ generated_at: new Date().toISOString(), directories: reports }) + '\n');
