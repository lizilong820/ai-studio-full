const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { db, getSetting } = require('../database/db');
const { signToken, authRequired } = require('../middleware/auth');
const creditService = require('../controllers/creditService');
const xunhupay = require('../utils/xunhupay');


// ========== 缩略图生成 ==========
const THUMB_DIR = path.join(__dirname, '..', 'public', 'uploads', 'thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

function generateThumbnail(srcUrl) {
  return new Promise((resolve) => {
    try {
      if (!srcUrl || !srcUrl.startsWith('/uploads/')) {
        resolve(null);
        return;
      }
      const srcPath = path.join(__dirname, '..', 'public', srcUrl);
      if (!fs.existsSync(srcPath)) {
        resolve(null);
        return;
      }
      const ext = path.extname(srcPath).toLowerCase();
      const baseName = path.basename(srcPath, ext);
      const thumbName = baseName + '_thumb.jpg';
      const thumbPath = path.join(THUMB_DIR, thumbName);
      const thumbUrl = '/uploads/thumbs/' + thumbName;

      if (fs.existsSync(thumbPath)) {
        resolve(thumbUrl);
        return;
      }

      const imgExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
      const gifExts = ['.gif'];
      const videoExts = ['.mp4', '.webm', '.mov', '.avi'];

      let cmd = '';
      if (imgExts.includes(ext)) {
        cmd = 'ffmpeg -y -i "' + srcPath + '" -vf "scale=300:-1" -q:v 6 "' + thumbPath + '" 2>/dev/null';
      } else if (gifExts.includes(ext)) {
        cmd = 'ffmpeg -y -i "' + srcPath + '" -vf "scale=300:-1" -frames:v 1 -q:v 6 "' + thumbPath + '" 2>/dev/null';
      } else if (videoExts.includes(ext)) {
        cmd = 'ffmpeg -y -i "' + srcPath + '" -vf "scale=300:-1" -ss 00:00:01 -frames:v 1 -q:v 6 "' + thumbPath + '" 2>/dev/null';
      } else {
        resolve(null);
        return;
      }

      exec(cmd, (err) => {
        if (err || !fs.existsSync(thumbPath)) {
          resolve(null);
        } else {
          resolve(thumbUrl);
        }
      });
    } catch (e) {
      resolve(null);
    }
  });
}


const router = express.Router();

// 注册
router.post('/register', (req, res) => {
  const { username, password, email } = req.body;
  
  if (!username || !password) {
    return res.error('用户名和密码不能为空');
  }
  
  if (username.length < 3 || username.length > 20) {
    return res.error('用户名长度为3-20位');
  }
  
  if (password.length < 6) {
    return res.error('密码至少6位');
  }
  
  // 检查是否开启注册
  if (getSetting('enable_register', '1') !== '1') {
    return res.error('注册功能已关闭');
  }
  
  // 检查用户名是否存在
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.error('用户名已存在');
  }
  
  const hash = bcrypt.hashSync(password, 10);
  const configuredBonus = parseInt(getSetting('register_bonus_credits', '100'), 10);
  const bonus = Number.isSafeInteger(configuredBonus) && configuredBonus >= 0 ? configuredBonus : 0;
  const inviteCode = req.body.invite_code || '';
  let invitedBy = 0;

  // 验证邀请码
  if (inviteCode) {
    const inviter = db.prepare('SELECT id FROM users WHERE invite_code = ?').get(inviteCode.toUpperCase());
    if (inviter) invitedBy = inviter.id;
  }

  // 生成邀请码
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let userInviteCode = '';
  for (let i = 0; i < 6; i++) {
    userInviteCode += chars[Math.floor(Math.random() * chars.length)];
  }

  const registerTransaction = db.transaction(() => {
    const result = db.prepare(`INSERT INTO users (username, password_hash, email, credits, is_admin, status, invited_by, invite_code)
                               VALUES (?, ?, ?, 0, 0, 1, ?, ?)`).run(username, hash, email || '', invitedBy, userInviteCode);
    const userId = result.lastInsertRowid;

    if (bonus > 0) {
      creditService.addCredits(userId, bonus, 'recharge', '注册赠送积分');
    }

    if (invitedBy > 0) {
      const configuredInviteBonus = parseInt(getSetting('invite_bonus_credits', '50'), 10);
      const inviteBonus = Number.isSafeInteger(configuredInviteBonus) && configuredInviteBonus >= 0
        ? configuredInviteBonus
        : 50;
      if (inviteBonus > 0) {
        creditService.addCredits(invitedBy, inviteBonus, 'recharge', `邀请好友奖励（${username}）`);
      }
    }

    return userId;
  });

  const userId = registerTransaction();
  
  const user = db.prepare('SELECT id, username, email, credits, is_admin FROM users WHERE id = ?').get(userId);
  const token = signToken(user);
  
  res.success({ token, user }, '注册成功');
});

