// Runs the case-study test cases (TC01-TC06) plus end-to-end flows against a fresh DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccas-test-'));
process.env.CCAS_DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.CCAS_AI_KEY = 'test-ai-key-0123456789';
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');
const { penaltyFor, keywordClassify, classifyComplaint, ollamaHealth, signJwt, verifyJwt } = await import('../src/lib.js');

const PW = 'Demo@1234';
let server, base, db;
const stubClassify = async (t) => ({ category: keywordClassify(t), priority: 'High', summary: 'stub', source: 'stub' });

before(async () => {
  db = openDb('file:' + path.join(dir, 'test.db').split(path.sep).join('/'));
  const app = createApp(db, { secret: 'test-secret', classify: stubClassify, chat: async () => 'Birth certificate fee is Rs 50.' });
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function api(method, url, { token, body, form } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: form || (body && JSON.stringify(body)) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const login = async (email, password = PW) => (await api('POST', '/api/auth/login', { body: { email, password } })).data.token;
const file = (name, type, size = 1000) => new File([Buffer.alloc(size, 1)], name, { type });

test('TC01 login with valid credentials returns role + token', async () => {
  const r = await api('POST', '/api/auth/login', { body: { email: 'citizen@ccas.gov', password: PW } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'citizen');
  assert.ok(r.data.token);
  assert.ok(!('password_hash' in r.data.user));
});

test('TC02 five wrong passwords lock the account', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await api('POST', '/api/auth/login', { body: { email: 'citizen2@ccas.gov', password: 'wrong' } })).status, 401);
  const fifth = await api('POST', '/api/auth/login', { body: { email: 'citizen2@ccas.gov', password: 'wrong' } });
  assert.equal(fifth.status, 423);
  assert.match(fifth.data.error, /locked/i);
  // even the right password is refused while locked
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'citizen2@ccas.gov', password: PW } })).status, 423);
  // admin unlocks
  const admin = await login('admin@ccas.gov');
  const u = (await api('GET', '/api/admin/users', { token: admin })).data.find(x => x.email === 'citizen2@ccas.gov');
  assert.equal(u.locked, 1);
  await api('PUT', `/api/admin/users/${u.id}`, { token: admin, body: { unlock: true } });
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'citizen2@ccas.gov', password: PW } })).status, 200);
});

