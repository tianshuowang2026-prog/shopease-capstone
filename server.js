// server.js — REST API for ShopEase (customer storefront + merchant admin backend)
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { sendCodeEmail, generateCode, isConfigured: mailerConfigured } = require('./mailer');

const app = express();
app.use(cors());
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, ''))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB cap

const JWT_SECRET = 'shopease-capstone-demo-secret'; // demo only — use env var in production

// ---------- Auth middleware ----------
function authenticate(requiredRole) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    try {
      const payload = jwt.verify(header.split(' ')[1], JWT_SECRET);
      if (requiredRole && payload.role !== requiredRole) {
        return res.status(403).json({ error: `Requires ${requiredRole} role` });
      }
      req.user = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// ---------- POST /api/login ----------
// Input:  { "username": "customer1", "password": "demo123" }
// Output: { "token": "...", "role": "customer", "name": "Jamie Customer" }
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'Please verify your email before logging in.', needsVerification: true, username: user.username });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, role: user.role, name: user.name });
});

// ---------- POST /api/register (public) — simplified registration, customer accounts only ----------
// Merchant accounts are provisioned separately (real-world pattern: store owners are vetted, not self-signup).
// Creates the account in an UNVERIFIED state and sends (or dev-mode-returns) a 6-digit email
// verification code. The account cannot log in until POST /api/verify-email succeeds.
// Input:  { "username": "newcustomer", "password": "mypassword123", "name": "Alex Doe", "email": "alex@example.com" }
// Output: 201 { "message": "...", "devCode": "384729" }   — devCode only present if SMTP isn't configured
app.post('/api/register', async (req, res) => {
  const { username, password, name, email } = req.body;
  if (!username || !password || !name || !email) {
    return res.status(400).json({ error: 'username, password, name, and email are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 8);
  const result = db.prepare('INSERT INTO users (username, password_hash, role, name, email, email_verified) VALUES (?, ?, ?, ?, ?, 0)')
    .run(username, hash, 'customer', name, email);
  const userId = result.lastInsertRowid;

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO verification_codes (user_id, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(userId, code, 'verify_email', expiresAt);

  const mailResult = await sendCodeEmail({ to: email, subject: 'Verify your ShopEase account', code, purposeLabel: 'email verification' });
  const response = { message: mailResult.sent ? 'Verification code sent to your email.' : 'Account created — email delivery is not configured, use the code below.' };
  if (!mailResult.sent) response.devCode = code;
  res.status(201).json(response);
});

// ---------- POST /api/verify-email (public) — confirm a registration code and log the user in ----------
// Input:  { "username": "newcustomer", "code": "384729" }
// Output: 200 { "token": "...", "role": "customer", "name": "Alex Doe" }
app.post('/api/verify-email', (req, res) => {
  const { username, code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.email_verified) return res.status(400).json({ error: 'Account is already verified' });

  const record = db.prepare(`
    SELECT * FROM verification_codes
    WHERE user_id = ? AND code = ? AND purpose = 'verify_email' AND used = 0
    ORDER BY id DESC LIMIT 1
  `).get(user.id, code);
  if (!record) return res.status(400).json({ error: 'Invalid verification code' });
  if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'Verification code has expired' });

  db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(record.id);
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, role: user.role, name: user.name });
});

// ---------- POST /api/resend-verification (public) ----------
// Input:  { "username": "newcustomer" }
// Output: 200 { "message": "...", "devCode": "384729" }
app.post('/api/resend-verification', async (req, res) => {
  const { username } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.email_verified) return res.status(400).json({ error: 'Account is already verified' });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO verification_codes (user_id, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(user.id, code, 'verify_email', expiresAt);

  const mailResult = await sendCodeEmail({ to: user.email, subject: 'Your new ShopEase verification code', code, purposeLabel: 'email verification' });
  const response = { message: mailResult.sent ? 'Verification code sent to your email.' : 'Email delivery is not configured, use the code below.' };
  if (!mailResult.sent) response.devCode = code;
  res.json(response);
});

