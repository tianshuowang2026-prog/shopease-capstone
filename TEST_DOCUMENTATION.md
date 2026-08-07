# ShopEase Backend — Test Case Documentation & Results

Primary test suite: **`test-suite.js`**, using Node's built-in test runner (`node:test`) and the `assert` module. Every test is fully self-contained — it performs its own login and its own setup — so any single test can be run in isolation, in any order, without depending on any other test having run first:

```bash
node --test test-suite.js                                  # run all 19
node --test --test-name-pattern="TEST 5:" test-suite.js    # run just one
```

(A secondary script, `test.js`, exists for human-readable narrated output during a demo — it prints each request/response for someone to read aloud, but doesn't make automated assertions. `test-suite.js` is the real automated suite this documentation covers.)

## Testing principle: independent before/after state verification

A test that only checks the response of a write operation (e.g., a `POST` returning `201` with the submitted data echoed back) does not prove the database was actually updated — it only proves the endpoint *claimed* success. If a handler had a bug where it returned a plausible success response without genuinely persisting the write, a test that only inspects that response would still pass.

Every write-heavy test in this suite guards against that by making a genuinely independent follow-up request — a separate `GET`, or a fresh `POST /api/login` for account creation — that re-queries the resource from scratch rather than trusting the mutating request's own response. These tests also establish their own known starting state (e.g., resetting a product's stock via `PUT` before testing an order against it), so they never depend on data left over from a previous test run.

| Operation | Self-contained test | What it independently re-verifies |
|---|---|---|
| Place an order | TEST 5 | Resets stock to a known value, places the order, then re-fetches products in a separate request and asserts stock dropped by exactly the quantity ordered |
| Order exceeding stock | TEST 10 | Resets stock to a known low value, confirms the order is rejected (409), then re-fetches and asserts stock is **unchanged** — proving a failed order doesn't partially corrupt data |
| Add a product | TEST 12 | After the `POST`, a separate `GET` confirms the new product is present in the full catalog with the submitted values |
| Edit a product | TEST 14 | After the `PUT`, a separate `GET` confirms the persisted stock value — not just what the `PUT` response echoed back |
| Register an account | TEST 16 | After registration, an independent `POST /api/login` with the new credentials proves the user row and password hash were genuinely written, not just that the registration endpoint returned a token |

---

## Full test case table

| # | Test case | Endpoint(s) | Expected | Result |
|---|---|---|---|---|
| 1 | Login with wrong password | POST /api/login | 401 + error message | ✅ 401 `"Invalid username or password"` |
| 2 | Login as customer1 (correct) | POST /api/login | 200 + JWT token, role customer | ✅ |
| 3 | Login as merchant1 (correct) | POST /api/login | 200 + JWT token, role merchant | ✅ |
| 4 | Product catalog is readable | GET /api/products | 200, non-empty list, well-formed objects | ✅ |
| 5 | **Order + independent before/after stock check** | PUT /api/products/3, GET, POST /api/orders, GET | Stock drops by exactly the quantity ordered, verified on a separate re-fetch | ✅ |
| 6 | Merchant sees an order after it's placed | POST /api/orders, GET /api/orders | Order appears in merchant's list | ✅ |
| 7 | Inventory risk ranking is readable | GET /api/inventory-risk | 200, ranked list with daysLeft computed | ✅ |
| 8 | Aggregate KPIs are readable | GET /api/kpis | 200, numeric totals | ✅ |
| 9 | Customer token blocked from merchant-only endpoint | GET /api/orders (customer token) | 403 | ✅ |
| 10 | **Insufficient stock order + independent no-corruption check** | PUT /api/products/5, POST /api/orders, GET | 409, and stock is unchanged on re-fetch (no partial write) | ✅ |
| 11 | No Authorization header | GET /api/orders | 401 | ✅ |
| 12 | **Add product + independent re-fetch** | POST /api/products, GET /api/products | New product present on a separate re-fetch with correct values | ✅ |
| 13 | Customer token blocked from adding a product | POST /api/products (customer token) | 403 | ✅ |
| 14 | **Edit product + independent re-fetch** | PUT /api/products/6, GET /api/products | Persisted stock (77) confirmed on a separate re-fetch | ✅ |
| 15 | Revenue summary is readable | GET /api/revenue-summary | 200, daily/weekly/monthly arrays present | ✅ |
| 16 | **Register + independent login verification** | POST /api/register, POST /api/login | New account can independently log in with the credentials just submitted | ✅ |
| 17 | Registration with a short password | POST /api/register | 400 | ✅ |
| 18 | Smart Advisor returns recommendations | GET /api/insights | 200, non-empty insights array | ✅ |
| 19 | Customer order history is correctly scoped | POST /api/orders, GET /api/my-orders | Order appears, formatted as ORD-##### | ✅ |

All 19 pass both individually (`--test-name-pattern`) and as a full run (`node --test test-suite.js`).

## Edge cases covered

- Invalid credentials (test 1)
- Role-based access control in both directions (tests 9, 13)
- Business rule enforcement with data-integrity check, not just a status code (test 10)
- Missing authentication entirely (test 11)
- Independent, non-trusting verification of every state-changing write (tests 5, 10, 12, 14, 16)
