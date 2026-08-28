const express = require('express');
const router = express.Router();
const bitrixService = require('../services/bitrix.service');
const shopifyService = require('../services/shopify.service');
const config = require('../config/bitrix.config');
const { getTenantConfig } = require('../utils/tenantContext');
const { getMappingWithFallback, setMapping, getShopifyIdByBitrixId } = require('../utils/idMapStore');
const { getToken } = require('../utils/tokenStore');
const {
  debug,
  generateSyncId,
  runWithRequestId,
  logBitrixEvent,
  logBitrixPayload,
  logValidation,
  logMapping,
  logMappingSave,
  logSyncComplete,
  logSyncFailed,
  logIdempotency,
  logLoopPrevention
} = require('../utils/debugLogger');
const { recordSync, isEchoLoop, isDuplicateEvent } = require('../utils/syncTracker');

/**
 * Two-Way Sync Engine: Bitrix24 -> Shopify
 * Implements reverse synchronization with end-to-end traceability,
 * duplicate prevention, idempotency, and echo loop suppression.
 */

const authorize = (req, res, next) => {
  const token =
    req.get('x-sync-token') ||
    req.query.token ||
    req.body?.token ||
    req.body?.auth?.application_token;

  const webhookSecret = (process.env.BITRIX_WEBHOOK_URL || '').split('/rest/1/')[1]?.replace(/\/.*$/, '') || '';

  const isAuthorized =
    Boolean(token && config.syncToken && token === config.syncToken) ||
    Boolean(token && webhookSecret && token === webhookSecret) ||
    Boolean(req.body?.auth?.domain && (process.env.BITRIX_WEBHOOK_URL || '').includes(req.body.auth.domain));

  debug('twoway', `${req.method} ${req.path} auth check`, {
    tokenProvided: Boolean(token),
    tokenMatches: isAuthorized,
    syncTokenConfigured: Boolean(config.syncToken)
  });

  if (!config.syncToken && !webhookSecret) {
    console.error('[TwoWay][Auth] BITRIX_SYNC_TOKEN is not configured in .env');
    return res.status(500).send('BITRIX_SYNC_TOKEN not configured');
  }

  if (!isAuthorized) {
    console.warn(`[TwoWay][Auth] Unauthorized request to ${req.path} (received token: "${token || 'NONE'}", expected: "${config.syncToken}")`);
    return res.status(401).send('Unauthorized');
  }

  next();
};

