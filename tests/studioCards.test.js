const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_STUDIO_CARDS } = require('../config/studioCardDefaults');
const {
  normalizeStatus,
  normalizeStringList,
  validateStudioCardInput,
} = require('../utils/studioCardInput');

test('内置首页卡片数据完整且可安全跳转', () => {
  assert.equal(DEFAULT_STUDIO_CARDS.length, 16);

  const hrefs = new Set();
  const titles = new Set();
  const categories = new Set();
  for (const card of DEFAULT_STUDIO_CARDS) {
    assert.ok(card.title, '卡片缺少名称');
    assert.ok(!titles.has(card.title), '卡片名称重复: ' + card.title);
    titles.add(card.title);
    assert.ok(card.description, card.title + ' 缺少描述');
    assert.ok(card.icon, card.title + ' 缺少图标');
    assert.ok(card.category, card.title + ' 缺少分类');
    assert.ok(card.href, card.title + ' 缺少链接');
    assert.ok(!hrefs.has(card.href), '卡片链接重复: ' + card.href);
    assert.ok(!card.href.startsWith('//'), card.title + ' 链接不能是协议相对地址');
    assert.ok(!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(card.href), card.title + ' 链接不能是外部协议');
    hrefs.add(card.href);
    categories.add(card.category);
    assert.ok(Array.isArray(card.tags), card.title + ' 标签必须是数组');
    assert.ok(Array.isArray(card.keywords), card.title + ' 关键词必须是数组');
    assert.ok(Number.isInteger(card.sort_order), card.title + ' 缺少排序');
  }

  assert.deepEqual(
    [...categories].sort(),
    ['办公', '工具', '文案', '电商', '社媒', '设计'].sort()
  );

  const ecommerceCards = DEFAULT_STUDIO_CARDS.filter(card => card.category === '电商');
  assert.equal(ecommerceCards.length, 1, '电商入口只保留一个');
  assert.equal(ecommerceCards[0].title, '电商工作室');
  assert.equal(ecommerceCards[0].href, 'workflow.html#studio');
});

test('工作室卡片输入会规范化文本、标签和默认值', () => {
  const result = validateStudioCardInput({
    title: '  新工作室  ',
    description: '  描述  ',
    icon: '',
    href: 'workflow.html#studio',
    category: ' 电商 ',
    tags: '电商，图片, 电商',
    highlight: '🔥 热门',
    highlight_style: '',
    keywords: '套图, 主图',
    sort_order: '30',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.title, '新工作室');
  assert.equal(result.value.description, '描述');
  assert.equal(result.value.icon, '✨');
  assert.equal(result.value.category, '电商');
  assert.deepEqual(result.value.tags, ['电商', '图片']);
  assert.deepEqual(result.value.keywords, ['套图', '主图']);
  assert.equal(result.value.highlight_style, 'hot');
  assert.equal(result.value.sort_order, 30);
  assert.equal(result.value.status, 1);
});

test('工作室卡片拒绝危险链接和越界字段', () => {
  const base = {
    title: '卡片',
    icon: '✨',
    href: 'image.html',
    category: '工具',
  };

  for (const href of ['javascript:alert(1)', 'data:text/html,hi', 'https://evil.example/x', '//evil.example/x', 'a\\b']) {
    const result = validateStudioCardInput({ ...base, href });
    assert.ok(result.error, '应拒绝链接: ' + href);
  }

  assert.ok(validateStudioCardInput({ ...base, title: '' }).error);
  assert.ok(validateStudioCardInput({ ...base, title: 'x'.repeat(61) }).error);
  assert.ok(validateStudioCardInput({ ...base, category: '' }).error);
  assert.ok(validateStudioCardInput({ ...base, category: '全部' }).error);
  assert.ok(validateStudioCardInput({ ...base, sort_order: 10000 }).error);
  assert.ok(validateStudioCardInput({ ...base, status: 2 }).error);
  assert.ok(validateStudioCardInput({ ...base, highlight_style: 'pink' }).error);
  assert.ok(validateStudioCardInput({ ...base, tags: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }).error);
});

test('列表与状态转换保持边界清晰', () => {
  assert.deepEqual(normalizeStringList('a，b, a', { label: '标签', maxItems: 2, maxLength: 5 }).value, ['a', 'b']);
  assert.ok(normalizeStringList('abcdef', { label: '标签', maxItems: 2, maxLength: 5 }).error);
  assert.equal(normalizeStatus(0), 0);
  assert.equal(normalizeStatus('1'), 1);
  assert.equal(normalizeStatus('', 1), 1);
  assert.equal(normalizeStatus(2), null);
  assert.equal(normalizeStatus('abc'), null);
});
