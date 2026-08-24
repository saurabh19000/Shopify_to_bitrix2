/**
 * Single-tenant integration test (dependency-free).
 *
 * Verifies:
 *   1. All config resolves from .env (no DB config / tenant context)
 *   2. A Shopify customer webhook pushes to the .env Bitrix portal
 *   3. Re-sending the same customer/order updates instead of duplicating
 *   4. Stock sync uses the .env warehouse + responsible IDs
 *   5. Migration routes are callable WITHOUT an admin token
 *
 * Run: node test/singleTenant.test.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');

// --- .env-equivalent config (set before services are required) ------------
process.env.SHOPIFY_STORE_URL = 'test-store.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test';
process.env.SHOPIFY_API_VERSION = '2024-10';
process.env.BITRIX_CURRENCY = 'USD';
process.env.BITRIX_WAREHOUSE_ID = '5';
process.env.BITRIX_RESPONSIBLE_ID = '3';
process.env.COMPUTE_LIFETIME = 'false';

const { getTenantConfig } = require('../src/utils/tenantContext');

// ---------------------------------------------------------------------------
// Fake Bitrix portal — emulates the pieces of Bitrix24 the services use.
// Records every request it receives.
// ---------------------------------------------------------------------------
const createFakePortal = () => {
  const calls = [];
  let seq = 1000;
  const contactsByEmail = new Map();
  const dealsByTitle = new Map();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url.replace(/^\//, '').replace(/\.json$/, '');
      let payload = {};
      try { payload = JSON.parse(body); } catch (e) {}
      calls.push({ url, payload, host: req.headers.host });

      let result;
      switch (url) {
        case 'crm.contact.add':
          result = ++seq;
          if (payload.fields && payload.fields.EMAIL) {
            contactsByEmail.set(payload.fields.EMAIL[0].VALUE.toLowerCase(), result);
          }
          break;
        case 'crm.contact.update':
          result = payload.id || ++seq;
          break;
        case 'crm.contact.list': {
          const email = payload.filter && payload.filter.EMAIL;
          const id = email ? contactsByEmail.get(String(email).toLowerCase()) : null;
          result = id ? [{ ID: id }] : [];
          break;
        }
        case 'crm.deal.add':
          result = ++seq;
          if (payload.fields && payload.fields.TITLE) dealsByTitle.set(payload.fields.TITLE, result);
          break;
        case 'crm.deal.update':
          result = payload.id || ++seq;
          break;
        case 'crm.deal.list': {
          const title = payload.filter && payload.filter.TITLE;
          const id = title ? dealsByTitle.get(title) : null;
          result = id ? [{ ID: id }] : [];
          break;
        }
        case 'crm.deal.productrows.set':
          result = true;
          break;
        case 'crm.timeline.comment.add':
          result = ++seq;
          break;
        case 'catalog.document.add':
          result = { document: { id: ++seq, status: 'N' } };
          break;
        case 'catalog.document.element.add':
          result = { documentElement: { id: ++seq } };
          break;
        case 'catalog.document.conduct':
          result = true;
          break;
        default:
          result = ++seq;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, host: `127.0.0.1:${port}`, baseUrl: `http://127.0.0.1:${port}/`, calls });
    });
  });
};

// ---------------------------------------------------------------------------
// Patch idMapStore with an in-memory store (mirrors the Postgres table).
// Must happen BEFORE requiring the services (they destructure at require time).
// ---------------------------------------------------------------------------
const idMapStore = require('../src/utils/idMapStore');
const memMap = new Map();
const memKey = (type, shopifyId) => `${type}|${String(shopifyId)}`;
idMapStore.setMapping = async (type, shopifyId, bitrixId) => memMap.set(memKey(type, shopifyId), String(bitrixId));
idMapStore.getMapping = async (type, shopifyId) => memMap.get(memKey(type, shopifyId)) || null;
idMapStore.getMappingWithFallback = async (type, shopifyId) => idMapStore.getMapping(type, shopifyId);
idMapStore.getMappingLegacy = async () => null;
idMapStore.deleteMapping = async (type, shopifyId) => memMap.delete(memKey(type, shopifyId));

const bitrixService = require('../src/services/bitrix.service');

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
const count = (portal, url) => portal.calls.filter((c) => c.url === url).length;

const main = async () => {
  const portal = await createFakePortal();
  process.env.BITRIX_WEBHOOK_URL = portal.baseUrl;

  const customer = {
    id: 111,
    email: 'john@example.com',
    first_name: 'John',
    last_name: 'Doe',
    tags: 'vip'
  };

  const order = {
    id: 555,
    order_number: 5001,
    name: '#5001',
    total_price: '99.99',
    currency: 'USD',
    financial_status: 'paid',
    customer: { id: 111, email: 'john@example.com', first_name: 'John', last_name: 'Doe' },
    line_items: [{ title: 'Widget', price: '99.99', quantity: 1 }]
  };

  console.log('\n=== Config resolution ===');
  check('Config resolves from .env only', () => {
    const cfg = getTenantConfig();
    assert.strictEqual(cfg.shop, 'test-store.myshopify.com');
    assert.strictEqual(cfg.accessToken, 'shpat_test');
    assert.strictEqual(cfg.currencyId, 'USD');
    assert.strictEqual(cfg.warehouseId, 5);
    assert.strictEqual(cfg.responsibleId, 3);
    assert.strictEqual(cfg.bitrixWebhookUrl, portal.baseUrl);
    assert.strictEqual(typeof cfg.runWithTenant, 'undefined');
  });

  console.log('\n=== Customer sync ===');
  await bitrixService.createOrUpdateContact(customer, { skipLifetime: true });
  check('Customer pushed to the .env Bitrix portal (no tenant context)', () => {
    assert.deepStrictEqual([...new Set(portal.calls.map((c) => c.host))], [portal.host]);
    assert.strictEqual(count(portal, 'crm.contact.add'), 1);
    assert.strictEqual(memMap.get(memKey('contacts', 111)), '1001');
  });

  await bitrixService.createOrUpdateContact(customer, { skipLifetime: true });
  check('Same customer re-send updates, no duplicate contact', () => {
    assert.strictEqual(count(portal, 'crm.contact.add'), 1);
    assert.strictEqual(count(portal, 'crm.contact.update'), 1);
  });

  console.log('\n=== Deal sync ===');
  await bitrixService.createOrUpdateDeal(order, { skipLifetime: true });
  await bitrixService.createOrUpdateDeal(order, { skipLifetime: true });
  check('Same order -> one deal, no duplicate on re-send', () => {
    assert.strictEqual(count(portal, 'crm.deal.add'), 1);
    assert.strictEqual(count(portal, 'crm.deal.update'), 1);
    assert.strictEqual(memMap.get(memKey('deals', 555)), '1002');
  });

  console.log('\n=== Stock sync ===');
  await bitrixService.syncProductStock('p1', 999, 10, 'Widget Pro');
  check('Stock doc uses .env warehouse + responsible + currency', () => {
    const doc = portal.calls.find((c) => c.url === 'catalog.document.add');
    assert.ok(doc, 'catalog.document.add was not called');
    assert.strictEqual(doc.payload.fields.responsibleId, 3);
    assert.strictEqual(doc.payload.fields.currency, 'USD');
    const elem = portal.calls.find((c) => c.url === 'catalog.document.element.add');
    assert.strictEqual(elem.payload.fields.storeTo, 5);
  });
  await bitrixService.syncProductStock('p1', 999, 10, 'Widget Pro');
  check('Same quantity re-send -> no duplicate stock doc', () => {
    assert.strictEqual(count(portal, 'catalog.document.add'), 1);
  });

  console.log('\n=== Migration routes ===');
  const migrationRoutes = require('../src/routes/migration.routes');
  const app = express();
  app.use(express.json());
  app.use('/migration', migrationRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  process.env.SHOPIFY_STORE_URL = 'your-store.myshopify.com'; // placeholder creds -> immediate validation error
  const res = await fetch(base + '/migration/customers', { method: 'POST' });
  const body = await res.json();
  process.env.SHOPIFY_STORE_URL = 'test-store.myshopify.com';
  check('Migration route callable WITHOUT an admin token', () => {
    assert.notStrictEqual(res.status, 401, 'route still requires a token');
    assert.strictEqual(body.success, false);
    assert.match(body.error, /credentials/i);
  });
  server.closeAllConnections?.();
  server.close();

  portal.server.closeAllConnections?.();
  portal.server.close();

  console.log('\n=== Summary ===');
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  if (passed === results.length) {
    console.log('SINGLE-TENANT OK');
  } else {
    console.error('SINGLE-TENANT FAILED');
    process.exit(1);
  }
};

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
