const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { db } = require('../database/db');
const batchQueue = require('../services/batchDownloadTaskQueue');
const safeHttp = require('../utils/safeHttp');

const execFileAsync = promisify(execFile);
const PROJECT_DIR = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(PROJECT_DIR, 'tmp', 'batch-downloads');
const UPLOADS_DIR = path.join(PROJECT_DIR, 'public', 'uploads');

const STUDIO_NAMES = {
  ecommerce: '电商套图',
  xiaohongshu: '小红书',
  poster: '海报',
  copywriting: '文案',
  ppt: 'PPT',
  video: '视频',
  resume: '简历',
  avatar: '头像',
  image: 'AI绘图',
  'image-edit': '图生图',
  gif: 'GIF表情包'
};

const MEDIA_EXTENSIONS = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/ogg': '.ogg', 'audio/mp4': '.m4a'
};

function safeName(value, fallback) {
  const normalized = String(value || fallback).replace(/[\\/:*?"<>|]/g, '_').trim();
  return (normalized || fallback).slice(0, 80);
}

function resolveUploadFile(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const resolved = path.resolve(UPLOADS_DIR, pathname.slice('/uploads/'.length));
  if (resolved !== UPLOADS_DIR && !resolved.startsWith(UPLOADS_DIR + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function parseAssets(row) {
  let result;
  try {
    result = JSON.parse(row.result || '{}');
  } catch (error) {
    throw new Error(`作品 ${row.id} 的结果无法解析`);
  }
  if (!result) result = {};
  const assets = [];
  const seen = new Set();
  const add = (value, extension) => {
    const url = typeof value === 'string' ? value : value && (
      value.url || value.image || (value.b64_json && `data:image/png;base64,${value.b64_json}`)
    );
    if (url && !seen.has(url)) {
      assets.push({ url, extension });
      seen.add(url);
    }
  };
  for (const key of ['images', 'posters']) {
    if (Array.isArray(result[key])) result[key].forEach(value => add(value, '.png'));
  }
  for (const [key, ext] of Object.entries({ image: '.png', gif: '.gif', gif_url: '.gif',
    video: '.mp4', video_url: '.mp4', audio: '.wav', audio_url: '.wav' })) add(result[key], ext);
  if (Array.isArray(result)) result.forEach(value => add(value, '.png'));

  const texts = [];
  for (const key of ['versions', 'notes', 'copies']) {
    if (!Array.isArray(result[key])) continue;
    for (const item of result[key]) {
      const content = typeof item === 'string' ? item : item && (item.content || item.text || item.outline);
      if (typeof content !== 'string' || !content.trim()) continue;
      texts.push([item.title, content, Array.isArray(item.tags) ? item.tags.join(' ') : '']
        .filter(Boolean).join('\n\n'));
    }
  }
  for (const key of ['text', 'content', 'outline', 'description']) {
    if (typeof result[key] === 'string' && result[key].trim()) texts.push(result[key]);
  }
  if (typeof result === 'string') {
    if (/^(https?:\/\/|\/uploads\/|data:)/.test(result)) add(result, '.bin');
    else if (result.trim()) texts.push(result);
  }

  return {
    title: safeName(result.title, `作品_${row.id}`),
    assets,
    texts: [...new Set(texts)]
  };
}

async function writeAsset(asset, destination, signal) {
  signal.throwIfAborted();
  const { url } = asset;
  if (url.startsWith('/uploads/')) {
    const sourcePath = resolveUploadFile(url);
    if (!sourcePath) throw new Error('原文件不存在');
    if (!fs.statSync(sourcePath).size) throw new Error('原文件内容为空');
    const target = destination + (path.extname(sourcePath) || asset.extension);
    try { fs.linkSync(sourcePath, target); }
    catch { await fs.promises.copyFile(sourcePath, target); }
    return;
  }
  let buffer;
  let extension = asset.extension;
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match || !MEDIA_EXTENSIONS[match[1]]) throw new Error('媒体数据格式无效');
    buffer = Buffer.from(match[2], 'base64');
    extension = MEDIA_EXTENSIONS[match[1]];
  } else {
    const response = await safeHttp.safeRequest(url, {
      signal, timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`媒体下载失败：HTTP ${response.status}`);
    }
    const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type === 'text/html' || type === 'application/json') throw new Error('媒体链接返回了错误页面');
    buffer = response.body;
    const urlExt = path.extname(new URL(url).pathname).toLowerCase();
    extension = MEDIA_EXTENSIONS[type] || (Object.values(MEDIA_EXTENSIONS).includes(urlExt) ? urlExt : extension);
  }
  if (!buffer.length) throw new Error('媒体内容为空');
  signal.throwIfAborted();
  await fs.promises.writeFile(destination + extension, buffer);
}

function loadRows(task) {
  if (!Array.isArray(task.generationIds) || task.generationIds.length < 1 || task.generationIds.length > 50) {
    throw new Error('批量下载任务 generation_ids 无效');
  }
  if (!task.generationIds.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('批量下载任务 generation_ids 包含无效 ID');
  }
  const placeholders = task.generationIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, studio_type, result, created_at
    FROM generations
    WHERE id IN (${placeholders}) AND user_id = ? AND status = 'success'`)
    .all(...task.generationIds, task.user_id);
  if (rows.length !== task.generationIds.length) {
    throw new Error('部分作品不存在、未完成或已被删除');
  }
  return rows;
}

async function createArchive(task, owner, queue, leaseSeconds, signal) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const token = `${safeName(task.public_id, 'batch')}_${crypto.randomBytes(8).toString('hex')}`;
  const workingDir = path.join(TMP_ROOT, `${token}.work`);
  const archivePath = path.join(TMP_ROOT, `${token}.zip`);
  fs.rmSync(workingDir, { recursive: true, force: true });
  fs.rmSync(archivePath, { force: true });
  fs.mkdirSync(workingDir, { recursive: true });

  let processed = 0;
  try {
    const rows = loadRows(task);
    for (const row of rows) {
      signal.throwIfAborted();
      const studioDir = path.join(workingDir, safeName(STUDIO_NAMES[row.studio_type] || row.studio_type, '其他'));
      fs.mkdirSync(studioDir, { recursive: true });
      const { title, assets, texts } = parseAssets(row);
      if (!assets.length && !texts.length) throw new Error(`作品 ${row.id} 没有可导出的内容`);
      // Include the generation ID so equal titles never overwrite another work.
      const prefix = `${row.id}_${title}`;
      for (let index = 0; index < assets.length; index += 1) {
        try {
          await writeAsset(assets[index], path.join(studioDir, `${prefix}_${index + 1}`), signal);
        } catch (error) {
          throw new Error(`作品 ${row.id} 第 ${index + 1} 个文件：${error.message}`, { cause: error });
        }
      }
      for (let index = 0; index < texts.length; index += 1) {
        await fs.promises.writeFile(path.join(studioDir, `${prefix}_text_${index + 1}.txt`), texts[index], 'utf8');
      }
      processed += 1;
      queue.updateProgress(task, owner, processed);
      if (!queue.renewLease(task, owner, leaseSeconds)) {
        throw new Error('批量下载任务租约已失效');
      }
    }

    await execFileAsync(process.env.ZIP_PATH || 'zip', ['-r', '-q', archivePath, '.'], {
      cwd: workingDir,
      windowsHide: true,
      maxBuffer: 100 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      signal
    });
    if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
      throw new Error('ZIP 文件未生成');
    }
    queue.complete(task, owner, archivePath);
  } catch (error) {
    fs.rmSync(archivePath, { force: true });
    throw error;
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
}

function cleanupExpired(queue) {
  const tasks = queue.listExpired();
  for (const task of tasks) {
    if (task.file_path) {
      const resolved = path.resolve(task.file_path);
      if (resolved === TMP_ROOT || resolved.startsWith(TMP_ROOT + path.sep)) {
        try { fs.rmSync(resolved, { force: true }); } catch (error) {}
      }
    }
    queue.deleteExpired(task.public_id);
  }
}

function createBatchDownloadWorker(options = {}) {
  const pollIntervalMs = Number.isSafeInteger(options.pollIntervalMs) && options.pollIntervalMs >= 50
    ? options.pollIntervalMs
    : 1000;
  const leaseSeconds = Number.isSafeInteger(options.leaseSeconds) && options.leaseSeconds >= 5
    ? options.leaseSeconds
    : 120;
  const owner = typeof options.owner === 'string' && options.owner.trim()
    ? options.owner.trim()
    : `${process.pid}-batch-${crypto.randomUUID()}`;
  const queue = options.queue || batchQueue;
  let running = false;
  let timer = null;
  let active = null;
  let activeController = null;
  let lastCleanupAt = 0;

  async function processTask(task, controller) {
    let heartbeat = null;
    let leaseLost = false;
    try {
      heartbeat = setInterval(() => {
        try {
          if (!queue.renewLease(task, owner, leaseSeconds)) {
            leaseLost = true;
            controller.abort(new Error('批量下载任务租约已失效'));
          }
        } catch (error) {
          leaseLost = true;
          controller.abort(error);
        }
      }, Math.max(1000, Math.floor(leaseSeconds * 500)));
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      if (task.attempt_count > task.max_attempts) {
        throw new Error('批量下载任务恢复次数已达上限');
      }
      await createArchive(task, owner, queue, leaseSeconds, controller.signal);
    } catch (error) {
      if (leaseLost || error.message === '批量下载任务租约已失效') {
        console.error(`批量下载任务 ${task.public_id} 租约已失效，放弃提交状态`);
        return;
      }
      try {
        if (controller.signal.aborted && controller.signal.reason?.message === '服务正在关闭') {
          queue.release(task, owner, '服务正在关闭');
        } else {
          queue.failOrRetry(task, owner, error);
        }
      } catch (leaseError) {
        console.error(`批量下载任务 ${task.public_id} 状态更新失败:`, leaseError.message);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async function runOnce() {
    const task = queue.claimNext(owner, leaseSeconds);
    if (task) {
      const controller = new AbortController();
      await processTask(task, controller);
    }
    cleanupExpired(queue);
    return Boolean(task);
  }

  async function tick() {
    if (!running || active) return;
    active = (async () => {
      try {
        const task = queue.claimNext(owner, leaseSeconds);
        if (task) {
          activeController = new AbortController();
          await processTask(task, activeController);
        }
        if (Date.now() - lastCleanupAt >= 60_000) {
          cleanupExpired(queue);
          lastCleanupAt = Date.now();
        }
      } catch (error) {
        console.error('批量下载 worker 轮询失败:', error.message);
      }
    })();
    try {
      await active;
    } finally {
      active = null;
      activeController = null;
      if (running) timer = setTimeout(tick, pollIntervalMs);
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setTimeout(tick, 0);
  }

  async function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    if (activeController) activeController.abort(new Error('服务正在关闭'));
    if (active) await active;
  }

  return { start, stop, runOnce, isRunning: () => running };
}

module.exports = { createBatchDownloadWorker };
