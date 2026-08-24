const axios = require('axios');
const { CONTACT_FIELDS, DEAL_FIELDS, LEAD_FIELDS } = require('../config/uf.config');

/**
 * Create Bitrix24 UF_CRM_* custom fields on any portal (idempotent).
 * Shared by scripts/createCustomFields.js and the /admin/onboard endpoint.
 */

const post = async (webhookUrl, method, payload) => {
  const res = await axios.post(`${webhookUrl}${method}`, payload);
  return res.data;
};

const entityName = (entity) => ({ contact: 'Contact', deal: 'Deal', lead: 'Lead' }[entity]);

const createFields = async (webhookUrl, entity, fields) => {
  const summary = { entity: entityName(entity), created: 0, existing: 0, failed: 0, details: [] };
  for (const field of fields) {
    try {
      const res = await post(webhookUrl, `crm.${entity}.userfield.add`, {
        fields: {
          FIELD_NAME: field.code,
          USER_TYPE_ID: field.type,
          LABEL: field.label,
          LIST_COLUMN_LABEL: { en: field.label },
          EDIT_FORM_LABEL: { en: field.label },
          LIST_FILTER_LABEL: { en: field.label },
          SHOW_FILTER: 'Y',
          SHOW_IN_LIST: 'Y',
          EDIT_IN_LIST: 'Y',
          IS_SEARCHABLE: 'Y',
          MULTIPLE: 'N',
          MANDATORY: 'N'
        }
      });
      if (res.result && !res.error) {
        summary.created++;
        summary.details.push(`${field.code} (${field.label}) -> ID ${res.result}`);
      } else if (String(res.error_description || res.error || '').toLowerCase().includes('exist')) {
        summary.existing++;
        summary.details.push(`${field.code} already exists`);
      } else {
        summary.failed++;
        summary.details.push(`${field.code}: ${res.error_description || res.error}`);
      }
    } catch (err) {
      const msg = err.response?.data?.error_description || err.response?.data?.error || err.message;
      if (String(msg).toLowerCase().includes('exist')) {
        summary.existing++;
        summary.details.push(`${field.code} already exists`);
      } else {
        summary.failed++;
        summary.details.push(`${field.code}: ${msg}`);
      }
    }
  }
  return summary;
};

const createAllFields = async (webhookUrl) => {
  const contact = await createFields(webhookUrl, 'contact', CONTACT_FIELDS);
  const deal = await createFields(webhookUrl, 'deal', DEAL_FIELDS);
  const lead = await createFields(webhookUrl, 'lead', LEAD_FIELDS);
  return { contact, deal, lead };
};

module.exports = { createAllFields, createFields };
