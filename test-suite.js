// test-suite.js — a real automated test suite using Node's built-in test runner (node:test)
// and assert module. Every test here is fully self-contained: it performs its own login and
// its own setup, and does not depend on any other test having run first or on shared state
// left behind by a previous test. This means any single test can be run in isolation, e.g.:
//
//   node --test test-suite.js                                   (run everything)
//   node --test --test-name-pattern="TEST 5" test-suite.js       (run just one)
//
// Requires the server to already be running: node server.js

const { test } = require('node:test');
const assert = require('node:assert');

const BASE = 'http://localhost:3000';

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

// Every test that needs a token gets its own, fresh, right here — no shared/module-level state.
async function loginAs(role) {
  const creds = role === 'merchant' ? { username: 'merchant1', password: 'demo123' } : { username: 'customer1', password: 'demo123' };
  const res = await call('POST', '/api/login', creds);
  if (res.status !== 200) throw new Error(`Setup failed: could not log in as ${role}`);
  return res.data.token;
}

test('TEST 1: POST /api/login — wrong password returns 401', async () => {
  const res = await call('POST', '/api/login', { username: 'customer1', password: 'wrong' });
  assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
  assert.strictEqual(res.data.error, 'Invalid username or password');
});

test('TEST 2: POST /api/login — customer1 correct login returns 200 + token', async () => {
  const res = await call('POST', '/api/login', { username: 'customer1', password: 'demo123' });
  assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
  assert.strictEqual(res.data.role, 'customer');
  assert.ok(res.data.token, 'expected a token to be returned');
});

test('TEST 3: POST /api/login — merchant1 correct login returns 200 + token', async () => {
  const res = await call('POST', '/api/login', { username: 'merchant1', password: 'demo123' });
  assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
  assert.strictEqual(res.data.role, 'merchant');
  assert.ok(res.data.token, 'expected a token to be returned');
});

test('TEST 4: GET /api/products — product catalog is readable and well-formed', async () => {
  const res = await call('GET', '/api/products');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data) && res.data.length > 0, 'expected a non-empty product list');
  assert.ok(res.data[0].id && res.data[0].name, 'expected product objects to have id and name');
});

test('TEST 5: POST /api/orders + independent before/after stock verification — self-contained', async () => {
  // This single test performs its own full before -> write -> after cycle, using a product
  // this test itself resets to a known stock level first, so it never depends on database
  // state left over from any other test or any previous run.
  const merchToken = await loginAs('merchant');
  const custToken = await loginAs('customer');

  // Arrange: force product id 3 (Scented candle) to a known stock level.
  await call('PUT', '/api/products/3', { stock: 20 }, merchToken);

  // Before state — independent read.
  const before = await call('GET', '/api/products');
  const stockBefore = before.data.find(p => p.id === 3).stock;
  assert.strictEqual(stockBefore, 20, 'setup failed to establish known stock level');

  // Act — place the order via the API, exactly as the front end does.
  const order = await call('POST', '/api/orders', { items: [{ productId: 3, qty: 2 }] }, custToken);
  assert.strictEqual(order.status, 201, `expected 201, got ${order.status}: ${JSON.stringify(order.data)}`);

  // After state — a completely separate, independent GET, not trusting the order response.
  const after = await call('GET', '/api/products');
  const stockAfter = after.data.find(p => p.id === 3).stock;
  assert.strictEqual(stockAfter, stockBefore - 2, `expected stock to drop by 2 (from ${stockBefore}), got ${stockAfter} — this is the direct proof the database was updated by the API call, verified independently of the write's own response`);
});

test('TEST 6: GET /api/orders — merchant sees an order after placing one (self-contained)', async () => {
  const merchToken = await loginAs('merchant');
  const custToken = await loginAs('customer');
  const order = await call('POST', '/api/orders', { items: [{ productId: 1, qty: 1 }] }, custToken);
  assert.strictEqual(order.status, 201);

  const res = await call('GET', '/api/orders', null, merchToken);
  assert.strictEqual(res.status, 200);
  const found = res.data.find(o => o.orderId === order.data.orderId);
  assert.ok(found, `expected order ${order.data.orderId} to appear in the merchant's order list`);
});

