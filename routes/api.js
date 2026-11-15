const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../database/db');

const { authRequired, authOptional } = require('../middleware/auth');
const aiAdapter = require('../controllers/aiAdapter');
const creditService = require('../controllers/creditService');
const { extractVideoFrames } = require('../utils/videoFrameExtract');
const { safeRequest } = require('../utils/safeHttp');
const { parseIntegerParam } = require('../utils/requestParams');

const router = express.Router();

function refundFailedGeneration(taskId, errorMessage) {
  if (taskId === null || taskId === undefined) return;
  try {
    creditService.failGenerationAndRefund(taskId, errorMessage);
  } catch (refundError) {
    console.error(`任务 ${taskId} 失败退款异常:`, refundError.message);
  }
}

function parseGenerationResult(result) {
  if (!result) return {};
  try {
    return JSON.parse(result);
  } catch (err) {
    return {};
  }
}

function getPublicGenerationTask(publicId, userId, studioType) {
  return db.prepare(`SELECT generation_jobs.public_id, generation_jobs.status AS job_status,
      generation_jobs.phase, generation_jobs.progress, generation_jobs.last_error,
      generations.id AS generation_id, generations.status, generations.result, generations.error_msg
    FROM generation_jobs
    JOIN generations ON generations.id = generation_jobs.generation_id
    WHERE generation_jobs.public_id = ? AND generations.user_id = ? AND generations.studio_type = ?`)
    .get(publicId, userId, studioType);
}

function mapPublicTaskStatus(task) {
  if (task.status === 'success' || task.job_status === 'succeeded') return 'success';
  if (task.status === 'failed' || task.job_status === 'failed') return 'failed';
  if (task.phase === 'converting') return 'converting';
  if (task.job_status === 'processing' || task.job_status === 'retry') return 'generating';
  return 'submitting';
}

// 获取站点配置 (不需要登录)
router.get('/config', authOptional, (req, res) => {
  const { getSetting } = require('../database/db');
  
  const imageModels = aiAdapter.getEnabledModels('image');
  const textModels = aiAdapter.getEnabledModels('text');
  
  res.success({
    site_name: getSetting('site_name', 'AI工作室'),
    register_bonus: parseInt(getSetting('register_bonus_credits', '100')),
    enable_register: getSetting('enable_register', '1') === '1',
    image_models: imageModels,
    text_models: textModels,
    user: req.user ? {
      id: req.user.id,
      username: req.user.username,
      credits: req.user.credits,
      is_admin: req.user.is_admin,
    } : null,
  });
});

// 获取模型列表
router.get('/models', (req, res) => {
  const type = req.query.type || null;
  const models = aiAdapter.getEnabledModels(type);
  res.success(models);
});

// 计算生成价格
router.post('/calculate-cost', (req, res) => {
  const { model_id, count, duration } = req.body;
  if (!model_id) return res.error('请选择模型');

  try {
    const actualCount = parseIntegerParam(count, {
      name: '数量', min: 1, max: 20, defaultValue: 1
    });
    const costOptions = duration === undefined
      ? actualCount
      : {
          count: actualCount,
          duration: parseIntegerParam(duration, {
            name: '时长', min: 1, max: 60
          })
        };
    const cost = aiAdapter.calculateCost(model_id, costOptions);
    if (cost === null) return res.error('模型不存在、已禁用或价格配置无效');

    res.success({ cost });
  } catch (err) {
    res.error(err.message);
  }
});

// ============ 生成相关 ============

// 创建生成任务 (图片类 - 电商套图)
router.post('/generate/ecommerce', authRequired, async (req, res) => {
  try {
    const {
      model_id, platform, market, language, text_setting,
      smart_composite, ratio, count, tone, prominence,
      forbidden_elements, avoid_requirements, selling_points,
      image_count, ref_image = ''
    } = req.body;

    if (!model_id) return res.error('请选择生图模型');
    if (!selling_points) return res.error('请填写商品卖点及要求');

    const actualCount = parseIntegerParam(
      image_count === undefined ? count : image_count,
      { name: '图片数量', min: 1, max: 20, defaultValue: 4 }
    );
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    if (!cost) return res.error('模型价格获取失败');

    const prompt = `Generate high quality e-commerce product image for: ${selling_points}.
      Platform: ${platform || 'general'}, Market: ${market || 'global'},
      Style: ${tone || 'neutral'}, Product prominence: ${prominence || 70}%.
      The product should be the main focus in a beautiful scene.`;
    const sizeMap = {
      '1:1': '1024x1024',
      '3:4': '768x1024',
      '16:9': '1024x576',
      '9:16': '576x1024',
      '4:3': '1024x768',
    };
    const options = {
      n: actualCount,
      size: sizeMap[ratio] || '1024x1024',
      negative_prompt: 'text, words, letters, characters, writing, watermark, logo, signature, caption, ugly, distorted, blurry, low quality',
    };
    if (ref_image) options.ref_image = ref_image;

    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'ecommerce',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount, image_count: actualCount }),
      cost,
      `电商套图生成 (${actualCount}张)`,
      {
        type: 'image.generate',
        payload: {
          model_id,
          prompt,
          options,
          deadline_seconds: 900,
          result_style: 'canonical',
          result_metadata: {}
        }
      }
    );

    if (!deductResult.success) return res.error(deductResult.msg, 402);
    res.success({ task_id: deductResult.taskId, cost, new_balance: deductResult.balance }, '任务已提交');
  } catch (err) {
    console.error(err);
    res.error('生成任务提交失败：' + err.message);
  }
});

// 小红书文案生成 (同步)
router.post('/generate/xiaohongshu', authRequired, async (req, res) => {
  let taskId = null;
  try {
    const {
      model_id, note_type, topic, target_audience,
      cover_style, cover_ratio, title_style, tone,
      word_count, tag_count = 3, count = 3
    } = req.body;
    
    if (!model_id) return res.error('请选择文本模型');
    if (!topic) return res.error('请填写笔记主题');
    
    const actualCount = parseIntegerParam(count, {
      name: '版本数量', min: 1, max: 5, defaultValue: 3
    });
    // 扣减积分：每个版本按一次文本模型调用计算
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'xiaohongshu',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount }),
      cost,
      `小红书笔记生成 (${actualCount}篇)`
    );
    
    if (!deductResult.success) {
      return res.error(deductResult.msg, 402);
    }
    taskId = deductResult.taskId;
    
    // 构建提示词
    const audience = Array.isArray(target_audience) ? target_audience.join('、') : (target_audience || '年轻女性');
    const prompt = `请帮我写一篇小红书爆款笔记，主题是：${topic}。
笔记类型：${note_type || '好物分享'}
目标人群：${audience}
文案风格：${tone || '真诚安利'}
标题风格：${title_style || 'emoji风+数字型'}
字数要求：约${word_count || 600}字
标签数量：约${tag_count}个热门话题标签

要求：
1. 标题要有爆款潜质，带emoji
2. 正文口语化，像闺蜜分享一样亲切
3. 分段清晰，多用emoji和符号装饰
4. 结尾要有互动引导
5. 最后列出相关的热门标签（带#号）

请直接输出完整的笔记内容，包括标题和标签。`;

    // 调用模型
    const genResult = await aiAdapter.generateText(model_id, [
      { role: 'user', content: prompt }
    ], { temperature: 0.8, max_tokens: 1500 });
    
    // 生成多版本模拟 (按实际数量返回)
    const allVersions = [
      { title: '版本一 · 真诚安利型', content: genResult.text, tags: ['#好物分享', '#种草推荐'] },
      { title: '版本二 · 干货测评型', content: genResult.text.replace('安利', '测评').replace('好物分享', '真实测评'), tags: ['#真实测评', '#干货分享'] },
      { title: '版本三 · 避坑指南型', content: genResult.text.replace('安利', '避坑'), tags: ['#避坑指南', '#经验分享'] },
      { title: '版本四 · 故事叙述型', content: genResult.text.replace('安利', '分享故事').replace('好物', '神奇'), tags: ['#故事分享', '#真实经历'] },
      { title: '版本五 · 对比测评型', content: genResult.text.replace('安利', '对比').replace('推荐', '测评'), tags: ['#对比测评', '#理性种草'] },
    ];
    const versions = allVersions.slice(0, actualCount);
    
    db.prepare(`UPDATE generations SET result = ?, status = 'success',
      completed_at = datetime('now','localtime') WHERE id = ?`)
      .run(JSON.stringify({ versions, mock: genResult.mock || false }), taskId);
    
    res.success({ task_id: taskId, result: versions, new_balance: deductResult.balance }, '生成成功');
    
  } catch (err) {
    console.error(err);
    refundFailedGeneration(taskId, err.message);
    res.error('生成失败：' + err.message);
  }
});

