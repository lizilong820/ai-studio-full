/**
 * 虎皮椒支付工具
 * 文档: https://www.xunhupay.com/doc/api/pay.html
 */
const crypto = require('crypto');

function getSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'xunhupay_%'").all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    appid: map.xunhupay_appid || '',
    appsecret: map.xunhupay_appsecret || '',
    gateway: map.xunhupay_gateway || 'https://api.xunhupay.com',
    enabled: map.xunhupay_enabled === '1',
  };
}

/**
 * 生成签名
 * 规则: 按 key 字典序排序，过滤空值和hash，拼接 key=val&key=val，末尾拼 &appsecret=xxx，MD5
 */
function generateSign(params, appSecret) {
  const keys = Object.keys(params)
    .filter(k => k !== 'hash' && params[k] !== '' && params[k] !== null && params[k] !== undefined)
    .sort();
  const str = keys.map(k => `${k}=${params[k]}`).join('&') + `&appsecret=${appSecret}`;
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * 发起支付请求（创建订单）
 */
async function createPayment(db, options) {
  const cfg = getSettings(db);
  if (!cfg.enabled || !cfg.appid || !cfg.appsecret) {
    throw new Error('支付通道未启用或配置不完整');
  }

  const nonceStr = crypto.randomBytes(8).toString('hex');
  const time = Math.floor(Date.now() / 1000);

  const params = {
    version: '1.1',
    appid: cfg.appid,
    trade_order_id: options.trade_order_id,
    total_fee: options.total_fee,
    title: options.title,
    time: time,
    notify_url: options.notify_url,
    nonce_str: nonceStr,
  };
  if (options.return_url) params.return_url = options.return_url;
  if (options.callback_url) params.callback_url = options.callback_url;
  if (options.attach) params.attach = options.attach;
  if (options.plugins) params.plugins = options.plugins;

  params.hash = generateSign(params, cfg.appsecret);

  const url = cfg.gateway + '/payment/do.html';
  const fetch = globalThis.fetch || require('node-fetch');

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const result = await resp.json();
  return result;
}

/**
 * 验证回调签名
 */
function verifyCallback(params, db) {
  const cfg = getSettings(db);
  if (!cfg.appsecret) return false;

  const hash = params.hash;
  if (!hash) return false;

  const calc = generateSign(params, cfg.appsecret);
  return calc.toLowerCase() === hash.toLowerCase();
}

module.exports = {
  getSettings,
  generateSign,
  createPayment,
  verifyCallback,
};
