const bitrixService = require('../services/bitrix.service');

/**
 * Webhook Controller
 * Purpose: Receives incoming webhooks from Shopify, prints webhook headers and payloads,
 * initiates asynchronous CRM syncs to Bitrix24, and returns HTTP 200 immediately.
 */

/**
 * Handles Shopify Customer creation/update webhooks.
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 */
const handleCustomerWebhook = (req, res) => {
  const eventType = 'Customer';
  const shopifyTopic = req.headers['x-shopify-topic'] || 'N/A';
  const shopifyShopDomain = req.headers['x-shopify-shop-domain'] || 'N/A';
  const shopifyWebhookId = req.headers['x-shopify-webhook-id'] || 'N/A';

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
      const contactId = await bitrixService.createContact(req.body);
      console.log(`Bitrix Contact Created: ${contactId}`);
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
 * Handles Shopify Product creation/update webhooks.
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 */
const handleProductWebhook = (req, res) => {
  const eventType = 'Product';
  const shopifyTopic = req.headers['x-shopify-topic'] || 'N/A';
  const shopifyShopDomain = req.headers['x-shopify-shop-domain'] || 'N/A';
  const shopifyWebhookId = req.headers['x-shopify-webhook-id'] || 'N/A';

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
      const productId = await bitrixService.createProduct(req.body);
      console.log(`Bitrix Product Created: ${productId}`);
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
 * Handles Shopify Order creation/update webhooks.
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 */
const handleOrderWebhook = (req, res) => {
  const eventType = 'Order';
  const shopifyTopic = req.headers['x-shopify-topic'] || 'N/A';
  const shopifyShopDomain = req.headers['x-shopify-shop-domain'] || 'N/A';
  const shopifyWebhookId = req.headers['x-shopify-webhook-id'] || 'N/A';

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
      const dealId = await bitrixService.createDeal(req.body);
      console.log(`Bitrix Deal Created: ${dealId}`);
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