// 海报生成
router.post('/generate/poster', authRequired, async (req, res) => {
  try {
    const { model_id, poster_type, theme, subtitle, style, color, image_count, count } = req.body;
    
    if (!model_id) return res.error('请选择生图模型');
    if (!theme) return res.error('请填写海报主题');
    
    const actualCount = parseIntegerParam(
      image_count === undefined ? count : image_count,
      { name: '图片数量', min: 1, max: 8, defaultValue: 4 }
    );
    const cost = aiAdapter.calculateCost(model_id, actualCount);

    const styleMap = {
      '简约现代': 'minimalist modern design, clean layout, geometric elements',
      '国潮风': 'Chinese guochao style, traditional Chinese elements blended with modern design, auspicious patterns, ink wash texture, red and gold color accents',
      '赛博朋克': 'cyberpunk style, neon lights, futuristic city, high-tech glow, dark tones with vibrant accents',
      '插画风': 'illustration style, hand-drawn feel, artistic, creative composition, vibrant colors',
      '高端商务': 'premium business style, elegant typography space, sophisticated composition, professional corporate feel',
      '可爱卡通': 'cute cartoon style, playful elements, bright cheerful colors, kawaii aesthetic',
      '复古怀旧': 'vintage retro style, classic typography layout, nostalgic color palette, old poster aesthetic',
      '科技未来': 'tech futuristic style, sleek lines, gradient glows, abstract tech patterns, modern digital feel',
      'ins风': 'Instagram aesthetic, soft tones, minimalist composition, lifestyle photography feel'
    };
    const colorMap = {
      '热情红': 'warm red and orange tones, passionate vibrant palette',
      '科技蓝紫': 'tech blue and purple tones, cool futuristic palette',
      '清新绿': 'fresh green tones, natural eco-friendly palette',
      '活力橙': 'energetic orange tones, warm vibrant palette',
      '魅惑粉紫': 'glamorous pink and purple tones, luxurious feminine palette',
      '高级黑灰': 'premium black and gray tones, sophisticated dark palette'
    };
    const styleEn = styleMap[style] || 'modern professional design';
    const colorEn = colorMap[color] || 'balanced professional color palette';
    
    const prompt = `Professional poster design template, ${styleEn}, ${colorEn}.
Theme: ${theme} — ${poster_type || 'promotional poster'}.
${subtitle ? 'Subtitle area: ' + subtitle : ''}

CRITICAL REQUIREMENTS:
- This is a POSTER DESIGN template, not a photograph or landscape image
- Leave clearly visible EMPTY BLANK SPACES for text: large title area at top, subtitle area, body copy area, and call-to-action area at bottom
- DO NOT write any actual text, words, letters, or Chinese characters on the poster
- Text areas must be clean empty spaces with appropriate background contrast for readability
- Strong visual composition with clear focal point and hierarchy
- High quality graphic design, professional layout, eye-catching visuals
- Appropriate decorative elements and background that match the theme and style`;

    const negativePrompt = 'text, words, letters, characters, writing, watermark, logo, signature, caption, subtitle text, realistic photograph, landscape photo, nature scenery, people portrait, low quality, blurry, distorted, ugly';
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'poster',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount, image_count: actualCount }),
      cost,
      `海报生成 (${actualCount}张)`,
      {
        type: 'image.generate',
        payload: {
          model_id,
          prompt,
          options: {
            n: actualCount,
            size: '768x1024',
            negative_prompt: negativePrompt
          },
          deadline_seconds: 900,
          result_style: 'canonical',
          result_metadata: {}
        }
      }
    );

    if (!deductResult.success) return res.error(deductResult.msg, 402);
    res.success({ task_id: deductResult.taskId, cost, new_balance: deductResult.balance }, '任务已提交');
    
  } catch (err) {
    console.error(err);
    res.error('生成任务提交失败：' + err.message);
  }
});

// AI文案生成
router.post('/generate/copywriting', authRequired, async (req, res) => {
  let taskId = null;
  try {
    const {
      model_id, copy_type, industry, product_name, selling_points,
      target_users, style, tone, perspective, structure, word_count, count = 3
    } = req.body;
    
    if (!model_id) return res.error('请选择文本模型');
    if (!product_name) return res.error('请填写产品/品牌名称');
    
    const actualCount = parseIntegerParam(count, {
      name: '版本数量', min: 1, max: 3, defaultValue: 3
    });
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'copywriting',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount }),
      cost,
      `AI文案生成 (${actualCount}个版本)`
    );
    
    if (!deductResult.success) {
      return res.error(deductResult.msg, 402);
    }
    taskId = deductResult.taskId;
    
    const users = Array.isArray(target_users) ? target_users.join('、') : (target_users || '目标用户');
    const prompt = `请为以下产品撰写${actualCount}个不同风格版本的${copy_type || '产品文案'}：

产品/品牌：${product_name}
所属行业：${industry || '电商零售'}
核心卖点：${selling_points || '优质品质、高性价比'}
目标用户：${users}
文案风格：${style || '专业权威'}
语气视角：${perspective || '第一人称'}
结构类型：${structure || '痛点-解决方案'}
字数要求：约${word_count || 500}字

请输出${actualCount}个不同角度的版本，每个版本有标题和正文内容。
版本差异化要明显，比如：
版本1：情感共鸣型
版本2：理性说服型
版本3：场景代入型

用编号清晰分隔每个版本。`;
    
    // 同步调用
    const genResult = await aiAdapter.generateText(model_id, [
      { role: 'user', content: prompt }
    ], { temperature: 0.75, max_tokens: 2500 });
    
    const versions = [
      { title: '版本一 · 情感共鸣型', content: genResult.text, tags: ['情感共鸣', '品牌温度'] },
      { title: '版本二 · 痛点解决型', content: genResult.text.replace('情感', '理性'), tags: ['痛点解决', '理性说服'] },
      { title: '版本三 · 价值塑造型', content: genResult.text.replace('共鸣', '价值'), tags: ['价值塑造', '高端定位'] },
    ].slice(0, actualCount);
    
    db.prepare(`UPDATE generations SET result = ?, status = 'success',
      completed_at = datetime('now','localtime') WHERE id = ?`)
      .run(JSON.stringify({ versions, mock: genResult.mock || false }), taskId);
    
    res.success({ task_id: taskId, result: versions, new_balance: deductResult.balance }, '生成成功');
    
  } catch (err) {
    console.error(err);
    refundFailedGeneration(taskId, err.message);
    res.error('生成失败：' + err.message);
  }
});

