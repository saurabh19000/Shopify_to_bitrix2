require('dotenv').config();
const pool = require('../src/config/db.config');

/**
 * Database setup (idempotent — safe to re-run).
 *
 * Creates the two tables the app needs:
 *   1. shop_tokens — OAuth access token for the store
 *   2. id_map      — Shopify ID -> Bitrix24 ID mappings + stock sync state
 *
 * Run once against the production database:
 *   node scripts/migrateDb.js
 */

const run = async () => {
  console.log('Setting up database schema...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_tokens (
      shop VARCHAR(255) PRIMARY KEY,
      access_token TEXT NOT NULL
    )
  `);
  console.log('shop_tokens table OK');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS id_map (
      shop VARCHAR(255) NOT NULL DEFAULT '',
      type VARCHAR(50) NOT NULL,
      shopify_id VARCHAR(255) NOT NULL,
      bitrix_id VARCHAR(255) NOT NULL,
      PRIMARY KEY (shop, type, shopify_id)
    )
  `);
  console.log('id_map table OK');

  console.log('Database setup complete.');
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Database setup failed:', err.message);
    process.exit(1);
  });
