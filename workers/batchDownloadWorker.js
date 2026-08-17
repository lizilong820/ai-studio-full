const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { db } = require('../database/db');
const batchQueue = require('../services/batchDownloadTaskQueue');

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

function safeName(value, fallback) {
  const normalized = String(value || fallback).replace(/[\\/:*?"<>|]/g, '_').trim();
  return (normalized || fallback).slice(0, 80);
}

function resolveUploadFile(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const resolved = path.resolve(UPLOADS_DIR, url.slice('/uploads/'.length));
  if (resolved !== UPLOADS_DIR && !resolved.startsWith(UPLOADS_DIR + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function parseAssets(row) {
  let result;
  try {
    result = JSON.parse(row.result || '{}');
  } catch (error) {
    return { title: `作品_${row.id}`, assets: [] };
  }

  let assets = [];
  if (Array.isArray(result.images)) assets = result.images;
  else if (Array.isArray(result.posters)) {
    assets = result.posters.map(item => typeof item === 'string' ? item : item && (item.image || item.url));
  } else if (result.image) assets = [result.image];
  else if (result.gif) assets = [result.gif];
  else if (result.video) assets = [result.video];
  else if (result.video_url) assets = [result.video_url];
  else if (result.audio_url) assets = [result.audio_url];

  return {
    title: safeName(result.title, `作品_${row.id}`),
    assets: assets.filter(Boolean)
  };
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
  const token = safeName(task.public_id, crypto.randomBytes(8).toString('hex'));
  const workingDir = path.join(TMP_ROOT, `${token}.work`);
  const archivePath = path.join(TMP_ROOT, `${token}.zip`);
  fs.rmSync(workingDir, { recursive: true, force: true });
  fs.rmSync(archivePath, { force: true });
  fs.mkdirSync(workingDir, { recursive: true });

  let processed = 0;
  try {
    const rows = loadRows(task);
    for (const row of rows) {
      const studioDir = path.join(workingDir, safeName(STUDIO_NAMES[row.studio_type] || row.studio_type, '其他'));
      fs.mkdirSync(studioDir, { recursive: true });
      const { title, assets } = parseAssets(row);
      for (let index = 0; index < assets.length; index += 1) {
        const sourcePath = resolveUploadFile(assets[index]);
        if (!sourcePath) continue;
        const extension = path.extname(sourcePath) || '.bin';
        const destination = path.join(studioDir, `${title}_${index + 1}${extension}`);
        try {
          fs.linkSync(sourcePath, destination);
        } catch (error) {
          fs.copyFileSync(sourcePath, destination);
        }
      }
      processed += 1;
      queue.updateProgress(task, owner, processed);
      queue.renewLease(task, owner, leaseSeconds);
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
    try {
      heartbeat = setInterval(() => {
        try { queue.renewLease(task, owner, leaseSeconds); } catch (error) {}
      }, Math.max(1000, Math.floor(leaseSeconds * 500)));
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      if (task.attempt_count > task.max_attempts) {
        throw new Error('批量下载任务恢复次数已达上限');
      }
      await createArchive(task, owner, queue, leaseSeconds, controller.signal);
    } catch (error) {
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

  return { start, stop, runOnce };
}

module.exports = { createBatchDownloadWorker };
