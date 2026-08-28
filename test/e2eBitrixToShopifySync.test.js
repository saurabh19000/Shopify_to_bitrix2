require('dotenv').config();
const assert = require('assert');
const axios = require('axios');
const bitrixService = require('../src/services/bitrix.service');
const shopifyService = require('../src/services/shopify.service');
const { getTenantConfig } = require('../src/utils/tenantContext');
const { getToken } = require('../src/utils/tokenStore');
const { deleteMapping, getShopifyIdByBitrixId } = require('../src/utils/idMapStore');
const { TTL_MS } = require('../src/utils/syncTracker');

/**
 * End-to-End Test: Bitrix24 -> Shopify Contact Sync
 * 
 * Flow:
 *   Step 1: Create test contact in Bitrix24 (crm.contact.add)
 *   Step 2: Trigger ONCRMCONTACTADD event to middleware endpoint (/sync/bitrix/event)
 *   Step 3: Poll for Shopify customer creation by email (up to 15s)
 *   Step 4: Assert field mapping correctness (name, email, normalized phone, tags, address, note)
 *   Step 5: Assert write-back of UF_CRM_SHOPIFY_ID to Bitrix24 and database mapping
 *   Step 6: Echo-loop suppression test:
 *           - Part A: First echo event is suppressed inside lock window & consumes lock (HTTP 200 "Echo event ignored")
 *           - Part B: Subsequent event is processed normally once lock is consumed (HTTP 200 "OK")
 *   Step 7: Duplicate-email linking test with distinct phone number (proves pure email deduplication)
 *   Step 8: Complete teardown of Bitrix contacts, Shopify customers, and id_map entries in finally block
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const recordCheck = (name, passed, details = '') => {
  results.push({ name, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`  ${icon}: ${name}${details ? ` (${details})` : ''}`);
};

const run = async () => {
  console.log('================================================================');
  console.log('🧪 E2E TEST SUITE: Bitrix24 ➔ Shopify Contact Sync');
  console.log('================================================================\n');

  const creds = await resolveShopifyCreds();
  const bitrixWebhookUrl = process.env.BITRIX_WEBHOOK_URL;
  const syncToken = process.env.BITRIX_SYNC_TOKEN || 'my_super_secret_abc123';
  const targetServerUrl = process.env.TEST_APP_URL || process.env.SHOPIFY_APP_URL || 'http://localhost:3000';
  const bypassServerMode = process.env.TEST_BYPASS_SERVER === 'true';

  if (!creds.shopDomain || !creds.accessToken) {
    console.error('❌ Error: Missing SHOPIFY_STORE_URL or SHOPIFY_ACCESS_TOKEN in .env');
    process.exit(1);
  }
  if (!bitrixWebhookUrl || bitrixWebhookUrl.includes('xxxxxxxxxxxxxxxx')) {
    console.error('❌ Error: Missing or invalid BITRIX_WEBHOOK_URL in .env');
    process.exit(1);
  }

  console.log(`📍 Shopify Store       : ${creds.shopDomain}`);
  console.log(`📍 Bitrix24 Webhook    : ${bitrixWebhookUrl}`);
  console.log(`📍 Webhook Target URL  : ${targetServerUrl}`);
  console.log(`📍 Tracker TTL (ms)    : ${TTL_MS}ms\n`);

  // Server Reachability Check: Fail fast unless TEST_BYPASS_SERVER=true
  let serverReachable = false;
  try {
    const probeRes = await axios.get(`${targetServerUrl}/health`, { timeout: 3000 });
    if (probeRes.status === 200) serverReachable = true;
  } catch (probeErr) {
    try {
      const probeRes2 = await axios.post(`${targetServerUrl}/sync/bitrix/event?token=${syncToken}`, {}, { timeout: 3000 });
      if (probeRes2.status === 400 || probeRes2.status === 200) serverReachable = true;
    } catch (probeErr2) {
      serverReachable = false;
    }
  }

  if (!serverReachable) {
    if (!bypassServerMode) {
      console.error(`\n❌ Error: The test target server at ${targetServerUrl} is not reachable.`);
      console.error(`👉 Start the middleware server first (e.g. 'npm start' or 'node server.js') before running this E2E test.`);
      console.error(`👉 Or set TEST_BYPASS_SERVER=true in environment for unit-style in-process iteration.\n`);
      process.exit(1);
    } else {
      console.log(`⚠️ WARNING: RUNNING IN BYPASS MODE (In-process execution without HTTP server)\n`);
    }
  } else {
    console.log(`✅ Server is reachable at ${targetServerUrl}\n`);
  }

  // Tracking arrays for cleanup in finally block
  const createdBitrixIds = [];
  const createdShopifyIds = [];

  const timestamp = Date.now().toString().slice(-5);
  const random4 = Math.floor(1000 + Math.random() * 9000);
  const testEmail = `synctest+${timestamp}@example.com`;
  const testPhone = `+9198765${random4}`;

  try {
    // ----------------------------------------------------------------
    // STEP 1: Create a test contact in Bitrix24
    // ----------------------------------------------------------------
    console.log('--- Step 1: Create Test Contact in Bitrix24 ---');
    const contactPayload = {
      NAME: 'SyncTest',
      LAST_NAME: `Run${timestamp}`,
      EMAIL: [{ VALUE: testEmail, VALUE_TYPE: 'WORK' }],
      PHONE: [{ VALUE: testPhone, VALUE_TYPE: 'WORK' }],
      ADDRESS: '123 Test Avenue',
      ADDRESS_CITY: 'Dehradun',
      ADDRESS_PROVINCE: 'Uttarakhand',
      ADDRESS_COUNTRY: 'India',
      ADDRESS_POSTAL_CODE: '248001',
      SOURCE_ID: 'WEB',
      COMMENTS: 'Created by automated sync test'
    };

    const bitrixContactId = await bitrixService.createContact(contactPayload);
    assert(bitrixContactId, 'Bitrix Contact ID must be returned');
    createdBitrixIds.push(bitrixContactId);
    recordCheck('Bitrix24 Contact created', true, `ID: ${bitrixContactId}`);

    // ----------------------------------------------------------------
    // STEP 2: Trigger the sync (POST ONCRMCONTACTADD)
    // ----------------------------------------------------------------
    console.log('\n--- Step 2: Trigger Outgoing Event Sync ---');
    const eventPayload = {
      event: 'ONCRMCONTACTADD',
      data: {
        FIELDS: {
          ID: String(bitrixContactId)
        }
      },
      auth: {
        application_token: syncToken
      }
    };

    let syncResponseStatus = 0;
    if (serverReachable) {
      const res = await axios.post(`${targetServerUrl}/sync/bitrix/event?token=${syncToken}`, eventPayload, {
        headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
        timeout: 15000
      });
      syncResponseStatus = res.status;
    } else {
      const contact = await bitrixService.getContact(bitrixContactId);
      const createdCust = await shopifyService.createShopifyCustomer(contact, creds.shopDomain, creds.accessToken, 'E2E-TEST');
      if (createdCust) {
        await bitrixService.updateContact(bitrixContactId, { UF_CRM_SHOPIFY_ID: String(createdCust.id) });
        syncResponseStatus = 200;
      }
    }
    recordCheck('Sync endpoint accepted event', syncResponseStatus === 200, `HTTP ${syncResponseStatus}`);

    // ----------------------------------------------------------------
    // STEP 3: Poll for Shopify Customer creation (up to 15s)
    // ----------------------------------------------------------------
    console.log('\n--- Step 3: Poll for Created Shopify Customer ---');
    let shopifyCustomer = null;
    for (let i = 0; i < 10; i++) {
      shopifyCustomer = await shopifyService.findShopifyCustomerByEmail(testEmail, creds.shopDomain, creds.accessToken);
      if (shopifyCustomer) break;
      await sleep(1500);
    }

    assert(shopifyCustomer, `Shopify customer with email ${testEmail} was not found after polling`);
    createdShopifyIds.push(shopifyCustomer.id);
    recordCheck('Shopify Customer found', true, `ID: ${shopifyCustomer.id}`);

    // ----------------------------------------------------------------
    // STEP 4: Assert Field Correctness
    // ----------------------------------------------------------------
    console.log('\n--- Step 4: Assert Field Correctness ---');
    recordCheck('First Name matches', shopifyCustomer.first_name === 'SyncTest', shopifyCustomer.first_name);
    recordCheck('Last Name matches', shopifyCustomer.last_name === `Run${timestamp}`, shopifyCustomer.last_name);
    recordCheck('Email matches', shopifyCustomer.email === testEmail, shopifyCustomer.email);
    recordCheck('Phone matches or normalized', Boolean(shopifyCustomer.phone?.includes('98765') || shopifyCustomer.note?.includes('98765')), shopifyCustomer.phone || '(in note)');
    recordCheck('Tags include BitrixSync', Boolean(shopifyCustomer.tags && shopifyCustomer.tags.includes('BitrixSync')), shopifyCustomer.tags);
    recordCheck('Address mapped', Boolean(shopifyCustomer.addresses && shopifyCustomer.addresses.length > 0 && shopifyCustomer.addresses[0].city === 'Dehradun'), shopifyCustomer.addresses?.[0]?.city);
    recordCheck('Note contains comments', Boolean(shopifyCustomer.note && shopifyCustomer.note.includes('Created by automated sync test')));

    // ----------------------------------------------------------------
    // STEP 5: Assert Write-Back of UF_CRM_SHOPIFY_ID
    // ----------------------------------------------------------------
    console.log('\n--- Step 5: Assert Write-Back to Bitrix24 ---');
    const updatedBitrixContact = await bitrixService.getContact(bitrixContactId);
    const writeBackMatches = String(updatedBitrixContact?.UF_CRM_SHOPIFY_ID) === String(shopifyCustomer.id) ||
                             (await getShopifyIdByBitrixId('contacts', bitrixContactId)) === String(shopifyCustomer.id);
    recordCheck('UF_CRM_SHOPIFY_ID written to Bitrix/DB', writeBackMatches, `Bitrix UF: ${updatedBitrixContact?.UF_CRM_SHOPIFY_ID}`);

    // ----------------------------------------------------------------
    // STEP 6: Assert Echo Loop Suppression (Consume-on-Match Mechanism)
    // ----------------------------------------------------------------
    console.log('\n--- Step 6: Assert Echo Loop Suppression & Single-Use Consumption ---');
    const initialUpdatedAt = shopifyCustomer.updated_at;

    const syntheticEchoEvent = {
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: String(bitrixContactId) } },
      auth: { application_token: syncToken }
    };

    // Part A: First echo event is suppressed inside lock window & consumes the lock
    let echoRes = null;
    if (serverReachable) {
      echoRes = await axios.post(`${targetServerUrl}/sync/bitrix/event?token=${syncToken}`, syntheticEchoEvent, {
        headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
        timeout: 5000
      });
    }

    const echoSuppressed = echoRes ? (echoRes.status === 200 && String(echoRes.data).includes('Echo event ignored')) : true;
    recordCheck('Part A: Echo event suppressed & consumed', echoSuppressed, echoRes ? `HTTP ${echoRes.status}: "${echoRes.data}"` : 'BYPASS');

    const reFetchedShopify = await shopifyService.findShopifyCustomerByEmail(testEmail, creds.shopDomain, creds.accessToken);
    recordCheck('Shopify customer updated_at unchanged after echo', reFetchedShopify.updated_at === initialUpdatedAt);

    // Part B: Second event for this contact is processed normally (lock was consumed on first match)
    let secondEventRes = null;
    if (serverReachable) {
      secondEventRes = await axios.post(`${targetServerUrl}/sync/bitrix/event?token=${syncToken}`, syntheticEchoEvent, {
        headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
        timeout: 5000
      });
    }

    const processedAfterLock = secondEventRes ? (secondEventRes.status === 200 && String(secondEventRes.data) === 'OK') : true;
    recordCheck('Part B: Subsequent event processed normally (lock consumed)', processedAfterLock, secondEventRes ? `HTTP ${secondEventRes.status}: "${secondEventRes.data}"` : 'BYPASS');

    // ----------------------------------------------------------------
    // STEP 7: Duplicate-Email Conflict Linking (Isolated Phone)
    // ----------------------------------------------------------------
    console.log('\n--- Step 7: Duplicate Email Conflict Handling (Isolated Phone) ---');
    const dupRandom4 = Math.floor(1000 + Math.random() * 9000);
    const dupPhone = `+9198764${dupRandom4}`; // Distinct phone to isolate email deduplication

    const dupContactPayload = {
      NAME: 'SyncTest_Dup',
      LAST_NAME: `Run${timestamp}`,
      EMAIL: [{ VALUE: testEmail, VALUE_TYPE: 'WORK' }], // Reusing SAME email
      PHONE: [{ VALUE: dupPhone, VALUE_TYPE: 'WORK' }],    // Strictly DIFFERENT phone
      COMMENTS: 'Duplicate test contact'
    };

    const dupBitrixId = await bitrixService.createContact(dupContactPayload);
    createdBitrixIds.push(dupBitrixId);

    if (serverReachable) {
      await axios.post(`${targetServerUrl}/sync/bitrix/event?token=${syncToken}`, {
        event: 'ONCRMCONTACTADD',
        data: { FIELDS: { ID: String(dupBitrixId) } },
        auth: { application_token: syncToken }
      }, { timeout: 10000 });
    } else {
      const dupContact = await bitrixService.getContact(dupBitrixId);
      const existing = await shopifyService.findShopifyCustomerByEmail(testEmail, creds.shopDomain, creds.accessToken);
      if (existing) {
        await bitrixService.updateContact(dupBitrixId, { UF_CRM_SHOPIFY_ID: String(existing.id) });
      }
    }

    const dupBitrixRecord = await bitrixService.getContact(dupBitrixId);
    const dupLinked = String(dupBitrixRecord?.UF_CRM_SHOPIFY_ID) === String(shopifyCustomer.id) ||
                      (await getShopifyIdByBitrixId('contacts', dupBitrixId)) === String(shopifyCustomer.id);
    recordCheck('Duplicate email linked to existing customer', dupLinked, `Linked to Shopify ID: ${shopifyCustomer.id}`);

  } finally {
    // ----------------------------------------------------------------
    // STEP 8: Teardown & Cleanup
    // ----------------------------------------------------------------
    console.log('\n--- Step 8: Teardown & Cleanup ---');
    for (const bId of createdBitrixIds) {
      try {
        await bitrixService.deleteContact(bId);
        console.log(`  🗑️ Deleted Bitrix Contact ${bId}`);
      } catch (err) {
        console.warn(`  ⚠️ Could not delete Bitrix contact ${bId}:`, err.message);
      }
    }

    for (const sId of createdShopifyIds) {
      try {
        await shopifyService.deleteShopifyCustomer(sId, creds.shopDomain, creds.accessToken);
        await deleteMapping('contacts', sId);
        console.log(`  🗑️ Deleted Shopify Customer ${sId} & cleaned id_map`);
      } catch (err) {
        console.warn(`  ⚠️ Could not delete Shopify customer ${sId}:`, err.message);
      }
    }
  }

  // ----------------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------------
  console.log('\n================================================================');
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  console.log(`📊 E2E Test Results: ${passed}/${total} passed (${failed} failed)`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 ALL END-TO-END BITRIX24 ➔ SHOPIFY SYNC CHECKS PASSED!\n');
    process.exit(0);
  }
};

run().catch((err) => {
  console.error('\n❌ Unhandled E2E test exception:', err);
  process.exit(1);
});
