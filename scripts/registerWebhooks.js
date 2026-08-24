require('dotenv').config();
const { getToken } = require('../src/utils/tokenStore');
const { registerWebhooks } = require('../src/services/webhookRegister.service');
const { debug } = require('../src/utils/debugLogger');

const shop = process.env.SHOPIFY_STORE_URL || '7zidsw-qx.myshopify.com';

const run = async () => {
  debug('webhook-register', `registerWebhooks script: starting for ${shop}`);
  const token = (await getToken(shop)) || process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) {
    console.error(`No token found for ${shop}. Set SHOPIFY_ACCESS_TOKEN in .env or run the OAuth install flow first.`);
    process.exit(1);
  }
  debug('webhook-register', `registerWebhooks script: token resolved (${await getToken(shop) ? 'from DB' : 'from env'}), appUrl=${process.env.SHOPIFY_APP_URL}`);
  const results = await registerWebhooks({
    shop,
    accessToken: token,
    appUrl: process.env.SHOPIFY_APP_URL,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10'
  });
  for (const r of results) {
    console.log(`${r.topic}: ${r.status}${r.id ? ` (id ${r.id})` : r.error ? ` ${JSON.stringify(r.error)}` : ''}`);
  }
  debug('webhook-register', `registerWebhooks script: finished with ${results.length} result(s)`);
};

run().catch((err) => {
  console.error('Webhook registration failed:', err.message);
  process.exit(1);
});
