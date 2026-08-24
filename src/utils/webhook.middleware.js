const crypto = require('crypto');
const { debug } = require('./debugLogger');

/**
 * Verifies Shopify webhook HMAC signatures (X-Shopify-Hmac-Sha256).
 * Must run AFTER express.raw() so req.body is the raw Buffer.
 * Skips verification (with a warning) when SHOPIFY_API_SECRET is not configured.
 */
const shopifyWebhookVerifier = (req, res, next) => {
  const secret = process.env.SHOPIFY_API_SECRET;
  const hmac = req.get('X-Shopify-Hmac-Sha256');

  if (!secret || secret.includes('your_shopify_api_secret')) {
    console.warn('[Webhook] SHOPIFY_API_SECRET not configured — skipping HMAC verification');
    debug('webhook-hmac', 'HMAC verification SKIPPED — SHOPIFY_API_SECRET not configured', {
      topic: req.get('x-shopify-topic'),
      shop: req.get('x-shopify-shop-domain')
    });
    return next();
  }

  if (!hmac) {
    debug('webhook-hmac', 'HMAC FAILED — missing X-Shopify-Hmac-Sha256 header', {
      topic: req.get('x-shopify-topic'),
      shop: req.get('x-shopify-shop-domain')
    });
    return res.status(401).send('Missing X-Shopify-Hmac-Sha256 header');
  }

  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body), 'utf8');

  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  debug('webhook-hmac', 'Verifying HMAC signature', {
    topic: req.get('x-shopify-topic'),
    shop: req.get('x-shopify-shop-domain'),
    bodyBytes: rawBody.length,
    providedPrefix: hmac.slice(0, 8)
  });

  try {
    const expected = Buffer.from(digest, 'utf8');
    const provided = Buffer.from(hmac, 'utf8');
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      debug('webhook-hmac', 'HMAC FAILED — signature mismatch', {
        expectedPrefix: digest.slice(0, 8),
        providedPrefix: hmac.slice(0, 8)
      });
      return res.status(401).send('Invalid HMAC signature');
    }
  } catch (err) {
    debug('webhook-hmac', 'HMAC FAILED — comparison error', { error: err.message });
    return res.status(401).send('Invalid HMAC signature');
  }

  debug('webhook-hmac', 'HMAC VERIFIED OK');
  next();
};

module.exports = { shopifyWebhookVerifier };
