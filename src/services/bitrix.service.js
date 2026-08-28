const axios = require('axios');
const config = require('../config/bitrix.config');
const { getTenantConfig } = require('../utils/tenantContext');
const { setMapping, getMapping, getMappingWithFallback } = require('../utils/idMapStore');
const { ensureProductPropertyMap } = require('../utils/productProperties');
const { debug } = require('../utils/debugLogger');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const bitrixRequest = async (method, payload, retries = 5) => {
  const url = getMethodUrl(method);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      debug('bitrix', `-> POST ${method} (attempt ${attempt + 1}/${retries + 1})`, { request: payload });
      const response = await axios.post(url, payload);
      debug('bitrix', `<- POST ${method} OK (status ${response.status})`, { response: response.data });
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || status >= 500 || !err.response;
      if (isRetryable && attempt < retries) {
        const delayMs = Math.pow(2, attempt) * 2000;
        console.warn(`Bitrix24 API [${method}] attempt ${attempt + 1} failed (status=${status || 'none'}), retrying in ${delayMs}ms...`);
        debug('bitrix', `POST ${method} attempt ${attempt + 1} RETRYABLE failure`, {
          status,
          message: err.message,
          errorBody: err.response?.data
        });
        await sleep(delayMs);
        continue;
      }
      debug('bitrix', `POST ${method} FAILED permanently`, {
        status,
        message: err.message,
        errorBody: err.response?.data
      });
      throw err;
    }
  }
};

const getImageAsBase64 = async (imageUrl) => {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      debug('bitrix', `getImageAsBase64: downloading image (attempt ${attempt + 1}/3): ${imageUrl}`);
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
      const base64 = Buffer.from(response.data, 'binary').toString('base64');
      const filename = imageUrl.split('/').pop().split('?')[0];
      debug('bitrix', `getImageAsBase64: downloaded "${filename}" (${base64.length} base64 chars)`);
      return { fileData: [filename, base64] };
    } catch (err) {
      if (attempt < 2) {
        debug('bitrix', `getImageAsBase64: download failed, retrying...`, { url: imageUrl, error: err.message });
        await sleep(1000 * (attempt + 1));
        continue;
      }
      console.error('Failed to fetch product image after retries:', imageUrl, err.message);
      debug('bitrix', `getImageAsBase64: FAILED after all retries`, { url: imageUrl, error: err.message });
      return null;
    }
  }
};

