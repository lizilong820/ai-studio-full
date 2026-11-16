const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-studio-workflow-'));
process.env.AI_STUDIO_DB_PATH = path.join(tempDir, 'test.db');
process.env.AI_STUDIO_UPLOADS_DIR = path.join(tempDir, 'uploads');
process.env.AI_STUDIO_TMP_DIR = path.join(tempDir, 'tmp');

const { db } = require('../database/db');
const service = require('../controllers/workflowService');
const { WORKFLOW_TEMPLATES } = require('../config/workflowTemplates');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// 1x1 PNG
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + TINY_PNG;

test('内置工作流模板已写入数据库且节点结构合法', () => {
  const templates = service.listTemplates();
  assert.ok(templates.length >= 5, '至少应有 5 个工作流模板');

  for (const tpl of templates) {
    assert.ok(tpl.key, '模板缺少 key');
    assert.ok(tpl.node_count >= 1, tpl.key + ' 没有节点');
    assert.ok(tpl.inputs.length >= 1, tpl.key + ' 没有输入组');
    assert.ok(tpl.nodes.every(node => node.name && node.type && node.key), tpl.key + ' 节点字段缺失');
  }

  const main = templates.find(tpl => tpl.key === 'main_image_set');
  assert.ok(main, '缺少电商主图套图模板');
  assert.equal(main.node_count, 4);
  assert.deepEqual(main.nodes.map(node => node.key), ['white_bg', 'scene', 'detail', 'hero_space']);
  const mainConfig = WORKFLOW_TEMPLATES.find(tpl => tpl.key === 'main_image_set');
  assert.ok(
    mainConfig.nodes.every(node => node.source === 'input:product'),
    '四张图都应从用户原图独立生成，避免反复转绘导致商品变形'
  );
  const scene = mainConfig.nodes.find(node => node.key === 'scene');
  assert.match(scene.prompt, /realistic scale/i);

  // 已有数据库也要通过一次性迁移拿到新节点，而不是继续使用旧的串联提示词
  const stored = db.prepare('SELECT nodes FROM workflow_templates WHERE template_key = ?').get('main_image_set');
  const storedNodes = JSON.parse(stored.nodes);
  assert.ok(storedNodes.every(node => node.source === 'input:product'));
});

test('电商主图套图模板升级会同步到已有数据库', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'database', 'db.js'), 'utf8');
  assert.match(source, /workflow_main_image_set_v2/);
  assert.match(source, /UPDATE workflow_templates SET/);
});

test('模板配置里的节点 key 在同一模板内唯一且都有 prompt', () => {
  for (const tpl of WORKFLOW_TEMPLATES) {
    const keys = tpl.nodes.map(node => node.key);
    assert.equal(new Set(keys).size, keys.length, tpl.key + ' 存在重复节点 key');
    for (const node of tpl.nodes) {
      assert.ok(node.prompt && node.prompt.length > 20, tpl.key + '/' + node.key + ' 缺少有效 prompt');
      assert.ok(['image_edit', 'image_generate'].includes(node.type), tpl.key + '/' + node.key + ' 节点类型非法');
    }
  }
});

test('画幅计算符合模型尺寸要求', () => {
  assert.equal(service.computeSize('1:1', '1K'), '1024x1024');
  assert.equal(service.computeSize('1:1', '2K'), '2048x2048');
  assert.equal(service.computeSize('3:4', '2K'), '1536x2048');
  assert.equal(service.computeSize('16:9', '1K'), '1024x576');
  // 不合法比例回退到 1:1
  assert.equal(service.computeSize('bad', '1K'), '1024x1024');
});

test('生成结果解析兼容 canonical 与旧格式', () => {
  assert.deepEqual(service.extractImages(JSON.stringify({ images: ['/uploads/a.png'] })), ['/uploads/a.png']);
  assert.deepEqual(service.extractImages({ images: ['/uploads/a.png', '/uploads/b.png'] }), ['/uploads/a.png', '/uploads/b.png']);
  assert.deepEqual(service.extractImages({ image: '/uploads/c.png' }), ['/uploads/c.png']);
  assert.deepEqual(service.extractImages('not-json'), []);
  assert.deepEqual(service.extractImages({ images: [] }), []);
});

