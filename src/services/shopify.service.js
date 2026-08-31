const axios = require('axios');
const config = require('../config/shopify.config');
const { debug, logShopifyRequest, logShopifyResponse } = require('../utils/debugLogger');

/**
 * Shopify Service
 * Purpose: Provides helper functions to interact with the Shopify Admin REST API.
 */

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
 * Checks for existing webhook subscriptions and registers them on Shopify if missing.
 */
const registerWebhooks = async () => {
  const { shopifyStoreUrl, shopifyAccessToken, shopifyApiVersion, baseWebhookUrl } = config;

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
    const response = await axios.get(
      `https://${shopifyStoreUrl}/admin/api/${shopifyApiVersion}/webhooks.json`,
      { headers: getAuthHeaders(shopifyAccessToken) }
    );

    const existingWebhooks = response.data.webhooks || [];
    const targetWebhooks = [
      { topic: 'customers/create', address: `${baseWebhookUrl}/webhook/customer` },
      { topic: 'products/create', address: `${baseWebhookUrl}/webhook/product` },
      { topic: 'orders/create', address: `${baseWebhookUrl}/webhook/order` }
    ];

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
            { webhook: { topic: target.topic, address: target.address, format: 'json' } },
            { headers: getAuthHeaders(shopifyAccessToken) }
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

/**
 * Normalize phone number to E.164 format for Shopify.
 */
const formatE164Phone = (phone, defaultCountry = 'IN') => {
  if (!phone) return '';
  let cleaned = String(phone).trim().replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
  if (cleaned.startsWith('+')) return cleaned;
  if (/^\d{10}$/.test(cleaned) && defaultCountry === 'IN') {
    return '+91' + cleaned;
  }
  if (/^0\d{10}$/.test(cleaned) && defaultCountry === 'IN') {
    return '+91' + cleaned.slice(1);
  }
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
};

/**
 * Safely format and merge tags into a comma-separated string.
 */
const extractTags = (tagField, ufTagField) => {
  const tags = [];
  if (Array.isArray(tagField)) {
    tags.push(...tagField.filter(Boolean).map(String));
  } else if (typeof tagField === 'string' && tagField.trim()) {
    tags.push(...tagField.split(',').map(t => t.trim()).filter(Boolean));
  }
  if (typeof ufTagField === 'string' && ufTagField.trim()) {
    tags.push(...ufTagField.split(',').map(t => t.trim()).filter(Boolean));
  }
  return [...new Set(tags)].join(', ');
};

/**
 * Push updated contact fields back to Shopify (Bitrix -> Shopify two-way sync).
 */
const updateShopifyCustomer = async (shopifyId, fields, shopDomain, accessToken, syncId = '') => {
  const setValue = (obj, key, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') obj[key] = value;
  };
  const customer = {};
  setValue(customer, 'first_name', fields.first_name || fields.NAME);
  setValue(customer, 'last_name', fields.last_name || fields.LAST_NAME);
  setValue(customer, 'email', fields.email);
  if (fields.phone) {
    const formattedPhone = formatE164Phone(fields.phone);
    if (formattedPhone) customer.phone = formattedPhone;
  }
  setValue(customer, 'tags', fields.tags);
  setValue(customer, 'note', fields.note);

  if (fields.addresses && Array.isArray(fields.addresses) && fields.addresses.length > 0) {
    customer.addresses = fields.addresses.map(a => ({
      ...a,
      phone: a.phone ? formatE164Phone(a.phone) : undefined
    }));
  }

  if (fields.email_marketing_consent) {
    customer.email_marketing_consent = typeof fields.email_marketing_consent === 'object'
      ? fields.email_marketing_consent
      : { state: 'subscribed', opt_in_level: 'single_opt_in', consent_updated_at: new Date().toISOString() };
  }
  if (fields.sms_marketing_consent) {
    customer.sms_marketing_consent = typeof fields.sms_marketing_consent === 'object'
      ? fields.sms_marketing_consent
      : { state: 'subscribed', opt_in_level: 'single_opt_in', consent_updated_at: new Date().toISOString(), consent_collected_from: 'OTHER' };
  }

  if (fields.metafields && Array.isArray(fields.metafields) && fields.metafields.length > 0) {
    customer.metafields = fields.metafields;
  }

  if (Object.keys(customer).length === 0) {
    debug('shopify', `updateShopifyCustomer: nothing to send for customer ${shopifyId} — skipping`);
    return null;
  }

  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/${shopifyId}.json`;
  logShopifyRequest({
    syncId,
    entity: 'customer',
    entityId: shopifyId,
    operation: 'UPDATE',
    endpoint,
    method: 'PUT',
    payload: { customer }
  });

  const startTime = Date.now();
  try {
    const response = await axios.put(endpoint, { customer }, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'customer',
      entityId: shopifyId,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return response.data.customer;
  } catch (err) {
    // If Shopify rejected the phone format, retry without phone
    if (customer.phone && err.response?.data?.errors?.phone) {
      debug('shopify', `updateShopifyCustomer: phone rejected by Shopify for customer ${shopifyId} — retrying without phone`);
      const fallbackCustomer = { ...customer };
      delete fallbackCustomer.phone;
      delete fallbackCustomer.sms_marketing_consent;
      if (fallbackCustomer.addresses && fallbackCustomer.addresses[0]) {
        fallbackCustomer.addresses = fallbackCustomer.addresses.map(a => {
          const c = { ...a };
          delete c.phone;
          return c;
        });
      }
      try {
        const retryRes = await axios.put(endpoint, { customer: fallbackCustomer }, { headers: getAuthHeaders(accessToken) });
        const duration = Date.now() - startTime;
        logShopifyResponse({
          syncId,
          entity: 'customer',
          entityId: shopifyId,
          statusCode: retryRes.status,
          status: 'SUCCESS',
          response: retryRes.data,
          duration
        });
        return retryRes.data.customer;
      } catch (retryErr) {
        // Continue to throw standard error below
      }
    }

    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'customer',
      entityId: shopifyId,
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody
    });
  }
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
    url = getNextPageUrl(response.headers.link);
    pages++;
  }
  return orders;
};

/**
 * Update a Shopify customer from Bitrix contact object.
 */
const updateCustomerByFields = async (shopifyId, contact, shopDomain, accessToken, syncId = '') => {
  const email = extractFirstValue(contact.EMAIL);
  const phone = extractFirstValue(contact.PHONE);
  const tags = extractTags(contact.TAG, contact.UF_CRM_CUSTOMER_TAGS);
  
  const addresses = [];
  if (contact.ADDRESS || contact.ADDRESS_CITY || contact.ADDRESS_PROVINCE || contact.ADDRESS_COUNTRY) {
    addresses.push({
      address1: contact.ADDRESS || '',
      city: contact.ADDRESS_CITY || '',
      province: contact.ADDRESS_PROVINCE || '',
      country: contact.ADDRESS_COUNTRY || '',
      zip: contact.ADDRESS_POSTAL_CODE || '',
      company: contact.COMPANY_TITLE || '',
      first_name: contact.NAME || '',
      last_name: contact.LAST_NAME || '',
      phone: phone ? formatE164Phone(phone) : ''
    });
  }

  return updateShopifyCustomer(shopifyId, {
    first_name: contact.NAME,
    last_name: contact.LAST_NAME,
    email,
    phone,
    tags,
    note: contact.UF_CRM_CUSTOMER_NOTE || '',
    addresses: addresses.length > 0 ? addresses : undefined
  }, shopDomain, accessToken, syncId);
};

/**
 * Push updated order fields from Bitrix deal back to Shopify.
 */
const updateShopifyOrder = async (shopifyOrderId, fields, shopDomain, accessToken, syncId = '') => {
  const order = {};
  if (fields.note !== undefined) order.note = fields.note || '';
  if (fields.tags !== undefined) order.tags = fields.tags || '';
  if (fields.financial_status !== undefined) order.financial_status = fields.financial_status;
  if (fields.fulfillment_status !== undefined) order.fulfillment_status = fields.fulfillment_status;

  if (Object.keys(order).length === 0) {
    debug('shopify', `updateShopifyOrder: nothing to send for order ${shopifyOrderId}`);
    return null;
  }

  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/orders/${shopifyOrderId}.json`;
  logShopifyRequest({
    syncId,
    entity: 'order',
    entityId: shopifyOrderId,
    operation: 'UPDATE',
    endpoint,
    method: 'PUT',
    payload: { order }
  });

  const startTime = Date.now();
  try {
    const response = await axios.put(endpoint, { order }, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: shopifyOrderId,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return response.data.order;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: shopifyOrderId,
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody
    });
  }
};

