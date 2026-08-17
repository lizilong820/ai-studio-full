const ORCHESTRATION_FIELDS = new Set([
  'model_id',
  'prompt',
  'input',
  'input_text',
  'deadline_seconds',
  'result_style',
  'result_metadata'
]);

function getAdapterOptions(payload = {}) {
  if (payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)) {
    return { ...payload.options };
  }

  const options = { ...payload };
  for (const field of ORCHESTRATION_FIELDS) delete options[field];
  delete options.options;
  return options;
}

function normalizeAdapterResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const { raw, ...canonical } = result;
  return canonical;
}

function formatGenerationResult(resultStyle, canonical, aliases = {}, metadata = {}) {
  const normalized = normalizeAdapterResult(canonical);
  const resultObject = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : {};
  const enriched = { ...resultObject, ...metadata };

  if (!resultStyle || resultStyle === 'canonical') return enriched;
  if (resultStyle === 'legacy') return { ...enriched, ...aliases };
  if (resultStyle === 'url') {
    return resultObject.gif_url
      || resultObject.video_url
      || resultObject.audio_url
      || resultObject.images;
  }
  if (typeof resultStyle === 'object' && !Array.isArray(resultStyle)) {
    const projected = { ...metadata };
    for (const [targetKey, sourceKey] of Object.entries(resultStyle)) {
      if (typeof sourceKey === 'string' && Object.prototype.hasOwnProperty.call(enriched, sourceKey)) {
        projected[targetKey] = enriched[sourceKey];
      }
    }
    return projected;
  }
  return enriched;
}

module.exports = { getAdapterOptions, normalizeAdapterResult, formatGenerationResult };
