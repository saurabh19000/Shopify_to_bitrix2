/**
 * Reverse-sync (Bitrix24 -> Shopify) integration test — fully offline.
 *
 * Fakes:
 *   - Bitrix portal (local HTTP server, same pattern as singleTenant.test.js)
 *   - Shopify Admin REST API (axios monkey-patch)
 *   - tokenStore.getToken -> returns a DB-stored OAuth token while env token is EMPTY
 *     (proves the credential fallback fix end-to-end)
 *   - idMapStore -> in-memory
 *
 * Verifies:
 *   1. contact-update with no UF_CRM_SHOPIFY_ID -> CREATES a Shopify customer + links it back in Bitrix
 *   2. product-update with no mapping          -> CREATES a Shopify product + saves mapping
 *   3. product-update WITH mapping             -> PUTs price update PRESERVING the existing variant ID
 *   4. deal-update with no order mapping       -> CREATES a Shopify DRAFT ORDER from deal rows + contact
 *   5. second deal-update (now mapped)         -> pushes financial_status to that order
 *   6. requests without the sync token are rejected (401)
 *
 * Run: node test/reverseSync.test.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.SHOPIFY_STORE_URL = 'test-store.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = ''; // deliberately EMPTY -> forces DB-token fallback
process.env.SHOPIFY_API_VERSION = '2024-10';
process.env.BITRIX_SYNC_TOKEN = 'testtoken';
process.env.COMPUTE_LIFETIME = 'false';
delete process.env.BITRIX_ORDER_SYNC_ENABLED;
delete process.env.BITRIX_DRAFT_ORDER_AUTOCOMPLETE;

// ---------------------------------------------------------------------------
// Stub tokenStore BEFORE anything requires it: getToken returns the "DB" token.
// ---------------------------------------------------------------------------
const tsPath = require.resolve('../src/utils/tokenStore');
require.cache[tsPath] = {
  id: tsPath,
  filename: tsPath,
  loaded: true,
  exports: {
    saveToken: async () => {},
    getToken: async () => 'shpat_from_database',
    deleteToken: async () => {}
  }
};

// In-memory id_map (must patch before requiring services).
const idMapStore = require('../src/utils/idMapStore');
const memMap = new Map();
const memKey = (type, id) => `${type}|${String(id)}`;
idMapStore.setMapping = async (type, id, bitrixId) => { memMap.set(memKey(type, id), String(bitrixId)); };
idMapStore.getMapping = async (type, id) => memMap.get(memKey(type, id)) || null;
idMapStore.getMappingWithFallback = async (type, id) => idMapStore.getMapping(type, id);
idMapStore.getMappingLegacy = async () => null;
idMapStore.deleteMapping = async (type, id) => { memMap.delete(memKey(type, id)); };

// ---------------------------------------------------------------------------
// Fake Bitrix portal
// ---------------------------------------------------------------------------
const createFakePortal = () => {
  const calls = [];
  const state = {
    contact501: {
      ID: '501', NAME: 'Jane', LAST_NAME: 'Roe',
      UF_CRM_SHOPIFY_ID: '',
      EMAIL: [{ VALUE: 'jane@bitrix.test', VALUE_TYPE: 'WORK' }],
      PHONE: [{ VALUE: '+911234567890', VALUE_TYPE: 'WORK' }]
    },
    contact777: {
      ID: '777', NAME: 'PhoneOnly', LAST_NAME: 'Patel',
      UF_CRM_SHOPIFY_ID: '',
      PHONE: [{ VALUE: '+919999999999', VALUE_TYPE: 'WORK' }]
    },
    product: {},
    deal: {}
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url.replace(/^\//, '');
      let payload = {};
      try { payload = JSON.parse(body); } catch (e) {}
      calls.push({ url, payload });

      let result;
      switch (url) {
        case 'crm.contact.get':
          result = String(payload.id) === '777' ? state.contact777 : state.contact501;
          break;
        case 'crm.contact.update':
          if (payload.fields && payload.fields.UF_CRM_SHOPIFY_ID) {
            const target = String(payload.id) === '777' ? state.contact777 : state.contact501;
            target.UF_CRM_SHOPIFY_ID = payload.fields.UF_CRM_SHOPIFY_ID;
          }
          result = payload.id;
          break;
        case 'crm.deal.get':
          result = state.deal.current || null;
          break;
        case 'crm.deal.productrows.get':
          result = state.deal.rows || [];
          break;
        case 'crm.product.get':
          result = state.product.current || null;
          break;
        default:
          result = true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/`, calls, state });
    });
  });
};

// ---------------------------------------------------------------------------
// Fake Shopify Admin REST API via axios monkey-patch
// ---------------------------------------------------------------------------
const axios = require('axios');
let shopifyCalls = []; // { method, url, body }
let shopifyState = {
  customersByEmail: new Map(),
  customersByPhone: new Map(),
  draftOrderSeq: 9000,
  variantsByProduct: new Map() // productId -> [{id}]
};

const fakeShopify = async (method, url, body) => {
  shopifyCalls.push({ method, url, body });
  const u = new URL(url);
  const path = u.pathname;

  let data;
  if (method === 'get' && path.endsWith('/customers/search.json')) {
    const query = decodeURIComponent(u.searchParams.get('query') || '');
    const found = query.startsWith('phone:')
      ? shopifyState.customersByPhone.get(query.slice(6))
      : shopifyState.customersByEmail.get(query.replace('email:', '').toLowerCase());
    data = { customers: found ? [found] : [] };
  } else if (method === 'post' && path.endsWith('/customers.json')) {
    const c = { ...body.customer, id: shopifyState.customersByEmail.size + shopifyState.customersByPhone.size + 7001 };
    if (c.email) shopifyState.customersByEmail.set(String(c.email).toLowerCase(), c);
    if (c.phone) shopifyState.customersByPhone.set(String(c.phone), c);
    data = { customer: c };
  } else if (method === 'put' && /\/customers\/\d+\.json$/.test(path)) {
    data = { customer: { ...body.customer, id: Number(path.match(/(\d+)\.json$/)[1]) } };
  } else if (method === 'post' && path.endsWith('/products.json')) {
    data = { product: { ...body.product, id: 8001 } };
  } else if (method === 'get' && /\/products\/\d+\.json$/.test(path)) {
    const pid = path.match(/(\d+)\.json$/)[1];
    data = { product: { id: Number(pid), variants: shopifyState.variantsByProduct.get(pid) || [] } };
  } else if (method === 'put' && /\/products\/\d+\.json$/.test(path)) {
    const pid = path.match(/(\d+)\.json$/)[1];
    data = { product: { ...body.product, id: Number(pid) } };
  } else if (method === 'post' && path.endsWith('/draft_orders.json')) {
    data = { draft_order: { id: ++shopifyState.draftOrderSeq, order_id: null } };
  } else if (method === 'post' && /\/draft_orders\/\d+\/complete\.json$/.test(path)) {
    const did = path.match(/draft_orders\/(\d+)\//)[1];
    data = { draft_order: { id: Number(did), order_id: 60001 } };
  } else if (method === 'put' && /\/orders\/\d+\.json$/.test(path)) {
    data = { order: { ...body.order, id: Number(path.match(/(\d+)\.json$/)[1]) } };
  } else {
    data = {};
  }
  return { status: 200, statusText: 'OK', headers: {}, config: {}, data };
};

const realAxios = { get: axios.get.bind(axios), post: axios.post.bind(axios), put: axios.put.bind(axios) };
axios.get = async (url, cfg) => (url.includes('/admin/api/') ? fakeShopify('get', url, cfg && cfg.data) : realGet(url, cfg));
const realGet = realAxios.get;
axios.post = async (url, data, cfg) => (url.includes('/admin/api/') ? fakeShopify('post', url, data) : realPost(url, data, cfg));
const realPost = realAxios.post;
axios.put = async (url, data, cfg) => (url.includes('/admin/api/') ? fakeShopify('put', url, data) : realPut(url, data, cfg));
const realPut = realAxios.put;

// ---------------------------------------------------------------------------
// Test driver
// ---------------------------------------------------------------------------
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, pass: false });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
};

const main = async () => {
  const portal = await createFakePortal();
  process.env.BITRIX_WEBHOOK_URL = portal.baseUrl;

  const syncRoutes = require('../src/routes/sync.routes');
  const app = express();
  app.use(express.json());
  app.use('/sync', syncRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const postSync = (path, payload, token = 'testtoken') =>
    fetch(`${base}/sync${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-sync-token': token } : {}) },
      body: JSON.stringify(payload)
    });

  console.log('\n=== Auth ===');
  const denied = await postSync('/bitrix/contact-update', { data: { FIELDS: { ID: '501' } } }, 'wrongtoken');
  check('Wrong sync token rejected with 401', () => assert.strictEqual(denied.status, 401));

  console.log('\n=== Contact creation (Bitrix -> Shopify) ===');
  const r1 = await postSync('/bitrix/contact-update', { event: 'CRM_CONTACT_ADD', data: { FIELDS: { ID: '501' } } });
  check('Contact without Shopify ID -> CREATED new Shopify customer', () => {
    assert.strictEqual(r1.status, 200, `expected 200 got ${r1.status}: ${await_ignored(r1)}`);
    const created = shopifyCalls.find((c) => c.method === 'post' && c.url.endsWith('/customers.json'));
    assert.ok(created, 'POST customers.json was never called');
    assert.strictEqual(created.body.customer.email, 'jane@bitrix.test');
    assert.strictEqual(created.body.customer.first_name, 'Jane');
    assert.strictEqual(created.body.customer.phone, '+911234567890');
  });
  check('New customer linked back into Bitrix contact (UF_CRM_SHOPIFY_ID=7001)', () => {
    assert.strictEqual(portal.state.contact501.UF_CRM_SHOPIFY_ID, '7001');
  });
  check('Credentials came from DATABASE fallback (env token empty)', () => {
    // If fallback failed, route would have returned 500 and no Shopify call would exist.
    assert.ok(shopifyCalls.length > 0, 'no Shopify API calls were made');
  });

  console.log('\n=== Contact with ONLY phone (no email) ===');
  const rPhone = await postSync('/bitrix/contact-update', { data: { FIELDS: { ID: '777' } } });
  check('Phone-only Bitrix contact -> CREATED Shopify customer without email', () => {
    assert.strictEqual(rPhone.status, 200, `expected 200 got ${rPhone.status}`);
    const created = shopifyCalls.find((c) => c.method === 'post' && /customers\.json$/.test(c.url) && c.body.customer && c.body.customer.phone === '+919999999999');
    assert.ok(created, 'phone-only POST customers.json never happened');
    const createdFake = shopifyState.customersByPhone.get('+919999999999');
    assert.ok(createdFake, 'phone-only customer was never created in fake Shopify');
    assert.strictEqual(created.body.customer.email, undefined, 'must NOT send an empty/absent email key');
    assert.strictEqual(portal.state.contact777.UF_CRM_SHOPIFY_ID, String(createdFake.id), 'customer not linked back into Bitrix');
  });

  console.log('\n=== Product creation (Bitrix -> Shopify) ===');
  portal.state.product.current = { ID: 'p9', NAME: 'Gold Ring', PRICE: '250.00', ACTIVE: 'Y', CODE: 'GR-1' };
  const r2 = await postSync('/bitrix/product-update', { data: { FIELDS: { ID: 'p9' } } });
  check('Unmapped product -> CREATED new Shopify product', () => {
    assert.strictEqual(r2.status, 200);
    const created = shopifyCalls.find((c) => c.method === 'post' && c.url.endsWith('/products.json'));
    assert.ok(created, 'POST products.json was never called');
    assert.strictEqual(created.body.product.title, 'Gold Ring');
    assert.strictEqual(memMap.get(memKey('products', 'p9')), '8001');
  });

  console.log('\n=== Product update preserves variant IDs ===');
  memMap.set(memKey('products', 'p5'), '555');
  shopifyState.variantsByProduct.set('555', [{ id: 888 }, { id: 889 }]);
  portal.state.product.current = { ID: 'p5', NAME: 'Silver Chain', PRICE: '42.50', ACTIVE: 'Y' };
  const r3 = await postSync('/bitrix/product-update', { data: { FIELDS: { ID: 'p5' } } });
  check('Mapped product price push keeps existing variant id 888', () => {
    assert.strictEqual(r3.status, 200);
    const put = [...shopifyCalls].reverse().find((c) => c.method === 'put' && /\/products\/555\.json$/.test(c.url));
    assert.ok(put, 'PUT products/555.json was never called');
    assert.strictEqual(put.body.product.variants[0].id, 888, 'variant id lost — destructive update!');
    assert.strictEqual(put.body.product.variants[0].price, 42.5);
  });

  console.log('\n=== Deal -> Draft ORDER creation ===');
  portal.state.deal.current = {
    ID: '777', TITLE: 'Phone order — Priya', STAGE_ID: 'C10:NEW', OPPORTUNITY: '500.00',
    CONTACT_ID: '501', COMMENTS: 'Customer called to order'
  };
  portal.state.deal.rows = [
    { PRODUCT_NAME: 'Ring', PRICE: '100.00', QUANTITY: '2' },
    { PRODUCT_NAME: 'Chain', PRICE: '300.00', QUANTITY: '1' }
  ];
  const r4 = await postSync('/bitrix/deal-update', { data: { FIELDS: { ID: '777' } } });
  check('Unmapped deal -> CREATED Shopify DRAFT ORDER with line items + customer', () => {
    assert.strictEqual(r4.status, 200);
    const draftCall = shopifyCalls.find((c) => c.method === 'post' && c.url.endsWith('/draft_orders.json'));
    assert.ok(draftCall, 'POST draft_orders.json was never called');
    assert.strictEqual(draftCall.body.draft_order.customer.id, 7001, 'customer not attached');
    assert.strictEqual(draftCall.body.draft_order.line_items.length, 2);
    assert.strictEqual(draftCall.body.draft_order.line_items[0].title, 'Ring');
    assert.strictEqual(draftCall.body.draft_order.line_items[0].quantity, 2);
    assert.strictEqual(draftCall.body.draft_order.note, 'Customer called to order');
    assert.strictEqual(memMap.get(memKey('deals_reverse', '777')), String(shopifyState.draftOrderSeq), 'mapping not saved');
  });
  check('Draft NOT auto-completed when flag is off', () => {
    assert.ok(!shopifyCalls.some((c) => /complete\.json$/.test(c.url)), 'complete.json should not be called');
  });

  console.log('\n=== Deal update on mapped order ===');
  portal.state.deal.current.UF_CRM_FINANCIAL_STATUS = 'paid';
  const r5 = await postSync('/bitrix/deal-update', { data: { FIELDS: { ID: '777' } } });
  check('Second update pushes financial_status to mapped Shopify order', () => {
    assert.strictEqual(r5.status, 200);
    const put = [...shopifyCalls].reverse().find((c) => c.method === 'put' && /\/orders\/\d+\.json$/.test(c.url));
    assert.ok(put, 'PUT orders/:id.json was never called');
    assert.strictEqual(put.body.order.financial_status, 'paid');
  });

  server.closeAllConnections?.();
  server.close();
  portal.server.closeAllConnections?.();
  portal.server.close();

  console.log('\n=== Summary ===');
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  if (passed === results.length) {
    console.log('REVERSE-SYNC OK');
  } else {
    console.error('REVERSE-SYNC FAILED');
    process.exitCode = 1;
  }
};

function await_ignored(res) { return ''; }

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