// ---------- POST /api/forgot-password (public) ----------
// Input:  { "username": "customer1" }
// Output: 200 { "message": "...", "devCode": "384729" }   — always 200 even if the account doesn't
// exist, so this endpoint can't be used to enumerate valid usernames.
app.post('/api/forgot-password', async (req, res) => {
  const { username } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.email) {
    return res.json({ message: 'If that account exists, a reset code has been sent.' });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO verification_codes (user_id, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(user.id, code, 'reset_password', expiresAt);

  const mailResult = await sendCodeEmail({ to: user.email, subject: 'Reset your ShopEase password', code, purposeLabel: 'password reset' });
  const response = { message: 'If that account exists, a reset code has been sent.' };
  if (!mailResult.sent) response.devCode = code; // dev mode: surfaced since there's no real inbox to check
  res.json(response);
});

// ---------- POST /api/reset-password (public) ----------
// Input:  { "username": "customer1", "code": "384729", "newPassword": "newpass123" }
// Output: 200 { "message": "Password updated — you can now log in." }
app.post('/api/reset-password', (req, res) => {
  const { username, code, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(400).json({ error: 'Invalid code' }); // deliberately vague, mirrors forgot-password's non-enumeration behavior

  const record = db.prepare(`
    SELECT * FROM verification_codes
    WHERE user_id = ? AND code = ? AND purpose = 'reset_password' AND used = 0
    ORDER BY id DESC LIMIT 1
  `).get(user.id, code);
  if (!record) return res.status(400).json({ error: 'Invalid code' });
  if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'Code has expired' });

  db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(record.id);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 8), user.id);
  res.json({ message: 'Password updated — you can now log in.' });
});
// Output: [ { "id":1, "name":"Ceramic mug", "category":"Home", "price":18, "stock":42, "avgDailySales":3, "icon":"☕", "imageUrl":null, "description":"..." }, ... ]
app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT id, name, category, price, stock, avg_daily_sales AS avgDailySales, icon, image_url AS imageUrl, description FROM products').all();
  res.json(rows);
});

// ---------- GET /api/products/:id (public) — single product detail, including average rating ----------
// Output: { "id":1, "name":"Ceramic mug", ..., "description":"...", "avgRating": 4.5, "reviewCount": 2 }
app.get('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT id, name, category, price, stock, avg_daily_sales AS avgDailySales, icon, image_url AS imageUrl, description FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const { avgRating, reviewCount } = db.prepare('SELECT AVG(rating) AS avgRating, COUNT(*) AS reviewCount FROM reviews WHERE product_id = ?').get(id);
  res.json({ ...product, avgRating: avgRating ? +avgRating.toFixed(1) : null, reviewCount });
});

// ---------- GET /api/products/:id/reviews (public) — list reviews for a product ----------
// Output: [ { "id":1, "customerName":"Jamie Customer", "rating":5, "comment":"...", "createdAt":"..." }, ... ]
app.get('/api/products/:id/reviews', (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare('SELECT id, customer_name AS customerName, rating, comment, created_at AS createdAt FROM reviews WHERE product_id = ? ORDER BY id DESC').all(id);
  res.json(rows);
});

// ---------- POST /api/products/:id/reviews (customer only) — submit a rating + optional comment ----------
// Input:  { "rating": 5, "comment": "Great mug!" }
// Output: 201 { "id":3, "customerName":"Jamie Customer", "rating":5, "comment":"Great mug!", "createdAt":"..." }
app.post('/api/products/:id/reviews', authenticate('customer'), (req, res) => {
  const productId = Number(req.params.id);
  const { rating, comment } = req.body;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
  }
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const result = db.prepare('INSERT INTO reviews (product_id, customer_id, customer_name, rating, comment) VALUES (?, ?, ?, ?, ?)')
    .run(productId, req.user.id, req.user.name, rating, comment || null);
  const created = db.prepare('SELECT id, customer_name AS customerName, rating, comment, created_at AS createdAt FROM reviews WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(created);
});