const cleanDomain = (d) => String(d || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

// Resolves Shopify creds from .env, falling back to the OAuth access token
// stored in the database (saved by /auth/callback).
const resolveShopifyCreds = async () => {
  const cfg = getTenantConfig();
  const shopDomain = cleanDomain(cfg.storeDomain);
  let accessToken = cfg.accessToken;
  if (!accessToken && shopDomain) {
    debug('twoway', `resolveShopifyCreds: no SHOPIFY_ACCESS_TOKEN in env — trying OAuth token from database for ${shopDomain}`);
    accessToken = (await getToken(shopDomain)) || '';
  }
  return { shopDomain, accessToken, apiVersion: cfg.apiVersion || '2024-10' };
};

/**
 * Robustly extract event name and entity ID from any Bitrix24 webhook payload format
 * (JSON, URL-encoded, query params, nested FIELDS).
 */
const extractBitrixEventData = (req, defaultEvent = 'BITRIX_EVENT') => {
  const body = req.body || {};
  const query = req.query || {};
  const event = (body.event || query.event || defaultEvent).toString().toUpperCase();
  const fields = body.data?.FIELDS || body.FIELDS || {};
  
  let id = null;
  if (event.includes('ADDRESS') || event.includes('REQUISITE')) {
    id =
      (fields.ANCHOR_TYPE_ID === 'CONTACT' || fields.ANCHOR_TYPE_ID === '3' || fields.ENTITY_TYPE_ID === 'CONTACT' || fields.ENTITY_TYPE_ID === '3')
        ? (fields.ANCHOR_ID || fields.ENTITY_ID)
        : (fields.ANCHOR_ID || fields.ENTITY_ID || fields.ID);
  }

  if (!id) {
    id =
      fields.ID ||
      fields.Id ||
      fields.id ||
      body.data?.ID ||
      body.data?.id ||
      body.id ||
      body.ID ||
      fields.ANCHOR_ID ||
      fields.ENTITY_ID ||
      body['data[FIELDS][ID]'] ||
      body['data[FIELDS][ANCHOR_ID]'] ||
      body['data[FIELDS][ENTITY_ID]'] ||
      query['data[FIELDS][ID]'] ||
      query['data[FIELDS][ANCHOR_ID]'] ||
      query['data[FIELDS][ENTITY_ID]'] ||
      query.id ||
      query.ID;
  }

  return {
    event: event || defaultEvent,
    id: id !== undefined && id !== null ? String(id).trim() : null,
    rawPayload: Object.keys(body).length > 0 ? body : query
  };
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

// Given a Bitrix contact object, find or create the matching Shopify customer.
const ensureShopifyCustomerForContact = async (contact, creds, syncId) => {
  if (contact.UF_CRM_SHOPIFY_ID) {
    return { id: String(contact.UF_CRM_SHOPIFY_ID), linked: false };
  }

  const email = extractFirstValue(contact.EMAIL);
  const phone = extractFirstValue(contact.PHONE);
  if (!email && !phone) return null;

  let existing = null;
  if (email) existing = await shopifyService.findShopifyCustomerByEmail(email, creds.shopDomain, creds.accessToken);
  if (!existing && phone) existing = await shopifyService.findShopifyCustomerByPhone(phone, creds.shopDomain, creds.accessToken);
  if (existing) return { id: existing.id, linked: true };

  try {
    const created = await shopifyService.createShopifyCustomer(contact, creds.shopDomain, creds.accessToken, syncId);
    return created ? { id: created.id, linked: false } : null;
  } catch (err) {
    if (err.duplicate) {
      debug('twoway', 'ensureShopifyCustomerForContact: creation duplicate (422) — searching once more', { email, phone });
      const dup =
        (email && (await shopifyService.findShopifyCustomerByEmail(email, creds.shopDomain, creds.accessToken))) ||
        (phone && (await shopifyService.findShopifyCustomerByPhone(phone, creds.shopDomain, creds.accessToken)));
      if (dup) return { id: dup.id, linked: true };
    }
    throw err;
  }
};

// ==================== CONTACTS (Bitrix -> Shopify) ====================

const contactUpdateHandler = async (req, res) => {
  const syncId = generateSyncId('BTX-SHP');
  const startedAt = Date.now();

  return runWithRequestId(syncId, async () => {
    try {
      const { event, id: contactId, rawPayload } = extractBitrixEventData(req, 'CRM_CONTACT_UPDATE');

      // Stage 1: Bitrix Event Received
      logBitrixEvent({ syncId, event, entityType: 'contact', entityId: contactId, payload: rawPayload });
      // Stage 2: Bitrix Payload Logged
      logBitrixPayload({ syncId, entity: 'contact', entityId: contactId, payload: rawPayload });

      if (!contactId) {
        logValidation({ syncId, entity: 'contact', entityId: 'N/A', status: 'FAILED', missingFields: 'contactId' });
        return res.status(400).send('Missing contact ID');
      }

      // Loop Prevention: suppress echo events from our own Shopify->Bitrix sync
      if (isEchoLoop('BITRIX_TO_SHOPIFY', 'contact', contactId)) {
        logLoopPrevention({ syncId, entity: 'contact', bitrixId: contactId, reason: 'echo_event_from_recent_shopify_sync' });
        return res.status(200).send('Echo event ignored (loop prevention)');
      }

      // Fetch Complete Bitrix Contact Data
      const contact = await bitrixService.getContact(contactId);
      if (!contact) {
        logSyncFailed({ syncId, entity: 'contact', bitrixId: contactId, error: `Contact ${contactId} not found in Bitrix`, stage: 'DATA_FETCH' });
        return res.status(404).send(`Contact ${contactId} not found`);
      }

      const email = extractFirstValue(contact.EMAIL);
      const phone = extractFirstValue(contact.PHONE);
      let shopifyId = contact.UF_CRM_SHOPIFY_ID;

      // If UF_CRM_SHOPIFY_ID is not present on the Bitrix record, check the database mapping
      if (!shopifyId) {
        shopifyId = await getShopifyIdByBitrixId('contacts', contactId);
        if (shopifyId) {
          debug('twoway', `contactUpdateHandler: resolved shopifyId=${shopifyId} from id_map for contact ${contactId}`);
        }
      }

      const hasName = Boolean((contact.NAME || '').trim() || (contact.LAST_NAME || '').trim());
      const hasEmail = Boolean(email);
      const hasPhone = Boolean(phone);
      const hasNote = Boolean((contact.UF_CRM_CUSTOMER_NOTE || contact.COMMENTS || '').trim());

      // Stage 3: Data Validation - allow name, email, phone, note or existing shopify ID
      if (!hasEmail && !hasPhone && !shopifyId && !hasName && !hasNote && !contact.COMPANY_TITLE) {
        logValidation({
          syncId,
          entity: 'contact',
          entityId: contactId,
          status: 'FAILED',
          missingFields: 'name_or_email_or_phone_or_shopifyId',
          details: { name: `${contact.NAME || ''} ${contact.LAST_NAME || ''}`.trim() }
        });
        return res.status(200).send('Contact has no name, email, phone or shopify ID — nothing to push');
      }

      logValidation({
        syncId,
        entity: 'contact',
        entityId: contactId,
        status: 'SUCCESS',
        requiredFields: 'id, name or email/phone',
        details: { hasName, hasEmail, hasPhone, hasShopifyId: Boolean(shopifyId) }
      });

      // Resolve Shopify Credentials
      const creds = await resolveShopifyCreds();
      if (!creds.shopDomain || !creds.accessToken) {
        logSyncFailed({ syncId, entity: 'contact', bitrixId: contactId, error: 'Shopify credentials not configured', stage: 'AUTH_RESOLUTION' });
        return res.status(500).send('Shopify credentials not configured');
      }

      // Stage 4: Field Mapping
      logMapping({
        syncId,
        source: 'BITRIX',
        target: 'SHOPIFY',
        entity: 'customer',
        status: 'SUCCESS',
        bitrixId: contactId,
        shopifyPayload: {
          first_name: contact.NAME,
          last_name: contact.LAST_NAME,
          email,
          phone,
          tags: contact.TAG || contact.UF_CRM_CUSTOMER_TAGS,
          note: contact.UF_CRM_CUSTOMER_NOTE
        }
      });

      // Case A: Bitrix contact already has Shopify Customer ID -> UPDATE
      if (shopifyId) {
        try {
          await shopifyService.updateCustomerByFields(shopifyId, contact, creds.shopDomain, creds.accessToken, syncId);
          await setMapping('contacts', shopifyId, contactId);
          recordSync('BITRIX_TO_SHOPIFY', 'contact', contactId);
          logMappingSave({ syncId, entity: 'customer', bitrixId: contactId, shopifyId, status: 'SUCCESS' });
          logSyncComplete({ syncId, entity: 'customer', bitrixId: contactId, shopifyId, duration: Date.now() - startedAt });
          return res.status(200).send('OK');
        } catch (updateErr) {
          if (updateErr.status === 404) {
            debug('twoway', `contactUpdateHandler: Shopify customer ${shopifyId} returned 404 — falling back to search/create`);
          } else {
            throw updateErr;
          }
        }
      }

      // Case B: Search Shopify for existing customer by email / phone
      let existingCustomer = null;
      if (email) existingCustomer = await shopifyService.findShopifyCustomerByEmail(email, creds.shopDomain, creds.accessToken);
      if (!existingCustomer && phone) existingCustomer = await shopifyService.findShopifyCustomerByPhone(phone, creds.shopDomain, creds.accessToken);

      if (existingCustomer) {
        recordSync('SHOPIFY_TO_BITRIX', 'contact', contactId);
        await bitrixService.updateContact(contactId, { UF_CRM_SHOPIFY_ID: String(existingCustomer.id) });
        await shopifyService.updateCustomerByFields(existingCustomer.id, contact, creds.shopDomain, creds.accessToken, syncId);
        await setMapping('contacts', existingCustomer.id, contactId);
        recordSync('BITRIX_TO_SHOPIFY', 'contact', contactId);
        logMappingSave({ syncId, entity: 'customer', bitrixId: contactId, shopifyId: existingCustomer.id, status: 'SUCCESS' });
        logSyncComplete({ syncId, entity: 'customer', bitrixId: contactId, shopifyId: existingCustomer.id, duration: Date.now() - startedAt, message: 'Linked existing Shopify customer to Bitrix contact' });
        return res.status(200).send('OK');
      }

      // Case C: Create brand new Shopify Customer
      try {
        const newCustomer = await shopifyService.createShopifyCustomer(contact, creds.shopDomain, creds.accessToken, syncId);
        if (newCustomer) {
          recordSync('SHOPIFY_TO_BITRIX', 'contact', contactId);
          await bitrixService.updateContact(contactId, { UF_CRM_SHOPIFY_ID: String(newCustomer.id) });
          await setMapping('contacts', newCustomer.id, contactId);
          recordSync('BITRIX_TO_SHOPIFY', 'contact', contactId);
          logMappingSave({ syncId, entity: 'customer', bitrixId: contactId, shopifyId: newCustomer.id, status: 'SUCCESS' });
          logSyncComplete({ syncId, entity: 'customer', bitrixId: contactId, shopifyId: newCustomer.id, duration: Date.now() - startedAt });
          return res.status(200).send('OK');
        }
      } catch (createErr) {
        if (createErr.status === 422 || createErr.duplicate) {
          debug('twoway', 'contactUpdateHandler: customer creation 422 conflict — looking up existing customer in Shopify', { email, phone });
          const existing = (email && (await shopifyService.findShopifyCustomerByEmail(email, creds.shopDomain, creds.accessToken))) ||
                           (phone && (await shopifyService.findShopifyCustomerByPhone(phone, creds.shopDomain, creds.accessToken)));
          if (existing) {
            recordSync('SHOPIFY_TO_BITRIX', 'contact', contactId);
            await bitrixService.updateContact(contactId, { UF_CRM_SHOPIFY_ID: String(existing.id) });
            await shopifyService.updateCustomerByFields(existing.id, contact, creds.shopDomain, creds.accessToken, syncId);
            await setMapping('contacts', existing.id, contactId);
            recordSync('BITRIX_TO_SHOPIFY', 'contact', contactId);
            logMappingSave({ syncId, entity: 'customer', bitrixId: contactId, shopifyId: existing.id, status: 'SUCCESS' });
            logSyncComplete({ syncId, entity: 'customer', bitrixId: contactId, shopifyId: existing.id, duration: Date.now() - startedAt, message: 'Linked existing Shopify customer on 422 conflict' });
            return res.status(200).send('OK');
          }
        }
        throw createErr;
      }

      logSyncFailed({ syncId, entity: 'contact', bitrixId: contactId, error: 'Shopify customer creation returned empty response', stage: 'SHOPIFY_API' });
      return res.status(200).send('Could not create Shopify customer');
    } catch (err) {
      logSyncFailed({
        syncId,
        entity: 'contact',
        bitrixId: req.body?.data?.FIELDS?.ID || 'UNKNOWN',
        error: err.message,
        duration: Date.now() - startedAt,
        stage: 'EXCEPTION',
        responseBody: err.responseBody || err.response?.data,
        httpStatus: err.status || err.response?.status || 500
      });
      return res.status(err.status || err.response?.status || 500).send(err.message);
    }
  });
};

router.post('/bitrix/contact-update', authorize, contactUpdateHandler);

// ==================== DEALS / ORDERS (Bitrix -> Shopify) ====================

const dealUpdateHandler = async (req, res) => {
  const syncId = generateSyncId('BTX-SHP');
  const startedAt = Date.now();

  return runWithRequestId(syncId, async () => {
    try {
      const { event, id: dealId, rawPayload } = extractBitrixEventData(req, 'CRM_DEAL_UPDATE');

      // Stage 1 & 2
      logBitrixEvent({ syncId, event, entityType: 'deal', entityId: dealId, payload: rawPayload });
      logBitrixPayload({ syncId, entity: 'deal', entityId: dealId, payload: rawPayload });

      if (!dealId) {
        logValidation({ syncId, entity: 'deal', entityId: 'N/A', status: 'FAILED', missingFields: 'dealId' });
        return res.status(400).send('Missing deal ID');
      }

      // Loop Prevention: suppress echo events from our own Shopify->Bitrix sync
      if (isEchoLoop('BITRIX_TO_SHOPIFY', 'deal', dealId)) {
        logLoopPrevention({ syncId, entity: 'deal', bitrixId: dealId, reason: 'echo_event_from_recent_shopify_sync' });
        return res.status(200).send('Echo event ignored (loop prevention)');
      }

      // Fetch Complete Bitrix Deal Data
      const deal = await bitrixService.getDeal(dealId);
      if (!deal) {
        logSyncFailed({ syncId, entity: 'deal', bitrixId: dealId, error: `Deal ${dealId} not found in Bitrix`, stage: 'DATA_FETCH' });
        return res.status(404).send(`Deal ${dealId} not found`);
      }

      // Stage 3: Data Validation
      logValidation({
        syncId,
        entity: 'deal',
        entityId: dealId,
        status: 'SUCCESS',
        requiredFields: 'id, title, opportunity',
        details: { title: deal.TITLE, stage: deal.STAGE_ID, opportunity: deal.OPPORTUNITY, contactId: deal.CONTACT_ID }
      });

      const creds = await resolveShopifyCreds();
      if (!creds.shopDomain || !creds.accessToken) {
        logSyncFailed({ syncId, entity: 'deal', bitrixId: dealId, error: 'Shopify credentials not configured', stage: 'AUTH_RESOLUTION' });
        return res.status(500).send('Shopify credentials not configured');
      }

      // Check if this deal was already mapped to a Shopify order
      let shopifyOrderId = await getMappingWithFallback('deals_reverse', dealId);
      if (!shopifyOrderId) {
        shopifyOrderId = await getShopifyIdByBitrixId('deals', dealId);
        if (shopifyOrderId) {
          debug('twoway', `dealUpdateHandler: resolved shopifyOrderId=${shopifyOrderId} from id_map for deal ${dealId}`);
        }
      }

      // Case A: Unmapped Deal -> Create Shopify DRAFT ORDER
      if (!shopifyOrderId) {
        if (process.env.BITRIX_ORDER_SYNC_ENABLED === 'false') {
          debug('twoway', `deal-update: deal ${dealId} unmapped and BITRIX_ORDER_SYNC_ENABLED=false — skipping`);
          return res.status(200).send('Order sync disabled');
        }

        let contact = null;
        if (deal.CONTACT_ID) {
          contact = await bitrixService.getContact(deal.CONTACT_ID);
        }

        let customerRef = null;
        if (contact) {
          customerRef = await ensureShopifyCustomerForContact(contact, creds, syncId);
          if (customerRef && customerRef.linked && contact.ID) {
            await bitrixService.updateContact(contact.ID, { UF_CRM_SHOPIFY_ID: String(customerRef.id) });
            await setMapping('contacts', customerRef.id, contact.ID);
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
        }

        // Build addresses if contact is available
        let shippingAddress = null;
        let billingAddress = null;
        if (contact && (contact.ADDRESS || contact.ADDRESS_CITY || contact.ADDRESS_PROVINCE)) {
          const addr = {
            address1: contact.ADDRESS || '',
            city: contact.ADDRESS_CITY || '',
            province: contact.ADDRESS_PROVINCE || '',
            country: contact.ADDRESS_COUNTRY || '',
            zip: contact.ADDRESS_POSTAL_CODE || '',
            first_name: contact.NAME || '',
            last_name: contact.LAST_NAME || '',
            company: contact.COMPANY_TITLE || '',
            phone: contact.PHONE && contact.PHONE[0] ? contact.PHONE[0].VALUE : ''
          };
          shippingAddress = addr;
          billingAddress = addr;
        }

        // Stage 4: Create Real Order (or Draft Order) in Shopify
        let createdOrder = null;
        try {
          const orderPayload = {
            line_items: lineItems,
            financial_status: deal.STAGE_ID === 'WON' ? 'paid' : (deal.UF_CRM_FINANCIAL_STATUS || 'pending'),
            fulfillment_status: deal.UF_CRM_FULFILLMENT_STATUS || null,
            note: deal.COMMENTS || `Created from Bitrix Deal #${dealId}: ${deal.TITLE}`,
            tags: `BitrixSync, Deal_${dealId}`
          };
          if (customerRef?.id) orderPayload.customer = { id: Number(customerRef.id) };
          if (contact?.EMAIL?.[0]?.VALUE) orderPayload.email = contact.EMAIL[0].VALUE;
          if (shippingAddress) orderPayload.shipping_address = shippingAddress;
          if (billingAddress) orderPayload.billing_address = billingAddress;

          createdOrder = await shopifyService.createShopifyOrder(orderPayload, creds.shopDomain, creds.accessToken, syncId);
        } catch (orderErr) {
          debug('twoway', `dealUpdateHandler: direct order creation failed (${orderErr.message}) — attempting draft order fallback`);
        }

        if (createdOrder && createdOrder.id) {
          await setMapping('deals_reverse', String(dealId), String(createdOrder.id));
          await setMapping('deals', String(createdOrder.id), String(dealId));
          recordSync('BITRIX_TO_SHOPIFY', 'deal', dealId);
          logMappingSave({ syncId, entity: 'order', bitrixId: dealId, shopifyId: createdOrder.id, status: 'SUCCESS' });
          logSyncComplete({ syncId, entity: 'order', bitrixId: dealId, shopifyId: createdOrder.id, duration: Date.now() - startedAt, message: 'Created real Shopify order from Bitrix deal' });
          return res.status(200).send('OK');
        }

        // Draft Order Creation Fallback
        const draft = await shopifyService.createShopifyDraftOrder({
          lineItems,
          customerId: customerRef ? Number(customerRef.id) : null,
          note: deal.COMMENTS || '',
          email: contact && contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : '',
          shippingAddress,
          billingAddress
        }, creds.shopDomain, creds.accessToken, syncId);

        if (!draft) {
          logSyncFailed({ syncId, entity: 'deal', bitrixId: dealId, error: 'Failed to create Shopify order/draft order', stage: 'SHOPIFY_API' });
          return res.status(500).send('Failed to create Shopify draft order');
        }

        await setMapping('deals_reverse', String(dealId), String(draft.id));
        recordSync('BITRIX_TO_SHOPIFY', 'deal', dealId);
        logMappingSave({ syncId, entity: 'deal_reverse', bitrixId: dealId, shopifyId: draft.id, status: 'SUCCESS' });

        // Optional auto-complete to turn draft order into real Shopify Order
        if (process.env.BITRIX_DRAFT_ORDER_AUTOCOMPLETE === 'true' || deal.STAGE_ID === 'WON') {
          try {
            const completed = await shopifyService.completeShopifyDraftOrder(draft.id, creds.shopDomain, creds.accessToken, syncId);
            if (completed && completed.order_id) {
              await setMapping('deals_reverse', String(dealId), String(completed.order_id));
              await setMapping('deals', String(completed.order_id), String(dealId));
              logMappingSave({ syncId, entity: 'order', bitrixId: dealId, shopifyId: completed.order_id, status: 'SUCCESS' });
              logSyncComplete({ syncId, entity: 'order', bitrixId: dealId, shopifyId: completed.order_id, duration: Date.now() - startedAt, message: 'Auto-completed draft into real Shopify order' });
              return res.status(200).send('OK');
            }
          } catch (compErr) {
            debug('twoway', `dealUpdateHandler: auto-complete failed (${compErr.message}) — remaining as draft order`);
          }
        }

        logSyncComplete({ syncId, entity: 'draft_order', bitrixId: dealId, shopifyId: draft.id, duration: Date.now() - startedAt });
        return res.status(200).send('OK');
      }

      // Case B: Mapped Deal -> Push changes to existing Shopify order
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
        logIdempotency({ syncId, entity: 'order', bitrixId: dealId, shopifyId: shopifyOrderId, reason: 'no_pushable_fields_changed' });
        return res.status(200).send('No pushable fields changed');
      }

      logMapping({
        syncId,
        source: 'BITRIX',
        target: 'SHOPIFY',
        entity: 'order_update',
        status: 'SUCCESS',
        bitrixId: dealId,
        shopifyPayload: updateFields
      });

      await shopifyService.updateShopifyOrder(shopifyOrderId, updateFields, creds.shopDomain, creds.accessToken, syncId);
      recordSync('BITRIX_TO_SHOPIFY', 'deal', dealId);
      logSyncComplete({ syncId, entity: 'order', bitrixId: dealId, shopifyId: shopifyOrderId, duration: Date.now() - startedAt });
      return res.status(200).send('OK');
    } catch (err) {
      logSyncFailed({
        syncId,
        entity: 'deal',
        bitrixId: req.body?.data?.FIELDS?.ID || 'UNKNOWN',
        error: err.message,
        duration: Date.now() - startedAt,
        stage: 'EXCEPTION',
        responseBody: err.responseBody || err.response?.data,
        httpStatus: err.status || err.response?.status || 500
      });
      return res.status(err.status || err.response?.status || 500).send(err.message);
    }
  });
};

router.post('/bitrix/deal-update', authorize, dealUpdateHandler);

// ==================== PRODUCTS (Bitrix -> Shopify) ====================

const productUpdateHandler = async (req, res) => {
  const syncId = generateSyncId('BTX-SHP');
  const startedAt = Date.now();

  return runWithRequestId(syncId, async () => {
    try {
      const { event, id: productId, rawPayload } = extractBitrixEventData(req, 'CRM_PRODUCT_UPDATE');

      // Stage 1 & 2
      logBitrixEvent({ syncId, event, entityType: 'product', entityId: productId, payload: rawPayload });
      logBitrixPayload({ syncId, entity: 'product', entityId: productId, payload: rawPayload });

      if (!productId) {
        logValidation({ syncId, entity: 'product', entityId: 'N/A', status: 'FAILED', missingFields: 'productId' });
        return res.status(400).send('Missing product ID');
      }

      // Loop Prevention: suppress echo events from our own Shopify->Bitrix sync
      if (isEchoLoop('BITRIX_TO_SHOPIFY', 'product', productId)) {
        logLoopPrevention({ syncId, entity: 'product', bitrixId: productId, reason: 'echo_event_from_recent_shopify_sync' });
        return res.status(200).send('Echo event ignored (loop prevention)');
      }

      // Fetch Complete Bitrix Product Data
      const product = await bitrixService.getProduct(productId);
      if (!product) {
        logSyncFailed({ syncId, entity: 'product', bitrixId: productId, error: `Product ${productId} not found in Bitrix`, stage: 'DATA_FETCH' });
        return res.status(404).send(`Product ${productId} not found`);
      }

      // Stage 3: Data Validation
      logValidation({
        syncId,
        entity: 'product',
        entityId: productId,
        status: 'SUCCESS',
        requiredFields: 'id, name, price',
        details: { name: product.NAME, price: product.PRICE, code: product.CODE }
      });

      const creds = await resolveShopifyCreds();
      if (!creds.shopDomain || !creds.accessToken) {
        logSyncFailed({ syncId, entity: 'product', bitrixId: productId, error: 'Shopify credentials not configured', stage: 'AUTH_RESOLUTION' });
        return res.status(500).send('Shopify credentials not configured');
      }

      let shopifyProductId = await getShopifyIdByBitrixId('products', productId);
      if (!shopifyProductId) {
        shopifyProductId = await getMappingWithFallback('products', product.PRODUCT_ID || productId);
      }
      if (shopifyProductId) {
        debug('twoway', `productUpdateHandler: resolved shopifyProductId=${shopifyProductId} for Bitrix product ${productId}`);
      }

      // Case A: Mapped Product -> UPDATE (safely preserving Shopify variant IDs)
      if (shopifyProductId) {
        const updateFields = {};
        if (product.NAME) updateFields.title = product.NAME;
        if (product.DESCRIPTION !== undefined) updateFields.body_html = product.DESCRIPTION || '';
        if (product.VENDOR !== undefined) updateFields.vendor = product.VENDOR;
        if (product.PRICE !== undefined) {
          updateFields.variants = [{ price: parseFloat(product.PRICE) }];
        }

        if (Object.keys(updateFields).length === 0) {
          logIdempotency({ syncId, entity: 'product', bitrixId: productId, shopifyId: shopifyProductId, reason: 'no_pushable_fields_changed' });
          return res.status(200).send('No pushable fields changed');
        }

        logMapping({
          syncId,
          source: 'BITRIX',
          target: 'SHOPIFY',
          entity: 'product',
          status: 'SUCCESS',
          bitrixId: productId,
          shopifyPayload: updateFields
        });

        try {
          await shopifyService.updateShopifyProduct(shopifyProductId, updateFields, creds.shopDomain, creds.accessToken, syncId);
          recordSync('BITRIX_TO_SHOPIFY', 'product', productId);
          logSyncComplete({ syncId, entity: 'product', bitrixId: productId, shopifyId: shopifyProductId, duration: Date.now() - startedAt });
          return res.status(200).send('OK');
        } catch (prodErr) {
          if (prodErr.status === 404) {
            debug('twoway', `productUpdateHandler: Shopify product ${shopifyProductId} returned 404 — falling back to create`);
          } else {
            throw prodErr;
          }
        }
      }

      // Case B: Unmapped Product -> CREATE NEW PRODUCT IN SHOPIFY
      logMapping({
        syncId,
        source: 'BITRIX',
        target: 'SHOPIFY',
        entity: 'product_create',
        status: 'SUCCESS',
        bitrixId: productId,
        shopifyPayload: { name: product.NAME, price: product.PRICE, code: product.CODE }
      });

      const newProduct = await shopifyService.createShopifyProduct(product, creds.shopDomain, creds.accessToken, syncId);
      if (newProduct) {
        await setMapping('products', String(productId), String(newProduct.id));
        recordSync('BITRIX_TO_SHOPIFY', 'product', productId);
        logMappingSave({ syncId, entity: 'product', bitrixId: productId, shopifyId: newProduct.id, status: 'SUCCESS' });
        logSyncComplete({ syncId, entity: 'product', bitrixId: productId, shopifyId: newProduct.id, duration: Date.now() - startedAt });
        return res.status(200).send('OK');
      }

      logSyncFailed({ syncId, entity: 'product', bitrixId: productId, error: 'Shopify product creation returned null', stage: 'SHOPIFY_API' });
      return res.status(200).send('Could not create Shopify product');
    } catch (err) {
      logSyncFailed({
        syncId,
        entity: 'product',
        bitrixId: req.body?.data?.FIELDS?.ID || 'UNKNOWN',
        error: err.message,
        duration: Date.now() - startedAt,
        stage: 'EXCEPTION',
        responseBody: err.responseBody || err.response?.data,
        httpStatus: err.status || err.response?.status || 500
      });
      return res.status(err.status || err.response?.status || 500).send(err.message);
    }
  });
};

const contactDeleteHandler = async (req, res) => {
  const syncId = generateSyncId('BTX-SHP-CUST-DEL');
  const startedAt = Date.now();
  return runWithRequestId(syncId, async () => {
    try {
      const { id: contactId } = extractBitrixEventData(req, 'ONCRMCONTACTDELETE');
      if (!contactId) return res.status(200).send('No contact ID');

      const creds = await resolveShopifyCreds();
      if (!creds.shopDomain || !creds.accessToken) return res.status(500).send('Shopify credentials missing');

      let shopifyCustomerId = await getShopifyIdByBitrixId('contacts', contactId);
      if (!shopifyCustomerId) {
        shopifyCustomerId = await getMappingWithFallback('contacts', contactId);
      }

      if (!shopifyCustomerId) {
        debug('twoway', `contactDeleteHandler: Bitrix contact ${contactId} was not mapped in Shopify — skipping`);
        return res.status(200).send('Contact not mapped');
      }

      debug('twoway', `contactDeleteHandler: deleting Shopify customer ${shopifyCustomerId} for Bitrix contact ${contactId}`);
      recordSync('SHOPIFY_TO_BITRIX', 'contact', contactId);
      await shopifyService.deleteShopifyCustomer(shopifyCustomerId, creds.shopDomain, creds.accessToken, syncId);
      await deleteMapping('contacts', contactId);
      await deleteMapping('contacts', shopifyCustomerId);
      recordSync('BITRIX_TO_SHOPIFY', 'contact', contactId);

      logSyncComplete({ syncId, entity: 'customer_delete', bitrixId: contactId, shopifyId: shopifyCustomerId, duration: Date.now() - startedAt });
      return res.status(200).send('Deleted in Shopify');
    } catch (err) {
      return res.status(err.status || 500).send(err.message);
    }
  });
};

const dealDeleteHandler = async (req, res) => {
  const syncId = generateSyncId('BTX-SHP-DEAL-DEL');
  const startedAt = Date.now();
  return runWithRequestId(syncId, async () => {
    try {
      const { id: dealId } = extractBitrixEventData(req, 'ONCRMDEALDELETE');
      if (!dealId) return res.status(200).send('No deal ID');

      const creds = await resolveShopifyCreds();
      if (!creds.shopDomain || !creds.accessToken) return res.status(500).send('Shopify credentials missing');

      let shopifyOrderId = await getShopifyIdByBitrixId('deals', dealId);
      if (!shopifyOrderId) shopifyOrderId = await getMappingWithFallback('deals_reverse', dealId);
      if (!shopifyOrderId) shopifyOrderId = await getMappingWithFallback('deals', dealId);

      if (!shopifyOrderId) {
        debug('twoway', `dealDeleteHandler: Bitrix deal ${dealId} was not mapped in Shopify — skipping`);
        return res.status(200).send('Deal not mapped');
      }

      debug('twoway', `dealDeleteHandler: canceling/deleting Shopify order ${shopifyOrderId} for Bitrix deal ${dealId}`);
      recordSync('SHOPIFY_TO_BITRIX', 'deal', dealId);
      await shopifyService.deleteShopifyOrder(shopifyOrderId, creds.shopDomain, creds.accessToken, syncId);
      await deleteMapping('deals', dealId);
      await deleteMapping('deals_reverse', dealId);
      await deleteMapping('deals', shopifyOrderId);
      recordSync('BITRIX_TO_SHOPIFY', 'deal', dealId);

      logSyncComplete({ syncId, entity: 'deal_delete', bitrixId: dealId, shopifyId: shopifyOrderId, duration: Date.now() - startedAt });
      return res.status(200).send('Deleted in Shopify');
    } catch (err) {
      return res.status(err.status || 500).send(err.message);
    }
  });
};

const productDeleteHandler = async (req, res) => {
  const syncId = generateSyncId('BTX-SHP-PROD-DEL');
  const startedAt = Date.now();
  return runWithRequestId(syncId, async () => {
    try {
      const { id: productId } = extractBitrixEventData(req, 'ONCRMPRODUCTDELETE');
      if (!productId) return res.status(200).send('No product ID');

      const creds = await resolveShopifyCreds();
      if (!creds.shopDomain || !creds.accessToken) return res.status(500).send('Shopify credentials missing');

      let shopifyProductId = await getShopifyIdByBitrixId('products', productId);
      if (!shopifyProductId) {
        shopifyProductId = await getMappingWithFallback('products', productId);
      }

      if (!shopifyProductId) {
        debug('twoway', `productDeleteHandler: Bitrix product ${productId} was not mapped in Shopify — skipping`);
        return res.status(200).send('Product not mapped');
      }

      debug('twoway', `productDeleteHandler: deleting Shopify product ${shopifyProductId} for Bitrix product ${productId}`);
      recordSync('SHOPIFY_TO_BITRIX', 'product', productId);
      await shopifyService.deleteShopifyProduct(shopifyProductId, creds.shopDomain, creds.accessToken, syncId);
      await deleteMapping('products', productId);
      await deleteMapping('products', shopifyProductId);
      recordSync('BITRIX_TO_SHOPIFY', 'product', productId);

      logSyncComplete({ syncId, entity: 'product_delete', bitrixId: productId, shopifyId: shopifyProductId, duration: Date.now() - startedAt });
      return res.status(200).send('Deleted in Shopify');
    } catch (err) {
      return res.status(err.status || 500).send(err.message);
    }
  });
};

// Contact routes (Bitrix -> Shopify)
router.post('/bitrix/contact-update', authorize, contactUpdateHandler);
router.post('/bitrix/contact-add', authorize, contactUpdateHandler);
router.post('/bitrix/contact-create', authorize, contactUpdateHandler);
router.post('/bitrix/contact-delete', authorize, contactDeleteHandler);
router.post('/bitrix/contact', authorize, contactUpdateHandler);
router.post('/bitrix/contacts', authorize, contactUpdateHandler);
router.post('/bitrix/customer-update', authorize, contactUpdateHandler);
router.post('/bitrix/customer-add', authorize, contactUpdateHandler);
router.post('/bitrix/customer-delete', authorize, contactDeleteHandler);
router.post('/bitrix/customer', authorize, contactUpdateHandler);
router.post('/bitrix/customers', authorize, contactUpdateHandler);

// Deal routes (Bitrix -> Shopify)
router.post('/bitrix/deal-update', authorize, dealUpdateHandler);
router.post('/bitrix/deal-add', authorize, dealUpdateHandler);
router.post('/bitrix/deal-create', authorize, dealUpdateHandler);
router.post('/bitrix/deal-delete', authorize, dealDeleteHandler);
router.post('/bitrix/deal', authorize, dealUpdateHandler);
router.post('/bitrix/deals', authorize, dealUpdateHandler);
router.post('/bitrix/order-update', authorize, dealUpdateHandler);
router.post('/bitrix/order-add', authorize, dealUpdateHandler);
router.post('/bitrix/order-delete', authorize, dealDeleteHandler);
router.post('/bitrix/order', authorize, dealUpdateHandler);

// Product routes (Bitrix -> Shopify)
router.post('/bitrix/product-update', authorize, productUpdateHandler);
router.post('/bitrix/product-add', authorize, productUpdateHandler);
router.post('/bitrix/product-create', authorize, productUpdateHandler);
router.post('/bitrix/product-delete', authorize, productDeleteHandler);
router.post('/bitrix/product', authorize, productUpdateHandler);
router.post('/bitrix/products', authorize, productUpdateHandler);

// ==================== UNIFIED EVENT DISPATCHER ====================
const EVENT_HANDLERS = {
  contact: contactUpdateHandler,
  contact_delete: contactDeleteHandler,
  deal: dealUpdateHandler,
  deal_delete: dealDeleteHandler,
  product: productUpdateHandler,
  product_delete: productDeleteHandler
};

router.post('/bitrix/event', authorize, async (req, res) => {
  const syncId = generateSyncId('BTX-SHP');
  return runWithRequestId(syncId, async () => {
    try {
      const { event: eventName, id } = extractBitrixEventData(req);

      debug('twoway', `event-dispatcher: received ${eventName}`, { id, body: req.body });

      if (!eventName || !id) {
        logValidation({ syncId, entity: 'general', entityId: id || 'N/A', status: 'SKIPPED', missingFields: 'eventName_or_id', details: { eventName } });
        return res.status(200).send(`Event ${eventName || 'UNKNOWN'} skipped (no entity ID)`);
      }

      const isDelete = eventName.endsWith('_DELETE') || eventName.includes('DELETE') || eventName.includes('UNREGISTER');

      // Contact delete
      if (isDelete && eventName.includes('CONTACT')) {
        req.body = { ...req.body, event: eventName, data: { FIELDS: { ID: String(id) } } };
        return await contactDeleteHandler(req, res);
      }

      // Deal / Order delete
      if (isDelete && (eventName.includes('DEAL') || eventName.includes('ORDER'))) {
        req.body = { ...req.body, event: eventName, data: { FIELDS: { ID: String(id) } } };
        return await dealDeleteHandler(req, res);
      }

      // Product delete
      if (isDelete && (eventName.includes('PRODUCT') || eventName.includes('CATALOG'))) {
        req.body = { ...req.body, event: eventName, data: { FIELDS: { ID: String(id) } } };
        return await productDeleteHandler(req, res);
      }

      if (isDelete) {
        debug('twoway', `event-dispatcher: unhandled delete event ${eventName} — skipping`);
        return res.status(200).send('Delete event skipped');
      }

      let kind = null;
      if (eventName.includes('CONTACT')) kind = 'contact';
      else if (eventName.includes('ADDRESS') || eventName.includes('REQUISITE')) {
        const fields = req.body?.data?.FIELDS || req.body?.FIELDS || {};
        const anchorType = String(fields.ANCHOR_TYPE_ID || fields.ENTITY_TYPE_ID || '').toUpperCase();
        if (anchorType === 'DEAL' || anchorType === '2' || anchorType === 'ORDER') {
          kind = 'deal';
        } else {
          kind = 'contact';
        }
      }
      else if (eventName.includes('DEAL') || eventName.includes('ORDER')) kind = 'deal';
      else if (eventName.includes('PRODUCT')) kind = 'product';

      if (!kind) {
        debug('twoway', `event-dispatcher: ${eventName} not mapped to an entity — ignoring`);
        return res.status(200).send(`Event ${eventName} ignored`);
      }

      req.body = { ...req.body, event: eventName, data: { FIELDS: { ID: String(id) } } };
      return await EVENT_HANDLERS[kind](req, res);
    } catch (err) {
      logSyncFailed({
        syncId,
        entity: 'dispatcher',
        bitrixId: req.body?.data?.FIELDS?.ID || 'UNKNOWN',
        error: err.message,
        stage: 'DISPATCHER'
      });
      return res.status(err.status || 500).send(err.message);
    }
  });
});

router.post('/bitrix/events', authorize, async (req, res) => {
  return router.handle(req, res);
});

// ==================== INVENTORY (Bitrix -> Shopify) ====================

router.post('/bitrix/inventory-update', authorize, async (req, res) => {
  const syncId = generateSyncId('BTX-SHP');
  const startedAt = Date.now();

  return runWithRequestId(syncId, async () => {
    try {
      const { id: rawId, rawPayload } = extractBitrixEventData(req, 'CRM_INVENTORY_UPDATE');
      const bitrixProductId = req.body?.bitrix_product_id || rawId;
      let shopifyProductId = req.body?.shopify_product_id;
      const quantity = req.body?.quantity;

      logBitrixEvent({ syncId, event: 'CRM_INVENTORY_UPDATE', entityType: 'inventory', entityId: bitrixProductId, payload: rawPayload });

      if (!bitrixProductId && !shopifyProductId) {
        return res.status(400).send('Missing product ID');
      }

      if (!shopifyProductId && bitrixProductId) {
        shopifyProductId = await getMappingWithFallback('products', bitrixProductId);
      }

      if (!shopifyProductId) {
        logIdempotency({ syncId, entity: 'inventory', bitrixId: bitrixProductId, reason: 'no_shopify_product_mapping' });
        return res.status(200).send('No Shopify product ID mapped');
      }

      const invCreds = await resolveShopifyCreds();
      if (!invCreds.shopDomain || !invCreds.accessToken) {
        return res.status(500).send('Shopify credentials not configured');
      }

      let qty = quantity;
      if (qty === undefined && bitrixProductId) {
        const bitrixProduct = await bitrixService.getProduct(bitrixProductId);
        qty = bitrixProduct?.QUANTITY !== undefined ? parseInt(bitrixProduct.QUANTITY, 10) : 0;
      }

      let invItemId = await getMappingWithFallback('inventory_items', shopifyProductId);
      if (!invItemId) {
        // Look up primary variant from Shopify directly
        try {
          const shopifyProd = await shopifyService.updateShopifyProduct(shopifyProductId, {}, invCreds.shopDomain, invCreds.accessToken, syncId);
          if (shopifyProd?.variants?.[0]?.inventory_item_id) {
            invItemId = String(shopifyProd.variants[0].inventory_item_id);
            await setMapping('inventory_items', shopifyProductId, invItemId);
          }
        } catch (e) {
          debug('twoway', 'inventory-update: could not fetch inventory_item_id from Shopify product');
        }
      }

      if (!invItemId) {
        debug('twoway', `inventory-update: no inventory item mapped for Shopify product ${shopifyProductId} -> SKIPPED`);
        return res.status(200).send('No inventory item mapped for this product');
      }

      let locationId = await getMappingWithFallback('locations', invCreds.shopDomain);
      if (!locationId && process.env.SHOPIFY_LOCATION_ID) {
        locationId = process.env.SHOPIFY_LOCATION_ID;
        await setMapping('locations', invCreds.shopDomain, locationId);
      }

      if (!locationId) {
        debug('twoway', `inventory-update: no location ID configured -> SKIPPED`);
        return res.status(200).send('No Shopify location ID configured');
      }

      await shopifyService.updateShopifyInventory(invItemId, locationId, qty, invCreds.shopDomain, invCreds.accessToken, syncId);
      logSyncComplete({ syncId, entity: 'inventory', bitrixId: bitrixProductId, shopifyId: shopifyProductId, duration: Date.now() - startedAt });
      return res.status(200).send('OK');
    } catch (err) {
      logSyncFailed({
        syncId,
        entity: 'inventory',
        bitrixId: req.body?.bitrix_product_id || 'UNKNOWN',
        error: err.message,
        duration: Date.now() - startedAt,
        stage: 'EXCEPTION'
      });
      return res.status(err.status || 500).send(err.message);
    }
  });
});

// ==================== HELPER: Store Shopify IDs for reverse mapping ====================

router.post('/bitrix/map-order', authorize, async (req, res) => {
  try {
    const { bitrix_deal_id, shopify_order_id } = req.body;
    if (!bitrix_deal_id || !shopify_order_id) {
      return res.status(400).send('Missing bitrix_deal_id or shopify_order_id');
    }

    await setMapping('deals_reverse', String(bitrix_deal_id), String(shopify_order_id));
    await setMapping('deals', String(shopify_order_id), String(bitrix_deal_id));
    console.log(`[TwoWay] Mapped deal ${bitrix_deal_id} <-> order ${shopify_order_id}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[TwoWay] Mapping failed:', err.message);
    res.status(500).send(err.message);
  }
});

router.get('/health', (req, res) => {
  res.status(200).send('sync routes OK');
});

module.exports = router;
