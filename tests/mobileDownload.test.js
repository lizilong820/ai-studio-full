const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../public/profile.html'), 'utf8');
const start = html.indexOf('async function downloadZipFile(url)');
const end = html.indexOf('// 筛选器事件', start);
const source = html.slice(start, end);

function browser(fetch) {
  const elements = { dlDownloadBtn: {}, dlProgressText: {} };
  let clicks = 0;
  const timers = [];
  const urlApi = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
  const context = vm.createContext({
    window: { location: { origin: 'https://studio.example.org' }, URL: urlApi, _dlPollSequence: 1 },
    document: {
      getElementById: id => elements[id],
      createElement: () => ({ click() { clicks++; } }),
      body: { appendChild() {}, removeChild() {} }
    },
    localStorage: { getItem: () => 'test-token' },
    normalizeExternalUrl: url => new URL(url, 'https://studio.example.org').href,
    showToast() {}, fetch, URL, AbortController,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}
  });
  vm.runInContext(source, context);
  return { context, elements, clicks: () => clicks };
}

test('mobile download works without a ReadableStream and permits another download', async () => {
  const b = browser(async () => ({
    ok: true, body: null,
    headers: new Headers({ 'content-type': 'application/zip' }),
    blob: async () => new Blob(['zip'], { type: 'application/zip' })
  }));
  await b.context.downloadZipFile('/download');
  await b.context.downloadZipFile('/download');
  assert.equal(b.clicks(), 2);
  assert.equal(b.elements.dlDownloadBtn.disabled, false);
  assert.equal(b.context.window._downloading, false);
});

test('HTTP 200 application errors are not saved as ZIP files', async () => {
  const b = browser(async () => ({
    ok: true, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ code: 400, msg: '文件已过期' })
  }));
  await b.context.downloadZipFile('/download');
  assert.equal(b.clicks(), 0);
  assert.equal(b.elements.dlProgressText.textContent, '文件已过期');
  assert.equal(b.elements.dlDownloadBtn.disabled, false);
});

test('network errors restore the button and allow retry', async () => {
  const b = browser(async () => { throw new Error('network unavailable'); });
  await b.context.downloadZipFile('/download');
  assert.equal(b.clicks(), 0);
  assert.equal(b.context.window._downloading, false);
  assert.equal(b.elements.dlDownloadBtn.disabled, false);
});

test('a response from a closed task cannot start a download', async () => {
  const b = browser(async () => ({
    ok: true, headers: new Headers({ 'content-type': 'application/zip' }),
    blob: async () => {
      b.context.window._dlPollSequence++;
      return new Blob(['zip']);
    }
  }));
  await b.context.downloadZipFile('/download');
  assert.equal(b.clicks(), 0);
});
