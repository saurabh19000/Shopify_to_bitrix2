const migrationService = require('../services/migration.service');
const { debug } = require('../utils/debugLogger');

/**
 * Migration Controller
 * Purpose: Handles HTTP POST requests for migrating Shopify Customers, Products,
 * and Orders into Bitrix24.
 */

/**
 * Endpoint to trigger Shopify Customers migration.
 * POST /migration/customers
 */
const migrateCustomers = async (req, res) => {
  debug('migration-controller', 'POST /migration/customers hit — starting customers migration');
  try {
    const result = await migrationService.migrateCustomers();
    const statusCode = result.success !== false ? 200 : 400;
    debug('migration-controller', `POST /migration/customers finished with ${statusCode}`, { summary: result });
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error('[Migration Controller] Customers migration failed:', error.message);
    debug('migration-controller', 'POST /migration/customers FAILED', { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Endpoint to trigger Shopify Products migration.
 * POST /migration/products
 */
const migrateProducts = async (req, res) => {
  debug('migration-controller', 'POST /migration/products hit — starting products migration');
  try {
    const result = await migrationService.migrateProducts();
    const statusCode = result.success !== false ? 200 : 400;
    debug('migration-controller', `POST /migration/products finished with ${statusCode}`, { summary: result });
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error('[Migration Controller] Products migration failed:', error.message);
    debug('migration-controller', 'POST /migration/products FAILED', { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Endpoint to trigger Shopify Orders migration.
 * POST /migration/orders
 */
const migrateOrders = async (req, res) => {
  debug('migration-controller', 'POST /migration/orders hit — starting orders migration');
  try {
    const result = await migrationService.migrateOrders();
    const statusCode = result.success !== false ? 200 : 400;
    debug('migration-controller', `POST /migration/orders finished with ${statusCode}`, { summary: result });
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error('[Migration Controller] Orders migration failed:', error.message);
    debug('migration-controller', 'POST /migration/orders FAILED', { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Endpoint to trigger all Shopify resources migration.
 * POST /migration/all
 */
const migrateAll = async (req, res) => {
  debug('migration-controller', 'POST /migration/all hit — starting FULL migration');
  try {
    const result = await migrationService.migrateAll();
    const statusCode = result.success !== false ? 200 : 400;
    debug('migration-controller', `POST /migration/all finished with ${statusCode}`, { summary: result });
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error('[Migration Controller] Full migration failed:', error.message);
    debug('migration-controller', 'POST /migration/all FAILED', { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  migrateCustomers,
  migrateProducts,
  migrateOrders,
  migrateAll
};