// ==================== PPT生成工作室 ====================
router.post('/generate/ppt', authRequired, async (req, res) => {
  let taskId = null;
  try {
    const {
      model_id, ppt_type, topic, audience, duration,
      key_points, slide_count, style, color_scheme, density, count = 2
    } = req.body;
    
    if (!model_id) return res.error('请选择文本模型');
    if (!topic) return res.error('请填写PPT主题');
    
    const actualCount = parseIntegerParam(count, {
      name: '版本数量', min: 1, max: 3, defaultValue: 2
    });
    const slides = parseIntegerParam(slide_count, {
      name: '页数', min: 3, max: 30, defaultValue: 12
    });
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'ppt',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount, slide_count: slides }),
      cost,
      `PPT生成 (${actualCount}份)`
    );
    
    if (!deductResult.success) {
      return res.error(deductResult.msg, 402);
    }
    taskId = deductResult.taskId;
    
    const audiences = Array.isArray(audience) ? audience.join('、') : (audience || '目标受众');
    const prompt = `请为以下主题设计${actualCount}个不同风格的PPT大纲：

PPT类型：${ppt_type || '工作汇报'}
PPT主题：${topic}
目标受众：${audiences}
演讲时长：${duration || '10分钟'}
核心要点：${key_points || '围绕主题展开'}
预计页数：约${slides}页
设计风格：${style || '商务简约'}
主色调：${color_scheme || '蓝色系'}
排版密度：${density || '适中'}

请输出${actualCount}个版本的完整PPT大纲，每个版本包含：
- 封面页（标题+副标题+演讲者）
- 目录页（章节列表）
- 内容页（每页有标题+3-5个要点+页面说明）
- 结尾页（总结/Q&A/致谢）

要求：
- 逻辑清晰，结构完整
- 每个版本的结构和角度要有明显差异
- 每页要点简洁精炼，适合PPT展示
- 页数控制在${Math.max(5, slides - 2)}~${slides + 2}页之间

用编号清晰分隔每个版本，每个版本内用"第X页"标注页码。`;
    
    const genResult = await aiAdapter.generateText(model_id, [
      { role: 'user', content: prompt }
    ], { temperature: 0.75, max_tokens: 4000 });
    
    const baseContent = genResult.text;
    const versions = [
      { title: '版本一 · 经典结构型', content: baseContent, slides: slides },
      { title: '版本二 · 故事叙述型', content: baseContent + '\n\n---\n\n【故事叙述版】以用户故事为主线，将核心观点融入叙事中，更具感染力。', slides: slides },
      { title: '版本三 · 数据驱动型', content: baseContent + '\n\n---\n\n【数据驱动版】以数据和案例为支撑，每个论点都有事实依据，更具说服力。', slides: slides },
    ].slice(0, actualCount);
    
    db.prepare(`UPDATE generations SET result = ?, status = 'success',
      completed_at = datetime('now','localtime') WHERE id = ?`)
      .run(JSON.stringify({ versions, mock: genResult.mock || false }), taskId);
    
    res.success({ task_id: taskId, result: versions, new_balance: deductResult.balance }, '生成成功');
    
  } catch (err) {
    console.error(err);
    refundFailedGeneration(taskId, err.message);
    res.error('生成失败：' + err.message);
  }
});

// ==================== 短视频脚本工作室 ====================
router.post('/generate/video', authRequired, async (req, res) => {
  let taskId = null;
  try {
    const {
      model_id, video_type, topic, platforms, duration,
      key_points, content_style, structure, characters,
      scene, bgm_style, count = 2
    } = req.body;
    
    if (!model_id) return res.error('请选择文本模型');
    if (!topic) return res.error('请填写视频主题');
    
    const actualCount = parseIntegerParam(count, {
      name: '版本数量', min: 1, max: 3, defaultValue: 2
    });
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'video',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount }),
      cost,
      `短视频脚本生成 (${actualCount}份)`
    );
    
    if (!deductResult.success) {
      return res.error(deductResult.msg, 402);
    }
    taskId = deductResult.taskId;
    
    const platformsStr = Array.isArray(platforms) ? platforms.join('、') : (platforms || '抖音');
    const charsStr = Array.isArray(characters) ? characters.join('、') : (characters || '主角');
    const prompt = `请为以下主题创作${actualCount}个不同风格的短视频脚本：

视频类型：${video_type || '产品种草'}
视频主题：${topic}
发布平台：${platformsStr}
视频时长：${duration || '60秒'}
核心卖点：${key_points || '产品优质好用'}
内容风格：${content_style || '搞笑幽默'}
脚本结构：${structure || '黄金3秒钩子'}
人物角色：${charsStr}
场景：${scene || '室内场景'}
BGM风格：${bgm_style || '轻快活泼'}

请输出${actualCount}个版本的完整脚本，每个版本包含：
1. 视频标题（3个备选标题，要有爆款潜质）
2. 分镜表（包含：镜号、时长、画面描述、台词/旁白、运镜方式）
3. 完整口播文案
4. 热门标签推荐（8-12个，带#号）

要求：
- 开头3秒必须有钩子，抓住用户注意力
- 节奏紧凑，符合短视频观看习惯
- 每个版本的创意角度要有明显差异
- 台词口语化，自然不生硬

用编号清晰分隔每个版本。`;
    
    const genResult = await aiAdapter.generateText(model_id, [
      { role: 'user', content: prompt }
    ], { temperature: 0.85, max_tokens: 4000 });
    
    const baseContent = genResult.text;
    const versions = [
      { title: '版本一 · 情绪共鸣型', content: baseContent, tags: ['#短视频脚本', '#爆款视频'] },
      { title: '版本二 · 干货输出型', content: baseContent.replace('情绪', '干货'), tags: ['#知识分享', '#干货视频'] },
      { title: '版本三 · 剧情反转型', content: baseContent.replace('共鸣', '反转'), tags: ['#剧情视频', '#反转'] },
    ].slice(0, actualCount);
    
    db.prepare(`UPDATE generations SET result = ?, status = 'success',
      completed_at = datetime('now','localtime') WHERE id = ?`)
      .run(JSON.stringify({ versions, mock: genResult.mock || false }), taskId);
    
    res.success({ task_id: taskId, result: versions, new_balance: deductResult.balance }, '生成成功');
    
  } catch (err) {
    console.error(err);
    refundFailedGeneration(taskId, err.message);
    res.error('生成失败：' + err.message);
  }
});

// ==================== 简历优化工作室 ====================
router.post('/generate/resume', authRequired, async (req, res) => {
  let taskId = null;
  try {
    const {
      model_id, target_position, experience_years, company_type,
      education, work_experience, projects, skills,
      optimize_goal, language, count = 2
    } = req.body;
    
    if (!model_id) return res.error('请选择文本模型');
    if (!target_position) return res.error('请填写求职岗位');
    if (!work_experience) return res.error('请填写工作经历');
    
    const actualCount = parseIntegerParam(count, {
      name: '版本数量', min: 1, max: 3, defaultValue: 2
    });
    const cost = aiAdapter.calculateCost(model_id, actualCount);
    
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'resume',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount }),
      cost,
      `简历优化 (${actualCount}份)`
    );
    
    if (!deductResult.success) {
      return res.error(deductResult.msg, 402);
    }
    taskId = deductResult.taskId;
    
    const skillsStr = Array.isArray(skills) ? skills.join('、') : (skills || '专业技能');
    const prompt = `请根据以下信息，为求职者优化${actualCount}个版本的简历内容：

求职岗位：${target_position}
工作年限：${experience_years || '3-5年'}
目标公司类型：${company_type || '不限'}
教育背景：${education || '本科'}
工作经历：${work_experience}
项目经历：${projects || '详见工作经历'}
技能特长：${skillsStr}
优化方向：${optimize_goal || '突出成果'}
简历语言：${language || '中文'}

请输出${actualCount}个版本的优化后简历，每个版本包含：
1. 个人简介/自我评价（3-5句话，突出核心竞争力）
2. 工作经历优化版（用STAR法则重写，量化成果，每个经历3-5个亮点）
3. 项目经历优化版（突出项目价值和个人贡献）
4. 技能标签梳理（按专业技能/软技能/工具分类）
5. 投递建议（针对目标岗位的简历优化建议）

要求：
- 每个版本的侧重点不同：一个偏成果导向、一个偏能力展示、一个偏潜力塑造
- 用数据和事实说话，避免空泛描述
- 语言专业精炼，符合简历规范
- 关键词优化，适配ATS系统

用编号清晰分隔每个版本。`;
    
    const genResult = await aiAdapter.generateText(model_id, [
      { role: 'user', content: prompt }
    ], { temperature: 0.7, max_tokens: 4000 });
    
    const baseContent = genResult.text;
    const versions = [
      { title: '版本一 · 成果导向型', content: baseContent, tags: ['简历优化', '突出成果'] },
      { title: '版本二 · 能力展示型', content: baseContent.replace('成果', '能力'), tags: ['能力展示', '专业塑造'] },
      { title: '版本三 · 潜力塑造型', content: baseContent.replace('成果', '潜力'), tags: ['潜力塑造', '成长型'] },
    ].slice(0, actualCount);
    
    db.prepare(`UPDATE generations SET result = ?, status = 'success',
      completed_at = datetime('now','localtime') WHERE id = ?`)
      .run(JSON.stringify({ versions, mock: genResult.mock || false }), taskId);
    
    res.success({ task_id: taskId, result: versions, new_balance: deductResult.balance }, '生成成功');
    
  } catch (err) {
    console.error(err);
    refundFailedGeneration(taskId, err.message);
    res.error('生成失败：' + err.message);
  }
});

