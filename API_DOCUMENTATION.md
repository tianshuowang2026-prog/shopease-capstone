# ShopEase Backend — API Documentation

Base URL (local): `http://localhost:3000`

Auth: after login, include the returned token on every subsequent request as
`Authorization: Bearer <token>`. Endpoints marked (customer) or (merchant) reject
requests from the wrong role with `403`, and requests with no/invalid token with `401`.

---

## 1. POST /api/login
Authenticates a user and returns a JWT.

**Input (JSON body):**
```json
{ "username": "customer1", "password": "demo123" }
```

**Output — 200 OK:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "role": "customer",
  "name": "Jamie Customer"
}
```

**Output — 401 Unauthorized (bad credentials):**
```json
{ "error": "Invalid username or password" }
```

---

## 2. GET /api/products
Returns all products. No auth required (public catalog).

**Output — 200 OK:**
```json
[
  { "id": 1, "name": "Ceramic mug", "category": "Home", "price": 18, "stock": 42, "avgDailySales": 3, "icon": "☕" },
  { "id": 2, "name": "Woven tote bag", "category": "Accessories", "price": 32, "stock": 6, "avgDailySales": 4, "icon": "👜" }
]
```

---

## 3. POST /api/orders  (customer only)
Places an order. Validates stock, computes total, writes the order + order
items, and decrements product stock — all inside a single DB transaction.

**Headers:** `Authorization: Bearer <customer token>`

**Input:**
```json
{ "items": [ { "productId": 2, "qty": 2 } ] }
```

**Output — 201 Created:**
```json
{
  "orderId": 1,
  "total": 64,
  "items": [
    { "productId": 2, "name": "Woven tote bag", "qty": 2, "unitPrice": 32 }
  ]
}
```

**Output — 409 Conflict (not enough stock):**
```json
{ "error": "Insufficient stock for Hand-poured soap" }
```

**Output — 404 Not Found (bad product id):**
```json
{ "error": "Product 99 not found" }
```

---

## 4. GET /api/orders  (merchant only)
Returns all orders with their line items, newest first.

**Headers:** `Authorization: Bearer <merchant token>`

**Output — 200 OK:**
```json
[
  {
    "orderId": 1,
    "customerName": "Jamie Customer",
    "total": 64,
    "createdAt": "2026-07-26 23:32:56",
    "items": [ { "name": "Woven tote bag", "qty": 2, "unitPrice": 32 } ]
  }
]
```

---

## 5. GET /api/inventory-risk  (merchant only)
Returns products ranked by estimated days-of-stock-remaining
(`stock / avgDailySales`), flagged for reorder at ≤3 days.

**Headers:** `Authorization: Bearer <merchant token>`

**Output — 200 OK:**
```json
[
  { "id": 2, "name": "Woven tote bag", "stock": 4, "avgDailySales": 4, "daysLeft": 1, "status": "reorder" },
  { "id": 1, "name": "Ceramic mug", "stock": 42, "avgDailySales": 3, "daysLeft": 14, "status": "healthy" }
]
```

---

## 6. GET /api/kpis  (merchant only)
Aggregate dashboard metrics computed directly from the orders/products tables.

**Headers:** `Authorization: Bearer <merchant token>`

**Output — 200 OK:**
```json
{ "totalOrders": 1, "totalRevenue": 64, "avgOrderValue": 64, "lowStockCount": 3 }
```

---

## 7. POST /api/products  (merchant only)
Adds a new product to the catalog.

**Headers:** `Authorization: Bearer <merchant token>`

**Input:**
```json
{ "name": "Wool beanie", "category": "Accessories", "price": 22, "stock": 20, "avgDailySales": 2, "icon": "🧢" }
```

**Output — 201 Created:**
```json
{ "id": 7, "name": "Wool beanie", "category": "Accessories", "price": 22, "stock": 20, "avgDailySales": 2, "icon": "🧢" }
```

---

## 8. PUT /api/products/:id  (merchant only)
Edits an existing product — price, stock, category, name, average daily sales, or icon. Any field omitted keeps its current value.

**Headers:** `Authorization: Bearer <merchant token>`

**Input:**
```json
{ "stock": 50 }
```

**Output — 200 OK:**
```json
{ "id": 7, "name": "Wool beanie", "category": "Accessories", "price": 22, "stock": 50, "avgDailySales": 2, "icon": "🧢" }
```

**Output — 404 Not Found:**
```json
{ "error": "Product not found" }
```

---

## 9. GET /api/revenue-summary  (merchant only)
Returns revenue and order counts grouped by day (last 14), week (last 8), and month (last 12).

**Headers:** `Authorization: Bearer <merchant token>`

**Output — 200 OK:**
```json
{
  "daily": [ { "date": "2026-07-27", "revenue": 64, "orders": 1 } ],
  "weekly": [ { "weekStart": "2026-07-27", "revenue": 64, "orders": 1 } ],
  "monthly": [ { "month": "2026-07", "revenue": 64, "orders": 1 } ]
}
```

---

## 10. POST /api/register  (public)
Self-service registration for **customer** accounts only. Merchant accounts are provisioned separately (a real storefront doesn't let anyone self-signup as the shop owner). No email verification in this version — see README for the trade-off rationale.

**Input:**
```json
{ "username": "alexdoe", "password": "mypassword123", "name": "Alex Doe" }
```

**Output — 201 Created:**
```json
{ "token": "eyJhbGciOi...", "role": "customer", "name": "Alex Doe" }
```

**Output — 409 Conflict (username taken):**
```json
{ "error": "Username already taken" }
```

**Output — 400 Bad Request (password too short):**
```json
{ "error": "Password must be at least 6 characters" }
```

---

## 11. POST /api/products/:id/image  (merchant only)
Uploads a photo for a product. `multipart/form-data`, field name `image` (max 5MB).

**Headers:** `Authorization: Bearer <merchant token>`

**Output — 200 OK:**
```json
{ "id": 7, "imageUrl": "/uploads/1721234567890-beanie.jpg" }
```

Uploaded images are served statically at `http://localhost:3000/uploads/<filename>`, and `imageUrl` is now included in `GET /api/products` and `GET /api/inventory-risk` responses — the front end falls back to the emoji icon when no image has been uploaded.