// 登录
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.error('用户名和密码不能为空');
  }
  
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.error('用户名或密码错误');
  }
  
  if (user.status !== 1) {
    return res.error('账号已被禁用，请联系管理员');
  }
  
  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.error('用户名或密码错误');
  }
  
  const safeUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    credits: user.credits,
    is_admin: user.is_admin,
  };
  
  const token = signToken(safeUser);
  
  res.success({ token, user: safeUser }, '登录成功');
});

// 获取当前用户信息
router.get('/profile', authRequired, (req, res) => {
  // 从数据库重新获取最新信息
  const user = db.prepare('SELECT id, username, email, credits, is_admin, status, created_at FROM users WHERE id = ?').get(req.user.id);
  res.success(user);
});

// 修改密码
router.post('/change-password', authRequired, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  
  if (!oldPassword || !newPassword) {
    return res.error('旧密码和新密码不能为空');
  }
  
  if (newPassword.length < 6) {
    return res.error('新密码至少6位');
  }
  
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const valid = bcrypt.compareSync(oldPassword, user.password_hash);
  
  if (!valid) {
    return res.error('旧密码错误');
  }
  
  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  
  res.success({}, '密码修改成功');
});

// 获取生成历史
router.get('/generations', authRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const studio = req.query.studio || '';
  const offset = (page - 1) * pageSize;
  
  let sql = `SELECT g.*, m.name as model_name 
             FROM generations g 
             LEFT JOIN models m ON g.model_id = m.id
             WHERE g.user_id = ?`;
  const params = [req.user.id];
  
  if (studio) {
    sql += ' AND g.studio_type = ?';
    params.push(studio);
  }
  
  sql += ' ORDER BY g.id DESC LIMIT ? OFFSET ?';
  params.push(pageSize, offset);
  
  const list = db.prepare(sql).all(...params);
  
  let countSql = 'SELECT COUNT(*) as count FROM generations WHERE user_id = ?';
  const countParams = [req.user.id];
  if (studio) {
    countSql += ' AND studio_type = ?';
    countParams.push(studio);
  }
  const total = db.prepare(countSql).get(...countParams).count;
  
  // 解析JSON字段
  list.forEach(item => {
    if (item.params) {
      try { item.params = JSON.parse(item.params); } catch (e) {}
    }
    if (item.result) {
      try { item.result = JSON.parse(item.result); } catch (e) {}
    }
  });
  
  res.success({ list, total, page, pageSize });
});

// 获取积分流水
router.get('/credit-logs', authRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const result = creditService.getCreditLogs(req.user.id, page, pageSize);
  res.success(result);
});

// ========== 作品管理 ==========

// 收藏/取消收藏作品
router.post('/generation/:id/favorite', authRequired, (req, res) => {
  const genId = parseInt(req.params.id);
  const gen = db.prepare('SELECT id, user_id FROM generations WHERE id = ?').get(genId);
  if (!gen || gen.user_id !== req.user.id) return res.error('作品不存在');

  const existing = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND generation_id = ?')
    .get(req.user.id, genId);
  
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND generation_id = ?').run(req.user.id, genId);
    db.prepare('UPDATE generations SET is_favorite = 0 WHERE id = ?').run(genId);
    res.success({ favored: false }, '已取消收藏');
  } else {
    db.prepare('INSERT INTO favorites (user_id, generation_id) VALUES (?, ?)').run(req.user.id, genId);
    db.prepare('UPDATE generations SET is_favorite = 1 WHERE id = ?').run(genId);
    res.success({ favored: true }, '已收藏');
  }
});

// 删除作品
router.delete('/generation/:id', authRequired, (req, res) => {
  const genId = parseInt(req.params.id);
  const gen = db.prepare('SELECT id, user_id, status, credits_used FROM generations WHERE id = ?').get(genId);
  if (!gen || gen.user_id !== req.user.id) return res.error('作品不存在');

  db.prepare('DELETE FROM favorites WHERE generation_id = ?').run(genId);
  db.prepare('DELETE FROM generations WHERE id = ? AND user_id = ?').run(genId, req.user.id);
  res.success({}, '已删除');
});

