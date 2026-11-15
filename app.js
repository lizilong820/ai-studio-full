require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const { host, port, corsOrigins } = require('./config/security');
const responseWrapper = require('./middleware/response');
const securityHeaders = require('./middleware/securityHeaders');
const { generalApiLimit, authLimit } = require('./middleware/rateLimit');
const userRoutes = require('./routes/user');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const apiV1Routes = require('./routes/apiV1');
const workflowRoutes = require('./routes/workflow');
const { db } = require('./database/db');
const { createGenerationWorker } = require('./workers/generationWorker');
const { createBatchDownloadWorker } = require('./workers/batchDownloadWorker');
const { createWorkflowWorker } = require('./workers/workflowWorker');

const app = express();

function logEvent(level, event, fields = {}) {
  const output = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields
  });
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(securityHeaders);
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    logEvent('info', 'http.request', {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Number(process.hrtime.bigint() - startedAt) / 1e6
    });
  });
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin denied'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  maxAge: 86400
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(responseWrapper);

let shutdownPromise = null;
let worker = null;
let batchDownloadWorker = null;
let workflowWorker = null;

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', request_id: req.requestId });
});

app.get('/readyz', (req, res) => {
  let databaseReady = false;
  try {
    databaseReady = db.open && db.pragma('quick_check', { simple: true }) === 'ok';
  } catch (error) {
    logEvent('error', 'readiness.database_check_failed', {
      request_id: req.requestId,
      error: error.message
    });
  }
  const generationWorkerReady = Boolean(worker && worker.isRunning());
  const batchWorkerReady = Boolean(batchDownloadWorker && batchDownloadWorker.isRunning());
  const workflowWorkerReady = Boolean(workflowWorker && workflowWorker.isRunning());
  const ready = databaseReady && generationWorkerReady && batchWorkerReady && workflowWorkerReady && !shutdownPromise;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks: {
      database: databaseReady,
      generation_worker: generationWorkerReady,
      batch_download_worker: batchWorkerReady,
      workflow_worker: workflowWorkerReady,
      shutting_down: Boolean(shutdownPromise)
    },
    request_id: req.requestId
  });
});

app.use('/api', generalApiLimit);
app.use('/api/user/login', authLimit);
app.use('/api/user/register', authLimit);

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/user', userRoutes);
app.use('/api/workflow', workflowRoutes);
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/v1', apiV1Routes);

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

const studios = ['ecommerce', 'xiaohongshu', 'poster', 'copywriting', 'image', 'video', 'avatar', 'resume', 'ppt', 'editor', 'developer', 'gif', 'idphoto', 'workflow'];
studios.forEach(studio => {
  app.get(`/${studio}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${studio}.html`));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  logEvent('error', 'http.error', {
    request_id: req.requestId,
    method: req.method,
    path: req.path,
    error: err.message
  });
  res.status(500).json({
    code: 500,
    msg: '\u670d\u52a1\u5668\u5185\u90e8\u9519\u8bef',
    request_id: req.requestId
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.json({ code: 404, msg: '\u63a5\u53e3\u4e0d\u5b58\u5728' });
  } else {
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

worker = createGenerationWorker();
batchDownloadWorker = createBatchDownloadWorker();
workflowWorker = createWorkflowWorker();
const server = app.listen(port, host, () => {
  logEvent('info', 'server.started', { host, port });
});
worker.start();
batchDownloadWorker.start();
workflowWorker.start();

function closeServer() {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(err => err ? reject(err) : resolve());
  });
}

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logEvent('info', 'server.shutdown_started', { signal });
    await closeServer();
    await Promise.all([worker.stop(), batchDownloadWorker.stop(), workflowWorker.stop()]);
    db.close();
    logEvent('info', 'server.shutdown_completed', { signal });
  })().catch(err => {
    logEvent('error', 'server.shutdown_failed', { error: err.message });
    process.exitCode = 1;
  });
  return shutdownPromise;
}

process.once('SIGTERM', () => { shutdown('SIGTERM'); });
process.once('SIGINT', () => { shutdown('SIGINT'); });

module.exports = app;
module.exports.server = server;
module.exports.worker = worker;
module.exports.batchDownloadWorker = batchDownloadWorker;
module.exports.workflowWorker = workflowWorker;
module.exports.shutdown = shutdown;
