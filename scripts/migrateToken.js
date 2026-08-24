require('dotenv').config();
const pool = require('../src/config/db.config');

const shop = process.env.SHOPIFY_STORE_URL;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

if (!shop) {
  console.error('SHOPIFY_STORE_URL is not set in .env');
  process.exit(1);
}
if (!accessToken) {
  console.error('SHOPIFY_ACCESS_TOKEN is not set in .env');
  process.exit(1);
}

pool.query(
  `INSERT INTO shop_tokens (shop, access_token) VALUES ($1, $2)
   ON CONFLICT (shop) DO UPDATE SET access_token = $2`,
  [shop, accessToken]
).then(() => {
  console.log(`Token stored for ${shop}`);
  process.exit();
}).catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
