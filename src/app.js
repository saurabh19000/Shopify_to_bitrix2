require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { debug, runWithRequestId, newRequestId } = require('./utils/debugLogger');

const app = express();

app.use((req, res, next) => {
  const rid = newRequestId(req.method.toLowerCase());
  runWithRequestId(rid, () => {
    debug('http', `>>> ${req.method} ${req.originalUrl}`, { query: req.query, ip: req.ip });
    res.on('finish', () => debug('http', `<<< ${req.method} ${req.originalUrl} -> ${res.statusCode}`));
    next();
  });
});

const { saveToken, getToken, deleteToken } = require('./utils/tokenStore');
const { getMappingWithFallback, deleteMapping } = require('./utils/idMapStore');
const { recordSync } = require('./utils/syncTracker');
const bitrixService = require('./services/bitrix.service');
const leadService = require('./services/lead.service');
const invoiceService = require('./services/invoice.service');
const lifetimeService = require('./services/lifetime.service');
const { shopifyWebhookVerifier } = require('./utils/webhook.middleware');
const migrationRoutes = require('./routes/migration.routes');
const syncRoutes = require('./routes/sync.routes');

const syncStockAfterDelay = (bitrixProductId, shopifyProductId, qty, productTitle, delayMs = 3000) => {
  debug('stock', `syncStockAfterDelay: scheduled in ${delayMs}ms | Bitrix=${bitrixProductId} Shopify=${shopifyProductId} qty=${qty} "${productTitle}"`);
  setTimeout(async () => {
    debug('stock', `syncStockAfterDelay: FIRING now for Bitrix=${bitrixProductId} Shopify=${shopifyProductId} qty=${qty}`);
    try {
      await bitrixService.syncProductStock(bitrixProductId, shopifyProductId, qty, productTitle);
      debug('stock', `syncStockAfterDelay: completed OK for Bitrix=${bitrixProductId}`);
    } catch (err) {
      console.error(`[Webhook] Delayed stock sync failed (Bitrix: ${bitrixProductId}, Shopify: ${shopifyProductId}):`, err.message);
      debug('stock', `syncStockAfterDelay: FAILED for Bitrix=${bitrixProductId}`, { error: err.message });
    }
  }, delayMs);
};

// Shared webhook plumbing: raw body -> HMAC verification -> handler.
// Handlers receive (payload, store) where store is built from .env credentials.
const webhookHandler = (handler) => [
  express.raw({ type: 'application/json' }),
  shopifyWebhookVerifier,
  async (req, res) => {
    const startedAt = Date.now();
    try {
      debug('app', `INBOUND webhook -> ${req.path}`, {
        topic: req.get('x-shopify-topic'),
        shop: req.get('x-shopify-shop-domain'),
        webhookId: req.get('x-shopify-webhook-id'),
        bytes: req.body ? req.body.length : 0
      });
      const payload = JSON.parse(req.body.toString());
      debug('app', `Webhook ${req.path} parsed payload`, { keys: Object.keys(payload || {}) });
      const store = {
        shopDomain: process.env.SHOPIFY_STORE_URL || '',
        accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
        apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10'
      };
      await handler(payload, store);
      debug('app', `OUTBOUND webhook ${req.path} handled OK in ${Date.now() - startedAt}ms`);
      res.status(200).send('OK');
    } catch (err) {
      console.error('[Webhook] Handler failed:', err);
      debug('app', `Webhook ${req.path} handler FAILED after ${Date.now() - startedAt}ms`, { error: err.message });
      res.status(500).send('Sync failed');
    }
  }
];

// ---------------- CUSTOMERS ----------------

app.post('/webhooks/shopify/customers-create', webhookHandler(async (customer, store) => {
  const contactId = await bitrixService.createOrUpdateContact(customer, store);
  if (contactId) recordSync('SHOPIFY_TO_BITRIX', 'contact', contactId);
}));

app.post('/webhooks/shopify/customers-update', webhookHandler(async (customer, store) => {
  const contactId = await bitrixService.createOrUpdateContact(customer, store);
  if (contactId) recordSync('SHOPIFY_TO_BITRIX', 'contact', contactId);
}));