test('TC03 registering an existing e-mail fails; new user needs OTP', async () => {
  const dup = await api('POST', '/api/auth/register', { body: { name: 'X', email: 'citizen@ccas.gov', mobile: '9876543210', password: 'abc12345' } });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /already registered/i);

  const reg = await api('POST', '/api/auth/register', { body: { name: 'New Citizen', email: 'new@example.com', mobile: '9876543210', password: 'abc12345' } });
  assert.equal(reg.status, 201);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'new@example.com', password: 'abc12345' } })).status, 403);
  assert.equal((await api('POST', '/api/auth/verify-otp', { body: { email: 'new@example.com', otp: '000000' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/verify-otp', { body: { email: 'new@example.com', otp: reg.data.demo_otp } })).status, 200);
  assert.ok(await login('new@example.com', 'abc12345'));
});

test('registration validation: weak password / bad mobile rejected', async () => {
  assert.equal((await api('POST', '/api/auth/register', { body: { name: 'A', email: 'a@b.co', mobile: '12345', password: 'abc12345' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/register', { body: { name: 'A', email: 'a@b.co', mobile: '9876543210', password: 'short' } })).status, 400);
});

test('password reset via OTP', async () => {
  const f = await api('POST', '/api/auth/forgot', { body: { email: 'new@example.com' } });
  assert.equal((await api('POST', '/api/auth/reset', { body: { email: 'new@example.com', otp: f.data.demo_otp, password: 'newpass99' } })).status, 200);
  assert.ok(await login('new@example.com', 'newpass99'));
});

let appId, appRef;
test('TC04 birth certificate application -> ID generated, status Submitted', async () => {
  const token = await login('citizen@ccas.gov');
  const svc = (await api('GET', '/api/services')).data.find(s => s.code === 'BIRTH');
  const form = new FormData();
  form.append('service_id', svc.id);
  form.append('details', JSON.stringify({ child_name: 'Aarav', date_of_birth: '2026-08-01', place_of_birth: 'City Hospital', father_name: 'Rohan', mother_name: 'Riya' }));
  form.append('documents', file('hospital-slip.pdf', 'application/pdf'));
  const r = await api('POST', '/api/applications', { token, form });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.ref_no, /^APP-\d{8}-[0-9A-F]{6}$/);
  assert.equal(r.data.status, 'Submitted');
  appId = r.data.id; appRef = r.data.ref_no;
});

test('TC04b missing mandatory field is rejected', async () => {
  const token = await login('citizen@ccas.gov');
  const svc = (await api('GET', '/api/services')).data.find(s => s.code === 'BIRTH');
  const form = new FormData();
  form.append('service_id', svc.id);
  form.append('details', JSON.stringify({ child_name: 'Aarav' }));
  form.append('documents', file('a.pdf', 'application/pdf'));
  const r = await api('POST', '/api/applications', { token, form });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /required/);
});

test('TC05 file >5 MB or disallowed type is rejected with a clear message', async () => {
  const token = await login('citizen@ccas.gov');
  const svc = (await api('GET', '/api/services')).data.find(s => s.code === 'RESID');
  const details = JSON.stringify({ resident_name: 'Riya', residing_since: '2010-01-01', purpose: 'Bank' });
  const big = new FormData();
  big.append('service_id', svc.id); big.append('details', details);
  big.append('documents', file('big.pdf', 'application/pdf', 5 * 1024 * 1024 + 1));
  const r1 = await api('POST', '/api/applications', { token, form: big });
  assert.equal(r1.status, 400);
  assert.match(r1.data.error, /5 MB/);
  const exe = new FormData();
  exe.append('service_id', svc.id); exe.append('details', details);
  exe.append('documents', file('virus.exe', 'application/x-msdownload'));
  const r2 = await api('POST', '/api/applications', { token, form: exe });
  assert.equal(r2.status, 400);
  assert.match(r2.data.error, /Only PDF, JPG and PNG/);
});

test('TC06 tax bill after due date includes the correct penalty', () => {
  // principal 10,000; due 31 Mar; paid 15 Jun -> 3 started months -> 6%
  assert.equal(penaltyFor(10000, '2026-03-31', { today: new Date('2026-06-15') }), 600);
  assert.equal(penaltyFor(10000, '2026-03-31', { today: new Date('2026-03-31T12:00:00') }), 0); // on due date: none
  assert.equal(penaltyFor(10000, '2026-03-31', { today: new Date('2026-04-01') }), 200);       // 1 day late: 1 month
  assert.equal(penaltyFor(10000, '2020-03-31', { today: new Date('2026-06-15') }), 2400);       // capped at 24%
});

test('TC06b API: overdue bill carries penalty and payment marks it paid only after confirmation', async () => {
  const token = await login('citizen@ccas.gov');
  const props = (await api('GET', '/api/properties', { token })).data;
  assert.equal(props.length, 2);
  const overdue = props.flatMap(p => p.bills).find(b => b.overdue);
  assert.ok(overdue, 'seed has an overdue bill');
  assert.ok(overdue.penalty > 0);
  assert.equal(overdue.total, Math.round((overdue.principal + overdue.penalty) * 100) / 100);

  const init = await api('POST', '/api/payments/initiate', { token, body: { bill_id: overdue.id } });
  assert.equal(init.data.amount, overdue.total);
  // gateway failure -> bill stays unpaid
  const fail = await api('POST', `/api/payments/${init.data.txn_id}/confirm`, { token, body: { outcome: 'failure' } });
  assert.equal(fail.data.status, 'Failed');
  assert.equal((await api('GET', '/api/properties', { token })).data.flatMap(p => p.bills).find(b => b.id === overdue.id).status, 'Unpaid');
  // retry succeeds
  const init2 = await api('POST', '/api/payments/initiate', { token, body: { bill_id: overdue.id } });
  const ok = await api('POST', `/api/payments/${init2.data.txn_id}/confirm`, { token, body: { outcome: 'success', method: 'UPI' } });
  assert.equal(ok.data.status, 'Success');
  assert.match(ok.data.receipt_no, /^RCPT-/);
  assert.equal((await api('GET', '/api/properties', { token })).data.flatMap(p => p.bills).find(b => b.id === overdue.id).status, 'Paid');
  assert.equal((await api('GET', `/api/payments/${ok.data.payment_id}/receipt`, { token })).status, 200);
  assert.equal((await api('POST', '/api/payments/initiate', { token, body: { bill_id: overdue.id } })).status, 400);
  // another citizen cannot see the receipt
  assert.equal((await api('GET', `/api/payments/${ok.data.payment_id}/receipt`, { token: await login('citizen2@ccas.gov') })).status, 404);
});

test('double payment guard: two pending txns for one bill, only the first confirm succeeds', async () => {
  const token = await login('citizen@ccas.gov');
  const bill = (await api('GET', '/api/properties', { token })).data.flatMap(p => p.bills).find(b => b.status === 'Unpaid');
  const a = (await api('POST', '/api/payments/initiate', { token, body: { bill_id: bill.id } })).data;
  const b = (await api('POST', '/api/payments/initiate', { token, body: { bill_id: bill.id } })).data;
  assert.equal((await api('POST', `/api/payments/${a.txn_id}/confirm`, { token, body: { outcome: 'success' } })).data.status, 'Success');
  const second = await api('POST', `/api/payments/${b.txn_id}/confirm`, { token, body: { outcome: 'success' } });
  assert.equal(second.status, 400);
  assert.match(second.data.error, /already been paid/);
});

test('certificate workflow: approve blocked until fee paid, then QR certificate + public verify', async () => {
  const citizen = await login('citizen@ccas.gov');
  const officer = await login('officer@ccas.gov');
  assert.equal((await api('GET', `/api/applications/${appId}/certificate`, { token: citizen })).status, 400);
  assert.equal((await api('POST', `/api/applications/${appId}/action`, { token: officer, body: { action: 'verify' } })).data.status, 'Under Verification');
  const early = await api('POST', `/api/applications/${appId}/action`, { token: officer, body: { action: 'approve' } });
  assert.equal(early.status, 400);
  assert.match(early.data.error, /fee/);
  const init = await api('POST', '/api/payments/initiate', { token: citizen, body: { application_id: appId } });
  assert.equal(init.data.amount, 50);
  await api('POST', `/api/payments/${init.data.txn_id}/confirm`, { token: citizen, body: { outcome: 'success' } });
  assert.equal((await api('POST', `/api/applications/${appId}/action`, { token: officer, body: { action: 'approve', remarks: 'Documents verified' } })).data.status, 'Approved');
  const cert = await api('GET', `/api/applications/${appId}/certificate`, { token: citizen });
  assert.equal(cert.status, 200);
  assert.match(cert.data.qr, /^data:image\/png;base64,/);
  assert.equal((await api('GET', `/api/verify/${appRef}`)).data.valid, true);
  assert.equal((await api('GET', '/api/verify/APP-FAKE')).data.valid, false);
  const notes = (await api('GET', '/api/notifications', { token: citizen })).data;
  assert.ok(notes.some(n => /approved/i.test(n.title)));
});

test('RBAC: citizen cannot act as officer; officer of other department cannot see application', async () => {
  const citizen = await login('citizen@ccas.gov');
  assert.equal((await api('POST', `/api/applications/${appId}/action`, { token: citizen, body: { action: 'approve' } })).status, 403);
  assert.equal((await api('GET', '/api/admin/users', { token: citizen })).status, 403);
  const works = await login('works.officer@ccas.gov');
  assert.equal((await api('GET', `/api/applications/${appId}`, { token: works })).status, 404);
  assert.equal((await api('GET', '/api/me')).status, 401);
  assert.equal((await api('GET', '/api/me', { token: 'forged.token.here' })).status, 401);
});

test('return with remarks requires remarks, then citizen resubmits', async () => {
  const citizen = await login('citizen@ccas.gov');
  const officer = await login('officer@ccas.gov');
  const svc = (await api('GET', '/api/services')).data.find(s => s.code === 'DEATH');
  const form = new FormData();
  form.append('service_id', svc.id);
  form.append('details', JSON.stringify({ deceased_name: 'X', date_of_death: '2026-01-01', place_of_death: 'Home', informant_relation: 'Son' }));
  form.append('documents', file('doc.png', 'image/png'));
  const { id } = (await api('POST', '/api/applications', { token: citizen, form })).data;
  assert.equal((await api('POST', `/api/applications/${id}/action`, { token: officer, body: { action: 'return' } })).status, 400);
  assert.equal((await api('POST', `/api/applications/${id}/action`, { token: officer, body: { action: 'return', remarks: 'Upload hospital letter' } })).data.status, 'Returned');
  const re = new FormData();
  re.append('documents', file('letter.pdf', 'application/pdf'));
  assert.equal((await api('POST', `/api/applications/${id}/resubmit`, { token: citizen, form: re })).data.status, 'Submitted');
  const detail = (await api('GET', `/api/applications/${id}`, { token: citizen })).data;
  assert.equal(detail.documents.length, 2);
  assert.deepEqual(detail.history.map(h => h.status), ['Submitted', 'Returned', 'Submitted']);
});

test('complaint lifecycle: submit -> AI route -> assign -> resolve with proof -> notify', async () => {
  const citizen = await login('citizen@ccas.gov');
  const form = new FormData();
  form.append('description', 'Huge pothole in the middle of the road near the school gate, two bikes fell yesterday');
  form.append('location', 'School Road, near Gate 2');
  form.append('ward_id', '2');
  form.append('photo', file('pothole.jpg', 'image/jpeg'));
  const r = await api('POST', '/api/complaints', { token: citizen, form });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.ref_no, /^CMP-/);
  assert.equal(r.data.category, 'roads');
  assert.equal(r.data.department, 'Roads & Engineering');
  const id = r.data.id;

  // the Registration officer must not see a Roads complaint; the Roads officer must
  assert.equal((await api('GET', `/api/complaints/${id}`, { token: await login('officer@ccas.gov') })).status, 404);
  const works = await login('works.officer@ccas.gov');
  const staff = (await api('GET', '/api/staff', { token: works })).data;
  assert.ok(staff.length >= 1);
  assert.equal((await api('POST', `/api/complaints/${id}/assign`, { token: works, body: { field_staff_id: staff[0].id } })).data.status, 'Assigned');

  const field = await login('field@ccas.gov');
  assert.equal((await api('GET', '/api/complaints', { token: field })).data[0].id, id);
  const prog = new FormData(); prog.append('status', 'In Progress'); prog.append('remark', 'Crew dispatched');
  assert.equal((await api('POST', `/api/complaints/${id}/update`, { token: field, form: prog })).data.status, 'In Progress');
  const noProof = new FormData(); noProof.append('status', 'Resolved'); noProof.append('remark', 'Filled');
  const np = await api('POST', `/api/complaints/${id}/update`, { token: field, form: noProof });
  assert.equal(np.status, 400);
  assert.match(np.data.error, /proof/);
  const done = new FormData(); done.append('status', 'Resolved'); done.append('remark', 'Pothole filled with asphalt'); done.append('photo', file('fixed.png', 'image/png'));
  assert.equal((await api('POST', `/api/complaints/${id}/update`, { token: field, form: done })).data.status, 'Resolved');

  const c = (await api('GET', `/api/complaints/${id}`, { token: citizen })).data;
  assert.equal(c.status, 'Resolved');
  assert.ok(c.resolved_at);
  assert.deepEqual(c.updates.map(u => u.status), ['Open', 'Assigned', 'In Progress', 'Resolved']);
  assert.equal(c.proofs.length, 1);
  assert.equal((await fetch(`${base}/api/files/${c.proofs[0].id}`, { headers: { authorization: `Bearer ${citizen}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/files/${c.proofs[0].id}`, { headers: { authorization: `Bearer ${await login('citizen2@ccas.gov')}` } })).status, 403);
  const notes = (await api('GET', '/api/notifications', { token: citizen })).data.map(n => n.title);
  assert.ok(notes.includes('Complaint registered') && notes.includes('Complaint resolved'));
});

test('complaint validation: short description rejected (alternate flow)', async () => {
  const citizen = await login('citizen@ccas.gov');
  const form = new FormData(); form.append('description', 'bad'); form.append('location', 'x');
  assert.equal((await api('POST', '/api/complaints', { token: citizen, form })).status, 400);
});

test('admin dashboard, reports (CSV), audit log, chatbot', async () => {
  const admin = await login('admin@ccas.gov');
  const d = (await api('GET', '/api/dashboard', { token: admin })).data;
  assert.ok(d.revenue.total > 0);
  assert.ok(d.complaints_by_category.length >= 1);
  const csv = await api('GET', '/api/admin/reports/payments.csv', { token: admin });
  assert.match(csv.data, /^txn_id,receipt_no,payer/);
  assert.ok((await api('GET', '/api/admin/audit', { token: admin })).data.some(a => a.action === 'account_locked'));
  const chat = await api('POST', '/api/chat', { token: await login('citizen@ccas.gov'), body: { messages: [{ role: 'user', content: 'Fee for birth certificate?' }] } });
  assert.equal(chat.status, 200);
  assert.match(chat.data.reply, /50/);
});

test('admin: create employee, add service, generate bills, settings', async () => {
  const admin = await login('admin@ccas.gov');
  const depts = (await api('GET', '/api/departments')).data;
  const elec = depts.find(d => d.code === 'ELEC');
  assert.equal((await api('POST', '/api/admin/users', { token: admin, body: { name: 'Light Officer', email: 'elec@ccas.gov', mobile: '9876500111', role: 'officer', department_id: elec.id, password: 'abc12345' } })).status, 201);
  assert.ok(await login('elec@ccas.gov', 'abc12345'));
  assert.equal((await api('POST', '/api/admin/services', { token: admin, body: { code: 'MKT', name: 'Market Stall Licence', department_id: depts.find(d => d.code === 'LIC').id, fee: 300, sla_days: 10, fields: 'Stall number, Market name' } })).status, 201);
  assert.ok((await api('GET', '/api/services')).data.some(s => s.code === 'MKT' && s.fields.length === 2));
  const gen = await api('POST', '/api/admin/bills/generate', { token: admin, body: { year: '2030-31', due_date: '2031-03-31' } });
  assert.equal(gen.data.created, 3);
  assert.equal((await api('POST', '/api/admin/bills/generate', { token: admin, body: { year: '2030-31', due_date: '2031-03-31' } })).data.created, 0);
  assert.equal((await api('PUT', '/api/admin/settings', { token: admin, body: { penalty_rate_monthly: 'abc' } })).status, 400);
  assert.equal((await api('PUT', '/api/admin/settings', { token: admin, body: { penalty_rate_monthly: '0.02' } })).status, 200);
});

test('AI endpoint registration requires the shared key and a safe URL', async () => {
  const post = (key, url) => fetch(`${base}/api/ai/endpoint`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key && { 'x-ccas-key': key }) }, body: JSON.stringify({ url }) });
  assert.equal((await post(null, 'https://abc.trycloudflare.com')).status, 403);
  assert.equal((await post('wrong-key-wrong-key-xx', 'https://abc.trycloudflare.com')).status, 403);
  assert.equal((await post(process.env.CCAS_AI_KEY, 'http://evil.example.com')).status, 400);
  assert.equal((await post(process.env.CCAS_AI_KEY, 'http://127.0.0.1:11434')).status, 200);
  assert.equal((await db.one("SELECT value FROM settings WHERE key = 'ai_url'")).value, 'http://127.0.0.1:11434');
  // ai_url is not exposed/editable through the numeric tax settings
  const admin = await login('admin@ccas.gov');
  assert.ok(!('ai_url' in (await api('GET', '/api/admin/settings', { token: admin })).data));
  assert.equal((await api('PUT', '/api/admin/settings', { token: admin, body: { ai_url: 'x' } })).status, 400);
});

test('JWT: tampered or expired tokens are rejected', () => {
  const t = signJwt({ sub: 1 }, 's');
  assert.equal(verifyJwt(t, 's').sub, 1);
  assert.equal(verifyJwt(t, 'other'), null);
  assert.equal(verifyJwt(signJwt({ sub: 1 }, 's', -1), 's'), null);
});

test('keyword fallback classifier', () => {
  assert.equal(keywordClassify('Street light not working for a week'), 'streetlight');
  assert.equal(keywordClassify('Garbage not collected, stinks'), 'garbage');
  assert.equal(keywordClassify('Drain overflowing onto street'), 'drainage');
  assert.equal(keywordClassify('No water supply since morning'), 'water');
  assert.equal(keywordClassify('Big pothole on main road'), 'roads');
});

test('LIVE Ollama classification (skipped if Ollama is not running)', async (t) => {
  const h = await ollamaHealth();
  if (!h.up || !h.modelInstalled) return t.skip(`Ollama/model ${h.model} not available`);
  const cases = [
    ['There is a big pothole on MG Road, vehicles are getting damaged', 'roads'],
    ['The drain in front of my house is clogged and sewage is overflowing', 'drainage'],
    ['Garbage has not been collected for 5 days, it is rotting and smells', 'garbage'],
    ['Street light on lane 4 is not working, it is very dark at night', 'streetlight'],
    ['No drinking water in our taps since two days, pipeline is leaking', 'water'],
  ];
  let correct = 0;
  for (const [text, want] of cases) {
    const r = await classifyComplaint(text);
    assert.match(r.source, /^ollama:/, r.error);
    if (r.category === want) correct++;
  }
  assert.ok(correct >= 4, `AI classified ${correct}/5 correctly`);
});