/**
 * Helper to prepare Shopify images (supports direct public CDN URLs and base64 attachments for portal URLs).
 */
const prepareShopifyImages = async (images) => {
  if (!images) return [];
  const list = Array.isArray(images) ? images : [images];
  const out = [];
  for (const img of list) {
    if (!img) continue;
    if (typeof img === 'object' && (img.attachment || (img.src && !img.detailUrl))) {
      out.push(img);
      continue;
    }
    const rawUrl = typeof img === 'string' ? img : (img.detailUrl || img.downloadUrl || img.showUrl || img.src);
    if (!rawUrl) continue;

    if (rawUrl.startsWith('https://cdn.bitrix24.') || rawUrl.startsWith('https://cdn.shopify.com/')) {
      out.push({ src: rawUrl });
    } else {
      try {
        const res = await axios.get(rawUrl, { responseType: 'arraybuffer', timeout: 25000 });
        const base64 = Buffer.from(res.data, 'binary').toString('base64');
        const filename = rawUrl.split('/').pop().split('?')[0] || 'product_image.jpg';
        out.push({ attachment: base64, filename });
      } catch (e) {
        out.push({ src: rawUrl });
      }
    }
  }
  return out;
};

/**
 * Upload an image directly to a Shopify product's media gallery.
 */
