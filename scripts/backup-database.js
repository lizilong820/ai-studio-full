const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const sourcePath = path.resolve(process.env.AI_STUDIO_DB_PATH || path.join(__dirname, '..', 'database', 'ai_studio.db'));
const outputArg = process.argv.find(arg => arg.startsWith('--output='));
const outputPath = path.resolve(outputArg ? outputArg.slice('--output='.length) : `${sourcePath}.backup`);

if (sourcePath === outputPath) throw new Error('Backup output must differ from source database');
if (!fs.existsSync(sourcePath)) throw new Error(`Source database not found: ${sourcePath}`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
try { fs.rmSync(outputPath, { force: true }); } catch (error) {}

async function main() {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const sourceIntegrity = source.pragma('integrity_check', { simple: true });
    if (sourceIntegrity !== 'ok') throw new Error(`Source integrity check failed: ${sourceIntegrity}`);
    await source.backup(outputPath);
  } finally {
    source.close();
  }

  try {
    const backup = new Database(outputPath, { readonly: true, fileMustExist: true });
    const backupIntegrity = backup.pragma('integrity_check', { simple: true });
    backup.close();
    if (backupIntegrity !== 'ok') throw new Error(`Backup integrity check failed: ${backupIntegrity}`);
    process.stdout.write(JSON.stringify({ source: sourcePath, output: outputPath, integrity: 'ok' }) + '\n');
  } catch (error) {
    try { fs.rmSync(outputPath, { force: true }); } catch (cleanupError) {}
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