---

## 12. GET /api/insights  (merchant only)
"Smart Advisor" — tries a real AI call first (Anthropic Claude), automatically falls back to a deterministic rules engine if the API key is missing, the call times out (8s), or the response is malformed. The response always tells you which one ran.

**Headers:** `Authorization: Bearer <merchant token>`

**Setup for real AI mode:** set `ANTHROPIC_API_KEY` as an environment variable before starting the server (see README). Without it, the endpoint still works — it just uses the rules engine.

**Output — 200 OK (AI succeeded):**
```json
{
  "insights": [
    { "type": "reorder", "message": "\"Woven tote bag\" has about 1 day(s) of stock left..." }
  ],
  "source": "ai"
}
```

**Output — 200 OK (fell back to rules):**
```json
{
  "insights": [ { "type": "reorder", "message": "..." } ],
  "source": "rules",
  "fallbackReason": "ANTHROPIC_API_KEY not set"
}
```
Other possible `fallbackReason` values: `"AI API returned 401"` (bad key), a timeout/abort error, or a JSON parse failure if the model didn't return valid JSON. In every case the endpoint still returns 200 with usable insights — it never surfaces the AI failure as an error to the merchant.

---

## 13. GET /api/my-orders  (customer only)
The logged-in customer's own order history — a customer only ever sees their own orders, never anyone else's.

**Headers:** `Authorization: Bearer <customer token>`

**Output — 200 OK:**
```json
[
  {
    "orderId": 1, "orderNo": "ORD-00001", "total": 64, "createdAt": "2026-08-03 18:02:38",
    "items": [ { "name": "Woven tote bag", "qty": 2, "unitPrice": 32 } ]
  }
]
```

