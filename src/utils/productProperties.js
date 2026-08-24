const axios = require('axios');
const { debug } = require('../utils/debugLogger');

/**
 * Bitrix24 product custom properties (PROPERTY_XX) are created on the portal
 * via crm.product.property.* and get portal-specific numeric IDs. The sync
 * code must therefore resolve the real "PROPERTY_<id>" field name per portal
 * instead of assuming fixed IDs.
 *
 * Resolves once per process and caches the mapping (idempotent — missing
 * properties are created on first use).
 */

const PROPERTY_DEFS = [
  { key: 'shopifyProductId', name: 'Shopify Product ID' },
  { key: 'collections',      name: 'Collections' },
  { key: 'category',         name: 'Category' },
  { key: 'costPerItem',      name: 'Cost Per Item' },
  { key: 'taxable',          name: 'Taxable' },
  { key: 'seoUrl',           name: 'SEO URL' },
  { key: 'vendor',           name: 'Vendor' },
  { key: 'productType',      name: 'Product Type' },
  { key: 'tags',             name: 'Product Tags' },
  { key: 'handle',           name: 'Handle' },
  { key: 'barcode',          name: 'Barcode' },
  { key: 'compareAtPrice',   name: 'Compare At Price' },
  { key: 'stockQuantity',    name: 'Stock Quantity' },
  { key: 'weight',           name: 'Weight' },
  { key: 'shopifyCreatedAt', name: 'Shopify Created Date' },
  { key: 'unitPrice',        name: 'Unit Price' },
  { key: 'inventoryTracked', name: 'Inventory Tracked' },
  { key: 'requiresShipping', name: 'Requires Shipping' },
  { key: 'seoTitle',         name: 'SEO Title' },
  { key: 'categoryMetafields', name: 'Category Metafields' },
  { key: 'variantInfo',      name: 'Variant Info' },
  { key: 'boxSize',          name: 'Box Size' },
  { key: 'productStatus',    name: 'Product Status' }
];

let cache = null;

const listAllProperties = async (webhookUrl) => {
  const props = [];
  let start = 0;
  for (;;) {
    debug('props', `listAllProperties: fetching crm.product.property.list (start=${start})`);
    const res = await axios.post(`${webhookUrl}crm.product.property.list`, { start });
    const batch = res.data?.result || [];
    props.push(...batch);
    debug('props', `listAllProperties: page start=${start} returned ${batch.length} property(ies), total=${props.length}`);
    if (batch.length < 50) break;
    start += 50;
    if (res.data?.next) start = res.data.next;
    if (props.length > 2000) break;
  }
  return props;
};

const ensureProductPropertyMap = async (webhookUrl) => {
  if (cache) {
    debug('props', `ensureProductPropertyMap: CACHE HIT — returning cached map with ${Object.keys(cache).length} entries`);
    return cache;
  }
  if (!webhookUrl || webhookUrl.includes('xxxxxxxxxxxxxx')) {
    debug('props', 'ensureProductPropertyMap: webhook URL missing/placeholder — returning EMPTY map (property fields will be skipped)');
    cache = {};
    return cache;
  }

  debug('props', `ensureProductPropertyMap: CACHE MISS — resolving ${PROPERTY_DEFS.length} property definition(s) against portal`);
  const map = {};
  const existing = await listAllProperties(webhookUrl);
  debug('props', `ensureProductPropertyMap: portal reports ${existing.length} existing product property(ies)`);
  const byName = new Map();
  for (const p of existing) byName.set((p.NAME || '').trim().toLowerCase(), p.ID);

  for (const def of PROPERTY_DEFS) {
    const key = def.name.trim().toLowerCase();
    let id = byName.get(key);
    if (!id) {
      try {
        debug('props', `ensureProductPropertyMap: "${def.name}" NOT on portal — creating...`);
        const created = await axios.post(`${webhookUrl}crm.product.property.add`, {
          fields: { NAME: def.name, TYPE: 'S' }
        });
        id = created.data?.result;
        if (id) console.log(`[ProductProps] Created "${def.name}" -> id ${id}`);
        else debug('props', `ensureProductPropertyMap: creation of "${def.name}" returned no id`, { response: created.data });
      } catch (err) {
        console.error(`[ProductProps] Failed to create "${def.name}":`, err.response?.data?.error_description || err.message);
        debug('props', `ensureProductPropertyMap: creation FAILED for "${def.name}"`, { error: err.response?.data || err.message });
      }
    } else {
      debug('props', `ensureProductPropertyMap: "${def.name}" FOUND on portal -> PROPERTY_${id}`);
    }
    if (id) map[def.key] = `PROPERTY_${id}`;
  }

  debug('props', `ensureProductPropertyMap: DONE — resolved ${Object.keys(map).length}/${PROPERTY_DEFS.length} properties`, { map });
  cache = map;
  return map;
};

const resetProductPropertyCache = () => {
  debug('props', 'resetProductPropertyCache: clearing cache');
  cache = null;
};

module.exports = { ensureProductPropertyMap, resetProductPropertyCache, PROPERTY_DEFS };
