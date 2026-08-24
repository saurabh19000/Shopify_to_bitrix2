const { debug } = require('../utils/debugLogger');

const config = {
  bitrixWebhookUrl: process.env.BITRIX_WEBHOOK_URL || '',
  currencyId: process.env.BITRIX_CURRENCY || 'INR',
  storeDomain: process.env.BITRIX_STORE_DOMAIN || '',
  warehouseId: parseInt(process.env.BITRIX_WAREHOUSE_ID, 10) || 2,
  responsibleId: parseInt(process.env.BITRIX_RESPONSIBLE_ID, 10) || 1,

  // Lifetime metrics & attribution roll-up (true/false)
  computeLifetime: process.env.COMPUTE_LIFETIME === 'true',

  // Lead (abandoned cart / checkout) settings
  leadResponsibleId: parseInt(process.env.BITRIX_LEAD_RESPONSIBLE_ID, 10) || 1,
  abandonedCartLeadStage: process.env.BITRIX_ABANDONED_CART_STAGE || 'NEW',
  checkoutLeadStage: process.env.BITRIX_CHECKOUT_STAGE || 'NEW',

  // Invoice sync (Smart Invoices via crm.item — legacy crm.invoice.* is not
  // available on plans without the Invoices module)
  invoiceSyncEnabled: process.env.BITRIX_INVOICE_SYNC_ENABLED === 'true',
  smartInvoiceEntityTypeId: parseInt(process.env.BITRIX_SMART_INVOICE_ENTITY_TYPE_ID, 10) || 31,
  invoicePaySystemId: parseInt(process.env.BITRIX_INVOICE_PAY_SYSTEM_ID, 10) || 84,
  invoiceStatusId: process.env.BITRIX_INVOICE_STATUS_ID || '',

  // Two-way sync (Bitrix -> Shopify) shared secret for outbound webhooks
  syncToken: process.env.BITRIX_SYNC_TOKEN || ''
};

debug('config', 'Bitrix config resolved', {
  webhookUrlPresent: Boolean(config.bitrixWebhookUrl),
  currencyId: config.currencyId,
  storeDomain: config.storeDomain || '(not set)',
  warehouseId: config.warehouseId,
  responsibleId: config.responsibleId,
  computeLifetime: config.computeLifetime,
  leadResponsibleId: config.leadResponsibleId,
  abandonedCartLeadStage: config.abandonedCartLeadStage,
  checkoutLeadStage: config.checkoutLeadStage,
  invoiceSyncEnabled: config.invoiceSyncEnabled,
  smartInvoiceEntityTypeId: config.smartInvoiceEntityTypeId,
  invoicePaySystemId: config.invoicePaySystemId,
  invoiceStatusId: config.invoiceStatusId || '(not set)',
  syncTokenPresent: Boolean(config.syncToken)
});

module.exports = config;
