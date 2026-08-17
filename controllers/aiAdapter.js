const { db } = require('../database/db');
const path = require('path');
const fs = require('fs');
const { safeRequest } = require('../utils/safeHttp');

// ===== imgbb 免费图床上传（用于 mzsjai 等需要 https 图片 URL 的 API） =====
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';

/**
 * 下载视频到本地 uploads 目录（用于 mzsjai 等需要鉴权访问的视频 URL）
 */
async function downloadVideoToLocal(url, apiKey, taskId) {
  const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const fileName = 'video_' + Date.now() + '_' + taskId.slice(0, 8) + '.mp4';
  const filePath = path.join(uploadsDir, fileName);

  const resp = await safeRequest(url, {
    headers: {
      'Authorization': 'Bearer ' + apiKey,
    },
    timeoutMs: 60_000,
    maxBytes: 500 * 1024 * 1024
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error('下载失败：HTTP ' + resp.status);
  }

  const buffer = resp.body;
  fs.writeFileSync(filePath, buffer);

  console.log('[VIDEO_DOWNLOAD] 视频已保存:', fileName, '大小:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');
  return '/uploads/' + fileName;
}

/**
 * 将 base64 图片上传到 imgbb，返回 https URL
 * @param {string} base64Str - base64 图片（可能带 data:image/xxx;base64, 前缀）
 * @returns {Promise<string>} 图片 https URL
 */
async function uploadToImgbb(base64Str) {
  if (!base64Str || !IMGBB_API_KEY) {
    throw new Error("imgbb 上传失败：缺少图片或 API Key");
  }
  // 去掉 data:image/xxx;base64, 前缀
  let base64Data = base64Str;
  const prefixMatch = base64Str.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,/);
  if (prefixMatch) {
    base64Data = base64Str.slice(prefixMatch[0].length);
  }

  // 构造 FormData
  const formBody = new URLSearchParams();
  formBody.append("image", base64Data);

  const resp = await fetch("https://api.imgbb.com/1/upload?key=" + encodeURIComponent(IMGBB_API_KEY), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });

  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const errMsg = data?.error?.message || data?.status?.message || `imgbb 返回 ${resp.status}`;
    throw new Error("imgbb 上传失败：" + errMsg);
  }
  return data.data.url; // 这是展示页，用 direct link
}

// HTTPS 图片域名（用于 mzsjai 等需要 https 图片 URL 的 API）
const HTTPS_IMAGE_DOMAIN = "https://ai.whaios.com";

/**
 * 将 base64 图片保存到本地 uploads 目录，返回 HTTPS URL
 */
async function saveImageLocal(base64Image) {
  if (typeof base64Image === "string" && base64Image.startsWith("https://")) {
    return base64Image;
  }
  let base64Data = base64Image;
  let ext = "png";
  const match = base64Image.match(/^data:image\/(\w+);base64,/);
  if (match) {
    ext = match[1];
    base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
  }
  const uploadsDir = path.join(__dirname, "..", "public", "uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const fileName = "mzsjai_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + "." + ext;
  const filePath = path.join(uploadsDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
  return HTTPS_IMAGE_DOMAIN + "/uploads/" + fileName;
}

/**
 * 批量保存 base64 图片到本地，返回 HTTPS URL 数组
 */
async function uploadImagesLocal(imageList) {
  const urls = [];
  for (const img of imageList) {
    const url = await saveImageLocal(img);
    urls.push(url);
  }
  return urls;
}

/**
 * 批量上传 base64 图片到 imgbb，返回 https URL 数组
 */
async function uploadImagesToImgbb(imageList) {
  const urls = [];
  for (const img of imageList) {
    // 已经是 https URL 就直接用
    if (typeof img === "string" && img.startsWith("https://")) {
      urls.push(img);
    } else {
      const url = await uploadToImgbb(img);
      urls.push(url);
    }
  }
  return urls;
}

// 模型能力缓存持久化文件路径（避免进程重启后每次都要降级试错）
const capsCacheFile = path.join(__dirname, '..', 'database', 'model_caps.json');

// 生图模型能力缓存（运行时记忆，避免每次都降级重试浪费时间）
// key: modelId (string), value: { supports_n: boolean|null, supports_negative_prompt: boolean|null }
const imageModelCaps = new Map();

// 启动时从文件加载缓存
function loadCapsCache() {
  try {
    if (fs.existsSync(capsCacheFile)) {
      const data = JSON.parse(fs.readFileSync(capsCacheFile, 'utf-8'));
      for (const [k, v] of Object.entries(data)) {
        imageModelCaps.set(k, v);
      }
    }
  } catch (e) {
    // 加载失败就算了，不影响主流程
  }
}

// 保存缓存到文件
function saveCapsCache() {
  try {
    const obj = {};
    for (const [k, v] of imageModelCaps.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(capsCacheFile, JSON.stringify(obj), 'utf-8');
  } catch (e) {
    // 保存失败不影响主流程
  }
}

loadCapsCache();

// 更新模型能力缓存并持久化
function setModelCap(modelId, key, value) {
  const id = String(modelId);
  let caps = imageModelCaps.get(id);
  if (!caps) {
    caps = { supports_n: null, supports_negative_prompt: null };
    imageModelCaps.set(id, caps);
  }
  caps[key] = value;
  saveCapsCache();
}

/**
 * AI 模型统一适配层
 * 支持 OpenAI 兼容格式的 API 调用
 */

/**
 * 调用文生图模型
 * 自动判断：Token Plan 多模态生成接口 (multimodal-generation) 走原生格式，其余走 OpenAI 兼容格式
 * @param {number} modelId 模型ID
 * @param {string} prompt 提示词
 * @param {object} options 选项 { size, n, negative_prompt }
 * @returns {Promise<{images: string[]}>} 图片URL列表
 */
async function generateImage(modelId, prompt, options = {}) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) {
    throw new Error('模型不存在或已禁用');
  }
  if (model.type !== 'image') {
    throw new Error('该模型类型不是生图模型');
  }

  const fetch = globalThis.fetch || require('node-fetch');
  
  // 注意：如果是占位假key，直接返回模拟结果
  if (model.api_key.includes('example') || model.api_key.includes('请修改') || model.api_endpoint.includes('api.example.com')) {
    return generateMockImageResult(options.n || 1, model.model_identifier);
  }

  // 判断是否为 Token Plan 多模态生成接口（百炼原生格式）
  const isTokenPlanMultimodal = model.api_endpoint.includes('multimodal-generation/generation');
  
  // 有参考图时走图生图分支
  if (options.ref_image) {
    if (isTokenPlanMultimodal) {
      // Token Plan 多模态接口也支持图生图（传图片+文字），复用现有逻辑
      return generateImageTokenPlan(model, prompt, options, fetch);
    } else {
      return editImageOpenAICompat(model, prompt, options, fetch);
    }
  }
  
  if (isTokenPlanMultimodal) {
    return generateImageTokenPlan(model, prompt, options, fetch);
  } else {
    return generateImageOpenAICompat(model, prompt, options, fetch);
  }
}

/**
 * 并行生成多张图（已知模型不支持 n 参数时使用）
 * 拆成多个单图请求并发发出，大幅缩短总耗时
 */
async function generateImageParallel(model, prompt, options, fetch, count) {
  const MAX_CONCURRENT = 4; // 最大并发数
  const allImages = [];
  let isMock = false;

  // 为每个请求生成独立的提示词变体（避免所有图完全一样）
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const variantPrompt = i === 0 ? prompt : `${prompt}, variation ${i + 1}, different angle and composition`;
    tasks.push({ prompt: variantPrompt, index: i });
  }

  // 分批并发执行
  for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
    const batch = tasks.slice(i, i + MAX_CONCURRENT);
    const promises = batch.map(task =>
      generateImageOpenAICompat(model, task.prompt, { ...options, n: 1 }, fetch)
        .then(result => ({ success: true, result, index: task.index }))
        .catch(err => ({ success: false, error: err, index: task.index }))
    );
    const results = await Promise.all(promises);

    for (const r of results) {
      if (r.success && r.result.images && r.result.images.length > 0) {
        allImages.push(r.result.images[0]);
        if (r.result.mock) isMock = true;
      }
    }
  }

  return { images: allImages, mock: isMock };
}

