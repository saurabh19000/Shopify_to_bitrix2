# Shopify ↔ Bitrix24 Bi-Directional CRM Integration

An enterprise-grade, real-time bi-directional synchronization middleware connecting **Shopify e-commerce stores** and **Bitrix24 CRM**. It synchronizes customers, contacts, deals, orders, products, variants, inventory stock, invoices, marketing attribution, and leads with zero echo loops and automated conflict recovery.

---

## Table of Contents
1. [Architecture & System Overview](#architecture--system-overview)
2. [Core Features & Functionalities](#core-features--functionalities)
3. [Data Flow Diagrams](#data-flow-diagrams)
   - [Shopify ➔ Bitrix24 Flow (Forward Sync)](#1-shopify--bitrix24-flow-forward-sync)
   - [Bitrix24 ➔ Shopify Flow (Reverse Sync)](#2-bitrix24--shopify-flow-reverse-sync)
4. [Supported Entities & Field Mappings](#supported-entities--field-mappings)
   - [Customers & Contacts](#1-customers--contacts)
   - [Deals & Orders](#2-deals--orders)
   - [Products & Variants](#3-products--variants-25-fields)
   - [Inventory Stock (Warehouse Documents)](#4-inventory-stock-warehouse-documents)
   - [Abandoned Carts & Checkouts (Leads)](#5-abandoned-carts--checkouts-leads)
5. [Resilience, Deduplication & Loop Prevention](#resilience-deduplication--loop-prevention)
6. [Structured 8-Stage Logging & Traceability](#structured-8-stage-logging--traceability)
7. [Database Schema (`shop_tokens` & `id_map`)](#database-schema)
8. [API Endpoints & Webhooks](#api-endpoints--webhooks)
9. [Environment Configuration (`.env`)](#environment-configuration)
10. [Deployment & Production Commands](#deployment--production-commands)
11. [Monitoring, Log Inspection & Testing](#monitoring-log-inspection--testing)

---

## Architecture & System Overview

```
 ┌────────────────────────┐                               ┌────────────────────────┐
 │      Shopify Store     │                               │      Bitrix24 CRM      │
 │ (luksonjewel.myshopify)│                               │  (lukson.bitrix24.in)  │
 └───────────┬────────────┘                               └───────────┬────────────┘
             │                                                        │
    HMAC Webhooks (13 topics)                                  Outbound Webhooks
             │                                                        │
             ▼                                                        ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │                     Shopify-to-Bitrix Backend (Express)                    │
   │                                                                            │
   │   ┌────────────────────────┐          ┌────────────────────────────────┐   │
   │   │ Inbound HMAC Validator │          │ Bitrix Event Dispatcher        │   │
   │   │ (X-Shopify-Hmac-Sha256)│          │ (Contact, Requisite, Address,  │   │
   │   └───────────┬────────────┘          │  Deal, Product handlers)       │   │
   │               │                       └───────────────┬────────────────┘   │
   │               ▼                                       ▼                    │
   │   ┌────────────────────────────────────────────────────────────────────┐   │
   │   │               Loop Prevention Engine (syncTracker.js)              │   │
   │   │  • Bidirectional Echo Suppression (TTL: 45s)                       │   │
   │   │  • In-flight Request Deduplication (TTL: 300ms)                    │   │
   │   └─────────────────────────────────┬──────────────────────────────────┘   │
   │                                     │                                      │
   │   ┌─────────────────────────────────┴──────────────────────────────────┐   │
   │   │                Business Logic & Transformation Services            │   │
   │   │  • bitrix.service.js      • shopify.service.js                     │   │
   │   │  • lifetime.service.js    • attribution.service.js                 │   │
   │   │  • lead.service.js        • invoice.service.js                     │   │
   │   └─────────────────────────────────┬──────────────────────────────────┘   │
   └─────────────────────────────────────┼──────────────────────────────────────┘
                                         │
                                         ▼
                           ┌───────────────────────────┐
                           │    PostgreSQL Database    │
                           │  • id_map table           │
                           │  • shop_tokens table      │
                           └───────────────────────────┘
```

---

## Core Features & Functionalities

* **True Bi-Directional Synchronization**: Changes in Shopify update Bitrix24 immediately, and changes in Bitrix24 update Shopify instantly.
* **360° Customer Profile**: Synchronizes Names, Emails, Phones, Addresses, Company titles, Tags, Notes, and computed Analytics.
* **Customer Lifetime Metrics**: Automatically computes and updates Bitrix contact fields:
  * Total Orders Count (`UF_CRM_TOTAL_ORDERS`)
  * Total Lifetime Spend (`UF_CRM_TOTAL_SPEND`)
  * Average Order Value (`UF_CRM_AOV`)
  * Last Purchase Timestamp (`UF_CRM_LAST_PURCHASE`)
* **Deal & Order Automation**:
  * Shopify Orders create Bitrix Deals with product line rows, taxes, discounts, and payment status.
  * Bitrix Deals create Shopify Draft Orders or update existing Order financial/fulfillment status.
* **Marketing Attribution Engine**: Extracts and updates UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`), landing site, and referring site.
* **Product Catalog Sync**: Syncs 25+ product fields, variants, barcodes, compare-at prices, weights, categories, and high-resolution images.
* **Delta-Based Stock Management**: Generates Bitrix inventory management warehouse documents (`catalog.document.add` / `conduct`) to update available stock accurately without race conditions.
* **Lead Generation from Abandoned Carts**: Converts abandoned checkouts and carts into Bitrix Leads with line item breakdown and recovery checkout links.
* **Invoices & Attachments**: Automatically creates Bitrix Invoices and attaches order PDF summaries to the deal timeline.
* **Echo Loop Prevention**: Memory-backed fingerprint and direction tracker prevents endless back-and-forth ping-pong sync cycles.
* **Automated Conflict Recovery**: Automatically handles Shopify 422 errors (e.g. duplicate email, invalid domestic phone numbers) and 404 missing records.

---

## Data Flow Diagrams

### 1. Shopify ➔ Bitrix24 Flow (Forward Sync)

```mermaid
sequenceDiagram
    autonumber
    participant SHP as Shopify Store
    participant APP as Backend Middleware
    participant PG as PostgreSQL (id_map)
    participant BTX as Bitrix24 CRM

    SHP->>APP: Webhook POST (e.g. customers/create, orders/create)
    APP->>APP: Cryptographic HMAC Signature Verification (SHA256)
    APP->>APP: Check Loop Prevention (isEchoLoop / isDuplicateEvent)
    
    alt Inbound Customer Sync
        APP->>BTX: Check for existing Contact (by Shopify ID / Email / Phone)
        alt Contact Exists
            APP->>BTX: crm.contact.update (Update fields & address)
        else New Contact
            APP->>BTX: crm.contact.add (Create contact with address & phone)
        end
        APP->>SHP: Fetch Customer Order History (paged)
        APP->>APP: Calculate Lifetime Metrics (Spend, Orders, AOV)
        APP->>BTX: crm.contact.update (Write computed lifetime fields)
        APP->>PG: Save mapping (Shopify ID <-> Bitrix Contact ID)
    end

    alt Inbound Order Sync
        APP->>BTX: crm.deal.add (Title, Opportunity, Financial Status, Contact ID)
        APP->>BTX: crm.deal.productrows.set (Line items, quantities, prices)
        APP->>BTX: crm.timeline.comment.add ("Imported from Shopify")
        APP->>PG: Save mapping (Shopify Order ID <-> Bitrix Deal ID)
    end

    APP-->>SHP: 200 OK
```

---

### 2. Bitrix24 ➔ Shopify Flow (Reverse Sync)

```mermaid
sequenceDiagram
    autonumber
    participant BTX as Bitrix24 Portal
    participant APP as Backend Middleware
    participant PG as PostgreSQL (id_map)
    participant SHP as Shopify Store

    BTX->>APP: Outbound Webhook POST /sync/bitrix/event?token=***
    APP->>APP: Authorize Bearer/Query Sync Token
    APP->>APP: extractBitrixEventData (Extracts ID from FIELDS.ID, ANCHOR_ID, or ENTITY_ID)
    APP->>APP: Check Loop Prevention (Suppress echo events within 45s)

    alt Contact Event (ONCRMCONTACTADD, ONCRMCONTACTUPDATE, ONCRMADDRESSREGISTER)
        APP->>BTX: crm.contact.get (Fetch full contact profile)
        APP->>PG: Check for existing Shopify mapping
        alt Has Mapping / UF_CRM_SHOPIFY_ID
            APP->>SHP: PUT /admin/api/2026-07/customers/{id}.json
        else Search by Email/Phone
            APP->>SHP: GET /admin/api/2026-07/customers/search.json
            alt Found Existing in Shopify
                APP->>SHP: PUT /admin/api/2026-07/customers/{id}.json
            else New Customer
                APP->>SHP: POST /admin/api/2026-07/customers.json
                alt 422 Conflict (e.g. Phone invalid or Email exists)
                    APP->>APP: Auto-retry without invalid phone or link existing email
                end
            end
        end
        APP->>BTX: crm.contact.update (Write back UF_CRM_SHOPIFY_ID)
        APP->>PG: Save bi-directional mapping (id_map)
    end

    alt Deal Event (ONCRMDEALADD, ONCRMDEALUPDATE)
        APP->>BTX: crm.deal.get + crm.deal.productrows.get
        alt Deal Create
            APP->>SHP: POST /admin/api/2026-07/draft_orders.json
        else Deal Update
            APP->>SHP: PUT /admin/api/2026-07/orders/{id}.json (financial/fulfillment status)
        end
    end

    alt Product Event (ONCRMPRODUCTADD, ONCRMPRODUCTUPDATE)
        APP->>BTX: crm.product.get
        APP->>SHP: GET /admin/api/2026-07/products/{id}.json (Fetch existing Variant IDs)
        APP->>SHP: PUT /admin/api/2026-07/products/{id}.json (Preserve Variant IDs)
    end

    APP-->>BTX: 200 OK
```

---

## Supported Entities & Field Mappings

### 1. Customers & Contacts
| Direction | Shopify Field | Bitrix24 Field | Purpose / Notes |
| :--- | :--- | :--- | :--- |
| `↔` | `first_name` | `NAME` | First Name |
| `↔` | `last_name` | `LAST_NAME` | Last Name |
| `↔` | `email` | `EMAIL` | Work Email (multi-value supported) |
| `↔` | `phone` | `PHONE` | Work Phone (E.164 auto-fallback) |
| `↔` | `default_address.address1` | `ADDRESS` | Street address |
| `↔` | `default_address.city` | `ADDRESS_CITY` | City |
| `↔` | `default_address.province`| `ADDRESS_PROVINCE` | State / Province |
| `↔` | `default_address.country` | `ADDRESS_COUNTRY` | Country |
| `↔` | `default_address.zip` | `ADDRESS_POSTAL_CODE` | Postal / Zip Code |
| `↔` | `tags` | `TAG` / `UF_CRM_CUSTOMER_TAGS` | Customer tags |
| `↔` | `note` | `UF_CRM_CUSTOMER_NOTE` | Customer notes |
| `➔` | `id` | `UF_CRM_SHOPIFY_ID` | Linked Shopify Customer ID |
| `➔` | Calculated Spend | `UF_CRM_TOTAL_SPEND` | Lifetime spend amount |
| `➔` | Calculated Orders | `UF_CRM_TOTAL_ORDERS` | Total order count |
| `➔` | Calculated AOV | `UF_CRM_AOV` | Average order value |
| `➔` | Last Order Date | `UF_CRM_LAST_PURCHASE` | Last purchase date |
| `➔` | UTM Source | `UF_CRM_UTM_SOURCE` | Marketing attribution |
| `➔` | UTM Campaign | `UF_CRM_UTM_CAMPAIGN` | Marketing campaign |

### 2. Deals & Orders
| Direction | Shopify Field | Bitrix24 Field | Notes |
| :--- | :--- | :--- | :--- |
| `↔` | `name` (`#1001`) | `TITLE` | "Order #1001" |
| `↔` | `total_price` | `OPPORTUNITY` | Total deal amount |
| `↔` | `currency` | `CURRENCY_ID` | E.g. `INR`, `USD` |
| `↔` | `financial_status` | `STAGE_ID` / `UF_CRM_FINANCIAL_STATUS` | `paid` ➔ `WON`, `pending` ➔ `NEW`, `refunded` ➔ `LOSE` |
| `↔` | `fulfillment_status` | `UF_CRM_FULFILLMENT_STATUS` | `fulfilled`, `unfulfilled`, `partial` |
| `➔` | `line_items` | Product Rows (`crm.deal.productrows.set`) | Name, Price, Quantity |
| `➔` | `discount_codes` | `UF_CRM_DISCOUNT_CODE` | Applied coupon codes |
| `➔` | `total_discounts` | `UF_CRM_DISCOUNT` | Total discount amount |
| `➔` | `source_name` | `UF_CRM_ORDER_CHANNEL` | E.g. `web`, `shopify_draft_order` |
| `➔` | Order Timeline | `crm.timeline.comment.add` | Automatically records import notes |

### 3. Products & Variants (25+ Fields)
| Shopify Field | Bitrix24 Field / Property | Description |
| :--- | :--- | :--- |
| `title` | `NAME` | Product Title |
| `variants[0].price` | `PRICE` | Product Price |
| `status` | `ACTIVE` (`Y`/`N`) | Active/Draft status |
| `body_html` | `DESCRIPTION` (`DESCRIPTION_TYPE: text`) | Stripped & clean formatted text |
| `variants[0].sku` | `CODE` | SKU identifier |
| `images` | `PREVIEW_PICTURE` & `DETAIL_PICTURE` | Base64 high-res image upload |
| `vendor` | `PROPERTY_110` (Vendor) | Brand / Vendor |
| `product_type` | `PROPERTY_112` (Product Type) | Type classification |
| `tags` | `PROPERTY_114` (Tags) | Comma-separated tags |
| `handle` | `PROPERTY_116` (Handle) | Shopify URL slug |
| `variants[0].barcode` | `PROPERTY_118` (Barcode) | Barcode / UPC |
| `compare_at_price` | `PROPERTY_120` (Compare At Price) | Original MSRP price |
| `inventory_quantity` | `PROPERTY_124` (Stock Quantity) | Current quantity |
| `weight + unit` | `PROPERTY_126` (Weight) | Weight with unit |

### 4. Inventory Stock (Warehouse Documents)
Instead of overwriting inventory records, stock is managed via Bitrix24 official warehouse documents:
1. `catalog.document.add`: Creates inventory document (`type: S` for receiving stock, `type: D` for stock write-off).
2. `catalog.document.element.add`: Attaches product ID, target warehouse ID (`BITRIX_WAREHOUSE_ID`), and delta amount.
3. `catalog.document.conduct`: Processes the document into Bitrix Available Stock.
4. Delta is tracked in PostgreSQL `id_map` under type `stock` to prevent redundant document creation.

### 5. Abandoned Carts & Checkouts (Leads)
* **`carts/update`** & **`checkouts/create`**: Automatically create a Lead in Bitrix24 with total value, line items, contact binding, and the customer's direct checkout recovery URL.
* Deduped via `id_map` under types `leads` and `checkouts`.

---

## Resilience, Deduplication & Loop Prevention

### 1. Echo Loop Suppression (`syncTracker.js`)
* Every outbound sync operation records a cryptographic key in memory: `${direction}:${entity}:${id}` with a 45-second TTL.
* When the opposite platform sends a webhook for that same entity within 45 seconds, the middleware identifies it as an echo loop, acknowledges it with `200 OK`, and skips execution.

### 2. Multi-Stage Contact Deduplication
When creating or updating contacts, the engine resolves records in order:
1. Exact ID mapping lookup via PostgreSQL `id_map`.
2. Bitrix custom field lookup (`UF_CRM_SHOPIFY_ID`).
3. Email matching (`crm.contact.list` filter `EMAIL`).
4. Phone matching (`crm.contact.list` filter `PHONE`).

### 3. Shopify 422 & 404 Auto-Recovery
* **Phone Format Fallback**: If Shopify rejects a phone number format with `422 Unprocessable Entity`, the customer creation is automatically retried with email-only.
* **Duplicate Email Fallback**: If Shopify rejects customer creation because the email exists, the customer is looked up via Shopify Search API, mapped, and updated.
* **404 Missing Record Recovery**: If a mapped customer or product was deleted in Shopify, the sync automatically recreates the entity and updates the ID mapping.
* **Non-Fatal Bitrix Custom Fields**: If a Bitrix portal is missing `UF_CRM_SHOPIFY_ID` in CRM settings, the system logs a non-fatal warning and persists the mapping in PostgreSQL.

---

## Structured 8-Stage Logging & Traceability

Every transaction generates a unique Correlation ID:
`[syncId=BTX-SHP-YYYYMMDD-XXXXX]` (Bitrix ➔ Shopify) or `[syncId=SHP-BTX-YYYYMMDD-XXXXX]` (Shopify ➔ Bitrix).

Each operation logs all 8 lifecycle stages:

```text
[INFO]  [syncId=BTX-SHP-20260826-00010-ABCD] [stage=BITRIX_EVENT] Bitrix event received: event=ONCRMCONTACTADD entity_id=8570
[DEBUG] [syncId=BTX-SHP-20260826-00010-ABCD] [stage=BITRIX_PAYLOAD] Bitrix payload received for contact 8570
[INFO]  [syncId=BTX-SHP-20260826-00010-ABCD] [stage=VALIDATION] Validation SUCCESS for contact 8570 (required: id, name, email/phone)
[INFO]  [syncId=BTX-SHP-20260826-00010-ABCD] [stage=MAPPING] Field mapping SUCCESS: BITRIX -> SHOPIFY (customer)
[INFO]  [syncId=BTX-SHP-20260826-00010-ABCD] [stage=SHOPIFY_API_REQUEST] Calling Shopify API: operation=CREATE method=POST endpoint=https://...
[INFO]  [syncId=BTX-SHP-20260826-00010-ABCD] [stage=SHOPIFY_API_RESPONSE] Shopify API responded: statusCode=201 status=SUCCESS (duration=184ms)
[INFO]  [syncId=BTX-SHP-20260826-00010-ABCD] [stage=MAPPING_SAVE] Bi-directional ID mapping saved: Bitrix 8570 <-> Shopify 9289514385648
[INFO]  [syncId=BTX-SHP-20260826-00010-ABCD] [stage=SYNC_COMPLETE] Synchronization completed successfully (duration=412ms)
```

> **Security**: All API keys, bearer tokens, and webhook secrets are automatically masked (`***`) in logs.

---

## Database Schema

```sql
-- OAuth access token storage
CREATE TABLE IF NOT EXISTS shop_tokens (
  shop VARCHAR(255) PRIMARY KEY,
  access_token TEXT NOT NULL
);

-- Bi-directional mapping storage
CREATE TABLE IF NOT EXISTS id_map (
  shop VARCHAR(255) NOT NULL DEFAULT '',
  type VARCHAR(50) NOT NULL,
  shopify_id VARCHAR(255) NOT NULL,
  bitrix_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (shop, type, shopify_id)
);

-- Index for reverse lookups
CREATE INDEX IF NOT EXISTS idx_id_map_reverse ON id_map (shop, type, bitrix_id);
```

**Mapping Types in `id_map`:**
* `contacts`: Shopify Customer ID `↔` Bitrix Contact ID
* `deals`: Shopify Order ID `↔` Bitrix Deal ID
* `products`: Shopify Product ID `↔` Bitrix Product ID
* `stock`: Shopify Product ID `↔` Last Synced Stock Quantity
* `leads`: Shopify Cart ID `↔` Bitrix Lead ID
* `checkouts`: Shopify Checkout ID `↔` Bitrix Lead ID
* `invoices`: Shopify Order ID `↔` Bitrix Invoice ID

---

## API Endpoints & Webhooks

### Inbound Shopify Webhooks (HMAC Verified)
* `POST /webhooks/shopify/customers-create` — Customer Created
* `POST /webhooks/shopify/customers-update` — Customer Updated
* `POST /webhooks/shopify/customers-delete` — Customer Deleted
* `POST /webhooks/shopify/orders-create` — Order Created
* `POST /webhooks/shopify/orders-updated` — Order Updated / Paid / Fulfilled
* `POST /webhooks/shopify/orders-delete` — Order Deleted
* `POST /webhooks/shopify/products-create` — Product Created + Stock Sync
* `POST /webhooks/shopify/products-update` — Product Updated + Stock Sync
* `POST /webhooks/shopify/products-delete` — Product Deleted
* `POST /webhooks/shopify/carts-update` — Abandoned Cart ➔ Lead
* `POST /webhooks/shopify/checkouts-create` — Checkout Started ➔ Lead
* `POST /webhooks/shopify/refunds-create` — Order Refunded
* `POST /webhooks/shopify/app-uninstalled` — App Uninstalled Cleanup

### Inbound Bitrix24 Webhooks (`/sync/*`)
* `POST /sync/bitrix/event?token={TOKEN}` — **Unified Event Dispatcher** (handles `ONCRMCONTACTADD`, `ONCRMCONTACTUPDATE`, `ONCRMADDRESSREGISTER`, `ONCRMREQUISITEADD`, `ONCRMDEALADD`, `ONCRMDEALUPDATE`, `ONCRMPRODUCTADD`, `ONCRMPRODUCTUPDATE`)
* `POST /sync/bitrix/contact-update?token={TOKEN}` — Contact Update Handler
* `POST /sync/bitrix/deal-update?token={TOKEN}` — Deal Update Handler
* `POST /sync/bitrix/product-update?token={TOKEN}` — Product Update Handler
* `POST /sync/bitrix/inventory-update?token={TOKEN}` — Stock Inventory Update Handler

### Bulk Migration Endpoints
* `POST /migration/all` — Sequentially migrates Customers, Products (with stock), and Orders
* `POST /migration/customers` — Bulk imports all Shopify customers into Bitrix24 contacts
* `POST /migration/products` — Bulk imports all Shopify products + stock documents
* `POST /migration/orders` — Bulk imports all Shopify orders into Bitrix24 deals

---

## Environment Configuration

Create a `.env` file in the root directory:

```env
PORT=3001
NODE_ENV=production

# Shopify Store & API Configuration
SHOPIFY_STORE_URL=luksonjewel.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2026-07
SHOPIFY_API_KEY=your_shopify_app_api_key
SHOPIFY_API_SECRET=your_shopify_app_api_secret
SHOPIFY_APP_URL=https://shopify.averlonworld.org

# PostgreSQL Connection
DATABASE_URL=postgresql://user:password@localhost:5432/shopify_bitrix?sslmode=disable

# Bitrix24 Portal Configuration
BITRIX_WEBHOOK_URL=https://lukson.bitrix24.in/rest/1/your_bitrix_inbound_token/
BITRIX_WAREHOUSE_ID=2
BITRIX_RESPONSIBLE_ID=1
BITRIX_CURRENCY=INR
BITRIX_STORE_DOMAIN=luksonjewel.myshopify.com

# Two-Way Sync Authentication Secret
BITRIX_SYNC_TOKEN=my_super_secret_abc123

# Features & Analytics
COMPUTE_LIFETIME=true
BITRIX_ORDER_SYNC_ENABLED=true
BITRIX_INVOICE_SYNC_ENABLED=true
BITRIX_INVOICE_PAY_SYSTEM_ID=1
BITRIX_INVOICE_STATUS_ID=1
BITRIX_LEAD_RESPONSIBLE_ID=1
```

---

## Deployment & Production Commands

### 1. Push Code from Local PC
```bash
git push origin development
```

### 2. Deploy on Linux Server (`root@averlon1`)
```bash
cd ~/Shopify_to_bitrix2
git checkout development
git pull origin development
docker compose down
docker compose up -d --build
```

### 3. Initialize Database & Custom Fields (One-time setup)
```bash
# Run database migrations
docker exec -i shopify-backend node scripts/migrateDb.js

# Store token in database
docker exec -i shopify-backend node scripts/migrateToken.js

# Register custom fields in Bitrix CRM
docker exec -i shopify-backend node scripts/createCustomFields.js

# Register all 13 Shopify webhook topics
docker exec -i shopify-backend node scripts/registerWebhooks.js
```

---

## Monitoring, Log Inspection & Testing

### 1. View Live Successful Syncs
```bash
docker compose logs -f app | grep --line-buffered -E "SYNC_COMPLETE|SUCCESS|createContact: DONE|createDeal: DONE"
```

### 2. View Live Errors & Exceptions
```bash
docker compose logs -f app | grep --line-buffered -E "ERROR|WARN|FAILED|EXCEPTION|401|422|500"
```

### 3. Trace a Transaction by Sync ID
```bash
docker compose logs app | grep "BTX-SHP-20260826-00010-ABCD"
```

### 4. Trigger a Test Sync for any Contact
```bash
docker exec -i shopify-backend node -e "
const axios = require('axios');
axios.post('http://localhost:3001/sync/bitrix/event?token=my_super_secret_abc123', {
  event: 'ONCRMCONTACTADD',
  data: { FIELDS: { ID: 'YOUR_BITRIX_CONTACT_ID' } }
}).then(r => console.log('RESPONSE:', r.status, r.data))
  .catch(e => console.error('ERROR:', e.message, e.response ? e.response.data : ''));
"
```

### 5. Run Automated Test Suites (47 / 47 Tests)
```bash
# Run the complete test suite
node test/verifyBitrixAddressAndContactEvents.test.js
node test/twoWaySyncComprehensive.test.js
node test/reverseSync.test.js
node test/singleTenant.test.js
```
