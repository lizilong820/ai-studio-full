function createRateLimit({ windowMs, max, keyGenerator, message = '请求过于频繁，请稍后再试' }) {
  const buckets = new Map();
  let requestsSinceCleanup = 0;

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = keyGenerator ? keyGenerator(req) : req.ip;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
    } else if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ code: 429, msg: message });
    } else {
      bucket.count += 1;
    }

    requestsSinceCleanup += 1;
    if (requestsSinceCleanup >= 1000) {
      requestsSinceCleanup = 0;
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }

    next();
  };
}

const generalApiLimit = createRateLimit({ windowMs: 60_000, max: 300 });
const authLimit = createRateLimit({ windowMs: 15 * 60_000, max: 20 });

module.exports = { createRateLimit, generalApiLimit, authLimit };
