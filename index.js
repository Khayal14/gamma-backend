require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'erp_secret_change_this';

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── DB Init ───────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Staff',
      dept TEXT,
      avatar TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT UNIQUE NOT NULL,
      category TEXT,
      qty INTEGER DEFAULT 0,
      min_qty INTEGER DEFAULT 0,
      price NUMERIC(10,2) DEFAULT 0,
      supplier TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sales_orders (
      id TEXT PRIMARY KEY,
      customer TEXT NOT NULL,
      date DATE DEFAULT CURRENT_DATE,
      items INTEGER DEFAULT 1,
      total NUMERIC(10,2) DEFAULT 0,
      status TEXT DEFAULT 'Pending',
      rep TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      client TEXT NOT NULL,
      date DATE DEFAULT CURRENT_DATE,
      due_date DATE,
      amount NUMERIC(10,2) DEFAULT 0,
      paid NUMERIC(10,2) DEFAULT 0,
      status TEXT DEFAULT 'Unpaid',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dept TEXT,
      role TEXT,
      salary NUMERIC(10,2) DEFAULT 0,
      status TEXT DEFAULT 'Active',
      leave_days INTEGER DEFAULT 14,
      joined DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Seed admin user if no users exist
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      `INSERT INTO users (name, email, password, role, dept, avatar) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['Admin User', 'admin@company.com', hash, 'Admin', 'Management', 'AU']
    );

    // Seed demo data
    await pool.query(`
      INSERT INTO inventory (name, sku, category, qty, min_qty, price, supplier) VALUES
        ('Laptop Pro 15"', 'LAP-001', 'Electronics', 42, 10, 1200, 'TechCorp'),
        ('Office Chair', 'CHR-002', 'Furniture', 8, 5, 320, 'FurniCo'),
        ('Wireless Mouse', 'MOU-003', 'Electronics', 0, 20, 45, 'TechCorp'),
        ('Standing Desk', 'DSK-004', 'Furniture', 15, 3, 650, 'FurniCo'),
        ('Monitor 27"', 'MON-005', 'Electronics', 23, 8, 420, 'ScreenPro')
      ON CONFLICT DO NOTHING;

      INSERT INTO sales_orders (id, customer, date, items, total, status, rep) VALUES
        ('SO-001', 'Acme Corp', '2026-02-15', 3, 4800, 'Delivered', 'Admin User'),
        ('SO-002', 'Global Tech', '2026-02-20', 1, 1200, 'Processing', 'Admin User'),
        ('SO-003', 'StartupXYZ', '2026-02-28', 5, 2250, 'Pending', 'Admin User')
      ON CONFLICT DO NOTHING;

      INSERT INTO invoices (id, client, date, due_date, amount, paid, status) VALUES
        ('INV-001', 'Acme Corp', '2026-02-16', '2026-03-16', 4800, 4800, 'Paid'),
        ('INV-002', 'Global Tech', '2026-02-21', '2026-03-21', 1200, 0, 'Unpaid'),
        ('INV-003', 'StartupXYZ', '2026-03-01', '2026-04-01', 2250, 1000, 'Partial')
      ON CONFLICT DO NOTHING;

      INSERT INTO employees (id, name, dept, role, salary, status, leave_days, joined) VALUES
        ('EMP-001', 'Admin User', 'Management', 'Admin', 8500, 'Active', 12, '2022-01-10')
      ON CONFLICT DO NOTHING;
    `);

    console.log('✅ Database seeded with demo data');
  }

  console.log('✅ Database initialized');
}

// ── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: rows[0].id, role: rows[0].role, name: rows[0].name, email: rows[0].email, avatar: rows[0].avatar, dept: rows[0].dept }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role, avatar: rows[0].avatar, dept: rows[0].dept } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', auth, (req, res) => res.json(req.user));

// ── Inventory ─────────────────────────────────────────────────────────────────
app.get('/api/inventory', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM inventory ORDER BY id');
  const items = rows.map(r => ({
    ...r, minQty: r.min_qty,
    status: r.qty === 0 ? 'Out of Stock' : r.qty <= r.min_qty ? 'Low Stock' : 'In Stock'
  }));
  res.json(items);
});

app.post('/api/inventory', auth, async (req, res) => {
  const { name, sku, category, qty, minQty, price, supplier } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO inventory (name,sku,category,qty,min_qty,price,supplier) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name, sku, category, qty || 0, minQty || 0, price || 0, supplier]
    );
    const r = rows[0];
    res.json({ ...r, minQty: r.min_qty, status: r.qty === 0 ? 'Out of Stock' : r.qty <= r.min_qty ? 'Low Stock' : 'In Stock' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Sales ─────────────────────────────────────────────────────────────────────
app.get('/api/sales', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sales_orders ORDER BY created_at DESC');
  res.json(rows.map(r => ({ ...r, date: r.date?.toISOString().split('T')[0] })));
});

app.post('/api/sales', auth, async (req, res) => {
  const { customer, items, total, status } = req.body;
  try {
    const countRes = await pool.query('SELECT COUNT(*) FROM sales_orders');
    const id = 'SO-' + String(parseInt(countRes.rows[0].count) + 1).padStart(3, '0');
    const { rows } = await pool.query(
      'INSERT INTO sales_orders (id,customer,items,total,status,rep) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [id, customer, items || 1, total || 0, status || 'Pending', req.user.name]
    );
    res.json({ ...rows[0], date: rows[0].date?.toISOString().split('T')[0] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Invoices ──────────────────────────────────────────────────────────────────
app.get('/api/invoices', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM invoices ORDER BY created_at DESC');
  res.json(rows.map(r => ({ ...r, date: r.date?.toISOString().split('T')[0], due: r.due_date?.toISOString().split('T')[0] })));
});

app.post('/api/invoices', auth, async (req, res) => {
  const { client, amount, due } = req.body;
  try {
    const countRes = await pool.query('SELECT COUNT(*) FROM invoices');
    const id = 'INV-' + String(parseInt(countRes.rows[0].count) + 1).padStart(3, '0');
    const { rows } = await pool.query(
      'INSERT INTO invoices (id,client,amount,paid,due_date,status) VALUES ($1,$2,$3,0,$4,$5) RETURNING *',
      [id, client, amount || 0, due || null, 'Unpaid']
    );
    res.json({ ...rows[0], date: rows[0].date?.toISOString().split('T')[0], due: rows[0].due_date?.toISOString().split('T')[0] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Employees ─────────────────────────────────────────────────────────────────
app.get('/api/employees', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM employees ORDER BY id');
  res.json(rows.map(r => ({ ...r, leave: r.leave_days, joined: r.joined?.toISOString().split('T')[0] })));
});

app.post('/api/employees', auth, async (req, res) => {
  const { name, dept, role, salary, joined } = req.body;
  try {
    const countRes = await pool.query('SELECT COUNT(*) FROM employees');
    const id = 'EMP-' + String(parseInt(countRes.rows[0].count) + 1).padStart(3, '0');
    const { rows } = await pool.query(
      'INSERT INTO employees (id,name,dept,role,salary,status,leave_days,joined) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [id, name, dept, role, salary || 0, 'Active', 14, joined || new Date()]
    );
    res.json({ ...rows[0], leave: rows[0].leave_days, joined: rows[0].joined?.toISOString().split('T')[0] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });
  const { rows } = await pool.query('SELECT id,name,email,role,dept,avatar,created_at FROM users ORDER BY id');
  res.json(rows);
});

app.post('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });
  const { name, email, password, role, dept } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const avatar = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    const { rows } = await pool.query(
      'INSERT INTO users (name,email,password,role,dept,avatar) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,dept,avatar',
      [name, email, hash, role || 'Staff', dept, avatar]
    );
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 ERP Backend running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