/**
 * OpenAI 兼容格式生图
 */
async function generateImageOpenAICompat(model, prompt, options, fetch) {
  const path = require('path');
  const fs = require('fs');
  
  const modelId = model.id;
  const requestedN = parseInt(options.n) || 1;
  const hasNeg = !!options.negative_prompt;

  // 读取/初始化模型能力缓存
  let caps = imageModelCaps.get(modelId);
  if (!caps) {
    caps = { supports_n: null, supports_negative_prompt: null };
    imageModelCaps.set(modelId, caps);
  }

  const baseBody = {
    model: model.model_identifier,
    prompt,
    size: options.size || '1024x1024',
    response_format: 'b64_json',
  };

  // 根据已知能力构建变体列表，避免无谓重试
  const bodyVariants = [];
  
  const tryN = caps.supports_n !== false && requestedN > 1;
  const tryNeg = caps.supports_negative_prompt !== false && hasNeg;

  // 按优先级排列：参数最全的先试
  if (tryN && tryNeg) {
    bodyVariants.push({ ...baseBody, n: requestedN, negative_prompt: options.negative_prompt, _label: 'full' });
  }
  if (tryN) {
    bodyVariants.push({ ...baseBody, n: requestedN, _label: 'n_only' });
  }
  if (tryNeg) {
    bodyVariants.push({ ...baseBody, negative_prompt: options.negative_prompt, _label: 'neg_only' });
  }
  // 保底最简版
  bodyVariants.push({ ...baseBody, _label: 'minimal' });

  const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  let lastError = null;
  
  for (let i = 0; i < bodyVariants.length; i++) {
    const body = bodyVariants[i];
    const label = body._label;
    delete body._label;

    try {
      const response = await fetch(model.api_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.api_key}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        lastError = new Error(`API调用失败 (${label}): ${response.status} - ${errText.slice(0, 200)}`);
        
        // 鉴权失败直接终止
        if (response.status === 401 || response.status === 403) {
          throw lastError;
        }

        // 400 类错误通常是参数不支持，记录能力后快速降级
        if (response.status >= 400 && response.status < 500) {
          if (label === 'full') {
            // 不确定是n还是neg的问题，不记录，继续试
          } else if (label === 'n_only') {
            setModelCap(modelId, 'supports_n', false);
          } else if (label === 'neg_only') {
            setModelCap(modelId, 'supports_negative_prompt', false);
          }
          continue;
        }

        // 5xx 服务器错误也继续试下一个变体
        continue;
      }

      const data = await response.json();
      const rawImages = (data.data || []).map(item => item.url || item.b64_json || '').filter(Boolean);
      
      if (rawImages.length === 0) {
        lastError = new Error('生成结果中没有图片: ' + JSON.stringify(data).slice(0, 200));
        continue;
      }

      // 关键优化：如果请求了n>1但只返回1张，说明模型不支持n参数
      // 直接用返回的图片，不再降级重试
      if (requestedN > 1 && rawImages.length < requestedN) {
        setModelCap(modelId, 'supports_n', false);
      }
      // 如果带了negative_prompt且成功，记录支持
      if (body.negative_prompt && rawImages.length > 0) {
        setModelCap(modelId, 'supports_negative_prompt', true);
      }
      // 如果带了n且返回多张，记录支持
      if (body.n && body.n > 1 && rawImages.length > 1) {
        setModelCap(modelId, 'supports_n', true);
      }
      
      // 将 base64 图片保存到本地生成目录，返回可访问的路径
      const images = rawImages.map((img, idx) => {
        if (img.startsWith('http://') || img.startsWith('https://')) {
          return img;
        }
        const base64Data = img.replace(/^data:image\/\w+;base64,/, '');
        const fileName = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${idx}.png`;
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return `/uploads/${fileName}`;
      });
      
      // 自动补齐：如果返回数量不够，并行发剩余请求
      if (requestedN > 1 && images.length < requestedN) {
        const stillNeed = requestedN - images.length;
        const extra = await generateImageParallel(model, prompt, options, fetch, stillNeed);
        return { images: images.concat(extra.images).slice(0, requestedN), raw: data, mock: extra.mock };
      }
      
      return { images, raw: data };
    } catch (err) {
      lastError = err;
      // 网络/鉴权错误直接抛，不用继续试
      if (err.message && (
        err.message.includes('401') || 
        err.message.includes('403') || 
        err.message.includes('network') || 
        err.message.includes('ENOTFOUND') ||
        err.message.includes('ECONNREFUSED')
      )) {
        throw err;
      }
    }
  }
  
  console.error(`生图API调用失败(OpenAI兼容, model=${model.model_identifier})，所有变体均失败:`, lastError?.message);
  throw lastError || new Error('生图失败');
}

/**
 * OpenAI 兼容格式图生图（image edit / variation）
 * 走 /v1/images/edits 接口，formData 格式
 * @param {object} model 模型对象
 * @param {string} prompt 提示词
 * @param {object} options { size, n, negative_prompt, ref_image: base64字符串或Buffer }
 * @param {function} fetch fetch函数
 */
async function editImageOpenAICompat(model, prompt, options, fetch) {
  const path = require('path');
  const fs = require('fs');
  
  const modelId = model.id;
  const requestedN = parseInt(options.n) || 1;

  const size = options.size || '1024x1024';

  // 处理参考图：支持单图（base64字符串/Buffer）或多图数组
  let imageBuffer;
  let imageExt = 'png';
  let imageList = [];
  let isMultiImage = false;

  const rawRef = options.ref_image;
  const refArray = Array.isArray(rawRef) ? rawRef.filter(x => x && x.length > 0) : (rawRef ? [rawRef] : []);
  isMultiImage = refArray.length > 1;

  for (const ref of refArray) {
    let buf, ext = 'png';
    if (Buffer.isBuffer(ref)) {
      buf = ref;
    } else if (typeof ref === 'string') {
      const base64Data = ref.replace(/^data:image\/(\w+);base64,/, (_, e) => {
        ext = e;
        return '';
      });
      buf = Buffer.from(base64Data, 'base64');
    } else {
      continue;
    }
    imageList.push({ buffer: buf, ext });
  }

  // 兼容单图变量
  if (imageList.length > 0) {
    imageBuffer = imageList[0].buffer;
    imageExt = imageList[0].ext;
  } else {
    throw new Error('参考图格式不支持');
  }

  // 处理蒙版（mask，可选，用于inpainting/去水印）
  let maskBuffer = null;
  let maskExt = 'png';
  if (options.mask) {
    if (Buffer.isBuffer(options.mask)) {
      maskBuffer = options.mask;
    } else if (typeof options.mask === 'string') {
      const base64Data = options.mask.replace(/^data:image\/(\w+);base64,/, (_, ext) => {
        maskExt = ext;
        return '';
      });
      maskBuffer = Buffer.from(base64Data, 'base64');
    }
  }

  // 构建接口URL：把原来的 .../images/generations 替换成 .../images/edits
  let endpoint = model.api_endpoint;
  if (endpoint.includes('/images/generations')) {
    endpoint = endpoint.replace('/images/generations', '/images/edits');
  } else if (!endpoint.endsWith('/images/edits')) {
    // 尝试拼接
    endpoint = endpoint.replace(/\/+$/, '') + '/images/edits';
  }

  const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  async function tryRequest(body) {
    // 用原生FormData + Blob，让fetch自动处理boundary（与中转站文档一致）
    const form = new FormData();
    form.append('model', model.model_identifier);
    form.append('prompt', body.prompt);
    form.append('size', body.size || size);
    form.append('response_format', 'b64_json');
    if (body.n && body.n > 1) form.append('n', body.n);
    // image 文件放最后（多图用 image[] 数组格式，单图沿用 image）
    if (isMultiImage) {
      imageList.forEach((img, idx) => {
        const blob = new Blob([img.buffer], { type: `image/${img.ext}` });
        form.append("image[]", blob, `ref_${idx}.${img.ext}`);
      });
    } else {
      const blob = new Blob([imageBuffer], { type: `image/${imageExt}` });
      form.append("image", blob, `ref.${imageExt}`);
    }
    
    // mask 文件（inpainting模式）
    if (maskBuffer) {
      const maskBlob = new Blob([maskBuffer], { type: `image/${maskExt}` });
      form.append('mask', maskBlob, `mask.${maskExt}`);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${model.api_key}`,
      },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`图生图API调用失败: ${response.status} - ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const rawImages = (data.data || []).map(item => item.url || item.b64_json || '').filter(Boolean);
    
    if (rawImages.length === 0) {
      throw new Error('图生图结果中没有图片: ' + JSON.stringify(data).slice(0, 200));
    }

    const images = rawImages.map((img, idx) => {
      if (img.startsWith('http://') || img.startsWith('https://')) {
        return img;
      }
      const base64Data = img.replace(/^data:image\/\w+;base64,/, '');
      const fileName = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${idx}.png`;
      const filePath = path.join(uploadDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      return `/uploads/${fileName}`;
    });

    return { images, raw: data };
  }

  // 图生图降级策略：先试带n，不行试n=1
  try {
    if (requestedN > 1) {
      return await tryRequest({ prompt, size, n: requestedN });
    }
  } catch (err) {
    if (requestedN <= 1) throw err;
    console.warn(`图生图 n=${requestedN} 失败，降级为单次请求:`, err.message);
  }

  // 最简版：n=1
  let result = await tryRequest({ prompt, size, n: 1 });
  // 记录不支持n
  setModelCap(modelId, 'supports_n', false);
  
  // 自动补齐：如果需要多张，并行发剩余请求
  if (requestedN > 1 && result.images.length < requestedN) {
    const stillNeed = requestedN - result.images.length;
    const extra = await editImageParallel(model, prompt, options, fetch, stillNeed);
    result = { images: result.images.concat(extra.images).slice(0, requestedN) };
  }
  
  return result;
}

