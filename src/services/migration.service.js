const axios = require('axios');
const shopifyConfig = require('../config/shopify.config');
const bitrixService = require('./bitrix.service');
const { getTenantConfig } = require('../utils/tenantContext');
const { debug } = require('../utils/debugLogger');

const getNextPageUrl = (linkHeader) => {
  if (!linkHeader) return null;
  const links = linkHeader.split(',');
  for (const link of links) {
    const parts = link.split(';');
    if (parts.length < 2) continue;
    const urlPart = parts[0].trim();
    const relPart = parts[1].trim();
    if (relPart === 'rel="next"') {
      const urlMatch = urlPart.match(/<([^>]+)>/);
      if (urlMatch) return urlMatch[1];
    }
  }
  return null;
};

// Resolve the Shopify store + token for the current tenant (falls back to .env).
const resolveShopify = async () => {
  const tenant = getTenantConfig();
  const shopDomain = tenant.storeDomain || '';
  const shopifyApiVersion = tenant.apiVersion || shopifyConfig.shopifyApiVersion || '2024-10';
  let shopifyAccessToken = tenant.accessToken || '';
  if (!shopifyAccessToken) {
    debug('migration', 'resolveShopify: no token in tenant config — falling back to tokenStore/.env');
    shopifyAccessToken = await shopifyConfig.getShopifyAccessToken();
  }
  debug('migration', `resolveShopify: resolved`, {
    shopDomain,
    apiVersion: shopifyApiVersion,
    tokenPresent: Boolean(shopifyAccessToken)
  });
  return { shopDomain, shopifyAccessToken, shopifyApiVersion };
};

const hasValidCredentials = ({ shopDomain, shopifyAccessToken }) =>
  Boolean(
    shopDomain &&
    !shopDomain.includes('your-store.myshopify.com') &&
    shopifyAccessToken &&
    !shopifyAccessToken.includes('shpat_your_access_token')
  );

const getShopifyCount = async (resource, creds) => {
  const { shopDomain, shopifyAccessToken, shopifyApiVersion } = creds;

  if (!hasValidCredentials(creds)) {
    debug('migration', `getShopifyCount(${resource}): SKIPPED — credentials invalid/placeholder`);
    return 0;
  }

  let url = `https://${shopDomain}/admin/api/${shopifyApiVersion}/${resource}/count.json`;
  if (resource === 'orders') {
    url += '?status=any';
  }

  try {
    const response = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' }
    });
    debug('migration', `getShopifyCount(${resource}) = ${response.data.count || 0}`);
    return response.data.count || 0;
  } catch (error) {
    console.error(`[Migration] Failed to get count for ${resource}:`, error.message);
    return 0;
  }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const migrateCustomers = async () => {
  const creds = await resolveShopify();
  const { shopDomain, shopifyAccessToken, shopifyApiVersion } = creds;

  if (!hasValidCredentials(creds)) {
    return { success: false, error: 'Shopify credentials not configured.' };
  }

  const totalRecords = await getShopifyCount('customers', creds);
  let url = `https://${shopDomain}/admin/api/${shopifyApiVersion}/customers.json?limit=250`;

  let processedCount = 0;
  let importedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;

  console.log(`[Migration] Starting Customer Migration (total: ${totalRecords})...`);

  while (url) {
    try {
      debug('migration', `migrateCustomers: fetching page ${url}`);
      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' }
      });

      const customers = response.data.customers || [];
      debug('migration', `migrateCustomers: page returned ${customers.length} customer(s)`);
      for (const customer of customers) {
        processedCount++;
        console.log(`[Migration] Customer ${processedCount}/${totalRecords || '?'} (Shopify ID: ${customer.id})`);
        debug('migration', 'migrateCustomers: processing customer', {
          shopifyId: customer.id,
          email: customer.email,
          name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          ordersCount: customer.orders_count,
          totalSpent: customer.total_spent
        });

        try {
          // Pass store credentials so lifetime metrics + attribution are computed on import.
          await bitrixService.createOrUpdateContact(customer, {
            shopDomain,
            accessToken: shopifyAccessToken,
            apiVersion: shopifyApiVersion
          });
          importedCount++;
          debug('migration', `migrateCustomers: customer ${customer.id} synced OK (${importedCount} imported so far)`);
        } catch (innerError) {
          console.error(`[Migration] Customer FAILED (Shopify ID: ${customer.id}):`, innerError.message);
          debug('migration', `migrateCustomers: customer ${customer.id} FAILED`, { error: innerError.message });
          failedCount++;
        }
        await delay(500);
      }

      const linkHeader = response.headers['link'] || response.headers['Link'];
      url = getNextPageUrl(linkHeader);
    } catch (outerError) {
      console.error('[Migration] Failed to fetch customers page:', outerError.message);
      break;
    }
  }

  console.log(`[Migration] Customer Migration Done — processed: ${processedCount}, imported: ${importedCount}, failed: ${failedCount}`);
  return { success: true, total: processedCount, imported: importedCount, updated: updatedCount, failed: failedCount };
};

