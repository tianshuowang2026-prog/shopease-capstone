// db.js — database connection, schema creation, and seed data.
// Uses Node's built-in node:sqlite module (Node 22+), so no native build
// toolchain is required to run this project — just `node server.js`.
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'shopease.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer','merchant')),
  name TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL,
  avg_daily_sales REAL NOT NULL DEFAULT 1,
  icon TEXT,
  image_url TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','shipped','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (customer_id) REFERENCES users(id),
  UNIQUE(product_id, customer_id)
);

-- Reusable table for both "verify your email" codes and "reset your password" codes.
-- purpose distinguishes the two flows; a code is only valid for its stated purpose.
CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Direct messaging between a customer and the merchant. In this single-merchant demo,
-- a customer's messages are always addressed to "the" merchant account; recipient_id
-- and sender_id are still generic user references so this would extend to multiple
-- merchants without a schema change.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sender_id) REFERENCES users(id),
  FOREIGN KEY (recipient_id) REFERENCES users(id)
);
`);

const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, role, name, email, email_verified) VALUES (?, ?, ?, ?, ?, ?)');
  insertUser.run('customer1', bcrypt.hashSync('demo123', 8), 'customer', 'Jamie Customer', 'customer1@example.com', 1);
  insertUser.run('customer2', bcrypt.hashSync('demo123', 8), 'customer', 'Priya Nandan', 'customer2@example.com', 1);
  insertUser.run('customer3', bcrypt.hashSync('demo123', 8), 'customer', 'Marcus Delgado', 'customer3@example.com', 1);
  insertUser.run('customer4', bcrypt.hashSync('demo123', 8), 'customer', 'Wei Lin', 'customer4@example.com', 1);
  insertUser.run('merchant1', bcrypt.hashSync('demo123', 8), 'merchant', 'Alex Merchant', 'merchant1@example.com', 1);

  // Products: 18 across 6 categories, each with a real generated product image (image_url),
  // not just an emoji fallback. avg_daily_sales and stock are deliberately varied so the
  // inventory-risk / insights features have real variety to reason over instead of a flat demo.
  // created_at can't be a raw SQL expression through a prepared-statement placeholder, so each
  // product is inserted first (with the table's default "now" timestamp), then backfilled via
  // an UPDATE using datetime(?, ?) — keeps this readable while still spreading products across
  // realistic past dates instead of every row sharing one identical creation timestamp.
  const insertProduct = db.prepare('INSERT INTO products (name, category, price, stock, avg_daily_sales, icon, image_url, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const rows = [
    ['Ceramic mug', 'Home', 18, 42, 3, '☕', '/uploads/seed-ceramic-mug.png', 'A hand-glazed stoneware mug, microwave and dishwasher safe. Holds 12oz.', 88],
    ['Woven tote bag', 'Accessories', 32, 6, 4, '👜', '/uploads/seed-woven-tote.png', 'Sturdy cotton-canvas tote, hand-woven trim, fits a 13" laptop.', 82],
    ['Scented candle', 'Home', 14, 55, 5, '🕯️', '/uploads/seed-scented-candle.png', 'Soy wax candle, cedar and sage scent, roughly 40 hours burn time.', 79],
    ['Leather wallet', 'Accessories', 45, 9, 2, '👛', '/uploads/seed-leather-wallet.png', 'Full-grain leather bifold wallet with 6 card slots, ages beautifully.', 75],
    ['Hand-poured soap', 'Bath', 9, 4, 3, '🧼', '/uploads/seed-hand-poured-soap.png', 'Cold-process bar soap, oatmeal and honey, free of synthetic fragrance.', 70],
    ['Knit scarf', 'Accessories', 28, 30, 2, '🧣', '/uploads/seed-knit-scarf.png', 'Chunky-knit wool-blend scarf, one size, machine washable on cold.', 66],
    ['Wool beanie', 'Accessories', 22, 26, 3, '🧢', '/uploads/seed-wool-beanie.png', 'Ribbed wool-blend beanie, one size stretch fit, lined for warmth.', 60],
    ['Linen notebook', 'Stationery', 16, 48, 2, '📓', '/uploads/seed-linen-notebook.png', 'A5 dot-grid notebook, linen cover, 160 pages of 100gsm paper.', 55],
    ['Rattan wall mirror', 'Home', 62, 5, 1, '🪞', '/uploads/seed-rattan-mirror.png', 'Round mirror in a hand-woven rattan frame, 18in diameter.', 50],
    ['Ceramic planter', 'Home', 24, 21, 2, '🪴', '/uploads/seed-ceramic-planter.png', 'Speckled stoneware planter with drainage hole and saucer, 6in.', 46],
    ['Brass drop earrings', 'Accessories', 19, 33, 3, '💫', '/uploads/seed-brass-earrings.png', 'Hand-hammered brass drop earrings, hypoallergenic ear wires.', 41],
    ['Beaded bracelet', 'Accessories', 15, 40, 3, '📿', '/uploads/seed-beaded-bracelet.png', 'Stretch bracelet with natural stone beads, one size fits most.', 37],
    ['Oak cutting board', 'Kitchen', 38, 0, 2, '🪵', '/uploads/seed-oak-cutting-board.png', 'Solid oak cutting board with juice groove and handle cutout.', 33],
    ['Linen tea towel set', 'Kitchen', 21, 37, 2, '🧺', '/uploads/seed-linen-tea-towel.png', 'Set of 2 stonewashed linen tea towels, generous 20x28in size.', 28],
    ['Ceramic sauce bottle', 'Kitchen', 17, 12, 5, '🍶', '/uploads/seed-ceramic-sauce-bottle.png', 'Glazed ceramic pour bottle for soy sauce or oil, 8oz capacity.', 24],
    ['Beeswax lip balm trio', 'Bath', 12, 60, 4, '💄', '/uploads/seed-beeswax-lip-balm.png', 'Set of 3 beeswax lip balms — mint, vanilla, and unscented.', 19],
    ['Insulated travel mug', 'Home', 26, 17, 6, '🥤', '/uploads/seed-travel-mug.png', 'Double-wall stainless travel mug, 16oz, leak-resistant lid.', 15],
    ['Lavender candle', 'Home', 15, 44, 3, '🕯️', '/uploads/seed-lavender-candle.png', 'Soy wax candle, French lavender and chamomile, 45 hour burn.', 10],
  ];
  const backfill = db.prepare('UPDATE products SET created_at = datetime(?, ?) WHERE id = ?');
  rows.forEach((r, i) => {
    const daysAgo = r.pop();
    const result = insertProduct.run(...r);
    backfill.run('now', `-${daysAgo} days`, result.lastInsertRowid);
  });

  // Reviews: deliberately mixed ratings, including a couple of high-sales products with
  // consistently low ratings ("Insulated travel mug" leaks, "Ceramic sauce bottle" drips) —
  // this is the real data behind the "quality risk" insight (see server.js ruleBasedInsights),
  // not a hypothetical the merchant dashboard just claims to detect.
  const insertReview = db.prepare('INSERT INTO reviews (product_id, customer_id, customer_name, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, datetime(?, ?))');
  const R = (productId, customerId, name, rating, comment, daysAgo) =>
    insertReview.run(productId, customerId, name, rating, comment, 'now', `-${daysAgo} days`);

  R(1, 1, 'Jamie Customer', 5, 'Great everyday mug, holds heat well.', 80);
  R(1, 2, 'Priya Nandan', 4, 'Nice weight, glaze is a little uneven but I like the handmade look.', 60);
  R(2, 1, 'Jamie Customer', 4, 'Sturdy and roomy, wish it had an inside pocket.', 75);
  R(2, 3, 'Marcus Delgado', 5, 'My laptop fits perfectly and the canvas feels durable.', 50);
  R(3, 2, 'Priya Nandan', 5, 'Scent is strong but not overwhelming, burns evenly.', 65);
  R(4, 3, 'Marcus Delgado', 5, 'Beautiful leather, already breaking in nicely after 2 weeks.', 55);
  R(6, 4, 'Wei Lin', 4, 'Soft and warm, colors are true to the photos.', 40);
  R(7, 1, 'Jamie Customer', 5, 'Perfect fit, doesn\'t itch like other wool beanies I\'ve tried.', 30);
  R(8, 2, 'Priya Nandan', 4, 'Paper quality is great for fountain pen ink, no bleed-through.', 25);
  R(10, 3, 'Marcus Delgado', 3, 'Nice color but arrived with a small chip on the rim.', 20);
  R(11, 4, 'Wei Lin', 5, 'Lightweight and comfortable for all-day wear.', 18);
  R(12, 1, 'Jamie Customer', 4, 'Good stretch, stones look more expensive than the price.', 15);
  // Quality-risk signal: travel mug sells fast (6/day) but rating is dragged down by leak complaints
  R(17, 1, 'Jamie Customer', 2, 'Lid leaked in my bag twice this week, not actually spill-proof.', 12);
  R(17, 2, 'Priya Nandan', 2, 'Good insulation but the seal doesn\'t hold when it\'s more than half full.', 9);
  R(17, 3, 'Marcus Delgado', 3, 'Keeps coffee hot, but I agree with other reviews about the lid leaking.', 5);
  // Quality-risk signal: sauce bottle sells well but drips / clogs
  R(15, 4, 'Wei Lin', 2, 'Pours unevenly and drips down the side every time.', 8);
  R(15, 1, 'Jamie Customer', 3, 'Looks great on the table but the spout clogs with soy sauce residue.', 3);

  // Orders + order_items: enough spread across dates for the revenue-summary chart (daily/
  // weekly/monthly) to show a real trend line instead of one flat data point, and enough
  // distinct customers for "my-orders" / merchant order views to look like a real store.
  const insertOrder = db.prepare('INSERT INTO orders (customer_id, total, status, created_at) VALUES (?, ?, ?, datetime(?, ?))');
  const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?, ?, ?, ?)');

  const seedOrders = [
    // [customerId, status, daysAgo, [[productId, qty, unitPrice], ...]]
    [1, 'completed', 55, [[1, 2, 18], [3, 1, 14]]],
    [2, 'completed', 50, [[2, 1, 32]]],
    [3, 'completed', 48, [[4, 1, 45], [12, 2, 15]]],
    [4, 'completed', 44, [[6, 1, 28], [7, 1, 22]]],
    [1, 'completed', 40, [[8, 3, 16]]],
    [2, 'completed', 35, [[17, 1, 26], [1, 1, 18]]],
    [3, 'completed', 30, [[9, 1, 62]]],
    [4, 'completed', 27, [[10, 2, 24]]],
    [1, 'completed', 22, [[11, 2, 19]]],
    [2, 'shipped', 18, [[15, 3, 17]]],
    [3, 'shipped', 14, [[17, 2, 26], [16, 1, 12]]],
    [4, 'completed', 11, [[13, 1, 38]]],
    [1, 'shipped', 8, [[14, 2, 21]]],
    [2, 'pending', 5, [[18, 2, 15], [3, 1, 14]]],
    [3, 'pending', 3, [[17, 1, 26]]],
    [4, 'pending', 1, [[1, 1, 18], [9, 1, 62]]],
  ];
  seedOrders.forEach(([customerId, status, daysAgo, items]) => {
    const total = items.reduce((sum, [, qty, price]) => sum + qty * price, 0);
    const order = insertOrder.run(customerId, total, status, 'now', `-${daysAgo} days`);
    items.forEach(([productId, qty, price]) => insertItem.run(order.lastInsertRowid, productId, qty, price));
  });

  console.log('Database seeded: 5 users, 18 products (with real images), 17 reviews, 16 orders.');
}

module.exports = db;
