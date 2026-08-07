# Frontend–Database Integration Testing (Milestone 3)

This document traces, for each key user-facing action, the full chain: **front-end UI action → REST API call → database change**, with the actual verification evidence. This is the evidence for "Testing the capstone project front-end interactions with the database layer via REST APIs."

Unlike `TEST_DOCUMENTATION.md` (Milestone 2), which tests the API layer directly with curl/scripts, this document specifically verifies that **triggering the action through the actual front-end UI** produces the correct database effect — not just that the API endpoint works in isolation.

---

## 1. Customer registration

| Step | Detail |
|---|---|
| UI action | On `login.html`, click "Create an account," fill in username/password/name, click "Create account" |
| Front-end code | `attemptRegister()` in `login.html` calls `fetch(POST /api/register)` |
| API endpoint | `POST /api/register` |
| Database effect | New row inserted into `users` table with `role = 'customer'`, `password_hash` bcrypt-hashed |
| Verification | Logged in immediately with the returned JWT; confirmed by checking `GET /api/my-orders` returns an empty array scoped to the new account (not another user's data) — proving the new row's `id` is correctly tied to the session |

## 2. Product browsing and category filtering

| Step | Detail |
|---|---|
| UI action | On `customer-app.html`, click a category filter button (e.g., "Accessories") |
| Front-end code | `setFilter()` re-renders `renderGrid()` from the already-fetched `PRODUCTS` array |
| API endpoint | `GET /api/products` (fetched once on page load via `loadProducts()`) |
| Database effect | Read-only — confirms the `products` table's `category` column values match what's rendered |
| Verification | Filtered results manually cross-checked against a direct `GET /api/products` response — every product shown under "Accessories" has `category: "Accessories"` in the raw API response |

## 3. Add to cart → checkout (core transactional path)

| Step | Detail |
|---|---|
| UI action | Click "Add to cart" on a product, then "Place order" in the cart view |
| Front-end code | `addToCart()` (local state, persisted to `sessionStorage`), then `checkout()` calls `fetch(POST /api/orders)` |
| API endpoint | `POST /api/orders` |
| Database effect | New row in `orders`, new row(s) in `order_items`, `products.stock` decremented for each item purchased |
| Verification (before/after) | **Before:** noted "Woven tote bag" stock via `GET /api/products` = 6. **UI action:** added 2 to cart, clicked Place order. **After:** refreshed the storefront — `GET /api/products` (triggered by `loadProducts()` on refresh) now shows stock = 4. This is the direct proof that a front-end button click resulted in a real database write, not a front-end-only state change. |

## 4. Order confirmation number

| Step | Detail |
|---|---|
| UI action | After checkout, the confirmation modal displays the order number |
| Front-end code | `checkout()` reads `result.orderNo` from the API response and displays it |
| API endpoint | `POST /api/orders` response includes `orderNo` formatted server-side as `ORD-#####` |
| Verification | Order number shown in the modal (e.g., `ORD-00007`) matched the `orderId`/`orderNo` visible in the merchant dashboard's order list for the same order, confirming both UIs are reading the same underlying database row |

## 5. Customer order history

| Step | Detail |
|---|---|
| UI action | Click "My Orders" tab on `customer-app.html` |
| Front-end code | `loadHistory()` calls `fetch(GET /api/my-orders)` |
| API endpoint | `GET /api/my-orders` (customer-scoped, filtered server-side by `customer_id`) |
| Database effect | Read-only |
| Verification | Confirmed the order placed in test 3 appears here with matching `orderNo` and total; confirmed a *second* customer account sees an empty list, proving the query is correctly scoped per-user rather than returning all orders |

## 6. Merchant dashboard reflects customer activity

| Step | Detail |
|---|---|
| UI action | Log in as merchant, click "Refresh from API" |
| Front-end code | `loadAll()` in `merchant-admin.html` calls `GET /api/orders`, `GET /api/kpis`, `GET /api/inventory-risk`, `GET /api/revenue-summary`, `GET /api/insights` in parallel via `Promise.all` |
| API endpoints | Five endpoints listed above |
| Database effect | Read-only, but reflects writes made by the *customer* app (a different browser session) |
| Verification | The order placed in test 3 (a different login session, different app) appeared in the merchant's order list, KPI totals, and inventory risk ranking after clicking Refresh — proving both front-end applications read from the same shared backend/database rather than separate or mocked data |

## 7. Merchant product management (add/edit)

| Step | Detail |
|---|---|
| UI action | Fill the "Add product" form and submit; separately, click "Edit" on an existing row, change stock, click "Save" |
| Front-end code | `addProduct()` calls `POST /api/products`; `saveRow()` calls `PUT /api/products/:id` |
| API endpoints | `POST /api/products`, `PUT /api/products/:id` |
| Database effect | New row inserted into `products`; existing row's `stock`/`price`/`avgDailySales` updated |
| Verification | New product appeared in both the merchant's product table *and* the customer storefront's product grid after a refresh — confirming the write via the admin UI is visible through the customer-facing read path, i.e., both UIs share one backend database |

## 8. Product image upload

| Step | Detail |
|---|---|
| UI action | Click the camera icon on a product row, select a local image file |
| Front-end code | `uploadImage()` sends a `multipart/form-data` request |
| API endpoint | `POST /api/products/:id/image` |
| Database effect | `products.image_url` updated to the uploaded file's served path |
| Verification | After upload and refresh, the real photo appeared in place of the emoji placeholder on **both** the merchant product table and the customer storefront card for that product — confirming the `image_url` column write is read back correctly on both front-ends |

## 9. Role-based access control enforced at the API, not just hidden in the UI

| Step | Detail |
|---|---|
| UI action | Manually attempted to call a merchant-only endpoint using a customer session's token (via browser dev tools / `api-tests.http`) |
| API endpoint | `GET /api/orders` with a customer token |
| Database effect | None — request rejected before reaching the database layer |
| Verification | Returned `403 Forbidden`, confirming the front-end's decision to hide merchant navigation from customer accounts is backed by real server-side enforcement, not just a UI convention that could be bypassed |

---

## Issues encountered during front-end/database integration testing

- **Stale front-end state after a write.** Initially, after placing an order, the storefront's product grid didn't reflect the new stock count because `PRODUCTS` was only fetched once on page load. Fixed by calling `loadProducts()` again after a successful checkout, so the UI re-fetches from the database rather than relying on stale local state.
- **Cart state lost on refresh.** The cart was originally held only in a JavaScript variable, so refreshing the page (a normal thing to do while verifying a database change) wiped it. Fixed by persisting the cart to `sessionStorage` so refresh-to-verify workflows don't destroy in-progress state.
- **Cross-app consistency required manual verification, not just isolated endpoint testing.** Testing `POST /api/orders` in isolation (as in Milestone 2) proves the endpoint works, but doesn't prove the customer and merchant front-ends are actually reading from the same database. This required the two-browser-session verification described in tests 3 and 6 above — placing an order as a customer in one session and confirming it's visible in a separate merchant session — which is a front-end integration concern specific to this milestone, not something the Milestone 2 API test suite covered.
