const express = require('express');
const { db } = require('../database/db');
const { apiKeyAuth, recordUsage } = require('../middleware/apiAuth');
const aiAdapter = require('../controllers/aiAdapter');
const creditService = require('../controllers/creditService');
const { safeRequest, validatePublicUrl } = require('../utils/safeHttp');

const router = express.Router();

// ========== Webhook 相关工具函数 ==========
async function triggerWebhook(userId, eventType, payload) {
  try {
    const subs = db.prepare(`
      SELECT ws.* FROM webhook_subscriptions ws
      WHERE ws.user_id = ? AND ws.status = 1 AND ws.event_type LIKE ?
    `).all(userId, `%${eventType}%`);

    if (!subs || subs.length === 0) return;

    const body = JSON.stringify({
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload
    });

    subs.forEach(sub => {
      safeRequest(sub.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Webhook-Secret': sub.secret || '',
          'X-Webhook-Event': eventType
        },
        body,
        timeoutMs: 10_000,
        maxBytes: 1024 * 1024
      }).catch(err => {
        console.error(`Webhook 发送失败 [${sub.id}]:`, err.message);
      });
    });
  } catch (err) {
    console.error('触发Webhook失败:', err.message);
  }
}

// ========== 公开接口（无需鉴权） ==========

// API 信息
router.get('/info', (req, res) => {
  const models = aiAdapter.getEnabledModels();
  res.json({
    code: 0,
    msg: 'success',
    data: {
      version: 'v1.1',
      available_studios: [
        { type: 'ecommerce', name: '电商套图', async: true },
        { type: 'xiaohongshu', name: '小红书笔记', async: false },
        { type: 'poster', name: '海报生成', async: true },
        { type: 'copywriting', name: '文案写作', async: false },
        { type: 'ppt', name: 'PPT生成', async: false },
        { type: 'video', name: '短视频脚本', async: false },
        { type: 'resume', name: '简历优化', async: false },
        { type: 'avatar', name: 'AI头像', async: true },
        { type: 'image', name: 'AI图片生成', async: true },
        { type: 'image-edit', name: 'AI图生图/编辑', async: true },
        { type: 'video-gen', name: 'AI视频生成', async: true },
        { type: 'gif', name: 'GIF表情包', async: true },
        { type: 'prompt-extract', name: '提示词反推', async: false },
        { type: 'audio', name: '音频合成', async: true },
        { type: 'idphoto', name: 'AI证件照', async: true },
        { type: 'face-swap', name: 'AI换脸', async: true },
      ],
      models,
      rate_limit: '60次/分钟/密钥',
      authentication: 'X-API-Key header',
      base_url: '/api/v1',
      features: ['同步生成', '异步任务', '任务查询', 'Webhook回调', '批量查询']
    }
  });
});

// ========== 需要鉴权的接口 ==========
router.use(apiKeyAuth);

// ========== 通用响应包装 ==========
function v1Success(res, data, msg = 'success') {
  res.json({ code: 0, msg, data });
}

function v1Error(res, msg, code = 400) {
  res.status(200).json({ code, msg, data: null });
}

// ========== 工具函数 ==========
function getTaskResult(taskId) {
  const task = db.prepare('SELECT * FROM generations WHERE id = ?').get(taskId);
  if (!task) return null;

  let result = null;
  try {
    result = task.result ? JSON.parse(task.result) : null;
  } catch (e) {
    result = null;
  }

  return {
    task_id: task.id,
    studio_type: task.studio_type,
    status: task.status,
    result,
    credits_used: task.credits_used,
    error_msg: task.error_msg,
    created_at: task.created_at,
    completed_at: task.completed_at
  };
}