---

## 14. GET /api/products/:id  (public)
Single product detail, including description and computed average rating.

**Output — 200 OK:**
```json
{ "id": 1, "name": "Ceramic mug", "category": "Home", "price": 18, "stock": 42, "avgDailySales": 3, "icon": "☕", "imageUrl": null, "description": "A hand-glazed stoneware mug...", "avgRating": 5, "reviewCount": 1 }
```

---

## 15. GET /api/products/:id/reviews  (public)
List reviews for a product, newest first.

**Output — 200 OK:**
```json
[ { "id": 1, "customerName": "Jamie Customer", "rating": 5, "comment": "Great everyday mug.", "createdAt": "2026-08-07 06:18:49" } ]
```

---

## 16. POST /api/products/:id/reviews  (customer only)
Submit a rating (1–5) and optional comment.

**Input:**
```json
{ "rating": 5, "comment": "Great mug!" }
```
**Output — 201 Created:**
```json
{ "id": 3, "customerName": "Jamie Customer", "rating": 5, "comment": "Great mug!", "createdAt": "..." }
```

---

## 17. PUT /api/orders/:id/status  (merchant only)
Advance an order's fulfillment status. Allowed values: `pending`, `shipped`, `completed`.

**Input:**
```json
{ "status": "shipped" }
```
**Output — 200 OK:**
```json
{ "orderId": 7, "orderNo": "ORD-00007", "status": "shipped" }
```
**Output — 400 (invalid status value):**
```json
{ "error": "status must be one of: pending, shipped, completed" }
```

---

## 18. POST /api/chat  (any logged-in user)
Basic AI assistant — business-focused context for merchants (inventory/revenue), catalog-focused for customers. Same AI-with-fallback pattern as `/api/insights`: tries a real Claude call if `ANTHROPIC_API_KEY` is set, falls back to a rules-based reply otherwise. No server-side conversation storage — the client sends recent history each time, which the rules-based fallback also uses for short-term memory (see below).

**The rules-based fallback genuinely searches live data, not a static message.** For customers, it matches the question against the real product catalog — a named category returns the actual matching products with live price/stock; a named product returns its real price and stock; a price-range question ("under $20", "cheapest") searches real prices; an unmatched question still returns the real category names rather than a generic platitude. For merchants, stock/reorder questions are checked against real days-of-stock-left, and revenue questions point to the live reporting panel.

**Short-term memory:** for brief follow-up messages (6 words or fewer), the rules engine looks at the last assistant reply in the supplied `history` array to resolve context-dependent questions — e.g., asking "how much?" right after being told about a specific product answers using that product; asking after a category listing that named multiple products triggers a clarifying "which one did you mean" instead of a generic no-match reply.

**Input:**
```json
{ "message": "What needs restocking?", "history": [ { "role": "user", "content": "..." }, { "role": "assistant", "content": "..." } ] }
```
**Output — 200 OK:**
```json
{ "reply": "These need attention soon: Woven tote bag, Hand-poured soap.", "source": "rules", "fallbackReason": "ANTHROPIC_API_KEY not set" }
```
**Output — 200 OK (customer, category match):**
```json
{ "reply": "In Accessories, we have: Woven tote bag ($32.00, 6 in stock); Leather wallet ($45.00, 9 in stock); Knit scarf ($28.00, 30 in stock).", "source": "rules", "fallbackReason": "ANTHROPIC_API_KEY not set" }
```
**Output — 200 OK (customer, ambiguous follow-up after a category listing):**
```json
{ "reply": "Which one did you mean — Ceramic mug, Scented candle?", "source": "rules", "fallbackReason": "ANTHROPIC_API_KEY not set" }
```

---