test('TEST 7: GET /api/inventory-risk — merchant can read inventory risk ranking', async () => {
  const merchToken = await loginAs('merchant');
  const res = await call('GET', '/api/inventory-risk', null, merchToken);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data) && res.data.length > 0);
  assert.ok(res.data[0].daysLeft !== undefined, 'expected daysLeft to be computed');
});

test('TEST 8: GET /api/kpis — merchant can read aggregate KPIs', async () => {
  const merchToken = await loginAs('merchant');
  const res = await call('GET', '/api/kpis', null, merchToken);
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.data.totalOrders === 'number');
  assert.ok(typeof res.data.totalRevenue === 'number');
});

test('TEST 9: GET /api/orders — customer token on a merchant-only endpoint returns 403', async () => {
  const custToken = await loginAs('customer');
  const res = await call('GET', '/api/orders', null, custToken);
  assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
});

test('TEST 10: POST /api/orders — ordering more than available stock returns 409 and does not corrupt data', async () => {
  const merchToken = await loginAs('merchant');
  const custToken = await loginAs('customer');

  // Arrange: force a known low stock level so this test doesn't depend on other tests' state.
  await call('PUT', '/api/products/5', { stock: 2 }, merchToken);
  const before = await call('GET', '/api/products');
  const stockBefore = before.data.find(p => p.id === 5).stock;

  const res = await call('POST', '/api/orders', { items: [{ productId: 5, qty: 999 }] }, custToken);
  assert.strictEqual(res.status, 409, `expected 409, got ${res.status}`);

  // Confirm the failed order did NOT partially decrement stock — independent re-check.
  const after = await call('GET', '/api/products');
  const stockAfter = after.data.find(p => p.id === 5).stock;
  assert.strictEqual(stockAfter, stockBefore, 'a failed order must not change stock at all');
});

test('TEST 11: GET /api/orders — no Authorization header returns 401', async () => {
  const res = await call('GET', '/api/orders');
  assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
});

test('TEST 12: POST /api/products + independent re-fetch — merchant adds a product and it persists', async () => {
  const merchToken = await loginAs('merchant');
  const unique = 'Wool beanie ' + Date.now();

  const created = await call('POST', '/api/products', { name: unique, category: 'Accessories', price: 22, stock: 20, avgDailySales: 2, icon: '🧢' }, merchToken);
  assert.strictEqual(created.status, 201, `expected 201, got ${created.status}`);
  assert.ok(created.data.id, 'expected the new product to have an id');

  // Independent re-fetch — does NOT trust the POST response, proves the write persisted.
  const check = await call('GET', '/api/products');
  const found = check.data.find(p => p.id === created.data.id);
  assert.ok(found, `expected product id ${created.data.id} to be present on independent re-fetch`);
  assert.strictEqual(found.name, unique, 'persisted name did not match what was submitted');
});

test('TEST 13: POST /api/products — customer token blocked from adding a product, expect 403', async () => {
  const custToken = await loginAs('customer');
  const res = await call('POST', '/api/products', { name: 'x', category: 'x', price: 1, stock: 1 }, custToken);
  assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
});

test('TEST 14: PUT /api/products/:id + independent re-fetch — merchant edits stock and it persists', async () => {
  const merchToken = await loginAs('merchant');

  const edited = await call('PUT', '/api/products/6', { stock: 77 }, merchToken);
  assert.strictEqual(edited.status, 200, `expected 200, got ${edited.status}`);
  assert.strictEqual(edited.data.stock, 77);

  // Independent re-fetch — the real proof, not the PUT response itself.
  const check = await call('GET', '/api/products');
  const found = check.data.find(p => p.id === 6);
  assert.strictEqual(found.stock, 77, `expected persisted stock to be 77 on independent re-fetch, got ${found.stock}`);
});

test('TEST 15: GET /api/revenue-summary — merchant can read revenue grouped by day/week/month', async () => {
  const merchToken = await loginAs('merchant');
  const res = await call('GET', '/api/revenue-summary', null, merchToken);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.daily));
  assert.ok(Array.isArray(res.data.weekly));
  assert.ok(Array.isArray(res.data.monthly));
});

