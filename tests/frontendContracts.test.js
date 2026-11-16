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
const image = fs.readFileSync(path.join(publicDir, 'image.html'), 'utf8');
const poster = fs.readFileSync(path.join(publicDir, 'poster.html'), 'utf8');
const ecommerce = fs.readFileSync(path.join(publicDir, 'ecommerce.html'), 'utf8');
const copywriting = fs.readFileSync(path.join(publicDir, 'copywriting.html'), 'utf8');
const xiaohongshu = fs.readFileSync(path.join(publicDir, 'xiaohongshu.html'), 'utf8');
const gif = fs.readFileSync(path.join(publicDir, 'gif.html'), 'utf8');
const videoGen = fs.readFileSync(path.join(publicDir, 'video-gen.html'), 'utf8');
const developer = fs.readFileSync(path.join(publicDir, 'developer.html'), 'utf8');
const promptExtract = fs.readFileSync(path.join(publicDir, 'prompt-extract.html'), 'utf8');
const editor = fs.readFileSync(path.join(publicDir, 'editor.html'), 'utf8');
const home = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const faceSwap = fs.readFileSync(path.join(publicDir, 'video-face-swap.html'), 'utf8');
const idphoto = fs.readFileSync(path.join(publicDir, 'idphoto.html'), 'utf8');
const profile = fs.readFileSync(path.join(publicDir, 'profile.html'), 'utf8');
const workflowPage = fs.readFileSync(path.join(publicDir, 'workflow.html'), 'utf8');
const admin = fs.readFileSync(path.join(publicDir, 'admin', 'index.html'), 'utf8');
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

