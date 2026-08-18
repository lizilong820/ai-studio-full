const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getAdapterOptions,
  normalizeAdapterResult,
  formatGenerationResult
} = require('../services/generationResult');

test('normalizeAdapterResult removes only provider raw payload', () => {
  assert.deepEqual(
    normalizeAdapterResult({ images: ['/a.png'], mock: true, raw: { secret: 'provider' } }),
    { images: ['/a.png'], mock: true }
  );
});

test('formatGenerationResult preserves supported result styles without raw', () => {
  const adapterResult = { video_url: '/video.mp4', raw: { request_id: 'provider' } };
  assert.deepEqual(
    formatGenerationResult('canonical', adapterResult, {}, { duration: 5 }),
    { video_url: '/video.mp4', duration: 5 }
  );
  assert.deepEqual(
    formatGenerationResult('legacy', adapterResult, { video: '/video.mp4' }),
    { video_url: '/video.mp4', video: '/video.mp4' }
  );
  assert.equal(formatGenerationResult('url', adapterResult), '/video.mp4');
  assert.equal(formatGenerationResult('url', { gif_url: '/animation.gif' }), '/animation.gif');
  assert.equal(formatGenerationResult('url', { audio_url: '/audio.mp3' }), '/audio.mp3');
  assert.deepEqual(formatGenerationResult('url', { images: ['/image.png'] }), ['/image.png']);
  assert.deepEqual(
    formatGenerationResult({ prompt: 'text' }, { text: 'description', raw: {} }, {}, { source: 'vlm' }),
    { source: 'vlm', prompt: 'description' }
  );
});

test('getAdapterOptions keeps provider options and removes orchestration fields', () => {
  assert.deepEqual(
    getAdapterOptions({
      model_id: 1,
      prompt: 'test',
      input: 'audio',
      input_text: 'audio text',
      deadline_seconds: 60,
      result_style: 'legacy',
      result_metadata: { source: 'web' },
      n: 4,
      size: '1024x1024'
    }),
    { n: 4, size: '1024x1024' }
  );
  assert.deepEqual(
    getAdapterOptions({
      model_id: 1,
      result_metadata: { source: 'web' },
      options: { n: 2, result_metadata: 'provider-owned' }
    }),
    { n: 2, result_metadata: 'provider-owned' }
  );
});