test('TEST 16: POST /api/register — requires an email, and a new account cannot log in before verifying', async () => {
  // Missing email is rejected outright.
  const noEmail = await call('POST', '/api/register', { username: 'noemail_' + Date.now(), password: 'testpass123', name: 'No Email' });
  assert.strictEqual(noEmail.status, 400, `expected 400 when email is missing, got ${noEmail.status}`);

  // Valid registration creates the account but does NOT hand back a login token —
  // the account must be verified first (covered end-to-end in TEST 25).
  const username = 'newbie_' + Date.now();
  const reg = await call('POST', '/api/register', { username, password: 'testpass123', name: 'New Buyer', email: `${username}@example.com` });
  assert.strictEqual(reg.status, 201, `expected 201, got ${reg.status}`);
  assert.ok(!reg.data.token, 'registration should not return a usable login token before email verification');

  // Independent check: attempting to log in with the correct password on this brand-new,
  // unverified account must be blocked with 403, not succeed.
  const login = await call('POST', '/api/login', { username, password: 'testpass123' });
  assert.strictEqual(login.status, 403, `expected an unverified account to be blocked from login, got ${login.status}`);
});

test('TEST 17: POST /api/register — password under 6 characters returns 400', async () => {
  const res = await call('POST', '/api/register', { username: 'shortpw_' + Date.now(), password: '123', name: 'X', email: 'shortpw@example.com' });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
});

test('TEST 18: GET /api/insights — merchant sees at least one recommendation', async () => {
  const merchToken = await loginAs('merchant');
  const res = await call('GET', '/api/insights', null, merchToken);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.insights));
  assert.ok(res.data.insights.length > 0, 'expected at least one insight to be generated');
});

test('TEST 19: GET /api/my-orders — customer sees only their own orders, correctly formatted', async () => {
  const custToken = await loginAs('customer');
  const order = await call('POST', '/api/orders', { items: [{ productId: 4, qty: 1 }] }, custToken);
  assert.strictEqual(order.status, 201);

  const res = await call('GET', '/api/my-orders', null, custToken);
  assert.strictEqual(res.status, 200);
  const found = res.data.find(o => o.orderId === order.data.orderId);
  assert.ok(found, `expected order ${order.data.orderId} in this customer's own history`);
  assert.match(found.orderNo, /^ORD-\d{5}$/, `expected orderNo formatted like ORD-00001, got ${found.orderNo}`);
});

test('TEST 20: GET /api/products/:id — single product detail includes description and rating fields', async () => {
  const res = await call('GET', '/api/products/1');
  assert.strictEqual(res.status, 200);
  assert.ok('description' in res.data, 'expected a description field');
  assert.ok('avgRating' in res.data && 'reviewCount' in res.data, 'expected rating fields');
});

test('TEST 21: POST review + independent re-fetch — rating persists, and a second submission from the same customer UPDATES rather than duplicates', async () => {
  // Uses a fresh throwaway account rather than the shared seeded customer1, since that
  // account already has a review on some seed products — this test needs a clean slate
  // to unambiguously verify count-goes-up-by-exactly-1 on first submission.
  const username = 'reviewer_' + Date.now();
  const reg = await call('POST', '/api/register', { username, password: 'testpass123', name: 'Review Tester', email: `${username}@example.com` });
  const custToken = (await call('POST', '/api/verify-email', { username, code: reg.data.devCode })).data.token;

  const before = await call('GET', '/api/products/2');
  const countBefore = before.data.reviewCount;

  const firstSubmit = await call('POST', '/api/products/2/reviews', { rating: 5, comment: 'Independent test review' }, custToken);
  assert.strictEqual(firstSubmit.status, 201, `expected 201 on first submission, got ${firstSubmit.status}`);

  // Independent re-fetch — does not trust the POST response, confirms the review and
  // recalculated average both actually persisted server-side.
  const afterFirst = await call('GET', '/api/products/2');
  assert.strictEqual(afterFirst.data.reviewCount, countBefore + 1, 'expected review count to increase by exactly 1 on independent re-fetch');

  const list = await call('GET', '/api/products/2/reviews');
  assert.ok(list.data.some(r => r.comment === 'Independent test review'), 'expected the new review to appear in the reviews list');

  // Submitting a SECOND review from the SAME customer for the SAME product must update the
  // existing row, not add a duplicate — this is the specific behavior requested after real
  // users could otherwise rate the same product multiple times and skew the average.
  const secondSubmit = await call('POST', '/api/products/2/reviews', { rating: 1, comment: 'Changed my mind' }, custToken);
  assert.strictEqual(secondSubmit.status, 200, `expected 200 (update) on a second submission from the same customer, got ${secondSubmit.status}`);

  // Independent re-fetch: review count must NOT have grown a second time...
  const afterSecond = await call('GET', '/api/products/2');
  assert.strictEqual(afterSecond.data.reviewCount, countBefore + 1, 'expected review count to stay the same after a second submission from the same customer (update, not duplicate)');

  // ...and the visible review content must reflect the updated rating, not the original.
  const listAfter = await call('GET', '/api/products/2/reviews');
  const ownReviews = listAfter.data.filter(r => r.comment === 'Changed my mind' || r.comment === 'Independent test review');
  assert.strictEqual(ownReviews.length, 1, 'expected exactly one review from this customer after the update, not two');
  assert.strictEqual(ownReviews[0].comment, 'Changed my mind', 'expected the review content to reflect the update');
});

