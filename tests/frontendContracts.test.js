const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const publicDir = path.join(__dirname, '..', 'public');
const avatar = fs.readFileSync(path.join(publicDir, 'avatar.html'), 'utf8');
const ppt = fs.readFileSync(path.join(publicDir, 'ppt.html'), 'utf8');
const common = fs.readFileSync(path.join(publicDir, 'js', 'common.js'), 'utf8');

function parseInlineScripts(fileName, html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(Boolean);
  scripts.forEach((code, index) => new vm.Script(code, { filename: `${fileName}#script${index}` }));
}

test('avatar uses the backend hairstyle contract and shared polling', () => {
  assert.match(avatar, /hairstyle:\s*document\.getElementById\('hairStyle'\)/);
  assert.doesNotMatch(avatar, /\bhair_style:\s*document/);
  assert.match(avatar, /params\.hairstyle \?\? params\.hair_style/);
  assert.match(avatar, /pollGeneration\(taskId/);
  assert.doesNotMatch(avatar, /setInterval\s*\(/);
});

test('ppt uses backend field names and accepts legacy templates', () => {
  assert.match(ppt, /key_points:\s*corePoints/);
  assert.match(ppt, /slide_count:/);
  assert.match(ppt, /color_scheme:/);
  assert.doesNotMatch(ppt, /\bcore_points:\s*corePoints/);
  assert.match(ppt, /params\.key_points \?\? params\.core_points/);
  assert.match(ppt, /params\.slide_count \?\? params\.page_count/);
});

test('shared generation polling avoids overlapping requests', () => {
  assert.match(common, /timer = setTimeout\(poll, 3000\)/);
  assert.doesNotMatch(common, /const pollInterval = setInterval/);
  assert.match(common, /statusData\.code !== 0/);
  assert.match(common, /catch \(error\)/);
});

test('changed page inline scripts parse', () => {
  parseInlineScripts('avatar.html', avatar);
  parseInlineScripts('ppt.html', ppt);
});
