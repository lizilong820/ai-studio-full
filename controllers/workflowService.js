// 电商工作流：模板读取、运行实例、节点编排
//
// 设计要点：
//   - 每个节点仍然走 generations + generation_jobs，复用现有扣费、重试和退款逻辑
//   - 节点之间通过 ref_image_paths 传递图片，避免把 base64 写进数据库
//   - workflow_runs.node_states 是唯一的进度来源，worker 只按它推进

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../database/db');
const aiAdapter = require('../controllers/aiAdapter');
const creditService = require('../controllers/creditService');
const { safeRequest } = require('../utils/safeHttp');

const MAX_INPUT_IMAGES = 3;
const MAX_INPUT_BYTES = 6 * 1024 * 1024;
const MAX_REF_IMAGES = 4;
const NODE_DEADLINE_SECONDS = 900;
const RUN_LOCK_SECONDS = 180;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function uploadsRoot() {
  const configured = process.env.AI_STUDIO_UPLOADS_DIR;
  if (configured && String(configured).trim()) return path.resolve(String(configured).trim());
  return path.join(__dirname, '..', 'public', 'uploads');
}

function detectImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('图片内容无效');
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new Error('只支持 JPG、PNG、WEBP 图片');
}

function writeUpload(buffer, prefix) {
  const ext = detectImageExt(buffer);
  const dir = path.join(uploadsRoot(), 'workflow');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return `/uploads/workflow/${name}`;
}

function decodeDataUrl(value) {
  if (typeof value !== 'string') throw new Error('图片格式无效');
  const match = value.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) throw new Error('图片格式无效，请重新上传 JPG 或 PNG');
  const buffer = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('单张图片不能超过 6MB，请压缩后再上传');
  return buffer;
}

function computeSize(ratio, quality) {
  const base = quality === '2K' ? 2048 : 1024;
  const ratioMap = {
    '1:1': [1, 1],
    '3:4': [3, 4],
    '4:3': [4, 3],
    '16:9': [16, 9],
    '9:16': [9, 16]
  };
  const pair = ratioMap[ratio] || ratioMap['1:1'];
  if (pair[0] >= pair[1]) {
    return `${base}x${Math.round(base * pair[1] / pair[0] / 8) * 8}`;
  }
  return `${Math.round(base * pair[0] / pair[1] / 8) * 8}x${base}`;
}

function extractImages(resultValue) {
  let result = resultValue;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch (error) {
      return [];
    }
  }
  if (!result || typeof result !== 'object') return [];
  let list = result.images;
  if (!list) list = result.image || result.url || result.output;
  if (typeof list === 'string') list = [list];
  if (!Array.isArray(list)) return [];
  return list
    .filter(item => typeof item === 'string' && item.trim())
    .slice(0, 8);
}

function toPublicTemplate(row) {
  const nodes = parseJson(row.nodes, []);
  const inputs = parseJson(row.inputs, []);
  return {
    id: row.id,
    key: row.template_key,
    name: row.name,
    summary: row.summary || '',
    category: row.category || 'ecommerce',
    emoji: row.emoji || '🛠️',
    badge: row.badge || '',
    node_count: nodes.length,
    nodes: nodes.map(node => ({
      key: node.key,
      name: node.name,
      type: node.type,
      note: node.note || '',
      size: node.size || '1:1'
    })),
    inputs: inputs.map(item => ({
      key: item.key,
      label: item.label,
      hint: item.hint || '',
      min: item.min === undefined ? 1 : item.min,
      max: item.max === undefined ? MAX_INPUT_IMAGES : item.max,
      required: item.required !== false
    }))
  };
}

function listTemplates() {
  const rows = db.prepare(`SELECT * FROM workflow_templates
    WHERE status = 1 ORDER BY sort_order ASC, id ASC`).all();
  return rows.map(toPublicTemplate);
}