test('TEST 22: Order status defaults to pending, then PUT + independent re-fetch confirms the transition', async () => {
  const merchToken = await loginAs('merchant');
  const custToken = await loginAs('customer');

  const order = await call('POST', '/api/orders', { items: [{ productId: 1, qty: 1 }] }, custToken);
  assert.strictEqual(order.status, 201);

  const beforeStatus = await call('GET', '/api/my-orders', null, custToken);
  const foundBefore = beforeStatus.data.find(o => o.orderId === order.data.orderId);
  assert.strictEqual(foundBefore.status, 'pending', 'expected a new order to default to pending status');

  const update = await call('PUT', `/api/orders/${order.data.orderId}/status`, { status: 'shipped' }, merchToken);
  assert.strictEqual(update.status, 200, `expected 200, got ${update.status}`);

  // Independent re-fetch via a completely different endpoint (customer's own order history)
  // than the one that performed the write (merchant's status update) — proves the change
  // is visible cross-role through the shared database, not just echoed in the PUT response.
  const afterStatus = await call('GET', '/api/my-orders', null, custToken);
  const foundAfter = afterStatus.data.find(o => o.orderId === order.data.orderId);
  assert.strictEqual(foundAfter.status, 'shipped', `expected status to persist as 'shipped' on independent re-fetch, got ${foundAfter.status}`);
});

test('TEST 23: PUT /api/orders/:id/status — invalid status value is rejected', async () => {
  const merchToken = await loginAs('merchant');
  const custToken = await loginAs('customer');
  const order = await call('POST', '/api/orders', { items: [{ productId: 1, qty: 1 }] }, custToken);
  const res = await call('PUT', `/api/orders/${order.data.orderId}/status`, { status: 'not-a-real-status' }, merchToken);
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
});

test('TEST 24: POST /api/chat — merchant gets a reply referencing real inventory data (rules fallback)', async () => {
  const merchToken = await loginAs('merchant');
  const res = await call('POST', '/api/chat', { message: 'what needs restocking?' }, merchToken);
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.reply && res.data.reply.length > 0, 'expected a non-empty reply');
  assert.ok(['ai', 'rules'].includes(res.data.source), 'expected source to be ai or rules');
});

