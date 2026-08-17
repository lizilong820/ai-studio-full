require('dotenv').config();

const express = require('express');
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

const app = express();

// 中间件
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(securityHeaders);
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
app.use('/api', generalApiLimit);
app.use('/api/user/login', authLimit);
app.use('/api/user/register', authLimit);

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// API 路由
app.use('/api/user', userRoutes);
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/v1', apiV1Routes);

// 页面路由 (SPA 风格 - 返回对应 HTML)
// 登录/注册页
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// 管理后台
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// 工作室页面
const studios = ['ecommerce', 'xiaohongshu', 'poster', 'copywriting', 'image', 'video', 'avatar', 'resume', 'ppt', 'editor', 'developer', 'gif', 'idphoto'];
studios.forEach(studio => {
  app.get(`/${studio}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${studio}.html`));
  });
});

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 错误处理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ code: 500, msg: '服务器内部错误' });
});

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.json({ code: 404, msg: '接口不存在' });
  } else {
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(port, host, () => {
  console.log(`AI工作室已启动：http://${host}:${port}`);
});
