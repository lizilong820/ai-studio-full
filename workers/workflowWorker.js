// 电商工作流执行 worker
// 只负责推进 workflow_runs，真正的模型调用仍然交给 generationWorker

const workflowService = require('../controllers/workflowService');

const DEFAULT_POLL_MS = 1500;

function createWorkflowWorker(options = {}) {
  const pollIntervalMs = Number.isSafeInteger(options.pollIntervalMs) && options.pollIntervalMs >= 200
    ? options.pollIntervalMs
    : DEFAULT_POLL_MS;

  let running = false;
  let timer = null;
  let draining = null;

  async function runOnce(limit = 50) {
    let claimed = 0;
    while (claimed < limit) {
      if (!running && claimed > 0) break;
      const run = workflowService.claimRun();
      if (!run) break;
      claimed += 1;
      try {
        await workflowService.advanceRun(run.id);
      } catch (error) {
        console.error(`工作流 ${run.id} 推进失败:`, error.message);
        workflowService.schedule(run.id, 10);
      }
    }
    return claimed;
  }

  async function tick() {
    if (!running) return;
    try {
      await runOnce();
    } catch (error) {
      console.error('工作流 worker 轮询失败:', error.message);
    } finally {
      if (running) timer = setTimeout(tick, pollIntervalMs);
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setTimeout(tick, 0);
  }

  async function stop() {
    if (draining) return draining;
    running = false;
    if (timer) clearTimeout(timer);
    draining = Promise.resolve();
    return draining;
  }

  return {
    start,
    stop,
    runOnce,
    isRunning: () => running
  };
}

module.exports = { createWorkflowWorker };
