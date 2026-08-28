const axios = require('axios');
const bitrixService = require('./bitrix.service');
const config = require('../config/bitrix.config');
const { getTenantConfig } = require('../utils/tenantContext');
const { setMapping, getMappingWithFallback } = require('../utils/idMapStore');
const { debug } = require('../utils/debugLogger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download a file and attach it to a Bitrix deal via a timeline comment.
 * Files is expected as: [{ fileName, url, headers }]
 */
const attachFilesToDeal = async (dealId, files) => {
  if (!dealId || !files || files.length === 0) {
    debug('invoice', `attachFilesToDeal: skipped (dealId=${dealId}, files=${files ? files.length : 0})`);
    return;
  }

  for (const file of files) {
    try {
      debug('invoice', `attachFilesToDeal: downloading "${file.fileName}" from ${file.url}`);
      const response = await axios.get(file.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: file.headers || {}
      });
      const base64 = Buffer.from(response.data, 'binary').toString('base64');
      const fileName = file.fileName || (file.url.split('/').pop().split('?')[0] || 'file.pdf');

      await bitrixService.bitrixRequest('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId,
          ENTITY_TYPE: 'deal',
          COMMENT: `Attachment: ${fileName}`,
          FILES: [{ fileData: [fileName, base64] }]
        }
      });
      console.log(`[Attachment] Uploaded "${fileName}" to deal ${dealId}`);
    } catch (err) {
      console.error(`[Attachment] Failed to upload "${file.fileName || file.url}" to deal ${dealId}:`, err.message);
      debug('invoice', `attachFilesToDeal: FAILED for "${file.fileName}"`, { error: err.message });
    }
  }
};

const buildInvoiceFields = (order, contactId) => {
  const invoiceNumber = order.name || `Order #${order.order_number || order.id}`;
  const invoiceUrl = order.invoice_url || order.order_status_url || '';

  const fields = {
    title: invoiceNumber,
    opportunity: parseFloat(order.total_price || 0),
    currencyId: order.currency || getTenantConfig().currencyId,
    accountNumber: invoiceNumber,
    begindate: order.created_at ? order.created_at.split('T')[0] : null,
    closedate: order.created_at ? order.created_at.split('T')[0] : null,
    description: `Invoice for ${invoiceNumber}\nPayment gateway: ${(order.payment_gateway_names || []).join(', ') || order.gateway || 'N/A'}`
  };
  if (contactId) fields.contactId = contactId;
  debug('invoice', `buildInvoiceFields: prepared Smart Invoice fields`, { fields });
  return fields;
};

/**
 * Create a Bitrix24 Smart Invoice for an order (dedupe via id_map type
 * 'invoices'), then attempt to attach the invoice PDF to the deal.
 *
 * Uses crm.item with entityTypeId=31 (Smart Invoice) — the legacy crm.invoice.*
 * methods are unavailable on plans without the Invoices module.
 */
const syncInvoice = async (order, dealId, opts) => {
  debug('invoice', `syncInvoice: START order=${order && order.id}, deal=${dealId}`, { enabled: config.invoiceSyncEnabled });
  if (!config.invoiceSyncEnabled) return { skipped: true, reason: 'invoice sync disabled' };
  if (!order || !order.id) return { skipped: true, reason: 'no order id' };

  const existing = await getMappingWithFallback('invoices', order.id);
  if (existing) {
    debug('invoice', `syncInvoice: invoice already exists (${existing}) for order ${order.id} — SKIPPED`);
    return { skipped: true, invoiceId: existing };
  }

  let contactId = null;
  const customerEmail = order.customer ? order.customer.email : order.email;
  if (customerEmail) {
    const contact = await bitrixService.findContactByEmail(customerEmail.trim().toLowerCase());
    if (contact) {
      contactId = contact.ID;
      debug('invoice', `syncInvoice: linking invoice to contact ${contactId}`);
    }
  }

  let invoiceId;
  try {
    const fields = buildInvoiceFields(order, contactId);
    const data = await bitrixService.bitrixRequest('crm.item.add', {
      entityTypeId: config.smartInvoiceEntityTypeId,
      fields
    });
    invoiceId = data?.item?.id || data?.result?.item?.id;
    if (!invoiceId) {
      console.error('[Invoice] crm.item.add returned no id:', JSON.stringify(data).substring(0, 500));
      debug('invoice', `syncInvoice: crm.item.add returned NO id for order ${order.id}`, { response: data });
      return { skipped: true, reason: 'no invoice id returned' };
    }
    await setMapping('invoices', order.id, invoiceId);
    console.log(`[Invoice] Created Smart Invoice ${invoiceId} for order ${order.id}`);
  } catch (err) {
    console.error('[Invoice] crm.item.add failed for order', order.id, ':', err.message);
    debug('invoice', `syncInvoice: FAILED for order ${order.id}`, { error: err.message });
    return { skipped: true, reason: err.message };
  }

  // Attach invoice PDF if a URL is available (Shopify Invoicing).
  if (order.invoice_url) {
    debug('invoice', `syncInvoice: attaching invoice PDF to deal ${dealId}`);
    await attachFilesToDeal(dealId, [{
      fileName: `${invoiceId}_invoice.pdf`,
      url: order.invoice_url,
      headers: opts && opts.shopDomain && opts.accessToken
        ? { 'X-Shopify-Access-Token': opts.accessToken }
        : {}
    }]);
  } else {
    debug('invoice', `syncInvoice: no invoice_url on order — PDF attach skipped`);
  }

  debug('invoice', `syncInvoice: DONE invoiceId=${invoiceId} for order ${order.id}`);
  return { invoiceId };
};

module.exports = { syncInvoice, attachFilesToDeal, buildInvoiceFields };