// 批量删除作品
router.post('/works/batch-delete', authRequired, (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.error('请选择要删除的作品');
  if (ids.length > 100) return res.error('一次最多删除100个');

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM generations WHERE id IN (${placeholders}) AND user_id = ?`).all(...ids, req.user.id);
  const validIds = rows.map(r => r.id);

  const tx = db.transaction(() => {
    const ph = validIds.map(() => '?').join(',');
    if (validIds.length > 0) {
      db.prepare(`DELETE FROM favorites WHERE generation_id IN (${ph})`).run(...validIds);
      db.prepare(`DELETE FROM generations WHERE id IN (${ph}) AND user_id = ?`).run(...validIds, req.user.id);
    }
  });
  tx();

  res.success({ deleted: validIds.length }, `已删除 ${validIds.length} 个作品`);
});

// 批量下载作品（异步打包）
const batchTasks = new Map(); // taskId -> { status, filePath, total, done, error }

router.post('/works/batch-download', authRequired, (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.error('请选择要下载的作品');
  if (ids.length > 50) return res.error('一次最多下载50个');

  const taskId = 'bdl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  batchTasks.set(taskId, { status: 'processing', filePath: null, total: ids.length, done: 0, error: null, userId: req.user.id });

  // 异步打包
  setImmediate(() => processBatchDownload(taskId, ids, req.user.id));

  res.success({ taskId }, '打包任务已创建');
});

// 查询打包进度
router.get('/works/batch-download/:taskId', authRequired, (req, res) => {
  const task = batchTasks.get(req.params.taskId);
  if (!task) return res.error('任务不存在');
  if (task.userId !== req.user.id) return res.error('无权访问');
  res.success({
    status: task.status,
    total: task.total,
    done: task.done,
    downloadUrl: task.status === 'done' ? `/api/user/works/batch-download/${req.params.taskId}/download` : null,
    error: task.error
  });
});

// 下载打包好的文件
router.get('/works/batch-download/:taskId/download', authRequired, (req, res) => {
  const task = batchTasks.get(req.params.taskId);
  if (!task || task.status !== 'done') return res.error('文件不存在或未就绪');
  if (task.userId !== req.user.id) return res.error('无权访问');
  res.download(task.filePath, `works_${req.params.taskId}.zip`, err => {
    if (err) console.error('download error:', err);
  });
});

async function processBatchDownload(taskId, ids, userId) {
  const task = batchTasks.get(taskId);
  if (!task) return;

  try {
    const tmpDir = path.join(__dirname, '..', 'tmp', taskId);
    const zipPath = path.join(__dirname, '..', 'tmp', taskId + '.zip');
    const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');

    // 确保临时目录存在
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(__dirname, '..', 'tmp'), { recursive: true });

    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, studio_type, result, created_at FROM generations WHERE id IN (${placeholders}) AND user_id = ?`).all(...ids, userId);

    const studioMap = { ecommerce: '电商套图', xiaohongshu: '小红书', poster: '海报', copywriting: '文案', ppt: 'PPT', video: '视频', resume: '简历', avatar: '头像', image: 'AI绘图', 'image-edit': '图生图', gif: 'GIF表情包' };

    let count = 0;
    for (const row of rows) {
      const studioName = (studioMap[row.studio_type] || row.studio_type).replace(/[\\/:*?"<>|]/g, '_');
      let images = [];
      let title = `作品_${row.id}`;
      if (row.result) {
        try {
          const r = JSON.parse(row.result);
          if (r.images && r.images.length) images = r.images;
          else if (r.posters && r.posters.length) images = r.posters.map(p => typeof p === 'string' ? p : (p.image || p.url || ''));
          else if (r.image) images = [r.image];
          else if (r.gif) images = [r.gif];
          if (r.title) title = r.title;
        } catch(e) {}
      }

      const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 40);
      const studioDir = path.join(tmpDir, studioName);
      if (!fs.existsSync(studioDir)) fs.mkdirSync(studioDir, { recursive: true });

      for (let i = 0; i < images.length; i++) {
        const imgUrl = images[i];
        if (!imgUrl) continue;
        if (imgUrl.startsWith('/uploads/')) {
          const localPath = path.join(uploadsDir, path.basename(imgUrl));
          if (fs.existsSync(localPath)) {
            const ext = path.extname(imgUrl) || '.png';
            const destPath = path.join(studioDir, `${cleanTitle}_${i+1}${ext}`);
            // 用硬链接，秒级完成
            try {
              fs.linkSync(localPath, destPath);
            } catch(e) {
              // 硬链接失败就复制
              fs.copyFileSync(localPath, destPath);
            }
          }
        }
      }
      count++;
      task.done = count;
    }

    // 用系统zip命令打包，飞快
    await new Promise((resolve, reject) => {
      exec(`cd "${tmpDir}" && zip -r -q "${zipPath}" .`, { maxBuffer: 100 * 1024 * 1024 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });

    task.status = 'done';
    task.filePath = zipPath;

    // 30分钟后清理
    setTimeout(() => {
      try {
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        batchTasks.delete(taskId);
      } catch(e) {}
    }, 30 * 60 * 1000);

  } catch(err) {
    console.error('batch download error:', err);
    task.status = 'failed';
    task.error = err.message;
  }
}

// 我的作品 (升级版 - 支持收藏/工作室/状态筛选 + 网格视图)
router.get('/works', authRequired, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 12;
  const offset = (page - 1) * pageSize;
  const studio = req.query.studio || '';
  const status = req.query.status || '';
  const favored = req.query.favored === '1';

  let whereSql = 'WHERE g.user_id = ?';
  const params = [req.user.id];

  if (studio) {
    whereSql += ' AND g.studio_type = ?';
    params.push(studio);
  }
  if (status) {
    whereSql += ' AND g.status = ?';
    params.push(status);
  }
  if (favored) {
    whereSql += ' AND g.is_favorite = 1';
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM generations g ${whereSql}`).get(...params).cnt;

  const rows = db.prepare(`
    SELECT g.id, g.studio_type, g.status, g.credits_used, g.result, g.is_favorite, g.created_at
    FROM generations g
    ${whereSql}
    ORDER BY g.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const list = rows.map(item => {
    let cover = null;
    let itemCount = 0;
    let title = '';
    if (item.result) {
      try {
        const r = JSON.parse(item.result);
        if (r.images && r.images.length) { cover = r.images[0]; itemCount = r.images.length; }
        else if (r.posters && r.posters.length) {
          const p = r.posters[0];
          cover = typeof p === 'string' ? p : (p.image || p.url || '');
          itemCount = r.posters.length;
        }
        else if (r.versions && r.versions.length) {
          title = r.versions[0].title || r.versions[0].content?.substring(0, 30);
          itemCount = r.versions.length;
        }
        else if (r.notes && r.notes.length) {
          title = r.notes[0].title || r.notes[0].content?.substring(0, 30);
          itemCount = r.notes.length;
        }
        else if (r.copies && r.copies.length) {
          title = r.copies[0].title || r.copies[0].content?.substring(0, 30);
          itemCount = r.copies.length;
        }
        else if (r.gif) {
          cover = r.gif;
          itemCount = 1;
        }
        else if (r.video) {
          cover = r.video;
          itemCount = 1;
        }
        else if (r.audio_url) {
          title = r.file_name || '音频';
          cover = r.audio_url;
          itemCount = 1;
        }
      } catch (e) {}
    }
    return {
      id: item.id,
      studio_type: item.studio_type,
      status: item.status,
      credits_used: item.credits_used,
      cover,
      title,
      item_count: itemCount,
      is_favorite: !!item.is_favorite,
      created_at: item.created_at,
    };
  });


  // 生成缩略图（最多等1.5秒，避免首次生成阻塞太久）
  await Promise.race([
    Promise.all(list.map(item => {
      if (item.cover && item.cover.startsWith('/uploads/') && item.studio_type !== 'audio') {
        return generateThumbnail(item.cover).then(thumb => {
          if (thumb) item.thumbnail = thumb;
        });
      }
      return Promise.resolve();
    })),
    new Promise(r => setTimeout(r, 1500))
  ]);
  res.success({ list, total, page, pageSize });
});


// 作品详情（返回完整 result）
router.get('/works/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const row = db.prepare(`
    SELECT g.*, m.name as model_name
    FROM generations g
    LEFT JOIN models m ON g.model_id = m.id
    WHERE g.id = ? AND g.user_id = ?
  `).get(id, req.user.id);
  if (!row) return res.error('作品不存在');
  if (row.params) { try { row.params = JSON.parse(row.params); } catch(e) {} }
  if (row.result) { try { row.result = JSON.parse(row.result); } catch(e) {} }
  res.success(row);
});

// ========== 充值套餐 & 订单 ==========

// 获取充值套餐列表
router.get('/recharge/packages', (req, res) => {
  const list = db.prepare('SELECT id, name, price, credits, bonus FROM recharge_packages WHERE status = 1 ORDER BY sort ASC, id ASC').all();
  res.success(list);
});

// 创建充值订单
router.post('/recharge/create', authRequired, (req, res) => {
  const { package_id } = req.body;
  if (!package_id) return res.error('请选择充值套餐');

  const pkg = db.prepare('SELECT * FROM recharge_packages WHERE id = ? AND status = 1').get(package_id);
  if (!pkg) return res.error('套餐不存在或已下架');

  const totalCredits = pkg.credits + (pkg.bonus || 0);

  const result = db.prepare(`INSERT INTO orders
    (user_id, package_id, amount, credits, status, pay_method, remark)
    VALUES (?, ?, ?, ?, 'pending', 'manual', '手动充值订单')`)
    .run(req.user.id, package_id, pkg.price, totalCredits);

  const orderId = result.lastInsertRowid;

  // 生成订单号
  const orderNo = 'ORD' + Date.now().toString().slice(-10) + String(orderId).padStart(4, '0');
  db.prepare('UPDATE orders SET remark = ? WHERE id = ?').run(orderNo, orderId);

  res.success({
    order_id: orderId,
    order_no: orderNo,
    package_name: pkg.name,
    amount: pkg.price,
    credits: totalCredits,
    pay_tip: '当前为演示模式，请联系管理员手动充值到账。'
  }, '订单已创建');
});


// ===== 虎皮椒支付 =====

// 创建支付订单
router.post('/recharge/pay', authRequired, async (req, res) => {
  try {
    const { package_id } = req.body;
    if (!package_id) return res.error('请选择充值套餐');

    const cfg = xunhupay.getSettings(db);
    if (!cfg.enabled || !cfg.appid || !cfg.appsecret) {
      return res.error('支付通道暂未开通，请联系管理员');
    }

    const pkg = db.prepare('SELECT * FROM recharge_packages WHERE id = ? AND status = 1').get(package_id);
    if (!pkg) return res.error('套餐不存在或已下架');

    const totalCredits = pkg.credits + (pkg.bonus || 0);

    // 创建订单
    const result = db.prepare(`INSERT INTO orders
      (user_id, package_id, amount, credits, status, pay_method, remark)
      VALUES (?, ?, ?, ?, 'pending', 'xunhupay', '')`)
      .run(req.user.id, package_id, pkg.price, totalCredits);

    const orderId = result.lastInsertRowid;
    const tradeOrderId = 'RECHARGE' + Date.now().toString() + String(orderId).padStart(4, '0');

    // 更新订单号到 remark 字段（保持原有习惯）
    db.prepare('UPDATE orders SET remark = ? WHERE id = ?').run(tradeOrderId, orderId);

    // 调用虎皮椒下单
    const notifyUrl = 'https://ai.whaios.com/api/payment/xunhupay/notify';
    const returnUrl = 'https://ai.whaios.com/profile.html?tab=orders';

    const payResult = await xunhupay.createPayment(db, {
      trade_order_id: tradeOrderId,
      total_fee: pkg.price,
      title: '积分充值 - ' + pkg.name,
      notify_url: notifyUrl,
      return_url: returnUrl,
      attach: JSON.stringify({ order_id: orderId, user_id: req.user.id }),
      plugins: 'ai-studio',
    });

    // 返回支付信息
    res.success({
      order_id: orderId,
      trade_order_id: tradeOrderId,
      package_name: pkg.name,
      amount: pkg.price,
      credits: totalCredits,
      url_qrcode: payResult.url_qrcode || '',
      url: payResult.url || '',
      pay_result: payResult,
    });

  } catch (err) {
    console.error('创建支付订单失败:', err);
    res.error('支付创建失败：' + err.message);
  }
});

// 查询支付订单状态（轮询用）
router.get('/recharge/query/:orderId', authRequired, (req, res) => {
  const orderId = parseInt(req.params.orderId);
  if (!orderId) return res.error('订单ID无效');

  const order = db.prepare('SELECT id, status, amount, credits, paid_at, pay_method, created_at FROM orders WHERE id = ? AND user_id = ?')
    .get(orderId, req.user.id);

  if (!order) return res.error('订单不存在');

  res.success({
    order_id: order.id,
    status: order.status,
    amount: order.amount,
    credits: order.credits,
    paid_at: order.paid_at,
    pay_method: order.pay_method,
    created_at: order.created_at,
  });
});

// 我的订单
router.get('/orders', authRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const offset = (page - 1) * pageSize;

  const total = db.prepare('SELECT COUNT(*) as cnt FROM orders WHERE user_id = ?').get(req.user.id).cnt;
  const list = db.prepare(`
    SELECT o.id, o.amount, o.credits, o.status, o.pay_method, o.paid_at, o.created_at,
           p.name as package_name
    FROM orders o
    LEFT JOIN recharge_packages p ON o.package_id = p.id
    WHERE o.user_id = ?
    ORDER BY o.id DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, pageSize, offset);

  res.success({ list, total, page, pageSize });
});

