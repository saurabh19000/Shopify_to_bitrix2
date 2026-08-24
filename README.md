# Shopify → Bitrix24 CRM Integration

Backend service that syncs Shopify customers, products (with images, variants, stock, and 25+ custom fields), and orders to Bitrix24 CRM in real-time via webhooks, with support for bulk historical data migration.

**Full 360° customer profile** — in addition to basic sync it provides:
- 🛒 Abandoned cart → automatic Bitrix **lead** creation
- 🚀 Checkout started → lead creation
- 📈 Customer lifetime metrics (total orders, total spend, AOV, last purchase)
- 🎯 Marketing attribution (UTMs, source, campaign, landing/referring site)
- 🏷️ Real customer tags + notes (dedicated fields)
- 💳 Discount code & amount
- 🧾 Invoice sync (number + PDF attachment)
- 🔄 Refund & return status updates
- 📎 Attachments on deals (invoice PDF, certificates, design files)
- 🔁 Two-way customer sync (Bitrix → Shopify)

---

## Architecture Overview

```
Shopify Store  ──webhooks──▶  Express App  ──REST API──▶  Bitrix24 CRM
                                  │                     (Products, Contacts,
                            OAuth Flow                   Deals, Stock Docs)
                                  │
                      ┌───────────┴───────────┐
                      │     PostgreSQL         │
                      │  shop_tokens table     │
                      │  id_map table          │
                      └───────────────────────┘
```

**Two independent workflows:**
1. **Product Sync** — Creates/updates products with images, prices, descriptions, and custom properties. Never touches inventory.
2. **Inventory Sync** — Creates warehouse documents (receive/dispose) via `catalog.document.*` APIs. Never touches product data or images.

---

## What's Synced

### Customers
| Shopify Field | Bitrix24 Field |
|---|---|
| first_name | NAME |
| last_name | LAST_NAME |
| email | EMAIL |
| phone | PHONE |
| default_address | ADDRESS, ADDRESS_CITY, ADDRESS_PROVINCE, ADDRESS_COUNTRY, ADDRESS_POSTAL_CODE |
| company (from address) | COMPANY_TITLE |
| tags | TAG (real Bitrix tags) |
| note | UF_CRM_CUSTOMER_NOTE |
| customer.id | UF_CRM_SHOPIFY_ID |
| created_at | UF_CRM_CREATED_AT |
| tags, note, created_at | COMMENTS |
| lifetime metrics | UF_CRM_TOTAL_ORDERS, UF_CRM_TOTAL_SPEND, UF_CRM_LAST_PURCHASE, UF_CRM_AOV |
| latest order attribution | UF_CRM_UTM_SOURCE, UF_CRM_UTM_MEDIUM, UF_CRM_UTM_CAMPAIGN, UF_CRM_LANDING_SITE, UF_CRM_REFERRING_SITE |

### Abandoned Carts & Checkouts (Leads)
| Shopify Event | Bitrix24 Action |
|---|---|
| carts/update (abandoned) | Creates/updates a **lead** "Abandoned Cart" with cart total, abandoned checkout URL, line items, UTMs, linked contact |
| checkouts/create | Creates/updates a **lead** "Checkout Started" with totals, attribution, shipping info, linked contact |

Lead dedupe is handled via `id_map` (`leads` / `checkouts` types) — no duplicate leads per cart/checkout.