// ========== 1. 电商套图生成 ==========
router.post('/generate/ecommerce', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'ecommerce';

  try {
    const { model_id, selling_points, image_count = 4, ratio = '1:1', platform, tone } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!selling_points) return v1Error(res, '请提供 selling_points 商品卖点参数');

    const actualCount = parseInt(image_count) || 4;
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-电商套图生成 (${actualCount}张)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/ecommerce', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const prompt = `Generate high quality e-commerce product image for: ${selling_points}. Platform: ${platform || 'general'}, Style: ${tone || 'neutral'}. The product should be the main focus in a beautiful scene.`;

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'ecommerce', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);

    const taskId = result.lastInsertRowid;

    // 异步生成
    setImmediate(async () => {
      try {
        const sizeMap = { '1:1': '1024x1024', '3:4': '768x1024', '16:9': '1024x576', '9:16': '576x1024', '4:3': '1024x768' };
        const size = sizeMap[ratio] || '1024x1024';
        const negative = 'text, words, letters, characters, writing, watermark, logo, signature, caption, ugly, distorted, blurry, low quality';

        const genResult = await aiAdapter.generateImage(model_id, prompt, {
          n: Math.min(actualCount, 4), size, negative_prompt: negative,
        });

        let images = genResult.images;
        if (actualCount > 4 && images.length < actualCount) {
          const more = await aiAdapter.generateImage(model_id, prompt + ' different angle', {
            n: Math.min(actualCount - images.length, 4), size, negative_prompt: negative,
          });
          images = images.concat(more.images);
        }
        images = images.slice(0, actualCount);

        db.prepare(`UPDATE generations SET result = ?, status = 'success', 
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({ images }), taskId);

        // Webhook 回调
        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost,
          result: { images }
        });
      } catch (err) {
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/ecommerce', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/ecommerce', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 2. 小红书生成 ==========
router.post('/generate/xiaohongshu', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'xiaohongshu';

  try {
    const { model_id, topic, versions = 1 } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!topic) return v1Error(res, '请提供 topic 主题参数');

    const actualVersions = parseInt(versions) || 1;
    const cost = aiAdapter.calculateCost(model_id, actualVersions);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-小红书生成 (${actualVersions}版)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/xiaohongshu', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const prompt = `请生成${actualVersions}篇小红书爆款笔记，主题：${topic}。
每篇包含：标题（带emoji）、正文（分段落，有互动引导）、标签（5-8个）。
风格：亲切种草感，有干货有情绪价值。`;

    const genResult = await aiAdapter.generateText(model_id, prompt, { max_tokens: 2000 * actualVersions });

    const versionsResult = [{
      version: 1,
      content: genResult.text,
      title: topic
    }];

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status, result)
      VALUES (?, 'xiaohongshu', ?, ?, ?, 'success', ?)`)
      .run(user.id, model_id, JSON.stringify(req.body), cost, JSON.stringify({ versions: versionsResult }));

    const taskId = result.lastInsertRowid;

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/xiaohongshu', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'completed',
      result: { versions: versionsResult },
      cost,
      remaining_credits: deductResult.balance
    }, '生成成功');

    triggerWebhook(user.id, 'task.completed', {
      task_id: taskId,
      studio_type: studioType,
      status: 'success',
      credits_used: cost,
      result: { versions: versionsResult }
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/xiaohongshu', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 3. 海报生成 ==========
router.post('/generate/poster', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'poster';

  try {
    const { model_id, theme, poster_type, image_count = 1, ratio = '3:4' } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!theme) return v1Error(res, '请提供 theme 主题参数');

    const actualCount = parseInt(image_count) || 1;
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-海报生成 (${actualCount}张)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/poster', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const prompt = `Create a ${poster_type || 'promotional'} poster design for: ${theme}. High quality, eye-catching, professional design.`;

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'poster', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);

    const taskId = result.lastInsertRowid;

    setImmediate(async () => {
      try {
        const sizeMap = { '1:1': '1024x1024', '3:4': '768x1024', '4:3': '1024x768', '16:9': '1024x576', '9:16': '576x1024' };
        const size = sizeMap[ratio] || '768x1024';

        const genResult = await aiAdapter.generateImage(model_id, prompt, {
          n: Math.min(actualCount, 4), size,
          negative_prompt: 'text, words, watermark, logo, ugly, blurry, low quality',
        });

        let images = genResult.images;
        if (actualCount > 4 && images.length < actualCount) {
          const more = await aiAdapter.generateImage(model_id, prompt + ' different layout', {
            n: Math.min(actualCount - images.length, 4), size,
            negative_prompt: 'text, words, watermark, logo, ugly, blurry, low quality',
          });
          images = images.concat(more.images);
        }
        images = images.slice(0, actualCount);

        db.prepare(`UPDATE generations SET result = ?, status = 'success', 
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({ images }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost,
          result: { images }
        });
      } catch (err) {
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/poster', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/poster', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 4. 文案写作 ==========
router.post('/generate/copywriting', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'copywriting';

  try {
    const { model_id, product, purpose, tone, versions = 1 } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!product) return v1Error(res, '请提供 product 产品/服务名称');

    const actualVersions = parseInt(versions) || 1;
    const cost = aiAdapter.calculateCost(model_id, actualVersions);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-文案写作 (${actualVersions}版)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/copywriting', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const prompt = `请为【${product}】撰写${actualVersions}版${purpose || '营销'}文案，语气：${tone || '专业'}。
要求：有吸引力、突出卖点、引导行动。`;

    const genResult = await aiAdapter.generateText(model_id, prompt, { max_tokens: 1500 * actualVersions });

    const versionsResult = [{ version: 1, content: genResult.text, title: product + '文案' }];

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status, result)
      VALUES (?, 'copywriting', ?, ?, ?, 'success', ?)`)
      .run(user.id, model_id, JSON.stringify(req.body), cost, JSON.stringify({ versions: versionsResult }));

    const taskId = result.lastInsertRowid;

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/copywriting', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'completed',
      result: { versions: versionsResult },
      cost,
      remaining_credits: deductResult.balance
    }, '生成成功');

    triggerWebhook(user.id, 'task.completed', {
      task_id: taskId,
      studio_type: studioType,
      status: 'success',
      credits_used: cost,
      result: { versions: versionsResult }
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/copywriting', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 5. PPT生成 ==========
router.post('/generate/ppt', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'ppt';

  try {
    const { model_id, topic, audience, style, pages = 10 } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!topic) return v1Error(res, '请提供 topic 主题参数');

    const actualPages = Math.max(3, Math.min(parseInt(pages) || 10, 30));
    const cost = aiAdapter.calculateCost(model_id, 1);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-PPT生成 (${actualPages}页)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/ppt', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const prompt = `请生成一份关于"${topic}"的PPT大纲，共${actualPages}页。
目标受众：${audience || '通用'}，风格：${style || '专业商务'}。
每页包含：标题、核心要点（3-5条）、备注。
格式清晰，逻辑连贯。`;

    const genResult = await aiAdapter.generateText(model_id, prompt, { max_tokens: 3000 });

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status, result)
      VALUES (?, 'ppt', ?, ?, ?, 'success', ?)`)
      .run(user.id, model_id, JSON.stringify(req.body), cost, JSON.stringify({ outline: genResult.text, pages: actualPages }));

    const taskId = result.lastInsertRowid;

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/ppt', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'completed',
      result: { outline: genResult.text, pages: actualPages },
      cost,
      remaining_credits: deductResult.balance
    }, '生成成功');

    triggerWebhook(user.id, 'task.completed', {
      task_id: taskId,
      studio_type: studioType,
      status: 'success',
      credits_used: cost
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/ppt', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 6. 短视频脚本 ==========
router.post('/generate/video', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'video';

  try {
    const { model_id, topic, duration = 60, platform = 'douyin', versions = 1 } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!topic) return v1Error(res, '请提供 topic 主题参数');

    const actualVersions = parseInt(versions) || 1;
    const cost = aiAdapter.calculateCost(model_id, actualVersions);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-短视频脚本 (${actualVersions}版)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/video', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const prompt = `请为${platform}平台创作一个约${duration}秒的短视频脚本，主题：${topic}。
共${actualVersions}个版本。

每个版本包含：
- 视频标题
- 核心创意/看点
- 分镜脚本（按场景，每个场景包含：画面描述、台词/旁白、时长）
- BGM建议
- 标签/话题

要求：开头3秒有钩子，节奏紧凑，有情绪起伏，结尾有引导。`;

    const genResult = await aiAdapter.generateText(model_id, prompt, { max_tokens: 2000 * actualVersions });

    const versionsResult = [{ version: 1, content: genResult.text, title: topic + ' - 短视频脚本' }];

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status, result)
      VALUES (?, 'video', ?, ?, ?, 'success', ?)`)
      .run(user.id, model_id, JSON.stringify(req.body), cost, JSON.stringify({ versions: versionsResult }));

    const taskId = result.lastInsertRowid;

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/video', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'completed',
      result: { versions: versionsResult },
      cost,
      remaining_credits: deductResult.balance
    }, '生成成功');

    triggerWebhook(user.id, 'task.completed', {
      task_id: taskId,
      studio_type: studioType,
      status: 'success',
      credits_used: cost
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/video', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 7. 简历优化 ==========
router.post('/generate/resume', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'resume';

  try {
    const { model_id, position, experience, skills, versions = 1 } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!position) return v1Error(res, '请提供 position 求职岗位参数');

    const actualVersions = parseInt(versions) || 1;
    const cost = aiAdapter.calculateCost(model_id, actualVersions);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-简历优化 (${actualVersions}版)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/resume', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const prompt = `请为求职简历做优化，生成${actualVersions}个版本。
目标岗位：${position}
工作经历：${experience || '未提供'}
技能特长：${skills || '未提供'}

每个版本包含：
- 个人优势/自我评价（突出亮点）
- 工作经历描述优化（用STAR法则，量化成果）
- 技能亮点提炼
- 求职建议

要求：专业、精准、有说服力，突出候选人的核心竞争力。`;

    const genResult = await aiAdapter.generateText(model_id, prompt, { max_tokens: 2000 * actualVersions });

    const versionsResult = [{ version: 1, content: genResult.text, title: position + ' - 简历优化' }];

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status, result)
      VALUES (?, 'resume', ?, ?, ?, 'success', ?)`)
      .run(user.id, model_id, JSON.stringify(req.body), cost, JSON.stringify({ versions: versionsResult }));

    const taskId = result.lastInsertRowid;

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/resume', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'completed',
      result: { versions: versionsResult },
      cost,
      remaining_credits: deductResult.balance
    }, '生成成功');

    triggerWebhook(user.id, 'task.completed', {
      task_id: taskId,
      studio_type: studioType,
      status: 'success',
      credits_used: cost
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/resume', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 8. AI头像生成 ==========
router.post('/generate/avatar', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'avatar';

  try {
    const { model_id, style = 'cartoon', gender = 'female', age_range = 'young', image_count = 1, ratio = '1:1' } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');

    const actualCount = parseInt(image_count) || 1;
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-AI头像生成 (${actualCount}张)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/avatar', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const prompt = `A beautiful ${style} style avatar portrait of a ${age_range} ${gender} person, high quality, detailed face, artistic, profile picture style.`;

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'avatar', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);

    const taskId = result.lastInsertRowid;

    setImmediate(async () => {
      try {
        const sizeMap = { '1:1': '1024x1024', '3:4': '768x1024', '4:3': '1024x768', '16:9': '1024x576', '9:16': '576x1024' };
        const size = sizeMap[ratio] || '1024x1024';

        const genResult = await aiAdapter.generateImage(model_id, prompt, {
          n: Math.min(actualCount, 4), size,
          negative_prompt: 'ugly, distorted, blurry, low quality, bad anatomy',
        });

        let images = genResult.images;
        if (actualCount > 4 && images.length < actualCount) {
          const more = await aiAdapter.generateImage(model_id, prompt + ' different style and expression', {
            n: Math.min(actualCount - images.length, 4), size,
            negative_prompt: 'ugly, distorted, blurry, low quality, bad anatomy',
          });
          images = images.concat(more.images);
        }
        images = images.slice(0, actualCount);

        db.prepare(`UPDATE generations SET result = ?, status = 'success', 
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({ images }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost,
          result: { images }
        });
      } catch (err) {
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/avatar', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/avatar', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 9. AI图片生成（异步） ==========
router.post('/generate/image', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'image';

  try {
    const { model_id, prompt, negative_prompt = '', style = '', size = '1:1', image_count = 1 } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!prompt || !prompt.trim()) return v1Error(res, '请提供 prompt 参数（图片描述）');

    const actualCount = Math.min(parseInt(image_count) || 1, 9);
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-AI图片生成 (${actualCount}张)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/image', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const stylePresets = {
      '写实': 'photorealistic, hyperrealistic, ultra detailed, 8k, professional photography',
      '动漫': 'anime style, manga art, vibrant colors, cel shading, detailed',
      '油画': 'oil painting style, classical art, brush strokes, fine art texture',
      '水彩': 'watercolor painting, soft colors, artistic, painterly',
      '赛博朋克': 'cyberpunk style, neon lights, futuristic, high tech, glowing accents',
      '国潮': 'Chinese guochao style, traditional Chinese elements, oriental aesthetics',
      '3D渲染': '3d render, octane render, unreal engine, cinematic lighting, high detail',
      '扁平插画': 'flat illustration, vector art, clean design, minimalist, solid colors',
    };
    const styleAdd = stylePresets[style] || '';
    const finalPrompt = styleAdd ? `${styleAdd}, ${prompt}` : prompt;
    const defaultNeg = 'ugly, deformed, blurry, low quality, bad anatomy, text, watermark, logo';
    const finalNeg = negative_prompt ? `${defaultNeg}, ${negative_prompt}` : defaultNeg;

    const sizeMap = { '1:1': '1024x1024', '3:4': '768x1024', '4:3': '1024x768', '16:9': '1024x576', '9:16': '576x1024' };
    const genSize = sizeMap[size] || '1024x1024';

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'image', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);

    const taskId = result.lastInsertRowid;

    setImmediate(async () => {
      try {
        let allImages = [];
        let remaining = actualCount;
        let batchNum = 0;

        while (remaining > 0) {
          const batchCount = Math.min(remaining, 4);
          const seedPrompt = batchNum > 0 ? `${finalPrompt}, variation ${batchNum + 1}` : finalPrompt;
          const genResult = await aiAdapter.generateImage(model_id, seedPrompt, {
            n: batchCount, size: genSize, negative_prompt: finalNeg,
          });
          allImages = allImages.concat(genResult.images || []);
          remaining -= batchCount;
          batchNum++;
          if (genResult.mock) break;
        }
        allImages = allImages.slice(0, actualCount);

        db.prepare(`UPDATE generations SET result = ?, status = 'success', 
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({ images: allImages }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost,
          result: { images: allImages }
        });
      } catch (err) {
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/image', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/image', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 10. AI图生图/图片编辑（v1.1新增） ==========
router.post('/generate/image-edit', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'image-edit';

  try {
    const { model_id, prompt, ref_image, negative_prompt = '', mode = 'variation', image_count = 1, size = '1:1' } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!ref_image) return v1Error(res, '请提供 ref_image 参数（参考图片URL或base64）');

    const actualCount = Math.min(parseInt(image_count) || 1, 4);
    // 图生图价格按生图的1.5倍计算
    const baseCost = aiAdapter.calculateCost(model_id, actualCount);
    if (!baseCost) return v1Error(res, '模型不存在或价格获取失败');
    const cost = Math.ceil(baseCost * 1.5);

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', `API-AI图生图 (${actualCount}张)`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/image-edit', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const defaultNeg = 'ugly, deformed, blurry, low quality, bad anatomy, text, watermark, logo';
    const finalNeg = negative_prompt ? `${defaultNeg}, ${negative_prompt}` : defaultNeg;
    const finalPrompt = prompt || 'high quality, detailed, professional';

    const sizeMap = { '1:1': '1024x1024', '3:4': '768x1024', '4:3': '1024x768', '16:9': '1024x576', '9:16': '576x1024' };
    const genSize = sizeMap[size] || '1024x1024';

    const result = db.prepare(`INSERT INTO generations 
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'image-edit', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);

    const taskId = result.lastInsertRowid;

    setImmediate(async () => {
      try {
        const genResult = await aiAdapter.generateImage(model_id, finalPrompt, {
          n: actualCount,
          size: genSize,
          negative_prompt: finalNeg,
          ref_image: ref_image,
          mode: mode
        });

        const images = (genResult.images || []).slice(0, actualCount);

        db.prepare(`UPDATE generations SET result = ?, status = 'success', 
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({ images, mode }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost,
          result: { images, mode }
        });
      } catch (err) {
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/image-edit', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '图生图任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/image-edit', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 11. 音频合成 ==========
router.post('/generate/audio', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'audio';

  try {
    const { model_id, input_text, response_format = 'wav' } = req.body;
    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!input_text || !input_text.trim()) return v1Error(res, '请输入要合成的文本');

    const text = input_text.trim();
    if (text.length > 5000) return v1Error(res, '文本过长，最多支持5000字');

    const cost = aiAdapter.calculateCost(model_id, 1);
    if (!cost) return v1Error(res, '模型不存在或价格获取失败');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', 'API-音频合成'
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/audio', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const result = db.prepare(`INSERT INTO generations
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'audio', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);
    const taskId = result.lastInsertRowid;

    setImmediate(async () => {
      try {
        const genResult = await aiAdapter.generateAudio(model_id, text, {
          response_format,
          voice: req.body.voice || undefined,
          dialect: req.body.dialect || undefined,
          cfg_value: req.body.cfg_value,
          inference_timesteps: req.body.inference_timesteps,
          seed: req.body.seed,
          normalize: req.body.normalize,
          denoise: req.body.denoise,
          ref_text: req.body.ref_text || undefined,
          ref_audio: req.body.ref_audio || undefined,
          speed: req.body.speed,
          duration: req.body.duration,
          num_step: req.body.num_step,
          language_id: req.body.language_id || undefined,
          instructions: req.body.instructions || undefined,
          use_emo_text: req.body.use_emo_text,
          emo_alpha: req.body.emo_alpha,
          emo_audio: req.body.emo_audio || undefined,
          emo_vector: req.body.emo_vector,
          use_random: req.body.use_random,
        });

        db.prepare(`UPDATE generations SET result = ?, status = 'success',
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({
            audio_url: genResult.audio_url,
            file_name: genResult.file_name,
            format: genResult.format,
            size: genResult.size,
            mock: genResult.mock || false
          }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost
        });
      } catch (err) {
        console.error('API音频生成失败:', err);
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/audio', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '音频合成任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/audio', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 12. 提示词反推 ==========
router.post('/generate/prompt-extract', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'prompt-extract';

  try {
    const { model_id, image_url, video_url, extract_type = 'prompt', style = 'general' } = req.body;

    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!image_url && !video_url) return v1Error(res, '请上传图片或视频');

    const model = aiAdapter.getEnabledModels('vlm').find(m => m.id === parseInt(model_id))
      || aiAdapter.getEnabledModels('text').find(m => m.id === parseInt(model_id));
    if (!model) return v1Error(res, '视觉理解模型不存在或未启用');

    const cost = model.price_per_call || 10;

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', 'API-提示词提取'
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/prompt-extract', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const insertResult = db.prepare(`INSERT INTO generations
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'prompt-extract', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify({ extract_type, style, image_url, video_url }), cost);
    const taskId = insertResult.lastInsertRowid;

    const systemPrompts = {
      prompt: '你是一位专业的AI提示词工程师。请仔细分析这张图片/视频的所有细节，然后生成一段高质量的英文AI绘画/视频提示词。要求：\n1. 详细描述主体、场景、构图、光影、色彩、风格、材质、氛围\n2. 使用逗号分隔的关键词形式，按重要性排序\n3. 适合用于Midjourney、DALL-E、Stable Diffusion等模型生成相似内容\n4. 输出格式：先写一段完整的英文提示词（50-150词），再换行用中文简要解释图片内容',
      description: '请用中文详细描述这张图片/视频的内容，包括：主体事物、场景环境、人物外貌穿着、动作表情、色彩光影、构图角度、整体风格和氛围。要求条理清晰，描述准确。',
      keywords: '请分析这张图片/视频，提取20个最核心的英文关键词（按重要性排序），用逗号分隔。关键词应涵盖：主体、场景、风格、色彩、光线、构图、材质等维度。',
      midjourney: '你是Midjourney提示词专家。分析这张图片/视频，生成一段专业的Midjourney提示词。要求：\n1. 英文，80-200词\n2. 包含主体描述、环境背景、艺术风格、光影效果、镜头角度、色彩调性、画质参数\n3. 末尾加上合适的 --ar --s --q 等参数\n4. 输出完整可直接使用的提示词',
    };

    const userPrompts = {
      prompt: '请分析这张图片，生成高质量的AI生成提示词。',
      description: '请详细描述这张图片的内容。',
      keywords: '请提取这张图片的核心关键词。',
      midjourney: '请生成Midjourney风格的提示词。',
    };

    const systemPrompt = systemPrompts[extract_type] || systemPrompts.prompt;
    const userPrompt = userPrompts[extract_type] || userPrompts.prompt;

    setImmediate(async () => {
      try {
        let finalImageUrl = image_url;
        if (video_url) {
          const path = require('path');
          const fs = require('fs');
          const tempDir = path.join(__dirname, '../public/uploads/temp_video');
          if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

          let videoFilePath = '';
          if (typeof video_url === 'string' && video_url.startsWith('data:')) {
            const base64Data = video_url.split(',')[1] || '';
            const mimeType = video_url.split(';')[0].replace('data:', '');
            const extMap = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv' };
            const ext = extMap[mimeType] || 'mp4';
            const fileName = 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
            videoFilePath = path.join(tempDir, fileName);
            fs.writeFileSync(videoFilePath, Buffer.from(base64Data, 'base64'));
          } else if (typeof video_url === 'string' && video_url.startsWith('http')) {
            const https = require('https');
            const http = require('http');
            const fileName = 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.mp4';
            videoFilePath = path.join(tempDir, fileName);
            const dlModule = video_url.startsWith('https') ? https : http;
            const file = fs.createWriteStream(videoFilePath);
            await new Promise((resolve, reject) => {
              dlModule.get(video_url, response => {
                response.pipe(file);
                file.on('finish', () => file.close(resolve));
              }).on('error', reject);
            });
          }
          if (videoFilePath) {
            const { execSync } = require('child_process');
            const gridPath = path.join(tempDir, 'grid_' + path.basename(videoFilePath, path.extname(videoFilePath)) + '.jpg');
            try {
              execSync(`ffmpeg -i "${videoFilePath}" -vf "select='eq(n,10)+eq(n,30)+eq(n,60)',scale=400:-1,tile=3x1" -frames:v 1 -q:v 2 "${gridPath}" -y`, { stdio: 'pipe' });
              finalImageUrl = 'file://' + gridPath;
            } catch (e) {
              // 抽帧失败用首帧
              const firstFramePath = path.join(tempDir, 'first_' + path.basename(videoFilePath, path.extname(videoFilePath)) + '.jpg');
              execSync(`ffmpeg -i "${videoFilePath}" -vframes 1 -q:v 2 "${firstFramePath}" -y`, { stdio: 'pipe' });
              finalImageUrl = 'file://' + firstFramePath;
            }
          }
        }

        const genResult = await aiAdapter.generateImage(model_id, userPrompt, {
          system_prompt: systemPrompt,
          image_url: finalImageUrl,
          vlm_mode: true
        });

        const answerText = (genResult.images && genResult.images[0]) || genResult.text || '';

        db.prepare(`UPDATE generations SET result = ?, status = 'success',
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({
            extract_type,
            style,
            prompt: answerText,
            image_url: image_url || '',
            video_url: video_url || ''
          }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost
        });
      } catch (err) {
        console.error('API提示词反推失败:', err);
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/prompt-extract', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '提示词反推任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/prompt-extract', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 13. AI证件照 ==========
router.post('/generate/idphoto', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'idphoto';

  try {
    const {
      model_id,
      ref_image,
      bg_color = 'blue',
      size = '1inch',
      suit = 'none',
      gender = 'auto',
      quality = 'standard',
      num_photos = 1
    } = req.body;

    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!ref_image || !ref_image.trim()) return v1Error(res, '请上传您的照片');

    const IDPHOTO_SIZES = {
      '1inch': { name: '一寸', width: 295, height: 413 },
      '2inch': { name: '二寸', width: 413, height: 579 },
      'small1inch': { name: '小一寸', width: 260, height: 378 },
      'small2inch': { name: '小二寸', width: 413, height: 531 },
      'big1inch': { name: '大一寸', width: 390, height: 567 },
      'big2inch': { name: '大二寸', width: 413, height: 626 },
    };
    const IDPHOTO_BG_COLORS = {
      'white': { name: '白色', hex: '#FFFFFF' },
      'blue': { name: '蓝色', hex: '#438EDB' },
      'red': { name: '红色', hex: '#D03232' },
      'gray': { name: '灰色', hex: '#D9D9D9' },
    };
    const IDPHOTO_SUITS = {
      'none': { name: '不添加', desc: '仅抠图换背景' },
      'male_formal': { name: '男士正装', desc: '西装+衬衫+领带' },
      'female_formal': { name: '女士正装', desc: '西装+衬衫' },
      'male_civil': { name: '男士文职', desc: '衬衫+领带' },
      'female_civil': { name: '女士文职', desc: '衬衫' },
    };

    const sizeConfig = IDPHOTO_SIZES[size];
    if (!sizeConfig) return v1Error(res, '无效的尺寸规格');
    const bgConfig = IDPHOTO_BG_COLORS[bg_color];
    if (!bgConfig) return v1Error(res, '无效的背景色');
    const suitConfig = IDPHOTO_SUITS[suit];
    if (!suitConfig) return v1Error(res, '无效的正装选项');

    const actualCount = Number(num_photos);
    if (!Number.isSafeInteger(actualCount) || actualCount < 1 || actualCount > 4) {
      return v1Error(res, '证件照数量必须为1-4张');
    }

    const totalCost = aiAdapter.calculateCost(model_id, actualCount);
    if (totalCost === null) return v1Error(res, '无法计算价格');

    const deductResult = creditService.deductCredits(
      user.id, totalCost, 'consume', `API-AI证件照(${sizeConfig.name})`
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/idphoto', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const result = db.prepare(`INSERT INTO generations
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'idphoto', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify({
        bg_color, size, suit, gender, quality, num_photos: actualCount, ref_image
      }), totalCost);
    const taskId = result.lastInsertRowid;

    setImmediate(async () => {
      try {
        const genResult = await aiAdapter.generateImage(model_id, `ID photo of a person, ${bgConfig.name} background, ${sizeConfig.name} size, professional`, {
          n: actualCount,
          size: `${sizeConfig.width}x${sizeConfig.height}`,
          ref_image: ref_image,
          mode: 'idphoto',
          idphoto_bg: bgConfig.hex,
          idphoto_suit: suit,
          idphoto_gender: gender,
          idphoto_quality: quality,
        });

        const images = (genResult.images || []).slice(0, actualCount);

        db.prepare(`UPDATE generations SET result = ?, status = 'success',
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({
            images,
            bg_color,
            size,
            suit,
            quality,
            num_photos: actualCount
          }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: totalCost
        });
      } catch (err) {
        console.error('API证件照生成失败:', err);
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/idphoto', studioType, taskId, 'success', totalCost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost: totalCost,
      remaining_credits: deductResult.balance
    }, '证件照生成任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/idphoto', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 14. AI视频生成 ==========
router.post('/generate/video-gen', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'video-gen';

  try {
    const { model_id, prompt, mode = 'text', ref_image = '', duration = 5, ratio = '16:9' } = req.body;

    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!prompt || !prompt.trim()) return v1Error(res, '请输入描述内容');

    const model = aiAdapter.getEnabledModels('video').find(m => m.id === parseInt(model_id));
    if (!model) return v1Error(res, '视频模型不存在或未启用');

    // 模式与模型能力校验
    const modelLower = model.name.toLowerCase();
    const isVeo = modelLower.includes('veo');
    const isSeedance = modelLower.includes('seedance') || modelLower.includes('dance');
    const isPaipu = model.api_endpoint && model.api_endpoint.includes('api.paipu.net');
    const isMinimax = model.api_endpoint && (model.api_endpoint.includes('/v1/video/generations') || model.api_endpoint.includes('mzsjai.com'));
    const isMinimaxRef = isMinimax && (model.model_identifier || '').toLowerCase().includes('ref2va');

    const hasImage = Array.isArray(ref_image)
      ? ref_image.length > 0 && ref_image.some(img => img && img.trim() !== '')
      : ref_image && ref_image.trim() !== '';

    if (mode === 'image_reference' && isVeo) {
      return v1Error(res, 'Veo 模型不支持参考图模式，请使用首帧模式或文生视频');
    }
    if (mode === 'image_firstframe' && (isSeedance || isPaipu)) {
      return v1Error(res, '该模型只支持参考图模式，不支持首帧模式');
    }
    if ((mode === 'image_firstframe' || mode === 'image_reference') && !hasImage) {
      return v1Error(res, '请上传图片');
    }
    if (isMinimaxRef) {
      if (mode === 'image_firstframe') {
        return v1Error(res, '该模型为全能参考模式，不支持首帧模式，请使用参考图模式');
      }
      if (mode === 'text' || (mode === 'image_reference' && !hasImage)) {
        return v1Error(res, '该模型为参考图生视频模型，必须上传至少1张参考图');
      }
    }
    if (isPaipu || isSeedance) {
      const d = parseInt(duration);
      if (d !== 10 && d !== 15) {
        return v1Error(res, '该模型仅支持 10 秒或 15 秒时长');
      }
    }
    if (isMinimax) {
      const d = parseInt(duration);
      if (isNaN(d) || d < 1 || d > 15) {
        return v1Error(res, 'MiniMax H3 模型仅支持 1-15 秒时长');
      }
    }

    const cost = aiAdapter.calculateCost(model_id, { duration: parseInt(duration) || 5 });
    if (cost === null) return v1Error(res, '无法计算价格');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', 'API-AI视频生成'
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/video-gen', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg || '积分不足', 402);
    }

    const result = db.prepare(`INSERT INTO generations
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'video-gen', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);
    const taskId = result.lastInsertRowid;

    // 异步执行视频生成
    setImmediate(async () => {
      try {
        const submitResult = await aiAdapter.submitVideoTask(model_id, prompt, {
          duration,
          ratio,
          ref_image: mode === 'text' ? '' : ref_image,
          mode,
        });

        const videoTaskId = submitResult.task_id;

        // 轮询视频生成结果
        const maxWait = 15 * 60 * 1000;
        const pollStart = Date.now();
        let videoUrl = '';

        while (Date.now() - pollStart < maxWait) {
          const status = await aiAdapter.getVideoTaskStatus(model_id, videoTaskId);

          if (status.status === 'succeeded') {
            videoUrl = status.video_url || '';
            break;
          }
          if (status.status === 'failed') {
            throw new Error(status.error_msg || '视频生成失败');
          }

          await new Promise(r => setTimeout(r, 5000));
        }

        if (!videoUrl) {
          throw new Error('视频生成超时');
        }

        db.prepare(`UPDATE generations SET result = ?, status = 'success',
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({
            video_url: videoUrl,
            duration,
            ratio,
            mode,
            thumbnail_url: ''
          }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost
        });
      } catch (err) {
        console.error('API视频生成失败:', err);
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/video-gen', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '视频生成任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/video-gen', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 15. GIF表情包生成 ==========
router.post('/generate/gif', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'gif';

  try {
    const { model_id, prompt, mode = 'text', ref_image = '', duration = 3, ratio = '1:1' } = req.body;

    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!prompt || !prompt.trim()) return v1Error(res, '请输入描述内容');

    const model = aiAdapter.getEnabledModels('video').find(m => m.id === parseInt(model_id));
    if (!model) return v1Error(res, '视频模型不存在或未启用');

    const hasImage = Array.isArray(ref_image)
      ? ref_image.length > 0 && ref_image.some(img => img && img.trim() !== '')
      : ref_image && ref_image.trim() !== '';

    if ((mode === 'image_firstframe' || mode === 'image_reference') && !hasImage) {
      return v1Error(res, '请上传图片');
    }
    if (!['text', 'image', 'image_firstframe', 'image_reference'].includes(mode)) {
      return v1Error(res, '不支持的生成模式');
    }
    const modelLower = (model.name || '').toLowerCase();
    if (mode === 'image_reference' && modelLower.includes('veo')) {
      return v1Error(res, 'Veo 模型不支持参考图模式，请使用首帧图生视频模式');
    }
    if (mode === 'image_firstframe' && (modelLower.includes('seedance') || modelLower.includes('dance'))) {
      return v1Error(res, '该跳舞模型不支持首帧模式，请使用参考图生视频模式');
    }

    const cost = aiAdapter.calculateCost(model_id, { duration: parseInt(duration) || 3 });
    if (cost === null) return v1Error(res, '无法计算价格');

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', 'API-GIF表情包生成'
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/gif', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg || '积分不足', 402);
    }

    const result = db.prepare(`INSERT INTO generations
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'gif', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);
    const taskId = result.lastInsertRowid;

    setImmediate(async () => {
      try {
        const path = require('path');
        const fs = require('fs');

        // veo只支持16:9/9:16，选1:1时先生成9:16竖屏，转GIF时再裁成正方形
        const videoRatio = ratio === '1:1' ? '9:16' : ratio;
        const submitResult = await aiAdapter.submitVideoTask(model_id, prompt, {
          duration,
          ratio: videoRatio,
          ref_image: mode === 'text' ? '' : ref_image,
          mode,
        });

        const videoTaskId = submitResult.task_id;

        // 轮询视频生成
        const maxWait = 15 * 60 * 1000;
        const pollStart = Date.now();
        let videoUrl = '';

        while (Date.now() - pollStart < maxWait) {
          const status = await aiAdapter.getVideoTaskStatus(model_id, videoTaskId);
          if (status.status === 'succeeded') {
            videoUrl = status.video_url || '';
            break;
          }
          if (status.status === 'failed') {
            throw new Error(status.error_msg || '视频生成失败');
          }
          await new Promise(r => setTimeout(r, 5000));
        }

        if (!videoUrl) throw new Error('视频生成超时');

        // 下载视频 → ffmpeg转GIF
        const tmpDir = path.join(__dirname, '../tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const https = require('https');
        const http = require('http');
        const vidFileName = 'gif_vid_' + taskId + '_' + Date.now() + '.mp4';
        const vidPath = path.join(tmpDir, vidFileName);
        const file = fs.createWriteStream(vidPath);
        const dlModule = videoUrl.startsWith('https') ? https : http;
        await new Promise((resolve, reject) => {
          dlModule.get(videoUrl, response => {
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
          }).on('error', reject);
        });

        // ffmpeg转GIF
        const gifFileName = 'gif_' + taskId + '_' + Date.now() + '.gif';
        const gifDir = path.join(__dirname, '../public/uploads/gif');
        if (!fs.existsSync(gifDir)) fs.mkdirSync(gifDir, { recursive: true });
        const gifPath = path.join(gifDir, gifFileName);

        const { execSync } = require('child_process');
        // 1:1比例时裁成正方形
        let filterStr = 'fps=12,scale=320:-1:flags=lanczos';
        if (ratio === '1:1') {
          filterStr = 'fps=12,scale=320:-1:flags=lanczos,crop=320:320';
        }
        execSync(`ffmpeg -i "${vidPath}" -vf "${filterStr}" -loop 0 "${gifPath}" -y`, { stdio: 'pipe' });

        const gifUrl = '/uploads/gif/' + gifFileName;

        // 清理临时视频文件
        try { fs.unlinkSync(vidPath); } catch (e) {}

        db.prepare(`UPDATE generations SET result = ?, status = 'success',
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({
            gif_url: gifUrl,
            video_url: videoUrl,
            duration,
            ratio,
            mode
          }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost
        });
      } catch (err) {
        console.error('API GIF生成失败:', err);
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/gif', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, 'GIF生成任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/gif', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 16. AI换脸 ==========
router.post('/generate/face-swap', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  const studioType = 'face-swap';

  try {
    const { model_id, prompt = '', video_url, image_url, duration = 5, ratio = '16:9' } = req.body;

    if (!model_id) return v1Error(res, '请提供 model_id 参数');
    if (!video_url) return v1Error(res, '请上传参考视频');
    if (!image_url) return v1Error(res, '请上传角色参考图');

    const model = aiAdapter.getEnabledModels('video').find(m => m.id === parseInt(model_id));
    if (!model) return v1Error(res, '视频模型不存在或未启用');

    const baseCost = aiAdapter.calculateCost(model_id, { duration: parseInt(duration) || 5 });
    if (baseCost === null) return v1Error(res, '无法计算价格');
    const cost = Math.floor(baseCost * 1.5);

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', 'API-AI换脸'
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/face-swap', studioType, null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg || '积分不足', 402);
    }

    const result = db.prepare(`INSERT INTO generations
      (user_id, studio_type, model_id, params, credits_used, status)
      VALUES (?, 'face-swap', ?, ?, ?, 'pending')`)
      .run(user.id, model_id, JSON.stringify(req.body), cost);
    const taskId = result.lastInsertRowid;

    setImmediate(async () => {
      try {
        const submitResult = await aiAdapter.submitFaceSwapTask(model_id, prompt || '将视频中的人物替换为参考图片中的人物，保持动作和背景不变', {
          duration,
          ratio,
          video_url,
          image_url,
        });

        const faceTaskId = submitResult.task_id;

        // 轮询
        const maxWait = 20 * 60 * 1000;
        const pollStart = Date.now();
        let resultVideoUrl = '';

        while (Date.now() - pollStart < maxWait) {
          const status = await aiAdapter.getVideoTaskStatus(model_id, faceTaskId);
          if (status.status === 'succeeded') {
            resultVideoUrl = status.video_url || '';
            break;
          }
          if (status.status === 'failed') {
            throw new Error(status.error_msg || '换脸生成失败');
          }
          await new Promise(r => setTimeout(r, 5000));
        }

        if (!resultVideoUrl) throw new Error('换脸生成超时');

        db.prepare(`UPDATE generations SET result = ?, status = 'success',
          completed_at = datetime('now','localtime') WHERE id = ?`)
          .run(JSON.stringify({
            video_url: resultVideoUrl,
            image_url,
            source_video_url: video_url,
            duration,
            ratio
          }), taskId);

        triggerWebhook(user.id, 'task.completed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'success',
          credits_used: cost
        });
      } catch (err) {
        console.error('API换脸生成失败:', err);
        creditService.failGenerationAndRefund(taskId, err.message);

        triggerWebhook(user.id, 'task.failed', {
          task_id: taskId,
          studio_type: studioType,
          status: 'failed',
          error_msg: err.message
        });
      }
    });

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/face-swap', studioType, taskId, 'success', cost, Date.now() - startTime);
    v1Success(res, {
      task_id: taskId,
      status: 'processing',
      cost,
      remaining_credits: deductResult.balance
    }, '换脸生成任务已提交');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/face-swap', studioType, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

// ========== 11. 任务状态查询 ==========
router.get('/task/:taskId', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const taskId = req.params.taskId;
    const task = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').get(taskId, user.id);

    if (!task) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/task/:id', null, taskId, 'failed', 0, Date.now() - startTime, '任务不存在');
      return v1Error(res, '任务不存在', 404);
    }

    let result = null;
    try {
      result = task.result ? JSON.parse(task.result) : null;
    } catch (e) { result = null; }

    recordUsage(user.id, req.apiKeyId, '/api/v1/task/:id', task.studio_type, taskId, 'success', 0, Date.now() - startTime);
    v1Success(res, {
      task_id: task.id,
      studio_type: task.studio_type,
      status: task.status,
      result,
      credits_used: task.credits_used,
      error_msg: task.error_msg || null,
      created_at: task.created_at,
      completed_at: task.completed_at
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/task/:id', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '查询失败：' + err.message);
  }
});

// ========== 12. 批量任务查询（v1.1新增） ==========
router.post('/tasks/batch', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const { task_ids } = req.body;
    if (!task_ids || !Array.isArray(task_ids) || task_ids.length === 0) {
      return v1Error(res, '请提供 task_ids 数组参数');
    }
    if (task_ids.length > 50) {
      return v1Error(res, '批量查询最多支持50个任务ID');
    }

    const placeholders = task_ids.map(() => '?').join(',');
    const tasks = db.prepare(`
      SELECT * FROM generations 
      WHERE id IN (${placeholders}) AND user_id = ?
    `).all(...task_ids, user.id);

    const taskMap = {};
    tasks.forEach(task => {
      let result = null;
      try { result = task.result ? JSON.parse(task.result) : null; } catch (e) {}
      taskMap[task.id] = {
        task_id: task.id,
        studio_type: task.studio_type,
        status: task.status,
        result,
        credits_used: task.credits_used,
        error_msg: task.error_msg || null,
        created_at: task.created_at,
        completed_at: task.completed_at
      };
    });

    // 按输入顺序返回，不存在的返回null
    const results = task_ids.map(id => taskMap[id] || null);

    recordUsage(user.id, req.apiKeyId, '/api/v1/tasks/batch', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, { tasks: results, total: results.filter(t => t !== null).length });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/tasks/batch', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '查询失败：' + err.message);
  }
});

// ========== 13. 任务列表查询（v1.1新增） ==========
router.get('/tasks', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const page_size = Math.min(100, Math.max(1, parseInt(req.query.page_size) || 20));
    const studio_type = req.query.studio_type || '';
    const status = req.query.status || '';
    const offset = (page - 1) * page_size;

    let whereSql = 'WHERE user_id = ?';
    let params = [user.id];

    if (studio_type) {
      whereSql += ' AND studio_type = ?';
      params.push(studio_type);
    }
    if (status) {
      whereSql += ' AND status = ?';
      params.push(status);
    }

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM generations ${whereSql}`).get(...params).cnt;
    const tasks = db.prepare(`
      SELECT id, studio_type, model_id, status, credits_used, error_msg, created_at, completed_at
      FROM generations ${whereSql}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(...params, page_size, offset);

    recordUsage(user.id, req.apiKeyId, '/api/v1/tasks', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, {
      tasks: tasks.map(t => ({
        task_id: t.id,
        studio_type: t.studio_type,
        model_id: t.model_id,
        status: t.status,
        credits_used: t.credits_used,
        error_msg: t.error_msg || null,
        created_at: t.created_at,
        completed_at: t.completed_at
      })),
      total,
      page,
      page_size
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/tasks', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '查询失败：' + err.message);
  }
});

// ========== 14. 余额查询（v1.1新增） ==========
router.get('/balance', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const userInfo = db.prepare('SELECT credits, username FROM users WHERE id = ?').get(user.id);

    recordUsage(user.id, req.apiKeyId, '/api/v1/balance', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, {
      credits: userInfo.credits,
      username: userInfo.username
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/balance', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '查询失败：' + err.message);
  }
});

// ========== 15. 模型列表查询（v1.1新增） ==========
router.get('/models', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const type = req.query.type || ''; // image / text

    let sql = 'SELECT id, name, type, model_identifier, price_per_call, description, is_default FROM models WHERE status = 1';
    const params = [];
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    sql += ' ORDER BY is_default DESC, id ASC';

    const models = db.prepare(sql).all(...params);

    recordUsage(user.id, req.apiKeyId, '/api/v1/models', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, { models: models.map(m => ({ ...m, price_per_call: m.price_per_call })) });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/models', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '查询失败：' + err.message);
  }
});

// ========== 16. 调用统计（v1.1新增） ==========
router.get('/usage/stats', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const period = req.query.period || '7d'; // today / 7d / 30d / all
    let dateFilter = '';
    if (period === 'today') {
      dateFilter = "AND date(created_at) = date('now','localtime')";
    } else if (period === '7d') {
      dateFilter = "AND date(created_at) >= date('now','localtime','-6 days')";
    } else if (period === '30d') {
      dateFilter = "AND date(created_at) >= date('now','localtime','-29 days')";
    }

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_calls,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_calls,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_calls,
        SUM(cost) as total_cost,
        AVG(response_time) as avg_response_time
      FROM api_usage
      WHERE user_id = ? ${dateFilter}
    `).get(user.id);

    const studioStats = db.prepare(`
      SELECT studio_type, COUNT(*) as calls, SUM(cost) as cost
      FROM api_usage
      WHERE user_id = ? ${dateFilter} AND status = 'success'
      GROUP BY studio_type
      ORDER BY calls DESC
    `).all(user.id);

    recordUsage(user.id, req.apiKeyId, '/api/v1/usage/stats', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, {
      period,
      summary: {
        total_calls: stats.total_calls || 0,
        success_calls: stats.success_calls || 0,
        failed_calls: stats.failed_calls || 0,
        success_rate: stats.total_calls ? Math.round(stats.success_calls / stats.total_calls * 100) / 100 : 0,
        total_cost: stats.total_cost || 0,
        avg_response_time: Math.round(stats.avg_response_time || 0)
      },
      by_studio: studioStats
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/usage/stats', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '查询失败：' + err.message);
  }
});

// ========== 17. Webhook 订阅管理（v1.1新增） ==========

// 获取Webhook订阅列表
router.get('/webhooks', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const subs = db.prepare(`
      SELECT id, webhook_url, event_type, status, created_at, updated_at
      FROM webhook_subscriptions
      WHERE user_id = ?
      ORDER BY id DESC
    `).all(user.id);

    recordUsage(user.id, req.apiKeyId, '/api/v1/webhooks', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, { webhooks: subs.map(s => ({ ...s, secret: undefined })) });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/webhooks', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '查询失败：' + err.message);
  }
});

// 创建Webhook订阅
router.post('/webhooks', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const { webhook_url, event_type = 'task.completed,task.failed', secret = '' } = req.body;
    let normalizedWebhookUrl;
    try {
      normalizedWebhookUrl = await validatePublicUrl(webhook_url);
    } catch (err) {
      return v1Error(res, '请提供可公开访问的 HTTP/HTTPS webhook_url');
    }

    // 检查是否已存在相同URL的订阅
    const existing = db.prepare('SELECT id FROM webhook_subscriptions WHERE user_id = ? AND webhook_url = ?').get(user.id, normalizedWebhookUrl);
    if (existing) {
      return v1Error(res, '该Webhook URL已存在订阅');
    }

    const result = db.prepare(`
      INSERT INTO webhook_subscriptions (user_id, webhook_url, event_type, secret, status)
      VALUES (?, ?, ?, ?, 1)
    `).run(user.id, normalizedWebhookUrl, event_type, secret);

    recordUsage(user.id, req.apiKeyId, '/api/v1/webhooks/create', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, {
      id: result.lastInsertRowid,
      webhook_url: normalizedWebhookUrl,
      event_type,
      status: 1
    }, 'Webhook订阅创建成功');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/webhooks/create', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '创建失败：' + err.message);
  }
});

// 更新Webhook订阅
router.put('/webhooks/:id', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const subId = req.params.id;
    const sub = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ? AND user_id = ?').get(subId, user.id);
    if (!sub) return v1Error(res, 'Webhook订阅不存在', 404);

    const { webhook_url, event_type, secret, status } = req.body;
    const updates = [];
    const params = [];

    if (webhook_url !== undefined) {
      let normalizedWebhookUrl;
      try {
        normalizedWebhookUrl = await validatePublicUrl(webhook_url);
      } catch (err) {
        return v1Error(res, '请提供可公开访问的 HTTP/HTTPS webhook_url');
      }
      updates.push('webhook_url = ?');
      params.push(normalizedWebhookUrl);
    }
    if (event_type !== undefined) { updates.push('event_type = ?'); params.push(event_type); }
    if (secret !== undefined) { updates.push('secret = ?'); params.push(secret); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    updates.push("updated_at = datetime('now','localtime')");

    params.push(subId, user.id);
    db.prepare(`UPDATE webhook_subscriptions SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);

    recordUsage(user.id, req.apiKeyId, '/api/v1/webhooks/update', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, { id: subId }, '更新成功');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/webhooks/update', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '更新失败：' + err.message);
  }
});

// 删除Webhook订阅
router.delete('/webhooks/:id', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;

  try {
    const subId = req.params.id;
    const result = db.prepare('DELETE FROM webhook_subscriptions WHERE id = ? AND user_id = ?').run(subId, user.id);
    if (result.changes === 0) return v1Error(res, 'Webhook订阅不存在', 404);

    recordUsage(user.id, req.apiKeyId, '/api/v1/webhooks/delete', null, null, 'success', 0, Date.now() - startTime);
    v1Success(res, null, '删除成功');

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/webhooks/delete', null, null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '删除失败：' + err.message);
  }
});


// ========== 17. 文本生成（v1.2新增） ==========
router.post('/generate/text', async (req, res) => {
  const startTime = Date.now();
  const user = req.apiUser;
  let cost = 0;

  try {
    const { model_id, messages, temperature, max_tokens } = req.body;

    if (!model_id) return v1Error(res, '缺少 model_id 参数');
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return v1Error(res, 'messages 不能为空，且必须是数组格式');
    }

    const model = aiAdapter.getEnabledModels('text').find(m => m.id === parseInt(model_id));
    if (!model) return v1Error(res, '模型不存在或已禁用');

    const pricePer1k = model.price_per_1k_tokens != null ? model.price_per_1k_tokens : 10;

    const genResult = await aiAdapter.generateText(parseInt(model_id), messages, {
      temperature: temperature,
      max_tokens: max_tokens || 2000,
    });

    const usage = genResult.raw?.usage || {};
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || (promptTokens + completionTokens);

    cost = Math.max(1, Math.ceil((totalTokens / 1000) * pricePer1k * 100) / 100);

    const deductResult = creditService.deductCredits(
      user.id, cost, 'consume', 'API文本生成：' + model.name
    );
    if (!deductResult.success) {
      recordUsage(user.id, req.apiKeyId, '/api/v1/generate/text', 'text', null, 'failed', 0, Date.now() - startTime, deductResult.msg);
      return v1Error(res, deductResult.msg, 402);
    }

    const taskId = Date.now() + Math.random().toString(36).slice(2, 8);

    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/text', 'text', taskId, 'success', cost, Date.now() - startTime);

    v1Success(res, {
      task_id: taskId,
      model: model.model_identifier,
      content: genResult.text,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      cost: cost,
      price_per_1k: pricePer1k,
      remaining_credits: deductResult.balance,
    });

  } catch (err) {
    recordUsage(user.id, req.apiKeyId, '/api/v1/generate/text', 'text', null, 'failed', 0, Date.now() - startTime, err.message);
    v1Error(res, '生成失败：' + err.message);
  }
});

module.exports = router;
