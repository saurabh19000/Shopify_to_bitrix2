// Simulates the EXACT broken server env: quoted URL + Prisma schema param + host "base"
process.env.DATABASE_URL = '"postgresql://shopify:shopify7897@base:5432/shopify"?schema=public';
const pool = require('../src/config/db.config.js');
setTimeout(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (e) { /* probe already reported */ }
  pool.end();
}, 3000);
