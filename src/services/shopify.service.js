const axios = require('axios');
const config = require('../config/shopify.config');
const { debug } = require('../utils/debugLogger');

/**
 * Shopify Service
 * Purpose: Provides helper functions to interact with the Shopify Admin REST API.
 */

/**
 * Checks for existing webhook subscriptions and registers them on Shopify if missing.
 * Subscribes to:
 * 1. customers/create -> /webhook/customer
 * 2. products/create  -> /webhook/product
 * 3. orders/create    -> /webhook/order
 * 
 * @returns {Promise<void>}
 */
const registerWebhooks = async () => {
  const { shopifyStoreUrl, shopifyAccessToken, shopifyApiVersion, baseWebhookUrl } = config;

  // Gracefully handle missing/default config to prevent application startup crashes
  if (!shopifyStoreUrl || shopifyStoreUrl.includes('your-store.myshopify.com')) {
    console.warn('[Shopify Service] SHOPIFY_STORE_URL not configured. Skipping webhook registration.');
    return;
  }
  if (!shopifyAccessToken || shopifyAccessToken.includes('shpat_your_access_token')) {
    console.warn('[Shopify Service] SHOPIFY_ACCESS_TOKEN not configured. Skipping webhook registration.');
    return;
  }
  if (!baseWebhookUrl || baseWebhookUrl.includes('your-ngrok-url')) {
    console.warn('[Shopify Service] BASE_WEBHOOK_URL not configured. Skipping webhook registration.');
    return;
  }

  console.log('[Shopify Service] Checking existing webhooks...');

  try {
    // 1. Fetch existing webhooks from Shopify
    const response = await axios.get(
      `https://${shopifyStoreUrl}/admin/api/${shopifyApiVersion}/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': shopifyAccessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    const existingWebhooks = response.data.webhooks || [];
    
    // 2. Define the target webhooks we want registered
    const targetWebhooks = [
      { topic: 'customers/create', address: `${baseWebhookUrl}/webhook/customer` },
      { topic: 'products/create', address: `${baseWebhookUrl}/webhook/product` },
      { topic: 'orders/create', address: `${baseWebhookUrl}/webhook/order` }
    ];

    // 3. Register webhooks that do not already exist
    for (const target of targetWebhooks) {
      const exists = existingWebhooks.some(
        (wh) => wh.topic === target.topic && wh.address === target.address
      );

      if (exists) {
        console.log(`[Shopify Service] Webhook for "${target.topic}" at "${target.address}" is already registered.`);
      } else {
        console.log(`[Shopify Service] Registering webhook for "${target.topic}" at "${target.address}"...`);
        
        try {
          await axios.post(
            `https://${shopifyStoreUrl}/admin/api/${shopifyApiVersion}/webhooks.json`,
            {
              webhook: {
                topic: target.topic,
                address: target.address,
                format: 'json'
              }
            },
            {
              headers: {
                'X-Shopify-Access-Token': shopifyAccessToken,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log(`[Shopify Service] Successfully registered webhook for topic "${target.topic}".`);
        } catch (postError) {
          const apiError = postError.response && postError.response.data
            ? JSON.stringify(postError.response.data)
            : postError.message;
          console.error(`[Shopify Service] Failed to register webhook for topic "${target.topic}":`, apiError);
        }
      }
    }
  } catch (error) {
    const fetchError = error.response && error.response.data
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error('[Shopify Service] Error fetching existing Shopify webhooks:', fetchError);
  }
};

const getNextPageUrl = (linkHeader) => {
  if (!linkHeader) return null;
  const links = linkHeader.split(',');
  for (const link of links) {
    const parts = link.split(';');
    if (parts.length < 2) continue;
    if (parts[1].trim() === 'rel="next"') {
      const match = parts[0].trim().match(/<([^>]+)>/);
      if (match) return match[1];
    }
  }
  return null;
};

const getAuthHeaders = (accessToken) => ({
  'X-Shopify-Access-Token': accessToken,
  'Content-Type': 'application/json'
});

/**
 * Push updated contact fields back to Shopify (Bitrix -> Shopify two-way sync).
 * Only fields the Shopify customers API accepts are sent.
 */
