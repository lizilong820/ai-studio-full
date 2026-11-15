// 电商工作流 API
const express = require('express');
const { authRequired, authOptional } = require('../middleware/auth');
const workflowService = require('../controllers/workflowService');

const router = express.Router();

// 工作流模板列表
router.get('/templates', authOptional, (req, res) => {
  res.success(workflowService.listTemplates());
});

// 预估消耗（节点数 × 单节点价格）
router.post('/estimate', authOptional, (req, res) => {
  try {
    const { template_id, model_id } = req.body || {};
    const estimate = workflowService.estimateCost(template_id, model_id);
    if (!estimate.ok) return res.error(estimate.msg);
    res.success(estimate);
  } catch (error) {
    res.error(error.message || '预估失败');
  }
});

// 创建并启动一次工作流
router.post('/runs', authRequired, (req, res) => {
  try {
    const run = workflowService.createRun(req.user.id, req.body || {});
    res.success(run, '工作流已启动');
  } catch (error) {
    res.error(error.message || '创建失败');
  }
});

// 我的工作流记录
router.get('/runs', authRequired, (req, res) => {
  try {
    res.success(workflowService.listRuns(req.user.id, req.query.limit));
  } catch (error) {
    res.error(error.message || '读取失败');
  }
});

// 单次工作流详情
router.get('/runs/:id', authRequired, (req, res) => {
  try {
    const run = workflowService.getRun(req.params.id, req.user.id);
    if (!run) return res.error('工作流不存在');
    res.success(run);
  } catch (error) {
    res.error(error.message || '读取失败');
  }
});

// 取消工作流
router.post('/runs/:id/cancel', authRequired, (req, res) => {
  try {
    const run = workflowService.cancelRun(req.params.id, req.user.id);
    res.success(run, '已取消');
  } catch (error) {
    res.error(error.message || '取消失败');
  }
});

module.exports = router;