### Products (25+ fields)
| Shopify Field | Bitrix24 Field | Property ID |
|---|---|---|
| title | NAME | — |
| price | PRICE | — |
| status (active/draft) | ACTIVE | — |
| body_html | DESCRIPTION (HTML stripped, formatted) | — |
| variant.sku | CODE | — |
| product.id | Shopify Product ID | PROPERTY_98 |
| vendor | Vendor | PROPERTY_110 |
| product_type | Product Type | PROPERTY_112 |
| tags | Tags | PROPERTY_114 |
| handle | Handle | PROPERTY_116 |
| variant.barcode | Barcode | PROPERTY_118 |
| variant.compare_at_price | Compare At Price | PROPERTY_120 |
| variant.inventory_quantity | Stock Quantity | PROPERTY_124 |
| variant.weight + unit | Weight | PROPERTY_126 |
| created_at | Shopify Created Date | PROPERTY_128 |
| variant.taxable | Taxable (Yes/No) | PROPERTY_106 |
| product handle URL | SEO URL | PROPERTY_108 |
| variant.unit_price | Unit Price | PROPERTY_130 |
| variant.inventory_management | Inventory Tracked (Physical/Virtual) | PROPERTY_132 |
| variant.requires_shipping | Requires Shipping (Yes/No) | PROPERTY_134 |
| product.title (SEO) | SEO Title | PROPERTY_136 |
| variant options + count | Variant Info | PROPERTY_140 |
| variant dimensions | Box Size (e.g. "10 x 8 x 5 cm") | PROPERTY_142 |
| product.status | Status (Active/Draft/Inactive) | PROPERTY_144 |
| variant.width | WIDTH | — |
| variant.length | LENGTH | — |
| variant.height | HEIGHT | — |
| product.image.src | PREVIEW_PICTURE + DETAIL_PICTURE | — |
| collections | Collections | PROPERTY_100 |
| category (GraphQL) | Category | PROPERTY_102 |
| cost per item | Cost Per Item | PROPERTY_104 |
| metafields | Category Metafields | PROPERTY_138 |

**Variant Info (PROPERTY_140) shows:**
```
2 variant(s) >> Color: Red, Blue | Size: S, M, L >> Red / S, Red / M, Blue / S, Blue / M
```

**Box Size (PROPERTY_142) shows:**
```
10 x 8 x 5 cm
```

### Orders/Deals
| Shopify Field | Bitrix24 Field |
|---|---|
| order_number | TITLE ("Order #1234") |
| total_price | OPPORTUNITY |
| currency | CURRENCY_ID |
| financial_status | STAGE_ID (paid→WON, pending→NEW, refunded→LOSE) |
| financial_status | UF_CRM_FINANCIAL_STATUS |
| fulfillment_status | UF_CRM_FULFILLMENT_STATUS |
| source_name | UF_CRM_ORDER_CHANNEL |
| shipping_lines[0].title | UF_CRM_DELIVERY_METHOD |
| fulfillments[0].shipment_status | UF_CRM_DELIVERY_STATUS |
| landing_site UTMs | UF_CRM_UTM_SOURCE, UF_CRM_UTM_MEDIUM, UF_CRM_UTM_CAMPAIGN, UF_CRM_UTM_TERM, UF_CRM_UTM_CONTENT |
| landing_site / referring_site | UF_CRM_LANDING_SITE, UF_CRM_REFERRING_SITE |
| discount_applications | UF_CRM_DISCOUNT_CODE, UF_CRM_DISCOUNT |
| invoice (name + url) | UF_CRM_INVOICE_NUMBER, UF_CRM_INVOICE_URL |
| refund state | UF_CRM_REFUND_STATUS, UF_CRM_REFUND_AMOUNT |
| created_at | BEGINDATE |
| closed_at | CLOSEDATE |
| customer email | CONTACT_ID (auto-linked) |
| line_items | Product Rows (name, price, qty) |
| — | Timeline Comment ("Imported automatically from Shopify", only on creation) |

### Invoices & Attachments
- When `BITRIX_INVOICE_SYNC_ENABLED=true`, every order gets a Bitrix invoice (`crm.invoice.add`) with number, price, currency, dates, linked contact/deal. Deduped via `id_map` type `invoices`.
- If Shopify exposes an invoice URL, the PDF is downloaded and attached to the deal timeline.
- `attachFilesToDeal()` (src/services/invoice.service.js) is a reusable helper to attach any file (invoice PDF, certificates, design files) to a deal.

### Inventory (Stock Sync)
| Step | API Call | Purpose |
|---|---|---|
| 1 | `catalog.document.add` | Create inventory document (type S=receive, D=dispose) |
| 2 | `catalog.document.element.add` | Add product line with quantity to document |
| 3 | `catalog.document.conduct` | Process document — updates Available Stock |

