const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { db } = require('../database/db');
const aiAdapter = require('../controllers/aiAdapter');
const generationJobQueue = require('../services/generationJobQueue');
const { safeRequest } = require('../utils/safeHttp');
const {
  getAdapterOptions,
  formatGenerationResult
} = require('../services/generationResult');

const execFileAsync = promisify(execFile);
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_RETRY_BASE_SECONDS = 10;
const VIDEO_POLL_SECONDS = 5;

function permanentError(message) {
  const error = new Error(message || '生成失败');
  error.permanent = true;
  return error;
}

function getModelId(job) {
  const value = job.payload.model_id === undefined ? job.model_id : job.payload.model_id;
  const modelId = Number(value);
  if (!Number.isSafeInteger(modelId) || modelId < 1) throw permanentError('payload.model_id 无效');
  return modelId;
}

function getRemainingDeadlineMs(job) {
  const seconds = Number(job.payload.deadline_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || !job.started_at) return null;
  const startedAt = Date.parse(job.started_at.endsWith('Z') ? job.started_at : `${job.started_at}Z`);
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, startedAt + seconds * 1000 - Date.now());
}

function assertDeadline(job) {
  const remainingMs = getRemainingDeadlineMs(job);
  if (remainingMs !== null && remainingMs <= 0) {
    throw permanentError('生成任务超过 deadline_seconds');
  }
}

async function handleImageGenerate(job, signal) {
  const payload = job.payload;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) throw permanentError('payload.prompt 无效');
  const result = await aiAdapter.generateImage(
    getModelId(job),
    prompt,
    { ...getAdapterOptions(payload), signal }
  );
  return formatGenerationResult(payload.result_style, result, { images: result.images }, payload.result_metadata);
}

async function handleImageEdit(job, signal) {
  const payload = job.payload;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) throw permanentError('payload.prompt 无效');
  const options = { ...getAdapterOptions(payload), signal };
  if (payload.ref_image_paths !== undefined) {
    const refs = readRefImagePaths(payload.ref_image_paths);
    options.ref_image = refs.length === 1 ? refs[0] : refs;
  }
  const result = await aiAdapter.editImage(
    getModelId(job),
    prompt,
    options
  );
  return formatGenerationResult(payload.result_style, result, { images: result.images }, payload.result_metadata);
}

async function handleAudioGenerate(job, signal) {
  const payload = job.payload;
  const input = payload.input_text === undefined ? payload.input : payload.input_text;
  if (typeof input !== 'string' || !input.trim()) throw permanentError('payload.input_text 无效');
  const result = await aiAdapter.generateAudio(
    getModelId(job),
    input,
    { ...getAdapterOptions(payload), signal }
  );
  return formatGenerationResult(payload.result_style, result, { audio: result.audio_url }, payload.result_metadata);
}

async function handleMediaAnalyze(job, signal) {
  const payload = job.payload;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) throw permanentError('payload.prompt 无效');
  const result = await aiAdapter.analyzeMedia(
    getModelId(job),
    prompt,
    { ...getAdapterOptions(payload), signal }
  );
  return formatGenerationResult(payload.result_style, result, { description: result.text }, payload.result_metadata);
}

function videoSubmitOptions(job, signal) {
  return {
    ...getAdapterOptions(job.payload),
    signal,
    idempotency_key: job.payload.idempotency_key || job.public_id
  };
}