app.post('/webhooks/shopify/customers-delete', webhookHandler(async ({ id }) => {
  debug('app', `customers-delete: resolving Bitrix contact for Shopify customer ${id}`);
  const bitrixId = await getMappingWithFallback('contacts', id);
  if (bitrixId) {
    debug('app', `customers-delete: mapped to Bitrix contact ${bitrixId} — deleting`);
    await bitrixService.deleteContactById(bitrixId);
    await deleteMapping('contacts', id);
    debug('app', `customers-delete: deleted Bitrix contact ${bitrixId} + removed mapping`);
  } else {
    debug('app', `customers-delete: NO mapping found for Shopify customer ${id} — nothing to delete`);
  }
}));

// ---------------- PRODUCTS ----------------

const handleProductWebhook = async (product, store) => {
  debug('app', `products webhook: syncing product ${product.id} "${product.title}"`);
  const bitrixProductId = await bitrixService.createOrUpdateProduct(
    product, store.shopDomain, store.accessToken, store.apiVersion
  );
  if (bitrixProductId) {
    recordSync('SHOPIFY_TO_BITRIX', 'product', bitrixProductId);
    const variant = (product.variants && product.variants[0]) || {};
    const qty = variant.inventory_quantity !== undefined ? Math.max(variant.inventory_quantity, 0) : 0;
    debug('app', `products webhook: product ${product.id} -> Bitrix ${bitrixProductId}; queueing stock sync in 3s with qty=${qty}`);
    syncStockAfterDelay(bitrixProductId, product.id, qty, product.title);
  } else {
    debug('app', `products webhook: product ${product.id} returned no Bitrix ID — stock sync skipped`);
  }
};

app.post('/webhooks/shopify/products-create', webhookHandler(handleProductWebhook));
app.post('/webhooks/shopify/products-update', webhookHandler(handleProductWebhook));

app.post('/webhooks/shopify/products-delete', webhookHandler(async ({ id }) => {
  debug('app', `products-delete: resolving Bitrix product for Shopify product ${id}`);
  const bitrixId = await getMappingWithFallback('products', id);
  if (bitrixId) {
    debug('app', `products-delete: mapped to Bitrix product ${bitrixId} — deleting`);
    await bitrixService.deleteProductById(bitrixId);
    await deleteMapping('products', id);
    debug('app', `products-delete: deleted Bitrix product ${bitrixId} + removed mapping`);
  } else {
    debug('app', `products-delete: NO mapping found for Shopify product ${id} — nothing to delete`);
  }
}));

// ---------------- ORDERS ----------------

const handleOrderWebhook = async (order, store) => {
  debug('app', `orders webhook: syncing order ${order.id} (#${order.order_number || order.name})`);
  const dealId = await bitrixService.createOrUpdateDeal(order, store);

  if (dealId) {
    recordSync('SHOPIFY_TO_BITRIX', 'deal', dealId);
    debug('app', `orders webhook: deal ${dealId} ready — syncing invoice`);
    await invoiceService.syncInvoice(order, dealId, store);

    const customerId = order.customer && order.customer.id;
    if (customerId) {
      debug('app', `orders webhook: refreshing lifetime metrics for customer ${customerId}`);
      await lifetimeService.refreshContactLifetime(customerId, store);
    }
  } else {
    debug('app', `orders webhook: order ${order.id} produced no deal — invoice/lifetime skipped`);
  }
};

app.post('/webhooks/shopify/orders-create', webhookHandler(handleOrderWebhook));
app.post('/webhooks/shopify/orders-updated', webhookHandler(handleOrderWebhook));

app.post('/webhooks/shopify/orders-delete', webhookHandler(async ({ id }) => {
  debug('app', `orders-delete: resolving Bitrix deal for Shopify order ${id}`);
  const bitrixId = await getMappingWithFallback('deals', id);
  if (bitrixId) {
    debug('app', `orders-delete: mapped to Bitrix deal ${bitrixId} — deleting`);
    await bitrixService.deleteDealById(bitrixId);
    await deleteMapping('deals', id);
    debug('app', `orders-delete: deleted Bitrix deal ${bitrixId} + removed mapping`);
  } else {
    debug('app', `orders-delete: NO mapping found for Shopify order ${id} — nothing to delete`);
  }
}));

// ---------------- ABANDONED CART / CHECKOUT ----------------

