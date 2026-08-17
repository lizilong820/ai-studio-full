const jwt = require('jsonwebtoken');
const { db } = require('../database/db');

const JWT_SECRET = process.env.JWT_SECRET || 'ai_studio_jwt_secret_key_change_in_prod';

// 生成 token
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// 验证 token - 普通用户
function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // 也检查 cookie
    const token = req.cookies?.token;
    if (!token) {
      return res.json({ code: 401, msg: '请先登录' });
    }
    req.token = token;
  } else {
    req.token = authHeader.split(' ')[1];
  }

  try {
    const decoded = jwt.verify(req.token, JWT_SECRET);
    const user = db.prepare('SELECT id, username, email, credits, is_admin, status FROM users WHERE id = ?').get(decoded.id);
    
    if (!user || user.status !== 1) {
      return res.json({ code: 401, msg: '账号不存在或已被禁用' });
    }
    
    req.user = user;
    next();
  } catch (err) {
    return res.json({ code: 401, msg: '登录已过期，请重新登录' });
  }
}

// 管理员验证
function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (!req.user.is_admin) {
      return res.json({ code: 403, msg: '权限不足，需要管理员身份' });
    }
    next();
  });
}

// 可选登录 - 不强制，有token就解析
function authOptional(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  let token = null;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  }
  
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT id, username, email, credits, is_admin, status FROM users WHERE id = ?').get(decoded.id);
      if (user && user.status === 1) {
        req.user = user;
      }
    } catch (err) {
      // ignore
    }
  }
  next();
}

module.exports = { signToken, authRequired, adminRequired, authOptional, JWT_SECRET };
