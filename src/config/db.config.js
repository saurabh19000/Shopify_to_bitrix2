const { Pool } = require('pg');
const { debug } = require('../utils/debugLogger');

/**
 * PostgreSQL pool with automatic SSL detection.
 *
 * Supports both local and cloud/external databases via DATABASE_URL:
 *   - Explicit ?sslmode=require / verify-ca / verify-full  -> SSL enabled
 *   - Explicit ?sslmode=disable                             -> no SSL
 *   - No sslmode but a local host (localhost / 127.0.0.1)   -> no SSL
 *   - No sslmode but a remote host (e.g. Render, Neon)      -> SSL enabled
 *
 * When DATABASE_URL is omitted it falls back to a local Postgres on
 * localhost:5432 (create the DB first, e.g. "shopify_bitrix").
 */

const connectionString = process.env.DATABASE_URL || '';

const sslFor = (url) => {
  const modeMatch = /[?&]sslmode=([^&]+)/.exec(url);
  if (modeMatch) {
    const mode = modeMatch[1].toLowerCase();
    if (mode === 'disable') return undefined;
    return { rejectUnauthorized: false };
  }
  const hostMatch = /@([^:/\s?]+)/.exec(url);
  const host = hostMatch ? hostMatch[1].toLowerCase() : '';
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return undefined;
  }
  return { rejectUnauthorized: false };
};

const resolvedSsl = sslFor(connectionString);

debug('db', 'Postgres pool initializing', {
  host: (/@([^:/\s?]+)/.exec(connectionString) || [])[1] || 'localhost',
  database: (/\/([^/?]+)(\?.*)?$/.exec(connectionString) || [])[1] || 'shopify_bitrix',
  ssl: resolvedSsl ? 'ENABLED' : 'disabled',
  usingEnvUrl: Boolean(connectionString)
});

const pool = new Pool({
  connectionString: connectionString || 'postgres://localhost:5432/shopify_bitrix',
  ssl: resolvedSsl
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

module.exports = pool;