// ==================== AI头像工作室 ====================
router.post('/generate/avatar', authRequired, async (req, res) => {
  try {
    const {
      model_id, avatar_style, gender, age_range,
      hairstyle, expression, clothing, background,
      size, resolution, count, image_count, ref_images = []
    } = req.body;
    
    if (!model_id) return res.error('请选择生图模型');
    if (!avatar_style) return res.error('请选择头像风格');
    
    const actualCount = parseIntegerParam(
      image_count === undefined ? count : image_count,
      { name: '图片数量', min: 1, max: 20, defaultValue: 4 }
    );
    const cost = aiAdapter.calculateCost(model_id, actualCount);

    // 风格描述映射
    const stylePrompts = {
      '证件照': 'ID photo, passport photo style, formal portrait, plain solid background, professional lighting, front facing, neutral expression',
      '职业形象照': 'professional business portrait, corporate headshot, formal attire, office background, professional lighting, confident expression',
      '动漫风': 'anime style portrait, anime aesthetic, cel shading, vibrant colors, detailed eyes, manga art style',
      '油画风': 'oil painting style portrait, classical oil painting texture, brush strokes, fine art, renaissance style lighting',
      '复古胶片': 'vintage film photo, retro film aesthetic, film grain, warm tones, analog photography, 90s style',
      '赛博朋克': 'cyberpunk style portrait, neon lights, futuristic, high tech, glowing accents, dark background with vibrant colors',
      '国潮': 'Chinese guochao style, traditional Chinese elements, modern fashion fusion, oriental aesthetics, red and gold accents',
      'ins风': 'Instagram aesthetic portrait, soft natural lighting, lifestyle photography, clean minimalist, warm tones'
    };
    
    const styleEn = stylePrompts[avatar_style] || 'professional portrait photo';
    const genderEn = gender === '男' ? 'male' : (gender === '女' ? 'female' : 'androgynous');
    
    const sizeMap = {
      '1:1方图': '1024x1024',
      '3:4竖版': '768x1024',
      '证件照标准(413x591)': '768x1024',
      '自定义': '1024x1024'
    };
    const genSize = sizeMap[size] || '1024x1024';
    
    const prompt = `${styleEn}, ${genderEn} portrait, high quality, detailed face, ${hairstyle ? hairstyle + ' hair, ' : ''}${expression ? expression + ' expression, ' : ''}${clothing ? 'wearing ' + clothing + ', ' : ''}${background ? background + ' background, ' : ''}beautiful composition, professional lighting, sharp focus, ultra detailed`;
    
    const negativePrompt = 'ugly, deformed, blurry, low quality, distorted face, extra fingers, bad anatomy, text, watermark, logo, signature';
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'avatar',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount, image_count: actualCount }),
      cost,
      `AI头像生成 (${actualCount}张)`,
      {
        type: 'image.generate',
        payload: {
          model_id,
          prompt,
          options: {
            n: actualCount,
            size: genSize,
            negative_prompt: negativePrompt,
            ...(Array.isArray(ref_images) && ref_images.length > 0 ? { ref_image: ref_images } : {})
          },
          deadline_seconds: 900,
          result_style: 'canonical',
          result_metadata: {}
        }
      }
    );

    if (!deductResult.success) return res.error(deductResult.msg, 402);
    res.success({ task_id: deductResult.taskId, cost, new_balance: deductResult.balance }, '任务已提交');
    
  } catch (err) {
    console.error(err);
    res.error('生成任务提交失败：' + err.message);
  }
});

// AI图片生成工作室（文生图）
// 音频合成生成接口
router.post('/generate/audio', authRequired, async (req, res) => {
  try {
    const { model_id, input_text, response_format = 'wav' } = req.body;

    if (!model_id) return res.error('请选择音频模型');
    if (!input_text || !input_text.trim()) return res.error('请输入要合成的文本');

    const text = input_text.trim();
    if (text.length > 5000) return res.error('文本过长，最多支持5000字');

    const cost = aiAdapter.calculateCost(model_id, 1);

    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'audio',
      model_id,
      JSON.stringify(req.body),
      cost,
      'AI音频合成',
      {
        type: 'audio.generate',
        payload: {
          model_id,
          input_text: text,
          options: {
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
            use_random: req.body.use_random
          },
          deadline_seconds: 900,
          result_style: 'canonical',
          result_metadata: {}
        }
      }
    );

    if (!deductResult.success) return res.error(deductResult.msg, 402);
    res.success({ task_id: deductResult.taskId, cost, new_balance: deductResult.balance }, '任务已提交');

  } catch (err) {
    console.error(err);
    res.error('生成任务提交失败：' + err.message);
  }
});

router.post('/generate/image', authRequired, async (req, res) => {
  try {
    const {
      model_id, prompt, negative_prompt = '',
      size = '1:1', quality = '1K', count = 1, style = ''
    } = req.body;

    if (!model_id) return res.error('请选择生图模型');
    if (!prompt || !prompt.trim()) return res.error('请输入图片描述');

    const actualCount = parseIntegerParam(count, {
      name: '图片数量', min: 1, max: 9, defaultValue: 1
    });
    const cost = aiAdapter.calculateCost(model_id, actualCount);

    const qualityBase = {
      '1K': 1024,
      '2K': 2048,
      '4K': 4096,
    };
    const base = qualityBase[quality] || 1024;
    const ratioMap = {
      '1:1': [1, 1],
      '16:9': [16, 9],
      '9:16': [9, 16],
      '3:4': [3, 4],
      '4:3': [4, 3],
    };
    const ratio = ratioMap[size] || [1, 1];
    // 以基准边为基准，按比例计算另一边（取整到最接近的8的倍数，AI生图常见要求）
    let w, h;
    if (ratio[0] >= ratio[1]) {
      w = base;
      h = Math.round(base * ratio[1] / ratio[0] / 8) * 8;
    } else {
      h = base;
      w = Math.round(base * ratio[0] / ratio[1] / 8) * 8;
    }
    const genSize = `${w}x${h}`;

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
    const defaultNeg = 'ugly, deformed, blurry, low quality, bad anatomy, text, watermark, logo, signature';
    const finalNeg = negative_prompt ? `${defaultNeg}, ${negative_prompt}` : defaultNeg;
    const options = {
      n: actualCount,
      size: genSize,
      negative_prompt: finalNeg
    };
    if (req.body.ref_image) options.ref_image = req.body.ref_image;

    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'image',
      model_id,
      JSON.stringify({ ...req.body, count: actualCount }),
      cost,
      `AI图片生成 (${actualCount}张)`,
      {
        type: 'image.generate',
        payload: {
          model_id,
          prompt: finalPrompt,
          options,
          deadline_seconds: 900,
          result_style: 'canonical',
          result_metadata: {}
        }
      }
    );

    if (!deductResult.success) return res.error(deductResult.msg, 402);
    res.success({ task_id: deductResult.taskId, cost, new_balance: deductResult.balance }, '任务已提交');

  } catch (err) {
    console.error(err);
    res.error('生成任务提交失败：' + err.message);
  }
});

// 查询生成任务状态 (用于异步图片类)
router.get('/generation/:id', authRequired, (req, res) => {
  const taskId = req.params.id;
  const gen = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').get(taskId, req.user.id);
  
  if (!gen) {
    return res.error('任务不存在');
  }
  
  if (gen.result) {
    try { gen.result = JSON.parse(gen.result); } catch (e) {}
  }
  if (gen.params) {
    try { gen.params = JSON.parse(gen.params); } catch (e) {}
  }
  
  res.success(gen);
});

// 用户生成记录列表（我的作品）
router.get('/user/generations', authRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const offset = (page - 1) * pageSize;
  const studioType = req.query.studio_type || '';

  let whereSql = 'WHERE user_id = ?';
  const params = [req.user.id];
  if (studioType) {
    whereSql += ' AND studio_type = ?';
    params.push(studioType);
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM generations ${whereSql}`).get(...params).cnt;
  const rows = db.prepare(`SELECT id, studio_type, model_id, status, credits_used, error_msg, result, created_at, completed_at
    FROM generations ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);

  // 解析结果，只返回缩略图/预览文本，避免数据过大
  const list = rows.map(item => {
    let preview = null;
    if (item.result) {
      try {
        const parsed = JSON.parse(item.result);
        if (parsed.images && parsed.images.length > 0) {
          preview = { type: 'image', url: parsed.images[0], count: parsed.images.length };
        } else if (parsed.versions && parsed.versions.length > 0) {
          preview = { type: 'text', title: parsed.versions[0].title || (parsed.versions[0].content || '').substring(0, 30), count: parsed.versions.length };
        } else if (parsed.notes && parsed.notes.length > 0) {
          preview = { type: 'text', title: parsed.notes[0].title || parsed.notes[0].content?.substring(0, 30), count: parsed.notes.length };
        } else if (parsed.posters && parsed.posters.length > 0) {
          preview = { type: 'image', url: parsed.posters[0].image || parsed.posters[0], count: parsed.posters.length };
        } else if (parsed.copies && parsed.copies.length > 0) {
          preview = { type: 'text', title: parsed.copies[0].title || parsed.copies[0].content?.substring(0, 30), count: parsed.copies.length };
        } else if (parsed.audio_url) {
          preview = { type: 'audio', url: parsed.audio_url, file_name: parsed.file_name, format: parsed.format, size: parsed.size };
        }
      } catch (e) {}
    }
    return {
      id: item.id,
      studio_type: item.studio_type,
      model_id: item.model_id,
      status: item.status,
      credits_used: item.credits_used,
      error_msg: item.error_msg,
      preview,
      created_at: item.created_at,
      completed_at: item.completed_at,
    };
  });

  res.success({ list, total, page, pageSize });
});