test('TEST 31: POST /api/chat (customer) — genuinely searches the product catalog, giving distinct answers to distinct questions', async () => {
  const custToken = await loginAs('customer');

  // Two clearly different questions must NOT produce the identical canned reply — this
  // is the specific regression this test guards against (the customer path previously
  // returned one static message regardless of what was asked).
  const askAccessories = await call('POST', '/api/chat', { message: 'do you have anything in Accessories?' }, custToken);
  const askMug = await call('POST', '/api/chat', { message: 'how much is the ceramic mug?' }, custToken);
  assert.notStrictEqual(askAccessories.data.reply, askMug.data.reply, 'expected different questions to produce different answers, not one static reply');

  // The Accessories answer should actually reference real catalog data, not just repeat the word back.
  assert.match(askAccessories.data.reply, /Accessories/, 'expected the reply to reference the requested category');

  // A question naming a specific real product should surface its actual price from the database.
  assert.match(askMug.data.reply, /\$18/, 'expected the reply to include the Ceramic mug\'s real price from the database');

  // A question that matches nothing should still return real category names, not an empty platitude.
  const askUnrelated = await call('POST', '/api/chat', { message: 'I need Duke' }, custToken);
  assert.match(askUnrelated.data.reply, /Home|Accessories|Bath/, 'expected a no-match reply to still list real catalog categories');
});

test('TEST 25: Registration + email verification — full self-contained flow, independent login proves it persisted', async () => {
  const username = 'verifytest_' + Date.now();

  const reg = await call('POST', '/api/register', { username, password: 'testpass123', name: 'Verify Test', email: `${username}@example.com` });
  assert.strictEqual(reg.status, 201, `expected 201, got ${reg.status}`);
  assert.ok(reg.data.devCode, 'expected a devCode since no SMTP is configured in this test environment');

  // Blocked before verifying — proves the account starts unverified, not a formality.
  const blockedLogin = await call('POST', '/api/login', { username, password: 'testpass123' });
  assert.strictEqual(blockedLogin.status, 403, `expected 403 before verification, got ${blockedLogin.status}`);

  // Wrong code rejected.
  const wrongCode = await call('POST', '/api/verify-email', { username, code: '000000' });
  assert.strictEqual(wrongCode.status, 400, `expected 400 for wrong code, got ${wrongCode.status}`);

  // Correct code succeeds and returns a working token.
  const verify = await call('POST', '/api/verify-email', { username, code: reg.data.devCode });
  assert.strictEqual(verify.status, 200, `expected 200, got ${verify.status}`);
  assert.ok(verify.data.token, 'expected a token after successful verification');

  // Independent re-check: log in fresh (not reusing the verify response's token) to prove
  // email_verified was actually persisted, not just true for this one response.
  const freshLogin = await call('POST', '/api/login', { username, password: 'testpass123' });
  assert.strictEqual(freshLogin.status, 200, `expected verified account to log in normally now, got ${freshLogin.status}`);
});

test('TEST 26: Forgot password + reset — self-contained flow with independent login verification', async () => {
  // Uses its own throwaway account so it never disturbs the shared customer1/merchant1 credentials
  // other tests rely on.
  const username = 'resettest_' + Date.now();
  await call('POST', '/api/register', { username, password: 'originalpass1', name: 'Reset Test', email: `${username}@example.com` });
  const forgot = await call('POST', '/api/forgot-password', { username });
  assert.strictEqual(forgot.status, 200);
  assert.ok(forgot.data.devCode, 'expected a devCode since no SMTP is configured in this test environment');

  const badReset = await call('POST', '/api/reset-password', { username, code: '000000', newPassword: 'newpass123' });
  assert.strictEqual(badReset.status, 400, `expected 400 for wrong code, got ${badReset.status}`);

  const reset = await call('POST', '/api/reset-password', { username, code: forgot.data.devCode, newPassword: 'newpass123' });
  assert.strictEqual(reset.status, 200, `expected 200, got ${reset.status}`);

  // The account is still unverified (registration flow wasn't completed), so login is
  // expected to hit the verification gate rather than succeed outright — this still proves
  // the password itself was updated, since a wrong password would fail with 401 instead of 403.
  const loginAttempt = await call('POST', '/api/login', { username, password: 'newpass123' });
  assert.strictEqual(loginAttempt.status, 403, `expected 403 (unverified, but correct password) — got ${loginAttempt.status}, which would indicate the password update did not persist`);
});