async function handleVideo(job, queue, owner, submitter, signal) {
  const payload = job.payload;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) throw permanentError('payload.prompt 无效');

  if (!job.provider_task_id) {
    const submitted = await submitter(getModelId(job), prompt, videoSubmitOptions(job, signal));
    if (submitted.sync) {
      if (!submitted.video_url) throw permanentError('同步视频结果缺少 video_url');
      return {
        done: true,
        result: formatGenerationResult(payload.result_style, { video_url: submitted.video_url }, { video: submitted.video_url }, payload.result_metadata)
      };
    }
    if (!submitted.task_id) throw new Error('视频供应商未返回 task_id');
    queue.reschedule(job, owner, {
      phase: 'polling',
      providerTaskId: submitted.task_id,
      progress: 5,
      delaySeconds: 0
    });
    return { rescheduled: true };
  }

  const status = await aiAdapter.getVideoTaskStatus(getModelId(job), job.provider_task_id, { signal });
  if (status.status === 'failed') throw permanentError(status.error || status.error_msg || '视频供应商生成失败');
  if (status.status === 'succeeded') {
    if (!status.video_url) throw permanentError('视频供应商成功结果缺少 video_url');
    return {
      done: true,
      result: formatGenerationResult(payload.result_style, { video_url: status.video_url }, { video: status.video_url }, payload.result_metadata)
    };
  }

  queue.reschedule(job, owner, {
    phase: 'polling',
    progress: status.progress === undefined ? job.progress : status.progress,
    delaySeconds: VIDEO_POLL_SECONDS
  });
  return { rescheduled: true };
}

function resolveLocalPublicFile(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const publicDir = path.resolve(__dirname, '..', 'public');
  const resolved = path.resolve(publicDir, value.replace(/^\/+/, ''));
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
    throw permanentError('视频本地路径无效');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('视频本地文件不存在');
  }
  return resolved;
}

// 把工作流传来的本地参考图读成 data URL，交给 editImage 使用
function readRefImagePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw permanentError('payload.ref_image_paths 无效');
  if (paths.length > 8) throw permanentError('payload.ref_image_paths 数量过多');
  const roots = [];
  if (process.env.AI_STUDIO_UPLOADS_DIR && String(process.env.AI_STUDIO_UPLOADS_DIR).trim()) {
    roots.push(path.resolve(String(process.env.AI_STUDIO_UPLOADS_DIR).trim()));
  }
  roots.push(path.resolve(__dirname, '..', 'public', 'uploads'));
  const images = [];
  for (const item of paths) {
    if (typeof item !== 'string' || !item.startsWith('/uploads/')) {
      throw permanentError('参考图路径无效');
    }
    const relative = item.replace(/^\/uploads\//, '');
    let resolved = null;
    for (const root of roots) {
      const candidate = path.resolve(root, relative);
      if (candidate !== root && !candidate.startsWith(root + path.sep)) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        resolved = candidate;
        break;
      }
    }
    if (!resolved) throw permanentError('参考图文件不存在');
    const ext = path.extname(resolved).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : (ext === 'webp' ? 'webp' : 'png');
    images.push(`data:image/${mime};base64,` + fs.readFileSync(resolved).toString('base64'));
  }
  return images;
}

async function downloadVideo(url, destination, signal) {
  const localPath = resolveLocalPublicFile(url);
  if (localPath) {
    fs.copyFileSync(localPath, destination);
    return;
  }
  if (typeof url === 'string' && url.startsWith('data:video/')) {
    const match = url.match(/^data:video\/[a-zA-Z0-9+.-]+;base64,([a-zA-Z0-9+/=]+)$/);
    if (!match) throw permanentError('视频 data URL 格式无效');
    const buffer = Buffer.from(match[1], 'base64');
    if (!buffer.length || buffer.length > 500 * 1024 * 1024) {
      throw permanentError('视频 data URL 大小无效');
    }
    fs.writeFileSync(destination, buffer);
    return;
  }
  const response = await safeRequest(url, {
    signal,
    timeoutMs: 60_000,
    maxBytes: 500 * 1024 * 1024
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`视频下载失败：HTTP ${response.status}`);
  }
  fs.writeFileSync(destination, response.body);
}