- Uses delta-based sync (tracks last synced quantity in `id_map` table)
- Avoids duplicate documents by comparing Shopify qty vs last synced qty
- Runs after product creation in migration (2.5s delay between products)
- Runs on product webhooks (3s delay after product create/update)

---

## Webhooks (Real-Time Sync)

| Shopify Event | Route | Bitrix24 Action |
|---|---|---|
| products/create | POST /webhooks/shopify/products-create | Create product + sync stock |
| products/update | POST /webhooks/shopify/products-update | Update product + sync stock |
| products/delete | POST /webhooks/shopify/products-delete | Delete product |
| customers/create | POST /webhooks/shopify/customers-create | Create contact (+ lifetime metrics, attribution) |
| customers/update | POST /webhooks/shopify/customers-update | Update contact (+ lifetime metrics, attribution) |
| customers/delete | POST /webhooks/shopify/customers-delete | Delete contact |
| orders/create | POST /webhooks/shopify/orders-create | Create deal + invoice + lifetime refresh |
| orders/update | POST /webhooks/shopify/orders-updated | Update deal (refunds, fulfillment, status) + invoice + lifetime refresh |
| orders/delete | POST /webhooks/shopify/orders-delete | Delete deal |
| carts/update | POST /webhooks/shopify/carts-update | Abandoned cart → lead (create/update) |
| checkouts/create | POST /webhooks/shopify/checkouts-create | Checkout started → lead |
| refunds/create | POST /webhooks/shopify/refunds-create | Update deal refund status/amount + timeline comment |
| app/uninstalled | POST /webhooks/shopify/app-uninstalled | Remove stored OAuth token |

All webhook routes use `express.raw()` **and verify the Shopify HMAC signature** (`X-Shopify-Hmac-Sha256`) via `src/utils/webhook.middleware.js`.

---

## Migration (Bulk Historical Import)

| Endpoint | Description |
|---|---|
| POST /migration/customers | Paginate all Shopify customers → Bitrix24 contacts |
| POST /migration/products | Paginate all Shopify products → Bitrix24 products + stock sync |
| POST /migration/orders | Paginate all Shopify orders → Bitrix24 deals |
| POST /migration/all | Run all three sequentially |

Credentials come from the `.env` file (single tenant).

Product migration runs in **two passes:**
1. Create/update all products (images, properties, prices)
2. Sync inventory stock via warehouse documents (2.5s delay between products)

---

## Project Structure

```
backend/
├── src/
│   ├── app.js                      # Express server, webhooks (HMAC-verified), OAuth, migration routes
│   │
│   ├── config/
│   │   ├── db.config.js            # PostgreSQL connection pool (pg)
│   │   ├── shopify.config.js       # Shopify store URL, API version, async token
│   │   ├── bitrix.config.js        # Webhook URL, currency, warehouse, responsible ID, invoice/lead/two-way settings
│   │   └── uf.config.js            # All Bitrix UF_CRM_* custom field definitions
│   │
│   ├── services/
│   │   ├── bitrix.service.js       # Core: product/contact/deal/lead/invoice CRUD, stock sync, refunds, image upload
│   │   ├── shopify.service.js      # Shopify REST helpers (webhook registration, customer update, order fetch)
│   │   ├── migration.service.js    # Bulk import with pagination and two-pass product sync
│   │   ├── attribution.service.js  # UTM / source / campaign extraction from orders
│   │   ├── lifetime.service.js     # Customer lifetime metrics computation + refresh
│   │   ├── lead.service.js         # Abandoned cart + checkout lead creation/dedupe
│   │   └── invoice.service.js      # Bitrix invoice creation + PDF/attachment upload
│   │
│   ├── utils/
│   │   ├── tokenStore.js           # PostgreSQL: saveToken / getToken / deleteToken
│   │   ├── idMapStore.js           # PostgreSQL: setMapping / getMappingWithFallback / deleteMapping
│   │   ├── tenantContext.js        # Single-tenant config resolver (reads .env)
│   │   └── webhook.middleware.js   # Shopify HMAC signature verification
│   │
│   ├── routes/
│   │   ├── migration.routes.js     # POST /migration/* endpoints
│   │   └── sync.routes.js          # Two-way sync endpoints (Bitrix → Shopify)
│   │
│   ├── sync/                       # Legacy sync modules (not actively used)
│   │   ├── syncCustomer.js
│   │   └── syncProduct.js
│   │
│   └── controllers/                # Route controllers
│       └── migration.controller.js
│
├── scripts/
│   ├── migrateDb.js                # Creates the required DB tables (idempotent)
│   ├── registerWebhooks.js         # Register all Shopify webhook topics (idempotent)
│   ├── createCustomFields.js       # Create all Bitrix UF_CRM_* fields (idempotent, accepts --bitrix-url)
│   ├── migrateToken.js             # Store SHOPIFY_ACCESS_TOKEN from .env into shop_tokens
│   ├── syncBitrixToShopify.js      # Poll Bitrix contacts → push updates to Shopify
│   └── wipeBitrixData.js           # Delete all Bitrix24 data (accepts --bitrix-url)
│
├── test/
│   └── singleTenant.test.js        # .env config + no-duplicate sync test (dummy data, no external services)
│
├── .env.example                    # Environment variable template
├── package.json
└── README.md
```