// ---------- POST /api/orders (customer only) ----------
// Input:  { "items": [ { "productId": 1, "qty": 2 }, { "productId": 3, "qty": 1 } ] }
// Output: { "orderId": 7, "total": 50.00, "items": [ { "productId":1,"name":"Ceramic mug","qty":2,"unitPrice":18 }, ... ] }
app.post('/api/orders', authenticate('customer'), (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const updateStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
  const insertOrder = db.prepare('INSERT INTO orders (customer_id, total) VALUES (?, ?)');
  const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    let total = 0;
    const lineItems = [];
    for (const it of items) {
      const product = getProduct.get(it.productId);
      if (!product) throw { status: 404, message: `Product ${it.productId} not found` };
      if (product.stock < it.qty) throw { status: 409, message: `Insufficient stock for ${product.name}` };
      total += product.price * it.qty;
      lineItems.push({ productId: product.id, name: product.name, qty: it.qty, unitPrice: product.price });
    }
    const orderId = insertOrder.run(req.user.id, total).lastInsertRowid;
    for (const li of lineItems) {
      insertItem.run(orderId, li.productId, li.qty, li.unitPrice);
      updateStock.run(li.qty, li.productId);
    }
    db.exec('COMMIT');
    res.status(201).json({ orderId, orderNo: 'ORD-' + String(orderId).padStart(5, '0'), total, items: lineItems });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message || 'Order failed' });
  }
});

// ---------- GET /api/my-orders (customer only) — the logged-in customer's own order history ----------
// Output: [ { "orderId":7, "orderNo":"ORD-00007", "total":50.0, "createdAt":"...", "items":[...] }, ... ]
app.get('/api/my-orders', authenticate('customer'), (req, res) => {
  const orders = db.prepare(`
    SELECT o.id AS orderId, o.total, o.status, o.created_at AS createdAt
    FROM orders o WHERE o.customer_id = ? ORDER BY o.id DESC
  `).all(req.user.id);
  const getItems = db.prepare(`
    SELECT p.name, oi.qty, oi.unit_price AS unitPrice
    FROM order_items oi JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `);
  const result = orders.map(o => ({ ...o, orderNo: 'ORD-' + String(o.orderId).padStart(5, '0'), items: getItems.all(o.orderId) }));
  res.json(result);
});

// ---------- GET /api/orders (merchant only) ----------
// Output: [ { "orderId":7, "customerName":"Jamie Customer", "total":50.0, "createdAt":"2026-07-26 20:10:00",
//             "items":[{ "name":"Ceramic mug","qty":2,"unitPrice":18 }] }, ... ]
app.get('/api/orders', authenticate('merchant'), (req, res) => {
  const orders = db.prepare(`
    SELECT o.id AS orderId, u.name AS customerName, o.total, o.status, o.created_at AS createdAt
    FROM orders o JOIN users u ON u.id = o.customer_id
    ORDER BY o.id DESC
  `).all();
  const getItems = db.prepare(`
    SELECT p.name, oi.qty, oi.unit_price AS unitPrice
    FROM order_items oi JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `);
  const result = orders.map(o => ({ ...o, orderNo: 'ORD-' + String(o.orderId).padStart(5, '0'), items: getItems.all(o.orderId) }));
  res.json(result);
});