/**
 * 图生图并行版本（已知模型不支持 n 参数时使用）
 */
async function editImageParallel(model, prompt, options, fetch, count) {
  const MAX_CONCURRENT = 4;
  const allImages = [];

  const tasks = [];
  for (let i = 0; i < count; i++) {
    const variantPrompt = i === 0 ? prompt : `${prompt}, variation ${i + 1}, different angle and composition`;
    tasks.push({ prompt: variantPrompt, index: i });
  }

  for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
    const batch = tasks.slice(i, i + MAX_CONCURRENT);
    const promises = batch.map(task =>
      editImageOpenAICompat(model, task.prompt, { ...options, n: 1 }, fetch)
        .then(result => ({ success: true, result, index: task.index }))
        .catch(err => ({ success: false, error: err, index: task.index }))
    );
    const results = await Promise.all(promises);

    for (const r of results) {
      if (r.success && r.result.images && r.result.images.length > 0) {
        allImages.push(r.result.images[0]);
      }
    }
  }

  return { images: allImages };
}

/**
 * Token Plan 百炼原生多模态生成接口生图
 * 同步返回，图片在 output.choices[*].message.content[*].image 中
 */
async function generateImageTokenPlan(model, prompt, options, fetch) {
  // size 格式转换: 768x1024 -> 768*1024
  const size = (options.size || '1024x1024').replace('x', '*');
  const n = options.n || 1;
  
  // 拼接 prompt 和 negative prompt
  let fullPrompt = prompt;
  if (options.negative_prompt) {
    fullPrompt = prompt + '\n\nNegative prompt: ' + options.negative_prompt;
  }
  
  const body = {
    model: model.model_identifier,
    input: {
      messages: [
        {
          role: 'user',
          content: [
            { text: fullPrompt }
          ]
        }
      ]
    },
    parameters: {
      size: size,
      n: n,
    }
  };

  try {
    const response = await fetch(model.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.api_key}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API调用失败: ${response.status} - ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    
    // 从 output.choices[*].message.content[*] 中提取图片
    const images = [];
    const choices = (data.output && data.output.choices) || [];
    for (const choice of choices) {
      const contents = (choice.message && choice.message.content) || [];
      for (const content of contents) {
        if (content.type === 'image' && content.image) {
          images.push(content.image);
        }
      }
    }
    
    if (images.length === 0) {
      throw new Error('生成结果中没有图片: ' + JSON.stringify(data).slice(0, 200));
    }
    
    return { images, raw: data };
  } catch (err) {
    console.error('生图API调用失败(TokenPlan):', err.message);
    throw err;
  }
}

/**
 * 调用文本生成模型 (OpenAI Chat Completions 兼容格式)
 * @param {number} modelId 模型ID
 * @param {array} messages 消息 [{role: 'user', content: '...'}]
 * @param {object} options 选项 { temperature, max_tokens }
 * @returns {Promise<{text: string}>}
 */
async function generateText(modelId, messages, options = {}) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) {
    throw new Error('模型不存在或已禁用');
  }
  if (model.type !== 'text') {
    throw new Error('该模型类型不是文本模型');
  }

  const body = {
    model: model.model_identifier,
    messages: messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens || 2000,
  };

  try {
    const fetch = globalThis.fetch || require('node-fetch');
    
    // 占位假key，返回模拟结果
    if (model.api_key.includes('example') || model.api_key.includes('请修改') || model.api_endpoint.includes('api.example.com')) {
      return generateMockTextResult(messages, model.model_identifier);
    }

    const response = await fetch(model.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.api_key}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API调用失败: ${response.status} - ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    
    return { text, raw: data };
  } catch (err) {
    // API调用失败直接抛出，由上层处理
    console.error('文本API调用失败:', err.message);
    throw err;
  }
}


