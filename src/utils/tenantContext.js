/**
 * Single-tenant config resolver.
 *
 * All configuration comes from the .env file. Kept as a single accessor so
 * services read one consistent source instead of scattering process.env calls.
 */
const getTenantConfig = () => ({
  shop: process.env.SHOPIFY_STORE_URL || '',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
  apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
  bitrixWebhookUrl: process.env.BITRIX_WEBHOOK_URL || '',
  currencyId: process.env.BITRIX_CURRENCY || 'INR',
  warehouseId: parseInt(process.env.BITRIX_WAREHOUSE_ID, 10) || 2,
  responsibleId: parseInt(process.env.BITRIX_RESPONSIBLE_ID, 10) || 1,
  storeDomain: process.env.SHOPIFY_STORE_URL || process.env.BITRIX_STORE_DOMAIN || '',
  shopifyLocationId: process.env.SHOPIFY_LOCATION_ID || ''
});

module.exports = { getTenantConfig };
