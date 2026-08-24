const { AsyncLocalStorage } = require('async_hooks');

const SECRET_KEY_PATTERN = /(token|secret|password|authorization|apikey|api_key|credential)/i;
const MAX_STRING_LENGTH = 400;

const als = new AsyncLocalStorage();

const runWithRequestId = (requestId, fn) => als.run(requestId, fn);
const getRequestId = () => als.getStore() || null;

let ridCounter = 0;
const newRequestId = (prefix = 'req') => {
  ridCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${ridCounter.toString(36)}`;
};

const maskString = (value) => {
  let out = String(value);
  out = out.replace(/shpat_[A-Za-z0-9_-]+/g, 'shpat_***');
  out = out.replace(/((?:postgres(?:ql)?|https?):\/\/[^:/@\s]+:)[^@\s/]+@/gi, '$1***@');
  out = out.replace(/(\/rest\/\d+\/)[A-Za-z0-9]+/g, '$1***');
  return out;
};

const mask = (data, depth = 0) => {
  if (depth > 8) return '[...]';
  if (typeof data === 'string') return maskString(data);
  if (Array.isArray(data)) return data.map((item) => mask(item, depth + 1));
  if (data && typeof data === 'object') {
    const out = {};
    for (const key of Object.keys(data)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '***' : mask(data[key], depth + 1);
    }
    return out;
  }
  return data;
};

const summarize = (data, depth = 0) => {
  if (depth > 6) return '[...]';
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    return data.length > MAX_STRING_LENGTH
      ? `${data.slice(0, MAX_STRING_LENGTH)}...(+${data.length - MAX_STRING_LENGTH} chars)`
      : data;
  }
  if (typeof data === 'number' || typeof data === 'boolean') return data;
  if (Buffer.isBuffer(data)) return `<Buffer ${data.length} bytes>`;
  if (Array.isArray(data)) {
    if (
      data.length === 2 &&
      typeof data[0] === 'string' &&
      typeof data[1] === 'string' &&
      data[1].length > MAX_STRING_LENGTH
    ) {
      return [data[0], `<base64:${data[1].length} chars>`];
    }
    if (data.length > 20) {
      return [
        ...data.slice(0, 20).map((item) => summarize(item, depth + 1)),
        `...(+${data.length - 20} items)`
      ];
    }
    return data.map((item) => summarize(item, depth + 1));
  }
  if (typeof data === 'object') {
    const out = {};
    for (const key of Object.keys(data)) {
      out[key] = summarize(data[key], depth + 1);
    }
    return out;
  }
  return data;
};

const stringify = (data, maxLength = 2500) => {
  try {
    let json = JSON.stringify(summarize(mask(data)));
    if (json === undefined) json = String(data);
    if (json.length > maxLength) json = `${json.slice(0, maxLength)}...(+${json.length - maxLength} chars)`;
    return json;
  } catch (err) {
    return '[unserializable]';
  }
};

const enabled = () => (process.env.DEBUG === undefined ? true : process.env.DEBUG !== 'false');

const debug = (scope, message, data) => {
  if (!enabled()) return;
  const ts = new Date().toISOString();
  const rid = getRequestId();
  const ridPrefix = rid ? `[${rid}] ` : '';
  const suffix = data === undefined ? '' : ` | ${stringify(data)}`;
  console.log(`[DEBUG ${ts}] ${ridPrefix}[${scope}] ${maskString(message)}${suffix}`);
};

module.exports = { debug, stringify, summarize, mask, enabled, runWithRequestId, newRequestId };