test('profile work details render untrusted data with DOM APIs', () => {
  assert.match(profile, /card\.dataset\.workId = String\(id\)/);
  assert.match(profile, /const coverUrl = normalizeMediaUrl\(item\.cover\)/);
  assert.match(profile, /function showGenDetailModal\(gen\)/);
  assert.match(profile, /body\.textContent = content/);
  assert.match(profile, /tag\.textContent = String\(valueTag\)/);
  assert.match(profile, /valueNode\.textContent = typeof value === 'object'/);
  assert.match(profile, /const safeImages = .*\.map\(normalizeMediaUrl\)\.filter\(Boolean\)/);
  assert.match(profile, /const mediaUrl = normalizeMediaUrl\(url\)/);
  assert.match(profile, /new URL\(audioUrl, window\.location\.origin\)\.href/);
  assert.match(profile, /favorite\.disabled = true/);
  assert.match(profile, /if \(await toggleFav\(generationId, Boolean\(gen\.is_favorite\)\)\) modal\.remove\(\)/);
  assert.match(profile, /if \(!resultSection && result\.video\)/);
  assert.match(profile, /暂无可展示结果/);
  assert.match(profile, /\.slice\(0, 180\)/);
  assert.match(profile, /\^\(con\|prn\|aux\|nul\|com\[1-9\]\|lpt\[1-9\]\)/i);
  assert.doesNotMatch(profile, /\bcontentHtml\b|\bparamsHtml\b|work-fav-btn-single/);
  assert.doesNotMatch(profile, /document\.onkeydown|window\.location\.origin \+ url/);
  assert.doesNotMatch(profile, /onclick="(?:openLightbox|downloadAllImages|downloadFile|copyAudioUrl|copyText)/);
});

test('profile account data is rendered without dynamic HTML', () => {
  assert.match(profile, /grid\.replaceChildren\(\)/);
  assert.match(profile, /name\.textContent = String\(pkg\.name/);
  assert.match(profile, /const qrcodeUrl = normalizeMediaUrl\(data\.url_qrcode\)/);
  assert.match(profile, /qrcodeWrap\.replaceChildren\(image\)/);
  assert.match(profile, /function normalizeExternalUrl\(value\)/);
  assert.match(profile, /\['http:', 'https:'\]\.includes\(url\.protocol\)/);
  assert.match(profile, /tbody\.replaceChildren\(\)/);
  assert.match(profile, /badge\.textContent = statusConfig/);
  assert.match(profile, /description\.textContent = String\(item\.description/);
  assert.match(profile, /cal\.replaceChildren\(\)/);
  assert.match(profile, /status\.replaceChildren\('已连续签到 '/);
  assert.match(profile, /description\.replaceChildren\('每邀请一位好友注册/);
  assert.match(profile, /button\.addEventListener\('click', \(\) => callback\(page\)\)/);
  assert.match(profile, /encodeURIComponent\(taskId\)/);
  assert.match(profile, /new URL\(downloadUrl\)\.origin !== window\.location\.origin/);
  assert.match(profile, /window\._dlTimer = setTimeout\(poll, 1000\)/);
  assert.match(profile, /sequence !== window\._dlPollSequence/);
  assert.match(profile, /if \(sequence === window\._dlPollSequence\) downloadZipFile\(currentDownloadUrl\)/);
  assert.match(profile, /payPollTimer = setTimeout\(poll, 3000\)/);
  assert.match(profile, /sequence !== window\._payPollSequence/);
  assert.doesNotMatch(profile, /\.innerHTML\s*=/);
  assert.doesNotMatch(profile, /setInterval\(async/);
  assert.doesNotMatch(profile, /grid\.innerHTML = list\.map\(\(pkg/);
  assert.doesNotMatch(profile, /tbody\.innerHTML = list\.map/);
  assert.doesNotMatch(profile, /cal\.innerHTML = d\.week_days\.map/);
  assert.doesNotMatch(profile, /getElementById\('inviteDesc'\)\.innerHTML/);
  assert.doesNotMatch(profile, /onclick="__pg/);
  assert.doesNotMatch(profile, /'<img src="' \+ data\.url_qrcode/);
});

test('admin users models and generation details use DOM APIs', () => {
  assert.match(admin, /function normalizeAdminId\(value\)/);
  assert.match(admin, /typeof value !== 'string' \|\| !\/\^\\d\+\$\/\.test\(value\)/);
  assert.match(admin, /function createAdminCell\(text/);
  assert.match(admin, /function createAdminButton\(text, className, onClick\)/);
  assert.match(admin, /tbody\.replaceChildren\(\)/);
  assert.match(admin, /username\.appendChild\(document\.createTextNode/);
  assert.match(admin, /identifier\.textContent = String\(model\.model_identifier/);
  assert.match(admin, /event => testModel\(id, event\.currentTarget\)/);
  assert.doesNotMatch(admin, /const btn = event\.target/);
  assert.match(admin, /checkbox\.addEventListener\('change', updateGenBatchBtn\)/);
  assert.match(admin, /function viewGenDetail\(id\)/);
  assert.match(admin, /const urls = result\.images\.map\(normalizeMediaUrl\)\.filter\(Boolean\)/);
  assert.match(admin, /image\.addEventListener\('click', \(\) => window\.open\(url, '_blank', 'noopener,noreferrer'\)\)/);
  assert.match(admin, /paramsValue\.textContent = g\.params/);
  assert.match(admin, /content\.textContent = String\(item\.content/);
  assert.match(admin, /error\.append\(label, document\.createTextNode\(String\(g\.error_msg\)\)\)/);
  assert.match(admin, /button\.addEventListener\('click', \(\) => callback\(page\)\)/);
  assert.doesNotMatch(admin, /usersTbody\.innerHTML|modelsTbody\.innerHTML|gensTbody\.innerHTML|genDetailContent\.innerHTML/);
  assert.doesNotMatch(admin, /resultHtml|onclick="window\.open|onclick="__pg_/);
});

test('admin dashboard and business data use DOM APIs', () => {
  assert.match(admin, /chart\.replaceChildren\(\)/);
  assert.match(admin, /bar\.style\.height = Math\.max\(8, \(item\.count \/ max\) \* 100\) \+ '%'/);
  assert.match(admin, /studioStats\.replaceChildren\(\)/);
  assert.match(admin, /fill\.style\.width = \(item\.count \/ total \* 100\)\.toFixed\(1\) \+ '%'/);
  assert.match(admin, /packages\.forEach\(pkg =>/);
  assert.match(admin, /createAdminButton\('编辑', '', \(\) => editPackage\(id\)\)/);
  assert.match(admin, /ordersTbody/);
  assert.match(admin, /orderStatus\.appendChild\(statusInfo/);
  assert.match(admin, /createAdminButton\('确认到账', 'btn-primary', \(\) => confirmOrder\(id\)\)/);
  assert.match(admin, /creditLogsTbody/);
  assert.match(admin, /typeMap\[log\.type\] \|\| log\.type \|\| '-'/);
  assert.doesNotMatch(admin, /chart\.innerHTML|studioStats\.innerHTML|packagesTbody\.innerHTML|ordersTbody\.innerHTML|creditLogsTbody\.innerHTML/);
  assert.doesNotMatch(admin, /onclick="editPackage|onclick="deletePackage|onclick="confirmOrder/);
});

test('model options use DOM APIs across studios', () => {
  assert.match(common, /function renderModelOptions\(select, models, formatLabel/);
  assert.match(common, /select\.replaceChildren\(\)/);
  assert.match(common, /option\.value = String\(model\.id/);
  assert.match(common, /option\.textContent = String\(formatLabel\(model\)\)/);
  for (const page of [avatar, ppt, video, resume, audio, image, poster, ecommerce, copywriting, xiaohongshu]) {
    assert.doesNotMatch(page, /data\.data\.map\(m\s*=>\s*`<option/);
    assert.doesNotMatch(page, /optionsHtml\s*=\s*data\.data\.map/);
  }
  assert.match(editor, /function renderEditorModelOptions\(select, models\)/);
  assert.match(editor, /renderEditorModelOptions\(resceneSel, data\.data\)/);
  assert.match(editor, /renderEditorModelOptions\(dwmSel, data\.data\)/);
  assert.doesNotMatch(editor, /(?:resceneSel|dwmSel)\.innerHTML\s*=\s*data\.data\.map/);
});

test('image studio polling uses shared non-overlapping control', () => {
  assert.match(image, /currentPoll = pollGeneration\(/);
  assert.match(image, /currentPoll\.stop\(\)/);
  assert.doesNotMatch(image, /setInterval\s*\(async/);
  assert.doesNotMatch(image, /clearInterval\(currentPollInterval\)/);
  assert.match(poster, /startImageGeneration\(formData\.count/);
  assert.match(poster, /pollGeneration\(\s*taskId/);
  assert.doesNotMatch(poster, /startImageGeneration\(count/);
  assert.doesNotMatch(poster, /setInterval\s*\(async/);
  assert.match(ecommerce, /pollGeneration\(\s*taskId/);
  assert.doesNotMatch(ecommerce, /setInterval\s*\(async/);
});

test('editor tasks stop stale polling and preserve target image', () => {
  assert.match(editor, /function startEditorTask\(targetIndex\)/);
  assert.match(editor, /function isEditorTaskActive\(task\)/);
  assert.match(editor, /task\.timer = setTimeout\(poll, 2000\)/);
  assert.match(editor, /if \(!isEditorTaskActive\(task\)\) return/);
  assert.match(editor, /images\[task\.targetIndex\] = newImg/);
  assert.match(editor, /if \(currentIndex === task\.targetIndex\)/);
  assert.match(editor, /stopEditorTask\(activeEditorTask\)/);
  assert.doesNotMatch(editor, /setInterval\s*\(async/);
  assert.doesNotMatch(editor, /pollDewatermarkTask|function pollTask\(taskId\)/);
  assert.doesNotMatch(editor, /loadingCancelled/);
});

test('home search renders API results as text and ignores stale responses', () => {
  assert.match(home, /hotTagsEl\.replaceChildren\(\)/);
  assert.match(home, /searchResults\.replaceChildren\(\)/);
  assert.match(home, /element\.textContent = String\(text \|\| ''\)/);
  assert.match(home, /if \(sequence !== searchSequence \|\| data\.code !== 0\) return/);
  assert.match(home, /item\.addEventListener\('click', \(\) => window\.gotoStudio/);
  assert.doesNotMatch(home, /searchResults\.innerHTML/);
  assert.doesNotMatch(home, /hotTagsEl\.innerHTML/);
  assert.doesNotMatch(home, /onclick="gotoStudio/);
});

test('cost calculation ignores stale responses and duplicate triggers', () => {
  const costPages = [
    ['xiaohongshu.html', xiaohongshu],
    ['video.html', video],
    ['video-gen.html', videoGen],
    ['resume.html', resume],
    ['ppt.html', ppt],
    ['poster.html', poster],
    ['copywriting.html', copywriting],
    ['avatar.html', avatar],
    ['audio.html', audio],
    ['image.html', image],
    ['ecommerce.html', ecommerce],
    ['gif.html', gif]
  ];
  for (const [fileName, html] of costPages) {
    assert.match(html, /let costRequestSeq = 0/ , fileName);
    assert.match(html, /const requestSeq = \+\+costRequestSeq/, fileName);
    assert.match(html, /requestSeq !== costRequestSeq/, fileName);
    parseInlineScripts(fileName, html);
  }
  assert.doesNotMatch(audio, /onchange="onModelChange\(\)"/);
  assert.equal((image.match(/getElementById\('img2imgModelSelect'\)\?\.addEventListener\('change'/g) || []).length, 1);
  assert.doesNotMatch(image, /getElementById\('imageCount'\)\?\.addEventListener\('change', updateCost\)/);
  assert.doesNotMatch(ecommerce, /getElementById\('imgCount'\)\.addEventListener\('change', updateCost\)/);
  assert.match(workflowPage, /const seq = \+\+studioCostSeq/);
  assert.doesNotMatch(common, /dispatchEvent\(new Event\('change'\)\);\s*updateCost\(\)/);
  assert.match(videoGen, /updateDurationAvailability\(\);\s*updateCost\(\);/);
  assert.doesNotMatch(videoGen, /currentDuration = parseInt\(items\[i\]\.dataset\.duration\);\s*updateCost\(\);/);
});
test('video generation normalizes mobile images and exposes provider-safe durations', () => {
  assert.match(videoGen, /function normalizeImageFile\(file\)/);
  assert.match(videoGen, /canvas\.toDataURL\('image\/jpeg', 0\.92\)/);
  assert.match(videoGen, /data:image\/jpeg;base64,\/9j\//);
  assert.match(videoGen, /id="durationInput"[^>]*min="1"[^>]*max="15"/);
  assert.match(videoGen, /let currentDuration = 5/);
  assert.match(videoGen, /Math\.min\(Math\.max\(value, 1\), 15\)/);
  assert.match(videoGen, /function switchLoraToStandardModel\(\)/);
  assert.match(videoGen, /identifier\.replace\(\/-lora\$\/, ''\)/);
  assert.match(videoGen, /1-4 秒已切换到同模式标准版/);
  assert.doesNotMatch(videoGen, /dur >= 5/);
  assert.match(videoGen, /await addReferenceFiles\(files\)/);
});

test('gif and video generation polling isolates tasks and validates media URLs', () => {
  for (const [fileName, html, endpoint] of [
    ['gif.html', gif, 'gif'],
    ['video-gen.html', videoGen, 'video-gen']
  ]) {
    assert.match(html, /const sequence = \+\+pollSequence/, fileName);
    assert.match(html, /if \(sequence !== pollSequence\) return/, fileName);
    assert.match(html, /pollTimer = setTimeout\(poll, 3000\)/, fileName);
    assert.match(html, new RegExp("/api/generate/" + endpoint + "/' \\+ encodeURIComponent\\(taskId\\)"), fileName);
    assert.match(html, /const mediaUrl = normalizeMediaUrl\(/, fileName);
    assert.doesNotMatch(html, /setInterval\s*\(async/, fileName);
    assert.doesNotMatch(html, /currentTaskId/, fileName);
  }
  assert.match(gif, /resultGif'\)\.src = mediaUrl/);
  assert.match(videoGen, /resultVideo'\)\.src = mediaUrl/);
  assert.match(videoGen, /lastVideoUrl = mediaUrl/);
  assert.doesNotMatch(videoGen, /lastGifUrl/);
});
test('task IDs, editor media, history requests, and image errors stay bounded', () => {
  assert.match(common, /const normalizedTaskId = String\(taskId \?\? ''\)/);
  assert.match(common, /encodeURIComponent\(normalizedTaskId\)/);
  assert.match(common, /normalizedTaskId\.length > 128/);
  assert.match(faceSwap, /const taskId = String\(data\.data\?\.task_id \?\? ''\)/);
  assert.match(faceSwap, /encodeURIComponent\(taskId\)/);
  assert.match(editor, /function normalizeEditorMediaUrl\(value\)/);
  assert.match(editor, /encodeURIComponent\(String\(taskId\)\)/);
  assert.match(editor, /const mediaUrl = normalizeEditorMediaUrl\(url\)/);
  assert.match(editor, /newImg\.src = mediaUrl/);
  assert.match(audio, /let historyItemRequestSeq = 0/);
  assert.match(audio, /const requestSeq = \+\+historyItemRequestSeq/);
  assert.match(audio, /requestSeq !== historyItemRequestSeq/);
  assert.match(audio, /encodeURIComponent\(normalizedId\)/);
  assert.match(image, /const errorMessage = previewContent\.querySelector\('\.error-message'\)/);
  assert.match(image, /errorMessage\.replaceChildren\(/);
  assert.match(image, /querySelector\('button'\)\.addEventListener\('click'/);
  assert.doesNotMatch(image, /\$\{errorMsg/);
  assert.doesNotMatch(image, /onclick=\"document\.getElementById\('generateBtn'\)/);
  assert.match(developer, /let statsRangeSeq = 0/);
  assert.match(developer, /sequence !== statsRangeSeq/);
  assert.match(developer, /chartEl\.replaceChildren\(\)/);
  assert.match(developer, /legendEl\.replaceChildren\(\)/);
  assert.doesNotMatch(developer, /chartEl\.innerHTML = data\.map/);
  assert.doesNotMatch(developer, /legendEl\.innerHTML = data\.map/);
  assert.match(idphoto, /encodeURIComponent\(String\(currentTaskId\)\)/);
  assert.match(idphoto, /pollCount > 150/);
  assert.match(idphoto, /consecutiveErrors >= 5/);
  assert.match(faceSwap, /pollCount > 100/);
  assert.match(faceSwap, /consecutiveErrors >= 5/);
});

test('developer data and prompt errors render with DOM APIs', () => {
  assert.match(developer, /function renderKeys\(\)[\s\S]*listEl\.replaceChildren\(\)/);
  assert.match(developer, /copy\.addEventListener\('click', \(\) => copyKey\(keyId\)\)/);
  assert.match(developer, /toggle\.addEventListener\('click', \(\) => toggleKeyStatus\(keyId\)\)/);
  assert.match(developer, /function renderLogs\(days(?:, sequence = statsRangeSeq)?\)[\s\S]*logsEl\.replaceChildren\(\)/);
  assert.match(developer, /statusNode\.textContent = String\(item\.status \|\| '-'\)/);
  assert.doesNotMatch(developer, /listEl\.innerHTML = g_apiKeys\.map/);
  assert.doesNotMatch(developer, /logsEl\.innerHTML = list\.map/);
  assert.match(developer, /function loadWebhooks\(\)[\s\S]*listEl\.replaceChildren\(\)/);
  assert.match(developer, /toggle\.addEventListener\('click', \(\) => toggleWebhook\(id/);
  assert.match(developer, /remove\.addEventListener\('click', \(\) => deleteWebhook\(id\)\)/);
  assert.match(developer, /encodeURIComponent\(String\(taskId\)\)/);
  assert.match(developer, /pollEl\.replaceChildren\(\)/);
  assert.doesNotMatch(developer, /onclick="(?:copyKey|toggleKeyStatus|deleteKey|toggleWebhook|deleteWebhook)/);
  assert.doesNotMatch(developer, /listEl\.innerHTML = html/);
  assert.match(promptExtract, /message\.textContent = String\(data\.msg \|\| data\.message \|\| '未知错误'\)/);
  assert.match(promptExtract, /message\.textContent = String\(err\.message \|\| '网络错误'\)/);
  assert.doesNotMatch(promptExtract, /\$\{data\.msg \|\| data\.message/);
  assert.doesNotMatch(promptExtract, /\$\{err\.message \|\| '网络错误'/);
  parseInlineScripts('developer.html', developer);
  parseInlineScripts('prompt-extract.html', promptExtract);
});
test('changed page inline scripts parse', () => {
  parseInlineScripts('avatar.html', avatar);
  parseInlineScripts('ppt.html', ppt);
  parseInlineScripts('audio.html', audio);
  parseInlineScripts('video-face-swap.html', faceSwap);
  parseInlineScripts('idphoto.html', idphoto);
  parseInlineScripts('profile.html', profile);
  parseInlineScripts('workflow.html', workflowPage);
  parseInlineScripts('admin/index.html', admin);
  parseInlineScripts('image.html', image);
  parseInlineScripts('poster.html', poster);
  parseInlineScripts('ecommerce.html', ecommerce);
  parseInlineScripts('copywriting.html', copywriting);
  parseInlineScripts('xiaohongshu.html', xiaohongshu);
  parseInlineScripts('video-gen.html', videoGen);
  parseInlineScripts('gif.html', gif);
  parseInlineScripts('editor.html', editor);
  parseInlineScripts('index.html', home);
});
