const { Pool } = require('pg');
const { debug } = require('../utils/debugLogger');

/**
 * PostgreSQL pool with defensive URL parsing + SSL detection.
 *
 * Hardened against the failure modes seen in production:
 *   - Quoted values leaking from docker --env-file / older compose
 *     (DATABASE_URL="postgresql://..."  -> quotes become part of the value,
 *      producing database names like `shopify"`)
 *   - Prisma-style URLs (?schema=public) which pg cannot use
 *   - SSL wrongly enabled for internal container hosts because sslmode
 *     was lost during parsing (causes silent connection failures)
 *   - Wrong hostnames (e.g. a compose service renamed) failing only at
 *     webhook time — we now probe connectivity once at startup.
 */

const rawUrl = process.env.DATABASE_URL || '';
// docker --env-file keeps surrounding quotes; dotenv trims but does not strip
// them. Quotes are never legitimate inside a postgres connection string, so
// remove every occurrence.
const connectionString = rawUrl.replace(/["']/g, '').trim();

// Prisma template leftover: ?schema=public is meaningless for node-postgres.
const cleanedUrl = connectionString.replace(/([?&])schema=[^&]*&?/, '$1').replace(/\?$/, '');

const parseParts = (url) => {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port, database: u.pathname.replace(/^\//, '') };
  } catch (e) {
    return { host: '', port: '', database: '' };
  }
};

const sslmodeOf = (url) => {
  const m = /[?&]sslmode=([^&]+)/.exec(url);
  return m ? m[1].toLowerCase() : '';
};

// SSL policy:
//   sslmode=require|verify-ca|verify-full -> SSL ON
//   sslmode=disable|prefer                -> OFF
//   no sslmode + localhost/private host   -> OFF (internal containers have no TLS)
//   no sslmode + public host              -> ON (Render/Neon/etc.)
const PRIVATE_HOST = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|postgres|db|database)$/i;

const sslFor = (url) => {
  const mode = sslmodeOf(url);
  if (mode === 'require' || mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: false };
  if (mode === 'disable' || mode === 'prefer') return undefined;
  const { host } = parseParts(url);
  if (!host) return undefined;
  if (PRIVATE_HOST.test(host)) return undefined;
  return { rejectUnauthorized: false };
};

const resolvedSsl = sslFor(cleanedUrl);
const parts = parseParts(cleanedUrl);

debug('db', 'Postgres pool initializing', {
  host: parts.host || '(empty)',
  port: parts.port || '5432',
  database: parts.database || 'shopify_bitrix',
  ssl: resolvedSsl ? 'ENABLED' : 'disabled',
  usingEnvUrl: Boolean(cleanedUrl),
  quotesStripped: /["']/.test(rawUrl),
  prismaSchemaParamStripped: /[?&]schema=/.test(connectionString)
});

if (!cleanedUrl) {
  console.warn('[db] DATABASE_URL is not set — falling back to postgres://localhost:5432/shopify_bitrix');
}

if (parts.host === 'base') {
  console.error('[db] CRITICAL: DATABASE_URL points at host "base". That service does not exist on this network.');
  console.error('[db] If your Postgres container/service is named differently (e.g. "postgres"), fix DATABASE_URL accordingly.');
}

const pool = new Pool({
  connectionString: cleanedUrl || 'postgres://localhost:5432/shopify_bitrix',
  ssl: resolvedSsl
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

// Boot-time connectivity probe: surface DNS/auth/SSL problems immediately with
// an actionable message instead of failing inside webhook handlers.
const probe = async () => {
  try {
    await pool.query('SELECT 1');
    debug('db', 'Connectivity probe OK');
  } catch (err) {
    console.error('[db] STARTUP PROBE FAILED:', err.message);
    if (/EAI_AGAIN|ENOTFOUND|getaddrinfo/i.test(err.message)) {
      console.error('[db] DNS resolution failed for the database host. Check that DATABASE_URL host matches the actual Postgres container/service name on this network.');
    } else if (/password authentication failed/i.test(err.message)) {
      console.error('[db] Auth failed — check user/password in DATABASE_URL.');
    } else if (/SSL|ssl/i.test(err.message)) {
      console.error('[db] SSL problem — add ?sslmode=disable to DATABASE_URL for internal containers, or enable TLS on the server.');
    }
  }
};
setTimeout(probe, 100);

module.exports = pool;
