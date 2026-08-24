require('dotenv').config();
const { createAllFields } = require('../src/utils/bitrixFields');

// Usage: node scripts/createCustomFields.js [--bitrix-url https://.../rest/1/xxx/]
const bitrixUrlArgIndex = process.argv.indexOf('--bitrix-url');
const bitrixUrlArg = bitrixUrlArgIndex > -1 ? process.argv[bitrixUrlArgIndex + 1] : '';
const WEBHOOK_URL = bitrixUrlArg || process.env.BITRIX_WEBHOOK_URL;

if (!WEBHOOK_URL || WEBHOOK_URL.includes('xxxxxxxxxxxxxxxx')) {
  console.error('BITRIX_WEBHOOK_URL is not configured. Pass --bitrix-url or set .env.');
  process.exit(1);
}

const run = async () => {
  const summary = await createAllFields(WEBHOOK_URL);
  for (const [entity, s] of Object.entries(summary)) {
    console.log(`\n===== ${s.entity} fields (created: ${s.created}, existing: ${s.existing}, failed: ${s.failed}) =====`);
    s.details.forEach((d) => console.log(d));
  }
  console.log('\nDone. Re-run safely anytime — existing fields are skipped.');
};

run().catch((err) => {
  console.error('Script failed:', err.message);
  process.exit(1);
});