async function generateAudio(modelId, inputText, options = {}) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) {
    throw new Error('模型不存在或已禁用');
  }
  if (model.type !== 'audio') {
    throw new Error('该模型类型不是音频模型');
  }

  const response_format = options.response_format || 'wav';
  const body = {
    model: model.model_identifier,
    input: inputText,
    response_format: response_format,
  };

  // 可选参数：音色描述 / 指令
  // index-tts-v2 不支持 voice 自然语言描述，会报 preset voice not allowed
  if (options.voice && model.model_identifier !== 'index-tts-v2') {
    body.voice = options.voice;
  }
  if (options.instructions) {
    body.instructions = options.instructions;
  }
  // ref_audio 公共参数（VoxCPM2 在专属块里单独处理，因为和方言互斥）
  if (options.ref_audio && model.model_identifier !== 'voxcpm2') {
    body.ref_audio = options.ref_audio;
  }

  // VoxCPM2 专属参数
  if (model.model_identifier === 'voxcpm2') {
    // 方言：直接拼接在 voice 最前面（如 "四川话温柔女声"）
    // 注意：有 ref_audio 克隆模式下方言无效
    if (options.dialect && !options.ref_audio) {
      body.voice = body.voice ? (options.dialect + ' ' + body.voice + '，用' + options.dialect + '朗读') : (options.dialect + ' 标准女声，用' + options.dialect + '朗读');
    }
    if (options.ref_audio) body.ref_audio = options.ref_audio;
    if (options.ref_text) body.ref_text = options.ref_text;
    if (options.cfg_value !== undefined) body.cfg_value = options.cfg_value;
    if (options.inference_timesteps !== undefined) body.inference_timesteps = options.inference_timesteps;
    if (options.seed !== undefined) body.seed = options.seed;
    if (options.normalize !== undefined) body.normalize = options.normalize;
    if (options.denoise !== undefined) body.denoise = options.denoise;
  }

  // OmniVoice 专属参数
  if (model.model_identifier === 'matrix-tts-v1') {
    if (options.speed !== undefined) body.speed = options.speed;
    if (options.duration !== undefined) body.duration = options.duration;
    if (options.num_step !== undefined) body.num_step = options.num_step;
    if (options.language_id !== undefined) body.language_id = options.language_id;
  }

  // IndexTTS2 专属参数
  if (model.model_identifier === 'index-tts-v2') {
    if (options.instructions) body.instructions = options.instructions;
    if (options.use_emo_text !== undefined) body.use_emo_text = options.use_emo_text;
    if (options.emo_alpha !== undefined) body.emo_alpha = options.emo_alpha;
    if (options.use_random !== undefined) body.use_random = options.use_random;
    if (options.emo_audio) body.emo_audio = options.emo_audio;
    // emo_vector 必须长度为8，否则上游500
    if (options.emo_vector && Array.isArray(options.emo_vector) && options.emo_vector.length === 8) {
      body.emo_vector = options.emo_vector;
    }
  }

  try {
    const fetch = globalThis.fetch || require('node-fetch');

    if (model.api_key.includes('example') || model.api_key.includes('请修改') || model.api_endpoint.includes('api.example.com')) {
      return { audio_url: '', mock: true, model: model.model_identifier, format: response_format };
    }

    // 从 api_endpoint 推导 baseUrl，再拼接 /v1/audio/speech
    // 兼容用户填完整路径或只填域名的情况
    let baseUrl = model.api_endpoint.replace(/\/v1\/.*$/, '');
    if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
    const speechUrl = baseUrl + '/v1/audio/speech';

    // DEBUG 音频请求（方言/克隆）
    console.log('[CLONE DEBUG] full body:', JSON.stringify({
      ...body,
      ref_audio: body.ref_audio ? ('base64_len=' + body.ref_audio.length + ' first20=' + body.ref_audio.slice(0,20)) : 'none'
    }));

    const response = await fetch(speechUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + model.api_key,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = 'API调用失败: ' + response.status;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error) {
          errMsg = errJson.error.message || errJson.error.code || errText.slice(0, 200);
          if (errJson.error.code === 'insufficient_user_quota') {
            errMsg = '上游余额不足，请充值后再试';
          } else if (errJson.error.code === 'model_not_found') {
            errMsg = '模型不存在或未开通: ' + model.model_identifier;
          }
        }
      } catch(e) {
        errMsg += ' - ' + errText.slice(0, 200);
      }
      throw new Error(errMsg);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).slice(2, 8);
    const extMap = { wav: 'wav', mp3: 'mp3', flac: 'flac', ogg: 'ogg', opus: 'opus' };
    const ext = extMap[response_format] || 'wav';
    const fileName = 'audio_' + timestamp + '_' + randomStr + '.' + ext;
    const savePath = '/var/www/ai-studio-full/public/audio/' + fileName;

    const fs2 = require('fs');
    fs2.writeFileSync(savePath, buffer);

    // 提取性能header
    let perfInfo = {};
    try {
      const headers = response.headers;
      if (headers.get('x-omnivoice-generate-seconds')) perfInfo.generate_seconds = headers.get('x-omnivoice-generate-seconds');
      if (headers.get('x-omnivoice-audio-seconds')) perfInfo.audio_seconds = headers.get('x-omnivoice-audio-seconds');
      if (headers.get('x-omnivoice-rtf')) perfInfo.rtf = headers.get('x-omnivoice-rtf');
      if (headers.get('x-indextts-generate-seconds')) perfInfo.generate_seconds = headers.get('x-indextts-generate-seconds');
    } catch(e) {}

    const audioUrl = '/audio/' + fileName;
    return { audio_url: audioUrl, file_name: fileName, format: response_format, size: buffer.length, perf: perfInfo };
  } catch (err) {
    console.error('音频API调用失败:', err.message);
    throw err;
  }
}

// ============ 模拟结果（用于假key/演示模式） ============

function generateMockImageResult(n, modelName) {
  // 返回占位图 URL (使用 picsum 作为占位)
  const images = [];
  const seed = Date.now();
  for (let i = 0; i < n; i++) {
    images.push(`https://picsum.photos/seed/${seed + i}/800/800`);
  }
  return { images, mock: true, model: modelName };
}

function generateMockTextResult(messages, modelName) {
  const userMsg = messages?.find(m => m.role === 'user')?.content || '';
  
  // 根据关键词返回不同的模拟文案
  const text = `【AI生成 · 演示模式】

这是由 ${modelName} 生成的示例文案。
当前配置的API地址为示例地址，请到管理后台配置真实的API Key后即可调用真实模型。

针对你的需求"${userMsg.slice(0, 50)}${userMsg.length > 50 ? '...' : ''}"，以下是生成结果：

✨ 核心亮点：
• 精选优质材质，手感细腻舒适
• 创新设计理念，引领时尚潮流
• 严格品质把控，每一处都经得起推敲
• 超高性价比，闭眼入不踩雷

💡 使用建议：
搭配同系列产品效果更佳，适合多种场景使用。

🌟 用户好评：
"用过最好的一款，回购无数次了！"
"性价比超高，强烈推荐给身边朋友"
"颜值与实力并存，太爱了❤️"

—— 以上为演示模式输出，配置真实API后将生成高质量内容 ——`;

  return { text, mock: true, model: modelName };
}

/**
 * 获取启用的模型列表
 */
function getEnabledModels(type = null) {
  let sql = 'SELECT id, name, type, model_identifier, price_per_call, is_default, description FROM models WHERE status = 1';
  const params = [];
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' ORDER BY is_default DESC, id ASC';
  return db.prepare(sql).all(...params);
}

/**
 * 获取模型价格
 */
function getModelPrice(modelId) {
  const model = db.prepare('SELECT price_per_call FROM models WHERE id = ? AND status = 1').get(modelId);
  return model ? model.price_per_call : null;
}

/**
 * 计算生成任务价格
 * @param {number} modelId 模型ID
 * @param {number|object} countOrOptions 数量（图片/文本类）或选项对象 { count, duration, ... }
 * @returns {number|null}
 */
function calculateCost(modelId, countOrOptions = 1) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) return null;

  const basePrice = Number(model.price_per_call);
  if (!Number.isSafeInteger(basePrice) || basePrice <= 0) return null;

  const validateCount = value => (
    Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : null
  );

  // 兼容旧调用：传数字直接当 count
  if (typeof countOrOptions === 'number') {
    const count = validateCount(countOrOptions);
    return count === null ? null : basePrice * count;
  }

  const opts = countOrOptions || {};
  const count = validateCount(opts.count === undefined ? 1 : Number(opts.count));
  if (count === null) return null;

  // 视频模型按秒计费（price_per_call 表示每秒价格）
  if (model.type === 'video' && opts.duration !== undefined) {
    const seconds = Number(opts.duration);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) return null;
    return Math.ceil(basePrice * seconds * count);
  }

  return basePrice * count;
}

/**
 * 图片编辑（inpainting / 去水印 / 图生图编辑）
 * 走 edits 接口，支持 mask 蒙版
 * @param {number} modelId 模型ID
 * @param {string} prompt 提示词
 * @param {object} options 选项 { size, n, ref_image, mask }
 * @returns {Promise<{images: string[]}>}
 */
