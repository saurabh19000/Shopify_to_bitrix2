require('dotenv').config();
const axios = require('axios');
const shopifyService = require('../src/services/shopify.service');
const { getMappingWithFallback, setMapping, getShopifyIdByBitrixId } = require('../src/utils/idMapStore');
const bitrixService = require('../src/services/bitrix.service');

/**
 * Pull Bitrix entities modified since a given date and push to Shopify.
 * Supports: contacts, deals (orders), products.
 *
 * Usage:
 *   node scripts/syncBitrixToShopify.js
 *   node scripts/syncBitrixToShopify.js "2026-08-01T00:00:00"
 *   node scripts/syncBitrixToShopify.js --contacts
 *   node scripts/syncBitrixToShopify.js --deals
 *   node scripts/syncBitrixToShopify.js --products
 *   node scripts/syncBitrixToShopify.js --all
 */
const post = async (webhookUrl, method, payload) => {
  const url = `${webhookUrl}${method}`;
  const res = await axios.post(url, payload);
  return res.data;
};

const extractFirstValue = (val) => {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val) && val.length > 0) {
    const item = val[0];
    return typeof item === 'string' ? item.trim() : (item?.VALUE || item?.value || '').trim();
  }
  if (typeof val === 'object') return (val.VALUE || val.value || '').trim();
  return String(val).trim();
};

const syncContacts = async (since, shopDomain, accessToken, webhookUrl) => {
  console.log('\n=== Syncing Contacts (Bitrix -> Shopify) ===');
  const filter = {};
  if (since) filter[">DATE_MODIFY"] = since;

  let start = 0, pushed = 0, created = 0, skipped = 0;
  while (true) {
    const data = await post(webhookUrl, 'crm.contact.list', {
      filter,
      select: ["ID", "NAME", "LAST_NAME", "EMAIL", "PHONE", "TAG", "UF_CRM_SHOPIFY_ID", "UF_CRM_CUSTOMER_NOTE", "UF_CRM_CUSTOMER_TAGS", "DATE_MODIFY", "ADDRESS", "ADDRESS_CITY", "ADDRESS_PROVINCE", "ADDRESS_COUNTRY", "ADDRESS_POSTAL_CODE", "COMPANY_TITLE"],
      start
    });
    const contacts = data.result || [];
    if (contacts.length === 0) break;

    for (const contact of contacts) {
      let shopifyId = contact.UF_CRM_SHOPIFY_ID;
      if (!shopifyId) {
        shopifyId = await getShopifyIdByBitrixId('contacts', contact.ID);
      }

      const email = extractFirstValue(contact.EMAIL);
      const phone = extractFirstValue(contact.PHONE);

      try {
        if (shopifyId) {
          await shopifyService.updateCustomerByFields(shopifyId, contact, shopDomain, accessToken);
          pushed++;
          console.log(`  Updated contact ${contact.ID} -> Shopify customer ${shopifyId}`);
        } else {
          // Check if exists by email/phone in Shopify
          let existing = null;
          if (email) existing = await shopifyService.findShopifyCustomerByEmail(email, shopDomain, accessToken);
          if (!existing && phone) existing = await shopifyService.findShopifyCustomerByPhone(phone, shopDomain, accessToken);

          if (existing) {
            await bitrixService.updateContact(contact.ID, { UF_CRM_SHOPIFY_ID: String(existing.id) });
            await shopifyService.updateCustomerByFields(existing.id, contact, shopDomain, accessToken);
            await setMapping('contacts', existing.id, contact.ID);
            pushed++;
            console.log(`  Linked & updated contact ${contact.ID} -> existing Shopify customer ${existing.id}`);
          } else {
            const newCust = await shopifyService.createShopifyCustomer(contact, shopDomain, accessToken);
            if (newCust) {
              await bitrixService.updateContact(contact.ID, { UF_CRM_SHOPIFY_ID: String(newCust.id) });
              await setMapping('contacts', newCust.id, contact.ID);
              created++;
              console.log(`  Created contact ${contact.ID} -> brand new Shopify customer ${newCust.id}`);
            } else {
              skipped++;
            }
          }
        }
      } catch (err) {
        console.error(`  Failed contact ${contact.ID}:`, err.message);
      }
    }
    const next = data.next;
    if (!next) break;
    start = next;
  }
  console.log(`Contacts done. Updated: ${pushed}, Created: ${created}, Skipped: ${skipped}`);
};

