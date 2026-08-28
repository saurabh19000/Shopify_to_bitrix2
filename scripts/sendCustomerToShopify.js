require('dotenv').config();
const axios = require('axios');
const shopifyService = require('../src/services/shopify.service');
const bitrixService = require('../src/services/bitrix.service');
const { getTenantConfig } = require('../src/utils/tenantContext');
const { getToken } = require('../src/utils/tokenStore');
const { setMapping, getShopifyIdByBitrixId } = require('../src/utils/idMapStore');
const { generateSyncId } = require('../src/utils/debugLogger');

/**
 * Script: Send Customer Data to Shopify with Full 360-degree CRM Fields
 * 
 * Supports:
 *   - Customer Name (first_name, last_name)
 *   - Email (email, verified_email)
 *   - Phone (E.164 phone)
 *   - Total Amount Spent (total_spent)
 *   - Total Orders (total_orders)
 *   - Last Order (last_order)
 *   - Order Amount (order_amount)
 *   - Order Status (order_status / financial_status)
 *   - Products (purchased products list)
 *   - Default Address (address1, city, province, country, zip, phone)
 *   - Marketing Subscription (email_marketing_consent, sms_marketing_consent)
 *   - Tags (tags)
 * 
 * Usage:
 *   1. Create rich customer with all fields:
 *      node scripts/sendCustomerToShopify.js
 * 
 *   2. Create custom customer with CLI args:
 *      node scripts/sendCustomerToShopify.js --firstName "Pooja" --lastName "Sharma" --email "pooja.sharma@example.com" --phone "+919876543210" --totalSpent "24999.00" --totalOrders "4" --lastOrder "#1088" --orderAmount "6500.00" --orderStatus "Paid & Delivered" --products "Diamond Solitaire Ring, Gold Pendant" --city "Jaipur" --marketing "true" --tags "VIP, High-Value, BitrixSync"
 * 
 *   3. Delete a customer:
 *      node scripts/sendCustomerToShopify.js --delete 9650993266928
 */

const cleanDomain = (d) => String(d || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

const resolveShopifyCreds = async () => {
  const cfg = getTenantConfig();
  const shopDomain = cleanDomain(cfg.storeDomain);
  let accessToken = cfg.accessToken;
  if (!accessToken && shopDomain) {
    accessToken = (await getToken(shopDomain)) || '';
  }
  return { shopDomain, accessToken, apiVersion: cfg.apiVersion || '2024-10' };
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextVal = args[i + 1];
      if (nextVal && !nextVal.startsWith('--')) {
        params[key] = nextVal;
        i++;
      } else {
        params[key] = true;
      }
    }
  }
  return params;
};

