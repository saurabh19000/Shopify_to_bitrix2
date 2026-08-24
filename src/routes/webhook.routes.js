/**
 * Webhook Routes
 * Purpose: Defines Express router endpoints for handling Shopify webhooks
 * and maps them to the appropriate webhook controller methods.
 */

const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// Route for customer-related webhooks
router.post('/customer', webhookController.handleCustomerWebhook);

// Route for product-related webhooks
router.post('/product', webhookController.handleProductWebhook);

// Route for order-related webhooks
router.post('/order', webhookController.handleOrderWebhook);

module.exports = router;
