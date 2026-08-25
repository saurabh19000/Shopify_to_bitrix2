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

let syncCounter = 0;
const generateSyncId = (prefix = 'BTX-SHP') => {
  syncCounter += 1;
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(syncCounter).padStart(5, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${yyyymmdd}-${seq}-${rand}`;
};

const debug = (scope, message, data) => {
  if (!enabled()) return;
  const ts = new Date().toISOString();
  const rid = getRequestId();
  const ridPrefix = rid ? `[${rid}] ` : '';
  const suffix = data === undefined ? '' : ` | ${stringify(data)}`;
  console.log(`[DEBUG ${ts}] ${ridPrefix}[${scope}] ${maskString(message)}${suffix}`);
};

/**
 * Standard structured logger for synchronization events.
 * Output format:
 * [TIMESTAMP] [LEVEL] [syncId=...] [direction=...] [entity=...] [entityId=...] [stage=...] MESSAGE
 */
const logSyncStage = ({
  level = 'INFO',
  syncId = '',
  direction = 'BITRIX_TO_SHOPIFY',
  entity = 'general',
  entityId = '',
  stage = 'GENERAL',
  message = '',
  data = undefined,
  duration = undefined
}) => {
  const ts = new Date().toISOString();
  const sId = syncId || getRequestId() || 'N/A';
  const durationStr = duration !== undefined ? ` (duration=${duration}ms)` : '';
  const dataStr = data !== undefined ? ` | ${stringify(data)}` : '';
  console.log(`[${ts}] [${level}] [syncId=${sId}] [direction=${direction}] [entity=${entity}] [entityId=${entityId || 'N/A'}] [stage=${stage}] ${maskString(message)}${durationStr}${dataStr}`);
};

const logBitrixEvent = ({ syncId, event, entityType, entityId, payload }) => {
  logSyncStage({
    level: 'INFO',
    syncId,
    direction: 'BITRIX_TO_SHOPIFY',
    entity: entityType,
    entityId,
    stage: 'BITRIX_EVENT',
    message: `Bitrix event received: event=${event} entity_type=${entityType} entity_id=${entityId}`,
    data: payload ? summarize(mask(payload)) : undefined
  });
};

const logBitrixPayload = ({ syncId, entity, entityId, payload }) => {
  logSyncStage({
    level: 'DEBUG',
    syncId,
    direction: 'BITRIX_TO_SHOPIFY',
    entity,
    entityId,
    stage: 'BITRIX_PAYLOAD',
    message: `Bitrix payload received for ${entity} ${entityId}`,
    data: mask(payload)
  });
};

const logValidation = ({ syncId, entity, entityId, status, requiredFields, missingFields, details }) => {
  const isOk = status === 'SUCCESS' || status === true;
  logSyncStage({
    level: isOk ? 'INFO' : 'WARN',
    syncId,
    direction: 'BITRIX_TO_SHOPIFY',
    entity,
    entityId,
    stage: 'VALIDATION',
    message: isOk
      ? `Validation SUCCESS for ${entity} ${entityId} (required: ${requiredFields || 'N/A'})`
      : `Validation FAILED for ${entity} ${entityId} (missing: ${missingFields || 'N/A'})`,
    data: details
  });
};

const logMapping = ({ syncId, source = 'BITRIX', target = 'SHOPIFY', entity, status = 'SUCCESS', bitrixId, shopifyPayload }) => {
  logSyncStage({
    level: 'INFO',
    syncId,
    direction: `${source}_TO_${target}`,
    entity,
    entityId: bitrixId,
    stage: 'MAPPING',
    message: `Field mapping ${status}: ${source} -> ${target} (${entity})`,
    data: shopifyPayload ? mask(shopifyPayload) : undefined
  });
};

const logShopifyRequest = ({ syncId, entity, entityId, operation = 'CREATE', endpoint, method = 'POST', payload }) => {
  logSyncStage({
    level: 'INFO',
    syncId,
    direction: 'BITRIX_TO_SHOPIFY',
    entity,
    entityId,
    stage: 'SHOPIFY_API_REQUEST',
    message: `Calling Shopify API: operation=${operation} method=${method} endpoint=${endpoint}`,
    data: payload ? mask(payload) : undefined
  });
};

const logShopifyResponse = ({ syncId, entity, entityId, statusCode, status = 'SUCCESS', response, duration, error }) => {
  const isOk = status === 'SUCCESS' || (statusCode >= 200 && statusCode < 300);
  logSyncStage({
    level: isOk ? 'INFO' : 'ERROR',
    syncId,
    direction: 'BITRIX_TO_SHOPIFY',
    entity,
    entityId,
    stage: 'SHOPIFY_API_RESPONSE',
    message: `Shopify API responded: statusCode=${statusCode} status=${status}${error ? ` error=${error}` : ''}`,
    duration,
    data: response ? mask(response) : undefined
  });
};

const logMappingSave = ({ syncId, entity, bitrixId, shopifyId, status = 'SUCCESS' }) => {
  logSyncStage({
    level: 'INFO',
    syncId,
    direction: 'BITRIX_TO_SHOPIFY',
    entity,
    entityId: bitrixId,
    stage: 'MAPPING_SAVE',
    message: `Bi-directional ID mapping saved: Bitrix ${bitrixId} <-> Shopify ${shopifyId} (status=${status})`,
    data: { bitrixId: String(bitrixId), shopifyId: String(shopifyId) }
  });
};

const logSyncComplete = ({ syncId, direction = 'BITRIX_TO_SHOPIFY', entity, bitrixId, shopifyId, status = 'SUCCESS', duration, message }) => {
  logSyncStage({
    level: 'INFO',
    syncId,
    direction,
    entity,
    entityId: bitrixId,
    stage: 'SYNC_COMPLETE',
    message: message || `Synchronization completed successfully: Bitrix ${bitrixId} -> Shopify ${shopifyId || 'N/A'}`,
    duration,
    data: { bitrixId: String(bitrixId), shopifyId: String(shopifyId || '') }
  });
};

const logSyncFailed = ({ syncId, direction = 'BITRIX_TO_SHOPIFY', entity, bitrixId, error, duration, stage = 'EXECUTION', responseBody, httpStatus }) => {
  logSyncStage({
    level: 'ERROR',
    syncId,
    direction,
    entity,
    entityId: bitrixId,
    stage: 'SYNC_FAILED',
    message: `Synchronization FAILED at stage ${stage}: ${error || 'Unknown error'} (httpStatus=${httpStatus || 'N/A'})`,
    duration,
    data: { error, httpStatus, responseBody: responseBody ? summarize(mask(responseBody)) : undefined }
  });
};

const logIdempotency = ({ syncId, entity, bitrixId, shopifyId, reason, action = 'SKIPPED' }) => {
  logSyncStage({
    level: 'INFO',
    syncId,
    direction: 'BITRIX_TO_SHOPIFY',
    entity,
    entityId: bitrixId,
    stage: 'IDEMPOTENCY',
    message: `Idempotency check: ${action} (reason=${reason}) for Bitrix ${bitrixId} -> Shopify ${shopifyId || 'N/A'}`
  });
};

const logLoopPrevention = ({ syncId, entity, bitrixId, shopifyId, reason }) => {
  logSyncStage({
    level: 'INFO',
    syncId,
    direction: 'BITRIX_TO_SHOPIFY',
    entity,
    entityId: bitrixId,
    stage: 'LOOP_PREVENTION',
    message: `Two-way sync loop prevented: skipped Bitrix ${bitrixId} (reason=${reason})`
  });
};

module.exports = {
  debug,
  stringify,
  summarize,
  mask,
  enabled,
  runWithRequestId,
  newRequestId,
  generateSyncId,
  logSyncStage,
  logBitrixEvent,
  logBitrixPayload,
  logValidation,
  logMapping,
  logShopifyRequest,
  logShopifyResponse,
  logMappingSave,
  logSyncComplete,
  logSyncFailed,
  logIdempotency,
  logLoopPrevention
};
