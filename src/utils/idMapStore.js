const pool = require('../config/db.config');
const { debug } = require('./debugLogger');

// Resolve the shop for a mapping: explicit arg > .env store > legacy ('')
const shopOf = (shop) => shop || process.env.SHOPIFY_STORE_URL || '';

const LEGACY = 'legacy';

async function setMapping(type, shopifyId, bitrixId, shop) {
  const s = shopOf(shop);
  debug('idmap', `setMapping: type=${type} shopifyId=${shopifyId} -> bitrixId=${bitrixId}`, { shop: s });
  try {
    await pool.query(
      `INSERT INTO id_map (shop, type, shopify_id, bitrix_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop, type, shopify_id) DO UPDATE SET bitrix_id = $4`,
      [s, type, String(shopifyId), String(bitrixId)]
    );
    debug('idmap', `setMapping: OK type=${type} ${shopifyId} -> ${bitrixId}`);
  } catch (err) {
    // Pre-migration schema (no shop column): fall back to legacy key.
    debug('idmap', `setMapping: modern schema failed (${err.message}) — using LEGACY schema for type=${type} ${shopifyId}`);
    await pool.query(
      `INSERT INTO id_map (type, shopify_id, bitrix_id) VALUES ($1, $2, $3)
       ON CONFLICT (type, shopify_id) DO UPDATE SET bitrix_id = $3`,
      [type, String(shopifyId), String(bitrixId)]
    );
    debug('idmap', `setMapping: LEGACY write OK type=${type} ${shopifyId} -> ${bitrixId}`);
  }
}

async function getMapping(type, shopifyId, shop) {
  const s = shopOf(shop);
  try {
    const result = await pool.query(
      'SELECT bitrix_id FROM id_map WHERE shop = $1 AND type = $2 AND shopify_id = $3',
      [s, type, String(shopifyId)]
    );
    if (result.rows.length > 0) {
      debug('idmap', `getMapping: HIT type=${type} ${shopifyId} -> ${result.rows[0].bitrix_id}`);
      return result.rows[0].bitrix_id;
    }
    debug('idmap', `getMapping: MISS type=${type} ${shopifyId} (shop=${s})`);
  } catch (err) {
    debug('idmap', `getMapping: query failed (${err.message}) — returning LEGACY sentinel for type=${type} ${shopifyId}`);
    return LEGACY;
  }
  return null;
}

// Fallback lookup using the old (shop-less) schema.
async function getMappingLegacy(type, shopifyId) {
  const result = await pool.query(
    'SELECT bitrix_id FROM id_map WHERE type = $1 AND shopify_id = $2',
    [type, String(shopifyId)]
  );
  const found = result.rows.length > 0 ? result.rows[0].bitrix_id : null;
  debug('idmap', `getMappingLegacy: type=${type} ${shopifyId} -> ${found || 'null'}`);
  return found;
}

async function getMappingWithFallback(type, shopifyId, shop) {
  const mapped = await getMapping(type, shopifyId, shop);
  if (mapped === LEGACY) {
    debug('idmap', `getMappingWithFallback: legacy fallback for type=${type} ${shopifyId}`);
    return await getMappingLegacy(type, shopifyId);
  }
  return mapped;
}

async function deleteMapping(type, shopifyId, shop) {
  const s = shopOf(shop);
  debug('idmap', `deleteMapping: type=${type} ${shopifyId} (shop=${s})`);
  try {
    await pool.query(
      'DELETE FROM id_map WHERE shop = $1 AND type = $2 AND shopify_id = $3',
      [s, type, String(shopifyId)]
    );
    debug('idmap', `deleteMapping: OK type=${type} ${shopifyId}`);
  } catch (err) {
    debug('idmap', `deleteMapping: modern failed (${err.message}) — legacy delete for type=${type} ${shopifyId}`);
    await pool.query('DELETE FROM id_map WHERE type = $1 AND shopify_id = $2', [type, String(shopifyId)]);
    debug('idmap', `deleteMapping: LEGACY delete OK type=${type} ${shopifyId}`);
  }
}

module.exports = {
  setMapping,
  getMapping,
  getMappingLegacy,
  getMappingWithFallback,
  deleteMapping
};
