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
  description TEXT
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
  FOREIGN KEY (customer_id) REFERENCES users(id)
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
  insertUser.run('merchant1', bcrypt.hashSync('demo123', 8), 'merchant', 'Alex Merchant', 'merchant1@example.com', 1);

  const insertProduct = db.prepare('INSERT INTO products (name, category, price, stock, avg_daily_sales, icon, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertProduct.run('Ceramic mug', 'Home', 18, 42, 3, '☕', 'A hand-glazed stoneware mug, microwave and dishwasher safe. Holds 12oz.');
  insertProduct.run('Woven tote bag', 'Accessories', 32, 6, 4, '👜', 'Sturdy cotton-canvas tote, hand-woven trim, fits a 13" laptop.');
  insertProduct.run('Scented candle', 'Home', 14, 55, 5, '🕯️', 'Soy wax candle, cedar and sage scent, roughly 40 hours burn time.');
  insertProduct.run('Leather wallet', 'Accessories', 45, 9, 2, '👛', 'Full-grain leather bifold wallet with 6 card slots, ages beautifully.');
  insertProduct.run('Hand-poured soap', 'Bath', 9, 4, 3, '🧼', 'Cold-process bar soap, oatmeal and honey, free of synthetic fragrance.');
  insertProduct.run('Knit scarf', 'Accessories', 28, 30, 2, '🧣', 'Chunky-knit wool-blend scarf, one size, machine washable on cold.');

  const insertReview = db.prepare('INSERT INTO reviews (product_id, customer_id, customer_name, rating, comment) VALUES (?, ?, ?, ?, ?)');
  insertReview.run(1, 1, 'Jamie Customer', 5, 'Great everyday mug, holds heat well.');
  insertReview.run(2, 1, 'Jamie Customer', 4, 'Sturdy and roomy, wish it had an inside pocket.');

  console.log('Database seeded with demo accounts, products, and sample reviews.');
}

module.exports = db;