// ========== 每日签到 ==========

router.post('/sign', authRequired, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const signTransaction = db.transaction(() => {
    const user = db.prepare('SELECT sign_days, last_sign_at FROM users WHERE id = ?').get(req.user.id);
    const lastSign = user.last_sign_at ? user.last_sign_at.slice(0, 10) : '';
    if (lastSign === today) return null;

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const isConsecutive = lastSign === yesterday;
    const newDays = isConsecutive ? (user.sign_days || 0) + 1 : 1;
    const bonus = Math.min(5 + (newDays - 1), 20);

    const updateResult = db.prepare(`UPDATE users
      SET sign_days = ?, last_sign_at = ?
      WHERE id = ? AND COALESCE(substr(last_sign_at, 1, 10), '') <> ?`)
      .run(newDays, today, req.user.id, today);
    if (updateResult.changes !== 1) return null;

    const balance = creditService.addCredits(
      req.user.id,
      bonus,
      'recharge',
      `每日签到奖励（连续${newDays}天）`
    );
    return { bonus, sign_days: newDays, total_credits: balance };
  });

  const result = signTransaction();
  if (!result) return res.error('今天已签到过了');

  res.success(result, `签到成功，获得 ${result.bonus} 积分`);
});

// 签到状态
router.get('/sign-status', authRequired, (req, res) => {
  const user = db.prepare('SELECT sign_days, last_sign_at FROM users WHERE id = ?').get(req.user.id);
  const today = new Date().toISOString().slice(0, 10);
  const lastSign = user.last_sign_at ? user.last_sign_at.slice(0, 10) : '';
  const signedToday = lastSign === today;

  // 7天签到日历
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    days.push({
      date: dateStr,
      day: d.getDate(),
      signed: user.last_sign_at && user.last_sign_at.slice(0, 10) === dateStr,
      bonus: Math.min(5 + ((6 - i) % 7), 20), // 仅示意
      is_today: i === 0,
    });
  }

  res.success({
    signed_today: signedToday,
    sign_days: user.sign_days || 0,
    today_bonus: Math.min(5 + ((user.sign_days || 0) % 7), 20),
    week_days: days,
  });
});

