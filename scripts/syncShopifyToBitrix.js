require('dotenv').config();
const migrationService = require('../src/services/migration.service');

const args = process.argv.slice(2);
const mode = args[0] || '--all';

(async () => {
  console.log('================================================================');
  console.log('🚀 BULK SYNC: SHOPIFY -> BITRIX24 CRM');
  console.log('================================================================\n');
  console.log(`Target Shopify Store : ${process.env.SHOPIFY_STORE_URL}`);
  console.log(`Bitrix24 Portal      : ${process.env.BITRIX_WEBHOOK_URL ? process.env.BITRIX_WEBHOOK_URL.split('/rest/')[0] : 'N/A'}`);
  console.log(`Execution Mode       : ${mode}\n`);

  const startTime = Date.now();

  try {
    if (mode === '--customers') {
      console.log('📦 Starting Customers Bulk Sync...');
      const res = await migrationService.migrateCustomers();
      console.log('\n📊 Customer Sync Result:', res);
    } else if (mode === '--products') {
      console.log('📦 Starting Products & Inventory Bulk Sync...');
      const res = await migrationService.migrateProducts();
      console.log('\n📊 Product Sync Result:', res);
    } else if (mode === '--orders') {
      console.log('📦 Starting Orders Bulk Sync...');
      const res = await migrationService.migrateOrders();
      console.log('\n📊 Order Sync Result:', res);
    } else {
      console.log('📦 Starting Full Bulk Sync (Customers + Products + Orders)...');
      const res = await migrationService.migrateAll();
      console.log('\n📊 Full Sync Summary:');
      console.log('----------------------------------------------------------------');
      console.log('  Customers Processed :', res.customers?.total || 0, `(Imported: ${res.customers?.imported || 0}, Failed: ${res.customers?.failed || 0})`);
      console.log('  Products Processed  :', res.products?.total || 0, `(Imported: ${res.products?.imported || 0}, Stock Synced: ${res.products?.stockSynced || 0})`);
      console.log('  Orders Processed    :', res.orders?.total || 0, `(Imported: ${res.orders?.imported || 0}, Failed: ${res.orders?.failed || 0})`);
      console.log('----------------------------------------------------------------');
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Bulk Sync Completed in ${durationSec}s!`);
  } catch (err) {
    console.error('\n❌ Bulk Sync Failed:', err.message);
    process.exit(1);
  }
})();