test('上传校验只接受真实图片数据', () => {
  assert.throws(() => service.decodeDataUrl('data:text/plain;base64,aGVsbG8='), /图片格式无效/);
  assert.throws(() => service.decodeDataUrl('hello'), /图片格式无效/);
  const buffer = service.decodeDataUrl(PNG_DATA_URL);
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

test('工作流按节点扣费、串联参考图并可取消退款', async () => {
  db.prepare(`INSERT INTO users (username, password_hash, credits, status)
    VALUES ('wf_tester', 'x', 100, 1)`).run();
  const userId = db.prepare("SELECT id FROM users WHERE username = 'wf_tester'").get().id;

  db.prepare(`INSERT INTO models (name, type, api_endpoint, api_key, model_identifier, price_per_call, status)
    VALUES ('测试生图模型', 'image', 'https://api.test-provider.local/v1/images/generations', 'sk-test-real', 'flux-pro', 10, 1)`).run();
  const modelId = db.prepare("SELECT id FROM models WHERE name = '测试生图模型'").get().id;

  const template = service.listTemplates().find(tpl => tpl.key === 'main_image_set');

  const run = service.createRun(userId, {
    template_id: template.id,
    model_id: modelId,
    ratio: '1:1',
    quality: '1K',
    inputs: { product: [PNG_DATA_URL] }
  });

  assert.equal(run.status, 'pending');
  assert.equal(run.total_nodes, 4);
  assert.match(run.inputs.product[0], /^\/uploads\/workflow\/in_product_/);
  assert.ok(fs.existsSync(path.join(tempDir, 'uploads', run.inputs.product[0].replace('/uploads/', ''))));

  const claimed = service.claimRun();
  assert.equal(claimed.id, run.id);

  const started = await service.advanceRun(run.id);
  assert.equal(started.state, 'started');

  const generation = db.prepare('SELECT * FROM generations WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  assert.equal(generation.studio_type, 'workflow');
  assert.equal(generation.credits_used, 10);
  assert.equal(generation.status, 'pending');

  const job = db.prepare('SELECT * FROM generation_jobs WHERE generation_id = ?').get(generation.id);
  assert.equal(job.job_type, 'image.edit');
  const payload = JSON.parse(job.payload);
  assert.deepEqual(payload.ref_image_paths, [run.inputs.product[0]]);
  assert.equal(payload.options.size, '1024x1024');

  // 第一个节点完成
  db.prepare("UPDATE generations SET status = 'success', result = ? WHERE id = ?")
    .run(JSON.stringify({ images: [run.inputs.product[0]] }), generation.id);

  await service.advanceRun(run.id);
  let current = service.getRun(run.id, userId);
  assert.equal(current.nodes[0].status, 'succeeded');
  assert.equal(current.current_index, 1);

  // 第二个节点应该以第一个节点的输出作为参考图
  await service.advanceRun(run.id);
  const secondGeneration = db.prepare('SELECT * FROM generations WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  const secondJob = db.prepare('SELECT * FROM generation_jobs WHERE generation_id = ?').get(secondGeneration.id);
  const secondPayload = JSON.parse(secondJob.payload);
  assert.deepEqual(secondPayload.ref_image_paths, [run.inputs.product[0]]);

  // 取消：进行中的节点退款，已完成的节点不退
  const canceled = service.cancelRun(run.id, userId);
  assert.equal(canceled.status, 'canceled');

  const balance = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId).credits;
  assert.equal(balance, 90);

  const canceledGeneration = db.prepare('SELECT status FROM generations WHERE id = ?').get(secondGeneration.id);
  assert.equal(canceledGeneration.status, 'failed');
});

test('取消时已生成成功的节点保留结果和费用', () => {
  const userId = db.prepare("SELECT id FROM users WHERE username = 'wf_tester'").get().id;
  const modelId = db.prepare("SELECT id FROM models WHERE name = '测试生图模型'").get().id;
  const template = service.getTemplateRow('main_image_set');
  const nodes = JSON.parse(template.nodes);

  // 构造“节点已生成成功，但工作流还没推进”的状态
  db.prepare('UPDATE users SET credits = credits - 10 WHERE id = ?').run(userId);
  const generation = db.prepare(`INSERT INTO generations
    (user_id, studio_type, model_id, params, credits_used, status, result)
    VALUES (?, 'workflow', ?, ?, 10, 'success', ?)`)
    .run(
      userId,
      modelId,
      JSON.stringify({ workflow_run_id: 0, node_key: 'white_bg' }),
      JSON.stringify({ images: ['/uploads/workflow/done.png'] })
    );

  const nodeStates = nodes.map((node, index) => ({
    key: node.key,
    name: node.name,
    status: index === 0 ? 'running' : 'pending',
    generation_id: index === 0 ? generation.lastInsertRowid : null,
    images: [],
    preview: '',
    cost: index === 0 ? 10 : 0,
    error: ''
  }));

  const run = db.prepare(`INSERT INTO workflow_runs
    (user_id, template_id, template_key, model_id, status, inputs, nodes_snapshot, node_states, total_cost)
    VALUES (?, ?, 'main_image_set', ?, 'running', '{}', ?, ?, 10)`)
    .run(userId, template.id, modelId, template.nodes, JSON.stringify(nodeStates));

  const canceled = service.cancelRun(run.lastInsertRowid, userId);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.nodes[0].status, 'succeeded');
  assert.equal(canceled.nodes[0].preview, '/uploads/workflow/done.png');
  assert.equal(canceled.total_cost, 10, '已生成成功的节点费用不能清零');
  assert.equal(canceled.final_image, '/uploads/workflow/done.png');

  const balance = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId).credits;
  assert.equal(balance, 80, '成功的节点不退款，余额 90 - 10');
});

test('演示模型不允许创建工作流（避免白扣积分）', () => {
  const userId = db.prepare("SELECT id FROM users WHERE username = 'wf_tester'").get().id;
  db.prepare(`INSERT INTO models (name, type, api_endpoint, api_key, model_identifier, price_per_call, status)
    VALUES ('演示生图模型', 'image', 'https://api.example.com/v1/images/generations', 'sk-example-key', 'demo', 10, 1)`).run();
  const demoId = db.prepare("SELECT id FROM models WHERE name = '演示生图模型'").get().id;
  const template = service.getTemplateRow('main_image_set');

  assert.throws(
    () => service.createRun(userId, {
      template_id: template.id,
      model_id: demoId,
      inputs: { product: [PNG_DATA_URL] }
    }),
    /演示配置/
  );
});

test('工作流页面走统一的 API 契约', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'workflow.html'), 'utf8');
  assert.match(html, /\/api\/workflow\/templates/);
  assert.match(html, /\/api\/workflow\/runs/);
  assert.match(html, /\/api\/workflow\/estimate/);
  assert.match(html, /canvas\.toDataURL/, '上传前应压缩图片');
  assert.match(html, /name="viewport"/);
  assert.doesNotMatch(html, /position:\s*fixed/, '不要在移动端使用固定悬浮条');
});

test('工作流页面同时提供电商套图工作室', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'workflow.html'), 'utf8');
  assert.match(html, /id="studioMode"/);
  assert.match(html, /\/api\/generate\/ecommerce/);
  assert.match(html, /data-mode="studio" role="tab" aria-selected="true"/);
  assert.match(html, /<div id="pipelineMode" hidden>/);
  assert.match(html, /location\.hash === '#pipeline' \? 'pipeline' : 'studio'/);
  assert.match(html, /product_images:\s*studioImages\.product\.slice\(\)/);
  assert.match(html, /style_ref_image:\s*studioImages\.style\[0\]/);
  assert.match(html, /pollGeneration\(\s*res\.data\.task_id/);
  assert.match(html, /let studioCostSeq = 0/);
  assert.doesNotMatch(html, /setInterval\s*\(\s*async/);
});

test('首页电商工作室入口直接打开套图表单', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /href="workflow\.html#studio"/);
});

test('工作流路由已挂载且 readyz 检查 workflow worker', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /app\.use\('\/api\/workflow', workflowRoutes\)/);
  assert.match(app, /workflow_worker/);
  assert.match(app, /workflowWorker\.start\(\)/);
});
