const BITRIX_URL = process.env.BITRIX_WEBHOOK_URL;

async function bitrixCall(method, payload) {
  const response = await fetch(`${BITRIX_URL}${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (data.error) {
    console.error(`Bitrix24 error [${method}]:`, data.error_description || data.error);
    throw new Error(data.error_description || data.error);
  }
  return data.result;
}

module.exports = { bitrixCall };
