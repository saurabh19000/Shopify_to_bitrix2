const bitrixService = require('../services/bitrix.service');
const { getMappingWithFallback, deleteMapping } = require('../utils/idMapStore');
const { recordSync, isEchoLoop } = require('../utils/syncTracker');
const { debug } = require('../utils/debugLogger');

/**
 * Webhook Controller
 * Purpose: Receives incoming webhooks from Shopify, prints webhook headers and payloads,
 * initiates asynchronous CRM syncs to Bitrix24 (creates, updates, and deletes),
 * and returns HTTP 200 immediately.
 */

/**
 * Handles Shopify Customer creation/update/delete webhooks.
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 */
const handleCustomerWebhook = (req, res) => {
  const eventType = 'Customer';
  const shopifyTopic = (req.headers['x-shopify-topic'] || '').toLowerCase();
  const shopifyShopDomain = req.headers['x-shopify-shop-domain'] || 'N/A';
  const shopifyWebhookId = req.headers['x-shopify-webhook-id'] || 'N/A';
  const customerId = req.body?.id ? String(req.body.id) : null;

  console.log('--- Webhook Received ---');
  console.log(`Event Type:           ${eventType}`);
  console.log(`Shopify Topic:        ${shopifyTopic}`);
  console.log(`Shopify Shop Domain:  ${shopifyShopDomain}`);
  console.log(`Shopify Webhook ID:   ${shopifyWebhookId}`);
  console.log('Complete JSON Payload:');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('--------------------------------------');

  // Return HTTP 200 immediately to Shopify to prevent timeouts/retries
  res.status(200).json({
    success: true,
    message: "Webhook received successfully"
  });

  // Execute Bitrix24 CRM sync asynchronously in the background
  (async () => {
    try {
      if (shopifyTopic.includes('delete') || shopifyTopic === 'customers/delete') {
        console.log(`[Shopify->Bitrix] Processing customer deletion for Shopify ID: ${customerId}`);
        let bitrixContactId = customerId ? await getMappingWithFallback('contacts', customerId) : null;
        if (!bitrixContactId && req.body?.email) {
          const contact = await bitrixService.findContactByEmail(req.body.email);
          if (contact) bitrixContactId = contact.ID;
        }
        if (!bitrixContactId && customerId) {
          const contact = await bitrixService.findContactByShopifyId(customerId);
          if (contact) bitrixContactId = contact.ID;
        }

        if (bitrixContactId) {
          recordSync('SHOPIFY_TO_BITRIX', 'contact', bitrixContactId);
          await bitrixService.deleteContact(bitrixContactId);
          if (customerId) await deleteMapping('contacts', customerId);
          await deleteMapping('contacts', bitrixContactId);
          console.log(`✅ Bitrix Contact ${bitrixContactId} deleted for Shopify customer ${customerId}`);
        } else {
          console.log(`[Shopify->Bitrix] No matching Bitrix contact found for deleted Shopify customer ${customerId}`);
        }
        return;
      }

      // Customer Create or Update
      const contactId = await bitrixService.createContact(req.body);
      console.log(`Bitrix Contact Created/Updated: ${contactId}`);
    } catch (error) {
      console.error('--- Bitrix24 Sync Error (Contact) ---');
      if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error('Message:', error.message);
      }
    }
  })();
};

