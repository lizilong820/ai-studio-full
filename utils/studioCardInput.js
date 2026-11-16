// 首页工作室卡片的输入校验与规范化（纯函数，不依赖数据库）

const HIGHLIGHT_STYLES = new Set(['', 'hot', 'new']);

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeStringList(value, { label, maxItems, maxLength }) {
  const rawItems = Array.isArray(value) ? value : cleanText(value).split(/[,，]/);
  const items = [];

  for (const raw of rawItems) {
    const item = cleanText(raw);
    if (!item) continue;
    if (Array.from(item).length > maxLength) {
      return { error: `${label}单个不能超过 ${maxLength} 个字符` };
    }
    if (!items.includes(item)) items.push(item);
  }

  if (items.length > maxItems) {
    return { error: `${label}最多 ${maxItems} 个` };
  }

  return { value: items };
}

function normalizeHref(value) {
  const href = cleanText(value);
  if (!href) return { error: '请填写卡片链接' };
  if (href.length > 300) return { error: '卡片链接不能超过 300 个字符' };

  // 只允许站内相对地址，拒绝 javascript:、data:、//evil.com 等协议或跨站跳转
  if (href.startsWith('//') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) {
    return { error: '卡片链接必须是站内相对地址' };
  }
  if (/[\\\u0000-\u001F\u007F]/.test(href)) {
    return { error: '卡片链接格式不正确' };
  }

  try {
    const parsed = new URL(href, 'https://studio.invalid/');
    if (parsed.origin !== 'https://studio.invalid') {
      return { error: '卡片链接必须是站内相对地址' };
    }
  } catch (error) {
    return { error: '卡片链接格式不正确' };
  }

  return { value: href };
}

function normalizeStatus(value, defaultValue = 1) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === 1 || value === '1' || value === true) return 1;
  if (value === 0 || value === '0' || value === false) return 0;
  return null;
}

function normalizeSortOrder(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 9999) return null;
  return number;
}

function validateStudioCardInput(body) {
  const input = body && typeof body === 'object' ? body : {};

  const title = cleanText(input.title);
  if (!title) return { error: '请填写卡片名称' };
  if (Array.from(title).length > 60) return { error: '卡片名称不能超过 60 个字符' };

  const description = cleanText(input.description);
  if (Array.from(description).length > 300) return { error: '卡片描述不能超过 300 个字符' };

  const icon = cleanText(input.icon) || '✨';
  if (Array.from(icon).length > 16) return { error: '图标不能超过 16 个字符' };

  const category = cleanText(input.category);
  if (!category) return { error: '请填写卡片分类' };
  if (category === '全部') return { error: '分类名称不能使用「全部」' };
  if (Array.from(category).length > 20) return { error: '卡片分类不能超过 20 个字符' };

  const hrefResult = normalizeHref(input.href);
  if (hrefResult.error) return { error: hrefResult.error };

  const tagsResult = normalizeStringList(input.tags, {
    label: '标签',
    maxItems: 8,
    maxLength: 20,
  });
  if (tagsResult.error) return { error: tagsResult.error };

  const keywordsResult = normalizeStringList(input.keywords, {
    label: '搜索关键词',
    maxItems: 30,
    maxLength: 30,
  });
  if (keywordsResult.error) return { error: keywordsResult.error };

  const highlight = cleanText(input.highlight);
  if (Array.from(highlight).length > 20) return { error: '高亮标签不能超过 20 个字符' };

  let highlightStyle = cleanText(input.highlight_style);
  if (!HIGHLIGHT_STYLES.has(highlightStyle)) return { error: '高亮样式不正确' };
  if (highlight && !highlightStyle) highlightStyle = 'hot';
  if (!highlight) highlightStyle = '';

  const credit = cleanText(input.credit);
  if (Array.from(credit).length > 40) return { error: '积分说明不能超过 40 个字符' };

  const sortOrder = normalizeSortOrder(input.sort_order);
  if (sortOrder === null) return { error: '排序必须是 0-9999 之间的整数' };

  const status = normalizeStatus(input.status, 1);
  if (status === null) return { error: '状态值不正确' };

  return {
    value: {
      title,
      description,
      icon,
      href: hrefResult.value,
      category,
      tags: tagsResult.value,
      highlight,
      highlight_style: highlightStyle,
      credit,
      keywords: keywordsResult.value,
      sort_order: sortOrder,
      status,
    },
  };
}

module.exports = {
  HIGHLIGHT_STYLES,
  normalizeStatus,
  normalizeStringList,
  normalizeHref,
  validateStudioCardInput,
};
