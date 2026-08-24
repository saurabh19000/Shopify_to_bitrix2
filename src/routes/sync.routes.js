const express = require('express');
const router = express.Router();
const bitrixService = require('../services/bitrix.service');
const shopifyService = require('../services/shopify.service');
const config = require('../config/bitrix.config');
const { getTenantConfig } = require('../utils/tenantContext');
const { getMappingWithFallback, setMapping } = require('../utils/idMapStore');
const { getToken } = require('../utils/tokenStore');
const { debug } = require('../utils/debugLogger');

const authorize = (req, res, next) => {
  const token = req.get('x-sync-token') || req.query.token;
  debug('twoway', `${req.method} ${req.path} auth check`, {
    tokenProvided: Boolean(token),
    tokenMatches: Boolean(token && config.syncToken && token === config.syncToken),
    syncTokenConfigured: Boolean(config.syncToken)
  });
  if (!config.syncToken) {
    return res.status(500).send('BITRIX_SYNC_TOKEN not configured');
  }
  if (token !== config.syncToken) {
    return res.status(401).send('Unauthorized');
  }
  next();
};

const cleanDomain = (d) => String(d || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

// Resolves Shopify creds from .env, falling back to the OAuth access token
// stored in the database (saved by /auth/callback). Without this fallback every
// reverse-sync push fails with "credentials not configured" on OAuth installs.
const resolveShopifyCreds = async () => {
  const cfg = getTenantConfig();
  const shopDomain = cleanDomain(cfg.storeDomain);
  let accessToken = cfg.accessToken;
  if (!accessToken && shopDomain) {
    debug('twoway', `resolveShopifyCreds: no SHOPIFY_ACCESS_TOKEN in env — trying OAuth token from database for ${shopDomain}`);
    accessToken = (await getToken(shopDomain)) || '';
  }
  return { shopDomain, accessToken };
};

// Given a Bitrix contact object, find or create the matching Shopify customer.
// Email OR phone identifies the customer — phone-only CRM contacts are supported.
const ensureShopifyCustomerForContact = async (contact, creds) => {
  if (contact.UF_CRM_SHOPIFY_ID) return { id: String(contact.UF_CRM_SHOPIFY_ID), linked: false };
  const email = contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : '';
  const phone = contact.PHONE && contact.PHONE[0] ? contact.PHONE[0].VALUE : '';
  if (!email && !phone) return null;

  let existing = null;
  if (email) existing = await shopifyService.findShopifyCustomerByEmail(email, creds.shopDomain, creds.accessToken);
  if (!existing && phone) existing = await shopifyService.findShopifyCustomerByPhone(phone, creds.shopDomain, creds.accessToken);
  if (existing) return { id: existing.id, linked: true };

  try {
    const created = await shopifyService.createShopifyCustomer(contact, creds.shopDomain, creds.accessToken);
    return created ? { id: created.id, linked: false } : null;
  } catch (err) {
    // 422 = email/phone already taken on the portal — find that customer and link it.
    if (err.duplicate) {
      debug('twoway', 'ensureShopifyCustomerForContact: creation rejected as duplicate — searching once more');
      const dup = (email && await shopifyService.findShopifyCustomerByEmail(email, creds.shopDomain, creds.accessToken)) ||
                  (phone && await shopifyService.findShopifyCustomerByPhone(phone, creds.shopDomain, creds.accessToken));
      if (dup) return { id: dup.id, linked: true };
    }
    throw err;
  }
};

// ==================== CONTACTS ====================

router.post('/bitrix/contact-update', authorize, async (req, res) => {
  try {
    debug('twoway', 'INBOUND Bitrix contact-update webhook', { body: req.body });
    const data = req.body?.data || {};
    const contactId = data.FIELDS?.ID || data.ID;
    if (!contactId) {
      console.log(`[TwoWay][Contact] Received webhook but no contact ID in payload`);
      debug('twoway', 'contact-update: no contact ID in payload -> 400');
      return res.status(400).send('Missing contact ID');
    }

    console.log(`[TwoWay][Contact] Webhook received for contact ${contactId}`);
    debug('twoway', `contact-update: fetching Bitrix contact ${contactId}`);

    const contact = await bitrixService.getContact(contactId);
    if (!contact) {
      console.log(`[TwoWay][Contact] Contact ${contactId} not found in Bitrix`);
      return res.status(404).send(`Contact ${contactId} not found`);
    }

    console.log(`[TwoWay][Contact] Fetched contact: name="${contact.NAME} ${contact.LAST_NAME}", shopifyId="${contact.UF_CRM_SHOPIFY_ID || 'none'}"`);
    debug('twoway', `contact-update: fetched contact`, {
      name: `${contact.NAME || ''} ${contact.LAST_NAME || ''}`.trim(),
      shopifyId: contact.UF_CRM_SHOPIFY_ID || null,
      email: contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : null
    });

    const shopifyId = contact.UF_CRM_SHOPIFY_ID;
    const creds = await resolveShopifyCreds();
    if (!creds.shopDomain || !creds.accessToken) {
      console.log(`[TwoWay][Contact] Shopify credentials not configured (env token AND database OAuth token missing)`);
      debug('twoway', 'contact-update: no credentials after env + DB fallback -> 500');
      return res.status(500).send('Shopify credentials not configured');
    }

    if (shopifyId) {
      console.log(`[TwoWay][Contact] Has Shopify ID ${shopifyId} — pushing update...`);
      await shopifyService.updateCustomerByFields(shopifyId, contact, creds.shopDomain, creds.accessToken);
      console.log(`[TwoWay][Contact] SUCCESS — Pushed Bitrix contact ${contactId} -> Shopify customer ${shopifyId}`);
      return res.status(200).send('OK');
    }

    const email = contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : '';
    const phone = contact.PHONE && contact.PHONE[0] ? contact.PHONE[0].VALUE : '';
    if (!email && !phone) {
      console.log(`[TwoWay][Contact] No UF_CRM_SHOPIFY_ID, no email AND no phone — nothing to push`);
      return res.status(200).send('No UF_CRM_SHOPIFY_ID, no email and no phone — nothing to push');
    }

    console.log(`[TwoWay][Contact] No Shopify ID. Searching Shopify by ${email ? `email "${email}"` : ''}${email && phone ? ' and ' : ''}${phone ? `phone "${phone}"` : ''}...`);
    let existingCustomer = null;
    if (email) existingCustomer = await shopifyService.findShopifyCustomerByEmail(email, creds.shopDomain, creds.accessToken);
    if (!existingCustomer && phone) {
      debug('twoway', `contact-update: email search missed — trying phone "${phone}"`);
      existingCustomer = await shopifyService.findShopifyCustomerByPhone(phone, creds.shopDomain, creds.accessToken);
    }

    if (existingCustomer) {
      console.log(`[TwoWay][Contact] Found existing Shopify customer ${existingCustomer.id} — linking and pushing update...`);
      await bitrixService.updateContact(contactId, { UF_CRM_SHOPIFY_ID: String(existingCustomer.id) });
      await shopifyService.updateCustomerByFields(existingCustomer.id, contact, creds.shopDomain, creds.accessToken);
      console.log(`[TwoWay][Contact] SUCCESS — Linked existing Shopify customer ${existingCustomer.id} to Bitrix contact ${contactId}`);
      return res.status(200).send('OK');
    }

    console.log(`[TwoWay][Contact] Not found in Shopify. Creating new customer...`);
    const newCustomer = await shopifyService.createShopifyCustomer(contact, creds.shopDomain, creds.accessToken);
    if (newCustomer) {
      await bitrixService.updateContact(contactId, { UF_CRM_SHOPIFY_ID: String(newCustomer.id) });
      console.log(`[TwoWay][Contact] SUCCESS — Created new Shopify customer ${newCustomer.id} from Bitrix contact ${contactId}`);
      return res.status(200).send('OK');
    }
    if (newCustomer) {
      await bitrixService.updateContact(contactId, { UF_CRM_SHOPIFY_ID: String(newCustomer.id) });
      console.log(`[TwoWay][Contact] SUCCESS — Created new Shopify customer ${newCustomer.id} from Bitrix contact ${contactId}`);
      return res.status(200).send('OK');
    }

    console.log(`[TwoWay][Contact] Could not create Shopify customer`);
    res.status(200).send('Could not create Shopify customer');
  } catch (err) {
    console.error(`[TwoWay][Contact] FAILED:`, err.message);
    debug('twoway', 'contact-update FAILED', { error: err.message });
    res.status(err.status || 500).send(err.message);
  }
});

// ==================== DEALS / ORDERS ====================

router.post('/bitrix/deal-update', authorize, async (req, res) => {
  try {
    debug('twoway', 'INBOUND Bitrix deal-update webhook', { body: req.body });
    const data = req.body?.data || {};
    const dealId = data.FIELDS?.ID || data.ID;
    if (!dealId) {
      console.log(`[TwoWay][Deal] Received webhook but no deal ID in payload`);
      debug('twoway', 'deal-update: no deal ID in payload -> 400');
      return res.status(400).send('Missing deal ID');
    }

    console.log(`[TwoWay][Deal] Webhook received for deal ${dealId}`);
    debug('twoway', `deal-update: fetching Bitrix deal ${dealId}`);

    const deal = await bitrixService.getDeal(dealId);
    if (!deal) {
      console.log(`[TwoWay][Deal] Deal ${dealId} not found in Bitrix`);
      return res.status(404).send(`Deal ${dealId} not found`);
    }

    console.log(`[TwoWay][Deal] Fetched deal: title="${deal.TITLE}", stage="${deal.STAGE_ID}", opportunity="${deal.OPPORTUNITY}"`);

    const shopifyOrderId = await getMappingWithFallback('deals_reverse', dealId);
    if (!shopifyOrderId) {
      if (process.env.BITRIX_ORDER_SYNC_ENABLED === 'false') {
        console.log(`[TwoWay][Deal] Deal ${dealId} unmapped and BITRIX_ORDER_SYNC_ENABLED=false — skipping`);
        return res.status(200).send('Order sync disabled');
      }

      console.log(`[TwoWay][Deal] Deal ${dealId} not mapped to a Shopify order — creating a Shopify DRAFT ORDER from this deal...`);
      debug('twoway', `deal-update: deal ${dealId} unmapped -> draft-order creation path`);

      const creds = await resolveShopifyCreds();
      if (!creds.shopDomain || !creds.accessToken) {
        console.log(`[TwoWay][Deal] Shopify credentials not configured`);
        return res.status(500).send('Shopify credentials not configured');
      }

      let contact = null;
      if (deal.CONTACT_ID) {
        contact = await bitrixService.getContact(deal.CONTACT_ID);
        debug('twoway', `deal-update: deal contact ${deal.CONTACT_ID} -> ${contact ? 'found' : 'not found'}`);
      }
      let customerRef = null;
      if (contact) {
        customerRef = await ensureShopifyCustomerForContact(contact, creds);
        if (!customerRef) {
          console.log(`[TwoWay][Deal] Contact ${deal.CONTACT_ID} has neither email nor phone — cannot attach a customer to the order`);
        } else if (customerRef.linked && contact.ID) {
          await bitrixService.updateContact(contact.ID, { UF_CRM_SHOPIFY_ID: String(customerRef.id) });
          console.log(`[TwoWay][Deal] Linked existing Shopify customer ${customerRef.id} to Bitrix contact ${contact.ID}`);
        }
      }

      const rows = await bitrixService.getDealProductRows(dealId);
      let lineItems = rows.map((r) => ({
        title: r.PRODUCT_NAME || 'Item',
        price: parseFloat(r.PRICE || 0) || 0,
        quantity: parseInt(r.QUANTITY, 10) || 1
      }));
      if (lineItems.length === 0) {
        lineItems = [{ title: deal.TITLE || 'Bitrix Deal', price: parseFloat(deal.OPPORTUNITY || 0) || 0, quantity: 1 }];
        debug('twoway', 'deal-update: no product rows on deal — using deal total as single line item');
      }
      debug('twoway', `deal-update: built line items`, { count: lineItems.length, items: lineItems.map((li) => `${li.quantity}x ${li.title}`) });

      const draft = await shopifyService.createShopifyDraftOrder({
        lineItems,
        customerId: customerRef ? Number(customerRef.id) : null,
        note: deal.COMMENTS || '',
        email: contact && contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : ''
      }, creds.shopDomain, creds.accessToken);

      if (!draft) {
        return res.status(500).send('Failed to create Shopify draft order');
      }

      await setMapping('deals_reverse', String(dealId), String(draft.id));
      console.log(`[TwoWay][Deal] SUCCESS — Created Shopify draft order ${draft.id} from deal ${dealId} (mapping saved)`);

      if (process.env.BITRIX_DRAFT_ORDER_AUTOCOMPLETE === 'true') {
        const completed = await shopifyService.completeShopifyDraftOrder(draft.id, creds.shopDomain, creds.accessToken);
        if (completed && completed.order_id) {
          await setMapping('deals_reverse', String(dealId), String(completed.order_id));
          console.log(`[TwoWay][Deal] Auto-completed draft -> real Shopify order ${completed.order_id} (mapping updated)`);
          return res.status(200).send('OK');
        }
        console.log(`[TwoWay][Deal] Auto-complete failed — draft order ${draft.id} remains in Shopify admin`);
      }

      return res.status(200).send('OK');
    }

    console.log(`[TwoWay][Deal] Mapped to Shopify order ${shopifyOrderId}`);
    debug('twoway', `deal-update: pushing to Shopify order ${shopifyOrderId}`, {
      financial: deal.UF_CRM_FINANCIAL_STATUS,
      fulfillment: deal.UF_CRM_FULFILLMENT_STATUS
    });

    const creds = await resolveShopifyCreds();
    if (!creds.shopDomain || !creds.accessToken) {
      console.log(`[TwoWay][Deal] Shopify credentials not configured`);
      return res.status(500).send('Shopify credentials not configured');
    }

    const updateFields = {};

    if (deal.COMMENTS) updateFields.note = deal.COMMENTS;
    if (deal.UF_CRM_FINANCIAL_STATUS) {
      const validStatuses = ['authorized', 'paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided', 'pending'];
      if (validStatuses.includes(deal.UF_CRM_FINANCIAL_STATUS)) {
        updateFields.financial_status = deal.UF_CRM_FINANCIAL_STATUS;
      }
    }
    if (deal.UF_CRM_FULFILLMENT_STATUS) {
      const validFulfill = ['unfulfilled', 'partial', 'fulfilled', 'restocked'];
      if (validFulfill.includes(deal.UF_CRM_FULFILLMENT_STATUS)) {
        updateFields.fulfillment_status = deal.UF_CRM_FULFILLMENT_STATUS;
      }
    }

    if (Object.keys(updateFields).length === 0) {
      console.log(`[TwoWay][Deal] Deal ${dealId} has no pushable fields changed (financial="${deal.UF_CRM_FINANCIAL_STATUS}", fulfillment="${deal.UF_CRM_FULFILLMENT_STATUS}")`);
      debug('twoway', `deal-update: no pushable fields for deal ${dealId} -> nothing to push`);
      return res.status(200).send('No pushable fields changed');
    }

    console.log(`[TwoWay][Deal] Pushing to Shopify order ${shopifyOrderId}:`, updateFields);
    await shopifyService.updateShopifyOrder(shopifyOrderId, updateFields, creds.shopDomain, creds.accessToken);
    console.log(`[TwoWay][Deal] SUCCESS — Pushed Bitrix deal ${dealId} -> Shopify order ${shopifyOrderId}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error(`[TwoWay][Deal] FAILED:`, err.message);
    debug('twoway', 'deal-update FAILED', { error: err.message });
    res.status(err.status || 500).send(err.message);
  }
});

// ==================== PRODUCTS ====================

router.post('/bitrix/product-update', authorize, async (req, res) => {
  try {
    debug('twoway', 'INBOUND Bitrix product-update webhook', { body: req.body });
    const data = req.body?.data || {};
    const productId = data.FIELDS?.ID || data.ID;
    if (!productId) {
      console.log(`[TwoWay][Product] Received webhook but no product ID in payload`);
      debug('twoway', 'product-update: no product ID in payload -> 400');
      return res.status(400).send('Missing product ID');
    }

    console.log(`[TwoWay][Product] Webhook received for product ${productId}`);
    debug('twoway', `product-update: fetching Bitrix product ${productId}`);

    const product = await bitrixService.getProduct(productId);
    if (!product) {
      console.log(`[TwoWay][Product] Product ${productId} not found in Bitrix`);
      return res.status(404).send(`Product ${productId} not found`);
    }

    console.log(`[TwoWay][Product] Fetched product: name="${product.NAME}", price="${product.PRICE}"`);

    const shopifyProductId = await getMappingWithFallback('products', product.PRODUCT_ID || productId);
    if (shopifyProductId) {
      debug('twoway', `product-update: mapped to Shopify product ${shopifyProductId} — pushing update`);
      const creds = await resolveShopifyCreds();
      if (!creds.shopDomain || !creds.accessToken) {
        console.log(`[TwoWay][Product] Shopify credentials not configured`);
        return res.status(500).send('Shopify credentials not configured');
      }

      const updateFields = {};
      if (product.NAME) updateFields.title = product.NAME;
      if (product.DESCRIPTION !== undefined) updateFields.body_html = product.DESCRIPTION || '';
      if (product.VENDOR !== undefined) updateFields.vendor = product.VENDOR;
      if (product.PRICE !== undefined) {
        updateFields.variants = [{ price: parseFloat(product.PRICE) }];
      }

      if (Object.keys(updateFields).length === 0) {
        console.log(`[TwoWay][Product] Product ${productId} has no pushable fields changed`);
        return res.status(200).send('No pushable fields changed');
      }

      console.log(`[TwoWay][Product] Pushing to Shopify product ${shopifyProductId}:`, Object.keys(updateFields));
      await shopifyService.updateShopifyProduct(shopifyProductId, updateFields, creds.shopDomain, creds.accessToken);
      console.log(`[TwoWay][Product] SUCCESS — Pushed Bitrix product ${productId} -> Shopify product ${shopifyProductId}`);
      return res.status(200).send('OK');
    }

    console.log(`[TwoWay][Product] Product ${productId} has no Shopify mapping. Attempting to create new product in Shopify...`);
    debug('twoway', `product-update: no mapping — creating NEW product in Shopify from Bitrix product ${productId}`);

    const creds = await resolveShopifyCreds();
    if (!creds.shopDomain || !creds.accessToken) {
      console.log(`[TwoWay][Product] Shopify credentials not configured`);
      return res.status(500).send('Shopify credentials not configured');
    }

    const newProduct = await shopifyService.createShopifyProduct(product, creds.shopDomain, creds.accessToken);
    if (newProduct) {
      const { setMapping } = require('../utils/idMapStore');
      await setMapping('products', String(productId), String(newProduct.id));
      console.log(`[TwoWay][Product] SUCCESS — Created new Shopify product ${newProduct.id} from Bitrix product ${productId}`);
      return res.status(200).send('OK');
    }

    console.log(`[TwoWay][Product] Could not create Shopify product from Bitrix product ${productId}`);
    res.status(200).send('Could not create Shopify product');
  } catch (err) {
    console.error(`[TwoWay][Product] FAILED:`, err.message);
    debug('twoway', 'product-update FAILED', { error: err.message });
    res.status(err.status || 500).send(err.message);
  }
});

// ==================== INVENTORY ====================

router.post('/bitrix/inventory-update', authorize, async (req, res) => {
  try {
    debug('twoway', 'INBOUND Bitrix inventory-update webhook', { body: req.body });
    const { bitrix_product_id, shopify_product_id, quantity } = req.body?.data || req.body || {};
    const bId = bitrix_product_id || req.body?.data?.FIELDS?.ID;
    debug('twoway', `inventory-update: bitrixProductId=${bId}, shopifyProductId=${shopify_product_id}, quantity=${quantity}`);
    if (!bId && !shopify_product_id) return res.status(400).send('Missing product ID');

    let shopifyPid = shopify_product_id;
    if (!shopifyPid) {
      shopifyPid = await getMappingWithFallback('products', bId);
      debug('twoway', `inventory-update: resolved Shopify product via id_map -> ${shopifyPid}`);
    }
    if (!shopifyPid) {
      debug('twoway', `inventory-update: NO Shopify product mapping -> skipping`);
      return res.status(200).send('No Shopify product ID mapped');
    }

    const invCreds = await resolveShopifyCreds();
    if (!invCreds.shopDomain || !invCreds.accessToken) return res.status(500).send('Shopify credentials not configured');

    let qty = quantity;
    if (qty === undefined && bId) {
      const bitrixProduct = await bitrixService.getProduct(bId);
      qty = bitrixProduct?.QUANTITY || 0;
      debug('twoway', `inventory-update: fetched Bitrix QUANTITY=${qty}`);
    }

    const invItemId = await getMappingWithFallback('inventory_items', shopifyPid);
    if (!invItemId) {
      debug('twoway', `inventory-update: no 'inventory_items' mapping for Shopify product ${shopifyPid} -> SKIPPED (nothing in this codebase ever writes that mapping)`);
      return res.status(200).send('No inventory item mapped for this product');
    }

    const locationId = await getMappingWithFallback('locations', shopDomain);
    if (!locationId) {
      debug('twoway', `inventory-update: no 'locations' mapping -> SKIPPED`);
      return res.status(200).send('No Shopify location ID configured');
    }

    await shopifyService.updateShopifyInventory(invItemId, locationId, qty, invCreds.shopDomain, invCreds.accessToken);
    console.log(`[TwoWay] Pushed Bitrix inventory -> Shopify product ${shopifyPid}, qty=${qty}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[TwoWay] Bitrix->Shopify inventory sync failed:', err.message);
    debug('twoway', 'inventory-update FAILED', { error: err.message });
    res.status(err.status || 500).send(err.message);
  }
});

// ==================== HELPER: Store Shopify IDs for reverse mapping ====================

router.post('/bitrix/map-order', authorize, async (req, res) => {
  try {
    debug('twoway', 'map-order: request received', { bitrix_deal_id: req.body.bitrix_deal_id, shopify_order_id: req.body.shopify_order_id });
    const { bitrix_deal_id, shopify_order_id } = req.body;
    if (!bitrix_deal_id || !shopify_order_id) {
      debug('twoway', 'map-order: REJECTED — missing fields');
      return res.status(400).send('Missing bitrix_deal_id or shopify_order_id');
    }

    const { setMapping } = require('../utils/idMapStore');
    await setMapping('deals_reverse', String(bitrix_deal_id), String(shopify_order_id));

    console.log(`[TwoWay] Mapped deal ${bitrix_deal_id} -> order ${shopify_order_id}`);
    debug('twoway', `map-order: mapping saved deals_reverse[${bitrix_deal_id}] = ${shopify_order_id}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[TwoWay] Mapping failed:', err.message);
    debug('twoway', 'map-order: FAILED', { error: err.message });
    res.status(500).send(err.message);
  }
});

router.get('/health', (req, res) => {
  debug('twoway', 'GET /sync/health pinged');
  res.status(200).send('sync routes OK');
});

module.exports = router;