async function convertVideoToGif(job, videoUrl, signal) {
  const gifDir = path.join(__dirname, '..', 'public', 'uploads', 'gif');
  const tempDir = path.join(__dirname, '..', 'tmp', 'generation-jobs');
  fs.mkdirSync(gifDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const token = `${job.public_id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  const videoPath = path.join(tempDir, `${token}.mp4`);
  const fileName = `gif_${token}.gif`;
  const gifPath = path.join(gifDir, fileName);
  const ratio = job.payload.ratio || (job.payload.options && job.payload.options.ratio);
  const filter = ratio === '1:1'
    ? 'fps=12,scale=320:-1:flags=lanczos,crop=320:320'
    : 'fps=12,scale=320:-1:flags=lanczos';

  try {
    await downloadVideo(videoUrl, videoPath, signal);
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-i', videoPath,
      '-vf', filter,
      '-loop', '0',
      '-y', gifPath
    ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60 * 1000, signal });
  } finally {
    try { fs.unlinkSync(videoPath); } catch (err) {}
  }

  return `/uploads/gif/${fileName}`;
}

async function handleVideoGif(job, queue, owner, signal) {
  if (job.phase === 'converting') {
    const videoUrl = job.payload.__video_url;
    if (!videoUrl) throw permanentError('GIF 转换缺少视频地址');
    const gifUrl = await convertVideoToGif(job, videoUrl, signal);
    const canonical = {
      gif_url: gifUrl,
      video_url: videoUrl,
      duration: job.payload.duration || job.payload.options?.duration,
      ratio: job.payload.ratio || job.payload.options?.ratio,
      mode: job.payload.mode || job.payload.options?.mode
    };
    return {
      done: true,
      result: formatGenerationResult(
        job.payload.result_style,
        canonical,
        { gif: gifUrl, video: videoUrl },
        job.payload.result_metadata
      )
    };
  }

  const originalResultStyle = job.payload.result_style;
  const videoJob = { ...job, payload: { ...job.payload, result_style: 'canonical' } };
  const result = await handleVideo(videoJob, queue, owner, aiAdapter.submitVideoTask, signal);
  if (!result.done) return result;
  const videoUrl = typeof result.result === 'string'
    ? result.result
    : result.result.video_url || result.result.video;
  if (!videoUrl) throw permanentError('GIF 视频生成结果缺少 video_url');
  queue.reschedule(job, owner, {
    phase: 'converting',
    progress: 80,
    payload: { ...job.payload, result_style: originalResultStyle, __video_url: videoUrl },
    delaySeconds: 0
  });
  return { rescheduled: true };
}

const claimWebhookTransaction = db.transaction((owner, leaseSeconds) => {
  const candidate = db.prepare(`SELECT id FROM webhook_deliveries
    WHERE (
      (status IN ('queued', 'retry') AND datetime(next_run_at) <= datetime('now'))
      OR
      (status = 'processing' AND lease_expires_at IS NOT NULL
        AND datetime(lease_expires_at) <= datetime('now'))
    )
    ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, datetime(next_run_at), id
    LIMIT 1`).get();
  if (!candidate) return null;

  const claimed = db.prepare(`UPDATE webhook_deliveries
    SET status = 'processing', lease_owner = ?,
        lease_expires_at = datetime('now', '+' || ? || ' seconds'),
        attempt = attempt + 1, updated_at = datetime('now')
    WHERE id = ? AND (
      (status IN ('queued', 'retry') AND datetime(next_run_at) <= datetime('now'))
      OR
      (status = 'processing' AND lease_expires_at IS NOT NULL
        AND datetime(lease_expires_at) <= datetime('now'))
    )`).run(owner, leaseSeconds, candidate.id);
  if (claimed.changes !== 1) return null;

  return db.prepare(`SELECT webhook_deliveries.*, webhook_subscriptions.webhook_url,
      webhook_subscriptions.secret
    FROM webhook_deliveries
    JOIN webhook_subscriptions ON webhook_subscriptions.id = webhook_deliveries.subscription_id
    WHERE webhook_deliveries.id = ?`).get(candidate.id);
});

function claimWebhook(owner, leaseSeconds) {
  return claimWebhookTransaction.immediate(owner, leaseSeconds);
}

async function deliverWebhook(delivery, owner, leaseSeconds) {
  let heartbeat = null;
  let leaseLost = false;
  const controller = new AbortController();
  try {
    heartbeat = setInterval(() => {
      try {
        const renewed = db.prepare(`UPDATE webhook_deliveries
          SET lease_expires_at = datetime('now', '+' || ? || ' seconds'),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`)
          .run(leaseSeconds, delivery.id, owner);
        if (renewed.changes !== 1) {
          leaseLost = true;
          controller.abort(new Error('Webhook 投递租约已失效'));
        }
      } catch (err) {
        leaseLost = true;
        controller.abort(err);
      }
    }, Math.max(1000, Math.floor(leaseSeconds * 500)));
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const response = await safeRequest(delivery.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(delivery.payload),
        'X-Webhook-Secret': delivery.secret || '',
        'X-Webhook-Event': delivery.event_type
      },
      body: delivery.payload,
      timeoutMs: 10_000,
      maxBytes: 1024 * 1024,
      signal: controller.signal
    });
    if (leaseLost) throw new Error('Webhook 投递租约已失效');
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Webhook 返回 HTTP ${response.status}`);
    }
    const result = db.prepare(`UPDATE webhook_deliveries
      SET status = 'delivered', delivered_at = datetime('now'), last_error = '',
          lease_owner = '', lease_expires_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'processing' AND lease_owner = ?`)
      .run(delivery.id, owner);
    if (result.changes !== 1) throw new Error('Webhook 投递租约已失效');
  } catch (error) {
    const message = (error && error.message ? error.message : 'Webhook 投递失败').slice(0, 2000);
    const isFinal = delivery.attempt >= WEBHOOK_MAX_ATTEMPTS;
    const delaySeconds = Math.min(15 * 60, WEBHOOK_RETRY_BASE_SECONDS * (2 ** Math.max(0, delivery.attempt - 1)));
    const result = db.prepare(`UPDATE webhook_deliveries
      SET status = ?, last_error = ?,
          next_run_at = datetime('now', '+' || ? || ' seconds'),
          lease_owner = '', lease_expires_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'processing' AND lease_owner = ?`)
      .run(isFinal ? 'failed' : 'retry', message, delaySeconds, delivery.id, owner);
    if (result.changes !== 1) throw error;
  }
}