function getTemplateRow(idOrKey) {
  const numeric = Number(idOrKey);
  if (Number.isSafeInteger(numeric) && numeric > 0) {
    return db.prepare('SELECT * FROM workflow_templates WHERE id = ? AND status = 1').get(numeric) || null;
  }
  return db.prepare('SELECT * FROM workflow_templates WHERE template_key = ? AND status = 1')
    .get(String(idOrKey || '')) || null;
}

function estimateCost(idOrKey, modelId) {
  const row = getTemplateRow(idOrKey);
  if (!row) return { ok: false, msg: '工作流不存在或已停用' };
  const nodes = parseJson(row.nodes, []);
  if (!nodes.length) return { ok: false, msg: '该工作流没有可用节点' };
  const unit = aiAdapter.calculateCost(modelId, 1);
  if (unit === null) return { ok: false, msg: '模型不存在、已停用或价格未配置' };
  return {
    ok: true,
    node_count: nodes.length,
    unit_cost: unit,
    total_cost: Math.round((unit * nodes.length + Number.EPSILON) * 100) / 100
  };
}

function isDemoModel(model) {
  const endpoint = String(model.api_endpoint || '');
  const key = String(model.api_key || '');
  return /api\.example\.com/i.test(endpoint)
    || /example/i.test(key)
    || key.includes('请修改');
}