// ---------- PUT /api/orders/:id/status (merchant only) — advance an order's fulfillment status ----------
// Input:  { "status": "shipped" }   — allowed values: pending, shipped, completed
// Output: 200 { "orderId":7, "orderNo":"ORD-00007", "status":"shipped" }
const ORDER_STATUS_FLOW = ['pending', 'shipped', 'completed'];
app.put('/api/orders/:id/status', authenticate('merchant'), (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;
  if (!ORDER_STATUS_FLOW.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ORDER_STATUS_FLOW.join(', ')}` });
  }
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  res.json({ orderId: id, orderNo: 'ORD-' + String(id).padStart(5, '0'), status });
});

// ---------- GET /api/inventory-risk (merchant only) ----------
// Output: [ { "id":2, "name":"Woven tote bag", "stock":4, "avgDailySales":4, "daysLeft":1, "status":"reorder" }, ... ]
app.get('/api/inventory-risk', authenticate('merchant'), (req, res) => {
  const rows = db.prepare('SELECT id, name, category, price, stock, avg_daily_sales AS avgDailySales, image_url AS imageUrl FROM products').all();
  const withRisk = rows
    .map(p => ({ ...p, daysLeft: Math.round(p.stock / p.avgDailySales), status: (p.stock / p.avgDailySales) <= 3 ? 'reorder' : 'healthy' }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
  res.json(withRisk);
});

// ---------- GET /api/kpis (merchant only) ----------
// Output: { "totalOrders":12, "totalRevenue":842.50, "avgOrderValue":70.21, "lowStockCount":2 }
app.get('/api/kpis', authenticate('merchant'), (req, res) => {
  const { totalOrders, totalRevenue } = db.prepare('SELECT COUNT(*) AS totalOrders, COALESCE(SUM(total),0) AS totalRevenue FROM orders').get();
  const { lowStockCount } = db.prepare('SELECT COUNT(*) AS lowStockCount FROM products WHERE stock < 10').get();
  res.json({
    totalOrders,
    totalRevenue,
    avgOrderValue: totalOrders ? +(totalRevenue / totalOrders).toFixed(2) : 0,
    lowStockCount
  });
});

// ---------- GET /api/revenue-summary (merchant only) ----------
// Output: { "daily":[{"date":"2026-07-26","revenue":64.0,"orders":1}, ...],
//           "weekly":[{"weekStart":"2026-07-20","revenue":64.0,"orders":1}, ...],
//           "monthly":[{"month":"2026-07","revenue":64.0,"orders":1}, ...] }
app.get('/api/revenue-summary', authenticate('merchant'), (req, res) => {
  const daily = db.prepare(`
    SELECT date(created_at) AS date, ROUND(SUM(total),2) AS revenue, COUNT(*) AS orders
    FROM orders GROUP BY date(created_at) ORDER BY date DESC LIMIT 14
  `).all();
  const weekly = db.prepare(`
    SELECT date(created_at, 'weekday 0', '-6 days') AS weekStart, ROUND(SUM(total),2) AS revenue, COUNT(*) AS orders
    FROM orders GROUP BY weekStart ORDER BY weekStart DESC LIMIT 8
  `).all();
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, ROUND(SUM(total),2) AS revenue, COUNT(*) AS orders
    FROM orders GROUP BY month ORDER BY month DESC LIMIT 12
  `).all();
  res.json({ daily, weekly, monthly });
});

// ---------- GET /api/insights (merchant only) — rule-based "smart advisor" ----------
// This is NOT a call to an external AI API. It's a deterministic rules engine that reads
// the same inventory-risk and revenue data already computed above. It tries a real AI
// call first (Anthropic API) if ANTHROPIC_API_KEY is set in the environment; if the key
// is missing, the call times out, or the API errors, it falls back automatically to a
// deterministic rules engine — so this feature can never break a live demo.
// Output: { "insights": [ { "type":"reorder", "message":"..." } ], "source": "ai" | "rules" }

function gatherInsightData() {
  const products = db.prepare('SELECT id, name, stock, avg_daily_sales AS avgDailySales FROM products').all();
  const daily = db.prepare(`SELECT date(created_at) AS date, SUM(total) AS revenue FROM orders GROUP BY date ORDER BY date DESC LIMIT 7`).all();
  return { products, daily };
}

function ruleBasedInsights({ products, daily }) {
  const insights = [];

  const atRisk = products
    .map(p => ({ ...p, daysLeft: p.stock / p.avgDailySales }))
    .filter(p => p.daysLeft <= 3)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  atRisk.forEach(p => {
    insights.push({ type: 'reorder', message: `"${p.name}" has about ${Math.round(p.daysLeft)} day(s) of stock left at current sales pace — consider reordering now.` });
  });

  products.filter(p => p.avgDailySales <= 1 && p.stock > 20).forEach(p => {
    insights.push({ type: 'slow-mover', message: `"${p.name}" is selling slowly (${p.avgDailySales}/day) with ${p.stock} units still on hand — consider a promotion to free up cash tied in inventory.` });
  });

  if (daily.length >= 2) {
    const [latest, prior] = [daily[0].revenue, daily[1].revenue];
    if (latest > prior) insights.push({ type: 'revenue', message: `Revenue is trending up — today's total (${latest.toFixed(2)}) beat the previous day (${prior.toFixed(2)}).` });
    else if (latest < prior) insights.push({ type: 'revenue', message: `Revenue dipped versus the previous day (${prior.toFixed(2)} → ${latest.toFixed(2)}) — worth checking if a top seller ran low on stock.` });
  }

  if (insights.length === 0) insights.push({ type: 'ok', message: 'No urgent issues detected — inventory and sales pace both look healthy right now.' });
  return insights;
}