async function editImage(modelId, prompt, options = {}) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) {
    throw new Error('模型不存在或已禁用');
  }
  if (model.type !== 'image') {
    throw new Error('该模型类型不是生图模型');
  }

  const fetch = globalThis.fetch || require('node-fetch');
  
  if (model.api_key.includes('example') || model.api_key.includes('请修改') || model.api_endpoint.includes('api.example.com')) {
    return generateMockImageResult(options.n || 1, model.model_identifier);
  }

  // 暂只支持 OpenAI 兼容格式的 edits 接口
  return editImageOpenAICompat(model, prompt, options, fetch);
}

// 同步返回视频结果缓存（chat completions 格式可能同步返回视频URL）
const syncVideoResults = new Map();

// ============ 视频生成 (文生视频 / 图生视频) ============
/**
 * 提交视频生成任务（异步）
 * 支持 OpenAI 兼容格式的视频生成接口
 * @param {number} modelId 模型ID
 * @param {string} prompt 提示词
 * @param {object} options 选项 { duration, size, ref_image, ratio }
 * @returns {Promise<{ task_id: string, mock?: boolean }>}
 */
async function submitVideoTask(modelId, prompt, options = {}) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) {
    throw new Error('模型不存在或已禁用');
  }
  if (model.type !== 'video') {
    throw new Error('该模型类型不是视频模型');
  }

  const fetch = globalThis.fetch || require('node-fetch');

  // 演示模式
  if (model.api_key.includes('example') || model.api_key.includes('请修改') || model.api_endpoint.includes('api.example.com')) {
    const mockTaskId = 'mock_' + Date.now();
    return { task_id: mockTaskId, mock: true };
  }

  try {
    const isChatCompletionsFormat = model.api_endpoint.includes('/chat/completions');
    const isPaipuVideoAPI = model.api_endpoint.includes('api.paipu.net') && model.api_endpoint.includes('/v1/videos');
    const isMinimaxVideoAPI = model.api_endpoint.includes("/v1/video/generations") || model.api_endpoint.includes("mzsjai.com");
    const isZiklVideoAPI = (model.api_endpoint.includes('img.zikl.dev') || model.api_endpoint.includes('/v1/videos')) && !isPaipuVideoAPI && !isMinimaxVideoAPI;
    const isImageMode = options.ref_image && options.ref_image.length > 0;

    const isRef2VA = (model.model_identifier || "").toLowerCase().includes("ref2va");

    // ===== mzsjai /v1/videos 异步API（MiniMax H3 等模型） =====
    if (isMinimaxVideoAPI) {
      const duration = parseInt(options.duration) || 5;
      const validDuration = Math.min(duration, 15);

      let imageList = [];
      if (Array.isArray(options.ref_image)) {
        imageList = options.ref_image.filter(img => img && img.length > 0);
      } else if (options.ref_image && options.ref_image.length > 0) {
        imageList = [options.ref_image];
      }
      const isImageMode = imageList.length > 0;

      // mzsjai 要求图片必须是 https URL，先上传到 imgbb 图床
      let uploadedImageUrls = [];
      if (isImageMode) {
        try {
          console.log("[VIDEO_MZSJAI] 正在上传 " + imageList.length + " 张图片到 imgbb...");
          uploadedImageUrls = await uploadImagesLocal(imageList);
          console.log("[VIDEO_MZSJAI] 图片上传完成: " + uploadedImageUrls.map(u => u.slice(0,60)+"...").join(", "));
        } catch (e) {
          console.error("[VIDEO_MZSJAI] imgbb 上传失败:", e.message);
          throw new Error("图片上传失败：" + e.message);
        }
      }

      // mzsjai 统一格式：model / prompt / images / seconds
      const body = {
        model: model.model_identifier,
        prompt: prompt,
        seconds: validDuration,
        aspect_ratio: options.ratio || "16:9",
      };
      if (isImageMode) {
        body.images = uploadedImageUrls;
      }
      // FL2VA 首尾帧模式：用第一帧和最后一帧（必须传上传后的 https URL）
      if (options.mode === 'image_firstframe' && uploadedImageUrls.length >= 1) {
        body.image_start = uploadedImageUrls[0];
        if (uploadedImageUrls.length >= 2) {
          body.image_end = uploadedImageUrls[uploadedImageUrls.length - 1];
        }
      }

      const submitUrl = model.api_endpoint;
      const response = await fetch(submitUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + model.api_key,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      console.log("[VIDEO_MZSJAI] submit:", model.model_identifier, "mode=" + (options.mode || "text"), "→", JSON.stringify(data).slice(0, 300));
      if (!response.ok) {
        throw new Error(data.error?.message || data.msg || data.message || `API返回${response.status}`);
      }
      const taskId = data.id || data.task_id;
      if (!taskId) {
        throw new Error("API未返回任务ID: " + JSON.stringify(data).slice(0, 300));
      }
      return { task_id: String(taskId), raw: data, minimax_video_api: true };
    }

    // ===== paipu.net /v1/videos 视频API（Seedance 等模型） =====
    if (isPaipuVideoAPI) {
      if (!isImageMode) {
        throw new Error('该模型需要上传参考图片');
      }
      const duration = parseInt(options.duration) || 10;
      const validDuration = (duration === 15) ? 15 : 10;
      const aspectRatio = options.ratio || '16:9';
      // ref_image 可能是单张字符串，也可能是多张数组
      let imageList = [];
      if (Array.isArray(options.ref_image)) {
        imageList = options.ref_image.filter(img => img && img.length > 0);
      } else if (options.ref_image && options.ref_image.length > 0) {
        imageList = [options.ref_image];
      }

      const body = {
        model: model.model_identifier,
        prompt: prompt,
        duration: validDuration,
        aspect_ratio: aspectRatio,
        images: imageList,
      };
      const submitUrl = model.api_endpoint;
      const response = await fetch(submitUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + model.api_key,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      console.log('[VIDEO_PAIPU] submit:', JSON.stringify(body).slice(0, 200), '→', JSON.stringify(data).slice(0, 300));
      if (!response.ok) {
        throw new Error(data.error?.message || data.msg || data.message || `API返回${response.status}`);
      }
      const taskId = data.id || data.task_id;
      if (!taskId) {
        throw new Error('API未返回任务ID: ' + JSON.stringify(data).slice(0, 300));
      }
      return { task_id: String(taskId), raw: data, paipu_video_api: true };
    }

    // ===== zikl.dev /v1/videos JSON 异步接口（veo 视频生成专用） =====
    if (isZiklVideoAPI) {
      const duration = parseInt(options.duration) || 4;
      const aspectRatio = options.ratio || '16:9';

      const body = {
        model: model.model_identifier,
        prompt: prompt,
        duration: duration,
        aspect_ratio: aspectRatio,
        generate_audio: true,
      };

      // 图生视频：直接传 image_url（公网直链）
      if (isImageMode) {
        body.image_url = options.ref_image;
      }

      // 构建提交URL
      let baseUrl = model.api_endpoint.replace(/\/v1\/.*$/, '');
      if (model.api_endpoint.includes('img.zikl.dev') && !baseUrl.startsWith('http')) {
        baseUrl = 'https://img.zikl.dev';
      }
      const submitUrl = baseUrl + '/v1/videos';

      const response = await fetch(submitUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + model.api_key,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      console.log('[VIDEO_ZIKL] submit:', JSON.stringify(body).slice(0, 200), '→', JSON.stringify(data).slice(0, 300));
      if (!response.ok) {
        throw new Error(data.error?.message || data.msg || data.message || `API返回${response.status}`);
      }

      const taskId = data.id || data.task_id;
      if (!taskId) {
        throw new Error('API未返回任务ID: ' + JSON.stringify(data).slice(0, 300));
      }
      return { task_id: String(taskId), raw: data, zikl_video_api: true };
    }

    let body;
    let submitUrl = model.api_endpoint;

    if (isChatCompletionsFormat) {
      // ===== 新中转站格式：OpenAI Chat Completions 风格 =====
      // messages 必填，视频参数(duration/aspect_ratio/fps)放顶层
      const content = isImageMode
        ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: options.ref_image } },
          ]
        : prompt;

      // 在prompt里也加上比例、时长描述，双保险
      const ratioDesc = options.ratio || '1:1';
      const durDesc = parseInt(options.duration) || 5;
      const enhancedPrompt = `[VIDEO ASPECT RATIO: ${ratioDesc}] [VIDEO DURATION: ${durDesc}s]\n\nIMPORTANT: This video MUST be generated in ${ratioDesc} aspect ratio. Do NOT generate 16:9. The canvas must be exactly ${ratioDesc}.\n\n${prompt}`;
      const finalContent = isImageMode
        ? [
            { type: 'text', text: enhancedPrompt },
            { type: 'image_url', image_url: { url: options.ref_image } },
          ]
        : enhancedPrompt;

      body = {
        model: model.model_identifier,
        messages: [
          { role: 'user', content: finalContent },
        ],
        duration: parseInt(options.duration) || 5,
        aspect_ratio: options.ratio || '1:1',
        fps: options.fps || 24,
      };
    } else {
      // ===== lk888 旧格式 =====
      body = {
        model: model.model_identifier,
        prompt: prompt,
        params: {
          aspect_ratio: options.ratio || '1:1',
          duration: String(options.duration || 5),
          generation_mode: options.model_mode || options.mode || 'fast',
          generation_type: isImageMode ? 'IMAGE' : 'TEXT',
          quality: '720p',
        },
      };
      if (isImageMode) {
        body.params.images = [options.ref_image];
      }
    }

    const response = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + model.api_key,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    console.log("[VIDEO_DEBUG] request body:", JSON.stringify(body));
    if (!response.ok) {
      throw new Error(data.msg || data.error?.message || data.message || `API返回${response.status}`);
    }

    if (isChatCompletionsFormat) {
    console.log("[VIDEO_DEBUG] response:", JSON.stringify(data).slice(0, 500));
      // chat completions 格式：先判断是同步返回还是异步任务
      // 尝试从 choices / output 中提取视频URL
      console.log('[VIDEO_CHAT_RESPONSE]', JSON.stringify(data).slice(0, 2000));
      let videoUrl = null;

      // 尝试多种常见的视频返回位置
      if (data.choices && data.choices[0]?.message?.content) {
        const content = data.choices[0].message.content;
        if (typeof content === 'string') {
          if (content.startsWith('http') || content.startsWith('data:')) {
            videoUrl = content;
          } else {
            // 从文本/markdown/html 代码块里提取视频URL
            const urlMatch = content.match(/https?:\/\/[^\s"'<>`]+\.(mp4|webm|mov|avi)(\?[^\s"'<>`]*)?/i);
            if (urlMatch) {
              videoUrl = urlMatch[0];
            }
          }
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.video_url || part.video) {
              videoUrl = part.video_url || part.video;
              break;
            }
            if (part.image_url?.url && (part.image_url.url.includes('.mp4') || part.image_url.url.includes('video'))) {
              videoUrl = part.image_url.url;
              break;
            }
          }
        }
      }
      if (!videoUrl && data.output) {
        videoUrl = data.output.video_url
          || data.output.video
          || data.output.result_url
          || (data.output.choices?.[0]?.message?.video_url);
      }
      if (!videoUrl && data.data) {
        videoUrl = data.data.video_url || data.data.result_url;
      }

      if (videoUrl && typeof videoUrl === 'string' && (videoUrl.startsWith('http') || videoUrl.startsWith('data:'))) {
        // 同步返回视频
        const syncTaskId = 'sync_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        syncVideoResults.set(syncTaskId, { video_url: videoUrl });
        return { task_id: syncTaskId, raw: data, sync: true };
      }

      // 异步任务：提取 task_id
      const taskId = data.task_id
        || data.data?.task_id
        || data.id;
      if (!taskId) {
        throw new Error('API未返回任务ID且未找到视频URL: ' + JSON.stringify(data).slice(0, 500));
      }
      return { task_id: String(taskId), raw: data };
    }

    // 旧格式：提取任务ID
    const taskId = data.task_id
      || data.data?.task_id
      || data.data?.['任务ids']?.[0]
      || data.id;
    if (!taskId) {
      throw new Error('API未返回任务ID: ' + JSON.stringify(data).slice(0, 300));
    }

    return { task_id: String(taskId), raw: data };
  } catch (err) {
    console.error('视频任务提交失败:', err.message);
    throw err;
  }
}