function assertModel(modelId) {
  const id = Number(modelId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('请选择生图模型');
  const model = db.prepare('SELECT id, name, type, api_endpoint, api_key FROM models WHERE id = ? AND status = 1').get(id);
  if (!model) throw new Error('模型不存在或已停用');
  if (model.type !== 'image') throw new Error('电商工作流只支持生图模型');
  if (isDemoModel(model)) {
    throw new Error('当前模型还是演示配置，工作流需要支持图生图的真实模型，请先到后台配置接口和 API Key');
  }
  return model;
}

function normalizeInputs(templateRow, rawInputs) {
  const declared = parseJson(templateRow.inputs, []);
  if (!rawInputs || typeof rawInputs !== 'object' || Array.isArray(rawInputs)) {
    throw new Error('请上传商品图');
  }
  const stored = {};
  let total = 0;
  for (const item of declared) {
    const provided = rawInputs[item.key];
    const list = Array.isArray(provided) ? provided.filter(Boolean) : (provided ? [provided] : []);
    const max = item.max === undefined ? MAX_INPUT_IMAGES : item.max;
    const min = item.min === undefined ? 1 : item.min;
    if (list.length < min) throw new Error(`请上传${item.label}`);
    if (list.length > max) throw new Error(`${item.label}最多 ${max} 张`);
    total += list.length;
    if (total > MAX_INPUT_IMAGES + 2) throw new Error('上传图片数量过多');
    stored[item.key] = list.map(value => writeUpload(decodeDataUrl(value), `in_${item.key}`));
  }
  return stored;
}

function createRun(userId, payload = {}) {
  const templateRow = getTemplateRow(payload.template_id);
  if (!templateRow) throw new Error('工作流不存在或已停用');
  const model = assertModel(payload.model_id);
  const nodes = parseJson(templateRow.nodes, []);
  if (!nodes.length) throw new Error('该工作流没有可用节点');

  const quality = payload.quality === '2K' ? '2K' : '1K';
  const ratio = ['1:1', '3:4', '4:3', '16:9', '9:16'].includes(payload.ratio) ? payload.ratio : '';
  const inputs = normalizeInputs(templateRow, payload.inputs);

  // 运行时的比例/清晰度写进节点快照，保证重跑时行为一致
  const resolvedNodes = nodes.map(node => ({
    ...node,
    size: ratio || node.size || '1:1',
    quality
  }));

  const nodeStates = resolvedNodes.map(node => ({
    key: node.key,
    name: node.name,
    status: 'pending',
    generation_id: null,
    images: [],
    preview: '',
    cost: 0,
    error: ''
  }));

  const info = db.prepare(`INSERT INTO workflow_runs
    (user_id, template_id, template_key, model_id, status, inputs, nodes_snapshot, node_states)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .run(
      userId,
      templateRow.id,
      templateRow.template_key,
      model.id,
      JSON.stringify(inputs),
      JSON.stringify(resolvedNodes),
      JSON.stringify(nodeStates)
    );

  return getRun(info.lastInsertRowid, userId);
}

function getRunRow(id, userId) {
  const numeric = Number(id);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return null;
  const row = db.prepare(`SELECT workflow_runs.*, workflow_templates.name AS template_name,
      workflow_templates.emoji AS template_emoji
    FROM workflow_runs
    LEFT JOIN workflow_templates ON workflow_templates.id = workflow_runs.template_id
    WHERE workflow_runs.id = ? AND workflow_runs.user_id = ?`)
    .get(numeric, userId);
  return row || null;
}

function shapeRun(row) {
  const states = parseJson(row.node_states, []);
  const snapshot = parseJson(row.nodes_snapshot, []);
  const nodes = states.map((state, index) => {
    const source = snapshot[index] || {};
    return {
      key: state.key,
      name: state.name || source.name,
      note: source.note || '',
      type: source.type || 'image_edit',
      status: state.status || 'pending',
      preview: state.preview || '',
      images: Array.isArray(state.images) ? state.images : [],
      cost: Number(state.cost) || 0,
      error: state.error || ''
    };
  });
  const done = nodes.filter(node => node.status === 'succeeded').length;
  return {
    id: row.id,
    status: row.status,
    template_id: row.template_id,
    template_key: row.template_key,
    template_name: row.template_name || row.template_key || '工作流',
    template_emoji: row.template_emoji || '🛠️',
    model_id: row.model_id,
    current_index: row.current_index,
    total_nodes: nodes.length,
    done_nodes: done,
    total_cost: Number(row.total_cost) || 0,
    final_image: row.final_image || '',
    error_msg: row.error_msg || '',
    inputs: parseJson(row.inputs, {}),
    nodes,
    created_at: row.created_at,
    finished_at: row.finished_at || ''
  };
}

function getRun(id, userId) {
  const row = getRunRow(id, userId);
  return row ? shapeRun(row) : null;
}

function listRuns(userId, limit = 20) {
  const size = Number.isSafeInteger(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 50) : 20;
  const rows = db.prepare(`SELECT workflow_runs.*, workflow_templates.name AS template_name,
      workflow_templates.emoji AS template_emoji
    FROM workflow_runs
    LEFT JOIN workflow_templates ON workflow_templates.id = workflow_runs.template_id
    WHERE workflow_runs.user_id = ?
    ORDER BY workflow_runs.id DESC LIMIT ?`).all(userId, size);
  return rows.map(shapeRun).map(run => ({
    id: run.id,
    status: run.status,
    template_name: run.template_name,
    template_emoji: run.template_emoji,
    total_nodes: run.total_nodes,
    done_nodes: run.done_nodes,
    total_cost: run.total_cost,
    cover: run.final_image || (run.nodes.find(node => node.preview) || {}).preview || '',
    error_msg: run.error_msg,
    created_at: run.created_at
  }));
}

function cancelRun(id, userId) {
  const row = getRunRow(id, userId);
  if (!row) throw new Error('工作流不存在');
  if (['succeeded', 'failed', 'canceled'].includes(row.status)) {
    throw new Error('该工作流已经结束');
  }

  const states = parseJson(row.node_states, []);
  const active = states[row.current_index];
  if (active && active.generation_id) {
    const generation = db.prepare('SELECT status, result FROM generations WHERE id = ?')
      .get(active.generation_id);
    if (generation && generation.status === 'success') {
      // 节点其实已经生成成功，只是工作流还没推进：保留结果，已花的积分仍然计入
      const images = extractImages(generation.result);
      if (images.length) {
        active.status = 'succeeded';
        active.images = images;
        active.preview = images[0];
        active.error = '';
      } else {
        active.status = 'canceled';
        active.error = '已取消';
      }
    } else {
      if (generation && ['pending', 'processing'].includes(generation.status)) {
        try {
          creditService.failGenerationAndRefund(active.generation_id, '用户取消工作流');
        } catch (error) {
          console.error(`工作流 ${row.id} 取消退款失败:`, error.message);
        }
      }
      active.status = 'canceled';
      active.cost = 0;
      active.error = '已取消';
    }
  }

  const finalState = states.slice().reverse().find(state => state.status === 'succeeded' && state.preview);

  db.prepare(`UPDATE workflow_runs
    SET status = 'canceled', node_states = ?, total_cost = ?, final_image = ?,
        error_msg = '用户取消',
        finished_at = datetime('now', 'localtime'),
        updated_at = datetime('now', 'localtime'), locked_until = NULL
    WHERE id = ?`).run(
    JSON.stringify(states),
    chargedTotal(states),
    finalState ? finalState.preview : '',
    row.id
  );

  return getRun(row.id, userId);
}

// ============ 执行引擎（由 workers/workflowWorker.js 调用） ============

const claimTransaction = db.transaction(() => {
  const candidate = db.prepare(`SELECT id FROM workflow_runs
    WHERE status IN ('pending', 'running')
      AND datetime(next_run_at) <= datetime('now')
      AND (locked_until IS NULL OR datetime(locked_until) <= datetime('now'))
    ORDER BY id ASC LIMIT 1`).get();
  if (!candidate) return null;
  const claimed = db.prepare(`UPDATE workflow_runs
    SET locked_until = datetime('now', '+' || ? || ' seconds'),
        status = 'running',
        updated_at = datetime('now', 'localtime')
    WHERE id = ? AND status IN ('pending', 'running')
      AND (locked_until IS NULL OR datetime(locked_until) <= datetime('now'))`)
    .run(RUN_LOCK_SECONDS, candidate.id);
  if (claimed.changes !== 1) return null;
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(candidate.id);
});

function claimRun() {
  return claimTransaction.immediate();
}

function schedule(runId, delaySeconds) {
  db.prepare(`UPDATE workflow_runs
    SET next_run_at = datetime('now', '+' || ? || ' seconds'),
        locked_until = NULL,
        updated_at = datetime('now', 'localtime')
    WHERE id = ?`).run(Math.max(0, Math.round(delaySeconds)), runId);
}

function saveProgress(runId, patch) {
  db.prepare(`UPDATE workflow_runs SET
      status = COALESCE(?, status),
      node_states = COALESCE(?, node_states),
      current_index = COALESCE(?, current_index),
      total_cost = COALESCE(?, total_cost),
      final_image = COALESCE(?, final_image),
      error_msg = COALESCE(?, error_msg),
      finished_at = CASE WHEN ? = 1 THEN datetime('now', 'localtime') ELSE finished_at END,
      locked_until = NULL,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?`).run(
    patch.status === undefined ? null : patch.status,
    patch.node_states === undefined ? null : patch.node_states,
    patch.current_index === undefined ? null : patch.current_index,
    patch.total_cost === undefined ? null : patch.total_cost,
    patch.final_image === undefined ? null : patch.final_image,
    patch.error_msg === undefined ? null : patch.error_msg,
    patch.finished === true ? 1 : 0,
    runId
  );
}

function isLocalUpload(url) {
  return typeof url === 'string' && url.startsWith('/uploads/');
}

function localFileFor(url) {
  if (!isLocalUpload(url)) return null;
  const relative = url.replace(/^\/uploads\//, '');
  const roots = [];
  if (process.env.AI_STUDIO_UPLOADS_DIR && String(process.env.AI_STUDIO_UPLOADS_DIR).trim()) {
    roots.push(path.resolve(String(process.env.AI_STUDIO_UPLOADS_DIR).trim()));
  }
  roots.push(path.resolve(__dirname, '..', 'public', 'uploads'));
  for (const root of roots) {
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

async function materializeRef(url) {
  if (isLocalUpload(url)) {
    return localFileFor(url) ? url : null;
  }
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    const response = await safeRequest(url, { timeoutMs: 20_000, maxBytes: MAX_INPUT_BYTES });
    if (response.status < 200 || response.status >= 300) return null;
    return writeUpload(response.body, 'ref');
  } catch (error) {
    console.error('工作流参考图下载失败:', error.message);
    return null;
  }
}

async function resolveRefPaths(node, states, inputs, index) {
  const tokens = String(node.source || 'input:product')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const collected = [];

  for (const token of tokens) {
    if (token === 'prev') {
      const previous = states[index - 1];
      if (previous && previous.images && previous.images[0]) collected.push(previous.images[0]);
      continue;
    }
    if (token.startsWith('node:')) {
      const key = token.slice('node:'.length);
      const target = states.find(item => item.key === key);
      if (target && target.images && target.images[0]) collected.push(target.images[0]);
      continue;
    }
    if (token.startsWith('input:')) {
      const key = token.slice('input:'.length);
      const list = Array.isArray(inputs[key]) ? inputs[key] : [];
      collected.push(...list);
    }
  }

  const unique = [];
  for (const item of collected) {
    if (item && !unique.includes(item)) unique.push(item);
    if (unique.length >= MAX_REF_IMAGES) break;
  }

  const resolved = [];
  for (const item of unique) {
    const local = await materializeRef(item);
    if (local) resolved.push(local);
  }
  return resolved;
}

function findExistingGeneration(runId, nodeKey) {
  return db.prepare(`SELECT id, status FROM generations
    WHERE studio_type = 'workflow'
      AND json_extract(params, '$.workflow_run_id') = ?
      AND json_extract(params, '$.node_key') = ?
    ORDER BY id ASC LIMIT 1`).get(runId, nodeKey) || null;
}

function chargedTotal(states) {
  return states.reduce((sum, state) => (
    state.status === 'succeeded' ? sum + (Number(state.cost) || 0) : sum
  ), 0);
}

function failRun(row, states, message) {
  const current = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(row.id);
  // 用户已经取消（或已结束）时不要覆盖终态
  if (!current || !['pending', 'running'].includes(current.status)) {
    return { state: 'idle' };
  }
  const index = row.current_index;
  if (states[index] && states[index].status !== 'succeeded') {
    states[index].status = 'failed';
    states[index].error = message;
  }
  saveProgress(row.id, {
    status: 'failed',
    node_states: JSON.stringify(states),
    total_cost: chargedTotal(states),
    error_msg: message,
    finished: true
  });
  return { state: 'failed', error: message };
}

async function advanceRun(runId) {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId);
  if (!row || !['pending', 'running'].includes(row.status)) {
    return { state: 'idle' };
  }

  const states = parseJson(row.node_states, []);
  const nodes = parseJson(row.nodes_snapshot, []);
  const inputs = parseJson(row.inputs, {});
  const index = Number(row.current_index) || 0;

  if (index >= states.length || index >= nodes.length) {
    const lastImage = states.length ? (states[states.length - 1].preview || '') : '';
    saveProgress(row.id, {
      status: 'succeeded',
      final_image: lastImage,
      error_msg: '',
      finished: true
    });
    return { state: 'succeeded' };
  }

  const state = states[index];
  const node = nodes[index];

  // 已有生成任务：检查进度
  if (state.generation_id) {
    const generation = db.prepare('SELECT id, status, result, error_msg FROM generations WHERE id = ?')
      .get(state.generation_id);
    if (!generation) return failRun(row, states, '生成记录丢失');
    if (generation.status === 'pending' || generation.status === 'processing') {
      schedule(row.id, 2);
      return { state: 'waiting' };
    }
    if (generation.status === 'failed') {
      return failRun(row, states, generation.error_msg || '生成失败');
    }

    const images = extractImages(generation.result);
    if (!images.length) return failRun(row, states, '生成成功但没有返回图片');

    state.status = 'succeeded';
    state.images = images;
    state.preview = images[0];
    state.error = '';

    const nextIndex = index + 1;
    if (nextIndex >= states.length) {
      saveProgress(row.id, {
        status: 'succeeded',
        node_states: JSON.stringify(states),
        current_index: nextIndex,
        final_image: state.preview,
        error_msg: '',
        finished: true
      });
      return { state: 'succeeded' };
    }

    saveProgress(row.id, {
      node_states: JSON.stringify(states),
      current_index: nextIndex
    });
    schedule(row.id, 0);
    return { state: 'advanced', next: nextIndex };
  }

  // 还没有生成任务：创建扣费 + 任务
  const existing = findExistingGeneration(row.id, node.key);
  if (existing) {
    state.generation_id = existing.id;
    state.status = existing.status === 'success' ? 'succeeded' : 'running';
    saveProgress(row.id, { node_states: JSON.stringify(states) });
    schedule(row.id, 0);
    return { state: 'recovered' };
  }

  let refPaths = [];
  if (node.type === 'image_edit') {
    refPaths = await resolveRefPaths(node, states, inputs, index);
    if (!refPaths.length) {
      const needsPreviousImage = /(^|,)\s*(prev|node:)/.test(String(node.source || ''));
      return failRun(
        row,
        states,
        needsPreviousImage
          ? '上一节点的输出图片无法读取，请确认生图模型已配置真实接口（演示模型的占位图不能作为参考图）'
          : '缺少参考图，请重新上传商品图'
      );
    }
  }

  // resolveRefPaths 会等待网络/磁盘，期间用户可能已经取消；
  // 这里再确认一次，避免取消之后仍创建扣费任务。之后到写库都是同步的，不会被打断。
  const latest = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(row.id);
  if (!latest || !['pending', 'running'].includes(latest.status)) {
    return { state: 'idle' };
  }

  const cost = aiAdapter.calculateCost(row.model_id, 1);
  if (cost === null) return failRun(row, states, '模型不可用或价格未配置');

  const size = computeSize(node.size || '1:1', node.quality || '1K');
  const jobPayload = {
    model_id: Number(row.model_id),
    prompt: String(node.prompt || '').trim(),
    options: { size },
    deadline_seconds: NODE_DEADLINE_SECONDS,
    result_style: 'canonical',
    result_metadata: { workflow_run_id: row.id, node_key: node.key }
  };
  if (node.type === 'image_edit') jobPayload.ref_image_paths = refPaths;

  const jobType = node.type === 'image_edit' ? 'image.edit' : 'image.generate';
  let deducted;
  try {
    deducted = creditService.createGenerationAndDeduct(
      row.user_id,
      'workflow',
      Number(row.model_id),
      JSON.stringify({ workflow_run_id: row.id, node_key: node.key, node_index: index }),
      cost,
      `电商工作流 · ${node.name || '节点'}`,
      {
        type: jobType,
        payload: jobPayload,
        maxAttempts: 2
      }
    );
  } catch (error) {
    return failRun(row, states, error.message);
  }

  if (!deducted.success) return failRun(row, states, deducted.msg || '积分不足');

  state.generation_id = deducted.taskId;
  state.status = 'running';
  state.cost = cost;
  state.error = '';

  saveProgress(row.id, {
    node_states: JSON.stringify(states),
    total_cost: (Number(row.total_cost) || 0) + cost
  });
  schedule(row.id, 2);
  return { state: 'started', node: node.key };
}

module.exports = {
  listTemplates,
  getTemplateRow,
  estimateCost,
  createRun,
  getRun,
  listRuns,
  cancelRun,
  claimRun,
  advanceRun,
  schedule,
  // 供测试使用的纯函数
  computeSize,
  extractImages,
  resolveRefPaths,
  decodeDataUrl,
  MAX_INPUT_BYTES
};
