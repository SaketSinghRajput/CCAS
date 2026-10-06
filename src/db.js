// Data layer on libSQL: a local SQLite file in development, Turso (hosted libSQL) in production.
// Same SQL either way; uploaded documents are stored as BLOBs so serverless hosts need no disk.
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './lib.js';

export const DATA_DIR = process.env.CCAS_DATA_DIR || path.resolve('data');

const toRows = (rs) => rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i] instanceof ArrayBuffer ? Buffer.from(r[i]) : r[i]])));
const norm = (a) => a.map(v => v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

// q = all rows, one = first row, run = write (returns changes + lastInsertRowid)
function api(exec) {
  return {
    q: async (sql, ...a) => toRows(await exec({ sql, args: norm(a) })),
    one: async (sql, ...a) => toRows(await exec({ sql, args: norm(a) }))[0],
    run: async (sql, ...a) => { const r = await exec({ sql, args: norm(a) }); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) }; },
  };
}

export function openDb(url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN) {
  if (!url) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    url = 'file:' + path.join(DATA_DIR, 'ccas.db').replace(/\\/g, '/');
  }
  const client = createClient({ url, authToken });
  let ready = null;
  const init = () => (ready ??= initDb(client).catch((e) => { ready = null; throw e; }));
  const db = api(async (stmt) => { await init(); return client.execute(stmt); });
  db.tx = async (fn) => {
    await init();
    const t = await client.transaction('write');
    try { const r = await fn(api((s) => t.execute(s))); await t.commit(); return r; }
    catch (e) { await t.rollback().catch(() => {}); throw e; }
    finally { t.close(); }
  };
  db.ready = init;
  db.close = () => client.close();
  return db;
}