// 首页全局搜索 (工作室 + 未登录也能用)
router.get('/search/all', (req, res) => {
  const keyword = (req.query.keyword || '').trim().toLowerCase();
  if (!keyword) return res.success({ studios: [] });

  const allStudios = [
    { type: 'workflow', name: '电商工作流', icon: '⚡', category: '电商', desc: '上传商品图，抠图、场景、主图、详情页节点式跑完', tags: '电商 套图 主图 详情页 工作流 节点 白底 抠图 复刻 模特 试穿' },
    { type: 'ecommerce', name: '电商套图工作室', icon: '🏪', category: '电商', desc: '一键生成商品主图、场景图、推广图', tags: '电商 套图 主图 详情页 商品' },
    { type: 'xiaohongshu', name: '小红书爆款笔记工作室', icon: '📕', category: '社媒', desc: '爆款封面 + 种草文案 + 热门标签', tags: '小红书 笔记 种草 封面 爆款' },
    { type: 'poster', name: '海报工厂工作室', icon: '🎨', category: '设计', desc: '活动海报、节日海报、产品海报', tags: '海报 设计 宣传 活动 节日' },
    { type: 'copywriting', name: 'AI文案工作室', icon: '✍️', category: '文案', desc: '产品文案、品牌文案、广告语', tags: '文案 广告 品牌 产品 标题' },
    { type: 'ppt', name: 'PPT生成工作室', icon: '📊', category: '办公', desc: '输入主题自动生成精美PPT大纲', tags: 'ppt 幻灯片 演示 汇报 办公' },
    { type: 'video', name: '短视频脚本工作室', icon: '🎬', category: '社媒', desc: 'AI生成短视频分镜脚本+口播文案', tags: '短视频 脚本 分镜 口播 抖音' },
    { type: 'video-gen', name: 'AI视频生成工作室', icon: '🎥', category: '社媒', desc: '文生视频 + 图生视频，一键生成短视频', tags: '视频 文生视频 图生视频 短视频 抖音' },
    { type: 'gif', name: 'GIF表情包工作室', icon: '🎞️', category: '社媒', desc: '文生GIF + 图生GIF，专属动态表情包', tags: 'gif 表情包 动态 动图' },
    { type: 'audio', name: '音频合成工作室', icon: '🎵', category: '工具', desc: '文字转语音，多音色配音与朗读', tags: '音频 配音 语音 朗读 tts' },
    { type: 'resume', name: '简历优化工作室', icon: '📄', category: '办公', desc: 'AI优化简历，突出亮点，提升通过率', tags: '简历 求职 面试 优化' },
    { type: 'avatar', name: 'AI头像工作室', icon: '👤', category: '设计', desc: '一键生成各种风格的精美头像', tags: '头像 人像 风格 写真' },
    { type: 'image', name: 'AI图片生成工作室', icon: '🖼️', category: '设计', desc: '文生图+图生图，多模型多风格自由创作', tags: '图片 生图 文生图 图生图 绘画 插画' },
    { type: 'editor', name: '图片编辑器', icon: '✂️', category: '工具', desc: '裁剪、文字、贴纸、水印、去水印', tags: '编辑 修图 裁剪 水印 贴纸 文字' },
    { type: 'idphoto', name: '证件照工作室', icon: '📷', category: '工具', desc: '一键生成各种尺寸与底色的证件照', tags: '证件照 一寸 二寸 换底色' },
    { type: 'face-swap', name: '视频换脸工作室', icon: '🎭', category: '工具', desc: '视频中的人脸替换', tags: '换脸 视频 人脸' },
    { type: 'prompt-extract', name: '提示词反推工作室', icon: '🔍', category: '工具', desc: '从图片反推可用的生成提示词', tags: '提示词 反推 图片 咒语' },
  ];

  const matched = allStudios.filter(s => {
    const haystack = [s.name, s.category, s.desc, s.type, s.tags].join(' ').toLowerCase();
    return haystack.includes(keyword);
  });

  res.success({ studios: matched });
});

// 虎皮椒支付回调（异步通知）
router.post('/payment/xunhupay/notify', async (req, res) => {
  try {
    const params = req.body;
    console.log('[虎皮椒回调] 收到通知:', JSON.stringify(params));

    if (!params || !params.trade_order_id) {
      return res.type('text/plain').send('fail');
    }

    // 延迟引入避免循环依赖
    const xunhupay = require('../utils/xunhupay');
    const { db } = require('../database/db');
    const creditService = require('../controllers/creditService');

    // 验签
    const valid = xunhupay.verifyCallback(params, db);
    if (!valid) {
      console.log('[虎皮椒回调] 签名验证失败');
      return res.type('text/plain').send('fail');
    }

    const tradeOrderId = params.trade_order_id;
    const status = params.status; // OD=已支付

    // 查订单
    const order = db.prepare('SELECT * FROM orders WHERE remark = ? AND pay_method = ?')
      .get(tradeOrderId, 'xunhupay');

    if (!order) {
      console.log('[虎皮椒回调] 订单不存在:', tradeOrderId);
      return res.type('text/plain').send('success'); // 返回success避免重复回调
    }

    // 幂等：已支付直接返回
    if (order.status === 'paid') {
      console.log('[虎皮椒回调] 订单已处理，跳过:', tradeOrderId);
      return res.type('text/plain').send('success');
    }

    if (status !== 'OD') {
      console.log('[虎皮椒回调] 非支付成功状态:', status);
      return res.type('text/plain').send('success');
    }

    const callbackAmount = Number(params.total_fee);
    const orderAmount = Number(order.amount);
    const callbackCents = Math.round(callbackAmount * 100);
    const orderCents = Math.round(orderAmount * 100);
    if (!Number.isFinite(callbackAmount) || !Number.isFinite(orderAmount)
        || callbackCents <= 0 || callbackCents !== orderCents) {
      console.log('[虎皮椒回调] 金额校验失败:', {
        tradeOrderId,
        callbackAmount: params.total_fee,
        orderAmount: order.amount,
      });
      return res.type('text/plain').send('fail');
    }

    // 只有成功抢占未处理订单的回调才能入账，防止并发重复通知重复加积分
    const processPayment = db.transaction(() => {
      const updateResult = db.prepare(`UPDATE orders
        SET status = 'paid', transaction_id = ?, paid_at = datetime('now', 'localtime')
        WHERE id = ? AND status = 'pending'`)
        .run(params.open_order_id || params.transaction_id || '', order.id);
      if (updateResult.changes !== 1) return false;

      creditService.addCredits(
        order.user_id,
        order.credits,
        'recharge',
        `充值订单 ${tradeOrderId}`,
        order.id
      );
      return true;
    });

    const processed = processPayment();
    if (!processed) {
      console.log('[虎皮椒回调] 订单已被其他回调处理，跳过:', tradeOrderId);
      return res.type('text/plain').send('success');
    }

    console.log('[虎皮椒回调] 支付成功，订单:', tradeOrderId, '积分:', order.credits);
    res.type('text/plain').send('success');

  } catch (err) {
    console.error('[虎皮椒回调] 处理异常:', err);
    res.type('text/plain').send('fail');
  }
});


// 获取充值套餐 (公开)
router.get('/recharge/packages', (req, res) => {
  const { db } = require('../database/db');
  const list = db.prepare('SELECT id, name, price, credits, bonus FROM recharge_packages WHERE status = 1 ORDER BY sort ASC, id ASC').all();
  res.success(list);
});

