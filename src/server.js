import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, UPLOAD_DIR, DATA_DIR, setting, computeTax } from './db.js';
import {
  hashPassword, verifyPassword, signJwt, verifyJwt, refNo, otp, penaltyFor,
  PASSWORD_RULE, MOBILE_RULE, EMAIL_RULE, COMPLAINT_CATEGORIES, classifyComplaint, chatbotReply, ollamaHealth,
} from './lib.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_FILE = 5 * 1024 * 1024;
const ALLOWED_MIME = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
const LOCK_AFTER = 5, LOCK_MINUTES = 15;
// Prototype: no real SMS/e-mail gateway, so OTPs are echoed back to the UI. Set CCAS_DEMO_OTP=0 to hide.
const DEMO_OTP = process.env.CCAS_DEMO_OTP !== '0';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, '.jwt-secret');
  if (!fs.existsSync(f)) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, crypto.randomBytes(32).toString('hex')); }
  return fs.readFileSync(f, 'utf8');
}

export function createApp(db = openDb(), { secret = jwtSecret(), classify = classifyComplaint, chat = chatbotReply } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });

  // ---------- helpers ----------
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const audit = (userId, action, entity, entityId, detail) =>
    run('INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)', userId ?? null, action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null);
  const notify = (userId, title, body) => {
    // ponytail: e-mail/SMS gateways are simulated by logging; plug a provider in here.
    const u = one('SELECT email, mobile FROM users WHERE id = ?', userId);
    run('INSERT INTO notifications (user_id, title, body, channels) VALUES (?,?,?,?)', userId, title, body, 'in-app,email,sms');
    if (process.env.NODE_ENV !== 'test') console.log(`[notify] email:${u?.email} sms:${u?.mobile} | ${title} - ${body}`);
  };
  const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, mobile: u.mobile, address: u.address, role: u.role, department_id: u.department_id, department: u.department_id ? one('SELECT name FROM departments WHERE id = ?', u.department_id)?.name : null });
  const str = (v, name, { min = 1, max = 500 } = {}) => {
    const s = String(v ?? '').trim();
    if (s.length < min) throw bad(min > 1 ? `${name} must be at least ${min} characters.` : `${name} is required.`);
    if (s.length > max) throw bad(`${name} must be at most ${max} characters.`);
    return s;
  };

  const auth = (...roles) => (req, res, next) => {
    const p = verifyJwt((req.headers.authorization || '').replace(/^Bearer /, ''), secret);
    if (!p) return res.status(401).json({ error: 'Please log in again (session expired or missing).' });
    const u = one('SELECT * FROM users WHERE id = ? AND active = 1', p.sub);
    if (!u) return res.status(401).json({ error: 'Account not found or disabled.' });
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'You are not allowed to perform this action.' });
    req.user = u;
    next();
  };

  const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + ALLOWED_MIME[file.mimetype]),
  });
  const uploader = multer({
    storage, limits: { fileSize: MAX_FILE, files: 5 },
    fileFilter: (req, file, cb) => ALLOWED_MIME[file.mimetype]
      ? cb(null, true) : cb(bad(`"${file.originalname}" is not allowed. Only PDF, JPG and PNG files are accepted.`)),
  });
  const upload = (field, max = 5) => (req, res, next) => uploader.array(field, max)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(bad('File is larger than 5 MB. Please upload a smaller file.'));
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return next(bad(`You can upload at most ${max} file(s).`));
    next(err);
  });
  const saveDocs = (files = [], userId, ownerType, ownerId, label) => files.map(f =>
    run('INSERT INTO documents (user_id, owner_type, owner_id, label, original_name, stored_name, mime, size) VALUES (?,?,?,?,?,?,?,?)',
      userId, ownerType, ownerId, label ?? null, f.originalname, f.filename, f.mimetype, f.size).lastInsertRowid);
  const docsFor = (type, id) => q('SELECT id, label, original_name, mime, size, created_at FROM documents WHERE owner_type = ? AND owner_id = ?', type, id);

  // ---------- public ----------
  app.get('/api/health', async (req, res) => res.json({ ok: true, ai: await ollamaHealth() }));
  app.get('/api/services', (req, res) => res.json(q(`SELECT s.*, d.name AS department FROM services s JOIN departments d ON d.id = s.department_id WHERE s.active = 1 ORDER BY s.name`).map(s => ({ ...s, fields: JSON.parse(s.fields) }))));
  app.get('/api/departments', (req, res) => res.json(q('SELECT * FROM departments ORDER BY name')));
  app.get('/api/wards', (req, res) => res.json(q('SELECT * FROM wards ORDER BY id')));
  app.get('/api/announcements', (req, res) => res.json(q('SELECT * FROM announcements ORDER BY created_at DESC, id DESC')));
  app.get('/api/verify/:ref', (req, res) => {
    const a = one(`SELECT a.ref_no, a.status, a.updated_at, s.name AS service, u.name AS applicant FROM applications a
      JOIN services s ON s.id = a.service_id JOIN users u ON u.id = a.user_id WHERE a.ref_no = ?`, req.params.ref);
    if (!a || a.status !== 'Approved') return res.json({ valid: false });
    res.json({ valid: true, ref_no: a.ref_no, service: a.service, applicant: a.applicant, issued_on: a.updated_at });
  });

  // ---------- M1: user & access ----------
  app.post('/api/auth/register', (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 'Name', { max: 100 });
    const email = str(b.email, 'E-mail', { max: 150 }).toLowerCase();
    if (!EMAIL_RULE.test(email)) throw bad('Please enter a valid e-mail address.');
    const mobile = str(b.mobile, 'Mobile number', { max: 10 });
    if (!MOBILE_RULE.test(mobile)) throw bad('Please enter a valid 10-digit mobile number.');
    if (!PASSWORD_RULE.test(b.password || '')) throw bad('Password must be at least 8 characters and contain a letter and a number.');
    if (one('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'Account already registered with this e-mail.');
    const code = otp();
    const id = run('INSERT INTO users (name, email, mobile, address, password_hash, role, otp, otp_expires) VALUES (?,?,?,?,?,?,?,?)',
      name, email, mobile, String(b.address || '').slice(0, 300), hashPassword(b.password), 'citizen', code, Date.now() + 10 * 60000).lastInsertRowid;
    notify(id, 'Verify your CCAS account', `Your one-time password is ${code}. It expires in 10 minutes.`);
    audit(id, 'register', 'user', id);
    res.status(201).json({ message: 'Registered. Enter the OTP sent to your e-mail/mobile to activate your account.', ...(DEMO_OTP && { demo_otp: code }) });
  });

  app.post('/api/auth/verify-otp', (req, res) => {
    const u = one('SELECT * FROM users WHERE email = ?', String(req.body?.email || '').toLowerCase());
    if (!u || !u.otp || u.otp !== String(req.body?.otp || '').trim() || u.otp_expires < Date.now()) throw bad('Invalid or expired OTP.');
    run('UPDATE users SET verified = 1, otp = NULL, otp_expires = NULL WHERE id = ?', u.id);
    audit(u.id, 'verify_otp', 'user', u.id);
    res.json({ message: 'Account verified. You can log in now.' });
  });

  app.post('/api/auth/resend-otp', (req, res) => {
    const u = one('SELECT * FROM users WHERE email = ?', String(req.body?.email || '').toLowerCase());
    let code;
    if (u) {
      code = otp();
      run('UPDATE users SET otp = ?, otp_expires = ? WHERE id = ?', code, Date.now() + 10 * 60000, u.id);
      notify(u.id, 'Your CCAS OTP', `Your one-time password is ${code}.`);
    }
    res.json({ message: 'If the account exists, a new OTP has been sent.', ...(DEMO_OTP && code && { demo_otp: code }) });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const u = one('SELECT * FROM users WHERE email = ?', email);
    if (u?.locked_until && u.locked_until > Date.now()) {
      throw new HttpError(423, `Account temporarily locked after ${LOCK_AFTER} failed attempts. Try again in ${Math.ceil((u.locked_until - Date.now()) / 60000)} minute(s).`);
    }
    if (!u || !u.active || !verifyPassword(String(req.body?.password || ''), u.password_hash)) {
      if (u) {
        const n = u.failed_attempts + 1;
        const lock = n >= LOCK_AFTER ? Date.now() + LOCK_MINUTES * 60000 : null;
        run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', lock ? 0 : n, lock, u.id);
        audit(u.id, lock ? 'account_locked' : 'login_failed', 'user', u.id);
        if (lock) throw new HttpError(423, `Account temporarily locked after ${LOCK_AFTER} failed attempts. Try again in ${LOCK_MINUTES} minutes.`);
      }
      throw new HttpError(401, 'Invalid e-mail or password.');
    }
    if (!u.verified) return res.status(403).json({ error: 'Please verify your account with the OTP first.', needsVerification: true });
    run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', u.id);
    audit(u.id, 'login', 'user', u.id);
    res.json({ token: signJwt({ sub: u.id, role: u.role }, secret), user: publicUser(u) });
  });

  app.post('/api/auth/forgot', (req, res) => {
    const u = one('SELECT * FROM users WHERE email = ?', String(req.body?.email || '').toLowerCase());
    let code;
    if (u) {
      code = otp();
      run('UPDATE users SET otp = ?, otp_expires = ? WHERE id = ?', code, Date.now() + 10 * 60000, u.id);
      notify(u.id, 'Password reset OTP', `Use ${code} to reset your CCAS password. It expires in 10 minutes.`);
    }
    res.json({ message: 'If the account exists, a reset OTP has been sent.', ...(DEMO_OTP && code && { demo_otp: code }) });
  });

  app.post('/api/auth/reset', (req, res) => {
    const b = req.body || {};
    const u = one('SELECT * FROM users WHERE email = ?', String(b.email || '').toLowerCase());
    if (!u || !u.otp || u.otp !== String(b.otp || '').trim() || u.otp_expires < Date.now()) throw bad('Invalid or expired OTP.');
    if (!PASSWORD_RULE.test(b.password || '')) throw bad('Password must be at least 8 characters and contain a letter and a number.');
    run('UPDATE users SET password_hash = ?, otp = NULL, otp_expires = NULL, failed_attempts = 0, locked_until = NULL, verified = 1 WHERE id = ?', hashPassword(b.password), u.id);
    audit(u.id, 'password_reset', 'user', u.id);
    res.json({ message: 'Password updated. You can log in now.' });
  });

  app.get('/api/me', auth(), (req, res) => res.json(publicUser(req.user)));
  app.put('/api/me', auth(), (req, res) => {
    const b = req.body || {};
    const name = str(b.name ?? req.user.name, 'Name', { max: 100 });
    const mobile = String(b.mobile ?? req.user.mobile);
    if (!MOBILE_RULE.test(mobile)) throw bad('Please enter a valid 10-digit mobile number.');
    run('UPDATE users SET name = ?, mobile = ?, address = ? WHERE id = ?', name, mobile, String(b.address ?? req.user.address ?? '').slice(0, 300), req.user.id);
    audit(req.user.id, 'profile_update', 'user', req.user.id);
    res.json(publicUser(one('SELECT * FROM users WHERE id = ?', req.user.id)));
  });
  app.put('/api/me/password', auth(), (req, res) => {
    if (!verifyPassword(String(req.body?.current || ''), req.user.password_hash)) throw bad('Current password is incorrect.');
    if (!PASSWORD_RULE.test(req.body?.password || '')) throw bad('Password must be at least 8 characters and contain a letter and a number.');
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), req.user.id);
    audit(req.user.id, 'password_change', 'user', req.user.id);
    res.json({ message: 'Password changed.' });
  });

  app.get('/api/documents', auth(), (req, res) => res.json(q("SELECT id, label, original_name, mime, size, created_at FROM documents WHERE user_id = ? AND owner_type = 'profile' ORDER BY id DESC", req.user.id)));
  app.post('/api/documents', auth(), upload('file', 1), (req, res) => {
    if (!req.files?.length) throw bad('Please choose a file to upload.');
    const [id] = saveDocs(req.files, req.user.id, 'profile', req.user.id, String(req.body.label || 'Document').slice(0, 80));
    audit(req.user.id, 'document_upload', 'document', id);
    res.status(201).json({ id });
  });
  app.get('/api/files/:id', auth(), (req, res) => {
    const d = one('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
    if (!d) throw new HttpError(404, 'File not found.');
    if (req.user.role === 'citizen' && d.user_id !== req.user.id) {
      // a citizen may also see proof photos on their own complaint
      const own = d.owner_type === 'complaint_proof' && one('SELECT 1 FROM complaints WHERE id = ? AND user_id = ?', d.owner_id, req.user.id);
      if (!own) throw new HttpError(403, 'You are not allowed to view this file.');
    }
    res.type(d.mime).set('Content-Disposition', `inline; filename="${d.original_name.replace(/[^\w.\- ]/g, '_')}"`);
    res.sendFile(path.join(UPLOAD_DIR, d.stored_name));
  });

  // ---------- M2: certificates & licences ----------
  const appRow = `SELECT a.*, s.name AS service, s.code AS service_code, s.sla_days, s.department_id, d.name AS department,
      u.name AS applicant, u.email AS applicant_email, o.name AS officer
    FROM applications a JOIN services s ON s.id = a.service_id JOIN departments d ON d.id = s.department_id
    JOIN users u ON u.id = a.user_id LEFT JOIN users o ON o.id = a.officer_id`;
  const canSeeApp = (u, a) => u.role === 'admin' || (u.role === 'citizen' && a.user_id === u.id) || (u.role === 'officer' && a.department_id === u.department_id);
  const getApp = (u, id) => {
    const a = one(`${appRow} WHERE a.id = ?`, Number(id));
    if (!a || !canSeeApp(u, a)) throw new HttpError(404, 'Application not found.');
    return { ...a, details: JSON.parse(a.details) };
  };
  const validateDetails = (service, raw) => {
    let details;
    try { details = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { throw bad('Invalid application details.'); }
    const out = {};
    for (const f of JSON.parse(service.fields)) {
      const v = String(details[f.name] ?? '').trim();
      if (!v) throw bad(`${f.label} is required.`);
      if (f.type === 'number' && !(Number(v) > 0)) throw bad(`${f.label} must be a positive number.`);
      if (f.type === 'date' && Number.isNaN(Date.parse(v))) throw bad(`${f.label} must be a valid date.`);
      out[f.name] = v.slice(0, 300);
    }
    return out;
  };

  app.post('/api/applications', auth('citizen'), upload('documents'), (req, res) => {
    const s = one('SELECT * FROM services WHERE id = ? AND active = 1', Number(req.body.service_id));
    if (!s) throw bad('Please select a valid service.');
    const details = validateDetails(s, req.body.details);
    if (!req.files?.length) throw bad('Please upload at least one supporting document (PDF, JPG or PNG, max 5 MB).');
    const ref = refNo('APP');
    const id = tx(() => {
      const id = run('INSERT INTO applications (ref_no, user_id, service_id, details, fee, fee_paid) VALUES (?,?,?,?,?,?)',
        ref, req.user.id, s.id, JSON.stringify(details), s.fee, s.fee > 0 ? 0 : 1).lastInsertRowid;
      run('INSERT INTO application_history (application_id, user_id, status, remark) VALUES (?,?,?,?)', id, req.user.id, 'Submitted', 'Application submitted online');
      saveDocs(req.files, req.user.id, 'application', id);
      return id;
    });
    notify(req.user.id, 'Application submitted', `${s.name} application ${ref} received.${s.fee > 0 ? ` Please pay the fee of Rs ${s.fee}.` : ''}`);
    for (const o of q("SELECT id FROM users WHERE role = 'officer' AND department_id = ? AND active = 1", s.department_id)) notify(o.id, 'New application', `${s.name} ${ref} is waiting for verification.`);
    audit(req.user.id, 'application_submit', 'application', id, { ref });
    res.status(201).json({ id, ref_no: ref, status: 'Submitted', fee: s.fee });
  });

  app.get('/api/applications', auth('citizen', 'officer', 'admin'), (req, res) => {
    const u = req.user;
    const [where, arg] = { citizen: ['a.user_id = ?', u.id], officer: ['s.department_id = ?', u.department_id], admin: ['1 = ?', 1] }[u.role];
    res.json(q(`${appRow} WHERE ${where} ORDER BY a.id DESC`, arg).map(a => ({
      ...a, details: JSON.parse(a.details),
      overdue: !['Approved', 'Rejected'].includes(a.status) && (Date.now() - Date.parse(a.created_at.replace(' ', 'T') + 'Z')) / 86400000 > a.sla_days,
    })));
  });

  app.get('/api/applications/:id', auth('citizen', 'officer', 'admin'), (req, res) => {
    const a = getApp(req.user, req.params.id);
    res.json({
      ...a,
      history: q('SELECT h.*, u.name AS by_name, u.role AS by_role FROM application_history h LEFT JOIN users u ON u.id = h.user_id WHERE application_id = ? ORDER BY h.id', a.id),
      documents: docsFor('application', a.id),
      payments: q('SELECT * FROM payments WHERE application_id = ? ORDER BY id DESC', a.id),
    });
  });

  const ACTIONS = { verify: 'Under Verification', approve: 'Approved', reject: 'Rejected', return: 'Returned' };
  app.post('/api/applications/:id/action', auth('officer', 'admin'), (req, res) => {
    const a = getApp(req.user, req.params.id);
    const status = ACTIONS[req.body?.action];
    if (!status) throw bad('Unknown action.');
    const remarks = String(req.body?.remarks || '').trim().slice(0, 500);
    if (['Approved', 'Rejected'].includes(a.status)) throw bad(`Application is already ${a.status.toLowerCase()}.`);
    if (['reject', 'return'].includes(req.body.action) && !remarks) throw bad('Please give remarks explaining the decision.');
    if (req.body.action === 'approve' && !a.fee_paid) throw bad('Cannot approve: the service fee has not been paid yet.');
    tx(() => {
      run("UPDATE applications SET status = ?, remarks = ?, officer_id = ?, updated_at = datetime('now') WHERE id = ?", status, remarks || a.remarks, req.user.id, a.id);
      run('INSERT INTO application_history (application_id, user_id, status, remark) VALUES (?,?,?,?)', a.id, req.user.id, status, remarks || null);
    });
    notify(a.user_id, `Application ${status.toLowerCase()}`, `${a.service} ${a.ref_no}: ${status}.${remarks ? ` Remarks: ${remarks}` : ''}${status === 'Approved' ? ' Your certificate is ready to download.' : ''}`);
    audit(req.user.id, `application_${req.body.action}`, 'application', a.id, { remarks });
    res.json({ id: a.id, status });
  });

  app.post('/api/applications/:id/resubmit', auth('citizen'), upload('documents'), (req, res) => {
    const a = getApp(req.user, req.params.id);
    if (a.status !== 'Returned') throw bad('Only returned applications can be resubmitted.');
    const details = req.body.details ? validateDetails(one('SELECT * FROM services WHERE id = ?', a.service_id), req.body.details) : a.details;
    tx(() => {
      run("UPDATE applications SET status = 'Submitted', details = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(details), a.id);
      run('INSERT INTO application_history (application_id, user_id, status, remark) VALUES (?,?,?,?)', a.id, req.user.id, 'Submitted', 'Resubmitted with corrections');
      saveDocs(req.files, req.user.id, 'application', a.id);
    });
    audit(req.user.id, 'application_resubmit', 'application', a.id);
    res.json({ id: a.id, status: 'Submitted' });
  });

  app.get('/api/applications/:id/certificate', auth('citizen', 'officer', 'admin'), async (req, res) => {
    const a = getApp(req.user, req.params.id);
    if (a.status !== 'Approved') throw bad('Certificate is available only after approval.');
    const verifyUrl = `${req.protocol}://${req.get('host')}/#/verify/${a.ref_no}`;
    res.json({ ...a, verify_url: verifyUrl, qr: await QRCode.toDataURL(verifyUrl, { margin: 1, width: 180 }) });
  });

  // ---------- M3: property tax & payment ----------
  const billView = (b) => {
    const principal = b.tax_amount + b.water_charge;
    const penalty = b.status === 'Paid' ? 0 : penaltyFor(principal, b.due_date, { rate: setting(db, 'penalty_rate_monthly'), cap: setting(db, 'penalty_cap') });
    return { ...b, principal, penalty, total: Math.round((principal + penalty) * 100) / 100, overdue: b.status !== 'Paid' && penalty > 0 };
  };
  const isRevenueStaff = (u) => u.role === 'admin' || (u.role === 'officer' && !!one("SELECT 1 FROM departments WHERE id = ? AND code = 'REV'", u.department_id));

  app.get('/api/properties', auth(), (req, res) => {
    const all = isRevenueStaff(req.user);
    const props = q(`SELECT p.*, w.name AS ward, u.name AS owner FROM properties p LEFT JOIN wards w ON w.id = p.ward_id JOIN users u ON u.id = p.owner_id ${all ? '' : 'WHERE p.owner_id = ?'} ORDER BY p.id`, ...(all ? [] : [req.user.id]));
    res.json(props.map(p => ({ ...p, bills: q('SELECT * FROM tax_bills WHERE property_id = ? ORDER BY year DESC', p.id).map(billView) })));
  });

  app.post('/api/payments/initiate', auth('citizen'), (req, res) => {
    const b = req.body || {};
    let amount, penalty = 0, purpose, billId = null, appId = null;
    if (b.bill_id) {
      const bill = one('SELECT * FROM tax_bills WHERE id = ?', Number(b.bill_id));
      const prop = bill && one('SELECT * FROM properties WHERE id = ?', bill.property_id);
      if (!bill || prop.owner_id !== req.user.id) throw new HttpError(404, 'Bill not found.');
      if (bill.status === 'Paid') throw bad('This bill is already paid.');
      const v = billView(bill);
      amount = v.total; penalty = v.penalty; billId = bill.id; purpose = `Property tax ${bill.year} - ${prop.property_no}`;
    } else if (b.application_id) {
      const a = getApp(req.user, b.application_id);
      if (a.fee_paid) throw bad('The fee for this application is already paid.');
      amount = a.fee; appId = a.id; purpose = `${a.service} fee - ${a.ref_no}`;
    } else throw bad('Nothing to pay.');
    const txn = `TXN${Date.now()}${crypto.randomInt(1000, 9999)}`;
    run('INSERT INTO payments (user_id, bill_id, application_id, purpose, amount, penalty, txn_id) VALUES (?,?,?,?,?,?,?)', req.user.id, billId, appId, purpose, amount, penalty, txn);
    audit(req.user.id, 'payment_initiate', 'payment', null, { txn, amount });
    res.status(201).json({ txn_id: txn, amount, penalty, purpose });
  });

  // ponytail: sandbox gateway; a real gateway would call this from its webhook with a signed payload.
  app.post('/api/payments/:txn/confirm', auth('citizen'), (req, res) => {
    const p = one('SELECT * FROM payments WHERE txn_id = ? AND user_id = ?', req.params.txn, req.user.id);
    if (!p) throw new HttpError(404, 'Transaction not found.');
    if (p.status !== 'Pending') throw bad(`Transaction already ${p.status.toLowerCase()}.`);
    const method = ['UPI', 'Card', 'NetBanking'].includes(req.body?.method) ? req.body.method : 'UPI';
    if (req.body?.outcome !== 'success') {
      run("UPDATE payments SET status = 'Failed', method = ? WHERE id = ?", method, p.id);
      audit(req.user.id, 'payment_failed', 'payment', p.id);
      return res.json({ status: 'Failed', message: 'Payment failed at the gateway. No amount was charged; please retry.' });
    }
    // Bill/fee is marked paid only after confirmation, and never twice (risk plan: gateway downtime).
    const already = p.bill_id ? one("SELECT 1 FROM tax_bills WHERE id = ? AND status = 'Paid'", p.bill_id) : one('SELECT 1 FROM applications WHERE id = ? AND fee_paid = 1', p.application_id);
    if (already) {
      run("UPDATE payments SET status = 'Failed', method = ? WHERE id = ?", method, p.id);
      throw bad('This item has already been paid in another transaction. No amount was charged.');
    }
    const receipt = refNo('RCPT');
    tx(() => {
      run("UPDATE payments SET status = 'Success', method = ?, receipt_no = ?, paid_at = datetime('now') WHERE id = ?", method, receipt, p.id);
      if (p.bill_id) run("UPDATE tax_bills SET status = 'Paid' WHERE id = ?", p.bill_id);
      if (p.application_id) {
        run('UPDATE applications SET fee_paid = 1 WHERE id = ?', p.application_id);
        run('INSERT INTO application_history (application_id, user_id, status, remark) VALUES (?,?,?,?)', p.application_id, req.user.id, 'Fee Paid', `Receipt ${receipt}`);
      }
    });
    notify(req.user.id, 'Payment successful', `Rs ${p.amount} received for ${p.purpose}. Receipt ${receipt}.`);
    audit(req.user.id, 'payment_success', 'payment', p.id, { receipt });
    res.json({ status: 'Success', receipt_no: receipt, payment_id: p.id });
  });

  app.get('/api/payments', auth(), (req, res) => {
    const all = req.user.role === 'admin';
    res.json(q(`SELECT p.*, u.name AS payer FROM payments p JOIN users u ON u.id = p.user_id ${all ? '' : 'WHERE p.user_id = ?'} ORDER BY p.id DESC`, ...(all ? [] : [req.user.id])));
  });
  app.get('/api/payments/:id/receipt', auth(), (req, res) => {
    const p = one('SELECT p.*, u.name AS payer, u.email, u.mobile FROM payments p JOIN users u ON u.id = p.user_id WHERE p.id = ?', Number(req.params.id));
    if (!p || (req.user.role !== 'admin' && p.user_id !== req.user.id) || p.status !== 'Success') throw new HttpError(404, 'Receipt not found.');
    res.json(p);
  });

  // ---------- M4: complaints ----------
  const cRow = `SELECT c.*, d.name AS department, w.name AS ward, u.name AS citizen, f.name AS assignee
    FROM complaints c LEFT JOIN departments d ON d.id = c.department_id LEFT JOIN wards w ON w.id = c.ward_id
    JOIN users u ON u.id = c.user_id LEFT JOIN users f ON f.id = c.assigned_to`;
  const canSeeComplaint = (u, c) => u.role === 'admin' || (u.role === 'citizen' && c.user_id === u.id)
    || (u.role === 'officer' && c.department_id === u.department_id) || (u.role === 'field' && c.assigned_to === u.id);
  const getComplaint = (u, id) => {
    const c = one(`${cRow} WHERE c.id = ?`, Number(id));
    if (!c || !canSeeComplaint(u, c)) throw new HttpError(404, 'Complaint not found.');
    return c;
  };
  const deptIdFor = (cat) => one('SELECT id FROM departments WHERE code = ?', COMPLAINT_CATEGORIES[cat] || 'GEN').id;
  const deptName = (id) => one('SELECT name FROM departments WHERE id = ?', id).name;

  app.post('/api/complaints/classify', auth(), async (req, res) => {
    const text = str(req.body?.text, 'Description', { min: 10, max: 2000 });
    const r = await classify(text);
    res.json({ ...r, department: deptName(deptIdFor(r.category)) });
  });

  app.post('/api/complaints', auth('citizen'), upload('photo', 1), async (req, res) => {
    const b = req.body;
    const description = str(b.description, 'Description', { min: 10, max: 2000 });
    const location = str(b.location, 'Location', { max: 300 });
    if (req.files?.some(f => f.mimetype === 'application/pdf')) throw bad('Complaint photo must be a JPG or PNG image.');
    const ward = b.ward_id ? one('SELECT id FROM wards WHERE id = ?', Number(b.ward_id))?.id ?? null : null;
    const lat = b.latitude ? Number(b.latitude) : null, lng = b.longitude ? Number(b.longitude) : null;
    if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) throw bad('Invalid map coordinates.');
    const ai = await classify(`${description}\nLocation: ${location}`);
    const category = COMPLAINT_CATEGORIES[b.category] ? b.category : ai.category;
    const ref = refNo('CMP');
    const deptId = deptIdFor(category);
    const id = tx(() => {
      const id = run(`INSERT INTO complaints (ref_no, user_id, category, description, location, ward_id, latitude, longitude, department_id, priority, ai_category, ai_priority, ai_summary, ai_source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, req.user.id, category, description, location, ward, lat, lng, deptId, ai.priority, ai.category, ai.priority, ai.summary, ai.source).lastInsertRowid;
      run('INSERT INTO complaint_updates (complaint_id, user_id, status, remark) VALUES (?,?,?,?)', id, req.user.id, 'Open', `Complaint registered and routed to ${deptName(deptId)}`);
      saveDocs(req.files, req.user.id, 'complaint', id, 'Complaint photo');
      return id;
    });
    notify(req.user.id, 'Complaint registered', `Your complaint ${ref} has been registered and sent to ${deptName(deptId)}.`);
    for (const o of q("SELECT id FROM users WHERE role = 'officer' AND department_id = ? AND active = 1", deptId)) notify(o.id, 'New complaint', `${ref} (${ai.priority} priority): ${description.slice(0, 80)}`);
    audit(req.user.id, 'complaint_submit', 'complaint', id, { ref, category, ai_source: ai.source });
    res.status(201).json({ id, ref_no: ref, status: 'Open', category, department: deptName(deptId), priority: ai.priority, ai_source: ai.source });
  });

  app.get('/api/complaints', auth(), (req, res) => {
    const u = req.user;
    const [where, arg] = { citizen: ['c.user_id = ?', u.id], officer: ['c.department_id = ?', u.department_id], field: ['c.assigned_to = ?', u.id], admin: ['1 = ?', 1] }[u.role];
    res.json(q(`${cRow} WHERE ${where} ORDER BY CASE c.status WHEN 'Resolved' THEN 1 ELSE 0 END, CASE c.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, c.id DESC`, arg));
  });

  app.get('/api/complaints/:id', auth(), (req, res) => {
    const c = getComplaint(req.user, req.params.id);
    res.json({
      ...c,
      updates: q('SELECT cu.*, u.name AS by_name, u.role AS by_role FROM complaint_updates cu LEFT JOIN users u ON u.id = cu.user_id WHERE complaint_id = ? ORDER BY cu.id', c.id),
      photos: docsFor('complaint', c.id), proofs: docsFor('complaint_proof', c.id),
    });
  });

  app.post('/api/complaints/:id/assign', auth('officer', 'admin'), (req, res) => {
    const c = getComplaint(req.user, req.params.id);
    if (c.status === 'Resolved') throw bad('Complaint is already resolved.');
    const staff = one("SELECT * FROM users WHERE id = ? AND role = 'field' AND active = 1", Number(req.body?.field_staff_id));
    if (!staff) throw bad('Please select a field staff member.');
    const remark = String(req.body?.remark || '').slice(0, 500) || `Assigned to ${staff.name}`;
    tx(() => {
      run("UPDATE complaints SET assigned_to = ?, status = 'Assigned' WHERE id = ?", staff.id, c.id);
      run('INSERT INTO complaint_updates (complaint_id, user_id, status, remark) VALUES (?,?,?,?)', c.id, req.user.id, 'Assigned', remark);
    });
    notify(staff.id, 'Complaint assigned to you', `${c.ref_no} at ${c.location}: ${c.description.slice(0, 80)}`);
    notify(c.user_id, 'Complaint assigned', `Your complaint ${c.ref_no} has been assigned to field staff.`);
    audit(req.user.id, 'complaint_assign', 'complaint', c.id, { to: staff.id });
    res.json({ id: c.id, status: 'Assigned' });
  });

  app.post('/api/complaints/:id/reroute', auth('officer', 'admin'), (req, res) => {
    const c = getComplaint(req.user, req.params.id);
    const cat = req.body?.category;
    if (!COMPLAINT_CATEGORIES[cat]) throw bad('Invalid category.');
    if (c.status === 'Resolved') throw bad('Complaint is already resolved.');
    const deptId = deptIdFor(cat);
    tx(() => {
      run("UPDATE complaints SET category = ?, department_id = ?, assigned_to = NULL, status = 'Open' WHERE id = ?", cat, deptId, c.id);
      run('INSERT INTO complaint_updates (complaint_id, user_id, status, remark) VALUES (?,?,?,?)', c.id, req.user.id, 'Open', `Re-routed to ${deptName(deptId)}`);
    });
    for (const o of q("SELECT id FROM users WHERE role = 'officer' AND department_id = ? AND active = 1", deptId)) notify(o.id, 'Complaint re-routed to you', `${c.ref_no}: ${c.description.slice(0, 80)}`);
    audit(req.user.id, 'complaint_reroute', 'complaint', c.id, { from: c.category, to: cat });
    res.json({ id: c.id, category: cat });
  });

  app.post('/api/complaints/:id/update', auth('field', 'officer', 'admin'), upload('photo', 1), (req, res) => {
    const c = getComplaint(req.user, req.params.id);
    const status = req.body?.status;
    if (!['In Progress', 'Resolved'].includes(status)) throw bad('Status must be In Progress or Resolved.');
    if (c.status === 'Resolved') throw bad('Complaint is already resolved.');
    const remark = String(req.body?.remark || '').trim().slice(0, 500);
    if (status === 'Resolved' && !remark) throw bad('Please describe how the complaint was resolved.');
    if (status === 'Resolved' && req.user.role === 'field' && !req.files?.length) throw bad('Please upload a photo as proof of resolution.');
    if (req.files?.some(f => f.mimetype === 'application/pdf')) throw bad('Proof must be a JPG or PNG image.');
    tx(() => {
      if (status === 'Resolved') run("UPDATE complaints SET status = ?, resolution_note = ?, resolved_at = datetime('now') WHERE id = ?", status, remark, c.id);
      else run('UPDATE complaints SET status = ? WHERE id = ?', status, c.id);
      run('INSERT INTO complaint_updates (complaint_id, user_id, status, remark) VALUES (?,?,?,?)', c.id, req.user.id, status, remark || null);
      saveDocs(req.files, req.user.id, 'complaint_proof', c.id, 'Resolution proof');
    });
    notify(c.user_id, `Complaint ${status.toLowerCase()}`, `${c.ref_no}: ${status}.${remark ? ` ${remark}` : ''}`);
    audit(req.user.id, 'complaint_update', 'complaint', c.id, { status });
    res.json({ id: c.id, status });
  });

  app.get('/api/staff', auth('officer', 'admin'), (req, res) => {
    const dept = req.user.role === 'officer' ? req.user.department_id : (req.query.department_id ? Number(req.query.department_id) : null);
    res.json(q(`SELECT u.id, u.name, u.department_id, d.name AS department, (SELECT COUNT(*) FROM complaints c WHERE c.assigned_to = u.id AND c.status != 'Resolved') AS open_tasks
      FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.role = 'field' AND u.active = 1 ${dept ? 'AND u.department_id = ?' : ''} ORDER BY open_tasks, u.name`, ...(dept ? [dept] : [])));
  });

  // ---------- M5: notifications ----------
  app.get('/api/notifications', auth(), (req, res) => res.json(q('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id)));
  app.post('/api/notifications/read-all', auth(), (req, res) => { run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id); res.json({ ok: true }); });

  // ---------- M6: dashboards & reports ----------
  app.get('/api/dashboard', auth(), (req, res) => {
    const u = req.user;
    const out = { unread: one('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', u.id).n };
    if (u.role === 'citizen') {
      const dues = q("SELECT b.* FROM tax_bills b JOIN properties p ON p.id = b.property_id WHERE p.owner_id = ? AND b.status != 'Paid'", u.id).map(billView);
      Object.assign(out, {
        active_applications: one("SELECT COUNT(*) n FROM applications WHERE user_id = ? AND status NOT IN ('Approved','Rejected')", u.id).n,
        open_complaints: one("SELECT COUNT(*) n FROM complaints WHERE user_id = ? AND status != 'Resolved'", u.id).n,
        tax_due: Math.round(dues.reduce((s, b) => s + b.total, 0) * 100) / 100,
        unpaid_fees: one("SELECT COUNT(*) n FROM applications WHERE user_id = ? AND fee_paid = 0 AND status != 'Rejected'", u.id).n,
        recent: q(`SELECT * FROM (
            SELECT 'Application' AS type, a.id, a.ref_no AS ref, s.name AS title, a.status, a.updated_at AS at FROM applications a JOIN services s ON s.id = a.service_id WHERE a.user_id = ?
            UNION ALL SELECT 'Complaint', id, ref_no, category || ' - ' || substr(description, 1, 40), status, created_at FROM complaints WHERE user_id = ?
            UNION ALL SELECT 'Payment', id, COALESCE(receipt_no, txn_id), purpose, status, created_at FROM payments WHERE user_id = ?
          ) ORDER BY at DESC LIMIT 8`, u.id, u.id, u.id),
      });
    } else if (u.role === 'officer') {
      Object.assign(out, {
        pending_applications: one("SELECT COUNT(*) n FROM applications a JOIN services s ON s.id = a.service_id WHERE s.department_id = ? AND a.status IN ('Submitted','Under Verification')", u.department_id).n,
        open_complaints: one("SELECT COUNT(*) n FROM complaints WHERE department_id = ? AND status = 'Open'", u.department_id).n,
        in_progress: one("SELECT COUNT(*) n FROM complaints WHERE department_id = ? AND status IN ('Assigned','In Progress')", u.department_id).n,
        resolved: one("SELECT COUNT(*) n FROM complaints WHERE department_id = ? AND status = 'Resolved'", u.department_id).n,
      });
    } else if (u.role === 'field') {
      Object.assign(out, {
        assigned: one("SELECT COUNT(*) n FROM complaints WHERE assigned_to = ? AND status = 'Assigned'", u.id).n,
        in_progress: one("SELECT COUNT(*) n FROM complaints WHERE assigned_to = ? AND status = 'In Progress'", u.id).n,
        resolved: one("SELECT COUNT(*) n FROM complaints WHERE assigned_to = ? AND status = 'Resolved'", u.id).n,
      });
    } else Object.assign(out, adminStats());
    res.json(out);
  });

  function adminStats() {
    return {
      users: q('SELECT role, COUNT(*) n FROM users GROUP BY role'),
      applications_by_status: q('SELECT status, COUNT(*) n FROM applications GROUP BY status'),
      applications_by_service: q('SELECT s.name, COUNT(a.id) n FROM services s LEFT JOIN applications a ON a.service_id = s.id GROUP BY s.id ORDER BY n DESC'),
      complaints_by_status: q('SELECT status, COUNT(*) n FROM complaints GROUP BY status'),
      complaints_by_category: q('SELECT category, COUNT(*) n FROM complaints GROUP BY category ORDER BY n DESC'),
      complaints_by_ward: q("SELECT COALESCE(w.name, 'Unspecified') ward, COUNT(*) n FROM complaints c LEFT JOIN wards w ON w.id = c.ward_id GROUP BY ward ORDER BY n DESC"),
      avg_resolution_hours: one('SELECT ROUND(AVG((julianday(resolved_at) - julianday(created_at)) * 24), 3) h FROM complaints WHERE resolved_at IS NOT NULL').h,
      revenue: one("SELECT COALESCE(SUM(amount), 0) total, COUNT(*) n FROM payments WHERE status = 'Success'"),
      revenue_by_purpose: q("SELECT CASE WHEN bill_id IS NOT NULL THEN 'Property tax' ELSE 'Service fees' END AS kind, SUM(amount) total FROM payments WHERE status = 'Success' GROUP BY kind"),
      tax_outstanding: Math.round(q("SELECT * FROM tax_bills WHERE status != 'Paid'").map(billView).reduce((s, b) => s + b.total, 0) * 100) / 100,
      ai_routing: q('SELECT ai_source, COUNT(*) n, SUM(CASE WHEN ai_category = category THEN 1 ELSE 0 END) agreed FROM complaints GROUP BY ai_source'),
      overdue_applications: q(`SELECT a.created_at, s.sla_days FROM applications a JOIN services s ON s.id = a.service_id WHERE a.status NOT IN ('Approved','Rejected')`)
        .filter(a => (Date.now() - Date.parse(a.created_at.replace(' ', 'T') + 'Z')) / 86400000 > a.sla_days).length,
      department_load: q(`SELECT d.name, SUM(CASE WHEN c.status != 'Resolved' THEN 1 ELSE 0 END) open, SUM(CASE WHEN c.status = 'Resolved' THEN 1 ELSE 0 END) resolved
        FROM departments d LEFT JOIN complaints c ON c.department_id = d.id GROUP BY d.id HAVING COUNT(c.id) > 0 ORDER BY open DESC`),
    };
  }

  app.get('/api/admin/users', auth('admin'), (req, res) => res.json(q(`SELECT u.id, u.name, u.email, u.mobile, u.role, u.department_id, d.name AS department, u.verified, u.active,
    CASE WHEN u.locked_until > ? THEN 1 ELSE 0 END AS locked, u.created_at FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.role, u.name`, Date.now())));
  app.post('/api/admin/users', auth('admin'), (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 'Name', { max: 100 });
    const email = str(b.email, 'E-mail', { max: 150 }).toLowerCase();
    if (!EMAIL_RULE.test(email)) throw bad('Please enter a valid e-mail address.');
    if (!MOBILE_RULE.test(b.mobile || '')) throw bad('Please enter a valid 10-digit mobile number.');
    if (!['officer', 'field', 'admin', 'citizen'].includes(b.role)) throw bad('Invalid role.');
    if (['officer', 'field'].includes(b.role) && !one('SELECT 1 FROM departments WHERE id = ?', Number(b.department_id))) throw bad('Officers and field staff need a department.');
    if (!PASSWORD_RULE.test(b.password || '')) throw bad('Password must be at least 8 characters and contain a letter and a number.');
    if (one('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'Account already registered with this e-mail.');
    const id = run('INSERT INTO users (name, email, mobile, password_hash, role, department_id, verified) VALUES (?,?,?,?,?,?,1)',
      name, email, b.mobile, hashPassword(b.password), b.role, ['officer', 'field'].includes(b.role) ? Number(b.department_id) : null).lastInsertRowid;
    audit(req.user.id, 'user_create', 'user', id, { role: b.role });
    res.status(201).json({ id });
  });
  app.put('/api/admin/users/:id', auth('admin'), (req, res) => {
    const u = one('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!u) throw new HttpError(404, 'User not found.');
    const b = req.body || {};
    if (u.id === req.user.id && (b.active === false || (b.role && b.role !== 'admin'))) throw bad('You cannot disable or demote your own account.');
    const role = b.role ?? u.role;
    if (!['officer', 'field', 'admin', 'citizen'].includes(role)) throw bad('Invalid role.');
    run('UPDATE users SET role = ?, department_id = ?, active = ?, locked_until = ?, failed_attempts = ? WHERE id = ?',
      role, b.department_id !== undefined ? (b.department_id ? Number(b.department_id) : null) : u.department_id,
      b.active === undefined ? u.active : (b.active ? 1 : 0), b.unlock ? null : u.locked_until, b.unlock ? 0 : u.failed_attempts, u.id);
    audit(req.user.id, 'user_update', 'user', u.id, b);
    res.json({ ok: true });
  });

  app.get('/api/admin/services', auth('admin'), (req, res) => res.json(q('SELECT s.*, d.name AS department FROM services s JOIN departments d ON d.id = s.department_id ORDER BY s.name')));
  app.post('/api/admin/services', auth('admin'), (req, res) => {
    const b = req.body || {};
    const code = str(b.code, 'Code', { max: 10 }).toUpperCase();
    if (one('SELECT 1 FROM services WHERE code = ?', code)) throw new HttpError(409, 'A service with this code already exists.');
    if (!one('SELECT 1 FROM departments WHERE id = ?', Number(b.department_id))) throw bad('Please choose a department.');
    const fields = (Array.isArray(b.fields) ? b.fields : String(b.fields || '').split(',')).map(s => String(s.label ?? s).trim()).filter(Boolean)
      .map(label => ({ name: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label }));
    if (!fields.length) throw bad('Please list at least one form field.');
    const id = run('INSERT INTO services (code, name, description, department_id, fee, sla_days, fields) VALUES (?,?,?,?,?,?,?)',
      code, str(b.name, 'Name', { max: 100 }), String(b.description || '').slice(0, 300), Number(b.department_id), Math.max(0, Number(b.fee) || 0), Math.max(1, Number(b.sla_days) || 7), JSON.stringify(fields)).lastInsertRowid;
    audit(req.user.id, 'service_create', 'service', id);
    res.status(201).json({ id });
  });
  app.put('/api/admin/services/:id', auth('admin'), (req, res) => {
    const s = one('SELECT * FROM services WHERE id = ?', Number(req.params.id));
    if (!s) throw new HttpError(404, 'Service not found.');
    const b = req.body || {};
    run('UPDATE services SET fee = ?, sla_days = ?, active = ? WHERE id = ?', b.fee !== undefined ? Math.max(0, Number(b.fee) || 0) : s.fee,
      b.sla_days !== undefined ? Math.max(1, Number(b.sla_days) || 1) : s.sla_days, b.active === undefined ? s.active : (b.active ? 1 : 0), s.id);
    audit(req.user.id, 'service_update', 'service', s.id, b);
    res.json({ ok: true });
  });

  app.post('/api/admin/announcements', auth('admin'), (req, res) => {
    const title = str(req.body?.title, 'Title', { max: 150 }), body = str(req.body?.body, 'Message', { max: 1000 });
    const id = run('INSERT INTO announcements (title, body, deadline) VALUES (?,?,?)', title, body, req.body?.deadline || null).lastInsertRowid;
    for (const u of q("SELECT id FROM users WHERE role = 'citizen' AND active = 1")) notify(u.id, `Announcement: ${title}`, body);
    audit(req.user.id, 'announcement_create', 'announcement', id);
    res.status(201).json({ id });
  });
  app.delete('/api/admin/announcements/:id', auth('admin'), (req, res) => {
    run('DELETE FROM announcements WHERE id = ?', Number(req.params.id));
    audit(req.user.id, 'announcement_delete', 'announcement', Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/admin/properties', auth('admin'), (req, res) => {
    const b = req.body || {};
    const owner = one("SELECT id FROM users WHERE email = ? AND role = 'citizen'", String(b.owner_email || '').toLowerCase().trim());
    if (!owner) throw bad('Owner must be a registered citizen (by e-mail).');
    const area = Number(b.area_sqft), value = Number(b.annual_value);
    if (!(area > 0) || !(value > 0)) throw bad('Area and annual value must be positive numbers.');
    const no = str(b.property_no, 'Property number', { max: 30 }).toUpperCase();
    if (one('SELECT 1 FROM properties WHERE property_no = ?', no)) throw new HttpError(409, 'Property number already exists.');
    const id = run('INSERT INTO properties (property_no, owner_id, address, ward_id, usage, area_sqft, annual_value) VALUES (?,?,?,?,?,?,?)',
      no, owner.id, str(b.address, 'Address', { max: 300 }), Number(b.ward_id) || null, b.usage === 'Commercial' ? 'Commercial' : 'Residential', area, value).lastInsertRowid;
    audit(req.user.id, 'property_create', 'property', id);
    res.status(201).json({ id });
  });
  app.post('/api/admin/bills/generate', auth('admin'), (req, res) => {
    const year = str(req.body?.year, 'Financial year', { max: 9 });
    const due = req.body?.due_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due || '')) throw bad('Due date must be YYYY-MM-DD.');
    const created = tx(() => q('SELECT * FROM properties').filter(p => {
      const { tax, water } = computeTax(p, db);
      return run('INSERT OR IGNORE INTO tax_bills (property_id, year, tax_amount, water_charge, due_date) VALUES (?,?,?,?,?)', p.id, year, tax, water, due).changes > 0;
    }));
    for (const p of created) notify(p.owner_id, 'New property tax bill', `A ${year} tax bill for ${p.property_no} is due on ${due}.`);
    audit(req.user.id, 'bills_generate', 'tax_bill', null, { year, created: created.length });
    res.json({ created: created.length });
  });

  app.get('/api/admin/settings', auth('admin'), (req, res) => res.json(Object.fromEntries(q('SELECT * FROM settings').map(s => [s.key, s.value]))));
  app.put('/api/admin/settings', auth('admin'), (req, res) => {
    const entries = Object.entries(req.body || {});
    for (const [k, v] of entries) if (!one('SELECT 1 FROM settings WHERE key = ?', k) || !(Number(v) >= 0)) throw bad(`Invalid setting ${k}.`);
    for (const [k, v] of entries) run('UPDATE settings SET value = ? WHERE key = ?', String(Number(v)), k);
    audit(req.user.id, 'settings_update', 'settings', null, req.body);
    res.json({ ok: true });
  });

  app.get('/api/admin/audit', auth('admin'), (req, res) => res.json(q('SELECT a.*, u.name AS user_name, u.role FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300')));

  const REPORTS = {
    applications: `SELECT a.ref_no, s.name AS service, u.name AS applicant, a.status, a.fee, a.fee_paid, a.created_at, a.updated_at FROM applications a JOIN services s ON s.id = a.service_id JOIN users u ON u.id = a.user_id ORDER BY a.id`,
    complaints: `SELECT c.ref_no, c.category, c.priority, c.status, d.name AS department, c.location, c.ai_category, c.ai_source, c.created_at, c.resolved_at FROM complaints c LEFT JOIN departments d ON d.id = c.department_id ORDER BY c.id`,
    payments: `SELECT p.txn_id, p.receipt_no, u.name AS payer, p.purpose, p.amount, p.penalty, p.status, p.method, p.created_at, p.paid_at FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.id`,
  };
  app.get('/api/admin/reports/:type', auth('admin'), (req, res) => {
    const type = req.params.type.replace(/\.csv$/, '');
    if (!REPORTS[type]) throw new HttpError(404, 'Unknown report.');
    const rows = q(REPORTS[type]);
    // CSV-injection safe: prefix formula-looking cells, quote when needed.
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = rows.length ? [Object.keys(rows[0]).join(','), ...rows.map(r => Object.values(r).map(cell).join(','))].join('\n') : 'no data';
    audit(req.user.id, 'report_export', 'report', null, { type });
    res.type('text/csv').set('Content-Disposition', `attachment; filename="ccas-${type}.csv"`).send(csv);
  });

  // ---------- AI chatbot (SRS 6.4) ----------
  app.post('/api/chat', auth(), async (req, res) => {
    const msgs = (Array.isArray(req.body?.messages) ? req.body.messages : [])
      .filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 1000) })).slice(-8);
    if (!msgs.length || msgs.at(-1).role !== 'user') throw bad('Please type a question.');
    const services = q('SELECT s.name, s.fee, s.sla_days, d.name AS dept FROM services s JOIN departments d ON d.id = s.department_id WHERE s.active = 1')
      .map(s => `- ${s.name}: fee Rs ${s.fee}, processed in about ${s.sla_days} days by ${s.dept}`).join('\n');
    const mine = req.user.role === 'citizen'
      ? [...q('SELECT a.ref_no, s.name, a.status, a.fee_paid FROM applications a JOIN services s ON s.id = a.service_id WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 5', req.user.id).map(a => `- Application ${a.ref_no} (${a.name}): ${a.status}${a.fee_paid ? '' : ', fee unpaid'}`),
         ...q('SELECT ref_no, category, status FROM complaints WHERE user_id = ? ORDER BY id DESC LIMIT 5', req.user.id).map(c => `- Complaint ${c.ref_no} (${c.category}): ${c.status}`)].join('\n')
      : '';
    const ann = q('SELECT title, body, deadline FROM announcements ORDER BY id DESC LIMIT 5').map(a => `- ${a.title}: ${a.body}${a.deadline ? ` (deadline ${a.deadline})` : ''}`).join('\n');
    const pct = (k) => Math.round(setting(db, k) * 100);
    const context = `Services:\n${services}\nProperty tax: residential ${pct('tax_rate_residential')}% and commercial ${pct('tax_rate_commercial')}% of annual value, plus water charge Rs ${setting(db, 'water_charge_per_sqft')}/sq ft; late penalty ${pct('penalty_rate_monthly')}% per month (max ${pct('penalty_cap')}%).\nComplaint categories: roads, drainage, garbage, streetlight, water, other.\nAnnouncements:\n${ann}\n${mine ? `This citizen (${req.user.name}) records:\n${mine}` : ''}`;
    try {
      res.json({ reply: await chat(msgs, context) });
    } catch (e) {
      res.status(503).json({ error: 'The AI assistant is offline right now (local Ollama not reachable). Please try again later.', detail: e.message });
    }
  });

  // ---------- static + errors ----------
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (req.files) for (const f of req.files) fs.rm(f.path, { force: true }, () => {});
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, async () => {
    const ai = await ollamaHealth();
    console.log(`CCAS running at http://localhost:${port}`);
    console.log(`AI: Ollama ${ai.up ? 'up' : 'DOWN'} | model ${ai.model} ${ai.modelInstalled ? 'installed' : `NOT installed (run: ollama pull ${ai.model})`}`);
  });
}