/**
 * 查询视频生成任务状态
 * @param {number} modelId 模型ID
 * @param {string} taskId 任务ID
 * @returns {Promise<{ status: 'pending'|'processing'|'succeeded'|'failed', video_url?: string, error?: string }>}
 */
async function getVideoTaskStatus(modelId, taskId) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) {
    throw new Error('模型不存在或已禁用');
  }

  // 演示模式 - 模拟30秒后完成
  if (taskId.startsWith('mock_')) {
    const startTime = parseInt(taskId.replace('mock_', ''));
    const elapsed = Date.now() - startTime;
    if (elapsed < 15000) {
      return { status: 'processing', progress: Math.floor(elapsed / 150) };
    }
    return {
      status: 'succeeded',
      video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
      mock: true,
    };
  }

  // 同步返回的视频（chat completions 同步格式）
  if (taskId.startsWith('sync_')) {
    const cached = syncVideoResults.get(taskId);
    if (cached && cached.video_url) {
      return { status: 'succeeded', video_url: cached.video_url, sync: true };
    }
    return { status: 'failed', error: '同步视频结果丢失' };
  }

  const fetch = globalThis.fetch || require('node-fetch');

  try {
    const isChatCompletionsFormat = model.api_endpoint.includes('/chat/completions');
    const isPaipuVideoAPI = model.api_endpoint.includes('api.paipu.net') && model.api_endpoint.includes('/v1/videos');
    const isMinimaxVideoAPI = model.api_endpoint.includes('/v1/video/generations') || model.api_endpoint.includes('mzsjai.com');
    const isZiklVideoAPI = (model.api_endpoint.includes('img.zikl.dev') || model.api_endpoint.includes('/v1/videos')) && !isPaipuVideoAPI && !isMinimaxVideoAPI;

    let queryUrl;
    if (isPaipuVideoAPI) {
      // paipu /v1/videos/{id} 状态查询
      queryUrl = model.api_endpoint + '/' + encodeURIComponent(taskId);
    } else if (isZiklVideoAPI) {
      // zikl /v1/videos/{id} 格式
      let baseUrl = model.api_endpoint.replace(/\/v1\/.*$/, '');
      if (model.api_endpoint.includes('img.zikl.dev') && !baseUrl.startsWith('http')) {
        baseUrl = 'https://img.zikl.dev';
      }
      queryUrl = baseUrl + '/v1/videos/' + encodeURIComponent(taskId);
    } else if (isMinimaxVideoAPI) {
      // mzsjai / MiniMax H3 /v1/videos/{id} 格式
      let baseUrl = model.api_endpoint.replace(/\/v1\/.*/, '');
      if (!baseUrl.startsWith('http')) baseUrl = 'https://mzsjai.com';
      queryUrl = baseUrl + '/v1/videos/' + encodeURIComponent(taskId);
    } else if (isChatCompletionsFormat) {
      // chat completions 中转站：尝试 /v1/operations/{task_id} 格式查询状态
      const baseUrl = model.api_endpoint.replace(/\/v1\/.*$/, '');
      queryUrl = baseUrl + '/v1/operations/' + encodeURIComponent(taskId);
    } else {
      // lk888 格式
      const baseUrl = model.api_endpoint.replace(/\/v1\/.*$/, '');
      queryUrl = baseUrl + '/v1/skills/task-status?task_id=' + encodeURIComponent(taskId);
    }

    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + model.api_key,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    console.log('[VIDEO_STATUS] query:', model.model_identifier, 'task=' + taskId, 'status_raw=' + (data.status || data.state || 'unknown'), JSON.stringify(data).slice(0, 300));
    if (!response.ok) {
      return { status: 'failed', error: data.error?.message || data.msg || data.message || 'API返回' + response.status };
    }

    if (isPaipuVideoAPI) {
      // paipu /v1/videos 格式：status = queued/processing/succeeded/failed
      const state = data.status || 'processing';
      if (state === 'succeeded' || state === 'completed' || state === 'success') {
        try {
          const contentUrl = model.api_endpoint + '/' + encodeURIComponent(taskId) + '/content';
          const contentResp = await fetch(contentUrl, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + model.api_key },
          });
          const contentData = await contentResp.json();
          console.log('[VIDEO_PAIPU] content:', JSON.stringify(contentData).slice(0, 300));
          const vUrl = contentData.video_url
            || contentData.url
            || contentData.result_url
            || (contentData.data && contentData.data.video_url)
            || (Array.isArray(contentData.videos) && contentData.videos[0] && contentData.videos[0].url);
          return { status: 'succeeded', video_url: vUrl || '', raw: data };
        } catch (contentErr) {
          console.error('[VIDEO_PAIPU] 获取视频地址失败:', contentErr.message);
          const vUrl = data.video_url || data.url || data.result_url || (data.output && data.output.video_url);
          return { status: 'succeeded', video_url: vUrl || '', raw: data };
        }
      }
      if (state === 'failed' || state === 'error') {
        return { status: 'failed', error: (data.error && data.error.message) || data.error || data.message || '生成失败', raw: data };
      }
      return { status: 'processing', progress: data.progress || 0, raw: data };
    }

    if (isZiklVideoAPI) {
      // zikl /v1/videos 格式：status = queued/in_progress/completed/failed
      const state = data.status || 'processing';
      if (state === 'completed' || state === 'succeeded' || state === 'success') {
        const vUrl = data.url
          || data.video_url
          || data.result_url
          || data.output?.video_url
          || data.data?.video_url;
        return { status: 'succeeded', video_url: vUrl || '', raw: data };
      }
      if (state === 'failed' || state === 'error') {
        return { status: 'failed', error: data.error?.message || data.error || data.message || '生成失败', raw: data };
      }
      return { status: 'processing', progress: data.progress || 0, raw: data };
    }

    if (isMinimaxVideoAPI) {
      const mzsjaiBaseUrl = model.api_endpoint.replace(/\/v1\/.*/, "").replace(/\/$/, "") || "https://mzsjai.com";
      console.log('[VIDEO_STATUS] 命中 mzsjai/MiniMax 分支');
      // mzsjai / MiniMax H3 /v1/videos 格式：queued / in_progress / completed / failed
      const state = data.status || 'processing';
      if (state === 'completed' || state === 'succeeded' || state === 'success') {
        // content_url 需要带 API Key 访问，下载到本地再返回本地 URL
        const contentUrl = data.content_url || (data.metadata && data.metadata.url) || data.video_url || data.url;
        if (contentUrl) {
          try {
            const localPath = await downloadVideoToLocal(contentUrl, model.api_key, taskId);
            return { status: 'succeeded', video_url: localPath, raw: data };
          } catch (e) {
            console.error('[VIDEO_MZSJAI] 视频下载失败:', e.message);
            return { status: 'failed', error: '视频下载失败：' + e.message, raw: data };
          }
        }
        return { status: 'succeeded', video_url: '', raw: data };
      }
      if (state === 'failed' || state === 'error') {
        return { status: 'failed', error: (data.error && data.error.message) || data.error || data.message || '生成失败', raw: data };
      }
      // 状态还是处理中，但 completed_at 有值时，试探性请求 content 接口
      // 防止 mzsjai 状态接口更新延迟导致一直等
      if (data.completed_at && data.status !== 'completed') {
        try {
          const probeUrl = mzsjaiBaseUrl + '/v1/videos/' + encodeURIComponent(taskId) + '/content';
          const probeResp = await fetch(probeUrl, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + model.api_key },
          });
          if (probeResp.ok) {
            const contentType = probeResp.headers.get('content-type') || '';
            // 如果返回的是视频流（不是 JSON），说明视频已经好了
            if (contentType.includes('video/') || contentType.includes('application/octet-stream') || probeResp.url.includes('.mp4')) {
              console.log('[VIDEO_MZSJAI] 状态仍为 in_progress 但视频已就绪，直接下载');
              const localPath = await downloadVideoToLocal(probeUrl, model.api_key, taskId);
              return { status: 'succeeded', video_url: localPath, raw: data };
            }
            // 如果返回的是 JSON，看看是不是错误
            const probeData = await probeResp.json();
            if (probeData.error) {
              // 还没好，继续等
              console.log('[VIDEO_MZSJAI] content 探测未就绪:', probeData.error.message || probeData.error);
            }
          }
        } catch (probeErr) {
          // 探测失败不影响正常流程
          console.log('[VIDEO_MZSJAI] content 探测异常（继续等待）:', probeErr.message);
        }
      }
      // queued / in_progress / running 都算处理中
      return { status: 'processing', progress: data.progress || 0, raw: data };
    }

    if (isChatCompletionsFormat) {
      // chat completions 格式状态：status 字段可能是 running/completed/failed
      const state = data.status || data.state || 'processing';
      const isDone = data.done === true || data.is_final === true;

      if (state === 'completed' || state === 'success' || (isDone && data.result_url)) {
        const vUrl = data.result_url
          || data.video_url
          || data.output?.video_url
          || data.output?.result_url
          || data.data?.result_url
          || data.data?.video_url;
        return { status: 'succeeded', video_url: vUrl || '', raw: data };
      }
      if (state === 'failed' || state === 'error' || (isDone && !data.result_url)) {
        return { status: 'failed', error: data.error || data.message || '生成失败', raw: data };
      }
      return { status: 'processing', progress: data.progress || 0, raw: data };
    }

    // lk888 格式：state 字段（pending/running/success/failed）
    const state = data.state || 'pending';
    const isFinal = data.is_final === true;

    let result = { status: 'processing' };

    if (state === 'success') {
      result.status = 'succeeded';
      if (data.result_url) result.video_url = data.result_url;
    } else if (state === 'failed') {
      result.status = 'failed';
      result.error = data.error || data.msg || '生成失败';
    } else {
      result.status = 'processing';
      if (data.progress != null) {
        const pct = String(data.progress).replace('%', '');
        const num = parseInt(pct, 10);
        if (!isNaN(num)) result.progress = num;
      }
    }

    return result;
  } catch (err) {
    console.error('视频任务状态查询失败:', err.message);
    return { status: 'processing' };
  }
}
module.exports = {
  generateImage,
  generateText,
  generateAudio,
  editImage,
  submitVideoTask,
  getVideoTaskStatus,
  getEnabledModels,
  getModelPrice,
  calculateCost,
};