// ========== 邀请好友 ==========

router.get('/invite-info', authRequired, (req, res) => {
  const user = db.prepare('SELECT invite_code FROM users WHERE id = ?').get(req.user.id);
  const inviteCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE invited_by = ?').get(req.user.id).cnt;
  const inviteBonus = parseInt(getSetting('invite_bonus_credits', '50')) || 50;

  res.success({
    invite_code: user.invite_code,
    invite_count: inviteCount,
    invite_bonus: inviteBonus,
    share_url: `/register?invite=${user.invite_code}`,
  });
});

// ========== 参数模板 ==========

router.get('/templates', authRequired, (req, res) => {
  const studio = req.query.studio || '';
  let sql = 'SELECT id, name, studio_type, params, created_at FROM param_templates WHERE user_id = ?';
  const params = [req.user.id];
  if (studio) { sql += ' AND studio_type = ?'; params.push(studio); }
  sql += ' ORDER BY id DESC';
  const list = db.prepare(sql).all(...params);
  list.forEach(t => {
    try { t.params = JSON.parse(t.params); } catch (e) {}
  });
  res.success(list);
});

router.post('/templates', authRequired, (req, res) => {
  const { name, studio_type, params } = req.body;
  if (!name || !studio_type || !params) return res.error('参数不完整');

  const result = db.prepare(`INSERT INTO param_templates (user_id, name, studio_type, params)
    VALUES (?, ?, ?, ?)`).run(req.user.id, name, studio_type, JSON.stringify(params));
  res.success({ id: result.lastInsertRowid }, '模板已保存');
});

