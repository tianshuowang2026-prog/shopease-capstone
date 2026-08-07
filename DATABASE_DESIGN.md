# ShopEase Backend — Database Design

Engine: SQLite (via Node's built-in `node:sqlite` module). File: `shopease.db`, created and seeded automatically on first run of `node server.js`.

## Entity-Relationship Overview

```
users (1) ──< (many) orders (1) ──< (many) order_items >── (many) products
```

### ER Diagram

```
┌─────────────────────┐
│       users          │
├─────────────────────┤
│ id            PK     │
│ username      UNIQUE │
│ password_hash        │
│ role   (customer/    │
│         merchant)    │
│ name                  │
└──────────┬───────────┘
           │ 1
           │
           │ places
           │
           │ many
┌──────────▼───────────┐
│       orders          │
├─────────────────────┤
│ id            PK     │
│ customer_id   FK ─────┼──► users.id
│ total                 │
│ created_at            │
└──────────┬───────────┘
           │ 1
           │
           │ contains
           │
           │ many
┌──────────▼───────────┐        many        ┌──────────────────────┐
│    order_items         │◄────────────────────►│      products         │
├─────────────────────┤   references one    ├──────────────────────┤
│ id            PK     │    product per      │ id            PK     │
│ order_id      FK ─────┤    line item        │ name                  │
│ product_id    FK ─────┼─────────────────────►│ category              │
│ qty                    │                     │ price                  │
│ unit_price             │                     │ stock                  │
└─────────────────────┘                     │ avg_daily_sales        │
                                              │ icon                   │
                                              └──────────────────────┘
```

**Cardinality summary:**
- One `user` (role = customer) → many `orders` (1:N)
- One `order` → many `order_items` (1:N)
- One `product` → many `order_items` across different orders (1:N)
- `order_items` is the junction/associative entity resolving the many-to-many between `orders` and `products`, with `qty` and `unit_price` as attributes on the relationship itself.

- One **user** (role = customer) can place many **orders**.
- One **order** has many **order_items** (line items).
- Each **order_item** references exactly one **product**.
- **products** is independent — read by both the customer app (catalog) and merchant app (inventory).

## Tables

### users
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| username | TEXT UNIQUE NOT NULL | login identifier |
| password_hash | TEXT NOT NULL | bcrypt hash, never plaintext |
| role | TEXT NOT NULL | `customer` or `merchant` (CHECK constraint) |
| name | TEXT NOT NULL | display name |
| email | TEXT | required for customer self-registration; used for verification/reset codes |
| email_verified | INTEGER NOT NULL DEFAULT 0 | login is blocked (403) until this is 1 |

### products
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| name | TEXT NOT NULL | |
| category | TEXT NOT NULL | used for storefront filtering |
| price | REAL NOT NULL | |
| stock | INTEGER NOT NULL | decremented by POST /api/orders |
| avg_daily_sales | REAL NOT NULL DEFAULT 1 | drives inventory-risk calculation |
| icon | TEXT | emoji placeholder for product image |
| image_url | TEXT | path to an uploaded product photo (served from /uploads); null falls back to the emoji icon in the UI |
| description | TEXT | product description shown on the customer-facing detail page and editable by the merchant |

### orders
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| customer_id | INTEGER NOT NULL | FK → users.id |
| total | REAL NOT NULL | computed server-side, never trusted from client |
| status | TEXT NOT NULL DEFAULT 'pending' | CHECK constrained to pending/shipped/completed; advanced via PUT /api/orders/:id/status |
| created_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

### order_items
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| order_id | INTEGER NOT NULL | FK → orders.id |
| product_id | INTEGER NOT NULL | FK → products.id |
| qty | INTEGER NOT NULL | |
| unit_price | REAL NOT NULL | price snapshot at time of purchase (doesn't change if product price later changes) |

### reviews
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| product_id | INTEGER NOT NULL | FK → products.id |
| customer_id | INTEGER NOT NULL | FK → users.id |
| customer_name | TEXT NOT NULL | denormalized copy of the reviewer's name for simpler read queries |
| rating | INTEGER NOT NULL | CHECK constrained 1–5 |
| comment | TEXT | optional |
| created_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

### verification_codes
Reused for both "verify your email" and "reset your password" — `purpose` distinguishes the two, and a code is only ever checked against its stated purpose.
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| user_id | INTEGER NOT NULL | FK → users.id |
| code | TEXT NOT NULL | 6-digit numeric code |
| purpose | TEXT NOT NULL | `verify_email` or `reset_password` (CHECK constraint) |
| expires_at | TEXT NOT NULL | 15 minutes after creation |
| used | INTEGER NOT NULL DEFAULT 0 | codes are single-use; checked and set on successful verification |
| created_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

### messages
Direct messaging between a customer and the merchant. `sender_id`/`recipient_id` are generic user references — the single-merchant demo logic (a customer's message always goes to "the" merchant) lives in the API layer, not the schema, so this extends to multiple merchants without a migration.
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| sender_id | INTEGER NOT NULL | FK → users.id |
| recipient_id | INTEGER NOT NULL | FK → users.id |
| content | TEXT NOT NULL | |
| read_at | TEXT | null until the recipient opens the thread |
| created_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

## Design decisions
- **Separate `order_items` table rather than a JSON column on `orders`** — keeps the schema in normal form, lets the inventory-risk and orders queries join cleanly, and matches how a real order management system would need per-line-item reporting later.
- **`unit_price` snapshotted onto `order_items`** rather than always joining to `products.price` — order history must stay accurate even if a product's price changes later.
- **Stock decrement and order insert happen in one SQL transaction** (`BEGIN` / `COMMIT` / `ROLLBACK` in `POST /api/orders`) so a failure partway through (e.g. insufficient stock on the second item) never leaves the database in a half-updated state.
- **`role` constrained with `CHECK(role IN ('customer','merchant'))`** at the schema level — the customer/merchant separation from the front-end architecture is enforced in the database itself, not just in application code.
