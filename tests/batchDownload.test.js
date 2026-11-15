const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-studio-batch-'));
process.env.AI_STUDIO_DB_PATH = path.join(tempDir, 'test.db');
const { db } = require('../database/db');
const queue = require('../services/batchDownloadTaskQueue');
const safeHttp = require('../utils/safeHttp');
const { createBatchDownloadWorker } = require('../workers/batchDownloadWorker');
const userId = db.prepare("INSERT INTO users (username, password_hash) VALUES ('batch-test', 'test')").run().lastInsertRowid;
const uploads = path.resolve(__dirname, '../public/uploads');
fs.mkdirSync(uploads, { recursive: true });
const localName = `batch-test-${process.pid}.png`;
fs.writeFileSync(path.join(uploads, localName), 'local-image');
const archives = [];

function generation(result) {
  return db.prepare("INSERT INTO generations (user_id,studio_type,status,result) VALUES (?, 'image', 'success', ?)")
    .run(userId, JSON.stringify(result)).lastInsertRowid;
}

async function archive(ids) {
  const taskId = queue.createTask(userId, ids, 1);
  const worker = createBatchDownloadWorker();
  await worker.runOnce();
  const task = queue.getTask(taskId, userId);
  if (task.file_path) archives.push(task.file_path);
  return task;
}

test('ZIP contains distinct local works, remote video, base64 audio and every text version', async t => {
  const request = t.mock.method(safeHttp, 'safeRequest', async (url, options) => {
    assert.equal(url, 'https://media.example.org/result');
    assert.ok(options.signal);
    return { status: 200, headers: { 'content-type': 'video/mp4' }, body: Buffer.from('remote-video') };
  });
  const ids = [
    generation({ title: 'same', images: [`/uploads/${localName}?v=1`] }),
    generation({ title: 'same', images: [`/uploads/${localName}`] }),
    generation({ video: 'https://media.example.org/result', video_url: 'https://media.example.org/result' }),
    generation({ audio_url: 'data:audio/mpeg;base64,YXVkaW8=' }),
    generation({ versions: [{ title: 'first', content: 'first copy', tags: ['tag'] }, { title: 'second', content: 'second copy' }] }),
    generation({ outline: 'PPT outline' })
  ];
  const task = await archive(ids);
  assert.equal(task.status, 'done', task.error_msg);
  assert.equal(task.done_count, ids.length);
  assert.equal(request.mock.callCount(), 1);
  const names = execFileSync('unzip', ['-Z1', task.file_path], { encoding: 'utf8' }).trim().split('\n')
    .filter(name => !name.endsWith('/'));
  assert.equal(names.length, 7);
  assert.equal(names.filter(name => name.endsWith('.png')).length, 2);
  assert.equal(names.filter(name => name.endsWith('.mp4')).length, 1);
  assert.equal(names.filter(name => name.endsWith('.mp3')).length, 1);
  const text = execFileSync('unzip', ['-p', task.file_path], { encoding: 'utf8' });
  for (const content of ['local-image', 'remote-video', 'audio', 'first copy', 'second copy', 'PPT outline']) {
    assert.ok(text.includes(content), content);
  }
});

test('empty work fails instead of publishing an empty ZIP', async () => {
  const task = await archive([generation({})]);
  assert.equal(task.status, 'failed');
  assert.match(task.error_msg, /没有可导出的内容/);
  assert.equal(task.file_path, '');
});

test('missing file fails instead of publishing a partial ZIP', async () => {
  const task = await archive([generation({ images: [`/uploads/${localName}`, '/uploads/missing-batch-file.png'] })]);
  assert.equal(task.status, 'failed');
  assert.match(task.error_msg, /原文件不存在/);
});

test('expired remote media returns a useful failure', async t => {
  t.mock.method(safeHttp, 'safeRequest', async () => ({ status: 403, headers: {}, body: Buffer.alloc(0) }));
  const task = await archive([generation({ video_url: 'https://media.example.org/expired' })]);
  assert.equal(task.status, 'failed');
  assert.match(task.error_msg, /HTTP 403/);
});

test.after(() => {
  db.close();
  for (const file of archives) fs.rmSync(file, { force: true });
  fs.rmSync(path.join(uploads, localName), { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});