router.delete('/templates/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const tpl = db.prepare('SELECT id FROM param_templates WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!tpl) return res.error('模板不存在');
  db.prepare('DELETE FROM param_templates WHERE id = ?').run(id);
  res.success({}, '已删除');
});

// ========== 搜索 ==========

// 搜索作品
router.get('/search', authRequired, (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 12;
  const offset = (page - 1) * pageSize;

  if (!keyword) return res.error('请输入搜索关键词');

  // 记录搜索历史
  const existingHistory = db.prepare('SELECT id FROM search_history WHERE user_id = ? AND keyword = ?')
    .get(req.user.id, keyword);
  if (existingHistory) {
    db.prepare('UPDATE search_history SET search_count = search_count + 1, updated_at = datetime("now","localtime") WHERE id = ?')
      .run(existingHistory.id);
  } else {
    db.prepare('INSERT INTO search_history (user_id, keyword) VALUES (?, ?)').run(req.user.id, keyword);
  }

  // 搜索：匹配工作室类型名 + params JSON里的内容 + result里的文本
  const searchTerm = `%${keyword}%`;
  const total = db.prepare(`
    SELECT COUNT(*) as cnt FROM generations
    WHERE user_id = ? AND (
      studio_type LIKE ? OR
      params LIKE ? OR
      result LIKE ?
    )
  `).get(req.user.id, searchTerm, searchTerm, searchTerm).cnt;

  const rows = db.prepare(`
    SELECT id, studio_type, status, credits_used, result, is_favorite, created_at
    FROM generations
    WHERE user_id = ? AND (
      studio_type LIKE ? OR
      params LIKE ? OR
      result LIKE ?
    )
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, searchTerm, searchTerm, searchTerm, pageSize, offset);

  const list = rows.map(item => {
    let cover = null;
    let title = '';
    let itemCount = 0;
    if (item.result) {
      try {
        const r = JSON.parse(item.result);
        if (r.images && r.images.length) { cover = r.images[0]; itemCount = r.images.length; }
        else if (r.posters && r.posters.length) {
          const p = r.posters[0];
          cover = typeof p === 'string' ? p : (p.image || '');
          itemCount = r.posters.length;
        }
        else if (r.versions && r.versions.length) {
          title = r.versions[0].title || r.versions[0].content?.substring(0, 40);
          itemCount = r.versions.length;
        }
        else if (r.notes && r.notes.length) {
          title = r.notes[0].title || '';
          itemCount = r.notes.length;
        }
        else if (r.gif) {
          cover = r.gif;
          itemCount = 1;
        }
        else if (r.video) {
          cover = r.video;
          itemCount = 1;
        }
        else if (r.audio_url) {
          title = r.file_name || '音频';
          cover = r.audio_url;
          itemCount = 1;
        }
      } catch (e) {}
    }
    return {
      id: item.id,
      studio_type: item.studio_type,
      status: item.status,
      credits_used: item.credits_used,
      cover,
      title,
      item_count: itemCount,
      is_favorite: !!item.is_favorite,
      created_at: item.created_at,
    };
  });

  // 热门搜索 (全站top10)
  const hotSearches = db.prepare(`
    SELECT keyword, SUM(search_count) as cnt
    FROM search_history
    GROUP BY keyword
    ORDER BY cnt DESC
    LIMIT 10
  `).all();

  res.success({ list, total, page, pageSize, hot_searches: hotSearches.map(s => s.keyword) });
});

// 搜索历史
router.get('/search/history', authRequired, (req, res) => {
  const list = db.prepare(`
    SELECT keyword, search_count
    FROM search_history
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(req.user.id);
  res.success(list.map(i => i.keyword));
});

router.delete('/search/history', authRequired, (req, res) => {
  db.prepare('DELETE FROM search_history WHERE user_id = ?').run(req.user.id);
  res.success({}, '搜索历史已清空');
});

// ========== API 密钥管理 ==========

// 获取我的API密钥列表
router.get('/api-keys', authRequired, (req, res) => {
  const list = db.prepare(`
    SELECT id, name, api_key, status, last_used_at, created_at
    FROM api_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id);

  // 返回掩码后的key
  res.success(list.map(k => ({
    id: k.id,
    name: k.name,
    api_key_masked: maskKey(k.api_key),
    api_key_full: '', // 默认不返回完整key
    status: k.status,
    last_used_at: k.last_used_at,
    created_at: k.created_at
  })));
});

// 创建API密钥
router.post('/api-keys', authRequired, (req, res) => {
  const { name } = req.body;
  const userId = req.user.id;

  // 检查数量限制
  const count = db.prepare('SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = ?').get(userId).cnt;
  if (count >= 5) {
    return res.error('每个用户最多创建5个API密钥');
  }

  const keyName = (name || '默认密钥').toString().slice(0, 50);
  const apiKey = generateApiKey();

  try {
    const result = db.prepare(`
      INSERT INTO api_keys (user_id, name, api_key, status)
      VALUES (?, ?, ?, 1)
    `).run(userId, keyName, apiKey);

    res.success({
      id: result.lastInsertRowid,
      name: keyName,
      api_key: apiKey,
      status: 1,
      created_at: new Date().toLocaleString('zh-CN')
    }, '密钥创建成功，请妥善保管，仅显示一次');
  } catch (err) {
    return res.error('创建失败，请重试');
  }
});

// 查看完整密钥（需要验证密码？这里简化直接返回，但记录操作）
router.get('/api-keys/:id/reveal', authRequired, (req, res) => {
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!key) return res.error('密钥不存在');
  res.success({ api_key: key.api_key });
});

// 更新密钥状态（启用/禁用）
router.put('/api-keys/:id/status', authRequired, (req, res) => {
  const { status } = req.body;
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!key) return res.error('密钥不存在');

  db.prepare('UPDATE api_keys SET status = ? WHERE id = ?').run(status === 0 ? 0 : 1, req.params.id);
  res.success({}, status === 0 ? '密钥已禁用' : '密钥已启用');
});

// 重命名密钥
router.put('/api-keys/:id/name', authRequired, (req, res) => {
  const { name } = req.body;
  if (!name || !name.toString().trim()) return res.error('名称不能为空');

  const key = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!key) return res.error('密钥不存在');

  db.prepare('UPDATE api_keys SET name = ? WHERE id = ?').run(name.toString().slice(0, 50), req.params.id);
  res.success({}, '名称已更新');
});

// 删除密钥
router.delete('/api-keys/:id', authRequired, (req, res) => {
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!key) return res.error('密钥不存在');

  db.prepare('DELETE FROM api_usage WHERE api_key_id = ?').run(req.params.id);
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
  res.success({}, '密钥已删除');
});

// API调用统计概览
router.get('/api-usage/summary', authRequired, (req, res) => {
  const userId = req.user.id;

  // 今日调用次数
  const todayCount = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(cost), 0) as cost
    FROM api_usage
    WHERE user_id = ? AND endpoint != '/api/v1/task/:id' AND DATE(created_at) = DATE('now', 'localtime')
  `).get(userId);

  // 累计调用次数
  const totalCount = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(cost), 0) as cost
    FROM api_usage
    WHERE user_id = ? AND endpoint != '/api/v1/task/:id'
  `).get(userId);

  // 本月消耗
  const monthCost = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as cost
    FROM api_usage
    WHERE user_id = ? AND endpoint != '/api/v1/task/:id' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
  `).get(userId);

  res.success({
    today_calls: todayCount.cnt,
    today_cost: todayCount.cost,
    total_calls: totalCount.cnt,
    total_cost: totalCount.cost,
    month_cost: monthCost.cost
  });
});

