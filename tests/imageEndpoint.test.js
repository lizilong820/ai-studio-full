const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `ai-studio-image-endpoint-${process.pid}.db`);
process.env.AI_STUDIO_DB_PATH = dbPath;

const { resolveImageGenerationEndpoint } = require('../controllers/aiAdapter');

test('resolveImageGenerationEndpoint normalizes common OpenAI image endpoints', () => {
  const expected = 'https://api.example.com/v1/images/generations';
  for (const endpoint of [
    'https://api.example.com/v1',
    'https://api.example.com/v1/',
    'https://api.example.com/v1/images',
    expected,
  ]) {
    assert.equal(resolveImageGenerationEndpoint(endpoint), expected);
  }
});

test('resolveImageGenerationEndpoint rejects an empty endpoint', () => {
  assert.throws(
    () => resolveImageGenerationEndpoint('   '),
    /生图 API 地址不能为空/
  );
});

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});
