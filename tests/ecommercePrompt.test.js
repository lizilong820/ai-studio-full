const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEcommercePrompt,
  DEFAULT_NEGATIVE_PROMPT
} = require('../controllers/ecommercePrompt');

const PNG = 'data:image/png;base64,AAAA';
const JPG = 'data:image/jpeg;base64,BBBB';

test('默认提示词与旧版电商套图完全一致', () => {
  const built = buildEcommercePrompt({
    selling_points: '高端护肤精华液',
    platform: '淘宝 / 天猫',
    market: '中国大陆',
    tone: '暖色',
    prominence: '70',
    ref_image: PNG
  });

  assert.equal(built.prompt, `Generate high quality e-commerce product image for: 高端护肤精华液.
      Platform: 淘宝 / 天猫, Market: 中国大陆,
      Style: 暖色, Product prominence: 70%.
      The product should be the main focus in a beautiful scene.`);
  assert.equal(built.negativePrompt, DEFAULT_NEGATIVE_PROMPT);
  assert.equal(built.negativePrompt, 'text, words, letters, characters, writing, watermark, logo, signature, caption, ugly, distorted, blurry, low quality');
  assert.equal(built.size, '1024x1024');
  assert.deepEqual(built.refImages, [PNG]);
});

test('比例映射保持旧版尺寸，未知比例回退 1:1', () => {
  const cases = {
    '1:1': '1024x1024',
    '3:4': '768x1024',
    '16:9': '1024x576',
    '9:16': '576x1024',
    '4:3': '1024x768',
    custom: '1024x1024'
  };
  for (const [ratio, size] of Object.entries(cases)) {
    assert.equal(buildEcommercePrompt({ selling_points: '商品', ratio }).size, size, ratio);
  }
});

test('多商品角度会合并为参考图并补充一致性说明', () => {
  const built = buildEcommercePrompt({
    selling_points: '运动鞋',
    product_images: [PNG, JPG, 'data:image/webp;base64,CCCC'],
    style_ref_image: 'data:image/png;base64,DDDD'
  });

  assert.equal(built.refImages.length, 4);
  assert.equal(built.productImages.length, 3);
  assert.equal(built.styleImages.length, 1);
  assert.match(built.prompt, /Images 1-3 show the same product from different angles/);
  assert.match(built.prompt, /Image 4 is a style reference/);
});

test('只有风格参考图时明确区分商品图和参考图', () => {
  const built = buildEcommercePrompt({
    selling_points: '香水',
    ref_image: PNG,
    style_ref_image: JPG
  });
  assert.match(built.prompt, /The first image is the product and the second image is a style reference/);
  assert.doesNotMatch(built.prompt, /different angles/);
});

test('没有商品图、只有风格参考图时只借用风格不复制商品', () => {
  const built = buildEcommercePrompt({
    selling_points: '家居香薰',
    style_ref_image: PNG
  });
  assert.deepEqual(built.productImages, []);
  assert.deepEqual(built.styleImages, [PNG]);
  assert.match(built.prompt, /Use the reference image only as a style reference/);
  assert.doesNotMatch(built.prompt, /The first image is the product/);
});

test('自动文字模式会从负面词里移除文字限制', () => {
  const built = buildEcommercePrompt({
    selling_points: '咖啡礼盒',
    text_setting: 'auto',
    language: '英文'
  });
  assert.match(built.prompt, /marketing copy in English/);
  assert.doesNotMatch(built.negativePrompt, /(^|, )text(,|$)/);
  assert.match(built.negativePrompt, /watermark/);
  assert.match(built.negativePrompt, /low quality/);
});

test('自定义文案会原样写进提示词并处理引号', () => {
  const built = buildEcommercePrompt({
    selling_points: '坚果',
    text_setting: 'custom',
    custom_text: '限时 "8" 折'
  });
  assert.match(built.prompt, /Include exactly this text in the image/);
  assert.match(built.prompt, /限时 '8' 折/);
  assert.doesNotMatch(built.negativePrompt, /(^|, )letters(,|$)/);
});

test('自定义文案为空时保持不生成文字的旧行为', () => {
  const built = buildEcommercePrompt({
    selling_points: '坚果',
    text_setting: 'custom',
    custom_text: '   '
  });
  assert.equal(built.textEnabled, false);
  assert.equal(built.negativePrompt, DEFAULT_NEGATIVE_PROMPT);
  assert.doesNotMatch(built.prompt, /Include exactly this text/);
});

test('禁用元素和规避要求追加到负面提示词', () => {
  const built = buildEcommercePrompt({
    selling_points: '床品',
    forbidden_elements: ['人物', '红色', '人物'],
    avoid_requirements: '避免出现杂乱背景'
  });
  assert.match(built.negativePrompt, /人物/);
  assert.match(built.negativePrompt, /红色/);
  assert.match(built.negativePrompt, /避免出现杂乱背景/);
  assert.equal((built.negativePrompt.match(/人物/g) || []).length, 1);
});

test('0% 主体突出度不会被默认值覆盖', () => {
  const built = buildEcommercePrompt({ selling_points: '商品', prominence: '0' });
  assert.match(built.prompt, /Product prominence: 0%/);
});

test('非 data URL 的参考图会被忽略', () => {
  const built = buildEcommercePrompt({
    selling_points: '商品',
    product_images: ['https://example.com/a.png', 'not-an-image', PNG]
  });
  assert.deepEqual(built.refImages, [PNG]);
});