// API调用记录列表
router.get('/api-usage', authRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const days = parseInt(req.query.days) || 0;
  const offset = (page - 1) * pageSize;
  const userId = req.user.id;

  let whereClause = "WHERE user_id = ? AND endpoint != '/api/v1/task/:id'";
  let params = [userId];
  if (days > 0) {
    whereClause += " AND created_at >= DATE('now', 'localtime', '-' || ? || ' day')";
    params.push(days - 1);
  }

  const list = db.prepare(`
    SELECT id, endpoint, studio_type, task_id, status, cost, response_time, created_at
    FROM api_usage
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare('SELECT COUNT(*) as cnt FROM api_usage ' + whereClause).get(...params).cnt;

  res.success({ list, total, page, pageSize });
});

// API调用趋势（近N天）
router.get('/api-usage/trend', authRequired, (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const userId = req.user.id;

  const data = db.prepare(`
    SELECT 
      DATE(created_at) as date,
      COUNT(*) as calls,
      COALESCE(SUM(cost), 0) as cost
    FROM api_usage
    WHERE user_id = ? AND endpoint != '/api/v1/task/:id' AND created_at >= DATE('now', 'localtime', '-' || ? || ' day')
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all(userId, days - 1);

  // 补全缺失的日期
  const result = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const found = data.find(x => x.date === dateStr);
    result.push({
      date: dateStr,
      calls: found ? found.calls : 0,
      cost: found ? found.cost : 0
    });
  }

  res.success(result);
});

// 各接口调用占比
router.get('/api-usage/by-endpoint', authRequired, (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const userId = req.user.id;

  const data = db.prepare(`
    SELECT 
      endpoint,
      COUNT(*) as calls,
      COALESCE(SUM(cost), 0) as cost
    FROM api_usage
    WHERE user_id = ? AND endpoint != '/api/v1/task/:id' AND created_at >= DATE('now', 'localtime', '-' || ? || ' day')
    GROUP BY endpoint
    ORDER BY calls DESC
  `).all(userId, days - 1);

  res.success(data);
});

// 工具函数
function generateApiKey() {
  const crypto = require('crypto');
  return 'sk_' + crypto.randomBytes(16).toString('hex');
}

function maskKey(key) {
  if (!key || key.length <= 10) return '****';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

module.exports = router;
