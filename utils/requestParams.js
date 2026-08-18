function parseIntegerParam(value, { name, min, max, defaultValue }) {
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`${name}不能为空`);
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${name}必须为${min}-${max}之间的整数`);
  }

  const normalized = typeof value === 'string' ? value.trim() : value;
  if (typeof normalized === 'string' && !/^\d+$/.test(normalized)) {
    throw new Error(`${name}必须为${min}-${max}之间的整数`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name}必须为${min}-${max}之间的整数`);
  }
  return parsed;
}

module.exports = { parseIntegerParam };
