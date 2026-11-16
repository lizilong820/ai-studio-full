// 首页工作室卡片：公开读取、首页搜索与后台 CRUD

const { db } = require('../database/db');
const { validateStudioCardInput, normalizeStatus } = require('../utils/studioCardInput');

function parseList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
  } catch (error) {
    return [];
  }
}

function serializeStudioCard(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    icon: row.icon,
    href: row.href,
    category: row.category,
    tags: parseList(row.tags),
    highlight: row.highlight,
    highlight_style: row.highlight_style,
    credit: row.credit,
    keywords: parseList(row.keywords),
    sort_order: row.sort_order,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toPublicCard(card) {
  return {
    id: card.id,
    title: card.title,
    description: card.description,
    icon: card.icon,
    href: card.href,
    category: card.category,
    tags: card.tags,
    highlight: card.highlight,
    highlight_style: card.highlight_style,
    credit: card.credit,
    sort_order: card.sort_order,
  };
}

function listAllStudioCards() {
  return db.prepare('SELECT * FROM studio_cards ORDER BY sort_order ASC, id ASC')
    .all()
    .map(serializeStudioCard);
}

function listVisibleStudioCards() {
  return db.prepare('SELECT * FROM studio_cards WHERE status = 1 ORDER BY sort_order ASC, id ASC')
    .all()
    .map(serializeStudioCard);
}

function getPublicStudioCards() {
  const cards = listVisibleStudioCards();
  const categories = [];
  for (const card of cards) {
    if (!categories.includes(card.category)) categories.push(card.category);
  }
  return { cards: cards.map(toPublicCard), categories };
}

function searchStudioCards(keyword) {
  const query = String(keyword || '').trim().toLowerCase();
  if (!query) return [];

  return listVisibleStudioCards()
    .filter(card => {
      const haystack = [
        card.title,
        card.category,
        card.description,
        ...card.tags,
        ...card.keywords,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    })
    .map(card => ({
      id: card.id,
      name: card.title,
      icon: card.icon,
      category: card.category,
      desc: card.description,
      href: card.href,
    }));
}

function getStudioCardById(id) {
  const row = db.prepare('SELECT * FROM studio_cards WHERE id = ?').get(id);
  return row ? serializeStudioCard(row) : null;
}

function createStudioCard(input) {
  const parsed = validateStudioCardInput(input);
  if (parsed.error) return parsed;

  const data = parsed.value;
  const result = db.prepare(`INSERT INTO studio_cards
    (title, description, icon, href, category, tags, highlight, highlight_style, credit, keywords, sort_order, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    data.title,
    data.description,
    data.icon,
    data.href,
    data.category,
    JSON.stringify(data.tags),
    data.highlight,
    data.highlight_style,
    data.credit,
    JSON.stringify(data.keywords),
    data.sort_order,
    data.status
  );

  return { id: Number(result.lastInsertRowid) };
}

function updateStudioCard(id, input) {
  const parsed = validateStudioCardInput(input);
  if (parsed.error) return parsed;

  const data = parsed.value;
  const result = db.prepare(`UPDATE studio_cards SET
    title = ?, description = ?, icon = ?, href = ?, category = ?, tags = ?,
    highlight = ?, highlight_style = ?, credit = ?, keywords = ?, sort_order = ?,
    status = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?`).run(
    data.title,
    data.description,
    data.icon,
    data.href,
    data.category,
    JSON.stringify(data.tags),
    data.highlight,
    data.highlight_style,
    data.credit,
    JSON.stringify(data.keywords),
    data.sort_order,
    data.status,
    id
  );

  if (result.changes === 0) return { error: '卡片不存在' };
  return { id };
}

function deleteStudioCard(id) {
  const result = db.prepare('DELETE FROM studio_cards WHERE id = ?').run(id);
  if (result.changes === 0) return { error: '卡片不存在' };
  return { id };
}

function setStudioCardStatus(id, value) {
  const status = normalizeStatus(value, null);
  if (status === null) return { error: '状态值不正确' };

  const result = db.prepare(`UPDATE studio_cards SET status = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?`).run(status, id);
  if (result.changes === 0) return { error: '卡片不存在' };
  return { id, status };
}

module.exports = {
  createStudioCard,
  deleteStudioCard,
  getPublicStudioCards,
  getStudioCardById,
  listAllStudioCards,
  listVisibleStudioCards,
  searchStudioCards,
  setStudioCardStatus,
  updateStudioCard,
};
