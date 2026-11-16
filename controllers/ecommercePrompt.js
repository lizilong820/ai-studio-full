// 电商套图提示词构建（纯函数，无数据库依赖）
//
// 默认输出必须与旧版 /api/generate/ecommerce 完全一致，
// 新增参数只在用户主动填写时才追加内容，避免改变已经验证过的出图效果。

const SIZE_MAP = Object.freeze({
  '1:1': '1024x1024',
  '3:4': '768x1024',
  '16:9': '1024x576',
  '9:16': '576x1024',
  '4:3': '1024x768'
});

const BASE_NEGATIVE_TOKENS = Object.freeze([
  'text', 'words', 'letters', 'characters', 'writing',
  'watermark', 'logo', 'signature', 'caption',
  'ugly', 'distorted', 'blurry', 'low quality'
]);

const TEXT_NEGATIVE_TOKENS = new Set([
  'text', 'words', 'letters', 'characters', 'writing', 'caption'
]);

const LANGUAGE_LABELS = Object.freeze({
  '中文': 'Chinese',
  '英文': 'English',
  '日文': 'Japanese',
  '韩文': 'Korean',
  '多语混合': 'mixed-language'
});

const DEFAULT_NEGATIVE_PROMPT = BASE_NEGATIVE_TOKENS.join(', ');

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function normalizeStringList(value, maxItems, maxLength) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,，\n]/) : []);
  const result = [];
  for (const item of raw) {
    const text = cleanString(item, maxLength);
    if (text && !result.includes(text)) result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeDataUrl(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(text)) return '';
  return text;
}

function normalizeRefImages(value, maxItems) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  const result = [];
  for (const item of raw) {
    const dataUrl = normalizeDataUrl(item);
    if (dataUrl) result.push(dataUrl);
    if (result.length >= maxItems) break;
  }
  return result;
}

function buildEcommercePrompt(input = {}) {
  const sellingPoints = cleanString(input.selling_points, 4000);
  const platform = cleanString(input.platform, 80) || 'general';
  const market = cleanString(input.market, 80) || 'global';
  const tone = cleanString(input.tone, 40) || 'neutral';

  let prominence = Number.parseInt(input.prominence, 10);
  if (!Number.isFinite(prominence)) prominence = 70;
  prominence = Math.max(0, Math.min(100, prominence));

  // 新字段优先；空数组时回退到旧版单图字段，保证老页面 / 老客户端行为不变
  const productSource = Array.isArray(input.product_images) && input.product_images.length > 0
    ? input.product_images
    : input.ref_image;
  const productImages = normalizeRefImages(productSource, 3);
  const styleImages = normalizeRefImages(input.style_ref_image, 1);
  const refImages = productImages.concat(styleImages);

  const rawTextSetting = cleanString(input.text_setting, 20);
  const textSetting = ['none', 'auto', 'custom'].includes(rawTextSetting) ? rawTextSetting : 'none';
  const language = cleanString(input.language, 20) || '中文';
  const customText = cleanString(input.custom_text, 200);
  const textEnabled = textSetting === 'auto' || (textSetting === 'custom' && customText.length > 0);

  let prompt = `Generate high quality e-commerce product image for: ${sellingPoints}.
      Platform: ${platform}, Market: ${market},
      Style: ${tone}, Product prominence: ${prominence}%.
      The product should be the main focus in a beautiful scene.`;

  // 多商品角度 / 风格参考图：只在用户提供时补充说明，单图默认路径保持旧版提示词不变
  if (productImages.length > 1 && styleImages.length > 0) {
    prompt += ` Images 1-${productImages.length} show the same product from different angles; keep its shape, color, material and logo exactly consistent. Image ${productImages.length + 1} is a style reference: borrow its lighting, color palette, composition and mood, but do not copy its product.`;
  } else if (productImages.length > 1) {
    prompt += ` The ${productImages.length} reference images show the same product from different angles; keep its shape, color, material and logo exactly consistent.`;
  } else if (productImages.length === 1 && styleImages.length > 0) {
    prompt += ' The first image is the product and the second image is a style reference: follow the reference image\'s lighting, color palette, composition and mood, but keep the product exactly as shown in the first image.';
  } else if (productImages.length === 0 && styleImages.length > 0) {
    prompt += ' Use the reference image only as a style reference: follow its lighting, color palette, composition and mood, but do not copy its product.';
  }

  if (textSetting === 'auto') {
    const languageLabel = LANGUAGE_LABELS[language] || 'Chinese';
    prompt += ` Include short, tasteful marketing copy in ${languageLabel}, correctly spelled and naturally integrated into the layout.`;
  } else if (textSetting === 'custom' && customText) {
    prompt += ` Include exactly this text in the image, correctly spelled: "${customText.replace(/"/g, '\'')}".`;
  }

  const negativeTokens = BASE_NEGATIVE_TOKENS.filter(token => !(textEnabled && TEXT_NEGATIVE_TOKENS.has(token)));
  const forbidden = normalizeStringList(input.forbidden_elements, 20, 40);
  const avoid = cleanString(input.avoid_requirements, 500);
  const extraNegatives = forbidden.concat(avoid ? [avoid] : []);
  const negativePrompt = negativeTokens.concat(extraNegatives).join(', ');

  return {
    prompt,
    negativePrompt,
    size: SIZE_MAP[input.ratio] || '1024x1024',
    ratio: SIZE_MAP[input.ratio] ? input.ratio : '1:1',
    refImages,
    productImages,
    styleImages,
    textSetting,
    textEnabled
  };
}

module.exports = {
  SIZE_MAP,
  DEFAULT_NEGATIVE_PROMPT,
  buildEcommercePrompt
};
