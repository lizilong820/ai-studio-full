const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-studio-worker-'));
process.env.AI_STUDIO_DB_PATH = path.join(tempDir, 'test.db');
const { db } = require('../database/db');
const creditService = require('../controllers/creditService');
const aiAdapter = require('../controllers/aiAdapter');
const { createGenerationWorker } = require('../workers/generationWorker');

function fixture(job = {}) {
  const userId = db.prepare('INSERT INTO users (username, password_hash, credits) VALUES (?, ?, 100)')
    .run(`worker-${crypto.randomUUID()}`, 'test').lastInsertRowid;
  const { taskId } = creditService.createGenerationAndDeduct(userId, 'image', 1, '{}', 10, 'test', {
    type: 'image.generate',
    payload: { model_id: 1, prompt: 'test', deadline_seconds: 60 },
    ...job
  });
  return { userId, taskId };
}

async function assertTerminalFailure(t, fixtureData, message) {
  const { userId, taskId } = fixtureData;
  const provider = t.mock.method(aiAdapter, 'generateImage', async () => {
    throw new Error('Unexpected provider request');
  });
  const worker = createGenerationWorker({ concurrency: 1 });
  t.after(() => worker.stop());
  await worker.runOnce();
  const generation = db.prepare('SELECT status, error_msg FROM generations WHERE id = ?').get(taskId);
  assert.equal(generation.status, 'failed');
  assert.match(generation.error_msg, message);
  assert.equal(db.prepare('SELECT status FROM generation_jobs WHERE generation_id = ?').get(taskId).status, 'failed');
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(await worker.runOnce(), 0);
  creditService.failGenerationAndRefund(taskId, 'repeat failure');
  assert.equal(creditService.getBalance(userId), 100);
  assert.deepEqual(db.prepare("SELECT COUNT(*) count, SUM(amount) amount FROM credit_logs WHERE related_id = ? AND type = 'refund'")
    .get(taskId), { count: 1, amount: 10 });
}

test('expired reclaimed jobs terminate and refund exactly once without calling the provider', async t => {
  const data = fixture();
  db.prepare(`UPDATE generation_jobs SET status = 'processing', started_at = datetime('now', '-1 day'),
    lease_owner = 'old-worker', lease_expires_at = datetime('now', '-1 minute') WHERE generation_id = ?`)
    .run(data.taskId);
  await assertTerminalFailure(t, data, /deadline_seconds/);
});

test('unknown job types terminate instead of waiting for another lease', async t => {
  await assertTerminalFailure(t, fixture({ type: 'unknown' }), /不支持的生成任务类型/);
});

test('invalid JSON payloads terminate and refund', async t => {
  const data = fixture();
  db.prepare('UPDATE generation_jobs SET payload = ? WHERE generation_id = ?').run('{broken', data.taskId);
  await assertTerminalFailure(t, data, /payload/);
});

test('null payloads terminate and refund', async t => {
  await assertTerminalFailure(t, fixture({ payload: null }), /payload/);
});

test('valid jobs still complete without a refund', async t => {
  const { userId, taskId } = fixture();
  t.mock.method(aiAdapter, 'generateImage', async () => ({ images: ['/uploads/test.png'] }));
  const worker = createGenerationWorker({ concurrency: 1 });
  t.after(() => worker.stop());
  await worker.runOnce();
  assert.equal(db.prepare('SELECT status FROM generations WHERE id = ?').get(taskId).status, 'success');
  assert.equal(creditService.getBalance(userId), 90);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM credit_logs WHERE related_id = ? AND type = 'refund'")
    .get(taskId).count, 0);
});

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
