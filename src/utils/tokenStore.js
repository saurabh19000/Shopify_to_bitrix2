const pool = require('../config/db.config');
const { debug } = require('./debugLogger');

async function saveToken(shop, accessToken) {
  debug('tokenStore', `saveToken: storing access token for shop=${shop}`, { tokenLength: accessToken ? accessToken.length : 0 });
  await pool.query(
    `INSERT INTO shop_tokens (shop, access_token) VALUES ($1, $2)
     ON CONFLICT (shop) DO UPDATE SET access_token = $2`,
    [shop, accessToken]
  );
  debug('tokenStore', `saveToken: token stored OK for shop=${shop}`);
}

async function getToken(shop) {
  debug('tokenStore', `getToken: lookup for shop=${shop}`);
  const result = await pool.query('SELECT access_token FROM shop_tokens WHERE shop = $1', [shop]);
  const found = result.rows.length > 0;
  debug('tokenStore', `getToken: shop=${shop} -> ${found ? 'FOUND' : 'NOT FOUND'}`);
  return found ? result.rows[0].access_token : null;
}

async function deleteToken(shop) {
  debug('tokenStore', `deleteToken: removing token for shop=${shop}`);
  await pool.query('DELETE FROM shop_tokens WHERE shop = $1', [shop]);
  debug('tokenStore', `deleteToken: removed token for shop=${shop}`);
}

module.exports = { saveToken, getToken, deleteToken };