---

## Environment Variables

```env
PORT=3001

# Shopify OAuth App
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SHOPIFY_APP_URL=https://your-app.onrender.com
SHOPIFY_SCOPES=read_customers,read_products,read_orders,read_fulfillments,read_inventory,read_checkouts
SHOPIFY_API_VERSION=2024-10
SHOPIFY_STORE_URL=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxx_from_your_custom_app

# PostgreSQL
DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require

# Bitrix24
BITRIX_WEBHOOK_URL=https://your-domain.bitrix24.in/rest/1/your_webhook_secret/
BITRIX_WAREHOUSE_ID=2
BITRIX_RESPONSIBLE_ID=1
BITRIX_CURRENCY=INR
BITRIX_STORE_DOMAIN=your-store.myshopify.com

# Customer lifetime metrics — true/false
COMPUTE_LIFETIME=true

# Lead settings (abandoned cart / checkout)
BITRIX_LEAD_RESPONSIBLE_ID=1
BITRIX_ABANDONED_CART_STAGE=NEW
BITRIX_CHECKOUT_STAGE=NEW

# Invoice sync
BITRIX_INVOICE_SYNC_ENABLED=true
BITRIX_INVOICE_PAY_SYSTEM_ID=1
BITRIX_INVOICE_STATUS_ID=1

# Two-way sync shared secret
BITRIX_SYNC_TOKEN=your_shared_secret_for_two_way_sync
```

---

## Database Schema

```sql
-- OAuth access token for the store
CREATE TABLE shop_tokens (
  shop VARCHAR(255) PRIMARY KEY,
  access_token TEXT NOT NULL
);

-- Shopify ID → Bitrix24 ID mappings (also tracks stock sync state)
CREATE TABLE id_map (
  shop VARCHAR(255) NOT NULL DEFAULT '',
  type VARCHAR(50) NOT NULL,
  shopify_id VARCHAR(255) NOT NULL,
  bitrix_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (shop, type, shopify_id)
);
```

These tables are created automatically by `node scripts/migrateDb.js`.

**id_map types:**
- `contacts` — Shopify customer ID → Bitrix24 contact ID
- `products` — Shopify product ID → Bitrix24 product ID
- `deals` — Shopify order ID → Bitrix24 deal ID
- `stock` — Shopify product ID → last synced quantity (for delta calculation)
- `leads` — Shopify cart ID → Bitrix24 lead ID (abandoned carts)
- `checkouts` — Shopify checkout ID → Bitrix24 lead ID
- `invoices` — Shopify order ID → Bitrix24 invoice ID

---

## Setup & Running

### 1. Postgres database

**Local Postgres** (free, no cloud needed):
- Install PostgreSQL from https://www.postgresql.org (or use Docker: `docker run -d --name pg -e POSTGRES_PASSWORD=yourpassword -p 5432:5432 postgres`)
- Create the database:
  ```bash
  createdb -U postgres shopify_bitrix
  ```