const syncDeals = async (since, shopDomain, accessToken, webhookUrl) => {
  console.log('\n=== Syncing Deals/Orders (Bitrix -> Shopify) ===');
  const filter = {};
  if (since) filter[">DATE_MODIFY"] = since;

  let start = 0, pushed = 0, skipped = 0;
  while (true) {
    const data = await post(webhookUrl, 'crm.deal.list', {
      filter,
      select: ["ID", "TITLE", "COMMENTS", "UF_CRM_FINANCIAL_STATUS", "UF_CRM_FULFILLMENT_STATUS", "DATE_MODIFY"],
      start
    });
    const deals = data.result || [];
    if (deals.length === 0) break;

    for (const deal of deals) {
      let shopifyOrderId = await getMappingWithFallback('deals_reverse', deal.ID);
      if (!shopifyOrderId) {
        shopifyOrderId = await getShopifyIdByBitrixId('deals', deal.ID);
      }
      if (!shopifyOrderId) { skipped++; continue; }

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

      if (Object.keys(updateFields).length === 0) { skipped++; continue; }

      try {
        await shopifyService.updateShopifyOrder(shopifyOrderId, updateFields, shopDomain, accessToken);
        pushed++;
        console.log(`  Pushed deal ${deal.ID} -> Shopify order ${shopifyOrderId}`);
      } catch (err) {
        console.error(`  Failed deal ${deal.ID}:`, err.message);
      }
    }
    const next = data.next;
    if (!next) break;
    start = next;
  }
  console.log(`Deals done. Pushed: ${pushed}, skipped: ${skipped}`);
};

const syncProducts = async (since, shopDomain, accessToken, webhookUrl) => {
  console.log('\n=== Syncing Products (Bitrix -> Shopify) ===');
  const filter = {};
  if (since) filter[">DATE_MODIFY"] = since;

  let start = 0, pushed = 0, created = 0, skipped = 0;
  while (true) {
    const data = await post(webhookUrl, 'crm.product.list', {
      filter,
      select: ["ID", "NAME", "DESCRIPTION", "PRICE", "VENDOR", "CODE", "DATE_MODIFY"],
      start
    });
    const products = data.result || [];
    if (products.length === 0) break;

    for (const product of products) {
      let shopifyProductId = await getShopifyIdByBitrixId('products', product.ID);
      if (!shopifyProductId) {
        shopifyProductId = await getMappingWithFallback('products', product.ID);
      }

      const updateFields = {};
      if (product.NAME) updateFields.title = product.NAME;
      if (product.DESCRIPTION !== undefined) updateFields.body_html = product.DESCRIPTION || '';
      if (product.VENDOR !== undefined) updateFields.vendor = product.VENDOR;
      if (product.PRICE !== undefined) {
        updateFields.variants = [{ price: parseFloat(product.PRICE) }];
      }

      try {
        if (shopifyProductId) {
          if (Object.keys(updateFields).length === 0) { skipped++; continue; }
          await shopifyService.updateShopifyProduct(shopifyProductId, updateFields, shopDomain, accessToken);
          pushed++;
          console.log(`  Updated product ${product.ID} -> Shopify product ${shopifyProductId}`);
        } else {
          const newProd = await shopifyService.createShopifyProduct(product, shopDomain, accessToken);
          if (newProd) {
            await setMapping('products', String(newProd.id), String(product.ID));
            await setMapping('products_reverse', String(product.ID), String(newProd.id));
            created++;
            console.log(`  Created product ${product.ID} -> brand new Shopify product ${newProd.id}`);
          } else {
            skipped++;
          }
        }
      } catch (err) {
        console.error(`  Failed product ${product.ID}:`, err.message);
      }
    }
    const next = data.next;
    if (!next) break;
    start = next;
  }
  console.log(`Products done. Updated: ${pushed}, Created: ${created}, Skipped: ${skipped}`);
};

const run = async () => {
  const webhookUrl = process.env.BITRIX_WEBHOOK_URL;
  const shopDomain = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!webhookUrl || webhookUrl.includes('xxxxxxxxxxxxxxxx')) {
    console.error('BITRIX_WEBHOOK_URL is not configured in .env.'); process.exit(1);
  }
  if (!shopDomain || !accessToken) {
    console.error('Shopify credentials not configured in .env.'); process.exit(1);
  }

  const sinceArg = process.argv[2] || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const mode = process.argv.find(a => a.startsWith('--')) || '--all';

  if (mode === '--contacts' || mode === '--all') await syncContacts(sinceArg, shopDomain, accessToken, webhookUrl);
  if (mode === '--deals' || mode === '--all') await syncDeals(sinceArg, shopDomain, accessToken, webhookUrl);
  if (mode === '--products' || mode === '--all') await syncProducts(sinceArg, shopDomain, accessToken, webhookUrl);

  console.log('\nAll sync complete.');
};

run().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