const updateShopifyCustomer = async (shopifyId, fields, shopDomain, accessToken) => {
  // Only send non-empty values — sending "" would WIPE existing data on the customer.
  const setValue = (obj, key, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') obj[key] = value;
  };
  const customer = {};
  setValue(customer, 'first_name', fields.first_name || fields.NAME);
  setValue(customer, 'last_name', fields.last_name || fields.LAST_NAME);
  setValue(customer, 'email', fields.email);
  setValue(customer, 'phone', fields.phone);
  setValue(customer, 'tags', fields.tags);
  setValue(customer, 'note', fields.note);

  if (Object.keys(customer).length === 0) {
    debug('shopify', `updateShopifyCustomer: nothing to send for customer ${shopifyId} — skipping`);
    return null;
  }

  debug('shopify', `updateShopifyCustomer: PUT customers/${shopifyId}`, { sentFields: Object.keys(customer) });
  const response = await axios.put(
    `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/${shopifyId}.json`,
    { customer },
    { headers: getAuthHeaders(accessToken) }
  );
  debug('shopify', `updateShopifyCustomer: OK — Shopify customer ${response.data.customer?.id} updated`);
  return response.data.customer;
};

/**
 * Fetch all orders for a Shopify customer (paged), for lifetime metric computation.
 */
