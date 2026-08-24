const { bitrixCall } = require('../utils/bitrixClient');

async function syncProduct(shopifyProduct) {
  const shopifyId = String(shopifyProduct.id);
  const variants = shopifyProduct.variants || [{ id: shopifyProduct.id, price: '0', sku: '', title: 'Default' }];

  const results = [];

  for (const variant of variants) {
    const variantShopifyId = `${shopifyId}-${variant.id}`;
    const productName = variants.length > 1
      ? `${shopifyProduct.title} - ${variant.title}`
      : shopifyProduct.title;

    const existing = await bitrixCall('crm.product.list', {
      filter: { 'PROPERTY_SHOPIFY_ID': variantShopifyId },
      select: ['ID']
    });

    const fields = {
      NAME: productName,
      PRICE: parseFloat(variant.price) || 0,
      CURRENCY_ID: 'INR',
      ACTIVE: 'Y',
      CODE: variant.sku || variantShopifyId,
      PROPERTY_SHOPIFY_ID: variantShopifyId
    };

    if (existing.length > 0) {
      const productId = existing[0].ID;
      await bitrixCall('crm.product.update', { id: productId, fields });
      console.log(`Updated product ${productId} (${productName})`);
      results.push(productId);
    } else {
      const productId = await bitrixCall('crm.product.add', { fields });
      console.log(`Created product ${productId} (${productName})`);
      results.push(productId);
    }
  }

  return results;
}

module.exports = { syncProduct };
