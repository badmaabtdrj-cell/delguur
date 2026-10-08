const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const SESSION_DAYS = 30;
// Бараны зургууд өгөгдлийн сантай нэг дискэнд хадгалагдана (Railway дээр /data/images)
const IMAGE_DIR = path.join(path.dirname(DB_PATH), "images");
fs.mkdirSync(IMAGE_DIR, { recursive: true });

// Дэлгүүрийн тохиргоо (Railway → Variables хэсэгт өөрчилнө)
const SHOP = {
  name: process.env.SHOP_NAME || "Дэлгүүр",
  phone: process.env.SHOP_PHONE || "",
  bankName: process.env.BANK_NAME || "",
  bankAccount: process.env.BANK_ACCOUNT || "",
  bankHolder: process.env.BANK_HOLDER || "",
  deliveryFee: parseInt(process.env.DELIVERY_FEE || "5000", 10),
  freeDeliveryFrom: parseInt(process.env.FREE_DELIVERY_FROM || "100000", 10),
};

const ORDER_STATUSES = {
  new: "Шинэ",
  paid: "Төлбөр төлөгдсөн",
  shipped: "Хүргэлтэнд гарсан",
  done: "Хүргэгдсэн",
  cancelled: "Цуцлагдсан",
};
const PAYMENT_METHODS = { bank: "Дансаар шилжүүлэх", cash: "Хүргэлтээр бэлнээр" };

// ---------- Өгөгдлийн сан ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    price INTEGER NOT NULL,          -- төгрөгөөр
    old_price INTEGER,               -- хямдралын өмнөх үнэ
    stock INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    emoji TEXT,
    color TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'new',
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    note TEXT,
    payment TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    delivery_fee INTEGER NOT NULL,
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,              -- захиалах үеийн нэр, үнийг хадгална
    price INTEGER NOT NULL,
    qty INTEGER NOT NULL
  );
`);

if (db.prepare("SELECT COUNT(*) n FROM products").get().n === 0) {
  const ins = db.prepare(`INSERT INTO products (name, description, category, price, old_price, stock, emoji, color)
    VALUES (@name, @description, @category, @price, @old_price, @stock, @emoji, @color)`);
  db.transaction(() => require("./seed.js").forEach((p) => ins.run({ old_price: null, ...p })))();
}

// ---------- Туслах функцууд ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
function checkPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const parts = [`sid=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

// Хэт олон хүсэлтийг IP-ээр хязгаарлана
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const rec = hits.get(req.ip) || { count: 0, reset: now + windowMs };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
    rec.count++;
    hits.set(req.ip, rec);
    if (rec.count > max) return res.status(429).json({ error: "Хэт олон оролдлого. Түр хүлээгээд дахин оролдоно уу." });
    next();
  };
}

const IMAGE_PATH_RE = /^\/images\/([a-f0-9]{32}\.(?:jpg|png|webp))$/;
function removeImageFile(image) {
  const m = IMAGE_PATH_RE.exec(image || "");
  if (m) fs.rm(path.join(IMAGE_DIR, m[1]), { force: true }, () => {});
}