/**
 * Handles Shopify Product creation/update/delete webhooks.
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 */
const handleProductWebhook = (req, res) => {
  const eventType = 'Product';
  const shopifyTopic = (req.headers['x-shopify-topic'] || '').toLowerCase();
  const shopifyShopDomain = req.headers['x-shopify-shop-domain'] || 'N/A';
  const shopifyWebhookId = req.headers['x-shopify-webhook-id'] || 'N/A';
  const productId = req.body?.id ? String(req.body.id) : null;

  console.log('--- Webhook Received ---');
  console.log(`Event Type:           ${eventType}`);
  console.log(`Shopify Topic:        ${shopifyTopic}`);
  console.log(`Shopify Shop Domain:  ${shopifyShopDomain}`);
  console.log(`Shopify Webhook ID:   ${shopifyWebhookId}`);
  console.log('Complete JSON Payload:');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('--------------------------------------');

  // Return HTTP 200 immediately to Shopify to prevent timeouts/retries
  res.status(200).json({
    success: true,
    message: "Webhook received successfully"
  });

  // Execute Bitrix24 CRM sync asynchronously in the background
  (async () => {
    try {
      if (shopifyTopic.includes('delete') || shopifyTopic === 'products/delete') {
        console.log(`[Shopify->Bitrix] Processing product deletion for Shopify ID: ${productId}`);
        let bitrixProductId = productId ? await getMappingWithFallback('products', productId) : null;
        if (!bitrixProductId && req.body?.title) {
          const prod = await bitrixService.findProductByName(req.body.title);
          if (prod) bitrixProductId = prod.ID;
        }

        if (bitrixProductId) {
          recordSync('SHOPIFY_TO_BITRIX', 'product', bitrixProductId);
          await bitrixService.deleteProductById(bitrixProductId);
          if (productId) await deleteMapping('products', productId);
          await deleteMapping('products', bitrixProductId);
          console.log(`✅ Bitrix Product ${bitrixProductId} deleted for Shopify product ${productId}`);
        } else {
          console.log(`[Shopify->Bitrix] No matching Bitrix product found for deleted Shopify product ${productId}`);
        }
        return;
      }

      // Product Create or Update
      const bitrixProdId = await bitrixService.createProduct(req.body);
      console.log(`Bitrix Product Created/Updated: ${bitrixProdId}`);
    } catch (error) {
      console.error('--- Bitrix24 Sync Error (Product) ---');
      if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error('Message:', error.message);
      }
    }
  })();
};

/**
 * Handles Shopify Order creation/update/delete webhooks.
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 */
const handleOrderWebhook = (req, res) => {
  const eventType = 'Order';
  const shopifyTopic = (req.headers['x-shopify-topic'] || '').toLowerCase();
  const shopifyShopDomain = req.headers['x-shopify-shop-domain'] || 'N/A';
  const shopifyWebhookId = req.headers['x-shopify-webhook-id'] || 'N/A';
  const orderId = req.body?.id ? String(req.body.id) : null;

  console.log('--- Webhook Received ---');
  console.log(`Event Type:           ${eventType}`);
  console.log(`Shopify Topic:        ${shopifyTopic}`);
  console.log(`Shopify Shop Domain:  ${shopifyShopDomain}`);
  console.log(`Shopify Webhook ID:   ${shopifyWebhookId}`);
  console.log('Complete JSON Payload:');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('--------------------------------------');

  // Return HTTP 200 immediately to Shopify to prevent timeouts/retries
  res.status(200).json({
    success: true,
    message: "Webhook received successfully"
  });

  // Execute Bitrix24 CRM sync asynchronously in the background
  (async () => {
    try {
      if (shopifyTopic.includes('delete') || shopifyTopic === 'orders/delete') {
        console.log(`[Shopify->Bitrix] Processing order deletion for Shopify Order ID: ${orderId}`);
        let bitrixDealId = orderId ? await getMappingWithFallback('deals', orderId) : null;
        if (!bitrixDealId && (req.body?.order_number || req.body?.name)) {
          const num = req.body.order_number || String(req.body.name).replace(/\D/g, '');
          const deal = await bitrixService.findDealByOrderNumber(num);
          if (deal) bitrixDealId = deal.ID;
        }

        if (bitrixDealId) {
          recordSync('SHOPIFY_TO_BITRIX', 'deal', bitrixDealId);
          await bitrixService.deleteDealById(bitrixDealId);
          if (orderId) await deleteMapping('deals', orderId);
          await deleteMapping('deals', bitrixDealId);
          await deleteMapping('deals_reverse', bitrixDealId);
          console.log(`✅ Bitrix Deal ${bitrixDealId} deleted for Shopify order ${orderId}`);
        } else {
          console.log(`[Shopify->Bitrix] No matching Bitrix deal found for deleted Shopify order ${orderId}`);
        }
        return;
      }

      // Order Create, Update, Paid, Fulfilled, Cancelled
      const dealId = await bitrixService.createDeal(req.body);
      console.log(`Bitrix Deal Created/Updated: ${dealId}`);
    } catch (error) {
      console.error('--- Bitrix24 Sync Error (Deal) ---');
      if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error('Message:', error.message);
      }
    }
  })();
};

module.exports = {
  handleCustomerWebhook,
  handleProductWebhook,
  handleOrderWebhook
};