const run = async () => {
  const syncId = generateSyncId('MANUAL-TEST');
  console.log('================================================================');
  console.log(`🚀 Send Full Customer Profile to Shopify [syncId: ${syncId}]`);
  console.log('================================================================\n');

  const creds = await resolveShopifyCreds();
  if (!creds.shopDomain || !creds.accessToken) {
    console.error('❌ Error: Shopify credentials (SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN) are missing in .env');
    process.exit(1);
  }

  console.log(`📦 Target Shopify Store : ${creds.shopDomain}`);
  console.log(`🔑 API Version          : ${creds.apiVersion}`);
  console.log(`🔐 Access Token Prefix  : ${creds.accessToken.substring(0, 10)}...`);

  const args = parseArgs();

  // Mode: Delete a customer
  if (args.delete) {
    const custId = String(args.delete);
    console.log(`\n🗑️ Deleting Shopify Customer ID ${custId}...`);
    try {
      await axios.delete(`https://${creds.shopDomain}/admin/api/${creds.apiVersion}/customers/${custId}.json`, {
        headers: { 'X-Shopify-Access-Token': creds.accessToken }
      });
      console.log(`✅ Customer ${custId} successfully deleted from Shopify.`);
    } catch (err) {
      console.error(`❌ Failed to delete customer ${custId}:`, err.response?.data || err.message);
    }
    return;
  }

  // Generate unique timestamp for unique email & phone
  const timestamp = Date.now().toString().slice(-4);

  // Field values with rich defaults
  const firstName = args.firstName || `Pooja_${timestamp}`;
  const lastName = args.lastName || 'Sharma';
  const email = args.email || `pooja.crm.${timestamp}@example.com`;
  const phone = args.phone || (`+91987654` + timestamp);
  const totalAmountSpent = args.totalSpent || '24,999.00';
  const amountSpendOrders = args.amountSpendOrders || args.orderAmountSpent || '52,500.00';
  const totalOrders = args.totalOrders || '4';
  const lastOrder = args.lastOrder || '#1088';
  const orderAmount = args.orderAmount || '6,500.00';
  const orderStatus = args.orderStatus || 'Paid & Delivered';
  const products = args.products || 'Diamond Solitaire Ring 18K, Royal Gold Pendant';
  const address1 = args.address || '42 Jewelers Lane, Johari Bazaar';
  const city = args.city || 'Jaipur';
  const province = args.province || 'Rajasthan';
  const country = args.country || 'India';
  const zip = args.zip || '302003';
  const tags = args.tags || 'VIP, High-Value, Gold-Member, BitrixSync';
  const isMarketingSubscribed = args.marketing !== 'false' && args.marketing !== false;

  // Build comprehensive structured note that displays directly in Shopify Customer View
  const customerNote = [
    `=== CRM & Order Summary ===`,
    `• Amount Spend Orders: ₹${amountSpendOrders}`,
    `• Total Amount Spent: ₹${totalAmountSpent}`,
    `• Total Orders (Orders Count): ${totalOrders}`,
    `• Last Order: ${lastOrder}`,
    `• Order Amount: ₹${orderAmount}`,
    `• Order Status: ${orderStatus}`,
    `• Products: ${products}`,
    `• Marketing Status: ${isMarketingSubscribed ? 'Subscribed to Email & SMS' : 'Not Subscribed'}`,
    `• Sync Timestamp: ${new Date().toISOString()}`
  ].join('\n');

  // Customer payload with all requested fields
  const sampleContact = {
    NAME: firstName,
    LAST_NAME: lastName,
    EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }],
    PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }],
    ADDRESS: address1,
    ADDRESS_CITY: city,
    ADDRESS_PROVINCE: province,
    ADDRESS_COUNTRY: country,
    ADDRESS_POSTAL_CODE: zip,
    COMPANY_TITLE: 'Lukson Jewels Club',
    UF_CRM_CUSTOMER_NOTE: customerNote,
    UF_CRM_CUSTOMER_TAGS: tags,
    email_marketing_consent: isMarketingSubscribed ? {
      state: 'subscribed',
      opt_in_level: 'single_opt_in',
      consent_updated_at: new Date().toISOString()
    } : { state: 'not_subscribed' },
    sms_marketing_consent: isMarketingSubscribed ? {
      state: 'subscribed',
      opt_in_level: 'single_opt_in',
      consent_updated_at: new Date().toISOString(),
      consent_collected_from: 'OTHER'
    } : { state: 'not_subscribed' },
    metafields: [
      { namespace: 'bitrix_crm', key: 'amount_spend_orders', value: String(amountSpendOrders), type: 'single_line_text_field' },
      { namespace: 'bitrix_crm', key: 'total_amount_spent', value: String(totalAmountSpent), type: 'single_line_text_field' },
      { namespace: 'bitrix_crm', key: 'total_orders', value: String(totalOrders), type: 'single_line_text_field' },
      { namespace: 'bitrix_crm', key: 'last_order', value: String(lastOrder), type: 'single_line_text_field' },
      { namespace: 'bitrix_crm', key: 'order_amount', value: String(orderAmount), type: 'single_line_text_field' },
      { namespace: 'bitrix_crm', key: 'order_status', value: String(orderStatus), type: 'single_line_text_field' },
      { namespace: 'bitrix_crm', key: 'products', value: String(products), type: 'single_line_text_field' }
    ]
  };

  console.log('📝 Customer Profile to Create:');
  console.log('----------------------------------------------------------------');
  console.log(`  1. Customer Name          : ${firstName} ${lastName}`);
  console.log(`  2. Email                  : ${email}`);
  console.log(`  3. Phone                  : ${phone}`);
  console.log(`  4. Amount Spend Orders    : ₹${amountSpendOrders}`);
  console.log(`  5. Total Amount Spent     : ₹${totalAmountSpent}`);
  console.log(`  6. Total Orders           : ${totalOrders}`);
  console.log(`  7. Last Order             : ${lastOrder}`);
  console.log(`  8. Order Amount           : ₹${orderAmount}`);
  console.log(`  9. Order Status           : ${orderStatus}`);
  console.log(` 10. Products               : ${products}`);
  console.log(` 11. Default Address        : ${address1}, ${city}, ${province}, ${country} - ${zip}`);
  console.log(` 12. Marketing Status       : ${isMarketingSubscribed ? 'Subscribed (Email + SMS)' : 'Not Subscribed'}`);
  console.log(` 13. Tags                   : ${tags}`);
  console.log('----------------------------------------------------------------\n');

  console.log('📤 Sending POST request to Shopify Admin API (/admin/api/.../customers.json)...');
  const result = await shopifyService.createShopifyCustomer(sampleContact, creds.shopDomain, creds.accessToken, syncId);

  if (result) {
    console.log('\n================================================================');
    console.log('🎉 SUCCESS: Full Customer Profile Created in Shopify!');
    console.log('================================================================');
    console.log(`   Shopify Customer ID   : ${result.id}`);
    console.log(`   Full Name             : ${result.first_name} ${result.last_name}`);
    console.log(`   Email                 : ${result.email}`);
    console.log(`   Phone                 : ${result.phone || '(saved in customer notes)'}`);
    console.log(`   Tags                  : ${result.tags}`);
    console.log(`   Email Marketing       : ${result.email_marketing_consent?.state || 'not_subscribed'}`);
    console.log(`   SMS Marketing         : ${result.sms_marketing_consent?.state || 'not_subscribed'}`);
    console.log(`   Default Address       : ${result.default_address?.address1 || address1}, ${result.default_address?.city || city}, ${result.default_address?.province || province} (${result.default_address?.zip || zip})`);
    console.log(`   Created At            : ${result.created_at}`);
    console.log(`   Shopify Admin URL     : https://${creds.shopDomain}/admin/customers/${result.id}`);
    console.log('================================================================\n');
  } else {
    console.error('❌ Error: Customer creation returned empty response.');
  }
};

run().catch((err) => {
  console.error('\n❌ Customer submission failed:');
  console.error(err.response?.data || err.message);
  process.exit(1);
});