const uploadShopifyProductImage = async (shopifyProductId, imageObj, shopDomain, accessToken) => {
  try {
    const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/products/${shopifyProductId}/images.json`;
    const res = await axios.post(endpoint, { image: imageObj }, { headers: getAuthHeaders(accessToken) });
    return res.data?.image;
  } catch (err) {
    debug('shopify', `uploadShopifyProductImage: direct upload failed for product ${shopifyProductId} (${err.message})`);
    return null;
  }
};

/**
 * Push updated product fields from Bitrix product back to Shopify.
 */
const updateShopifyProduct = async (shopifyProductId, fields, shopDomain, accessToken, syncId = '') => {
  const product = {};
  if (fields.title !== undefined) product.title = fields.title;
  if (fields.body_html !== undefined) product.body_html = fields.body_html || '';
  if (fields.vendor !== undefined) product.vendor = fields.VENDOR || fields.vendor;
  if (fields.product_type !== undefined) product.product_type = fields.product_type;
  if (fields.tags !== undefined) product.tags = fields.tags || '';
  if (fields.status !== undefined) product.status = fields.status;
  if (fields.images && Array.isArray(fields.images) && fields.images.length > 0) {
    product.images = await prepareShopifyImages(fields.images);
  }

  if (fields.variants && fields.variants.length > 0) {
    let variants = fields.variants;
    if (variants.some((v) => !v.id)) {
      try {
        const current = await axios.get(
          `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/products/${shopifyProductId}.json`,
          { headers: getAuthHeaders(accessToken) }
        );
        const existing = current.data?.product?.variants || [];
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
      if (v.barcode !== undefined) variant.barcode = v.barcode;
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

  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/products/${shopifyProductId}.json`;
  logShopifyRequest({
    syncId,
    entity: 'product',
    entityId: shopifyProductId,
    operation: 'UPDATE',
    endpoint,
    method: 'PUT',
    payload: { product }
  });

  const startTime = Date.now();
  try {
    const response = await axios.put(endpoint, { product }, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'product',
      entityId: shopifyProductId,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });

    let updatedProduct = response.data.product;
    if ((!updatedProduct?.images || updatedProduct.images.length === 0) && product.images?.length > 0) {
      debug('shopify', `updateShopifyProduct: images array empty in response — performing direct image uploads...`);
      for (const img of product.images) {
        const uploadedImg = await uploadShopifyProductImage(shopifyProductId, img, shopDomain, accessToken);
        if (uploadedImg) {
          if (!updatedProduct.images) updatedProduct.images = [];
          updatedProduct.images.push(uploadedImg);
        }
      }
    }
    return updatedProduct;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'product',
      entityId: shopifyProductId,
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody
    });
  }
};