const getCollectionNames = async (productId, shopDomain, accessToken, apiVersion) => {
  try {
    debug('shopify', `getCollectionNames: fetching collects for product ${productId}`);
    const collectsRes = await axios.get(
      `https://${shopDomain}/admin/api/${apiVersion}/collects.json?product_id=${productId}`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const collectionIds = (collectsRes.data.collects || []).map(c => c.collection_id);
    debug('shopify', `getCollectionNames: product ${productId} belongs to ${collectionIds.length} collection(s)`, { collectionIds });
    const names = [];
    for (const collId of collectionIds) {
      const collRes = await axios.get(
        `https://${shopDomain}/admin/api/${apiVersion}/collections/${collId}.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      if (collRes.data.collection) names.push(collRes.data.collection.title);
    }
    debug('shopify', `getCollectionNames: resolved names for product ${productId}`, { names });
    return names.join(', ');
  } catch (err) {
    console.error('Failed to fetch collections:', err.message);
    debug('shopify', `getCollectionNames: FAILED for product ${productId}`, { error: err.message });
    return '';
  }
};

const getCostPerItem = async (inventoryItemId, shopDomain, accessToken, apiVersion) => {
  if (!inventoryItemId) return '';
  try {
    debug('shopify', `getCostPerItem: fetching inventory item ${inventoryItemId}`);
    const invRes = await axios.get(
      `https://${shopDomain}/admin/api/${apiVersion}/inventory_items/${inventoryItemId}.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const cost = invRes.data.inventory_item?.cost || '';
    debug('shopify', `getCostPerItem: inventory item ${inventoryItemId} cost=${cost}`);
    return cost;
  } catch (err) {
    console.error('Failed to fetch cost per item:', err.message);
    debug('shopify', `getCostPerItem: FAILED for ${inventoryItemId}`, { error: err.message });
    return '';
  }
};

const getProductCategory = async (graphqlProductId, shopDomain, accessToken, apiVersion) => {
  if (!graphqlProductId) return '';
  try {
    debug('shopify', `getProductCategory: GraphQL query for ${graphqlProductId}`);
    const query = `{ product(id: "${graphqlProductId}") { category { name } } }`;
    const res = await axios.post(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      { query },
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );
    const category = res.data?.data?.product?.category?.name || '';
    debug('shopify', `getProductCategory: ${graphqlProductId} -> "${category}"`);
    return category;
  } catch (err) {
    console.error('Failed to fetch category:', err.message);
    debug('shopify', `getProductCategory: FAILED for ${graphqlProductId}`, { error: err.message });
    return '';
  }
};

const getCategoryMetafields = async (graphqlProductId, shopDomain, accessToken, apiVersion) => {
  if (!graphqlProductId) return '';
  try {
    debug('shopify', `getCategoryMetafields: GraphQL query for ${graphqlProductId}`);
    const query = `{
      product(id: "${graphqlProductId}") {
        metafields(first: 20) {
          edges { node { namespace key value } }
        }
      }
    }`;
    const res = await axios.post(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      { query },
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );
    const edges = res.data?.data?.product?.metafields?.edges || [];
    const joined = edges.map(e => `${e.node.key}: ${e.node.value}`).join(' | ');
    debug('shopify', `getCategoryMetafields: ${graphqlProductId} -> ${edges.length} metafield(s)`);
    return joined;
  } catch (err) {
    console.error('Failed to fetch category metafields:', err.message);
    debug('shopify', `getCategoryMetafields: FAILED for ${graphqlProductId}`, { error: err.message });
    return '';
  }
};

const syncProductStock = async (bitrixProductId, shopifyProductId, shopifyQty, productTitle) => {
  const logPrefix = `[Stock] Bitrix=${bitrixProductId} Shopify=${shopifyProductId} "${productTitle || ''}"`;
  debug('stock', `syncProductStock: START ${logPrefix}`, { shopifyQty });

  const tenant = getTenantConfig();
  const lastSyncedQty = parseInt(await getMappingWithFallback('stock', shopifyProductId), 10) || 0;
  const delta = shopifyQty - lastSyncedQty;

  console.log(`${logPrefix} | ShopifyQty=${shopifyQty} | LastSynced=${lastSyncedQty} | Delta=${delta}`);
  debug('stock', `syncProductStock: lastSyncedQty=${lastSyncedQty}, delta=${delta}`);

  if (delta === 0) {
    console.log(`${logPrefix} | No change, skipping`);
    debug('stock', `syncProductStock: no change — SKIPPED`);
    return;
  }

  const docType = delta > 0 ? 'S' : 'D';
  const amount = Math.abs(delta);
  console.log(`${logPrefix} | docType=${docType} | amount=${amount}`);
  debug('stock', `syncProductStock: will create document docType=${docType} (${delta > 0 ? 'receive' : 'dispose'}) amount=${amount}, warehouse=${tenant.warehouseId}`);

  let docId;
  try {
    const docRes = await bitrixRequest('catalog.document.add', {
      fields: {
        docType,
        responsibleId: tenant.responsibleId,
        currency: tenant.currencyId,
        title: `Shopify Stock Sync - ${productTitle || bitrixProductId} (${delta > 0 ? '+' : ''}${delta})`
      }
    });
    docId = docRes?.result?.document?.id;
    if (!docId) {
      console.error(`${logPrefix} | catalog.document.add returned no docId:`, JSON.stringify(docRes).substring(0, 500));
      debug('stock', `syncProductStock: catalog.document.add returned NO docId`, { response: docRes });
      return;
    }
    console.log(`${logPrefix} | Document created: docId=${docId} status=${docRes?.result?.document?.status}`);
  } catch (e) {
    const errMethod = e.response?.data?.error || e.message;
    console.error(`${logPrefix} | catalog.document.add FAILED: ${errMethod}`);
    throw e;
  }

  try {
    const elementFields = {
      docId: parseInt(docId, 10),
      elementId: parseInt(bitrixProductId, 10),
      amount,
      storeTo: tenant.warehouseId
    };
    const elemRes = await bitrixRequest('catalog.document.element.add', { fields: elementFields });
    const elemId = elemRes?.result?.documentElement?.id;
    console.log(`${logPrefix} | Element added: elemId=${elemId} amount=${amount} storeTo=${tenant.warehouseId}`);
  } catch (e) {
    const errMethod = e.response?.data?.error || e.message;
    console.error(`${logPrefix} | catalog.document.element.add FAILED: ${errMethod}`);
    throw e;
  }

  try {
    const conductRes = await bitrixRequest('catalog.document.conduct', { id: parseInt(docId, 10) });
    if (conductRes?.result === true) {
      console.log(`${logPrefix} | Document conducted successfully: docId=${docId}`);
      await setMapping('stock', shopifyProductId, String(shopifyQty));
      console.log(`${logPrefix} | Stock synced: ${lastSyncedQty} → ${shopifyQty} (delta=${delta})`);
      debug('stock', `syncProductStock: DONE — stock updated ${lastSyncedQty} -> ${shopifyQty}`);
    } else {
      console.error(`${logPrefix} | catalog.document.conduct returned unexpected result:`, JSON.stringify(conductRes));
      debug('stock', `syncProductStock: conduct returned UNEXPECTED result — lastSyncedQty NOT updated`, { response: conductRes });
    }
  } catch (e) {
    const errMethod = e.response?.data?.error || e.message;
    console.error(`${logPrefix} | catalog.document.conduct FAILED: ${errMethod}`);
    debug('stock', `syncProductStock: conduct FAILED — mapping NOT saved (will retry next time)`);
    throw e;
  }
};

const stripHtml = (html) => {
  if (!html) return '';
  return html
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const getMethodUrl = (methodName) => {
  const { bitrixWebhookUrl } = getTenantConfig();
  if (!bitrixWebhookUrl || bitrixWebhookUrl.includes('xxxxxxxxxxxxxxxx')) {
    debug('bitrix', 'getMethodUrl: BITRIX_WEBHOOK_URL not properly configured!');
    throw new Error('BITRIX_WEBHOOK_URL is not properly configured.');
  }
  const baseUrl = bitrixWebhookUrl.endsWith('/') ? bitrixWebhookUrl : `${bitrixWebhookUrl}/`;
  return `${baseUrl}${methodName}`;
};

const findContactByEmail = async (email) => {
  if (!email) {
    debug('bitrix', 'findContactByEmail: no email provided -> null');
    return null;
  }
  const data = await bitrixRequest('crm.contact.list', {
    filter: { "EMAIL": email.trim().toLowerCase() },
    select: ["ID"]
  });
  const contacts = data?.result || [];
  debug('bitrix', `findContactByEmail: "${email}" -> ${contacts.length} match(es)`, { found: contacts[0] || null });
  return contacts.length > 0 ? contacts[0] : null;
};

const findContactByShopifyId = async (shopifyCustomerId) => {
  if (!shopifyCustomerId) {
    debug('bitrix', 'findContactByShopifyId: no Shopify customer ID -> null');
    return null;
  }
  try {
    const data = await bitrixRequest('crm.contact.list', {
      filter: { "UF_CRM_SHOPIFY_ID": String(shopifyCustomerId) },
      select: ["ID"]
    });
    const contacts = data?.result || [];
    debug('bitrix', `findContactByShopifyId: ${shopifyCustomerId} -> ${contacts.length > 0 ? `contact ${contacts[0].ID}` : 'NOT FOUND'}`);
    return contacts.length > 0 ? contacts[0].ID : null;
  } catch (err) {
    // UF field may not exist on the portal yet — fall back to mapping table.
    debug('bitrix', `findContactByShopifyId: UF filter failed (${err.message}) — falling back to id_map`);
    const mapped = await getMappingWithFallback('contacts', shopifyCustomerId);
    debug('bitrix', `findContactByShopifyId: id_map fallback for ${shopifyCustomerId} -> ${mapped || 'null'}`);
    return mapped || null;
  }
};

const getContact = async (contactId) => {
  const data = await bitrixRequest('crm.contact.get', { id: contactId });
  debug('bitrix', `getContact: ${contactId} -> ${data?.result ? `found "${data.result.NAME}"` : 'null'}`);
  return data?.result || null;
};

const updateContact = async (contactId, fields) => {
  debug('bitrix', `updateContact: updating contact ${contactId}`, { fieldKeys: Object.keys(fields) });
  try {
    await bitrixRequest('crm.contact.update', { id: contactId, fields });
    return contactId;
  } catch (err) {
    debug('bitrix', `updateContact: warning when updating contact ${contactId} (${err.message})`);
    if (fields.UF_CRM_SHOPIFY_ID && Object.keys(fields).length === 1) {
      console.warn(`[Bitrix] Warning: could not write UF_CRM_SHOPIFY_ID to contact ${contactId} in Bitrix (field may not exist in CRM settings). ID mapping is still saved in database.`);
      return contactId;
    }
    throw err;
  }
};

const createContact = async (fields, params = {}) => {
  debug('bitrix', 'createContact: creating contact', { fieldKeys: Object.keys(fields) });
  const data = await bitrixRequest('crm.contact.add', { fields, params });
  const id = data?.result;
  debug('bitrix', `createContact: created contact ${id}`);
  return id;
};

const deleteContact = async (contactId) => {
  debug('bitrix', `deleteContact: deleting contact ${contactId}`);
  try {
    const data = await bitrixRequest('crm.contact.delete', { id: contactId });
    return data?.result === true;
  } catch (err) {
    debug('bitrix', `deleteContact: error deleting contact ${contactId} (${err.message})`);
    return false;
  }
};

const getDeal = async (dealId) => {
  const data = await bitrixRequest('crm.deal.get', { id: dealId });
  debug('bitrix', `getDeal: ${dealId} -> ${data?.result ? `found "${data.result.TITLE}"` : 'null'}`);
  return data?.result || null;
};

const getDealProductRows = async (dealId) => {
  const data = await bitrixRequest('crm.deal.productrows.get', { id: dealId });
  const rows = data?.result || [];
  debug('bitrix', `getDealProductRows: deal ${dealId} -> ${rows.length} row(s)`);
  return rows;
};

const getProduct = async (bitrixProductId) => {
  const data = await bitrixRequest('crm.product.get', { id: bitrixProductId });
  debug('bitrix', `getProduct: ${bitrixProductId} -> ${data?.result ? `found "${data.result.NAME}"` : 'null'}`);
  return data?.result || null;
};

const findProductByName = async (name) => {
  const data = await bitrixRequest('crm.product.list', {
    filter: { "NAME": name },
    select: ["ID"]
  });
  const products = data?.result || [];
  debug('bitrix', `findProductByName: "${name}" -> ${products[0] ? products[0].ID : 'NOT FOUND'}`);
  return products.length > 0 ? products[0] : null;
};

const findDealByOrderNumber = async (orderNumber) => {
  const title = `Order #${orderNumber}`;
  const data = await bitrixRequest('crm.deal.list', {
    filter: { "TITLE": title },
    select: ["ID"]
  });
  const deals = data?.result || [];
  debug('bitrix', `findDealByOrderNumber: "${title}" -> ${deals[0] ? deals[0].ID : 'NOT FOUND'}`);
  return deals.length > 0 ? deals[0] : null;
};

const findProductById = async (bitrixProductId) => {
  debug('bitrix', `findProductById: looking up Bitrix product ${bitrixProductId}`);
  const data = await bitrixRequest('crm.product.get', { id: bitrixProductId });
  const product = data?.result;
  if (product && product.ID) {
    console.log(`[findProductById] Found product ID=${product.ID}, name="${product.NAME}"`);
    debug('bitrix', `findProductById: FOUND ID=${product.ID}`, { name: product.NAME, price: product.PRICE });
    return product;
  }
  console.log(`[findProductById] Product ${bitrixProductId} not found (result:`, JSON.stringify(data?.result), ')');
  debug('bitrix', `findProductById: product ${bitrixProductId} NOT FOUND`, { result: data?.result });
  return null;
};

const splitTags = (tags) => {
  if (!tags) return [];
  return String(tags)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
};

const createContact = async (customer, opts = {}) => {
  debug('bitrix', `createContact: START shopifyId=${customer.id} email=${customer.email || 'none'} name="${customer.first_name || ''} ${customer.last_name || ''}"`);
  const email = customer.email;
  const phone = customer.phone || (customer.default_address && customer.default_address.phone);

  const defaultAddr = customer.default_address || {};
  const addressLine1 = defaultAddr.address1 || '';
  const addressLine2 = defaultAddr.address2 || '';
  const streetAddress = [addressLine1, addressLine2].filter(Boolean).join(', ');
  const city = defaultAddr.city || '';
  const province = defaultAddr.province || defaultAddr.state || '';
  const country = defaultAddr.country || '';
  const zip = defaultAddr.zip || '';
  const company = defaultAddr.company || '';

  const commentsList = [];
  if (company) commentsList.push(`Company: ${company}`);
  if (streetAddress) commentsList.push(`Default Address: ${streetAddress}`);
  const comments = commentsList.join('\n');

  const fallbackName = email ? email.split('@')[0] : 'Unknown Customer';
  const fields = {
    "NAME": customer.first_name || fallbackName,
    "LAST_NAME": customer.last_name || '',
    "COMPANY_TITLE": company || '',
    "ADDRESS": streetAddress,
    "ADDRESS_CITY": city,
    "ADDRESS_PROVINCE": province,
    "ADDRESS_COUNTRY": country,
    "ADDRESS_POSTAL_CODE": zip,
    "COMMENTS": comments,
    "TAG": splitTags(customer.tags),
    "UF_CRM_CUSTOMER_TAGS": customer.tags || '',
    "UF_CRM_SHOPIFY_ID": String(customer.id || ''),
    "UF_CRM_CREATED_AT": customer.created_at || '',
    "UF_CRM_CUSTOMER_NOTE": customer.note || ''
  };

  if (email) {
    fields.EMAIL = [{ "VALUE": email.trim().toLowerCase(), "VALUE_TYPE": "WORK" }];
  }
  if (phone) {
    fields.PHONE = [{ "VALUE": phone, "VALUE_TYPE": "WORK" }];
  }

  let contactId;
  let existingContact = null;
  const byShopifyId = await findContactByShopifyId(customer.id);
  if (byShopifyId) {
    existingContact = { ID: byShopifyId };
  } else if (email) {
    existingContact = await findContactByEmail(email);
  }
  debug('bitrix', `createContact: dedupe resolution — byShopifyId=${byShopifyId || 'null'}, byEmail=${existingContact ? existingContact.ID : 'null'}`);

  if (existingContact) {
    contactId = existingContact.ID;
    debug('bitrix', `createContact: UPDATING existing contact ${contactId}`);
    await bitrixRequest('crm.contact.update', { id: contactId, fields });
  } else {
    debug('bitrix', `createContact: CREATING new contact`);
    const data = await bitrixRequest('crm.contact.add', { fields });
    contactId = data?.result;
    debug('bitrix', `createContact: created contact ${contactId}`);
  }

  await setMapping('contacts', customer.id, contactId);

  // Compute lifetime metrics + attribution roll-up when credentials are present.
  if (opts.shopDomain && opts.accessToken && !opts.skipLifetime && config.computeLifetime) {
    debug('bitrix', `createContact: triggering lifetime refresh for customer ${customer.id}`);
    const lifetimeService = require('./lifetime.service');
    await lifetimeService.refreshContactLifetime(customer.id, opts);
  } else {
    debug('bitrix', `createContact: lifetime refresh SKIPPED`, {
      hasCredentials: Boolean(opts.shopDomain && opts.accessToken),
      skipLifetime: Boolean(opts.skipLifetime),
      computeLifetimeConfig: config.computeLifetime
    });
  }

  debug('bitrix', `createContact: DONE contactId=${contactId}`);
  return contactId;
};

const createProduct = async (product, shopDomain, accessToken, apiVersion) => {
  debug('bitrix', `createProduct: START product=${product.id} title="${product.title}"`);
  const title = product.title || 'Unnamed Product';
  const variant = (product.variants && product.variants[0]) || {};
  const sku = variant.sku || '';
  const price = parseFloat(variant.price || product.price || 0);
  const tenant = getTenantConfig();
  const storeDomain = tenant.storeDomain || shopDomain || '';

  const cleanDescription = stripHtml(product.body_html || product.description || '');
  debug('bitrix', `createProduct: title="${title}", sku="${sku}", price=${price}, description ${cleanDescription.length} chars`);

  const fields = {
    "NAME": title,
    "PRICE": price,
    "CURRENCY_ID": tenant.currencyId,
    "DESCRIPTION": cleanDescription,
    "DESCRIPTION_TYPE": "text",
    "ACTIVE": (product.status === 'active' || !product.status) ? 'Y' : 'N',
    "CODE": sku || String(product.id),
    "MEASURE": 9,
    "WIDTH": variant.width || '',
    "LENGTH": variant.length || '',
    "HEIGHT": variant.height || ''
  };

  const propValues = {
    shopifyProductId: String(product.id),
    vendor: product.vendor || '',
    productType: product.product_type || '',
    tags: product.tags || '',
    handle: product.handle || '',
    barcode: variant.barcode || '',
    compareAtPrice: variant.compare_at_price || '',
    stockQuantity: variant.inventory_quantity !== undefined ? String(variant.inventory_quantity) : '',
    weight: variant.weight ? `${variant.weight} ${variant.weight_unit || ''}`.trim() : '',
    shopifyCreatedAt: product.created_at || '',
    taxable: variant.taxable ? 'Yes' : 'No',
    seoUrl: product.handle && storeDomain ? `https://${storeDomain}/products/${product.handle}` : '',
    unitPrice: variant.unit_price || '',
    inventoryTracked: variant.inventory_management === 'shopify' ? 'Physical' : 'Virtual',
    requiresShipping: variant.requires_shipping ? 'Yes' : 'No',
    seoTitle: product.title || '',
    variantInfo: (() => {
      const allVariants = product.variants || [];
      const totalVariants = allVariants.length;
      const options = (product.options || []).map(o => {
        const values = (o.values || []).filter(Boolean);
        return values.length > 0 ? `${o.name}: ${values.join(', ')}` : o.name;
      });
      const variantNames = allVariants
        .map(v => [v.option1, v.option2, v.option3].filter(Boolean).join(' / '))
        .filter(Boolean);
      const parts = [];
      if (totalVariants > 0) parts.push(`${totalVariants} variant(s)`);
      if (options.length > 0) parts.push(options.join(' | '));
      if (variantNames.length > 0) parts.push(variantNames.join(', '));
      return parts.join(' >> ');
    })(),
    boxSize: (() => {
      const w = variant.width;
      const l = variant.length;
      const h = variant.height;
      const unit = variant.dimension_unit || 'cm';
      if (!w && !l && !h) return '';
      return [w, l, h].filter(v => v !== undefined && v !== null && v !== '').join(` x `) + ` ${unit}`;
    })(),
    productStatus: product.status === 'active' ? 'Active' : product.status === 'draft' ? 'Draft' : 'Inactive'
  };

  if (shopDomain && accessToken && apiVersion) {
    debug('bitrix', `createProduct: fetching Shopify extras (collections, cost, category, metafields)...`);
    propValues.collections = await getCollectionNames(product.id, shopDomain, accessToken, apiVersion);
    propValues.costPerItem = await getCostPerItem(variant.inventory_item_id, shopDomain, accessToken, apiVersion);
    propValues.category = await getProductCategory(product.admin_graphql_api_id, shopDomain, accessToken, apiVersion);
    propValues.categoryMetafields = await getCategoryMetafields(product.admin_graphql_api_id, shopDomain, accessToken, apiVersion);
  } else {
    debug('bitrix', `createProduct: Shopify extras SKIPPED (missing shopDomain/accessToken/apiVersion)`);
  }

  // Map logical property values to the portal's actual PROPERTY_<id> fields.
  const propMap = await ensureProductPropertyMap(tenant.bitrixWebhookUrl);
  debug('bitrix', `createProduct: property map resolved with ${Object.keys(propMap).length} entries`, { propMap });
  for (const [key, value] of Object.entries(propValues)) {
    const field = propMap[key];
    if (field) fields[field] = value;
  }

  if (product.image && product.image.src) {
    debug('bitrix', `createProduct: downloading product image...`);
    const imageData = await getImageAsBase64(product.image.src);
    if (imageData) {
      fields.PREVIEW_PICTURE = imageData;
      fields.DETAIL_PICTURE = imageData;
      debug('bitrix', `createProduct: image attached to PREVIEW_PICTURE + DETAIL_PICTURE`);
    } else {
      debug('bitrix', `createProduct: image download failed — proceeding without image`);
    }
  }

  const existingBitrixId = await getMappingWithFallback('products', product.id);
  let productId;

  if (existingBitrixId) {
    productId = existingBitrixId;
    debug('bitrix', `createProduct: UPDATING existing Bitrix product ${productId}`);
    await bitrixRequest('crm.product.update', { id: productId, fields });
  } else {
    debug('bitrix', `createProduct: CREATING new Bitrix product`, { fieldKeys: Object.keys(fields) });
    const data = await bitrixRequest('crm.product.add', { fields });
    productId = data?.result;
    debug('bitrix', `createProduct: created Bitrix product ${productId}`);
  }

  await setMapping('products', product.id, productId);
  debug('bitrix', `createProduct: DONE productId=${productId}`);
  return productId;
};

const createDeal = async (order, opts = {}) => {
  debug('bitrix', `createDeal: START order=${order.id} (#${order.order_number || order.name}) financial=${order.financial_status}`);
  const orderNumber = order.order_number || order.name || order.id || 'N/A';
  const title = `Order #${orderNumber}`;
  const opportunity = parseFloat(order.total_price || 0);
  const currencyId = order.currency || getTenantConfig().currencyId;

  let contactId = null;
  const customerEmail = order.customer ? order.customer.email : order.email;
  if (customerEmail) {
    const existingContact = await findContactByEmail(customerEmail.trim().toLowerCase());
    if (existingContact) {
      contactId = existingContact.ID;
      debug('bitrix', `createDeal: linked to existing contact ${contactId} via email`);
    } else if (order.customer) {
      debug('bitrix', `createDeal: no contact for ${customerEmail} — creating one from order.customer`);
      contactId = await createContact(order.customer, { ...opts, skipLifetime: true });
    }
  } else {
    debug('bitrix', `createDeal: no customer email — deal will have no contact link`);
  }

  const commentsList = [
    `Customer Name: ${order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 'N/A'}`,
    `Customer Email: ${customerEmail || 'N/A'}`,
    `Customer Phone: ${order.customer ? order.customer.phone : (order.phone || 'N/A')}`,
    `Subtotal: ${order.subtotal_price || 'N/A'}`,
    `Discount: ${order.total_discounts || '0.00'}`,
    `Shipping Cost: ${order.shipping_lines && order.shipping_lines[0] ? order.shipping_lines[0].price : '0.00'}`,
    `Tax: ${order.total_tax || '0.00'}`,
    `Payment Gateway: ${order.payment_gateway_names ? order.payment_gateway_names.join(', ') : (order.gateway || 'N/A')}`,
    `Tags: ${order.tags || 'None'}`,
    `Order Notes: ${order.note || 'None'}`
  ];

  if (order.shipping_address) {
    const sa = order.shipping_address;
    const addr = [sa.address1, sa.address2, sa.city, sa.province, sa.country, sa.zip].filter(Boolean).join(', ');
    commentsList.push(`Shipping Address: ${addr}`);
  }
  if (order.billing_address) {
    const ba = order.billing_address;
    const addr = [ba.address1, ba.address2, ba.city, ba.province, ba.country, ba.zip].filter(Boolean).join(', ');
    commentsList.push(`Billing Address: ${addr}`);
  }
  const comments = commentsList.join('\n');

  const stageMap = {
    'paid': 'WON',
    'pending': 'NEW',
    'refunded': 'LOSE',
    'partially_refunded': 'LOSE',
    'voided': 'LOSE'
  };
  const stageId = stageMap[order.financial_status] || 'NEW';
  debug('bitrix', `createDeal: stage mapping financial="${order.financial_status}" -> STAGE_ID=${stageId}`);

  const attribution = require('./attribution.service').extractAttribution(order);
  const discountCode = require('./attribution.service').extractDiscountCodes(order);
  debug('bitrix', `createDeal: attribution extracted`, { channel: attribution.channel, utm_source: attribution.utm_source, utm_campaign: attribution.utm_campaign });
  debug('bitrix', `createDeal: discount codes="${discountCode}", total_discounts=${order.total_discounts}`);
  const invoiceNumber = order.name || `Order #${orderNumber}`;
  const refundStatus = order.financial_status === 'refunded'
    ? 'Fully Refunded'
    : order.financial_status === 'partially_refunded' ? 'Partially Refunded' : '';

  const fields = {
    "TITLE": title,
    "OPPORTUNITY": opportunity,
    "CURRENCY_ID": currencyId,
    "COMMENTS": comments,
    "STAGE_ID": stageId,
    "UF_CRM_FINANCIAL_STATUS": order.financial_status || 'N/A',
    "UF_CRM_FULFILLMENT_STATUS": order.fulfillment_status || 'unfulfilled',
    "UF_CRM_ORDER_CHANNEL": attribution.channel,
    "UF_CRM_DELIVERY_METHOD": order.shipping_lines && order.shipping_lines[0]
      ? order.shipping_lines[0].title
      : 'Shipping not required',
    "UF_CRM_DELIVERY_STATUS": order.fulfillments && order.fulfillments.length > 0
      ? (order.fulfillments[0].shipment_status || 'Fulfilled')
      : 'Not shipped',
    "UF_CRM_UTM_SOURCE": attribution.utm_source,
    "UF_CRM_UTM_MEDIUM": attribution.utm_medium,
    "UF_CRM_UTM_CAMPAIGN": attribution.utm_campaign,
    "UF_CRM_UTM_TERM": attribution.utm_term,
    "UF_CRM_UTM_CONTENT": attribution.utm_content,
    "UF_CRM_LANDING_SITE": attribution.landing_site,
    "UF_CRM_REFERRING_SITE": attribution.referring_site,
    "UF_CRM_DISCOUNT_CODE": discountCode,
    "UF_CRM_DISCOUNT": String(order.total_discounts || '0.00'),
    "UF_CRM_INVOICE_NUMBER": invoiceNumber,
    "UF_CRM_INVOICE_URL": order.invoice_url || order.order_status_url || '',
    "UF_CRM_REFUND_STATUS": refundStatus,
    "UF_CRM_REFUND_AMOUNT": refundStatus ? String(order.total_refunded || '0.00') : '',
    "BEGINDATE": order.created_at ? order.created_at.split('T')[0] : null,
    "CLOSEDATE": order.closed_at ? order.closed_at.split('T')[0] : (order.created_at ? order.created_at.split('T')[0] : null)
  };

  if (contactId) {
    fields.CONTACT_ID = contactId;
  }

  const existingDeal = await findDealByOrderNumber(orderNumber);
  let dealId;
  let isNew = false;

  if (existingDeal) {
    dealId = existingDeal.ID;
    debug('bitrix', `createDeal: UPDATING existing deal ${dealId} (found by title "${title}")`);
    await bitrixRequest('crm.deal.update', { id: dealId, fields });
  } else {
    debug('bitrix', `createDeal: CREATING new deal "${title}"`);
    const data = await bitrixRequest('crm.deal.add', { fields });
    dealId = data?.result;
    isNew = true;
    debug('bitrix', `createDeal: created deal ${dealId}`);
  }

  if (order.line_items && order.line_items.length > 0) {
    const rows = order.line_items.map(item => ({
      "PRODUCT_NAME": item.title || item.name || 'Unnamed Line Item',
      "PRICE": parseFloat(item.price || 0),
      "QUANTITY": parseInt(item.quantity || 1)
    }));

    const shippingCost = order.shipping_lines && order.shipping_lines[0]
      ? parseFloat(order.shipping_lines[0].price || 0)
      : 0;
    const taxCost = parseFloat(order.total_tax || 0);
    if (shippingCost) rows.push({ PRODUCT_NAME: 'Shipping', PRICE: shippingCost, QUANTITY: 1 });
    if (taxCost) rows.push({ PRODUCT_NAME: 'Tax', PRICE: taxCost, QUANTITY: 1 });

    // Bitrix derives OPPORTUNITY from the sum of the product rows and ignores
    // direct OPPORTUNITY updates once rows exist. Make the rows sum to the real
    // order total by adding an adjustment row (handles discounts/rounding).
    const sum = rows.reduce((s, r) => s + r.PRICE * r.QUANTITY, 0);
    const diff = Number((opportunity - sum).toFixed(2));
    if (Math.abs(diff) >= 0.005) {
      rows.push({ PRODUCT_NAME: 'Adjustment', PRICE: diff, QUANTITY: 1 });
    }

    debug('bitrix', `createDeal: setting ${rows.length} product row(s), rowsSum=${(sum + diff).toFixed(2)}, target OPPORTUNITY=${opportunity}`, { rows });

    await bitrixRequest('crm.deal.productrows.set', { id: dealId, rows });
  } else {
    debug('bitrix', `createDeal: no line items — product rows skipped`);
  }

  if (isNew) {
    await bitrixRequest('crm.timeline.comment.add', {
      fields: { "ENTITY_ID": dealId, "ENTITY_TYPE": "deal", "COMMENT": "Imported automatically from Shopify" }
    });
    debug('bitrix', `createDeal: timeline comment added to new deal ${dealId}`);
  }

  await setMapping('deals', order.id, dealId);
  await setMapping('deals_reverse', String(dealId), String(order.id));
  debug('bitrix', `createDeal: DONE dealId=${dealId}, mappings saved (deals + deals_reverse)`);
  return dealId;
};

const applyRefund = async (refund) => {
  debug('bitrix', `applyRefund: START`, { orderId: refund.order?.id, totalRefund: refund.total_refund });
  const order = refund.order || {};
  const orderId = order.id;
  const orderNumber = order.order_number || order.name || orderId || 'N/A';

  let dealId = orderId ? await getMappingWithFallback('deals', orderId) : null;
  if (!dealId) {
    debug('bitrix', `applyRefund: no id_map entry — searching deal by order number "${orderNumber}"`);
    const existing = await findDealByOrderNumber(orderNumber);
    if (existing) dealId = existing.ID;
  }
  if (!dealId) {
    console.error(`[Refund] No deal found for order ${orderId || orderNumber}`);
    debug('bitrix', `applyRefund: ABORTED — no deal found for order ${orderId || orderNumber}`);
    return null;
  }

  const refundStatus = order.financial_status === 'refunded' ? 'Fully Refunded' : 'Partially Refunded';
  const refundAmount = refund.total_refund || order.total_refunded || '';
  debug('bitrix', `applyRefund: applying to deal ${dealId}`, { refundStatus, refundAmount, financial: order.financial_status });

  await bitrixRequest('crm.deal.update', {
    id: dealId,
    fields: {
      "STAGE_ID": order.financial_status === 'refunded' ? 'LOSE' : 'WON',
      "UF_CRM_FINANCIAL_STATUS": order.financial_status || 'N/A',
      "UF_CRM_REFUND_STATUS": refundStatus,
      "UF_CRM_REFUND_AMOUNT": String(refundAmount)
    }
  });

  await bitrixRequest('crm.timeline.comment.add', {
    fields: {
      "ENTITY_ID": dealId,
      "ENTITY_TYPE": "deal",
      "COMMENT": `Refund received: ${refundAmount || 'N/A'} (${refundStatus})${refund.note ? ` — ${refund.note}` : ''}`
    }
  });

  console.log(`[Refund] Applied ${refundStatus} (${refundAmount}) to deal ${dealId}`);
  debug('bitrix', `applyRefund: DONE dealId=${dealId}`);
  return dealId;
};

const deleteContactByEmail = async (email) => {
  debug('bitrix', `deleteContactByEmail: "${email}"`);
  if (!email) return;
  const existing = await findContactByEmail(email.trim().toLowerCase());
  if (existing) {
    await bitrixRequest('crm.contact.delete', { id: existing.ID });
    console.log(`Deleted contact ${existing.ID} (${email})`);
  } else {
    debug('bitrix', `deleteContactByEmail: no contact found for "${email}"`);
  }
};

const deleteProductByName = async (name) => {
  debug('bitrix', `deleteProductByName: "${name}"`);
  if (!name) return;
  const existing = await findProductByName(name);
  if (existing) {
    await bitrixRequest('crm.product.delete', { id: existing.ID });
    console.log(`Deleted product ${existing.ID} (${name})`);
  } else {
    debug('bitrix', `deleteProductByName: no product found for "${name}"`);
  }
};

const deleteDealByOrderNumber = async (orderNumber) => {
  debug('bitrix', `deleteDealByOrderNumber: Order #${orderNumber}`);
  const existing = await findDealByOrderNumber(orderNumber);
  if (existing) {
    await bitrixRequest('crm.deal.delete', { id: existing.ID });
    console.log(`Deleted deal ${existing.ID} (Order #${orderNumber})`);
  } else {
    debug('bitrix', `deleteDealByOrderNumber: no deal found for Order #${orderNumber}`);
  }
};

const deleteContactById = async (bitrixId) => {
  debug('bitrix', `deleteContactById: ${bitrixId}`);
  await bitrixRequest('crm.contact.delete', { id: bitrixId });
  console.log(`Deleted contact ${bitrixId}`);
};

const deleteProductById = async (bitrixId) => {
  debug('bitrix', `deleteProductById: ${bitrixId}`);
  await bitrixRequest('crm.product.delete', { id: bitrixId });
  console.log(`Deleted product ${bitrixId}`);
};

const deleteDealById = async (bitrixId) => {
  debug('bitrix', `deleteDealById: ${bitrixId}`);
  await bitrixRequest('crm.deal.delete', { id: bitrixId });
  console.log(`Deleted deal ${bitrixId}`);
};

module.exports = {
  bitrixRequest,
  getMethodUrl,
  findContactByEmail,
  findContactByShopifyId,
  getContact,
  updateContact,
  getDeal,
  getDealProductRows,
  getProduct,
  findProductByName,
  findProductById,
  findDealByOrderNumber,
  createContact,
  deleteContact,
  createProduct,
  createDeal,
  createOrUpdateContact: createContact,
  createOrUpdateProduct: createProduct,
  createOrUpdateDeal: createDeal,
  applyRefund,
  syncProductStock,
  deleteContactByEmail,
  deleteProductByName,
  deleteDealByOrderNumber,
  deleteContactById,
  deleteProductById,
  deleteDealById
};