app.post('/webhooks/shopify/carts-update', webhookHandler(async (cart, store) => {
  debug('app', `carts-update: cart ${cart.id}, abandoned=${Boolean(cart.abandoned_checkout_url)}, total=${cart.total_price}`);
  await leadService.syncLeadFromCart(cart, store);
}));

app.post('/webhooks/shopify/checkouts-create', webhookHandler(async (checkout, store) => {
  debug('app', `checkouts-create: checkout ${checkout.id}, total=${checkout.total_price}`);
  await leadService.syncLeadFromCheckout(checkout, store);
}));

app.post('/webhooks/shopify/refunds-create', webhookHandler(async (refund) => {
  debug('app', `refunds-create: refund for order ${refund.order && refund.order.id}, amount=${refund.total_refund}`);
  await bitrixService.applyRefund(refund);
}));

// ---------------- APP LIFECYCLE ----------------

app.post('/webhooks/shopify/app-uninstalled', webhookHandler(async (payload, ctx) => {
  const shop = payload.shop || ctx.shopDomain;
  debug('app', `app-uninstalled: shop=${shop}`);
  if (shop) {
    await deleteToken(shop);
    console.log(`[App] Uninstalled — removed token for ${shop}`);
  }
}));

// Global JSON parsing — applies to all routes BELOW this line
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

debug('app', 'Mounting routes: /migration (bulk import) + /sync, /webhooks/bitrix, /bitrix (Bitrix->Shopify two-way)');
app.use('/migration', migrationRoutes);
app.use('/sync', syncRoutes);
app.use('/webhooks/bitrix', syncRoutes);
app.use('/bitrix', syncRoutes);

app.get('/', (req, res) => {
  const shop = req.query.shop;
  if (shop) {
    return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }
  res.send('OK Server is running');
});

app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  debug('app', `OAuth /auth: requested for shop=${shop}`);
  if (!shop) return res.status(400).send('Missing shop parameter');

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/auth/callback`;
  debug('app', `OAuth /auth: redirect_uri=${redirectUri}, state generated`);

  const installUrl = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_API_KEY}` +
    `&scope=${process.env.SHOPIFY_SCOPES}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  debug('app', `OAuth /auth: redirecting browser to Shopify install URL`);
  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  debug('app', `OAuth callback: shop=${shop}, code present=${Boolean(code)}`);
  if (!shop || !code) return res.status(400).send('Missing shop or code');

  try {
    debug('app', `OAuth callback: exchanging temporary code for access token...`);
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code
      })
    });

    const data = await response.json();

    if (!data.access_token) {
      console.error('Token exchange failed:', data);
      debug('app', 'OAuth callback: token exchange FAILED — no access_token in response', { keys: Object.keys(data || {}) });
      return res.status(400).send('Failed to get access token');
    }

    await saveToken(shop, data.access_token);
    console.log(`Access token saved for ${shop}`);
    debug('app', `OAuth callback: SUCCESS — token saved for shop=${shop}`);

    res.send('App installed successfully! You can close this tab.');
  } catch (err) {
    console.error('OAuth callback error:', err);
    debug('app', 'OAuth callback FAILED', { error: err.message });
    res.status(500).send('Something went wrong during installation');
  }
});

app.get('/test', async (req, res) => {
  const shop = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN || (shop ? await getToken(shop) : '');
  debug('app', `/test: shop=${shop}, token present=${Boolean(token)}`);
  if (!token) return res.status(404).send('No token found yet');

  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
  debug('app', `/test: fetching first 5 customers from Shopify`);
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/customers.json?limit=5`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const data = await response.json();
  debug('app', `/test: Shopify responded`, { customerCount: (data.customers || []).length });
  res.json(data);
});

app.use((req, res) => {
  debug('http', `404 — no route matched ${req.method} ${req.path}`);
  res.status(404).send('Not found');
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
  debug('app', `Server started on port ${process.env.PORT || 3000}`, {
    debugLogging: true,
    shopDomain: process.env.SHOPIFY_STORE_URL || '(not configured)',
    bitrixConfigured: Boolean(process.env.BITRIX_WEBHOOK_URL),
    invoiceSync: process.env.BITRIX_INVOICE_SYNC_ENABLED === 'true',
    lifetimeMetrics: process.env.COMPUTE_LIFETIME === 'true'
  });
});
