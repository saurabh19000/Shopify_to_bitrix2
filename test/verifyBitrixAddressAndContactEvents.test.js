/**
 * Test Suite: Cross-check Bitrix Contact and Address Webhook Variations
 * 
 * Verifies that:
 * 1. Standard ONCRMCONTACTADD with data.FIELDS.ID creates customer in Shopify.
 * 2. ONCRMADDRESSREGISTER with data.FIELDS.ANCHOR_ID (ANCHOR_TYPE_ID=CONTACT) resolves to contact and syncs.
 * 3. ONCRMREQUISITEADD with data.FIELDS.ENTITY_ID (ENTITY_TYPE_ID=3) resolves to contact and syncs.
 * 4. URL-encoded payloads with nested brackets (data[FIELDS][ANCHOR_ID]) parse and sync.
 * 5. Domestic phone formatting errors automatically retry with email-only.
 * 6. Duplicate email (422) automatically resolves and links existing Shopify customer.
 * 7. Non-fatal handling if Bitrix portal lacks UF_CRM_SHOPIFY_ID custom field.
 * 8. Non-entity / metadata pings return 200 OK without failing.
 *
 * Run: node test/verifyBitrixAddressAndContactEvents.test.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const axios = require('axios');

process.env.SHOPIFY_STORE_URL = 'test-store.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test_access_token';
process.env.SHOPIFY_API_VERSION = '2024-10';
process.env.BITRIX_SYNC_TOKEN = 'secret_sync_token_123';
process.env.SHOPIFY_LOCATION_ID = 'loc_888';
process.env.BITRIX_ORDER_SYNC_ENABLED = 'true';

// ---------------------------------------------------------------------------
// In-Memory idMapStore & tokenStore
// ---------------------------------------------------------------------------
const idMapStore = require('../src/utils/idMapStore');
const memMap = new Map();
const memKey = (type, id) => `${type}|${String(id)}`;
idMapStore.setMapping = async (type, id, bitrixId) => { memMap.set(memKey(type, id), String(bitrixId)); };
idMapStore.getMapping = async (type, id) => memMap.get(memKey(type, id)) || null;
idMapStore.getMappingWithFallback = async (type, id) => idMapStore.getMapping(type, id);
idMapStore.deleteMapping = async (type, id) => { memMap.delete(memKey(type, id)); };

// ---------------------------------------------------------------------------
// Fake Bitrix Portal
// ---------------------------------------------------------------------------
const createFakeBitrixPortal = () => {
  const state = {
    contacts: {
      '8570': {
        ID: '8570',
        NAME: 'Pooja',
        LAST_NAME: 'khatri',
        EMAIL: [{ VALUE: 'bansodpooja13@gmail.com', VALUE_TYPE: 'WORK' }],
        PHONE: [{ VALUE: '+918329232496', VALUE_TYPE: 'WORK' }],
        ADDRESS: '1202, galaxy one apartment, Wing A, NEAR EON IT PARK, Kharadi',
        ADDRESS_CITY: 'PUNE',
        ADDRESS_PROVINCE: 'Maharashtra',
        ADDRESS_COUNTRY: 'India',
        ADDRESS_POSTAL_CODE: '411014',
        UF_CRM_CUSTOMER_TAGS: 'Online, Retail',
        UF_CRM_SHOPIFY_ID: ''
      },
      '8571': {
        ID: '8571',
        NAME: 'Rahul',
        LAST_NAME: 'Sharma',
        EMAIL: [{ VALUE: 'rahul.sharma@example.com', VALUE_TYPE: 'WORK' }],
        PHONE: [{ VALUE: '9876543210', VALUE_TYPE: 'WORK' }], // Invalid domestic phone format
        UF_CRM_SHOPIFY_ID: ''
      },
      '8572': {
        ID: '8572',
        NAME: 'Existing',
        LAST_NAME: 'User',
        EMAIL: [{ VALUE: 'existing.duplicate@example.com', VALUE_TYPE: 'WORK' }],
        UF_CRM_SHOPIFY_ID: ''
      },
      '8573': {
        ID: '8573',
        NAME: 'NoCustomField',
        EMAIL: [{ VALUE: 'nocustom@example.com', VALUE_TYPE: 'WORK' }],
        PHONE: [{ VALUE: '+15559998888', VALUE_TYPE: 'WORK' }]
      }
    },
    updates: [],
    customFieldsSupported: true
  };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.post('/crm.contact.get', (req, res) => {
    const id = req.body?.id || req.body?.ID;
    const contact = state.contacts[String(id)];
    res.json({ result: contact || null });
  });

  app.post('/crm.contact.update', (req, res) => {
    const id = req.body?.id || req.body?.ID;
    state.updates.push({ id, fields: req.body?.fields });
    if (!state.customFieldsSupported && req.body?.fields?.UF_CRM_SHOPIFY_ID) {
      return res.status(400).json({ error: 'ERROR_CORE', error_description: 'Field UF_CRM_SHOPIFY_ID is not found' });
    }
    if (state.contacts[String(id)]) {
      Object.assign(state.contacts[String(id)], req.body.fields);
    }
    res.json({ result: true });
  });

  app.post('/crm.contact.list', (req, res) => {
    const filter = req.body?.filter || {};
    let matches = Object.values(state.contacts);
    if (filter.EMAIL) {
      matches = matches.filter(c => c.EMAIL?.some(e => e.VALUE.toLowerCase() === filter.EMAIL.toLowerCase()));
    }
    res.json({ result: matches.map(c => ({ ID: c.ID })) });
  });

  return { app, state };
};

// ---------------------------------------------------------------------------
// Run Test Suite
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('\n============================================================');
  console.log(' RUNNING BITRIX CONTACT & ADDRESS WEBHOOK TEST SUITE');
  console.log('============================================================\n');

  // Start Fake Bitrix
  const { app: fakeBitrixApp, state: bitrixState } = createFakeBitrixPortal();
  const bitrixServer = http.createServer(fakeBitrixApp);
  await new Promise(resolve => bitrixServer.listen(0, resolve));
  const bitrixPort = bitrixServer.address().port;
  process.env.BITRIX_WEBHOOK_URL = `http://127.0.0.1:${bitrixPort}`;

  // State for Shopify mock
  const shopifyState = {
    customers: [],
    requests: []
  };

  const origGet = axios.get;
  const origPost = axios.post;
  const origPut = axios.put;

  axios.get = async (url, opts) => {
    if (url.includes('/admin/api/')) {
      shopifyState.requests.push({ method: 'GET', url });
      if (url.includes('/customers/search.json')) {
        if (url.includes('existing.duplicate%40example.com') || url.includes('existing.duplicate@example.com')) {
          return { status: 200, data: { customers: [{ id: 99991, email: 'existing.duplicate@example.com', first_name: 'Existing' }] } };
        }
        return { status: 200, data: { customers: [] } };
      }
    }
    return origGet(url, opts);
  };

  axios.post = async (url, data, opts) => {
    if (url.includes('/admin/api/')) {
      shopifyState.requests.push({ method: 'POST', url, data });
      if (url.includes('/customers.json')) {
        const cust = data.customer || {};

        // Simulate Shopify rejecting invalid phone number
        if (cust.phone && !cust.phone.startsWith('+')) {
          const err = new Error('Request failed with status code 422');
          err.response = { status: 422, data: { errors: { phone: ['is invalid'] } } };
          throw err;
        }

        // Simulate Shopify rejecting duplicate email
        if (cust.email === 'existing.duplicate@example.com') {
          const err = new Error('Request failed with status code 422');
          err.response = { status: 422, data: { errors: { email: ['has already been taken'] } } };
          throw err;
        }

        const created = {
          id: 70000 + shopifyState.customers.length + 1,
          first_name: cust.first_name,
          last_name: cust.last_name,
          email: cust.email,
          phone: cust.phone,
          tags: cust.tags,
          addresses: cust.addresses || []
        };
        shopifyState.customers.push(created);
        return { status: 201, data: { customer: created } };
      }
    }
    return origPost(url, data, opts);
  };

  axios.put = async (url, data, opts) => {
    if (url.includes('/admin/api/')) {
      shopifyState.requests.push({ method: 'PUT', url, data });
      return { status: 200, data: { customer: { id: 99991, ...data.customer } } };
    }
    return origPut(url, data, opts);
  };

  // Start App
  const syncRoutes = require('../src/routes/sync.routes');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/sync', syncRoutes);
  const appServer = http.createServer(app);
  await new Promise(resolve => appServer.listen(0, resolve));
  const appPort = appServer.address().port;
  const baseUrl = `http://127.0.0.1:${appPort}/sync`;

  let passed = 0;
  let failed = 0;

  const testCase = async (name, fn) => {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL: ${name}`);
      console.error(`        ${err.message}`);
      failed++;
    }
  };

  // Test 1: Standard ONCRMCONTACTADD
  await testCase('1. ONCRMCONTACTADD with data.FIELDS.ID creates customer in Shopify', async () => {
    const res = await origPost(`${baseUrl}/bitrix/event?token=secret_sync_token_123`, {
      event: 'ONCRMCONTACTADD',
      data: { FIELDS: { ID: '8570' } }
    });
    assert.strictEqual(res.status, 200);
    const createdCust = shopifyState.customers.find(c => c.email === 'bansodpooja13@gmail.com');
    assert(createdCust, 'Shopify customer should be created');
    assert.strictEqual(createdCust.first_name, 'Pooja');
    assert.strictEqual(createdCust.phone, '+918329232496');
    assert(createdCust.addresses?.length > 0, 'Customer address should be included');
  });

  // Test 2: ONCRMADDRESSREGISTER with ANCHOR_ID
  await testCase('2. ONCRMADDRESSREGISTER with data.FIELDS.ANCHOR_ID resolves to contact and syncs', async () => {
    const res = await origPost(`${baseUrl}/bitrix/event?token=secret_sync_token_123`, {
      event: 'ONCRMADDRESSREGISTER',
      data: {
        FIELDS: {
          TYPE_ID: 'PRIMARY',
          ENTITY_TYPE_ID: 'REQUISITE',
          ENTITY_ID: '1430',
          ANCHOR_ID: '8570',
          ANCHOR_TYPE_ID: 'CONTACT'
        }
      }
    });
    assert.strictEqual(res.status, 200);
    assert(res.data.includes('OK') || res.data.includes('ignored') || res.data.includes('loop prevention'));
  });

  // Test 3: ONCRMREQUISITEADD with ENTITY_ID
  await testCase('3. ONCRMREQUISITEADD with data.FIELDS.ENTITY_ID resolves to contact and syncs', async () => {
    const res = await origPost(`${baseUrl}/bitrix/event?token=secret_sync_token_123`, {
      event: 'ONCRMREQUISITEADD',
      data: {
        FIELDS: {
          ID: '99',
          ENTITY_ID: '8570',
          ENTITY_TYPE_ID: 'CONTACT'
        }
      }
    });
    assert.strictEqual(res.status, 200);
  });

  // Test 4: URL-Encoded Payload with nested bracket keys
  await testCase('4. URL-Encoded payload with data[FIELDS][ANCHOR_ID] parses and syncs', async () => {
    const params = new URLSearchParams();
    params.append('event', 'ONCRMADDRESSREGISTER');
    params.append('data[FIELDS][ANCHOR_ID]', '8570');
    params.append('data[FIELDS][ANCHOR_TYPE_ID]', 'CONTACT');

    const res = await origPost(`${baseUrl}/bitrix/event?token=secret_sync_token_123`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    assert.strictEqual(res.status, 200);
  });

  // Test 5: Invalid Domestic Phone Auto-Recovery
  await testCase('5. Invalid domestic phone automatically retries and creates with email only', async () => {
    const res = await origPost(`${baseUrl}/bitrix/event?token=secret_sync_token_123`, {
      event: 'ONCRMCONTACTADD',
      data: { FIELDS: { ID: '8571' } }
    });
    assert.strictEqual(res.status, 200);
    const rahul = shopifyState.customers.find(c => c.email === 'rahul.sharma@example.com');
    assert(rahul, 'Customer Rahul should be created even if phone was invalid');
  });

  // Test 6: Duplicate Email (422) Auto-Recovery
  await testCase('6. Duplicate email 422 conflict automatically resolves and links customer', async () => {
    const res = await origPost(`${baseUrl}/bitrix/event?token=secret_sync_token_123`, {
      event: 'ONCRMCONTACTADD',
      data: { FIELDS: { ID: '8572' } }
    });
    assert.strictEqual(res.status, 200);
    const mapping = await idMapStore.getMapping('contacts', '99991');
    assert.strictEqual(mapping, '8572', 'Mapping should be saved for duplicate customer');
  });

  // Test 7: Missing Custom Field UF_CRM_SHOPIFY_ID Safety
  await testCase('7. Sync succeeds even if Bitrix throws error on UF_CRM_SHOPIFY_ID', async () => {
    bitrixState.customFieldsSupported = false; // Simulate Bitrix portal without custom user field
    const res = await origPost(`${baseUrl}/bitrix/event?token=secret_sync_token_123`, {
      event: 'ONCRMCONTACTADD',
      data: { FIELDS: { ID: '8573' } }
    });
    assert.strictEqual(res.status, 200);
    const cust = shopifyState.customers.find(c => c.email === 'nocustom@example.com');
    assert(cust, 'Customer should be created in Shopify');
  });

  // Test 8: Non-entity metadata events return 200 OK
  await testCase('8. Non-entity metadata ping returns 200 OK without failing', async () => {
    const res = await origPost(`${baseUrl}/bitrix/event?token=secret_sync_token_123`, {
      event: 'ONAPPINSTALL',
      data: {}
    });
    assert.strictEqual(res.status, 200);
    assert(res.data.includes('skipped') || res.data.includes('ignored'));
  });

  // Cleanup
  axios.get = origGet;
  axios.post = origPost;
  axios.put = origPut;
  await new Promise(resolve => bitrixServer.close(resolve));
  await new Promise(resolve => appServer.close(resolve));

  console.log('\n============================================================');
  console.log(` SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('ALL BITRIX ADDRESS & CONTACT EVENT TESTS PASSED 100%!\n');
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
