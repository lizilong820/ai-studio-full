const crypto = require('crypto');

function generateApiKey() {
  return 'sk_' + crypto.randomBytes(32).toString('hex');
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

function getApiKeyPrefix(apiKey) {
  return apiKey.slice(0, 10);
}

function maskApiKey(prefix) {
  return prefix ? `${prefix}...` : '****';
}

module.exports = { generateApiKey, hashApiKey, getApiKeyPrefix, maskApiKey };