// Calls a real LLM (Anthropic Claude) with the same data, asking it to return structured JSON.
// 8-second timeout via AbortController — if the model is slow, we don't hang the demo.
async function aiInsights({ products, daily }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const prompt = `You are a small-business retail advisor. Given this product and revenue data, return 2-4 short, specific, actionable recommendations as a JSON array of objects: [{"type":"reorder"|"slow-mover"|"revenue"|"ok","message":"..."}]. Only return the JSON array, nothing else.

Products (name, stock, avg daily sales): ${JSON.stringify(products.map(p => ({ name: p.name, stock: p.stock, avgDailySales: p.avgDailySales })))}
Last 7 days revenue by date: ${JSON.stringify(daily)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error('AI API returned ' + response.status);
    const data = await response.json();
    const text = data.content.map(b => b.text || '').join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!Array.isArray(parsed)) throw new Error('AI response was not a JSON array');
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/insights', authenticate('merchant'), async (req, res) => {
  const data = gatherInsightData();
  try {
    const insights = await aiInsights(data);
    return res.json({ insights, source: 'ai' });
  } catch (err) {
    // Any failure — missing key, timeout, network error, bad response — falls back silently
    // to the deterministic rules engine so the feature always returns something useful.
    const insights = ruleBasedInsights(data);
    return res.json({ insights, source: 'rules', fallbackReason: err.message });
  }
});

// ---------- POST /api/chat (any logged-in user) — basic AI assistant, business-focused for merchants ----------
// This is a first version: single-turn context (recent message history sent by the client),
// no server-side conversation storage. Same fallback pattern as /api/insights — tries a real
// AI call, falls back to a canned rules-based reply if the API key is missing or the call fails.
// Merchants get business/data context injected; customers get product-catalog context.
// Input:  { "message": "Which products need attention?", "history": [{"role":"user"|"assistant","content":"..."}] }
// Output: { "reply": "...", "source": "ai" | "rules" }
function ruleBasedChatReply(message, role, context) {
  const lower = (message || '').toLowerCase();
  if (role === 'merchant') {
    if (lower.includes('stock') || lower.includes('reorder') || lower.includes('inventory')) {
      const risky = context.products.filter(p => p.stock / p.avgDailySales <= 3);
      if (risky.length === 0) return "Stock levels look healthy right now — nothing needs reordering.";
      return `These need attention soon: ${risky.map(p => p.name).join(', ')}. Check the Smart Advisor panel for exact days-of-stock-left.`;
    }
    if (lower.includes('revenue') || lower.includes('sales') || lower.includes('sold')) {
      return "Check the Revenue summary panel for day/week/month breakdowns — I can't compute a custom range in this basic version yet.";
    }
    return "I can help with stock/reorder questions and revenue questions right now — try asking something like \"what needs restocking?\"";
  }
  return "I can help you find products or answer basic questions about what's in stock. Try asking about a category, like \"do you have anything in Accessories?\"";
}

app.post('/api/chat', authenticate(), async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const role = req.user.role;
  const context = role === 'merchant'
    ? gatherInsightData()
    : { products: db.prepare('SELECT name, category, price, stock FROM products').all() };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const systemContext = role === 'merchant'
        ? `You are a helpful assistant for a small business owner using the ShopEase platform. Current inventory and recent revenue data: ${JSON.stringify(context)}. Answer concisely, referencing specific products/numbers when relevant.`
        : `You are a helpful shopping assistant for the ShopEase storefront. Current product catalog: ${JSON.stringify(context.products)}. Answer concisely and only reference products that are actually in the catalog.`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 400, system: systemContext,
          messages: [...(Array.isArray(history) ? history.slice(-6) : []), { role: 'user', content: message }]
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error('AI API returned ' + response.status);
      const data = await response.json();
      const reply = data.content.map(b => b.text || '').join('');
      return res.json({ reply, source: 'ai' });
    } catch (err) {
      return res.json({ reply: ruleBasedChatReply(message, role, context), source: 'rules', fallbackReason: err.message });
    }
  }
  return res.json({ reply: ruleBasedChatReply(message, role, context), source: 'rules', fallbackReason: 'ANTHROPIC_API_KEY not set' });
});

// ---------- POST /api/products (merchant only) — add a new product ----------
// Accepts either application/json, or multipart/form-data if uploading a photo at creation
// time (field name "image" alongside the other fields as form fields).
// Input:  { "name":"Wool beanie", "category":"Accessories", "price":22, "stock":20, "avgDailySales":2, "icon":"🧢", "description":"..." }
// Output: 201 { "id":7, "name":"Wool beanie", ..., "imageUrl": "/uploads/..." or null }
app.post('/api/products', authenticate('merchant'), upload.single('image'), (req, res) => {
  const body = req.body;
  const name = body.name;
  const category = body.category;
  const price = Number(body.price);
  const stock = Number(body.stock);
  const avgDailySales = body.avgDailySales != null && body.avgDailySales !== '' ? Number(body.avgDailySales) : 1;
  const icon = body.icon || '🛍️';
  const description = body.description || null;

  if (!name || !category || Number.isNaN(price) || Number.isNaN(stock)) {
    return res.status(400).json({ error: 'name, category, price, and stock are required' });
  }
  const imageUrl = req.file ? '/uploads/' + req.file.filename : null;

  const insert = db.prepare('INSERT INTO products (name, category, price, stock, avg_daily_sales, icon, image_url, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const result = insert.run(name, category, price, stock, avgDailySales, icon, imageUrl, description);
  res.status(201).json({ id: result.lastInsertRowid, name, category, price, stock, avgDailySales, icon, imageUrl, description });
});

// ---------- PUT /api/products/:id (merchant only) — edit an existing product, including its photo ----------
// Accepts either application/json, or multipart/form-data if replacing the photo (field "image").
// Input:  { "name":"Wool beanie", "price":24, "stock":15, "description":"Updated details..." }
// Output: 200 { "id":7, "name":"Wool beanie", ..., "imageUrl": "..." }
app.put('/api/products/:id', authenticate('merchant'), upload.single('image'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  const body = req.body;
  const name = body.name ?? existing.name;
  const category = body.category ?? existing.category;
  const price = body.price != null && body.price !== '' ? Number(body.price) : existing.price;
  const stock = body.stock != null && body.stock !== '' ? Number(body.stock) : existing.stock;
  const avgDailySales = body.avgDailySales != null && body.avgDailySales !== '' ? Number(body.avgDailySales) : existing.avg_daily_sales;
  const icon = body.icon ?? existing.icon;
  const description = body.description ?? existing.description;
  const imageUrl = req.file ? '/uploads/' + req.file.filename : existing.image_url;

  db.prepare('UPDATE products SET name=?, category=?, price=?, stock=?, avg_daily_sales=?, icon=?, image_url=?, description=? WHERE id=?')
    .run(name, category, price, stock, avgDailySales, icon, imageUrl, description, id);

  res.json({ id, name, category, price, stock, avgDailySales, icon, imageUrl, description });
});

// ---------- POST /api/products/:id/image (merchant only) — upload/replace a product photo on its own ----------
// Kept as a standalone endpoint too, for editing just the photo without resubmitting other fields.
// Input: multipart/form-data, field name "image" (jpg/png/webp, max 5MB)
// Output: 200 { "id": 7, "imageUrl": "/uploads/1721234567890-beanie.jpg" }
app.post('/api/products/:id/image', authenticate('merchant'), upload.single('image'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  if (!req.file) return res.status(400).json({ error: 'No image file provided (field name must be "image")' });

  const imageUrl = '/uploads/' + req.file.filename;
  db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(imageUrl, id);
  res.json({ id, imageUrl });
});

const PORT = process.env.PORT || 3000;

// ---------- Messaging: customer <-> merchant direct messages ----------
// Single-merchant demo model: a customer always messages "the" merchant (the first merchant
// account found); a merchant addresses a specific customer by id. sender_id/recipient_id are
// still generic user references, so this extends to multiple merchants without a schema change.
function getPrimaryMerchant() {
  return db.prepare("SELECT id, name FROM users WHERE role = 'merchant' ORDER BY id LIMIT 1").get();
}

// ---------- POST /api/messages/send (any logged-in user) ----------
// Customer input:  { "content": "Is this in stock?" }                       (recipient resolved server-side)
// Merchant input:  { "content": "Yes, 3 left!", "customerId": 4 }
// Output: 201 { "id":5, "senderId":1, "recipientId":2, "content":"...", "createdAt":"..." }
app.post('/api/messages/send', authenticate(), (req, res) => {
  const { content, customerId } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content is required' });

  let recipientId;
  if (req.user.role === 'customer') {
    const merchant = getPrimaryMerchant();
    if (!merchant) return res.status(500).json({ error: 'No merchant account exists to receive messages' });
    recipientId = merchant.id;
  } else {
    if (!customerId) return res.status(400).json({ error: 'customerId is required when sending as a merchant' });
    const customer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    recipientId = customer.id;
  }

  const result = db.prepare('INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)').run(req.user.id, recipientId, content.trim());
  const created = db.prepare('SELECT id, sender_id AS senderId, recipient_id AS recipientId, content, created_at AS createdAt FROM messages WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(created);
});

// ---------- GET /api/messages/thread (customer only) — full thread with the merchant ----------
// Output: [ { "id":1, "senderId":1, "isMine":true, "content":"...", "createdAt":"..." }, ... ]
app.get('/api/messages/thread', authenticate('customer'), (req, res) => {
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json([]);
  const rows = db.prepare(`
    SELECT id, sender_id AS senderId, content, created_at AS createdAt
    FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY id ASC
  `).all(req.user.id, merchant.id, merchant.id, req.user.id);
  db.prepare("UPDATE messages SET read_at = datetime('now') WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL").run(req.user.id, merchant.id);
  res.json(rows.map(r => ({ ...r, isMine: r.senderId === req.user.id })));
});

// ---------- GET /api/messages/thread/:customerId (merchant only) — thread with a specific customer ----------
app.get('/api/messages/thread/:customerId', authenticate('merchant'), (req, res) => {
  const customerId = Number(req.params.customerId);
  const rows = db.prepare(`
    SELECT id, sender_id AS senderId, content, created_at AS createdAt
    FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY id ASC
  `).all(req.user.id, customerId, customerId, req.user.id);
  db.prepare("UPDATE messages SET read_at = datetime('now') WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL").run(req.user.id, customerId);
  res.json(rows.map(r => ({ ...r, isMine: r.senderId === req.user.id })));
});

// ---------- GET /api/messages/conversations (merchant only) — one row per customer who has messaged ----------
// Output: [ { "customerId":4, "customerName":"Jamie Customer", "lastMessage":"...", "lastAt":"...", "unreadCount":2 } ]
app.get('/api/messages/conversations', authenticate('merchant'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id AS customerId, u.name AS customerName
    FROM users u WHERE u.role = 'customer'
    AND u.id IN (
      SELECT sender_id FROM messages WHERE recipient_id = ?
      UNION
      SELECT recipient_id FROM messages WHERE sender_id = ?
    )
  `).all(req.user.id, req.user.id);

  const lastMsg = db.prepare(`
    SELECT content, created_at AS createdAt FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY id DESC LIMIT 1
  `);
  const unread = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL');

  const result = rows.map(r => {
    const last = lastMsg.get(r.customerId, req.user.id, req.user.id, r.customerId);
    const { c } = unread.get(r.customerId, req.user.id);
    return { ...r, lastMessage: last?.content || '', lastAt: last?.createdAt || '', unreadCount: c };
  }).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));

  res.json(result);
});

// ---------- GET /api/messages/unread-count (any logged-in user) ----------
// Output: { "count": 3 }
app.get('/api/messages/unread-count', authenticate(), (req, res) => {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE recipient_id = ? AND read_at IS NULL').get(req.user.id);
  res.json({ count });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`ShopEase backend running on http://localhost:${PORT}`));
}

module.exports = app;