const migrateProducts = async () => {
  const creds = await resolveShopify();
  const { shopDomain, shopifyAccessToken, shopifyApiVersion } = creds;

  if (!hasValidCredentials(creds)) {
    return { success: false, error: 'Shopify credentials not configured.' };
  }

  const totalRecords = await getShopifyCount('products', creds);
  let url = `https://${shopDomain}/admin/api/${shopifyApiVersion}/products.json?limit=250`;

  let processedCount = 0;
  let importedCount = 0;
  let failedCount = 0;

  const productsToSyncStock = [];

  console.log(`[Migration] Starting Product Migration (total: ${totalRecords})...`);

  while (url) {
    try {
      debug('migration', `migrateProducts: fetching page ${url}`);
      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' }
      });

      const products = response.data.products || [];
      debug('migration', `migrateProducts: page returned ${products.length} product(s)`);
      for (const product of products) {
        processedCount++;
        console.log(`[Migration] Product ${processedCount}/${totalRecords || '?'} (Shopify ID: ${product.id}, title: ${product.title})`);
        debug('migration', 'migrateProducts: processing product', {
          shopifyId: product.id,
          title: product.title,
          vendor: product.vendor,
          variants: (product.variants || []).length,
          images: (product.image || product.images) ? 'present' : 'none'
        });

        try {
          const bitrixProductId = await bitrixService.createOrUpdateProduct(
            product, shopDomain, shopifyAccessToken, shopifyApiVersion
          );
          importedCount++;
          debug('migration', `migrateProducts: product "${product.title}" synced OK -> Bitrix=${bitrixProductId} (${importedCount} imported so far)`);

          if (bitrixProductId) {
            const variant = (product.variants && product.variants[0]) || {};
            const qty = variant.inventory_quantity !== undefined ? Math.max(variant.inventory_quantity, 0) : 0;
            debug('migration', `migrateProducts: queueing stock sync for Bitrix=${bitrixProductId} qty=${qty}`);
            productsToSyncStock.push({ shopifyId: product.id, bitrixProductId, qty, title: product.title });
          }
        } catch (innerError) {
          console.error(`[Migration] Product FAILED (Shopify ID: ${product.id}, title: ${product.title}):`, innerError.message);
          debug('migration', `migrateProducts: product "${product.title}" FAILED`, { error: innerError.message });
          failedCount++;
        }
        await delay(500);
      }

      const linkHeader = response.headers['link'] || response.headers['Link'];
      url = getNextPageUrl(linkHeader);
    } catch (outerError) {
      console.error('[Migration] Failed to fetch products page:', outerError.message);
      break;
    }
  }

  console.log(`[Migration] Product creation done. Starting inventory sync for ${productsToSyncStock.length} products...`);

  let stockSynced = 0;
  let stockFailed = 0;

  for (const { shopifyId, bitrixProductId, qty, title } of productsToSyncStock) {
    try {
      debug('migration', `migrateProducts: stock pass — product ${shopifyId} (Bitrix ${bitrixProductId}) targetQty=${qty}, waiting 2.5s...`);
      await delay(2500);
      await bitrixService.syncProductStock(bitrixProductId, shopifyId, qty, title);
      stockSynced++;
    } catch (stockError) {
      console.error(`[Migration] Stock sync FAILED (Bitrix: ${bitrixProductId}, Shopify: ${shopifyId}, "${title}"):`, stockError.message);
      debug('migration', `migrateProducts: stock sync FAILED for product ${shopifyId}`, { error: stockError.message });
      stockFailed++;
    }
  }

  console.log(`[Migration] Product Migration Complete — processed: ${processedCount}, created/updated: ${importedCount}, failed: ${failedCount}, stock synced: ${stockSynced}, stock failed: ${stockFailed}`);

  return {
    success: true,
    total: processedCount,
    imported: importedCount,
    failed: failedCount,
    stockSynced,
    stockFailed
  };
};