/**
 * Update Shopify inventory level for a product variant.
 */
const updateShopifyInventory = async (inventoryItemId, locationId, quantity, shopDomain, accessToken, syncId = '') => {
  if (!inventoryItemId || !locationId) {
    debug('shopify', `updateShopifyInventory: SKIPPED — missing inventory item or location ID`);
    return null;
  }

  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/inventory_levels/set.json`;
  const payload = {
    location_id: locationId,
    inventory_item_id: inventoryItemId,
    available: quantity
  };

  logShopifyRequest({
    syncId,
    entity: 'inventory',
    entityId: inventoryItemId,
    operation: 'SET_LEVEL',
    endpoint,
    method: 'POST',
    payload
  });

  const startTime = Date.now();
  try {
    const response = await axios.post(endpoint, payload, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'inventory',
      entityId: inventoryItemId,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return response.data.inventory_level;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'inventory',
      entityId: inventoryItemId,
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody
    });
  }
};

/**
 * Find a Shopify customer by email.
 */
const findShopifyCustomerByEmail = async (email, shopDomain, accessToken) => {
  if (!email) return null;
  try {
    const response = await axios.get(
      `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/search.json?query=email:${encodeURIComponent(email)}`,
      { headers: getAuthHeaders(accessToken) }
    );
    const customers = response.data.customers || [];
    return customers.length > 0 ? customers[0] : null;
  } catch (err) {
    console.error('[Shopify] Failed to search customer by email:', err.message);
    return null;
  }
};

/**
 * Find a Shopify customer by phone number.
 */
const findShopifyCustomerByPhone = async (phone, shopDomain, accessToken) => {
  if (!phone) return null;
  try {
    const response = await axios.get(
      `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/search.json?query=${encodeURIComponent(`phone:${phone}`)}`,
      { headers: getAuthHeaders(accessToken) }
    );
    const customers = response.data.customers || [];
    return customers.length > 0 ? customers[0] : null;
  } catch (err) {
    console.error('[Shopify] Failed to search customer by phone:', err.message);
    return null;
  }
};

const extractFirstValue = (val) => {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val) && val.length > 0) {
    const item = val[0];
    return typeof item === 'string' ? item.trim() : (item?.VALUE || item?.value || '').trim();
  }
  if (typeof val === 'object') {
    return (val.VALUE || val.value || '').trim();
  }
  return String(val).trim();
};

/**
 * Create a new Shopify customer from a Bitrix contact (used by two-way sync).
 */
const createShopifyCustomer = async (contact, shopDomain, accessToken, syncId = '') => {
  const email = extractFirstValue(contact.EMAIL);
  const phone = extractFirstValue(contact.PHONE);
  const firstName = contact.NAME || '';
  const lastName = contact.LAST_NAME || '';
  const tags = extractTags(contact.TAG, contact.UF_CRM_CUSTOMER_TAGS);
  const note = contact.UF_CRM_CUSTOMER_NOTE || '';

  // Require at least a name, email, phone, company, or note to create a customer
  if (!firstName && !lastName && !email && !phone && !contact.COMPANY_TITLE && !note) {
    debug('shopify', 'createShopifyCustomer: contact has no identifying information — cannot create in Shopify');
    return null;
  }

  const customer = {};
  if (firstName) customer.first_name = firstName;
  if (lastName) customer.last_name = lastName;
  if (email) {
    customer.email = email;
    customer.verified_email = true;
  }
  if (phone) {
    const formattedPhone = formatE164Phone(phone);
    if (formattedPhone) customer.phone = formattedPhone;
  }
  if (tags) customer.tags = tags;
  if (note) customer.note = note;

  if (contact.email_marketing_consent || contact.MARKETING_SUBSCRIPTION === 'Y' || contact.MARKETING_SUBSCRIPTION === true) {
    customer.email_marketing_consent = typeof contact.email_marketing_consent === 'object'
      ? contact.email_marketing_consent
      : { state: 'subscribed', opt_in_level: 'single_opt_in', consent_updated_at: new Date().toISOString() };
  }
  if (contact.sms_marketing_consent) {
    customer.sms_marketing_consent = typeof contact.sms_marketing_consent === 'object'
      ? contact.sms_marketing_consent
      : { state: 'subscribed', opt_in_level: 'single_opt_in', consent_updated_at: new Date().toISOString(), consent_collected_from: 'OTHER' };
  }

  if (contact.metafields && Array.isArray(contact.metafields) && contact.metafields.length > 0) {
    customer.metafields = contact.metafields;
  }

  if (contact.ADDRESS || contact.ADDRESS_CITY || contact.ADDRESS_PROVINCE || contact.ADDRESS_COUNTRY) {
    customer.addresses = [{
      address1: contact.ADDRESS || '',
      city: contact.ADDRESS_CITY || '',
      province: contact.ADDRESS_PROVINCE || '',
      country: contact.ADDRESS_COUNTRY || '',
      zip: contact.ADDRESS_POSTAL_CODE || '',
      company: contact.COMPANY_TITLE || '',
      first_name: firstName,
      last_name: lastName,
      phone: phone ? formatE164Phone(phone) : undefined
    }];
  }

  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers.json`;
  logShopifyRequest({
    syncId,
    entity: 'customer',
    entityId: contact.ID || 'NEW',
    operation: 'CREATE',
    endpoint,
    method: 'POST',
    payload: { customer }
  });

  const startTime = Date.now();
  try {
    const response = await axios.post(endpoint, { customer }, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'customer',
      entityId: response.data.customer?.id,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return response.data.customer;
  } catch (err) {
    // If Shopify rejected the phone format, retry without phone (saving phone into note)
    if (customer.phone && err.response?.data?.errors?.phone) {
      debug('shopify', 'createShopifyCustomer: phone rejected by Shopify — retrying with note fallback');
      const fallbackCustomer = { ...customer };
      const failedPhone = fallbackCustomer.phone;
      delete fallbackCustomer.phone;
      delete fallbackCustomer.sms_marketing_consent;
      fallbackCustomer.note = fallbackCustomer.note
        ? `${fallbackCustomer.note} | Phone: ${failedPhone}`
        : `Phone: ${failedPhone}`;
      if (fallbackCustomer.addresses && fallbackCustomer.addresses[0]) {
        fallbackCustomer.addresses = fallbackCustomer.addresses.map(a => {
          const c = { ...a };
          delete c.phone;
          return c;
        });
      }
      try {
        const retryResponse = await axios.post(endpoint, { customer: fallbackCustomer }, { headers: getAuthHeaders(accessToken) });
        const duration = Date.now() - startTime;
        logShopifyResponse({
          syncId,
          entity: 'customer',
          entityId: retryResponse.data.customer?.id,
          statusCode: retryResponse.status,
          status: 'SUCCESS',
          response: retryResponse.data,
          duration
        });
        return retryResponse.data.customer;
      } catch (retryErr) {
        // Fall through to standard error handling
      }
    }

    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'customer',
      entityId: contact.ID || 'NEW',
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody,
      duplicate: statusCode === 422
    });
  }
};