function productFromBody(b) {
  const errors = [];
  const int = (v) => (v === "" || v == null ? null : Number(v));
  const name = String(b.name || "").trim();
  const category = String(b.category || "").trim();
  const price = int(b.price);
  const oldPrice = int(b.old_price);
  const stock = int(b.stock) ?? 0;
  const image = String(b.image || "").trim();

  if (!name || name.length > 150) errors.push("Барааны нэр оруулна уу.");
  if (!category || category.length > 50) errors.push("Ангилал оруулна уу.");
  if (!Number.isInteger(price) || price < 0 || price > 1e9) errors.push("Үнэ буруу байна.");
  if (oldPrice !== null && (!Number.isInteger(oldPrice) || oldPrice <= price)) errors.push("Хуучин үнэ одоогийн үнээс их байх ёстой.");
  if (!Number.isInteger(stock) || stock < 0 || stock > 1e6) errors.push("Үлдэгдэл буруу байна.");
  if (image && !IMAGE_PATH_RE.test(image) && !/^https:\/\/[^\s'"()<>\\]+$/.test(image)) errors.push("Зургийн холбоос буруу.");

  return {
    errors,
    product: {
      name, category, price, stock, old_price: oldPrice,
      description: String(b.description || "").trim().slice(0, 3000),
      image: image || null,
      emoji: String(b.emoji || "").trim().slice(0, 8) || "🛍️",
      color: /^#[0-9a-f]{6}$/i.test(b.color || "") ? b.color : "#e5e7eb",
      active: b.active === false || b.active === "0" ? 0 : 1,
    },
  };
}

function orderWithItems(o) {
  const items = db.prepare("SELECT product_id, name, price, qty FROM order_items WHERE order_id = ?").all(o.id);
  return { ...o, items, status_label: ORDER_STATUSES[o.status], payment_label: PAYMENT_METHODS[o.payment] };
}

// ---------- Апп ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "img-src 'self' https: data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.json({ limit: "50kb" }));

// Өөр сайтаас хүсэлт илгээхээс хамгаалах: өөрчлөлт хийх хүсэлт заавал JSON байна (зураг илгээхээс бусад)
app.use("/api", (req, res, next) => {
  if (req.path === "/images") return next();
  if (["POST", "PUT"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ error: "JSON хүсэлт шаардлагатай." });
  }
  next();
});

app.use((req, res, next) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) {
    const row = db.prepare(`SELECT u.id, u.username, u.is_admin, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    if (row && row.expires_at > Date.now()) req.user = { id: row.id, username: row.username, isAdmin: !!row.is_admin };
  }
  next();
});

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Эхлээд нэвтэрнэ үү." }));
const requireAdmin = (req, res, next) => (req.user?.isAdmin ? next() : res.status(403).json({ error: "Зөвхөн админ хийх боломжтой." }));
const authLimit = rateLimiter(20, 15 * 60e3);

// --- Тохиргоо ---
app.get("/api/config", (req, res) => res.json({ shop: SHOP, statuses: ORDER_STATUSES, payments: PAYMENT_METHODS }));

// --- Бүртгэл / нэвтрэлт ---
app.get("/api/me", (req, res) => res.json({ user: req.user || null }));

app.post("/api/register", authLimit, (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[\p{L}\p{N}_.-]{3,30}$/u.test(username)) return res.status(400).json({ error: "Нэр 3-30 тэмдэгт, үсэг/тоо/_ . - байна." });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Нууц үг дор хаяж 8 тэмдэгт байна." });
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return res.status(409).json({ error: "Энэ нэр бүртгэлтэй байна." });
  // Анхны бүртгүүлсэн хүн админ болно
  const isAdmin = db.prepare("SELECT COUNT(*) n FROM users").get().n === 0 ? 1 : 0;
  const { lastInsertRowid } = db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)")
    .run(username, hashPassword(password), isAdmin);
  createSession(req, res, lastInsertRowid);
  res.json({ user: { id: lastInsertRowid, username, isAdmin: !!isAdmin } });
});

app.post("/api/login", authLimit, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(String(req.body.username || "").trim());
  if (!u || !checkPassword(String(req.body.password || ""), u.password_hash)) {
    return res.status(401).json({ error: "Нэр эсвэл нууц үг буруу." });
  }
  createSession(req, res, u.id);
  res.json({ user: { id: u.id, username: u.username, isAdmin: !!u.is_admin } });
});

app.post("/api/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  setSessionCookie(req, res, "", 0);
  res.json({ ok: true });
});

// --- Бараа ---
app.get("/api/products", (req, res) => {
  const all = req.user?.isAdmin && req.query.all === "1";
  res.json(db.prepare(`SELECT * FROM products ${all ? "" : "WHERE active = 1"} ORDER BY id DESC`).all());
});

app.post("/api/products", requireAdmin, (req, res) => {
  const { errors, product } = productFromBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });
  const { lastInsertRowid } = db.prepare(`INSERT INTO products
    (name, description, category, price, old_price, stock, image, emoji, color, active)
    VALUES (@name, @description, @category, @price, @old_price, @stock, @image, @emoji, @color, @active)`).run(product);
  res.json(db.prepare("SELECT * FROM products WHERE id = ?").get(lastInsertRowid));
});

app.put("/api/products/:id", requireAdmin, (req, res) => {
  const old = db.prepare("SELECT image FROM products WHERE id = ?").get(req.params.id);
  if (!old) return res.status(404).json({ error: "Бараа олдсонгүй." });
  const { errors, product } = productFromBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });
  db.prepare(`UPDATE products SET name=@name, description=@description, category=@category, price=@price,
    old_price=@old_price, stock=@stock, image=@image, emoji=@emoji, color=@color, active=@active WHERE id=@id`)
    .run({ ...product, id: Number(req.params.id) });
  if (old.image !== product.image) removeImageFile(old.image);
  res.json(db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id));
});

// Захиалгын түүхэнд хэрэгтэй тул бүрмөсөн устгахгүй, зөвхөн нууна
app.delete("/api/products/:id", requireAdmin, (req, res) => {
  db.prepare("UPDATE products SET active = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Зураг (зөвхөн админ) ---
const IMAGE_TYPES = {
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
};
app.post("/api/images", requireAdmin, express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "JPG, PNG эсвэл WEBP зураг сонгоно уу." });
  // Файлын агуулгаар нь төрлийг шалгана
  const ext = Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k](req.body));
  if (!ext) return res.status(400).json({ error: "Зөвхөн JPG, PNG, WEBP зураг оруулна." });
  const name = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(IMAGE_DIR, name), req.body);
  res.json({ url: `/images/${name}` });
});

// --- Захиалга ---
const placeOrder = db.transaction((userId, items, info) => {
  let subtotal = 0;
  const lines = [];
  for (const { id, qty } of items) {
    const p = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(id);
    if (!p) throw new Error("Сагсанд байгаа зарим бараа зарагдахаа больсон байна.");
    if (p.stock < qty) throw new Error(`"${p.name}" барааны үлдэгдэл ${p.stock} ширхэг байна.`);
    subtotal += p.price * qty;
    lines.push({ p, qty });
  }
  // Үнийг үйлчлүүлэгчээс биш, өгөгдлийн сангаас тооцно
  const deliveryFee = subtotal >= SHOP.freeDeliveryFrom ? 0 : SHOP.deliveryFee;
  const { lastInsertRowid: orderId } = db.prepare(`INSERT INTO orders
    (user_id, name, phone, address, note, payment, subtotal, delivery_fee, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, info.name, info.phone, info.address, info.note, info.payment, subtotal, deliveryFee, subtotal + deliveryFee);
  for (const { p, qty } of lines) {
    db.prepare("INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)").run(orderId, p.id, p.name, p.price, qty);
    db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").run(qty, p.id);
  }
  return orderId;
});

const restoreStock = (orderId) => {
  for (const it of db.prepare("SELECT product_id, qty FROM order_items WHERE order_id = ?").all(orderId)) {
    db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(it.qty, it.product_id);
  }
};

app.post("/api/orders", requireUser, rateLimiter(30, 60 * 60e3), (req, res) => {
  const b = req.body;
  const merged = new Map();
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 50) : []) {
    const id = Number(it?.id), qty = Number(it?.qty);
    if (Number.isInteger(id) && Number.isInteger(qty) && qty > 0 && qty <= 99) merged.set(id, (merged.get(id) || 0) + qty);
  }
  const items = [...merged].map(([id, qty]) => ({ id, qty }));
  const info = {
    name: String(b.name || "").trim().slice(0, 100),
    phone: String(b.phone || "").replace(/\s/g, ""),
    address: String(b.address || "").trim().slice(0, 500),
    note: String(b.note || "").trim().slice(0, 500),
    payment: PAYMENT_METHODS[b.payment] ? b.payment : null,
  };
  if (!items.length) return res.status(400).json({ error: "Сагс хоосон байна." });
  if (!info.name) return res.status(400).json({ error: "Нэрээ оруулна уу." });
  if (!/^\+?\d{8,12}$/.test(info.phone)) return res.status(400).json({ error: "Утасны дугаар буруу байна." });
  if (info.address.length < 5) return res.status(400).json({ error: "Хүргэлтийн хаягаа дэлгэрэнгүй оруулна уу." });
  if (!info.payment) return res.status(400).json({ error: "Төлбөрийн хэлбэр сонгоно уу." });
  try {
    const id = placeOrder(req.user.id, items, info);
    res.json(orderWithItems(db.prepare("SELECT * FROM orders WHERE id = ?").get(id)));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.get("/api/orders", requireUser, (req, res) => {
  res.json(db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC").all(req.user.id).map(orderWithItems));
});

// Үйлчлүүлэгч зөвхөн "Шинэ" төлөвтэй захиалгаа цуцална
app.post("/api/orders/:id/cancel", requireUser, (req, res) => {
  const o = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!o) return res.status(404).json({ error: "Захиалга олдсонгүй." });
  if (o.status !== "new") return res.status(400).json({ error: "Энэ захиалгыг цуцлах боломжгүй. Дэлгүүртэй холбогдоно уу." });
  db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
    restoreStock(o.id);
  })();
  res.json({ ok: true });
});

