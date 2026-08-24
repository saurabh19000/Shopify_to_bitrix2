/**
 * Bitrix24 Custom Field (UF) definitions used by the integration.
 *
 * All codes are <= 20 chars (system limit for UF_CRM_* fields).
 * Create them on your portal with: node scripts/createCustomFields.js
 */
const CONTACT_FIELDS = [
  { code: 'UF_CRM_SHOPIFY_ID',     label: 'Shopify Customer ID',     type: 'string'   },
  { code: 'UF_CRM_CREATED_AT',     label: 'Shopify Created At',      type: 'datetime' },
  { code: 'UF_CRM_CUSTOMER_NOTE',  label: 'Customer Note',           type: 'string'   },
  { code: 'UF_CRM_CUSTOMER_TAGS',  label: 'Customer Tags',           type: 'string'   },
  { code: 'UF_CRM_TOTAL_ORDERS',   label: 'Total Orders',            type: 'integer'  },
  { code: 'UF_CRM_TOTAL_SPEND',    label: 'Total Spend',             type: 'string'   },
  { code: 'UF_CRM_LAST_PURCHASE',  label: 'Last Purchase Date',      type: 'datetime' },
  { code: 'UF_CRM_AOV',            label: 'Average Order Value',     type: 'string'   },
  { code: 'UF_CRM_UTM_SOURCE',     label: 'UTM Source',              type: 'string'   },
  { code: 'UF_CRM_UTM_MEDIUM',     label: 'UTM Medium',              type: 'string'   },
  { code: 'UF_CRM_UTM_CAMPAIGN',   label: 'UTM Campaign',            type: 'string'   },
  { code: 'UF_CRM_LANDING_SITE',   label: 'Landing Site',            type: 'string'   },
  { code: 'UF_CRM_REFERRING_SITE', label: 'Referring Site',          type: 'string'   }
];

const DEAL_FIELDS = [
  { code: 'UF_CRM_UTM_SOURCE',     label: 'UTM Source',              type: 'string' },
  { code: 'UF_CRM_UTM_MEDIUM',     label: 'UTM Medium',              type: 'string' },
  { code: 'UF_CRM_UTM_CAMPAIGN',   label: 'UTM Campaign',            type: 'string' },
  { code: 'UF_CRM_UTM_TERM',       label: 'UTM Term',                type: 'string' },
  { code: 'UF_CRM_UTM_CONTENT',    label: 'UTM Content',             type: 'string' },
  { code: 'UF_CRM_LANDING_SITE',   label: 'Landing Site',            type: 'string' },
  { code: 'UF_CRM_REFERRING_SITE', label: 'Referring Site',          type: 'string' },
  { code: 'UF_CRM_DISCOUNT_CODE',  label: 'Discount Code',           type: 'string' },
  { code: 'UF_CRM_DISCOUNT',       label: 'Discount Amount',         type: 'string' },
  { code: 'UF_CRM_INVOICE_NUMBER', label: 'Invoice No.',             type: 'string' },
  { code: 'UF_CRM_INVOICE_URL',    label: 'Invoice URL',             type: 'string' },
  { code: 'UF_CRM_REFUND_STATUS',  label: 'Refund Status',           type: 'string' },
  { code: 'UF_CRM_REFUND_AMOUNT',  label: 'Refund Amount',           type: 'string' },
  { code: 'UF_CRM_FINANCIAL_STATUS',    label: 'Financial Status',       type: 'string' },
  { code: 'UF_CRM_FULFILLMENT_STATUS',  label: 'Fulfillment Status',     type: 'string' },
  { code: 'UF_CRM_ORDER_CHANNEL',       label: 'Order Channel',          type: 'string' },
  { code: 'UF_CRM_DELIVERY_METHOD',     label: 'Delivery Method',        type: 'string' },
  { code: 'UF_CRM_DELIVERY_STATUS',     label: 'Delivery Status',        type: 'string' }
];

const LEAD_FIELDS = [
  { code: 'UF_CRM_LEAD_SOURCE',    label: 'Lead Source',             type: 'string' },
  { code: 'UF_CRM_CART_TYPE',      label: 'Cart Type',               type: 'string' },
  { code: 'UF_CRM_CART_ID',        label: 'Shopify Cart ID',         type: 'string' },
  { code: 'UF_CRM_ABANDONED_URL',  label: 'Abandoned Checkout URL',  type: 'string' },
  { code: 'UF_CRM_CART_TOTAL',     label: 'Cart Total',              type: 'string' },
  { code: 'UF_CRM_UTM_SOURCE',     label: 'UTM Source',              type: 'string' },
  { code: 'UF_CRM_UTM_MEDIUM',     label: 'UTM Medium',              type: 'string' },
  { code: 'UF_CRM_UTM_CAMPAIGN',   label: 'UTM Campaign',            type: 'string' }
];

module.exports = { CONTACT_FIELDS, DEAL_FIELDS, LEAD_FIELDS };