## Note on POST/PUT /api/products
These two endpoints now accept **either** `application/json` **or** `multipart/form-data`. Use multipart when uploading a photo at creation or edit time (field name `image`, alongside the other fields as form fields) — this lets a merchant add a product with its photo in a single submission, rather than creating the product first and uploading a photo as a separate step.

---

## 19. POST /api/verify-email  (public)
Confirms a registration code and returns a working login token. Required before a newly registered account can log in.

**Input:** `{ "username": "alexdoe", "code": "384729" }`
**Output — 200 OK:** `{ "token": "...", "role": "customer", "name": "Alex Doe" }`
**Output — 400:** `{ "error": "Invalid verification code" }` or `{ "error": "Verification code has expired" }`

---

## 20. POST /api/resend-verification  (public)
**Input:** `{ "username": "alexdoe" }`
**Output — 200:** `{ "message": "...", "devCode": "384729" }` — `devCode` only present when SMTP isn't configured.

---

## 21. POST /api/forgot-password  (public)
Always returns 200 (even for a non-existent username) to avoid leaking which usernames exist.
**Input:** `{ "username": "customer1" }`
**Output — 200:** `{ "message": "If that account exists, a reset code has been sent.", "devCode": "384729" }`

---

## 22. POST /api/reset-password  (public)
**Input:** `{ "username": "customer1", "code": "384729", "newPassword": "newpass123" }`
**Output — 200:** `{ "message": "Password updated — you can now log in." }`
**Output — 400:** `{ "error": "Invalid code" }` or `{ "error": "Code has expired" }`

---

## Email delivery (verify-email / resend-verification / forgot-password)
All three endpoints above try to send a real email via SMTP first. If `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` aren't set as environment variables, they fall back to **dev mode**: the response includes the code directly as `devCode`, and the front end displays it in a labeled banner instead of requiring an inbox. See README for how to configure a real Gmail SMTP sender.

---

## 23. POST /api/messages/send  (any logged-in user)
Customer input: `{ "content": "Is this in stock?" }` — recipient is resolved server-side to the merchant.
Merchant input: `{ "content": "Yes, 3 left!", "customerId": 4 }`
**Output — 201:** `{ "id": 5, "senderId": 1, "recipientId": 2, "content": "...", "createdAt": "..." }`

## 24. GET /api/messages/thread  (customer only)
Full thread with the merchant, oldest first. Also marks incoming messages as read.
**Output:** `[ { "id": 1, "senderId": 1, "isMine": true, "content": "...", "createdAt": "..." } ]`

## 25. GET /api/messages/thread/:customerId  (merchant only)
Same shape as above, for a specific customer conversation.

## 26. GET /api/messages/conversations  (merchant only)
One row per customer who has exchanged messages, sorted by most recent activity.
**Output:** `[ { "customerId": 4, "customerName": "Jamie Customer", "lastMessage": "...", "lastAt": "...", "unreadCount": 2 } ]`

## 27. GET /api/messages/unread-count  (any logged-in user)
**Output:** `{ "count": 3 }`

---

## 28. DELETE /api/products/:id  (merchant only)
Deletes a product outright. Blocked with 409 if the product has any order history — deleting it would corrupt past order records (an order_item pointing to a product_id that no longer exists). Its reviews are removed along with it.

**Output — 200 OK:** `{ "id": 7, "deleted": true, "name": "Wool beanie" }`
**Output — 409 Conflict:** `{ "error": "Cannot delete \"Wool beanie\" — it has 2 existing order(s) referencing it. Deleting it would corrupt past order records." }`
**Output — 404 Not Found:** `{ "error": "Product not found" }`

---

## Error format (all endpoints)
```json
{ "error": "human-readable message" }
```

| Status | Meaning |
|---|---|
| 400 | Malformed request body |
| 401 | Missing/invalid/expired token, or bad login credentials |
| 403 | Valid token, but wrong role for this endpoint |
| 404 | Referenced resource (e.g. product) doesn't exist |
| 409 | Valid request but conflicts with current state (e.g. insufficient stock) |