// --- Админ: захиалга ---
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id
    ORDER BY o.id DESC LIMIT 500`).all();
  res.json(rows.map(orderWithItems));
});

app.put("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const status = req.body.status;
  if (!ORDER_STATUSES[status]) return res.status(400).json({ error: "Төлөв буруу." });
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!o) return res.status(404).json({ error: "Захиалга олдсонгүй." });
  if (o.status === "cancelled" && status !== "cancelled") {
    return res.status(400).json({ error: "Цуцлагдсан захиалгыг сэргээх боломжгүй. Шинээр захиалга үүсгэнэ үү." });
  }
  db.transaction(() => {
    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, o.id);
    if (status === "cancelled" && o.status !== "cancelled") restoreStock(o.id);
  })();
  res.json({ ok: true });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Олдсонгүй." }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(IMAGE_DIR, { maxAge: "30d", immutable: true }));

// Алдааны дэлгэрэнгүйг хэрэглэгчид харуулахгүй
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Буруу хүсэлт." });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Файл хэт том байна (5MB хүртэл)." });
  console.error(err);
  res.status(500).json({ error: "Серверийн алдаа гарлаа." });
});

setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()), 3600e3).unref();

app.listen(PORT, () => console.log(`${SHOP.name} ажиллаж байна: http://localhost:${PORT}`));
