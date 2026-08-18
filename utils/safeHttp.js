const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

function normalizeIpLiteral(address) {
  return address.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0];
}

function isPrivateAddress(address) {
  const normalized = normalizeIpLiteral(address);
  const version = net.isIP(normalized);
  if (version === 4) {
    const parts = normalized.split('.').map(Number);
    return parts[0] === 0
      || parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 192 && parts[1] === 0 && parts[2] === 0)
      || (parts[0] === 192 && parts[1] === 0 && parts[2] === 2)
      || (parts[0] === 192 && parts[1] === 88 && parts[2] === 99)
      || (parts[0] === 198 && [18, 19].includes(parts[1]))
      || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100)
      || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
      || parts[0] >= 224;
  }
  if (version === 6) {
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7);
      if (net.isIP(mapped) === 4) return isPrivateAddress(mapped);
      return true;
    }
    return !/^[23]/.test(normalized) || normalized.startsWith('2001:db8:');
  }
  return true;
}

async function resolvePublicAddress(hostname) {
  const normalizedHostname = normalizeIpLiteral(hostname);
  if (net.isIP(normalizedHostname)) {
    if (isPrivateAddress(normalizedHostname)) throw new Error('目标地址不可访问');
    return { address: normalizedHostname, family: net.isIP(normalizedHostname) };
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateAddress(record.address))) {
    throw new Error('目标地址不可访问');
  }
  return records[0];
}

function validateUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 HTTP 或 HTTPS URL');
  if (url.username || url.password) throw new Error('URL 不允许包含认证信息');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('URL 端口不允许访问');
  return url;
}

async function requestOnce(url, options, addressRecord) {
  const client = url.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs || 10_000;
  const maxBytes = options.maxBytes || 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      servername: url.hostname,
      lookup(hostname, lookupOptions, callback) {
        if (!addressRecord || !addressRecord.address || !addressRecord.family) {
          callback(new Error('目标地址解析失败'));
          return;
        }
        if (lookupOptions && lookupOptions.all) {
          callback(null, [addressRecord]);
          return;
        }
        callback(null, addressRecord.address, addressRecord.family);
      }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error('响应体超过大小限制'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('出站请求超时')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function safeRequest(value, options = {}) {
  let url = validateUrl(value);
  let headers = { ...(options.headers || {}) };
  const maxRedirects = options.maxRedirects ?? 3;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const address = await resolvePublicAddress(url.hostname);
    const response = await requestOnce(url, { ...options, headers }, address);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) {
      return { ...response, url: url.toString() };
    }
    if (redirect === maxRedirects) throw new Error('重定向次数过多');
    const nextUrl = validateUrl(new URL(response.headers.location, url).toString());
    if (nextUrl.origin !== url.origin) {
      delete headers.Authorization;
      delete headers.authorization;
    }
    if ([301, 302, 303].includes(response.status) && !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) {
      options = { ...options, method: 'GET', body: undefined };
      delete headers['Content-Length'];
      delete headers['content-length'];
      delete headers['Content-Type'];
      delete headers['content-type'];
    }
    url = nextUrl;
  }
  throw new Error('出站请求失败');
}

async function validatePublicUrl(value) {
  const url = validateUrl(value);
  await resolvePublicAddress(url.hostname);
  return url.toString();
}

module.exports = { isPrivateAddress, validatePublicUrl, safeRequest };