/**
 * 视觉理解（VLM）：分析图片/视频内容，生成描述或提示词
 * 支持两种格式：
 *   1. OpenAI chat/completions 格式（content 数组含 image_url）
 *   2. /v1/responses 格式（input 数组含 input_image）
 */
async function analyzeMedia(modelId, prompt, options = {}) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) {
    throw new Error('模型不存在或已禁用');
  }

  const fetch = globalThis.fetch || require('node-fetch');

  if (model.api_key.includes('example') || model.api_key.includes('请修改') || model.api_endpoint.includes('api.example.com')) {
    return { text: '【演示模式】这是一张精美的图片，包含丰富的色彩和细节。请配置真实API后使用。', mock: true };
  }

  const isResponsesFormat = model.api_endpoint.includes('/v1/responses');
  const isChatCompletionsFormat = model.api_endpoint.includes('/chat/completions');

  // 视频输入且走 responses 格式时，部分中转不支持 input_video，降级到 chat completions 格式
  const hasVideo = !!options.video_url;
  const useChatFormatForVideo = isResponsesFormat && hasVideo;

  let body, endpoint;

  if (isResponsesFormat && !useChatFormatForVideo) {
    const userContent = [];
    if (options.image_url) {
      userContent.push({ type: 'input_image', image_url: options.image_url });
    }
    if (options.video_url) {
      userContent.push({ type: 'input_video', video_url: options.video_url });
    }
    userContent.push({ type: 'input_text', text: prompt });

    body = {
      model: model.model_identifier,
      input: [
        { role: 'user', content: userContent }
      ],
    };
    if (options.system_prompt) {
      body.instructions = options.system_prompt;
    }
    endpoint = model.api_endpoint;

  } else if (useChatFormatForVideo) {
    // 视频输入时，用 chat completions 格式请求（部分中转 responses 不支持 input_video）
    const chatEndpoint = model.api_endpoint.replace('/v1/responses', '/v1/chat/completions');
    const content = [];
    if (options.image_url) {
      content.push({ type: 'image_url', image_url: { url: options.image_url } });
    }
    if (options.video_url) {
      content.push({ type: 'video_url', video_url: { url: options.video_url } });
    }
    content.push({ type: 'text', text: prompt });

    const messages = [];
    if (options.system_prompt) {
      messages.push({ role: 'system', content: options.system_prompt });
    }
    messages.push({ role: 'user', content });

    body = {
      model: model.model_identifier,
      messages,
      max_tokens: options.max_tokens || 2000,
      temperature: options.temperature ?? 0.7,
    };
    endpoint = chatEndpoint;

  } else if (isChatCompletionsFormat) {
    const content = [];
    if (options.image_url) {
      content.push({ type: 'image_url', image_url: { url: options.image_url } });
    }
    if (options.video_url) {
      content.push({ type: 'video_url', video_url: { url: options.video_url } });
    }
    content.push({ type: 'text', text: prompt });

    const messages = [];
    if (options.system_prompt) {
      messages.push({ role: 'system', content: options.system_prompt });
    }
    messages.push({ role: 'user', content });

    body = {
      model: model.model_identifier,
      messages,
      max_tokens: options.max_tokens || 2000,
      temperature: options.temperature ?? 0.7,
    };
    endpoint = model.api_endpoint;

  } else {
    throw new Error('不支持的API格式，该模型无法用于视觉理解');
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + model.api_key,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error('视觉理解API调用失败: ' + response.status + ' - ' + errText.slice(0, 300));
    }

    const data = await response.json();
    let text = '';

    if (isResponsesFormat && !useChatFormatForVideo) {
      if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.content && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c.type === 'output_text' && c.text) {
                text += c.text;
              }
            }
          }
        }
      }
      if (!text && data.output_text) {
        text = data.output_text;
      }
    } else {
      text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      if (typeof text === 'object' && Array.isArray(text)) {
        text = text.map(function(t) { return t.text || ''; }).join('\n');
      }
    }

    return { text: text, raw: data };
  } catch (err) {
    console.error('视觉理解API调用失败:', err.message);
    throw err;
  }
}

