require('dotenv').config();

// Override BEFORE services load: .env has PAY_SYSTEM_ID=1 which does NOT exist
// on this portal. Use 84 (PayU contact) which was confirmed present.
process.env.BITRIX_INVOICE_PAY_SYSTEM_ID = '84';

const bitrixService = require('./src/services/bitrix.service');
const leadService = require('./src/services/lead.service');
const invoiceService = require('./src/services/invoice.service');
const { getTenantConfig } = require('./src/utils/tenantContext');
const pool = require('./src/config/db.config');

const ts = Date.now();
const marker = `DUMMY_${ts}`;
const email = `dummy-${ts}@example.com`;
const SHOPIFY_CUSTOMER_ID = 900000000 + (ts % 1000000);
const SHOPIFY_CART_ID = 800000000 + (ts % 1000000);
const SHOPIFY_ORDER_ID = 700000000 + (ts % 1000000);
const ORDER_NUMBER = 70000 + (ts % 100000);

const post = async (method, payload) => {
  const { bitrixWebhookUrl } = getTenantConfig();
  const res = await fetch(bitrixWebhookUrl + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
};

let failures = 0;
const log = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

const created = { contact: null, deal: null, lead: null, invoice: null };

async function main() {
  console.log('========================================');
  console.log('DUMMY DATA END-TO-END TEST');
  console.log(`marker=${marker}  email=${email}`);
  console.log(`shopify customer=${SHOPIFY_CUSTOMER_ID} cart=${SHOPIFY_CART_ID} order=${SHOPIFY_ORDER_ID}`);
  console.log('========================================\n');

  // ---------- 1. CUSTOMER SYNC (CREATE) ----------
  console.log('--- 1. Customer sync (create) ---');
  const customer = {
    id: SHOPIFY_CUSTOMER_ID,
    email,
    first_name: 'Dummy',
    last_name: 'Test',
    phone: '+919999999999',
    tags: `dummy_test,${marker}`,
    note: `Dummy note ${marker}`,
    created_at: new Date().toISOString(),
    default_address: {
      address1: '100 Test St', city: 'Mumbai', province: 'MH', country: 'India',
      zip: '400001', company: 'Dummy Corp', phone: '+919999999999'
    }
  };
  created.contact = await bitrixService.createOrUpdateContact(customer, { skipLifetime: true });
  log(!!created.contact, `Contact created -> ID ${created.contact}`);

  let list = await post('crm.contact.list', {
    filter: { '=UF_CRM_SHOPIFY_ID': String(SHOPIFY_CUSTOMER_ID) },
    select: ['ID']
  });
  log((list.result || []).length === 1, `Exactly 1 contact with Shopify ID ${SHOPIFY_CUSTOMER_ID}`);

  const contact = await post('crm.contact.get', { id: created.contact });
  const c = contact.result || {};
  log(c.NAME === 'Dummy' && c.LAST_NAME === 'Test', `Contact fields set (NAME=${c.NAME} LAST_NAME=${c.LAST_NAME})`);
  log((c.UF_CRM_CUSTOMER_TAGS || '').includes(marker), `Tags synced (UF_CRM_CUSTOMER_TAGS="${c.UF_CRM_CUSTOMER_TAGS}")`);
  log(c.UF_CRM_CUSTOMER_NOTE === customer.note, `Note synced (UF_CRM_CUSTOMER_NOTE="${c.UF_CRM_CUSTOMER_NOTE}")`);

  // ---------- 2. CUSTOMER RE-SEND (NO DUPLICATE) ----------
  console.log('\n--- 2. Customer re-send (no duplicate) ---');
  customer.last_name = 'Test2';
  const contactId2 = await bitrixService.createOrUpdateContact(customer, { skipLifetime: true });
  list = await post('crm.contact.list', {
    filter: { '=UF_CRM_SHOPIFY_ID': String(SHOPIFY_CUSTOMER_ID) },
    select: ['ID']
  });
  log(String(contactId2) === String(created.contact) && (list.result || []).length === 1,
    `Re-send updated same contact ${contactId2} (no duplicate)`);

  // ---------- 3. ABANDONED CART LEAD ----------
  console.log('\n--- 3. Abandoned cart -> lead ---');
  const cart = {
    id: SHOPIFY_CART_ID,
    email,
    abandoned_checkout_url: 'https://checkout.example.com/123/checkouts/dummy',
    total_price: '250.00',
    subtotal_price: '220.00',
    landing_site: 'https://store.example.com/products/widget?utm_source=google&utm_medium=cpc&utm_campaign=spring',
    line_items: [{ title: 'Dummy Widget', quantity: 2, price: '110.00' }]
  };
  created.lead = await leadService.syncLeadFromCart(cart, {});
  log(!!created.lead, `Abandoned cart lead created -> ID ${created.lead}`);

  let lead = await post('crm.lead.get', { id: created.lead });
  let l = lead.result || {};
  log((l.TITLE || '').includes('Abandoned Cart'), `Lead title="${l.TITLE}"`);
  log(l.UF_CRM_CART_TYPE === 'abandoned' && String(l.UF_CRM_CART_ID) === String(SHOPIFY_CART_ID),
    `Lead cart type/id synced (${l.UF_CRM_CART_TYPE} / ${l.UF_CRM_CART_ID})`);
  log(l.UF_CRM_UTM_SOURCE === 'google' && l.UF_CRM_UTM_CAMPAIGN === 'spring',
    `Lead UTMs synced (source=${l.UF_CRM_UTM_SOURCE} campaign=${l.UF_CRM_UTM_CAMPAIGN})`);
  log(String(l.CONTACT_ID) === String(created.contact), `Lead linked to contact ${l.CONTACT_ID}`);

  // re-send cart -> update, not duplicate
  await leadService.syncLeadFromCart({ ...cart, total_price: '300.00' }, {});
  const leads = await post('crm.lead.list', {
    filter: { '=UF_CRM_CART_ID': String(SHOPIFY_CART_ID) },
    select: ['ID']
  });
  log((leads.result || []).length === 1, `Cart re-send -> 1 lead only (no duplicate)`);

  // ---------- 4. ORDER -> DEAL ----------
  console.log('\n--- 4. Order -> deal ---');
  const order = {
    id: SHOPIFY_ORDER_ID,
    order_number: ORDER_NUMBER,
    name: `#${ORDER_NUMBER}`,
    email,
    total_price: '299.00',
    subtotal_price: '250.00',
    total_tax: '25.00',
    total_discounts: '10.00',
    total_refunded: '0.00',
    currency: 'INR',
    financial_status: 'paid',
    fulfillment_status: 'unfulfilled',
    source_name: 'web',
    tags: 'dummy-test',
    note: 'Dummy order',
    landing_site: 'https://store.example.com/?utm_source=facebook&utm_medium=cpc&utm_campaign=launch&utm_term=ad1&utm_content=cta',
    referring_site: 'https://facebook.com',
    discount_applications: [{ code: 'DUMMY10', target_selection: 'line_item' }],
    payment_gateway_names: ['PayU'],
    shipping_lines: [{ title: 'Express', price: '20.00' }],
    shipping_address: { address1: '100 Test St', city: 'Mumbai', province: 'MH', country: 'India', zip: '400001' },
    billing_address: { address1: '100 Test St', city: 'Mumbai', province: 'MH', country: 'India', zip: '400001' },
    created_at: new Date().toISOString(),
    closed_at: null,
    customer: { id: SHOPIFY_CUSTOMER_ID, email, first_name: 'Dummy', last_name: 'Test', phone: '+919999999999' },
    line_items: [{ title: 'Dummy Widget', price: '250.00', quantity: 1 }]
  };
  created.deal = await bitrixService.createOrUpdateDeal(order, { skipLifetime: true });
  log(!!created.deal, `Deal created -> ID ${created.deal}`);

  const deal = await post('crm.deal.get', { id: created.deal });
  const d = deal.result || {};
  log(d.TITLE === `Order #${ORDER_NUMBER}`, `Deal title="${d.TITLE}"`);
  log(Number(d.OPPORTUNITY) === 299 && d.CURRENCY_ID === 'INR', `Deal amount/currency (${d.OPPORTUNITY} ${d.CURRENCY_ID})`);
  log(d.STAGE_ID === 'WON', `Deal stage WON for paid order (stage=${d.STAGE_ID})`);
  log(d.UF_CRM_UTM_SOURCE === 'facebook' && d.UF_CRM_UTM_CAMPAIGN === 'launch' && d.UF_CRM_UTM_TERM === 'ad1',
    `Deal UTMs synced (source=${d.UF_CRM_UTM_SOURCE} campaign=${d.UF_CRM_UTM_CAMPAIGN} term=${d.UF_CRM_UTM_TERM})`);
  log(d.UF_CRM_LANDING_SITE.includes('store.example.com') && d.UF_CRM_REFERRING_SITE === 'https://facebook.com',
    `Deal landing/referring synced`);
  log(d.UF_CRM_DISCOUNT_CODE === 'DUMMY10' && Number(d.UF_CRM_DISCOUNT) === 10, `Discount info synced (${d.UF_CRM_DISCOUNT_CODE} / ${d.UF_CRM_DISCOUNT})`);
  log(String(d.CONTACT_ID) === String(created.contact), `Deal linked to contact ${d.CONTACT_ID}`);

  // re-send order -> no duplicate
  const dealId2 = await bitrixService.createOrUpdateDeal(order, { skipLifetime: true });
  log(String(dealId2) === String(created.deal), `Order re-send -> same deal ${dealId2} (no duplicate)`);

  // product rows check — rows must sum to the order total (299)
  const rows = await post('crm.deal.productrows.get', { id: created.deal });
  const rowList = rows.result || [];
  const rowSum = rowList.reduce((s, r) => s + Number(r.PRICE) * Number(r.QUANTITY), 0);
  log(rowList.some(r => r.PRODUCT_NAME === 'Dummy Widget') && Math.abs(rowSum - 299) < 0.01,
    `Product rows sum to 299.00 (rows: ${rowList.map(r => r.PRODUCT_NAME).join(' + ')})`);

  // ---------- 5. INVOICE ----------
  console.log('\n--- 5. Invoice sync ---');
  const inv = await invoiceService.syncInvoice(order, created.deal, {});
  if (inv.invoiceId) {
    created.invoice = inv.invoiceId;
    log(true, `Smart Invoice created -> ID ${inv.invoiceId}`);
    const invGet = await post('crm.item.get', { entityTypeId: 31, id: inv.invoiceId });
    const iv = invGet.result && invGet.result.item ? invGet.result.item : (invGet.result || {});
    log(Number(iv.opportunity) === 299 && iv.currencyId === 'INR',
      `Invoice amount/currency (${iv.opportunity} ${iv.currencyId})`);
    log(String(iv.contactId) === String(created.contact), `Invoice linked to contact ${iv.contactId}`);
  } else {
    log(false, `Invoice sync: ${JSON.stringify(inv)}`);
  }

  // ---------- 6. REFUND PATH (financial_status update via applyRefund) ----------
  console.log('\n--- 6. Refund status path ---');
  const refundPayload = {
    order: { id: SHOPIFY_ORDER_ID, order_number: ORDER_NUMBER, financial_status: 'refunded' },
    total_refund: '299.00',
    note: 'Dummy refund test'
  };
  const refundDeal = await bitrixService.applyRefund(refundPayload);
  const dealAfter = await post('crm.deal.get', { id: created.deal });
  const dr = dealAfter.result || {};
  log(String(refundDeal) === String(created.deal) && dr.STAGE_ID === 'LOSE' && dr.UF_CRM_REFUND_STATUS === 'Fully Refunded',
    `Refund applied (stage=${dr.STAGE_ID} status=${dr.UF_CRM_REFUND_STATUS} amount=${dr.UF_CRM_REFUND_AMOUNT})`);

  // ---------- 7. CLEANUP ----------
  console.log('\n--- 7. Cleanup ---');
  const cleanupCalls = [];
  if (created.invoice) cleanupCalls.push(['crm.item.delete', created.invoice, 'smart-invoice', { entityTypeId: 31, id: created.invoice }]);
  if (created.deal) cleanupCalls.push(['crm.deal.delete', created.deal, 'deal', { id: created.deal }]);
  if (created.lead) cleanupCalls.push(['crm.lead.delete', created.lead, 'lead', { id: created.lead }]);
  if (created.contact) cleanupCalls.push(['crm.contact.delete', created.contact, 'contact', { id: created.contact }]);

  for (const [method, id, label, payload] of cleanupCalls) {
    const r = await post(method, payload);
    console.log(`  ${label} ${id}: ${r.result === true || r.result ? 'deleted' : JSON.stringify(r.error || r)}`);
  }

  const mapRows = await pool.query(
    `DELETE FROM id_map WHERE shopify_id IN ($1, $2, $3) RETURNING type, shopify_id, bitrix_id`,
    [String(SHOPIFY_CUSTOMER_ID), String(SHOPIFY_CART_ID), String(SHOPIFY_ORDER_ID)]
  );
  console.log(`  id_map cleaned: ${mapRows.rowCount} row(s)`);
  await pool.end();

  // ---------- SUMMARY ----------
  console.log('\n========================================');
  console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} CHECK(S) FAILED`);
  console.log('========================================');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