// 用户积分流水
router.get('/user/credit-logs', authRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const offset = (page - 1) * pageSize;

  const total = db.prepare('SELECT COUNT(*) as cnt FROM credit_logs WHERE user_id = ?').get(req.user.id).cnt;
  const list = db.prepare(`SELECT id, type, amount, description, related_generation_id, created_at
    FROM credit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(req.user.id, pageSize, offset);

  res.success({ list, total, page, pageSize });
});

// 图片代理（解决跨域canvas污染问题）
router.get('/editor/proxy-image', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.error('缺少图片URL');
    
    const response = await safeRequest(url, { timeoutMs: 10_000, maxBytes: 10 * 1024 * 1024 });
    if (response.status < 200 || response.status >= 300) {
      return res.error('图片加载失败');
    }

    const contentType = String(response.headers['content-type'] || '');
    if (!contentType.toLowerCase().startsWith('image/')) {
      return res.error('目标内容不是图片');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(response.body);
    
  } catch (err) {
    console.error('图片代理失败:', err.message);
    res.error('图片代理失败');
  }
});

// AI去水印（inpainting模式，使用图片编辑接口）
router.post('/editor/dewatermark', authRequired, async (req, res) => {
  try {
    const { model_id, image, mask } = req.body;

    if (!model_id) return res.error('请选择模型');
    if (!image) return res.error('缺少原图');
    if (!mask) return res.error('缺少蒙版');

    const cost = aiAdapter.calculateCost(model_id, 1);

    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'image',
      model_id,
      JSON.stringify({ action: 'dewatermark' }),
      cost,
      'AI去水印',
      {
        type: 'image.edit',
        payload: {
          model_id,
          prompt: 'Remove the watermark, text or unwanted object from this area and restore the background naturally, seamlessly, high quality, photorealistic',
          options: {
            n: 1,
            ref_image: image,
            mask,
            size: '1024x1024'
          },
          deadline_seconds: 900,
          result_style: 'canonical',
          result_metadata: {}
        }
      }
    );

    if (!deductResult.success) return res.error(deductResult.msg, 402);
    res.success({ task_id: deductResult.taskId, cost, new_balance: deductResult.balance }, '任务已提交');

  } catch (err) {
    console.error(err);
    res.error('提交失败：' + err.message);
  }
});

// ============ GIF表情包工作室 ============

// 提交GIF生成任务
router.post('/generate/gif', authRequired, async (req, res) => {
  try {
    const { model_id, prompt, mode = 'text', ref_image = '', duration = 3, ratio = '1:1' } = req.body;

    if (!model_id) return res.error('请选择模型');
    if (!prompt || !prompt.trim()) return res.error('请输入描述内容');

    const model = aiAdapter.getEnabledModels('video').find(m => m.id === parseInt(model_id));
    if (!model) return res.error('视频模型不存在或未启用');
    if (!['text', 'image', 'image_firstframe', 'image_reference'].includes(mode)) {
      return res.error('不支持的生成模式');
    }

    const hasImage = Array.isArray(ref_image)
      ? ref_image.some(img => typeof img === 'string' && img.trim())
      : typeof ref_image === 'string' && ref_image.trim();
    if (mode !== 'text' && !hasImage) return res.error('请上传图片');

    const modelLower = (model.name || '').toLowerCase();
    const isMultiImageModel = Boolean(model.api_endpoint && (
      model.api_endpoint.includes('api.paipu.net')
      || model.api_endpoint.includes('/v1/video/generations')
      || model.api_endpoint.includes('mzsjai.com')
    ));
    if (mode === 'image_reference' && modelLower.includes('veo')) {
      return res.error('Veo 模型不支持参考图模式，请使用首帧图生视频模式');
    }
    if (mode === 'image_firstframe' && (modelLower.includes('seedance') || modelLower.includes('dance'))) {
      return res.error('该跳舞模型不支持首帧模式，请使用参考图生视频模式');
    }

    const actualDuration = parseIntegerParam(duration, {
      name: '时长', min: 1, max: 60, defaultValue: 3
    });
    const cost = aiAdapter.calculateCost(model_id, { duration: actualDuration });
    if (cost === null) return res.error('无法计算价格');

    let finalPrompt = prompt;
    if (mode === 'image_firstframe') {
      finalPrompt = '以下图片是视频的第一帧，请基于这张图片和描述生成连贯的视频，视频必须从这张图片的画面开始。\n\n' + prompt;
    } else if (mode === 'image_reference') {
      finalPrompt = '请参考以下图片中的人物外貌、风格和特征，生成符合描述的视频。\n\n' + prompt;
    }

    let submitRefImage = '';
    if (mode !== 'text') {
      submitRefImage = Array.isArray(ref_image) && !isMultiImageModel
        ? (ref_image.find(img => typeof img === 'string' && img.trim()) || '')
        : ref_image;
    }

    const publicId = 'gif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'gif',
      model_id,
      JSON.stringify({ prompt, mode, ref_image, duration: actualDuration, ratio }),
      cost,
      'GIF表情包生成',
      {
        publicId,
        type: 'video.generate-gif',
        payload: {
          model_id,
          prompt: finalPrompt,
          options: {
            duration: actualDuration,
            ratio: ratio === '1:1' ? '9:16' : ratio,
            ref_image: submitRefImage,
            mode,
            model_mode: 'fast'
          },
          duration: actualDuration,
          ratio,
          mode,
          deadline_seconds: 900,
          result_style: 'legacy',
          result_metadata: {}
        }
      }
    );
    if (!deductResult.success) return res.error(deductResult.msg || '积分不足', 402);

    res.success({ task_id: publicId, cost, new_balance: deductResult.balance }, '任务已提交');
  } catch (err) {
    console.error('GIF生成提交失败:', err);
    res.error('提交失败：' + err.message);
  }
});

// 查询GIF任务状态
router.get('/generate/gif/:taskId', authRequired, (req, res) => {
  const task = getPublicGenerationTask(req.params.taskId, req.user.id, 'gif');
  if (!task) return res.error('任务不存在或已过期');

  const result = parseGenerationResult(task.result);
  res.success({
    task_id: task.public_id,
    status: mapPublicTaskStatus(task),
    progress: task.status === 'success' ? 100 : task.status === 'failed' ? 0 : task.progress,
    gif_url: result.gif_url || result.gif || '',
    video_url: result.video_url || result.video || '',
    error_msg: task.error_msg || task.last_error || ''
  });
});

// ============ AI证件照工作室 ============

/**
 * 证件照尺寸配置（单位：像素，按300DPI换算）
 * 一寸: 25×35mm → 295×413px
 * 小一寸: 22×32mm → 260×378px
 * 大一寸: 33×48mm → 390×567px
 * 两寸: 35×49mm → 413×579px
 * 小二寸: 35×45mm → 413×531px
 * 护照/签证: 33×48mm → 390×567px
 */
const IDPHOTO_SIZES = {
  '1inch': { name: '一寸', width: 295, height: 413, mm: '25×35mm' },
  'small1inch': { name: '小一寸', width: 260, height: 378, mm: '22×32mm' },
  'big1inch': { name: '大一寸', width: 390, height: 567, mm: '33×48mm' },
  '2inch': { name: '两寸', width: 413, height: 579, mm: '35×49mm' },
  'small2inch': { name: '小二寸', width: 413, height: 531, mm: '35×45mm' },
  'passport': { name: '护照签证', width: 390, height: 567, mm: '33×48mm' },
};

/**
 * 背景色配置
 */
const IDPHOTO_BG_COLORS = {
  'white': { name: '白色', hex: '#FFFFFF', label: '通用/简历' },
  'blue': { name: '蓝色', hex: '#438EDB', label: '社保/护照' },
  'red': { name: '红色', hex: '#D03B31', label: '结婚证/证件' },
  'blue_dark': { name: '深蓝', hex: '#2B5FB8', label: '公务员/签证' },
  'gray': { name: '灰色', hex: '#E8E8E8', label: '驾驶证/签证' },
};

/**
 * 正装模板（描述词，AI生成时用）
 */
const IDPHOTO_SUITS = {
  'none': { name: '不换正装', prompt: '' },
  'suit_black': { name: '黑色西装', prompt: 'wearing black formal suit jacket, white dress shirt, formal attire' },
  'suit_gray': { name: '灰色西装', prompt: 'wearing gray formal suit jacket, white dress shirt, business attire' },
  'blazer_women': { name: '女士西装', prompt: 'wearing formal business blazer, white blouse, professional attire' },
  'shirt_white': { name: '白衬衫', prompt: 'wearing crisp white dress shirt, formal collar, professional' },
  'military': { name: '制式服装', prompt: 'wearing formal uniform, official attire, professional' },
};

// 提交证件照生成任务
router.post('/generate/idphoto', authRequired, async (req, res) => {
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

    if (!model_id) return res.error('请选择模型');
    if (!ref_image || !ref_image.trim()) return res.error('请上传您的照片');
    
    const sizeConfig = IDPHOTO_SIZES[size];
    if (!sizeConfig) return res.error('无效的尺寸规格');
    
    const bgConfig = IDPHOTO_BG_COLORS[bg_color];
    if (!bgConfig) return res.error('无效的背景色');
    
    const suitConfig = IDPHOTO_SUITS[suit];
    if (!suitConfig) return res.error('无效的正装选项');
    
    const actualCount = Number(num_photos);
    if (!Number.isSafeInteger(actualCount) || actualCount < 1 || actualCount > 4) {
      return res.error('证件照数量必须为1-4张');
    }

    const totalCost = aiAdapter.calculateCost(model_id, actualCount);
    if (totalCost === null) return res.error('无法计算价格');

    const genderPrompt = gender === 'male' ? 'man' : gender === 'female' ? 'woman' : 'person';
    const bgPrompt = `solid ${bgConfig.name} background, uniform plain ${bgConfig.hex} color background`;
    const prompt = `professional ID photo, passport photo style, ${genderPrompt} portrait,
      front facing, neutral expression, looking at camera,
      ${suitConfig.prompt || ''}
      ${bgPrompt},
      soft studio lighting, even lighting on face, no shadows on background,
      high quality, sharp focus, detailed face, photorealistic,
      standard composition, head and shoulders portrait,
      centered face, proper framing for official ID photo`;
    const negativePrompt = `smiling, laughing, open mouth, profile view, side view, tilted head,
      glasses reflection, hat, jewelry, earrings, necklace,
      blurry, low quality, distorted, ugly, deformed,
      text, watermark, logo, signature, caption,
      busy background, patterned background, gradient background,
      dramatic lighting, shadows on face, uneven lighting`;

    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'idphoto',
      model_id,
      JSON.stringify({ bg_color, size, suit, gender, quality, num_photos: actualCount }),
      totalCost,
      `AI证件照(${sizeConfig.name})`,
      {
        type: 'image.generate',
        payload: {
          model_id,
          prompt,
          options: {
            n: actualCount,
            ref_image,
            size: sizeConfig.height > sizeConfig.width ? '768x1024' : '1024x1024',
            negative_prompt: negativePrompt
          },
          deadline_seconds: 900,
          result_style: 'canonical',
          result_metadata: {
            bg_color,
            size,
            size_info: sizeConfig
          }
        }
      }
    );

    if (!deductResult.success) return res.error(deductResult.msg, 402);
    res.success({
      task_id: deductResult.taskId,
      cost: totalCost,
      new_balance: deductResult.balance
    }, '证件照生成任务已提交');

  } catch (err) {
    console.error(err);
    res.error('提交失败：' + err.message);
  }
});

// 查询证件照任务状态
router.get('/generate/idphoto/:taskId', authRequired, (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isSafeInteger(taskId) || taskId < 1) return res.error('任务不存在或已过期');

  const record = db.prepare(`SELECT generations.*, generation_jobs.progress AS job_progress
    FROM generations
    LEFT JOIN generation_jobs ON generation_jobs.generation_id = generations.id
    WHERE generations.id = ? AND generations.user_id = ? AND generations.studio_type = ?`)
    .get(taskId, req.user.id, 'idphoto');
  if (!record) return res.error('任务不存在或已过期');

  const result = parseGenerationResult(record.result);
  res.success({
    task_id: record.id,
    status: record.status,
    progress: record.status === 'success' ? 100 : record.status === 'failed' ? 0 : (record.job_progress || 0),
    images: result.images || [],
    bg_color: result.bg_color,
    size: result.size,
    size_info: result.size_info,
    error_msg: record.error_msg || ''
  });
});

// ============ AI视频生成（纯视频，不走GIF转码） ============

// 提交视频生成任务
router.post('/generate/video-gen', authRequired, async (req, res) => {
  try {
    const { model_id, prompt, mode = 'text', ref_image = '', duration = 5, ratio = '16:9' } = req.body;

    if (!model_id) return res.error('请选择模型');
    if (!prompt || !prompt.trim()) return res.error('请输入描述内容');
    // 模式校验移至 model 查询之后进行能力匹配检查

    const model = aiAdapter.getEnabledModels('video').find(m => m.id === parseInt(model_id));
    if (!model) return res.error('视频模型不存在或未启用');

    // 模式与模型能力校验
    const modelLower = model.name.toLowerCase();
    const isVeo = modelLower.includes('veo');
    const isSeedance = modelLower.includes('seedance') || modelLower.includes('dance');
    const isPaipu = model.api_endpoint && model.api_endpoint.includes('api.paipu.net');
    const isMinimax = model.api_endpoint && (model.api_endpoint.includes("/v1/video/generations") || model.api_endpoint.includes("mzsjai.com"));
    const isMinimaxRef = isMinimax && (model.model_identifier || "").toLowerCase().includes("ref2va");

    // 统一判断是否有图：兼容字符串和数组两种格式
    const hasImage = Array.isArray(ref_image)
      ? ref_image.length > 0 && ref_image.some(img => img && img.trim() !== '')
      : ref_image && ref_image.trim() !== '';

    if (mode === 'image_reference' && isVeo) {
      return res.error('Veo 模型不支持参考图模式，请使用首帧模式或文生视频');
    }
    if (mode === 'image_firstframe' && (isSeedance || isPaipu)) {
      return res.error('该模型只支持参考图模式，不支持首帧模式');
    }
    if ((mode === 'image_firstframe' || mode === 'image_reference') && !hasImage) {
      return res.error('请上传图片');
    }

    // MiniMax Ref2VA 模型：只支持参考图模式（必须传图），不支持首帧和纯文本
    if (isMinimaxRef) {
      if (mode === 'image_firstframe') {
        return res.error('该模型为全能参考模式，不支持首帧模式，请使用参考图模式');
      }
      if (mode === 'text' || (mode === 'image_reference' && !hasImage)) {
        return res.error('该模型为参考图生视频模型，必须上传至少1张参考图');
      }
    }

    const actualDuration = parseIntegerParam(duration, {
      name: '时长', min: 1, max: 15, defaultValue: 5
    });

    // Seedance 2.0 (paipu) 时长只能是 10 或 15 秒
    if ((isPaipu || isSeedance) && actualDuration !== 10 && actualDuration !== 15) {
      return res.error('该模型仅支持 10 秒或 15 秒时长');
    }

    // MiniMax H3 标准版支持 1-15 秒；当前上游加速版仅支持 5-15 秒。
    if (isMinimax && (actualDuration < 1 || actualDuration > 15)) {
      return res.error('MiniMax H3 模型仅支持 1-15 秒时长');
    }
    const isMinimaxLora = isMinimax && (model.model_identifier || '').toLowerCase().includes('-lora');
    if (isMinimaxLora && actualDuration < 5) {
      return res.error('当前加速版仅支持 5-15 秒；1-4 秒请选择同模式标准版');
    }

    const cost = aiAdapter.calculateCost(model_id, { duration: actualDuration });
    if (cost === null) return res.error('无法计算价格');

    let finalPrompt = prompt;
    if (mode === 'image_firstframe') {
      finalPrompt = '以下图片是视频的第一帧，请基于这张图片和描述生成连贯的视频，视频必须从这张图片的画面开始。\n\n' + prompt;
    } else if (mode === 'image_reference') {
      finalPrompt = '请参考以下图片中的人物外貌、风格和特征，生成符合描述的视频。\n\n' + prompt;
    }

    let submitRefImage = '';
    if (mode === 'image_firstframe' || mode === 'image_reference') {
      const isMultiImageModel = isPaipu || isMinimax;
      submitRefImage = Array.isArray(ref_image) && !isMultiImageModel
        ? (ref_image.find(img => typeof img === 'string' && img.trim()) || '')
        : ref_image;
    }

    const publicId = 'video_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'video-gen',
      model_id,
      JSON.stringify({ prompt, mode, ref_image, duration: actualDuration, ratio }),
      cost,
      'AI视频生成',
      {
        publicId,
        type: 'video.generate',
        payload: {
          model_id,
          prompt: finalPrompt,
          options: {
            duration: actualDuration,
            ratio,
            ref_image: submitRefImage,
            mode,
            model_mode: 'fast'
          },
          deadline_seconds: 7200,
          result_style: 'legacy',
          result_metadata: {}
        }
      }
    );
    if (!deductResult.success) return res.error(deductResult.msg || '积分不足', 402);

    res.success({ task_id: publicId, cost, new_balance: deductResult.balance }, '任务已提交');

  } catch (err) {
    console.error('视频生成提交失败:', err);
    res.error('提交失败：' + err.message);
  }
});

// 查询视频生成任务状态
router.get('/generate/video-gen/:taskId', authRequired, (req, res) => {
  const task = getPublicGenerationTask(req.params.taskId, req.user.id, 'video-gen');
  if (!task) return res.error('任务不存在或已过期');

  const result = parseGenerationResult(task.result);
  res.success({
    task_id: task.public_id,
    status: mapPublicTaskStatus(task),
    progress: task.status === 'success' ? 100 : task.status === 'failed' ? 0 : task.progress,
    video_url: result.video_url || result.video || '',
    error_msg: task.error_msg || task.last_error || ''
  });
});

module.exports = router;

// ==================== 视觉理解 / 自动获取提示词工作室 ====================

router.post('/generate/prompt-extract', authRequired, async (req, res) => {
  let taskId = null;
  let cost = 0;
  try {
    const { model_id, image_url, video_url, extract_type = 'prompt', style = 'general' } = req.body;

    if (!model_id) return res.error('请选择模型');
    if (!image_url && !video_url) return res.error('请上传图片或视频');

    const model = aiAdapter.getEnabledModels('vlm').find(m => m.id === parseInt(model_id))
      || aiAdapter.getEnabledModels('text').find(m => m.id === parseInt(model_id));
    if (!model) return res.error('视觉理解模型不存在或未启用');

    // 计算费用（按次计费）
    const basePrice = model.price_per_call || 10;
    cost = basePrice;

    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'prompt-extract',
      model_id,
      JSON.stringify({ extract_type, style }),
      cost,
      '提示词提取'
    );
    if (!deductResult.success) return res.error(deductResult.msg || '积分不足', 402);

    taskId = deductResult.taskId;

    // 构建系统提示词
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

    // 视频抽帧处理：将视频抽3帧拼成网格图，转成图片识别（当前VLM模型不支持原生视频输入）
    let finalImageUrl = image_url;
    let usedVideoFallback = false;
    if (video_url) {
      try {
        const tempDir = path.join(__dirname, '../public/uploads/temp_video');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        let videoFilePath = '';

        // 1. base64 视频或网络URL视频 → 存为本地文件
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
          await new Promise(function(dlResolve, dlReject) {
            dlModule.get(video_url, function(resp) {
              const fileStream = fs.createWriteStream(videoFilePath);
              resp.pipe(fileStream);
              fileStream.on('finish', function() { fileStream.close(); dlResolve(); });
              fileStream.on('error', dlReject);
            }).on('error', dlReject);
          });
        }

        // 2. 抽帧拼接为网格图
        if (videoFilePath && fs.existsSync(videoFilePath) && fs.statSync(videoFilePath).size > 0) {
          const frameDir = path.join(tempDir, 'frames');
          const gridImagePath = await extractVideoFrames(videoFilePath, frameDir, 3);
          if (gridImagePath && fs.existsSync(gridImagePath)) {
            // 3. 生成公网可访问的图片URL（比base64快，模型直接下载）
            const { getSetting } = require('../database/db');
            const siteUrl = getSetting('site_url', '').replace(/\/$/, '');
            const reqHost = req.headers['x-forwarded-host'] || req.headers['host'];
            const reqProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
            const relativePath = path.relative(path.join(__dirname, '../public'), gridImagePath).replace(/\\/g, '/');
            if (siteUrl) {
              finalImageUrl = siteUrl + '/' + relativePath;
            } else {
              finalImageUrl = reqProto + '://' + reqHost + '/' + relativePath;
            }
            usedVideoFallback = true;
            console.log('[PROMPT_EXTRACT] 视频抽帧完成:', finalImageUrl);
          }
        }
      } catch (e) {
        console.error('[PROMPT_EXTRACT] 视频抽帧处理失败:', e.message);
      }
    }

    // 如果视频抽帧成功，走图片识别分支（不传video_url）；否则保留原逻辑
    const analyzeOptions = { system_prompt: systemPrompt };
    if (usedVideoFallback && finalImageUrl) {
      analyzeOptions.image_url = finalImageUrl;
    } else {
      analyzeOptions.image_url = image_url;
      if (video_url) analyzeOptions.video_url = video_url;
    }

    // 同步执行（视觉理解通常很快）
    const apiResult = await aiAdapter.analyzeMedia(model_id, userPrompt, analyzeOptions);

    // 更新为成功
    db.prepare(`UPDATE generations SET result = ?, status = 'success',
      completed_at = datetime('now','localtime') WHERE id = ?`)
      .run(JSON.stringify({ text: apiResult.text, mock: apiResult.mock || false }), taskId);

    res.success({
      task_id: taskId,
      text: apiResult.text,
      mock: apiResult.mock || false,
      cost,
      new_balance: deductResult.balance,
    }, '提取完成');

  } catch (err) {
    console.error('提示词提取失败:', err);
    // 更新为失败并退款
    try {
      refundFailedGeneration(taskId, err.message);
    } catch (e) {
      console.error('更新失败记录或退款出错:', e);
    }
    res.error('提取失败：' + err.message);
  }
});

// ==================== 视频换人工作室 ====================

router.post('/generate/face-swap', authRequired, async (req, res) => {
  try {
    const { model_id, prompt = '', video_url, image_url, duration = 5, ratio = '16:9' } = req.body;

    if (!model_id) return res.error('请选择模型');
    if (!video_url) return res.error('请上传参考视频');
    if (!image_url) return res.error('请上传角色参考图');

    const model = aiAdapter.getEnabledModels('video').find(m => m.id === parseInt(model_id));
    if (!model) return res.error('视频模型不存在或未启用');

    const actualDuration = parseIntegerParam(duration, {
      name: '时长', min: 1, max: 60, defaultValue: 5
    });
    const cost = aiAdapter.calculateCost(model_id, { duration: actualDuration });
    if (cost === null) return res.error('无法计算价格');

    // 视频换人价格加倍（更复杂）
    const finalCost = Math.round((cost * 1.5 + Number.EPSILON) * 100) / 100;

    const publicId = 'faceswap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const deductResult = creditService.createGenerationAndDeduct(
      req.user.id,
      'face-swap',
      model_id,
      JSON.stringify({ prompt, video_url, image_url, duration: actualDuration, ratio }),
      finalCost,
      '视频换人',
      {
        publicId,
        type: 'video.face-swap',
        payload: {
          model_id,
          prompt: prompt || '将视频中的人物替换为参考图片中的人物，保持动作和背景不变',
          options: {
            duration: actualDuration,
            ratio,
            video_url,
            image_url
          },
          deadline_seconds: 7200,
          result_style: 'legacy',
          result_metadata: {}
        }
      }
    );
    if (!deductResult.success) return res.error(deductResult.msg || '积分不足', 402);

    res.success({ task_id: publicId, cost: finalCost, new_balance: deductResult.balance }, '任务已提交');

  } catch (err) {
    console.error('视频换人提交失败:', err);
    res.error('提交失败：' + err.message);
  }
});

// 查询视频换人任务状态
router.get('/generate/face-swap/:taskId', authRequired, (req, res) => {
  const task = getPublicGenerationTask(req.params.taskId, req.user.id, 'face-swap');
  if (!task) return res.error('任务不存在或已过期');

  const result = parseGenerationResult(task.result);
  res.success({
    task_id: task.public_id,
    status: mapPublicTaskStatus(task),
    progress: task.status === 'success' ? 100 : task.status === 'failed' ? 0 : task.progress,
    video_url: result.video_url || result.video || '',
    error_msg: task.error_msg || task.last_error || ''
  });
});
