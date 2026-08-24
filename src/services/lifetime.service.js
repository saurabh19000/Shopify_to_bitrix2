const shopifyService = require('./shopify.service');
const bitrixService = require('./bitrix.service');
const attributionService = require('./attribution.service');
const config = require('../config/bitrix.config');
const { debug } = require('../utils/debugLogger');

/**
 * Compute lifetime metrics from a list of orders.
 */
const computeLifetime = (orders) => {
  const list = orders || [];
  const totalOrders = list.length;
  const totalSpend = list.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const lastPurchase = list
    .map((o) => o.created_at)
    .filter(Boolean)
    .sort()
    .pop() || '';
  const aov = totalOrders > 0 ? totalSpend / totalOrders : 0;

  const metrics = {
    totalOrders,
    totalSpend: Number(totalSpend.toFixed(2)),
    lastPurchase,
    aov: Number(aov.toFixed(2))
  };
  debug('lifetime', `computeLifetime: computed from ${totalOrders} order(s)`, metrics);
  return metrics;
};

/**
 * Recompute lifetime metrics + latest attribution for a Shopify customer and
 * write them to the linked Bitrix contact. No-op when COMPUTE_LIFETIME is off.
 */
const refreshContactLifetime = async (shopifyCustomerId, opts) => {
  debug('lifetime', `refreshContactLifetime: START customer=${shopifyCustomerId}`, { hasOpts: Boolean(opts) });
  if (!shopifyCustomerId) return null;
  if (!config.computeLifetime) {
    debug('lifetime', `refreshContactLifetime: SKIPPED — COMPUTE_LIFETIME is off`);
    return null;
  }

  const { shopDomain, accessToken } = opts || {};
  if (!shopDomain || !accessToken) {
    debug('lifetime', `refreshContactLifetime: SKIPPED — missing shopDomain/accessToken in opts`);
    return null;
  }

  try {
    const orders = await shopifyService.getCustomerOrders(shopifyCustomerId, shopDomain, accessToken);
    const metrics = computeLifetime(orders);
    debug('lifetime', `refreshContactLifetime: computed metrics for ${shopifyCustomerId}`, metrics);

    const latest = [...orders].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
    const att = latest ? attributionService.extractAttribution(latest) : {};

    const contactId = await bitrixService.findContactByShopifyId(shopifyCustomerId);
    if (!contactId) {
      debug('lifetime', `refreshContactLifetime: no Bitrix contact found for ${shopifyCustomerId} -> nothing written`);
      return null;
    }

    const fields = {
      UF_CRM_TOTAL_ORDERS: metrics.totalOrders,
      UF_CRM_TOTAL_SPEND: metrics.totalSpend ? String(metrics.totalSpend) : '',
      UF_CRM_LAST_PURCHASE: metrics.lastPurchase || '',
      UF_CRM_AOV: metrics.aov ? String(metrics.aov) : '',
      UF_CRM_UTM_SOURCE: att.utm_source || '',
      UF_CRM_UTM_MEDIUM: att.utm_medium || '',
      UF_CRM_UTM_CAMPAIGN: att.utm_campaign || '',
      UF_CRM_LANDING_SITE: att.landing_site || '',
      UF_CRM_REFERRING_SITE: att.referring_site || ''
    };

    await bitrixService.updateContact(contactId, fields);
    console.log(`[Lifetime] Refreshed contact ${contactId} for Shopify customer ${shopifyCustomerId}: ${metrics.totalOrders} orders, ${metrics.totalSpend} total, AOV ${metrics.aov}`);
    return { contactId, metrics };
  } catch (err) {
    console.error(`[Lifetime] Refresh failed for customer ${shopifyCustomerId}:`, err.message);
    debug('lifetime', `refreshContactLifetime: FAILED for ${shopifyCustomerId}`, { error: err.message });
    return null;
  }
};

module.exports = { computeLifetime, refreshContactLifetime };
