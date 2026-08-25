const crypto = require('crypto');

/**
 * Loop prevention and idempotency tracker for Two-Way Synchronization.
 * Tracks recent sync timestamps, signatures, and directions to prevent
 * infinite echo loops between Shopify and Bitrix.
 */

// Memory caches with TTL
const recentSyncs = new Map(); // key: `direction:entity:id` -> { timestamp, hash }
const recentEvents = new Map(); // key: `event:entity:id:hash` -> { timestamp }

const TTL_MS = 45 * 1000; // 45 seconds loop suppression window
const EVENT_DEDUP_MS = 300; // 300ms network retry dedup

const cleanExpired = () => {
  const now = Date.now();
  for (const [key, val] of recentSyncs.entries()) {
    if (now - val.timestamp > TTL_MS) recentSyncs.delete(key);
  }
  for (const [key, val] of recentEvents.entries()) {
    if (now - val.timestamp > EVENT_DEDUP_MS) recentEvents.delete(key);
  }
};

// Periodic cleanup every 2 minutes
setInterval(cleanExpired, 2 * 60 * 1000).unref();

const hashPayload = (data) => {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data || {});
    return crypto.createHash('md5').update(str).digest('hex');
  } catch (e) {
    return '';
  }
};

/**
 * Record that a sync operation was performed by our backend.
 * @param {string} direction 'SHOPIFY_TO_BITRIX' or 'BITRIX_TO_SHOPIFY'
 * @param {string} entity 'contact', 'product', 'deal', 'order'
 * @param {string|number} id Primary entity ID
 * @param {object} payload Optional payload for fingerprinting
 */
const recordSync = (direction, entity, id, payload = null) => {
  if (!id) return;
  cleanExpired();
  const key = `${direction}:${entity}:${String(id)}`;
  recentSyncs.set(key, {
    timestamp: Date.now(),
    hash: payload ? hashPayload(payload) : ''
  });
};

/**
 * Check if an incoming event is an echo/loop resulting from a sync we just performed
 * in the opposite direction.
 * @param {string} currentDirection 'BITRIX_TO_SHOPIFY' or 'SHOPIFY_TO_BITRIX'
 * @param {string} entity 'contact', 'product', 'deal', 'order'
 * @param {string|number} id Entity ID
 * @param {object} incomingPayload
 * @returns {boolean} True if this event should be ignored as an echo loop
 */
const isEchoLoop = (currentDirection, entity, id, incomingPayload = null) => {
  if (!id) return false;
  cleanExpired();
  const oppositeDirection = currentDirection === 'BITRIX_TO_SHOPIFY' ? 'SHOPIFY_TO_BITRIX' : 'BITRIX_TO_SHOPIFY';
  const oppositeKey = `${oppositeDirection}:${entity}:${String(id)}`;
  
  const record = recentSyncs.get(oppositeKey);
  if (!record) return false;

  const age = Date.now() - record.timestamp;
  if (age < TTL_MS) {
    // If the record exists in opposite direction within TTL window, it's an echo loop.
    // Consume the record so future independent user edits are not blocked.
    recentSyncs.delete(oppositeKey);
    return true;
  }
  return false;
};

/**
 * Check if the exact same webhook payload was received in the last few seconds (identical retry).
 * @param {string} eventName
 * @param {string} entity
 * @param {string|number} id
 * @param {object} payload
 * @returns {boolean}
 */
const isDuplicateEvent = (eventName, entity, id, payload = null) => {
  if (!id) return false;
  cleanExpired();
  const hash = payload ? hashPayload(payload) : '';
  const key = `${eventName || 'event'}:${entity}:${String(id)}:${hash}`;
  const record = recentEvents.get(key);
  const now = Date.now();
  if (record && now - record.timestamp < EVENT_DEDUP_MS) {
    return true;
  }
  recentEvents.set(key, { timestamp: now });
  return false;
};

module.exports = {
  recordSync,
  isEchoLoop,
  isDuplicateEvent,
  hashPayload
};
