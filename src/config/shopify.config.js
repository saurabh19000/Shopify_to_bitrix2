const { getToken } = require('../utils/tokenStore');
const { debug } = require('../utils/debugLogger');

const rawStoreUrl = process.env.SHOPIFY_STORE_URL || '';
const cleanStoreUrl = rawStoreUrl
  .replace(/^https?:\/\//i, '')
  .replace(/\/$/, '');

debug('config', 'Shopify config resolved', {
  store: cleanStoreUrl || '(not set)',
  apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
  appUrl: process.env.SHOPIFY_APP_URL || '(not set)',
  envTokenPresent: Boolean(process.env.SHOPIFY_ACCESS_TOKEN)
});

module.exports = {
  shopifyStoreUrl: cleanStoreUrl,
  getShopifyAccessToken: async () => (await getToken(cleanStoreUrl)) || process.env.SHOPIFY_ACCESS_TOKEN || '',
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
  baseWebhookUrl: process.env.SHOPIFY_APP_URL || ''
};