async function initDb(client) {
  await client.batch(SCHEMA.split(';').map(s => s.trim()).filter(Boolean), 'write');
  const t = await client.transaction('write');
  try {
    const tx = api((s) => t.execute(s));
    if (!(await tx.one('SELECT 1 AS x FROM users LIMIT 1'))) await seed(tx);
    await t.commit();
  } catch (e) { await t.rollback().catch(() => {}); throw e; }
  finally { t.close(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wards (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, mobile TEXT,
  address TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('citizen','officer','field','admin')),
  department_id INTEGER REFERENCES departments(id),
  verified INTEGER NOT NULL DEFAULT 0, otp TEXT, otp_expires INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT,
  department_id INTEGER NOT NULL REFERENCES departments(id), fee REAL NOT NULL DEFAULT 0,
  sla_days INTEGER NOT NULL DEFAULT 7, fields TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY, ref_no TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL REFERENCES services(id), details TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'Submitted', fee REAL NOT NULL DEFAULT 0, fee_paid INTEGER NOT NULL DEFAULT 0,
  remarks TEXT, officer_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS application_history (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
  user_id INTEGER REFERENCES users(id), status TEXT NOT NULL, remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  owner_type TEXT NOT NULL, owner_id INTEGER, label TEXT, original_name TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS documents_owner ON documents (owner_type, owner_id);
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY, ref_no TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL, description TEXT NOT NULL, location TEXT NOT NULL, ward_id INTEGER REFERENCES wards(id),
  latitude REAL, longitude REAL,
  department_id INTEGER REFERENCES departments(id), assigned_to INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'Open', priority TEXT NOT NULL DEFAULT 'Medium',
  ai_category TEXT, ai_priority TEXT, ai_summary TEXT, ai_source TEXT,
  resolution_note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT);
CREATE TABLE IF NOT EXISTS complaint_updates (
  id INTEGER PRIMARY KEY, complaint_id INTEGER NOT NULL REFERENCES complaints(id),
  user_id INTEGER REFERENCES users(id), status TEXT NOT NULL, remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY, property_no TEXT UNIQUE NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id),
  address TEXT NOT NULL, ward_id INTEGER REFERENCES wards(id), usage TEXT NOT NULL DEFAULT 'Residential',
  area_sqft REAL NOT NULL, annual_value REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tax_bills (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id),
  year TEXT NOT NULL, tax_amount REAL NOT NULL, water_charge REAL NOT NULL, due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Unpaid', UNIQUE (property_id, year));
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  bill_id INTEGER REFERENCES tax_bills(id), application_id INTEGER REFERENCES applications(id),
  purpose TEXT NOT NULL, amount REAL NOT NULL, penalty REAL NOT NULL DEFAULT 0,
  txn_id TEXT UNIQUE NOT NULL, receipt_no TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'Pending',
  method TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL,
  body TEXT NOT NULL, channels TEXT NOT NULL DEFAULT 'in-app', read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, deadline TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
  entity TEXT, entity_id INTEGER, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const DEMO_PASSWORD = 'Demo@1234';
export const NUMERIC_SETTINGS = ['tax_rate_residential', 'tax_rate_commercial', 'water_charge_per_sqft', 'penalty_rate_monthly', 'penalty_cap'];

async function seed(db) {
  const depts = [
    ['REG', 'Birth & Death Registration'], ['LIC', 'Trade Licensing'], ['BLD', 'Building & Planning'],
    ['REV', 'Revenue (Property Tax)'], ['ROAD', 'Roads & Engineering'], ['DRN', 'Drainage & Sewerage'],
    ['SAN', 'Sanitation & Solid Waste'], ['ELEC', 'Street Lighting'], ['WTR', 'Water Supply'], ['GEN', 'Public Grievance Cell'],
  ];
  for (const d of depts) await db.run('INSERT INTO departments (code, name) VALUES (?, ?)', ...d);
  const dept = Object.fromEntries((await db.q('SELECT code, id FROM departments')).map(r => [r.code, r.id]));
  for (let i = 1; i <= 6; i++) await db.run('INSERT INTO wards (name) VALUES (?)', `Ward ${i}`);

  const settings = { tax_rate_residential: '0.10', tax_rate_commercial: '0.15', water_charge_per_sqft: '1.5', penalty_rate_monthly: '0.02', penalty_cap: '0.24' };
  for (const [k, v] of Object.entries(settings)) await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', k, v);

  const F = (...f) => JSON.stringify(f);
  const services = [
    ['BIRTH', 'Birth Certificate', 'Registration of birth and issue of a digital birth certificate.', 'REG', 50, 7,
      F({ name: 'child_name', label: 'Child name' }, { name: 'date_of_birth', label: 'Date of birth', type: 'date' }, { name: 'place_of_birth', label: 'Place of birth' }, { name: 'father_name', label: "Father's name" }, { name: 'mother_name', label: "Mother's name" })],
    ['DEATH', 'Death Certificate', 'Registration of death and issue of a digital death certificate.', 'REG', 50, 7,
      F({ name: 'deceased_name', label: 'Name of deceased' }, { name: 'date_of_death', label: 'Date of death', type: 'date' }, { name: 'place_of_death', label: 'Place of death' }, { name: 'informant_relation', label: 'Relation of applicant' })],
    ['RESID', 'Residence Certificate', 'Certificate of residence within the corporation limits.', 'REG', 30, 5,
      F({ name: 'resident_name', label: 'Resident name' }, { name: 'residing_since', label: 'Residing since', type: 'date' }, { name: 'purpose', label: 'Purpose' })],
    ['TRADE', 'Trade Licence', 'New trade licence for shops and commercial establishments.', 'LIC', 500, 15,
      F({ name: 'business_name', label: 'Business name' }, { name: 'business_type', label: 'Type of trade' }, { name: 'business_address', label: 'Business address' })],
    ['BPLAN', 'Building Plan Approval', 'Approval of building plans for new construction.', 'BLD', 2000, 30,
      F({ name: 'plot_address', label: 'Plot address' }, { name: 'plot_area', label: 'Plot area (sq ft)', type: 'number' }, { name: 'floors', label: 'Number of floors', type: 'number' })],
    ['GARB', 'Bulk Garbage Collection', 'Request a special pickup for bulk or event waste.', 'SAN', 200, 3,
      F({ name: 'pickup_address', label: 'Pickup address' }, { name: 'pickup_date', label: 'Preferred date', type: 'date' }, { name: 'waste_type', label: 'Type of waste' })],
    ['WCONN', 'New Water Connection', 'Apply for a new domestic water connection.', 'WTR', 1500, 15,
      F({ name: 'connection_address', label: 'Connection address' }, { name: 'connection_size', label: 'Pipe size (mm)', type: 'number' })],
  ];
  for (const [c, n, d, dep, fee, sla, f] of services)
    await db.run('INSERT INTO services (code, name, description, department_id, fee, sla_days, fields) VALUES (?,?,?,?,?,?,?)', c, n, d, dept[dep], fee, sla, f);

  const hash = hashPassword(DEMO_PASSWORD);
  const users = [
    ['Riya Sharma', 'citizen@ccas.gov', '9876500001', '12 Lake Road, Ward 2', 'citizen', null],
    ['Arjun Patel', 'citizen2@ccas.gov', '9876500002', '44 Station Street, Ward 4', 'citizen', null],
    ['Officer Meera Rao', 'officer@ccas.gov', '9876500010', 'Ward Office 1', 'officer', dept.REG],
    ['Officer Vikram Das', 'works.officer@ccas.gov', '9876500011', 'Ward Office 2', 'officer', dept.ROAD],
    ['Officer Sunita Nair', 'revenue.officer@ccas.gov', '9876500012', 'Head Office', 'officer', dept.REV],
    ['Field Staff Ramesh', 'field@ccas.gov', '9876500020', 'Depot 1', 'field', dept.ROAD],
    ['Field Staff Kavya', 'field2@ccas.gov', '9876500021', 'Depot 2', 'field', dept.SAN],
    ['Admin Anil Kumar', 'admin@ccas.gov', '9876500099', 'Head Office', 'admin', null],
  ];
  for (const [n, e, m, a, r, d] of users)
    await db.run('INSERT INTO users (name, email, mobile, address, password_hash, role, department_id, verified) VALUES (?,?,?,?,?,?,?,1)', n, e, m, a, hash, r, d);
  const uid = Object.fromEntries((await db.q('SELECT email, id FROM users')).map(r => [r.email, r.id]));

  const props = [
    ['PRP-W2-0012', uid['citizen@ccas.gov'], '12 Lake Road', 2, 'Residential', 1200, 96000],
    ['PRP-W2-0019', uid['citizen@ccas.gov'], 'Shop 3, Market Complex', 2, 'Commercial', 400, 72000],
    ['PRP-W4-0044', uid['citizen2@ccas.gov'], '44 Station Street', 4, 'Residential', 900, 60000],
  ];
  for (const p of props) await db.run('INSERT INTO properties (property_no, owner_id, address, ward_id, usage, area_sqft, annual_value) VALUES (?,?,?,?,?,?,?)', ...p);

  const year = new Date().getFullYear();
  const rates = await taxRates(db);
  for (const p of await db.q('SELECT * FROM properties')) {
    const { tax, water } = computeTax(p, rates);
    await db.run('INSERT INTO tax_bills (property_id, year, tax_amount, water_charge, due_date, status) VALUES (?,?,?,?,?,?)',
      p.id, `${year - 1}-${String(year).slice(2)}`, tax, water, `${year}-03-31`, p.property_no === 'PRP-W4-0044' ? 'Paid' : 'Unpaid');
    await db.run('INSERT INTO tax_bills (property_id, year, tax_amount, water_charge, due_date, status) VALUES (?,?,?,?,?,?)',
      p.id, `${year}-${String(year + 1).slice(2)}`, tax, water, `${year + 1}-03-31`, 'Unpaid');
  }

  await db.run('INSERT INTO announcements (title, body, deadline) VALUES (?,?,?)',
    'Property tax due date', 'Pay your current-year property tax before the due date to avoid a 2% monthly penalty.', `${year + 1}-03-31`);
  await db.run('INSERT INTO announcements (title, body, deadline) VALUES (?,?,?)',
    'Monsoon drain cleaning drive', 'Report blocked drains in your ward through the Complaints section.', null);
}

/** All numeric tax/penalty settings in one query. */
export async function taxRates(db) {
  const rows = await db.q(`SELECT key, value FROM settings WHERE key IN (${NUMERIC_SETTINGS.map(() => '?').join(',')})`, ...NUMERIC_SETTINGS);
  return Object.fromEntries(rows.map(r => [r.key, Number(r.value)]));
}

export function computeTax(property, rates) {
  const rate = property.usage === 'Commercial' ? rates.tax_rate_commercial : rates.tax_rate_residential;
  return {
    tax: Math.round(property.annual_value * rate * 100) / 100,
    water: Math.round(property.area_sqft * rates.water_charge_per_sqft * 100) / 100,
  };
}