function createGenerationWorker(options = {}) {
  const pollIntervalMs = Number.isSafeInteger(options.pollIntervalMs) && options.pollIntervalMs >= 50
    ? options.pollIntervalMs
    : 1000;
  const leaseSeconds = Number.isSafeInteger(options.leaseSeconds) && options.leaseSeconds >= 5
    ? options.leaseSeconds
    : 60;
  const concurrency = Number.isSafeInteger(options.concurrency) && options.concurrency >= 1
    ? options.concurrency
    : 2;
  const owner = typeof options.owner === 'string' && options.owner.trim()
    ? options.owner.trim()
    : `${process.pid}-${crypto.randomUUID()}`;
  const queue = options.queue || generationJobQueue;
  const handlers = {
    'image.generate': handleImageGenerate,
    'image.edit': handleImageEdit,
    'audio.generate': handleAudioGenerate,
    'media.analyze': handleMediaAnalyze,
    'video.generate': (job, signal) => handleVideo(job, queue, owner, aiAdapter.submitVideoTask, signal),
    'video.face-swap': (job, signal) => handleVideo(job, queue, owner, aiAdapter.submitFaceSwapTask, signal),
    'video.generate-gif': (job, signal) => handleVideoGif(job, queue, owner, signal)
  };

  let running = false;
  let timer = null;
  let draining = null;
  const active = new Set();
  const controllers = new Set();

  async function processGenerationJob(job, controller) {
    let heartbeat = null;
    let deadlineTimer = null;
    let leaseLost = false;
    try {
      // Preflight failures must use the same terminal-state and refund path.
      if (!job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) {
        throw permanentError('任务 payload 必须是有效 JSON 对象');
      }
      const handler = Object.hasOwn(handlers, job.job_type) ? handlers[job.job_type] : null;
      if (!handler) throw permanentError(`不支持的生成任务类型：${job.job_type}`);
      assertDeadline(job);
      const remainingMs = getRemainingDeadlineMs(job);
      if (remainingMs !== null) {
        deadlineTimer = setTimeout(() => controller.abort(new Error('生成任务超过 deadline_seconds')), remainingMs);
        if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
      }
      heartbeat = setInterval(() => {
        try {
          if (!queue.renewLease(job, owner, leaseSeconds)) {
            leaseLost = true;
            controller.abort(new Error('生成任务租约已失效'));
          }
        } catch (err) {
          leaseLost = true;
          controller.abort(err);
        }
      }, Math.max(1000, Math.floor(leaseSeconds * 500)));
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      if (job.failure_count >= job.max_attempts) {
        throw permanentError('生成任务恢复次数已达上限');
      }
      const outcome = await handler(job, controller.signal);
      if (leaseLost) throw new Error('生成任务租约已失效');
      if (outcome && outcome.rescheduled) return;
      assertDeadline(job);
      const result = outcome && outcome.done ? outcome.result : outcome;
      queue.complete(job, owner, result);
    } catch (error) {
      if (leaseLost || error.message === '生成任务租约已失效'
        || controller.signal.reason?.message === '生成任务租约已失效') {
        console.error(`生成任务 ${job.id} 租约已失效，放弃提交状态`);
        return;
      }
      const abortMessage = controller.signal.aborted && controller.signal.reason?.message;
      if (abortMessage === '服务正在关闭') {
        queue.reschedule(job, owner, { delaySeconds: 0, lastError: abortMessage });
      } else if (abortMessage === '生成任务超过 deadline_seconds') {
        const deadlineError = permanentError('生成任务超过 deadline_seconds');
        queue.failOrRetry(job, owner, deadlineError);
      } else {
        queue.failOrRetry(job, owner, error);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      controllers.delete(controller);
    }
  }

  async function runOneSlot() {
    if (!running || active.size >= concurrency) return false;
    const job = queue.claimNext(owner, leaseSeconds);
    if (job) {
      const controller = new AbortController();
      controllers.add(controller);
      const promise = processGenerationJob(job, controller).catch(error => {
        console.error(`生成任务 ${job.id} 执行失败:`, error.message);
      });
      active.add(promise);
      promise.finally(() => active.delete(promise));
      return true;
    }

    const delivery = claimWebhook(owner, leaseSeconds);
    if (!delivery) return false;
    const promise = deliverWebhook(delivery, owner, leaseSeconds).catch(error => {
      console.error(`Webhook 投递 ${delivery.id} 执行失败:`, error.message);
    });
    active.add(promise);
    promise.finally(() => active.delete(promise));
    return true;
  }

  async function runOnce() {
    if (!running) running = true;
    let claimed = 0;
    while (active.size < concurrency && await runOneSlot()) claimed += 1;
    if (active.size > 0) await Promise.allSettled(Array.from(active));
    return claimed;
  }

  async function tick() {
    if (!running) return;
    try {
      while (running && active.size < concurrency && await runOneSlot()) {}
    } catch (error) {
      console.error('生成 worker 轮询失败:', error.message);
    } finally {
      if (running) timer = setTimeout(tick, pollIntervalMs);
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setTimeout(tick, 0);
  }

  async function stop() {
    if (draining) return draining;
    running = false;
    if (timer) clearTimeout(timer);
    for (const controller of controllers) controller.abort(new Error('服务正在关闭'));
    draining = Promise.allSettled(Array.from(active)).then(() => undefined);
    return draining;
  }

  return { start, stop, runOnce, isRunning: () => running };
}

module.exports = { createGenerationWorker };