const migrateOrders = async () => {
  const creds = await resolveShopify();
  const { shopDomain, shopifyAccessToken, shopifyApiVersion } = creds;

  if (!hasValidCredentials(creds)) {
    return { success: false, error: 'Shopify credentials not configured.' };
  }

  const totalRecords = await getShopifyCount('orders', creds);
  let url = `https://${shopDomain}/admin/api/${shopifyApiVersion}/orders.json?limit=250&status=any`;

  let processedCount = 0;
  let importedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;

  const uniqueCustomerIds = new Set();

  const opts = {
    shopDomain,
    accessToken: shopifyAccessToken,
    apiVersion: shopifyApiVersion
  };

  console.log(`[Migration] Starting Order Migration (total: ${totalRecords})...`);

  while (url) {
    try {
      debug('migration', `migrateOrders: fetching page ${url}`);
      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' }
      });

      const orders = response.data.orders || [];
      debug('migration', `migrateOrders: page returned ${orders.length} order(s)`);
      for (const order of orders) {
        processedCount++;
        const orderNumber = order.order_number || order.name || order.id || 'N/A';
        console.log(`[Migration] Order ${processedCount}/${totalRecords || '?'} (#${orderNumber}, Shopify ID: ${order.id})`);
        debug('migration', 'migrateOrders: processing order', {
          shopifyId: order.id,
          orderNumber,
          financialStatus: order.financial_status,
          fulfillmentStatus: order.fulfillment_status,
          totalPrice: order.total_price,
          customer: order.customer ? { id: order.customer.id, email: order.customer.email } : null,
          lineItems: (order.line_items || []).length
        });

        try {
          const dealId = await bitrixService.createOrUpdateDeal(order, opts);
          importedCount++;
          debug('migration', `migrateOrders: order #${orderNumber} synced OK -> deal ${dealId} (${importedCount} imported so far)`);
          if (order.customer && order.customer.id) uniqueCustomerIds.add(order.customer.id);

          const invoiceService = require('./invoice.service');
          await invoiceService.syncInvoice(order, dealId, opts);
          debug('migration', `migrateOrders: invoice step finished for order #${orderNumber}`);
        } catch (innerError) {
          console.error(`[Migration] Order FAILED (Shopify ID: ${order.id}, #${orderNumber}):`, innerError.message);
          debug('migration', `migrateOrders: order #${orderNumber} FAILED`, { error: innerError.message });
          failedCount++;
        }
        await delay(500);
      }

      const linkHeader = response.headers['link'] || response.headers['Link'];
      url = getNextPageUrl(linkHeader);
    } catch (outerError) {
      console.error('[Migration] Failed to fetch orders page:', outerError.message);
      break;
    }
  }

  console.log(`[Migration] Order Migration Done — processed: ${processedCount}, imported: ${importedCount}, failed: ${failedCount}`);

  // Backfill lifetime metrics once per unique customer (deduped — avoids O(n^2)).
  const lifetimeService = require('./lifetime.service');
  let lifetimeRefreshed = 0;
  let lifetimeFailed = 0;
  for (const customerId of uniqueCustomerIds) {
    debug('migration', `lifetime backfill: refreshing customer ${customerId}`);
    try {
      await lifetimeService.refreshContactLifetime(customerId, opts);
      lifetimeRefreshed++;
      debug('migration', `lifetime backfill: customer ${customerId} refreshed OK (${lifetimeRefreshed} done)`);
    } catch (err) {
      lifetimeFailed++;
      console.error(`[Migration] Lifetime refresh failed for customer ${customerId}:`, err.message);
      debug('migration', `lifetime backfill: customer ${customerId} FAILED`, { error: err.message });
    }
  }
  console.log(`[Migration] Lifetime metrics refreshed for ${lifetimeRefreshed} customers (${lifetimeFailed} failed)`);

  return { success: true, total: processedCount, imported: importedCount, updated: updatedCount, failed: failedCount, lifetimeRefreshed };
};

const migrateAll = async () => {
  const customerStats = await migrateCustomers();
  console.log('---------------------------------');
  const productStats = await migrateProducts();
  console.log('---------------------------------');
  const orderStats = await migrateOrders();
  console.log('---------------------------------');
  console.log('[Migration] All migrations completed');

  return {
    success: true,
    customers: customerStats,
    products: productStats,
    orders: orderStats
  };
};

module.exports = {
  migrateCustomers,
  migrateProducts,
  migrateOrders,
  migrateAll
};
