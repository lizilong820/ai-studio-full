const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const publicDir = path.join(__dirname, '..', 'public');
const avatar = fs.readFileSync(path.join(publicDir, 'avatar.html'), 'utf8');
const ppt = fs.readFileSync(path.join(publicDir, 'ppt.html'), 'utf8');
const video = fs.readFileSync(path.join(publicDir, 'video.html'), 'utf8');
const resume = fs.readFileSync(path.join(publicDir, 'resume.html'), 'utf8');
const audio = fs.readFileSync(path.join(publicDir, 'audio.html'), 'utf8');
const faceSwap = fs.readFileSync(path.join(publicDir, 'video-face-swap.html'), 'utf8');
const idphoto = fs.readFileSync(path.join(publicDir, 'idphoto.html'), 'utf8');
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

test('saved template names are rendered as text', () => {
  assert.match(common, /function renderTemplateList\(/);
  assert.match(common, /name\.textContent = String\(template\.name/);
  for (const [fileName, html] of [['avatar.html', avatar], ['ppt.html', ppt], ['video.html', video], ['resume.html', resume]]) {
    assert.match(html, /renderTemplateList\(tplList, templates/);
    assert.doesNotMatch(html, /tplList\.innerHTML = templates\.map/);
    assert.doesNotMatch(html, /\$\{t\.name\}/);
    parseInlineScripts(fileName, html);
  }
});

test('dynamic media results use normalized URLs and DOM APIs', () => {
  assert.match(audio, /currentPollController = pollGeneration\(taskId/);
  assert.doesNotMatch(audio, /currentPollInterval|setInterval\s*\(/);
  assert.match(audio, /const audioUrl = normalizeMediaUrl\(result\.audio_url\)/);
  assert.match(audio, /name\.textContent = '🎵 ' \+ fileName/);
  assert.doesNotMatch(audio, /src="\$\{audioUrl\}"|\$\{errorMsg/);

  assert.match(faceSwap, /const videoUrl = normalizeMediaUrl\(/);
  assert.match(faceSwap, /pollTimer = setTimeout\(poll, 3000\)/);
  assert.match(faceSwap, /sequence === pollSequence/);
  assert.doesNotMatch(faceSwap, /pollTimer = setInterval/);
  assert.match(faceSwap, /querySelector\('\.error-message'\)\.textContent/);
  assert.doesNotMatch(faceSwap, /src="\$\{videoUrl\}"|\$\{msg \|\|/);

  assert.match(idphoto, /\.map\(normalizeMediaUrl\)/);
  assert.match(idphoto, /pollTimer = setTimeout\(poll, 2000\)/);
  assert.match(idphoto, /sequence === pollSequence/);
  assert.doesNotMatch(idphoto, /pollTimer = setInterval/);
  assert.match(idphoto, /image\.src = img/);
  assert.doesNotMatch(idphoto, /card\.innerHTML = `\s*<div class="result-img-wrap">/);
});

test('changed page inline scripts parse', () => {
  parseInlineScripts('avatar.html', avatar);
  parseInlineScripts('ppt.html', ppt);
  parseInlineScripts('audio.html', audio);
  parseInlineScripts('video-face-swap.html', faceSwap);
  parseInlineScripts('idphoto.html', idphoto);
});