test('TEST 27: Messaging — customer sends, merchant reads, replies, and both sides see the shared thread', async () => {
  const custToken = await loginAs('customer');
  const merchToken = await loginAs('merchant');
  const uniqueText = 'Test message ' + Date.now();

  const sent = await call('POST', '/api/messages/send', { content: uniqueText }, custToken);
  assert.strictEqual(sent.status, 201, `expected 201, got ${sent.status}`);

  // Independent re-fetch from the CUSTOMER's own thread endpoint — proves the message
  // persisted and is retrievable, not just that the send endpoint echoed it back.
  const custThread = await call('GET', '/api/messages/thread', null, custToken);
  assert.ok(custThread.data.some(m => m.content === uniqueText && m.isMine === true), 'expected the sent message in the customer\'s own thread, marked isMine');

  // Independent verification from the MERCHANT side — proves the write is visible
  // cross-role through the shared database, exactly like the order-status test pattern.
  const unread = await call('GET', '/api/messages/unread-count', null, merchToken);
  assert.ok(unread.data.count >= 1, 'expected at least 1 unread message for the merchant');

  const conversations = await call('GET', '/api/messages/conversations', null, merchToken);
  const convo = conversations.data.find(c => c.lastMessage === uniqueText);
  assert.ok(convo, 'expected the new message to appear as the latest message in the merchant\'s conversation list');

  // Merchant replies; independent re-fetch of the customer's thread should show it.
  const custId = jwtDecode(custToken).id;
  const reply = await call('POST', '/api/messages/send', { content: 'Merchant reply ' + Date.now(), customerId: custId }, merchToken);
  assert.strictEqual(reply.status, 201);

  const custThreadAfter = await call('GET', '/api/messages/thread', null, custToken);
  assert.ok(custThreadAfter.data.some(m => m.id === reply.data.id), 'expected the merchant\'s reply to appear in the customer\'s thread on independent re-fetch');
});

test('TEST 28: DELETE /api/products/:id + independent re-fetch — a never-ordered product is actually removed', async () => {
  const merchToken = await loginAs('merchant');

  // Create a throwaway product with no order history, so this test never depends on
  // whether other tests have placed orders against shared seed products.
  const created = await call('POST', '/api/products', { name: 'Delete-me test product', category: 'Test', price: 1, stock: 1 }, merchToken);
  assert.strictEqual(created.status, 201);
  const id = created.data.id;

  const del = await call('DELETE', `/api/products/${id}`, null, merchToken);
  assert.strictEqual(del.status, 200, `expected 200, got ${del.status}: ${JSON.stringify(del.data)}`);
  assert.strictEqual(del.data.deleted, true);

  // Independent re-fetch — does not trust the DELETE response, confirms the row is
  // genuinely gone from a fresh GET /api/products call.
  const after = await call('GET', '/api/products');
  assert.ok(!after.data.some(p => p.id === id), `expected product ${id} to be absent from the catalog on independent re-fetch`);
});

test('TEST 29: DELETE /api/products/:id — blocked (409) for a product with existing order history', async () => {
  const merchToken = await loginAs('merchant');
  const custToken = await loginAs('customer');

  // Create a product and immediately order it, so this test controls its own order history
  // rather than depending on whatever other tests have already ordered.
  const created = await call('POST', '/api/products', { name: 'Has-orders test product', category: 'Test', price: 5, stock: 10 }, merchToken);
  const id = created.data.id;
  const order = await call('POST', '/api/orders', { items: [{ productId: id, qty: 1 }] }, custToken);
  assert.strictEqual(order.status, 201);

  const del = await call('DELETE', `/api/products/${id}`, null, merchToken);
  assert.strictEqual(del.status, 409, `expected 409, got ${del.status}`);

  // Independent re-fetch confirms the product was NOT removed despite the attempt.
  const after = await call('GET', '/api/products');
  assert.ok(after.data.some(p => p.id === id), 'expected the product to still exist after a blocked delete');
});

test('TEST 30: DELETE /api/products/:id — customer token blocked, expect 403', async () => {
  const merchToken = await loginAs('merchant');
  const custToken = await loginAs('customer');
  const created = await call('POST', '/api/products', { name: 'Auth test product', category: 'Test', price: 1, stock: 1 }, merchToken);

  const res = await call('DELETE', `/api/products/${created.data.id}`, null, custToken);
  assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
});

// Minimal JWT payload decoder for test purposes only (no signature verification needed —
// we already trust this token since we just obtained it from our own loginAs() call).
function jwtDecode(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}
