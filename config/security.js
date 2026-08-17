const jwtAlgorithm = 'HS256';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

const jwtSecret = process.env.JWT_SECRET
  || (process.env.NODE_ENV === 'test' ? process.env.JWT_TEST_SECRET : undefined);

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required');
}

if (Buffer.byteLength(jwtSecret, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be at least 32 bytes');
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

module.exports = { jwtSecret, jwtAlgorithm, host, port };
