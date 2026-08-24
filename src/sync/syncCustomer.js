const { bitrixCall } = require('../utils/bitrixClient');

async function syncCustomer(shopifyCustomer) {
  const shopifyId = String(shopifyCustomer.id);

  // Check if contact already exists
  const existing = await bitrixCall('crm.contact.list', {
    filter: { UF_CRM_SHOPIFY_ID: shopifyId },
    select: ['ID']
  });

  const fields = {
    NAME: shopifyCustomer.first_name || '',
    LAST_NAME: shopifyCustomer.last_name || '',
    EMAIL: shopifyCustomer.email ? [{ VALUE: shopifyCustomer.email, VALUE_TYPE: 'WORK' }] : [],
    PHONE: shopifyCustomer.phone ? [{ VALUE: shopifyCustomer.phone, VALUE_TYPE: 'WORK' }] : [],
    UF_CRM_SHOPIFY_ID: shopifyId
  };

  if (existing.length > 0) {
    const contactId = existing[0].ID;
    await bitrixCall('crm.contact.update', { id: contactId, fields });
    console.log(`Updated contact ${contactId} for Shopify customer ${shopifyId}`);
    return contactId;
  } else {
    const contactId = await bitrixCall('crm.contact.add', { fields });
    console.log(`Created contact ${contactId} for Shopify customer ${shopifyId}`);
    return contactId;
  }
}

module.exports = { syncCustomer };