/**
 * Create a new Shopify product from a Bitrix product (used by two-way sync).
 */
const createShopifyProduct = async (product, shopDomain, accessToken, syncId = '') => {
  const title = product.NAME || 'Untitled Product';
  const price = parseFloat(product.PRICE || 0);

  const payload = {
    product: {
      title: title,
      body_html: product.DESCRIPTION || '',
      vendor: product.VENDOR || '',
      product_type: product.PRODUCT_TYPE || '',
      tags: product.TAGS || '',
      status: (product.ACTIVE === 'Y' || product.ACTIVE === true || product.ACTIVE === undefined) ? 'active' : 'draft',
      variants: [{
        price: price,
        sku: product.CODE || '',
        barcode: product.BARCODE || '',
        inventory_quantity: product.QUANTITY !== undefined ? parseInt(product.QUANTITY, 10) : undefined
      }]
    }
  };

  // Attach images if provided
  const rawImages = product.images || (product.image ? [product.image] : []);
  if (Array.isArray(rawImages) && rawImages.length > 0) {
    payload.product.images = await prepareShopifyImages(rawImages);
  } else if (product.DETAIL_PICTURE || product.PREVIEW_PICTURE) {
    const pic = product.DETAIL_PICTURE || product.PREVIEW_PICTURE;
    payload.product.images = await prepareShopifyImages([pic]);
  }

  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/products.json`;
  logShopifyRequest({
    syncId,
    entity: 'product',
    entityId: product.ID || 'NEW',
    operation: 'CREATE',
    endpoint,
    method: 'POST',
    payload
  });

  const startTime = Date.now();
  try {
    const response = await axios.post(endpoint, payload, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'product',
      entityId: response.data.product?.id,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    let createdProduct = response.data.product;
    if ((!createdProduct?.images || createdProduct.images.length === 0) && payload.product.images?.length > 0) {
      debug('shopify', `createShopifyProduct: images array empty in response — performing direct image uploads...`);
      for (const img of payload.product.images) {
        const uploadedImg = await uploadShopifyProductImage(createdProduct.id, img, shopDomain, accessToken);
        if (uploadedImg) {
          if (!createdProduct.images) createdProduct.images = [];
          createdProduct.images.push(uploadedImg);
        }
      }
    }
    return createdProduct;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'product',
      entityId: product.ID || 'NEW',
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody
    });
  }
};

/**
 * Create a Shopify DRAFT ORDER from a Bitrix deal (used by two-way sync).
 */
const createShopifyDraftOrder = async (
  { lineItems, customerId, note, email, shippingAddress, billingAddress, tags, discount, shippingLine },
  shopDomain,
  accessToken,
  syncId = ''
) => {
  const draftOrder = { line_items: lineItems };
  if (customerId) draftOrder.customer = { id: customerId };
  if (!customerId && email) draftOrder.email = email;
  if (note) draftOrder.note = note;
  if (tags) draftOrder.tags = tags;
  if (shippingAddress) draftOrder.shipping_address = shippingAddress;
  if (billingAddress) draftOrder.billing_address = billingAddress;
  if (shippingLine) draftOrder.shipping_line = shippingLine;
  if (discount) draftOrder.applied_discount = discount;

  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/draft_orders.json`;
  logShopifyRequest({
    syncId,
    entity: 'order',
    entityId: 'NEW_DRAFT',
    operation: 'CREATE',
    endpoint,
    method: 'POST',
    payload: { draft_order: draftOrder }
  });

  const startTime = Date.now();
  try {
    const response = await axios.post(endpoint, { draft_order: draftOrder }, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: response.data.draft_order?.id,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return response.data.draft_order;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: 'NEW_DRAFT',
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody
    });
  }
};