- Set in `.env`:
  ```
  DATABASE_URL=postgres://postgres:yourpassword@localhost:5432/shopify_bitrix
  ```

**External/cloud Postgres** (e.g. Render, Neon): just paste the connection string and keep `?sslmode=require` — SSL is enabled automatically for remote hosts.

The app auto-detects SSL: `localhost`/`127.0.0.1` → no SSL; remote hosts → SSL. You can force either way with `?sslmode=disable` or `?sslmode=require`.

### 2. Install + run

```bash
cd backend
npm install
cp .env.example .env   # fill in your credentials
node scripts/migrateDb.js   # creates the DB tables (run once)
npm start
```

### Store the Shopify token
If you use a Shopify **custom app** (recommended for testing), store its Admin API access token so the scripts and OAuth flow can read it:
```bash
node scripts/migrateToken.js   # reads SHOPIFY_ACCESS_TOKEN from .env -> shop_tokens
```

### Register Webhooks
```bash
node scripts/registerWebhooks.js
```
This registers **13 topics** idempotently (create/update/delete for customers, products, orders, plus carts/update, checkouts/create, refunds/create, app/uninstalled).

### Create Bitrix Custom Fields (one-time, idempotent)
```bash
node scripts/createCustomFields.js                      # default portal (.env)
node scripts/createCustomFields.js --bitrix-url https://store.bitrix24.in/rest/1/xxx/   # another portal
```
Creates all `UF_CRM_*` fields used for lifetime metrics, attribution, notes, invoices, refunds, and lead data. Safe to re-run — existing fields are skipped.

### Two-Way Sync (Bitrix → Shopify)
1. In Bitrix24: **Settings → Integrations → Webhooks → Add webhook → Outgoing**, select event `Contact: updated`, and set the handler URL:
   `https://{SHOPIFY_APP_URL}/sync/bitrix/contact-update?token={BITRIX_SYNC_TOKEN}`
2. Alternatively run the poller on a schedule:
   ```bash
   node scripts/syncBitrixToShopify.js "2026-08-01T00:00:00"
   ```
   Pushes Bitrix contact name/email/phone/tags/note back to the matching Shopify customer (matched via `UF_CRM_SHOPIFY_ID`).

### Run Migration
```bash
curl -X POST "http://localhost:3001/migration/all"
```
Order migration also backfills customer lifetime metrics (deduped, one refresh per customer).

---

## Key Design Decisions

### Why two workflows for products?
Product images disappear if `crm.product.update` is called without `PREVIEW_PICTURE`/`DETAIL_PICTURE` fields. By separating product sync (which always includes images) from inventory sync (which only uses `catalog.document.*` APIs), images are never accidentally cleared.

### Why delta-based stock tracking?
`catalog.store.product.list` is not available on this Bitrix24 portal. Instead of querying current stock, the system tracks `lastSyncedQty` in the `id_map` table and calculates the delta for each sync. This is idempotent — running migration twice won't create duplicate stock documents.

### Why `DESCRIPTION_TYPE: "text"`?
Bitrix24 stores descriptions as HTML by default. Plain text newlines don't render as line breaks in the UI. Setting `DESCRIPTION_TYPE: "text"` ensures formatted descriptions with bullet points and paragraphs display correctly.

### Image upload strategy
Product images are uploaded as base64 to both `PREVIEW_PICTURE` and `DETAIL_PICTURE` fields simultaneously, ensuring the image appears in both list view and detail view in Bitrix24.

---

## Bitrix24 Portal Compatibility

This integration works with Bitrix24 Cloud portals that support:
- `crm.product.*` (CRUD)
- `crm.contact.*` (CRUD)
- `crm.deal.*` (CRUD)
- `catalog.document.*` (inventory management)
- `catalog.store.list` (warehouse listing)

**Not supported on this portal:**
- `catalog.store.product.list` (stock query) — delta tracking used instead
- `catalog.document.get` (document status check) — conduct result checked directly
