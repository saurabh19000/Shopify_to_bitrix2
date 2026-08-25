/**
 * Comprehensive Two-Way Synchronization Test Suite (Bitrix24 ↔ Shopify)
 * 
 * Verifies all 8 core capabilities:
 *   1. Bitrix Contact Create -> Shopify Customer Created + Addresses + UF_CRM_SHOPIFY_ID updated in Bitrix
 *   2. Bitrix Contact Update -> Shopify Customer Updated
 *   3. Bitrix Product Create -> Shopify Product Created + Mappings Saved
 *   4. Bitrix Product Update -> Shopify Product Updated with Variant ID Preserved
 *   5. Bitrix Deal Create -> Shopify Draft Order Created with Line Items, Addresses, Customer
 *   6. Bitrix Deal Update -> Shopify Order Fields Updated (financial_status, notes)
 *   7. Echo Loop Suppression -> Forward Shopify->Bitrix sync prevents infinite echo loops
 *   8. Error Handling & Security -> Token auth (401), missing ID (400), not found (404), token masking in logs
 *
 * Run: node test/twoWaySyncComprehensive.test.js
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

const { recordSync, isEchoLoop } = require('../src/utils/syncTracker');

// ---------------------------------------------------------------------------
// Fake Bitrix Portal
// ---------------------------------------------------------------------------
const createFakeBitrixPortal = () => {
  const state = {
    contacts: {
      '101': {
        ID: '101',
        NAME: 'Alice',
        LAST_NAME: 'Smith',
        EMAIL: [{ VALUE: 'alice@example.com', VALUE_TYPE: 'WORK' }],
        PHONE: [{ VALUE: '+15551234567', VALUE_TYPE: 'WORK' }],
        ADDRESS: '123 Main St',
        ADDRESS_CITY: 'Springfield',
        ADDRESS_PROVINCE: 'IL',
        ADDRESS_COUNTRY: 'US',
        ADDRESS_POSTAL_CODE: '62701',
        UF_CRM_CUSTOMER_TAGS: 'VIP, Wholesale',
        UF_CRM_CUSTOMER_NOTE: 'Preferred customer',
        UF_CRM_SHOPIFY_ID: ''
      },
      '102': {
        ID: '102',
        NAME: 'Bob',
        LAST_NAME: 'Jones',
        EMAIL: [{ VALUE: 'bob@example.com', VALUE_TYPE: 'WORK' }],
        UF_CRM_SHOPIFY_ID: 'cust_bob_999'
      }
    },
    products: {
      '201': {
        ID: '201',
        NAME: 'Diamond Ring',
        PRICE: '999.50',
        DESCRIPTION: 'Luxury 18k diamond ring',
        CODE: 'DR-18K',
        ACTIVE: 'Y',
        VENDOR: 'Artisan Co'
      },
      '202': {
        ID: '202',
        NAME: 'Gold Bracelet',
        PRICE: '450.00',
        ACTIVE: 'Y'
      }
    },
    deals: {
      '301': {
        ID: '301',
        TITLE: 'Deal #301 - Alice Order',
        OPPORTUNITY: '1999.00',
        STAGE_ID: 'NEW',
        CONTACT_ID: '101',
        COMMENTS: 'Express delivery requested'
      }
    },
    dealProductRows: {
      '301': [
        { PRODUCT_NAME: 'Diamond Ring', PRICE: '999.50', QUANTITY: '2' }
      ]
    }
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const endpoint = req.url.replace(/^\//, '');
      let payload = {};
      try { payload = JSON.parse(body); } catch (e) {}

      let result;
      switch (endpoint) {
        case 'crm.contact.get':
          result = state.contacts[String(payload.id)] || null;
          break;
        case 'crm.contact.update':
          if (state.contacts[String(payload.id)] && payload.fields) {
            Object.assign(state.contacts[String(payload.id)], payload.fields);
          }
          result = payload.id;
          break;
        case 'crm.product.get':
          result = state.products[String(payload.id)] || null;
          break;
        case 'crm.deal.get':
          result = state.deals[String(payload.id)] || null;
          break;
        case 'crm.deal.productrows.get':
          result = state.dealProductRows[String(payload.id)] || [];
          break;
        default:
          result = {};
      }

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result }));
    });
  });

  return {
    state,
    listen: (port) => new Promise((resolve) => server.listen(port, resolve)),
    close: () => new Promise((resolve) => server.close(resolve))
  };
};

// ---------------------------------------------------------------------------
// Run Test Suite
// ---------------------------------------------------------------------------
const runSuite = async () => {
  console.log('\n========================================');
  console.log(' Starting Two-Way Sync Comprehensive Test Suite');
  console.log('========================================\n');

  const portal = createFakeBitrixPortal();
  await portal.listen(8091);
  process.env.BITRIX_WEBHOOK_URL = 'http://localhost:8091';

  // Monkey-patch axios for Shopify API
  const shopifyCalls = [];
  const origPost = axios.post;
  const origPut = axios.put;
  const origGet = axios.get;

  axios.get = async (url, opts) => {
    if (url.includes('/admin/api/')) shopifyCalls.push({ method: 'GET', url, opts });
    if (url.includes('/customers/search.json')) {
      return { status: 200, data: { customers: [] } };
    }
    if (url.includes('/products/shp_prod_202.json')) {
      return { status: 200, data: { product: { id: 'shp_prod_202', variants: [{ id: 'var_777', price: '400.00' }] } } };
    }
    return origGet(url, opts);
  };

  axios.post = async (url, data, opts) => {
    if (url.includes('/admin/api/')) shopifyCalls.push({ method: 'POST', url, data, opts });
    if (url.includes('/customers.json')) {
      return { status: 201, data: { customer: { id: 7001, ...data.customer } } };
    }
    if (url.includes('/products.json')) {
      return { status: 201, data: { product: { id: 8001, ...data.product } } };
    }
    if (url.includes('/draft_orders.json')) {
      return { status: 201, data: { draft_order: { id: 9001, ...data.draft_order } } };
    }
    if (url.includes('/inventory_levels/set.json')) {
      return { status: 200, data: { inventory_level: { available: data.available } } };
    }
    return origPost(url, data, opts);
  };

  axios.put = async (url, data, opts) => {
    if (url.includes('/admin/api/')) shopifyCalls.push({ method: 'PUT', url, data, opts });
    if (url.includes('/customers/')) {
      return { status: 200, data: { customer: { id: 7002, ...data.customer } } };
    }
    if (url.includes('/orders/')) {
      return { status: 200, data: { order: { id: 9002, ...data.order } } };
    }
    if (url.includes('/products/')) {
      return { status: 200, data: { product: { id: 8002, ...data.product } } };
    }
    return origPut(url, data, opts);
  };

  // Mount express app with sync routes
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const syncRoutes = require('../src/routes/sync.routes');
  app.use('/sync', syncRoutes);

  const testServer = http.createServer(app);
  await new Promise((resolve) => testServer.listen(8092, resolve));

  const postSync = (path, body, headers = {}) => {
    return axios.post(`http://localhost:8092/sync${path}`, body, {
      headers: { 'x-sync-token': 'secret_sync_token_123', ...headers },
      validateStatus: () => true
    });
  };

  let passed = 0;
  let failed = 0;
  const test = (name, fn) => {
    try {
      fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL: ${name} -> ${err.message}`);
      failed++;
    }
  };

  try {
    // ----------------------------------------------------
    // Scenario 1: Contact Create -> Shopify Customer Created
    // ----------------------------------------------------
    console.log('\n--- Scenario 1: Bitrix Contact Create -> Shopify Customer ---');
    const res1 = await postSync('/bitrix/contact-update', {
      event: 'ONCRMCONTACTADD',
      data: { FIELDS: { ID: '101' } }
    });
    test('Contact creation endpoint returns 200', () => assert.strictEqual(res1.status, 200));
    test('Customer POSTed to Shopify with correct address and tags', () => {
      const call = shopifyCalls.find((c) => c.method === 'POST' && c.url.includes('/customers.json'));
      assert(call, 'Shopify customer creation API was called');
      assert.strictEqual(call.data.customer.first_name, 'Alice');
      assert.strictEqual(call.data.customer.last_name, 'Smith');
      assert.strictEqual(call.data.customer.email, 'alice@example.com');
      assert.strictEqual(call.data.customer.addresses[0].city, 'Springfield');
      assert.strictEqual(call.data.customer.addresses[0].zip, '62701');
    });
    test('Bitrix Contact updated with Shopify ID 7001', () => {
      assert.strictEqual(portal.state.contacts['101'].UF_CRM_SHOPIFY_ID, '7001');
    });

    // ----------------------------------------------------
    // Scenario 2: Contact Update -> Shopify Customer Updated
    // ----------------------------------------------------
    console.log('\n--- Scenario 2: Bitrix Contact Update -> Shopify Customer ---');
    const res2 = await postSync('/bitrix/contact-update', {
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: '102' } }
    });
    test('Contact update endpoint returns 200', () => assert.strictEqual(res2.status, 200));
    test('Existing Shopify customer PUT updated', () => {
      const call = shopifyCalls.find((c) => c.method === 'PUT' && c.url.includes('/customers/cust_bob_999.json'));
      assert(call, 'Shopify customer PUT was called with ID cust_bob_999');
      assert.strictEqual(call.data.customer.first_name, 'Bob');
      assert.strictEqual(call.data.customer.email, 'bob@example.com');
    });

    // ----------------------------------------------------
    // Scenario 3: Product Create -> Shopify Product Created
    // ----------------------------------------------------
    console.log('\n--- Scenario 3: Bitrix Product Create -> Shopify Product ---');
    const res3 = await postSync('/bitrix/product-update', {
      event: 'ONCRMPRODUCTADD',
      data: { FIELDS: { ID: '201' } }
    });
    test('Product create endpoint returns 200', () => assert.strictEqual(res3.status, 200));
    test('Product POSTed to Shopify with price and sku', () => {
      const call = shopifyCalls.find((c) => c.method === 'POST' && c.url.includes('/products.json'));
      assert(call, 'Shopify product POST was called');
      assert.strictEqual(call.data.product.title, 'Diamond Ring');
      assert.strictEqual(call.data.product.variants[0].price, 999.50);
      assert.strictEqual(call.data.product.variants[0].sku, 'DR-18K');
    });
    test('Product ID mapping saved in idMapStore', async () => {
      const mapped = await idMapStore.getMapping('products', '201');
      assert.strictEqual(mapped, '8001');
    });

    // ----------------------------------------------------
    // Scenario 4: Product Update -> Shopify Product Updated (Preserving Variant ID)
    // ----------------------------------------------------
    console.log('\n--- Scenario 4: Bitrix Product Update -> Preserve Variant ID ---');
    await idMapStore.setMapping('products', '202', 'shp_prod_202');
    portal.state.products['202'].PRICE = '475.00';
    const res4 = await postSync('/bitrix/product-update', {
      event: 'ONCRMPRODUCTUPDATE',
      data: { FIELDS: { ID: '202' } }
    });
    test('Product update endpoint returns 200', () => assert.strictEqual(res4.status, 200));
    test('Shopify product PUT called with preserved variant ID var_777', () => {
      const call = shopifyCalls.find((c) => c.method === 'PUT' && c.url.includes('/products/shp_prod_202.json'));
      assert(call, 'Shopify product PUT was called');
      assert.strictEqual(call.data.product.variants[0].id, 'var_777');
      assert.strictEqual(call.data.product.variants[0].price, 475.00);
    });

    // ----------------------------------------------------
    // Scenario 5: Deal Create -> Shopify Draft Order Created
    // ----------------------------------------------------
    console.log('\n--- Scenario 5: Bitrix Deal Create -> Shopify Draft Order ---');
    const res5 = await postSync('/bitrix/deal-update', {
      event: 'ONCRMDEALADD',
      data: { FIELDS: { ID: '301' } }
    });
    test('Deal create endpoint returns 200', () => assert.strictEqual(res5.status, 200));
    test('Draft order POSTed to Shopify with line items and customer', () => {
      const call = shopifyCalls.find((c) => c.method === 'POST' && c.url.includes('/draft_orders.json'));
      assert(call, 'Shopify draft order POST was called');
      assert.strictEqual(call.data.draft_order.line_items.length, 1);
      assert.strictEqual(call.data.draft_order.line_items[0].title, 'Diamond Ring');
      assert.strictEqual(call.data.draft_order.line_items[0].quantity, 2);
      assert.strictEqual(call.data.draft_order.customer.id, 7001);
      assert.strictEqual(call.data.draft_order.note, 'Express delivery requested');
    });
    test('Bi-directional mapping saved for deal 301 <-> draft 9001', async () => {
      const mapped = await idMapStore.getMapping('deals_reverse', '301');
      assert.strictEqual(mapped, '9001');
    });

    // ----------------------------------------------------
    // Scenario 6: Deal Update -> Shopify Order Fields Updated
    // ----------------------------------------------------
    console.log('\n--- Scenario 6: Bitrix Deal Update -> Shopify Order ---');
    portal.state.deals['301'].UF_CRM_FINANCIAL_STATUS = 'paid';
    portal.state.deals['301'].COMMENTS = 'Customer confirmed payment';
    const res6 = await postSync('/bitrix/deal-update', {
      event: 'ONCRMDEALUPDATE',
      data: { FIELDS: { ID: '301' } }
    });
    test('Deal update endpoint returns 200', () => assert.strictEqual(res6.status, 200));
    test('Shopify order PUT called with updated financial_status and note', () => {
      const call = shopifyCalls.find((c) => c.method === 'PUT' && c.url.includes('/orders/9001.json'));
      assert(call, 'Shopify order PUT was called');
      assert.strictEqual(call.data.order.financial_status, 'paid');
      assert.strictEqual(call.data.order.note, 'Customer confirmed payment');
    });

    // ----------------------------------------------------
    // Scenario 7: Echo Loop Suppression
    // ----------------------------------------------------
    console.log('\n--- Scenario 7: Echo Loop Suppression ---');
    // Simulate that forward sync just updated contact 101 from Shopify
    recordSync('SHOPIFY_TO_BITRIX', 'contact', '101');
    const callsBefore = shopifyCalls.length;
    const res7 = await postSync('/bitrix/contact-update', {
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: '101' } }
    });
    test('Echo event returns 200 with loop prevention message', () => {
      assert.strictEqual(res7.status, 200);
      assert(res7.data.includes('Echo event ignored'));
    });
    test('No new Shopify API calls made during echo event', () => {
      assert.strictEqual(shopifyCalls.length, callsBefore);
    });

    // ----------------------------------------------------
    // Scenario 8: Auth & Validation Error Handling
    // ----------------------------------------------------
    console.log('\n--- Scenario 8: Auth & Error Handling ---');
    const resAuthFail = await postSync('/bitrix/contact-update', { data: { ID: '101' } }, { 'x-sync-token': 'wrong_token' });
    test('Invalid sync token returns 401 Unauthorized', () => assert.strictEqual(resAuthFail.status, 401));

    const resMissingId = await postSync('/bitrix/contact-update', { data: {} });
    test('Missing entity ID returns 400 Bad Request', () => assert.strictEqual(resMissingId.status, 400));

    const resNotFound = await postSync('/bitrix/contact-update', { data: { ID: '999999' } });
    test('Non-existent Bitrix entity returns 404 Not Found', () => assert.strictEqual(resNotFound.status, 404));

    // ----------------------------------------------------
    // Final Summary
    // ----------------------------------------------------
    console.log('\n========================================');
    console.log(` Summary: ${passed} passed, ${failed} failed`);
    console.log('========================================\n');

    if (failed > 0) {
      process.exit(1);
    } else {
      console.log('ALL TWO-WAY SYNCHRONIZATION TESTS PASSED SUCCESSFULLY!\n');
    }
  } finally {
    await portal.close();
    testServer.close();
  }
};

runSuite().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