/**
 * Complete a draft order — converts it into a REAL order in the store.
 */
const completeShopifyDraftOrder = async (draftOrderId, shopDomain, accessToken, syncId = '') => {
  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/draft_orders/${draftOrderId}/complete.json`;
  logShopifyRequest({
    syncId,
    entity: 'order',
    entityId: draftOrderId,
    operation: 'COMPLETE_DRAFT',
    endpoint,
    method: 'POST',
    payload: {}
  });

  const startTime = Date.now();
  try {
    const response = await axios.post(endpoint, {}, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: response.data.draft_order?.order_id || draftOrderId,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return response.data.draft_order;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: draftOrderId,
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody
    });
  }
};

/**
 * Delete a customer in Shopify (useful for cleanup and teardown).
 */
const deleteShopifyCustomer = async (shopifyId, shopDomain, accessToken, syncId = '') => {
  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/${shopifyId}.json`;
  logShopifyRequest({
    syncId,
    entity: 'customer',
    entityId: shopifyId,
    operation: 'DELETE',
    endpoint,
    method: 'DELETE',
    payload: {}
  });

  const startTime = Date.now();
  try {
    const response = await axios.delete(endpoint, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'customer',
      entityId: shopifyId,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return true;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'customer',
      entityId: shopifyId,
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    return false;
  }
};

/**
 * Create a REAL Shopify Order directly from a Bitrix deal.
 */
const createShopifyOrder = async (orderPayload, shopDomain, accessToken, syncId = '') => {
  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/orders.json`;
  logShopifyRequest({
    syncId,
    entity: 'order',
    entityId: 'NEW',
    operation: 'CREATE',
    endpoint,
    method: 'POST',
    payload: { order: orderPayload }
  });

  const startTime = Date.now();
  try {
    const response = await axios.post(endpoint, { order: orderPayload }, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: response.data.order?.id,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return response.data.order;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: 'NEW',
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    throw Object.assign(new Error(responseBody ? JSON.stringify(responseBody) : err.message), {
      status: statusCode,
      responseBody
    });
  }
};

/**
 * Delete a product in Shopify (when deleted in Bitrix24).
 */
const deleteShopifyProduct = async (shopifyProductId, shopDomain, accessToken, syncId = '') => {
  const endpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/products/${shopifyProductId}.json`;
  logShopifyRequest({
    syncId,
    entity: 'product',
    entityId: shopifyProductId,
    operation: 'DELETE',
    endpoint,
    method: 'DELETE',
    payload: {}
  });

  const startTime = Date.now();
  try {
    const response = await axios.delete(endpoint, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'product',
      entityId: shopifyProductId,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return true;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'product',
      entityId: shopifyProductId,
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    return false;
  }
};

/**
 * Cancel and delete an order in Shopify (when deleted in Bitrix24).
 */
const deleteShopifyOrder = async (shopifyOrderId, shopDomain, accessToken, syncId = '') => {
  const cancelEndpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/orders/${shopifyOrderId}/cancel.json`;
  const deleteEndpoint = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/orders/${shopifyOrderId}.json`;

  logShopifyRequest({
    syncId,
    entity: 'order',
    entityId: shopifyOrderId,
    operation: 'CANCEL_AND_DELETE',
    endpoint: deleteEndpoint,
    method: 'DELETE',
    payload: {}
  });

  const startTime = Date.now();
  try {
    try {
      await axios.post(cancelEndpoint, {}, { headers: getAuthHeaders(accessToken) });
    } catch (cancelErr) {
      // Ignored if already closed / cancelled
    }
    const response = await axios.delete(deleteEndpoint, { headers: getAuthHeaders(accessToken) });
    const duration = Date.now() - startTime;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: shopifyOrderId,
      statusCode: response.status,
      status: 'SUCCESS',
      response: response.data,
      duration
    });
    return true;
  } catch (err) {
    const duration = Date.now() - startTime;
    const statusCode = err.response?.status || 500;
    const responseBody = err.response?.data;
    logShopifyResponse({
      syncId,
      entity: 'order',
      entityId: shopifyOrderId,
      statusCode,
      status: 'FAILED',
      response: responseBody,
      duration,
      error: err.message
    });
    return false;
  }
};

module.exports = {
  registerWebhooks,
  updateShopifyCustomer,
  updateCustomerByFields,
  deleteShopifyCustomer,
  getCustomerOrders,
  updateShopifyOrder,
  createShopifyOrder,
  deleteShopifyOrder,
  updateShopifyProduct,
  createShopifyProduct,
  deleteShopifyProduct,
  updateShopifyInventory,
  findShopifyCustomerByEmail,
  findShopifyCustomerByPhone,
  createShopifyCustomer,
  createShopifyDraftOrder,
  completeShopifyDraftOrder
};

