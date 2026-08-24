require('dotenv').config();
const axios = require('axios');

// Usage: node scripts/wipeBitrixData.js [--bitrix-url https://.../rest/1/xxx/]
const bitrixUrlArgIndex = process.argv.indexOf('--bitrix-url');
const bitrixUrlArg = bitrixUrlArgIndex > -1 ? process.argv[bitrixUrlArgIndex + 1] : '';
const BITRIX_URL = bitrixUrlArg || process.env.BITRIX_WEBHOOK_URL;

if (!BITRIX_URL || BITRIX_URL.includes('xxxxxxxxxxxxxxxx')) {
  console.error('BITRIX_WEBHOOK_URL is not configured. Pass --bitrix-url or set .env.');
  process.exit(1);
}

async function wipeAll(entity, listMethod, deleteMethod) {
  const listUrl = `${BITRIX_URL}${listMethod}.json`;
  const response = await axios.post(listUrl, { select: ['ID'] });
  const items = response.data.result || [];

  console.log(`Found ${items.length} ${entity} to delete...`);

  for (const item of items) {
    try {
      const deleteUrl = `${BITRIX_URL}${deleteMethod}.json`;
      await axios.post(deleteUrl, { id: item.ID });
      console.log(`Deleted ${entity} ${item.ID}`);
    } catch (err) {
      console.error(`Failed to delete ${entity} ${item.ID}:`, err.message);
    }
  }
  console.log(`${entity} wipe complete.\n`);
}

async function main() {
  await wipeAll('deals', 'crm.deal.list', 'crm.deal.delete');
  await wipeAll('contacts', 'crm.contact.list', 'crm.contact.delete');
  await wipeAll('products', 'crm.product.list', 'crm.product.delete');
  console.log('All wiped.');
}

main();