const getCustomerOrders = async (customerId, shopDomain, accessToken, maxPages = 20) => {
  const orders = [];
  let url = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/${customerId}/orders.json?status=any&limit=250`;
  let pages = 0;

  while (url && pages < maxPages) {
    debug('shopify', `getCustomerOrders: fetching page ${pages + 1} for customer ${customerId}`);
    const response = await axios.get(url, { headers: getAuthHeaders(accessToken) });
    orders.push(...(response.data.orders || []));
    debug('shopify', `getCustomerOrders: page ${pages + 1} returned ${((response.data || {}).orders || []).length} order(s), total so far=${orders.length}`);
    url = getNextPageUrl(response.headers.link);
    pages++;
  }
  debug('shopify', `getCustomerOrders: DONE customer=${customerId} total orders=${orders.length} pages=${pages}`);
  return orders;
};

/**
 * Update a Shopify customer (generic wrapper used by two-way sync).
 */
const updateCustomerByFields = async (shopifyId, contact, shopDomain, accessToken) => {
  debug('shopify', `updateCustomerByFields: preparing push for Shopify customer ${shopifyId} from Bitrix contact "${contact.NAME || ''}"`);
  const email = contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : '';
  const phone = contact.PHONE && contact.PHONE[0] ? contact.PHONE[0].VALUE : '';
  return updateShopifyCustomer(shopifyId, {
    first_name: contact.NAME,
    last_name: contact.LAST_NAME,
    email,
    phone,
    tags: (contact.TAG && contact.TAG.length ? contact.TAG.join(', ') : '') || contact.UF_CRM_CUSTOMER_TAGS || '',
    note: contact.UF_CRM_CUSTOMER_NOTE || ''
  }, shopDomain, accessToken);
};

/**
 * Push updated order fields from Bitrix deal back to Shopify.
 * Shopify Orders API only allows updating: note, tags, financial_status, fulfillment_status.
 */
const updateShopifyOrder = async (shopifyOrderId, fields, shopDomain, accessToken) => {
  debug('shopify', `updateShopifyOrder: PUT orders/${shopifyOrderId}`, { sentFields: fields });
  const order = {};
  if (fields.note !== undefined) order.note = fields.note || '';
  if (fields.tags !== undefined) order.tags = fields.tags || '';
  if (fields.financial_status !== undefined) order.financial_status = fields.financial_status;
  if (fields.fulfillment_status !== undefined) order.fulfillment_status = fields.fulfillment_status;

  if (Object.keys(order).length === 0) {
    debug('shopify', `updateShopifyOrder: nothing to send for order ${shopifyOrderId}`);
    return null;
  }

  const response = await axios.put(
    `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/orders/${shopifyOrderId}.json`,
    { order },
    { headers: getAuthHeaders(accessToken) }
  );
  debug('shopify', `updateShopifyOrder: OK — Shopify order ${response.data.order?.id} updated`);
  return response.data.order;
};

/**
 * Push updated product fields from Bitrix product back to Shopify.
 */
const updateShopifyProduct = async (shopifyProductId, fields, shopDomain, accessToken) => {
  debug('shopify', `updateShopifyProduct: PUT products/${shopifyProductId}`, { sentFields: Object.keys(fields) });
  const product = {};
  if (fields.title !== undefined) product.title = fields.title;
  if (fields.body_html !== undefined) product.body_html = fields.body_html || '';
  if (fields.vendor !== undefined) product.vendor = fields.VENDOR || fields.vendor;
  if (fields.product_type !== undefined) product.product_type = fields.product_type;
  if (fields.tags !== undefined) product.tags = fields.tags || '';
  if (fields.status !== undefined) product.status = fields.status;

  if (fields.variants && fields.variants.length > 0) {
    let variants = fields.variants;
    // Sending variants WITHOUT ids makes Shopify DELETE the existing variants
    // and create fresh ones — destroying SKU/barcode/inventory links.
    if (variants.some((v) => !v.id)) {
      try {
        const current = await axios.get(
          `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/products/${shopifyProductId}.json`,
          { headers: getAuthHeaders(accessToken) }
        );
        const existing = current.data?.product?.variants || [];
        debug('shopify', `updateShopifyProduct: fetched ${existing.length} existing variant(s) to preserve their IDs`);
        variants = variants.map((v, i) => ({ ...(existing[i] ? { id: existing[i].id } : {}), ...v }));
      } catch (err) {
        debug('shopify', `updateShopifyProduct: could not fetch existing variants (${err.message}) — sending without IDs`);
      }
    }
    product.variants = variants.map((v) => {
      const variant = {};
      if (v.id) variant.id = v.id;
      if (v.price !== undefined) variant.price = v.price;
      if (v.sku !== undefined) variant.sku = v.sku;
      if (v.inventory_quantity !== undefined) variant.inventory_quantity = v.inventory_quantity;
      if (v.weight !== undefined) variant.weight = v.weight;
      if (v.compare_at_price !== undefined) variant.compare_at_price = v.compare_at_price;
      return variant;
    });
  }

  if (Object.keys(product).length === 0) {
    debug('shopify', `updateShopifyProduct: nothing to send for product ${shopifyProductId}`);
    return null;
  }

  const response = await axios.put(
    `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/products/${shopifyProductId}.json`,
    { product },
    { headers: getAuthHeaders(accessToken) }
  );
  debug('shopify', `updateShopifyProduct: OK — Shopify product ${response.data.product?.id} updated`);
  return response.data.product;
};

/**
 * Update Shopify inventory level for a product variant.
 * Uses inventory_levels/set.json to set absolute quantity.
 */
const updateShopifyInventory = async (inventoryItemId, locationId, quantity, shopDomain, accessToken) => {
  debug('shopify', `updateShopifyInventory: setting qty=${quantity} (item=${inventoryItemId}, location=${locationId})`);
  if (!inventoryItemId || !locationId) {
    debug('shopify', `updateShopifyInventory: SKIPPED — missing inventory item or location ID`);
    return null;
  }

  const response = await axios.post(
    `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/inventory_levels/set.json`,
    {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: quantity
    },
    { headers: getAuthHeaders(accessToken) }
  );
  debug('shopify', `updateShopifyInventory: OK — inventory level set`);
  return response.data.inventory_level;
};

/**
 * Find a Shopify customer by email (used by two-way sync to link new Bitrix contacts).
 */
const findShopifyCustomerByEmail = async (email, shopDomain, accessToken) => {
  if (!email) {
    debug('shopify', 'findShopifyCustomerByEmail: no email -> null');
    return null;
  }
  try {
    debug('shopify', `findShopifyCustomerByEmail: searching "${email}"`);
    const response = await axios.get(
      `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/search.json?query=email:${encodeURIComponent(email)}`,
      { headers: getAuthHeaders(accessToken) }
    );
    const customers = response.data.customers || [];
    debug('shopify', `findShopifyCustomerByEmail: "${email}" -> ${customers.length > 0 ? `customer ${customers[0].id}` : 'NOT FOUND'}`);
    return customers.length > 0 ? customers[0] : null;
  } catch (err) {
    console.error('[Shopify] Failed to search customer by email:', err.message);
    debug('shopify', `findShopifyCustomerByEmail: FAILED for "${email}"`, { error: err.message });
    return null;
  }
};

/**
 * Create a new Shopify customer from a Bitrix contact (used by two-way sync).
 */
const createShopifyCustomer = async (contact, shopDomain, accessToken) => {
  const email = contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : '';
  if (!email) {
    debug('shopify', 'createShopifyCustomer: contact has no email — cannot create');
    return null;
  }

  const phone = contact.PHONE && contact.PHONE[0] ? contact.PHONE[0].VALUE : '';

  const customer = {
    first_name: contact.NAME || '',
    last_name: contact.LAST_NAME || '',
    email: email,
    phone: phone,
    verified_email: true,
    tags: (contact.TAG && contact.TAG.length ? contact.TAG.join(', ') : '') || contact.UF_CRM_CUSTOMER_TAGS || '',
    note: contact.UF_CRM_CUSTOMER_NOTE || ''
  };

  try {
    debug('shopify', `createShopifyCustomer: POST customers (email=${email})`);
    const response = await axios.post(
      `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers.json`,
      { customer },
      { headers: getAuthHeaders(accessToken) }
    );
    debug('shopify', `createShopifyCustomer: OK — created Shopify customer ${response.data.customer?.id}`);
    return response.data.customer;
  } catch (err) {
    console.error('[Shopify] Failed to create customer:', err.message);
    debug('shopify', `createShopifyCustomer: FAILED`, { email, error: err.message, responseBody: err.response?.data });
    return null;
  }
};

/**
 * Create a new Shopify product from a Bitrix product (used by two-way sync).
 */
const createShopifyProduct = async (product, shopDomain, accessToken) => {
  const title = product.NAME || 'Untitled Product';
  const price = parseFloat(product.PRICE || 0);
  debug('shopify', `createShopifyProduct: POST products title="${title}" price=${price}`);

  const payload = {
    product: {
      title: title,
      body_html: product.DESCRIPTION || '',
      vendor: product.VENDOR || '',
      status: product.ACTIVE === 'Y' ? 'active' : 'draft',
      variants: [{ price: price, sku: product.CODE || '' }]
    }
  };

  try {
    const response = await axios.post(
      `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/products.json`,
      payload,
      { headers: getAuthHeaders(accessToken) }
    );
    console.log(`[Shopify] Created product "${title}" -> ID ${response.data.product?.id}`);
    return response.data.product;
  } catch (err) {
    console.error(`[Shopify] Failed to create product "${title}":`, err.message);
    debug('shopify', `createShopifyProduct: FAILED for "${title}"`, { error: err.message, responseBody: err.response?.data });
    return null;
  }
};

/**
 * Create a Shopify DRAFT ORDER from a Bitrix deal (used by two-way sync).
 * Draft orders are the supported way to push CRM-created orders into Shopify —
 * the merchant reviews them in Shopify admin and marks them as paid, or the
 * auto-complete flag turns them into real orders immediately.
 */
const createShopifyDraftOrder = async ({ lineItems, customerId, note, email }, shopDomain, accessToken) => {
  const draftOrder = { line_items: lineItems };
  if (customerId) draftOrder.customer = { id: customerId };
  if (!customerId && email) draftOrder.email = email;
  if (note) draftOrder.note = note;

  try {
    debug('shopify', `createShopifyDraftOrder: POST draft_orders (${lineItems.length} line item(s), customer=${customerId || 'none'})`, {
      lineItems: lineItems.map((li) => `${li.quantity}x ${li.title} @ ${li.price}`)
    });
    const response = await axios.post(
      `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/draft_orders.json`,
      { draft_order: draftOrder },
      { headers: getAuthHeaders(accessToken) }
    );
    debug('shopify', `createShopifyDraftOrder: OK — draft order ${response.data.draft_order?.id} created`);
    return response.data.draft_order;
  } catch (err) {
    console.error('[Shopify] Failed to create draft order:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    debug('shopify', `createShopifyDraftOrder: FAILED`, { error: err.message, responseBody: err.response?.data });
    return null;
  }
};

/**
 * Complete a draft order — converts it into a REAL order in the store.
 * Returns the draft_order payload which contains order_id of the new order.
 */
const completeShopifyDraftOrder = async (draftOrderId, shopDomain, accessToken) => {
  try {
    debug('shopify', `completeShopifyDraftOrder: POST draft_orders/${draftOrderId}/complete`);
    const response = await axios.post(
      `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/draft_orders/${draftOrderId}/complete.json`,
      {},
      { headers: getAuthHeaders(accessToken) }
    );
    debug('shopify', `completeShopifyDraftOrder: OK — draft ${draftOrderId} -> order ${response.data.draft_order?.order_id}`);
    return response.data.draft_order;
  } catch (err) {
    console.error('[Shopify] Failed to complete draft order:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    debug('shopify', `completeShopifyDraftOrder: FAILED for draft ${draftOrderId}`, { error: err.message });
    return null;
  }
};

module.exports = {
  registerWebhooks,
  updateShopifyCustomer,
  updateCustomerByFields,
  getCustomerOrders,
  updateShopifyOrder,
  updateShopifyProduct,
  updateShopifyInventory,
  findShopifyCustomerByEmail,
  createShopifyCustomer,
  createShopifyProduct,
  createShopifyDraftOrder,
  completeShopifyDraftOrder
};
