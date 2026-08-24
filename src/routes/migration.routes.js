const express = require('express');
const router = express.Router();
const migrationController = require('../controllers/migration.controller');

/**
 * Migration Routes
 * Purpose: Exposes endpoints for executing historical data migration
 * from Shopify to Bitrix24.
 */

// Route to migrate customers only
router.post('/customers', migrationController.migrateCustomers);

// Route to migrate products only
router.post('/products', migrationController.migrateProducts);

// Route to migrate orders only
router.post('/orders', migrationController.migrateOrders);

// Route to migrate customers, products, and orders in order
router.post('/all', migrationController.migrateAll);

module.exports = router;