/**
 * 视频换脸/换人：参考视频 + 角色参考图生成新视频
 */
async function submitFaceSwapTask(modelId, prompt, options = {}) {
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND status = 1').get(modelId);
  if (!model) {
    throw new Error('模型不存在或已禁用');
  }

  const fetch = globalThis.fetch || require('node-fetch');
  const isChatCompletionsFormat = model.api_endpoint.includes('/chat/completions');
  const isZiklVideoAPI = model.api_endpoint.includes('img.zikl.dev') || model.api_endpoint.includes('/v1/videos');

  if (model.api_key.includes('example') || model.api_key.includes('请修改') || model.api_endpoint.includes('api.example.com')) {
    var mockTaskId = 'mock_' + Date.now();
    return { task_id: mockTaskId, mock: true };
  }

  try {
    var duration = parseInt(options.duration) || 5;
    var aspectRatio = options.ratio || '16:9';
    var refVideo = options.video_url;
    var refImage = options.image_url;

    if (!refVideo || !refImage) {
      throw new Error('视频换人需要同时提供参考视频和角色参考图');
    }

    if (isZiklVideoAPI) {
      var baseUrl = model.api_endpoint.replace(/\/v1\/.*$/, '');
      if (model.api_endpoint.includes('img.zikl.dev') && !baseUrl.startsWith('http')) {
        baseUrl = 'https://img.zikl.dev';
      }
      var submitUrl = baseUrl + '/v1/videos';
      var body = {
        model: model.model_identifier,
        prompt: prompt,
        duration: duration,
        aspect_ratio: aspectRatio,
        image_url: refImage,
        generate_audio: true,
      };
      var response = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + model.api_key },
        body: JSON.stringify(body),
      });
      var data = await response.json();
      if (!response.ok) {
        throw new Error((data.error && data.error.message) || data.msg || ('API返回' + response.status));
      }
      var taskId = data.id || data.task_id;
      if (!taskId) throw new Error('API未返回任务ID');
      return { task_id: String(taskId), zikl_video_api: true, raw: data };
    }

    if (isChatCompletionsFormat) {
      var content = [
        { type: 'text', text: prompt },
        { type: 'video_url', video_url: { url: refVideo } },
        { type: 'image_url', image_url: { url: refImage } },
      ];
      var body = {
        model: model.model_identifier,
        messages: [{ role: 'user', content: content }],
        duration: duration,
        aspect_ratio: aspectRatio,
        fps: options.fps || 24,
      };
      var response = await fetch(model.api_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + model.api_key },
        body: JSON.stringify(body),
      });
      var data = await response.json();
      console.log('[FACESWAP_DEBUG] submit:', JSON.stringify(data).slice(0, 500));
      if (!response.ok) {
        throw new Error(data.msg || (data.error && data.error.message) || ('API返回' + response.status));
      }

      var videoUrl = null;
      if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
        var c = data.choices[0].message.content;
        if (typeof c === 'string' && c.startsWith('http')) videoUrl = c;
      }
      if (!videoUrl && data.output && data.output.video_url) videoUrl = data.output.video_url;
      if (!videoUrl && data.data && data.data.video_url) videoUrl = data.data.video_url;

      if (videoUrl && typeof videoUrl === 'string' && videoUrl.startsWith('http')) {
        var syncTaskId = 'sync_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        syncVideoResults.set(syncTaskId, { video_url: videoUrl });
        return { task_id: syncTaskId, sync: true, raw: data };
      }

      var taskId = data.task_id || (data.data && data.data.task_id) || data.id;
      if (!taskId) throw new Error('API未返回任务ID且未找到视频URL');
      return { task_id: String(taskId), raw: data };
    }

    throw new Error('不支持的API格式，该模型无法用于视频换人');
  } catch (err) {
    console.error('视频换人任务提交失败:', err.message);
    throw err;
  }
}

module.exports.analyzeMedia = analyzeMedia;
module.exports.submitFaceSwapTask = submitFaceSwapTask;
