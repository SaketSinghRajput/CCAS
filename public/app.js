/* CCAS single-page front end (vanilla JS + Bootstrap). Hash routes per role. */
'use strict';

// ---------- core helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (s) => s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
const day = (s) => s ? new Date(s.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '';
const cap = (s) => String(s || '').replace(/^\w/, c => c.toUpperCase());

const state = { token: null, user: null, services: [], wards: [], depts: [], chat: [] };
try { state.token = localStorage.getItem('ccas_token'); state.user = JSON.parse(localStorage.getItem('ccas_user') || 'null'); } catch { /* storage blocked */ }
if (!state.user) state.token = null;

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && state.token) { logout(); throw new Error(data.error || 'Session expired.'); }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.data = data; e.status = res.status; throw e; }
  return data;
}

function toast(msg, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${kind === 'error' ? 'danger' : kind} border-0`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(msg)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
  $('#toasts').append(el);
  new bootstrap.Toast(el, { delay: 5000 }).show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}
const fail = (e) => toast(e.message || String(e), 'error');

const modalEl = () => bootstrap.Modal.getOrCreateInstance($('#modal'));
function openModal(html) { $('#modal-content').innerHTML = html; modalEl().show(); return $('#modal-content'); }
const closeModal = () => modalEl().hide();

function busy(btn, on, label = 'Please wait...') {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${esc(label)}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

async function openFile(id) {
  const w = window.open('', '_blank');
  try {
    const r = await fetch(`/api/files/${id}`, { headers: { authorization: `Bearer ${state.token}` } });
    if (!r.ok) throw new Error((await r.json()).error);
    const url = URL.createObjectURL(await r.blob());
    if (w) w.location = url; else window.open(url, '_blank');
  } catch (e) { w?.close(); fail(e); }
}
async function download(path, filename) {
  try {
    const r = await fetch(path, { headers: { authorization: `Bearer ${state.token}` } });
    if (!r.ok) throw new Error('Download failed');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: filename });
    a.click();
  } catch (e) { fail(e); }
}

const STATUS_CLASS = {
  Approved: 's-ok', Resolved: 's-ok', Success: 's-ok', Paid: 's-ok', 'Fee Paid': 's-ok', Active: 's-ok',
  Submitted: 's-info', 'Under Verification': 's-info', Assigned: 's-info', 'In Progress': 's-info',
  Open: 's-warn', Pending: 's-warn', Unpaid: 's-warn', Returned: 's-warn', Unverified: 's-warn',
  Rejected: 's-bad', Failed: 's-bad', Overdue: 's-bad', Locked: 's-bad', Disabled: 's-muted',
};
const badge = (s) => `<span class="status ${STATUS_CLASS[s] || 's-muted'}">${esc(s)}</span>`;
const prio = (p) => `<span class="status ${p === 'High' ? 's-bad' : p === 'Low' ? 's-muted' : 's-warn'}">${esc(p)} priority</span>`;
const empty = (icon, text) => `<div class="empty"><i class="bi bi-${icon}"></i>${esc(text)}</div>`;
const CAT_ICON = { roads: 'sign-stop', drainage: 'droplet-half', garbage: 'trash3', streetlight: 'lightbulb', water: 'droplet', other: 'chat-square-text' };

function logout() {
  state.token = null; state.user = null; state.chat = [];
  try { localStorage.removeItem('ccas_token'); localStorage.removeItem('ccas_user'); } catch { /* ignore */ }
  $('#app').innerHTML = ''; $('#toasts').innerHTML = '';
  if (location.hash === '#/login') render(); else location.hash = '#/login';
}

// ---------- router ----------
const routes = [];
const route = (pattern, roles, fn) => routes.push({ re: new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), roles, fn });

async function render() {
  const path = location.hash.slice(1) || (state.token ? '/dashboard' : '/login');
  if ($('#modal').classList.contains('show')) closeModal();
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const args = m.slice(1).map(decodeURIComponent);
    if (r.roles === 'public') { $('#app').innerHTML = ''; return r.fn(...args); }
    if (!state.token) { location.hash = '#/login'; return; }
    if (r.roles && !r.roles.includes(state.user.role)) { location.hash = '#/dashboard'; return; }
    shell(path);
    try { await r.fn(...args); } catch (e) { if ($('#view')) $('#view').innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`; }
    window.scrollTo(0, 0);
    return;
  }
  location.hash = state.token ? '#/dashboard' : '#/login';
}
window.addEventListener('hashchange', render);

const NAV = {
  citizen: [['dashboard', 'grid', 'Dashboard'], ['services', 'card-checklist', 'Apply for Services'], ['applications', 'folder2-open', 'My Applications'],
    ['complaints', 'megaphone', 'Complaints'], ['tax', 'house', 'Property Tax'], ['payments', 'receipt', 'Payments'],
    ['assistant', 'robot', 'AI Assistant'], ['profile', 'person-circle', 'Profile & Documents']],
  officer: [['dashboard', 'grid', 'Dashboard'], ['applications', 'folder2-open', 'Applications Queue'], ['complaints', 'megaphone', 'Complaints Queue'],
    ['tax', 'house', 'Property Register'], ['assistant', 'robot', 'AI Assistant'], ['profile', 'person-circle', 'Profile']],
  field: [['dashboard', 'grid', 'Dashboard'], ['complaints', 'tools', 'My Assignments'], ['profile', 'person-circle', 'Profile']],
  admin: [['dashboard', 'speedometer2', 'Analytics'], ['applications', 'folder2-open', 'Applications'], ['complaints', 'megaphone', 'Complaints'],
    ['tax', 'house', 'Properties & Tax'], ['payments', 'receipt', 'Payments'], ['admin/users', 'people', 'Users & Staff'],
    ['admin/services', 'gear-wide', 'Services & Fees'], ['admin/announcements', 'broadcast', 'Announcements'],
    ['admin/settings', 'sliders', 'Tax Settings'], ['admin/audit', 'shield-check', 'Audit Log'], ['assistant', 'robot', 'AI Assistant']],
};
const ROLE_LABEL = { citizen: 'Citizen', officer: 'Department Officer', field: 'Field Staff', admin: 'Administrator' };

function shell(path) {
  const u = state.user;
  if (!$('#view')) {
    $('#app').innerHTML = `<div class="shell">
      <nav class="sidebar" aria-label="Main">
        <div class="brand mb-3">CCAS<small>City Corporation Automation System</small></div>
        <div class="section">${esc(ROLE_LABEL[u.role])}</div>
        <div id="nav" class="nav flex-column gap-1"></div>
      </nav>
      <div class="d-flex flex-column" style="min-width:0">
        <header class="topbar">
          <div class="me-auto small text-secondary d-none d-md-block">${u.department ? esc(u.department) : 'Municipal e-Services'}</div>
          <a href="#/notifications" class="btn btn-light position-relative" aria-label="Notifications"><i class="bi bi-bell"></i>
            <span id="unread" class="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger d-none">0</span></a>
          <div class="text-end lh-sm"><div class="fw-semibold small">${esc(u.name)}</div><div class="text-secondary" style="font-size:.75rem">${esc(ROLE_LABEL[u.role])}</div></div>
          <button class="btn btn-outline-secondary btn-sm" id="logout"><i class="bi bi-box-arrow-right"></i><span class="d-none d-sm-inline"> Logout</span></button>
        </header>
        <main class="content" id="view"></main>
      </div></div>`;
    $('#logout').onclick = logout;
  }
  $('#nav').innerHTML = NAV[u.role].map(([href, icon, label]) => {
    const on = path === '/' + href || path.startsWith('/' + href + '/') || (href === 'applications' && path.startsWith('/apply')) || (href === 'payments' && path.startsWith('/receipt'));
    return `<a class="nav-link ${on ? 'active' : ''}" ${on ? 'aria-current="page"' : ''} href="#/${href}"><i class="bi bi-${icon}"></i>${label}</a>`;
  }).join('');
  $('#view').innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading</span></div></div>';
  refreshUnread();
}
async function refreshUnread() {
  try {
    const n = (await api('/api/notifications')).filter(x => !x.read).length;
    const el = $('#unread'); if (!el) return;
    el.textContent = n; el.classList.toggle('d-none', !n);
  } catch { /* ignore */ }
}
const view = (html) => { $('#view').innerHTML = html; return $('#view'); };
const header = (title, sub, right = '') => `<div class="d-flex flex-wrap gap-2 align-items-start justify-content-between"><div><h1 class="page-title">${title}</h1><p class="page-sub">${sub}</p></div><div>${right}</div></div>`;

async function loadLookups() {
  if (!state.services.length) [state.services, state.wards, state.depts] = await Promise.all([api('/api/services'), api('/api/wards'), api('/api/departments')]);
}

// ---------- public: auth ----------
const SKYLINE = `<svg class="skyline" viewBox="0 0 400 160" fill="none" stroke="#fff" stroke-width="2" aria-hidden="true"><path d="M0 160V110h30V80h25v30h20V60l20-20 20 20v100M135 160V90h40v70M175 160V50h50v110M190 50V30h20v20M225 160V100h30V70h30v90M285 160V95h45v65M330 160V120h70v40"/><path d="M185 70h30M185 90h30M185 110h30M145 105h20M145 125h20M295 110h25M295 130h25"/></svg>`;

function authLayout(inner) {
  $('#app').innerHTML = `<div class="auth-wrap">
    <section class="auth-hero">
      <div>
        <div class="small text-uppercase" style="letter-spacing:2px;color:#9FB4CC">City Corporation</div>
        <h1>CCAS<br>City Corporation<br>Automation System</h1>
        <div class="accent"></div>
        <p class="lead" style="max-width:440px;color:#DCE6F2">One digital gateway to apply, pay, complain and track municipal services, 24x7.</p>
        <div class="chips"><span><i class="bi bi-file-earmark-check"></i> Certificates</span><span><i class="bi bi-house"></i> Property tax</span><span><i class="bi bi-megaphone"></i> Complaints</span><span><i class="bi bi-geo"></i> Tracking</span></div>
      </div>
      <div class="small mt-4" style="color:#9FB4CC">Software Engineering Lab &middot; B.Tech CSE (AI &amp; ML) &middot; Group 8 &middot; Prototype</div>
      ${SKYLINE}
    </section>
    <main class="auth-form"><div class="auth-card">${inner}</div></main></div>`;
}

const DEMO = [['Citizen', 'citizen@ccas.gov'], ['Officer (Registration)', 'officer@ccas.gov'], ['Officer (Roads)', 'works.officer@ccas.gov'],
  ['Officer (Revenue)', 'revenue.officer@ccas.gov'], ['Field staff (Roads)', 'field@ccas.gov'], ['Admin', 'admin@ccas.gov']];

route('/login', 'public', () => {
  if (state.token) { location.hash = '#/dashboard'; return; }
  authLayout(`<h2 class="h4 fw-bold mb-1" style="color:var(--navy)">Sign in</h2><p class="text-secondary mb-4">Citizens, officers, field staff and administrators.</p>
    <form id="f" novalidate>
      <div class="mb-3"><label class="form-label" for="email">E-mail</label><input class="form-control" id="email" type="email" autocomplete="username" required></div>
      <div class="mb-2"><label class="form-label" for="password">Password</label><input class="form-control" id="password" type="password" autocomplete="current-password" required></div>
      <div class="text-end mb-3"><a href="#/forgot" class="small">Forgot password?</a></div>
      <button class="btn btn-primary w-100" id="go">Sign in</button>
    </form>
    <p class="mt-3 text-center small">New citizen? <a href="#/register">Create an account</a></p>
    <div class="demo-box mt-4"><div class="fw-semibold mb-1">Demo accounts (password <code>Demo@1234</code>)</div>
      <div class="d-flex flex-wrap gap-1">${DEMO.map(([l, e]) => `<button type="button" class="btn btn-sm btn-outline-primary" data-email="${e}">${l}</button>`).join('')}</div></div>`);
  document.querySelectorAll('[data-email]').forEach(b => b.onclick = () => { $('#email').value = b.dataset.email; $('#password').value = 'Demo@1234'; $('#go').focus(); });
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#go'); busy(btn, true, 'Signing in...');
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
      state.token = r.token; state.user = r.user; state.services = [];
      try { localStorage.setItem('ccas_token', r.token); localStorage.setItem('ccas_user', JSON.stringify(r.user)); } catch { /* ignore */ }
      $('#app').innerHTML = ''; location.hash = '#/dashboard';
    } catch (e) {
      busy(btn, false);
      if (e.data?.needsVerification) { sessionStorage.setItem('ccas_verify', $('#email').value); location.hash = '#/verify-otp'; }
      fail(e);
    }
  };
});

route('/register', 'public', () => {
  authLayout(`<h2 class="h4 fw-bold mb-1" style="color:var(--navy)">Create citizen account</h2><p class="text-secondary mb-3">You will verify your account with a one-time password.</p>
    <form id="f" novalidate>
      <div class="mb-2"><label class="form-label" for="name">Full name</label><input class="form-control" id="name" required maxlength="100" autocomplete="name"></div>
      <div class="mb-2"><label class="form-label" for="email">E-mail</label><input class="form-control" id="email" type="email" required autocomplete="email"></div>
      <div class="mb-2"><label class="form-label" for="mobile">Mobile number</label><input class="form-control" id="mobile" inputmode="numeric" pattern="[6-9][0-9]{9}" maxlength="10" required autocomplete="tel"><div class="form-text">10-digit Indian mobile number.</div></div>
      <div class="mb-2"><label class="form-label" for="address">Address</label><input class="form-control" id="address" maxlength="300" autocomplete="street-address"></div>
      <div class="mb-3"><label class="form-label" for="password">Password</label><input class="form-control" id="password" type="password" autocomplete="new-password" required><div class="form-text">At least 8 characters with a letter and a number.</div></div>
      <button class="btn btn-primary w-100" id="go">Register</button>
    </form><p class="mt-3 text-center small">Already registered? <a href="#/login">Sign in</a></p>`);
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#go'); busy(btn, true);
    try {
      const body = Object.fromEntries(['name', 'email', 'mobile', 'address', 'password'].map(k => [k, $('#' + k).value]));
      const r = await api('/api/auth/register', { method: 'POST', body });
      sessionStorage.setItem('ccas_verify', body.email);
      if (r.demo_otp) sessionStorage.setItem('ccas_demo_otp', r.demo_otp);
      toast(r.message); location.hash = '#/verify-otp';
    } catch (e) { busy(btn, false); fail(e); }
  };
});

route('/verify-otp', 'public', () => {
  const email = sessionStorage.getItem('ccas_verify') || '';
  const demo = sessionStorage.getItem('ccas_demo_otp');
  authLayout(`<h2 class="h4 fw-bold mb-1" style="color:var(--navy)">Verify your account</h2><p class="text-secondary mb-3">Enter the 6-digit OTP sent to your e-mail and mobile.</p>
    ${demo ? `<div class="alert alert-info small"><i class="bi bi-info-circle"></i> Prototype mode (no SMS gateway): your OTP is <b>${esc(demo)}</b></div>` : ''}
    <form id="f"><div class="mb-2"><label class="form-label" for="email">E-mail</label><input class="form-control" id="email" value="${esc(email)}" required></div>
      <div class="mb-3"><label class="form-label" for="otp">OTP</label><input class="form-control" id="otp" inputmode="numeric" maxlength="6" required autocomplete="one-time-code"></div>
      <button class="btn btn-primary w-100" id="go">Verify</button></form>
    <p class="mt-3 text-center small"><a href="#" id="resend">Resend OTP</a> &middot; <a href="#/login">Back to sign in</a></p>`);
  $('#resend').onclick = async (ev) => {
    ev.preventDefault();
    try { sessionStorage.setItem('ccas_verify', $('#email').value); const r = await api('/api/auth/resend-otp', { method: 'POST', body: { email: $('#email').value } }); if (r.demo_otp) sessionStorage.setItem('ccas_demo_otp', r.demo_otp); toast(r.message); render(); } catch (e) { fail(e); }
  };
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    try { toast((await api('/api/auth/verify-otp', { method: 'POST', body: { email: $('#email').value, otp: $('#otp').value } })).message); sessionStorage.removeItem('ccas_demo_otp'); location.hash = '#/login'; } catch (e) { fail(e); }
  };
});

route('/forgot', 'public', () => {
  authLayout(`<h2 class="h4 fw-bold mb-1" style="color:var(--navy)">Reset password</h2><p class="text-secondary mb-3">We will send a one-time password to your registered e-mail/mobile.</p>
    <form id="f1"><div class="mb-3"><label class="form-label" for="email">E-mail</label><input class="form-control" id="email" type="email" required></div>
      <button class="btn btn-primary w-100">Send OTP</button></form>
    <form id="f2" class="d-none mt-3"><div id="demo"></div>
      <div class="mb-2"><label class="form-label" for="otp">OTP</label><input class="form-control" id="otp" inputmode="numeric" maxlength="6" required autocomplete="one-time-code"></div>
      <div class="mb-3"><label class="form-label" for="password">New password</label><input class="form-control" id="password" type="password" autocomplete="new-password" required></div>
      <button class="btn btn-primary w-100">Update password</button></form>
    <p class="mt-3 text-center small"><a href="#/login">Back to sign in</a></p>`);
  $('#f1').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('/api/auth/forgot', { method: 'POST', body: { email: $('#email').value } });
      toast(r.message); $('#f2').classList.remove('d-none');
      $('#demo').innerHTML = r.demo_otp ? `<div class="alert alert-info small">Prototype mode: OTP is <b>${esc(r.demo_otp)}</b></div>` : '';
    } catch (e) { fail(e); }
  };
  $('#f2').onsubmit = async (ev) => {
    ev.preventDefault();
    try { toast((await api('/api/auth/reset', { method: 'POST', body: { email: $('#email').value, otp: $('#otp').value, password: $('#password').value } })).message); location.hash = '#/login'; } catch (e) { fail(e); }
  };
});

route('/verify/(.+)', 'public', async (ref) => {
  $('#app').innerHTML = `<main class="container py-5" style="max-width:560px"><div class="card p-4 text-center" id="v"><div class="spinner-border text-primary mx-auto"></div></div></main>`;
  const r = await api(`/api/verify/${encodeURIComponent(ref)}`).catch(() => ({ valid: false }));
  $('#v').innerHTML = r.valid
    ? `<i class="bi bi-patch-check-fill" style="font-size:3rem;color:var(--ok)" aria-hidden="true"></i><h1 class="h4 mt-2">Valid certificate</h1>
       <p class="mb-1"><b>${esc(r.service)}</b></p><p class="mb-1">Issued to: ${esc(r.applicant)}</p><p class="mb-1">Reference: <code>${esc(r.ref_no)}</code></p><p class="text-secondary">Issued on ${when(r.issued_on)}</p>`
    : `<i class="bi bi-x-octagon-fill" style="font-size:3rem;color:#B42318" aria-hidden="true"></i><h1 class="h4 mt-2">Not a valid certificate</h1><p class="text-secondary">Reference <code>${esc(ref)}</code> was not found or is not approved.</p>`;
  $('#v').insertAdjacentHTML('beforeend', '<a class="btn btn-outline-primary mt-3" href="#/login">Go to CCAS</a>');
});

// ---------- dashboards ----------
const stat = (icon, label, value, href) => {
  const card = `<div class="card stat h-100"><div class="d-flex justify-content-between"><span class="label">${label}</span><i class="bi bi-${icon}" aria-hidden="true"></i></div><div class="value">${value}</div></div>`;
  return `<div class="col-6 col-lg-3">${href ? `<a href="${href}" class="text-decoration-none">${card}</a>` : card}</div>`;
};
const bars = (rows, key, val, fmt = (v) => v) => {
  const max = Math.max(1, ...rows.map(r => r[val] || 0));
  return rows.length ? rows.map(r => `<div class="bar"><span class="text-truncate" title="${esc(r[key])}">${esc(cap(r[key]))}</span><div class="track" role="img" aria-label="${esc(r[key])}: ${fmt(r[val] || 0)}"><div class="fill" style="width:${(100 * (r[val] || 0)) / max}%"></div></div><span class="text-end fw-semibold">${fmt(r[val] || 0)}</span></div>`).join('') : empty('bar-chart', 'No data yet');
};

route('/dashboard', null, async () => {
  const u = state.user, d = await api('/api/dashboard');
  if (u.role === 'citizen') {
    const anns = await api('/api/announcements');
    view(`${header(`Welcome, ${esc(u.name.split(' ')[0])}`, 'Apply, pay, complain and track - all in one place.')}
      <div class="row g-3 mb-4">${stat('folder2-open', 'Active applications', d.active_applications, '#/applications')}${stat('megaphone', 'Open complaints', d.open_complaints, '#/complaints')}
        ${stat('currency-rupee', 'Property tax due', money(d.tax_due), '#/tax')}${stat('bell', 'Unread notifications', d.unread, '#/notifications')}</div>
      <div class="row g-3 mb-4">
        <div class="col-md-4"><a class="quick-action" href="#/services"><i class="bi bi-file-earmark-plus"></i><div><div class="fw-semibold">Apply for a service</div><div class="small text-secondary">Certificates, licences, connections</div></div></a></div>
        <div class="col-md-4"><a class="quick-action" href="#/tax"><i class="bi bi-credit-card"></i><div><div class="fw-semibold">Pay property tax</div><div class="small text-secondary">Instant digital receipt</div></div></a></div>
        <div class="col-md-4"><a class="quick-action" href="#/complaints/new"><i class="bi bi-megaphone"></i><div><div class="fw-semibold">Lodge a complaint</div><div class="small text-secondary">AI routes it to the right department</div></div></a></div>
      </div>
      <div class="row g-3"><div class="col-lg-8"><div class="card p-3"><h2 class="h6 fw-bold">Recent activity</h2>
        ${d.recent.length ? `<div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Type</th><th>Reference</th><th>Details</th><th>Status</th><th>Date</th></tr></thead><tbody>
          ${d.recent.map(r => `<tr><td>${r.type}</td><td><a href="#/${r.type === 'Application' ? 'applications/' + r.id : r.type === 'Complaint' ? 'complaints/' + r.id : 'payments'}"><code>${esc(r.ref)}</code></a></td><td class="small">${esc(r.title)}</td><td>${badge(r.status)}</td><td class="small text-secondary">${when(r.at)}</td></tr>`).join('')}
        </tbody></table></div>` : empty('inbox', 'No activity yet. Start by applying for a service.')}</div></div>
        <div class="col-lg-4"><div class="card p-3"><h2 class="h6 fw-bold">Announcements</h2>
          ${anns.map(a => `<div class="border-bottom py-2"><div class="fw-semibold small">${esc(a.title)}</div><div class="small text-secondary">${esc(a.body)}</div>${a.deadline ? `<div class="small mt-1"><i class="bi bi-calendar-event"></i> Deadline ${day(a.deadline)}</div>` : ''}</div>`).join('') || empty('megaphone', 'No announcements')}</div></div></div>`);
  } else if (u.role === 'officer') {
    view(`${header('Officer dashboard', esc(u.department || ''))}
      <div class="row g-3 mb-4">${stat('hourglass-split', 'Applications pending', d.pending_applications, '#/applications')}${stat('exclamation-circle', 'New complaints', d.open_complaints, '#/complaints')}
        ${stat('arrow-repeat', 'Complaints in progress', d.in_progress, '#/complaints')}${stat('check2-circle', 'Complaints resolved', d.resolved)}</div>
      <div class="row g-3"><div class="col-md-6"><a class="quick-action" href="#/applications"><i class="bi bi-folder-check"></i><div><div class="fw-semibold">Verify applications</div><div class="small text-secondary">Approve, reject or return with remarks</div></div></a></div>
        <div class="col-md-6"><a class="quick-action" href="#/complaints"><i class="bi bi-person-gear"></i><div><div class="fw-semibold">Assign complaints</div><div class="small text-secondary">Route work to field staff</div></div></a></div></div>`);
  } else if (u.role === 'field') {
    view(`${header('Field staff dashboard', esc(u.department || ''))}
      <div class="row g-3 mb-4">${stat('inbox', 'Newly assigned', d.assigned, '#/complaints')}${stat('arrow-repeat', 'In progress', d.in_progress, '#/complaints')}${stat('check2-circle', 'Resolved', d.resolved)}</div>
      <a class="quick-action" href="#/complaints"><i class="bi bi-tools"></i><div><div class="fw-semibold">Open my assignments</div><div class="small text-secondary">Update progress and upload proof photos</div></div></a>`);
  } else {
    const n = (arr, k, v) => (arr.find(x => x[k] === v) || {}).n || 0;
    const totalC = d.complaints_by_status.reduce((s, x) => s + x.n, 0);
    const ai = d.ai_routing.filter(x => x.ai_source?.startsWith('ollama'));
    const aiN = ai.reduce((s, x) => s + x.n, 0), aiAgree = ai.reduce((s, x) => s + x.agreed, 0);
    view(`${header('Corporation analytics', 'Live statistics for decision-making (FR-037 to FR-040).',
      `<div class="d-flex flex-wrap gap-1 no-print"><button class="btn btn-outline-primary btn-sm" data-r="applications"><i class="bi bi-download"></i> Applications CSV</button><button class="btn btn-outline-primary btn-sm" data-r="complaints"><i class="bi bi-download"></i> Complaints CSV</button><button class="btn btn-outline-primary btn-sm" data-r="payments"><i class="bi bi-download"></i> Payments CSV</button></div>`)}
      <div class="row g-3 mb-3">${stat('people', 'Registered citizens', n(d.users, 'role', 'citizen'), '#/admin/users')}${stat('folder2-open', 'Applications', d.applications_by_status.reduce((s, x) => s + x.n, 0), '#/applications')}
        ${stat('megaphone', 'Complaints', totalC, '#/complaints')}${stat('currency-rupee', 'Revenue collected', money(d.revenue.total), '#/payments')}</div>
      <div class="row g-3 mb-4">${stat('hourglass', 'Avg. resolution time', d.avg_resolution_hours == null ? '-' : d.avg_resolution_hours < 1 ? Math.round(d.avg_resolution_hours * 60) + ' min' : d.avg_resolution_hours.toFixed(1) + ' h')}${stat('exclamation-triangle', 'Applications past SLA', d.overdue_applications, '#/applications')}
        ${stat('cash-stack', 'Tax outstanding', money(d.tax_outstanding), '#/tax')}${stat('robot', 'AI routing kept by staff', aiN ? Math.round((100 * aiAgree) / aiN) + '%' : '-')}</div>
      <div class="row g-3">
        <div class="col-lg-6"><div class="card p-3 h-100"><h2 class="h6 fw-bold mb-3">Complaints by category</h2>${bars(d.complaints_by_category, 'category', 'n')}</div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><h2 class="h6 fw-bold mb-3">Complaints by ward (hotspots)</h2>${bars(d.complaints_by_ward, 'ward', 'n')}</div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><h2 class="h6 fw-bold mb-3">Service usage</h2>${bars(d.applications_by_service, 'name', 'n')}</div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><h2 class="h6 fw-bold mb-3">Department workload (open complaints)</h2>${bars(d.department_load, 'name', 'open')}</div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><h2 class="h6 fw-bold mb-3">Applications by status</h2>${bars(d.applications_by_status, 'status', 'n')}</div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><h2 class="h6 fw-bold mb-3">Revenue by source</h2>${bars(d.revenue_by_purpose, 'kind', 'total', money)}</div></div>
      </div>`);
    document.querySelectorAll('[data-r]').forEach(b => b.onclick = () => download(`/api/admin/reports/${b.dataset.r}.csv`, `ccas-${b.dataset.r}.csv`));
  }
});

// ---------- M2: services & applications ----------
route('/services', ['citizen'], async () => {
  await loadLookups();
  const icon = { BIRTH: 'balloon', DEATH: 'flower1', RESID: 'house-check', TRADE: 'shop', BPLAN: 'building', GARB: 'trash3', WCONN: 'droplet' };
  view(`${header('Municipal services', 'Choose a service to apply online. Upload supporting documents as PDF, JPG or PNG (max 5 MB each).')}
    <div class="row g-3">${state.services.map(s => `<div class="col-md-6 col-xl-4"><div class="card p-3 h-100 d-flex flex-column">
      <div class="d-flex gap-2 align-items-center mb-2"><i class="bi bi-${icon[s.code] || 'file-earmark-text'} fs-4" style="color:var(--blue)" aria-hidden="true"></i><h2 class="h6 fw-bold mb-0">${esc(s.name)}</h2></div>
      <p class="small text-secondary flex-grow-1">${esc(s.description)}</p>
      <div class="d-flex justify-content-between align-items-center small mb-2 gap-2"><span>Fee <b>${money(s.fee)}</b></span><span class="text-secondary text-end">~${s.sla_days} days &middot; ${esc(s.department)}</span></div>
      <a class="btn btn-primary btn-sm" href="#/apply/${s.id}" aria-label="Apply for ${esc(s.name)}">Apply</a></div></div>`).join('')}</div>`);
});

route('/apply/:id', ['citizen'], async (id) => {
  await loadLookups();
  const s = state.services.find(x => String(x.id) === id);
  if (!s) throw new Error('Service not found');
  view(`${header(`Apply: ${esc(s.name)}`, `${esc(s.department)} &middot; Fee ${money(s.fee)} &middot; processed in about ${s.sla_days} days`)}
    <div class="card p-4" style="max-width:720px"><form id="f" novalidate>
      <div class="row g-3">${s.fields.map(f => `<div class="col-md-6"><label class="form-label" for="f_${f.name}">${esc(f.label)} <span class="text-danger">*</span></label>
        <input class="form-control" id="f_${f.name}" name="${f.name}" type="${f.type || 'text'}" ${f.type === 'number' ? 'min="1"' : ''} required maxlength="300"><div class="invalid-feedback">${esc(f.label)} is required.</div></div>`).join('')}
      <div class="col-12"><label class="form-label" for="docs">Supporting documents <span class="text-danger">*</span></label>
        <input class="form-control" id="docs" type="file" multiple accept=".pdf,.jpg,.jpeg,.png" required><div class="form-text">Up to 5 files. PDF, JPG or PNG only; max 5 MB each.</div><div id="ferr" class="text-danger small" role="alert"></div></div></div>
      <div class="mt-4 d-flex gap-2"><button class="btn btn-primary" id="go">Submit application</button><a class="btn btn-light" href="#/services">Cancel</a></div></form></div>`);
  $('#docs').onchange = () => {
    const bad = [...$('#docs').files].filter(f => f.size > 5 * 1024 * 1024 || !/\.(pdf|jpe?g|png)$/i.test(f.name));
    $('#ferr').textContent = bad.length ? `Not allowed: ${bad.map(f => f.name).join(', ')} (only PDF/JPG/PNG up to 5 MB)` : '';
  };
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    if (!ev.target.checkValidity()) { ev.target.classList.add('was-validated'); return toast('Please fill all required fields.', 'error'); }
    const form = new FormData();
    form.append('service_id', s.id);
    form.append('details', JSON.stringify(Object.fromEntries(s.fields.map(f => [f.name, $(`#f_${f.name}`).value]))));
    for (const f of $('#docs').files) form.append('documents', f);
    const btn = $('#go'); busy(btn, true, 'Submitting...');
    try {
      const r = await api('/api/applications', { method: 'POST', form });
      toast(`Application ${r.ref_no} submitted.`);
      location.hash = `#/applications/${r.id}`;
    } catch (e) { busy(btn, false); fail(e); }
  };
});

route('/applications', ['citizen', 'officer', 'admin'], async () => {
  const rows = await api('/api/applications');
  const citizen = state.user.role === 'citizen';
  const draw = (filter) => {
    const list = rows.filter(a => !filter || (filter === 'pending' ? ['Submitted', 'Under Verification'].includes(a.status) : a.status === filter));
    $('#list').innerHTML = list.length ? `<div class="table-responsive"><table class="table align-middle"><thead><tr><th>Reference</th><th>Service</th>${citizen ? '' : '<th>Applicant</th>'}<th>Submitted</th><th>Fee</th><th>Status</th><th><span class="visually-hidden">Open</span></th></tr></thead><tbody>
      ${list.map(a => `<tr><td><code>${esc(a.ref_no)}</code>${a.overdue ? ' <span class="status s-bad" title="Past service-level target">Past SLA</span>' : ''}</td><td>${esc(a.service)}</td>${citizen ? '' : `<td>${esc(a.applicant)}</td>`}
        <td class="small">${when(a.created_at)}</td><td>${a.fee ? (a.fee_paid ? badge('Paid') : badge('Unpaid')) : '-'}</td><td>${badge(a.status)}</td>
        <td><a class="btn btn-sm btn-outline-primary" href="#/applications/${a.id}">${citizen ? 'Track' : 'Open'}</a></td></tr>`).join('')}</tbody></table></div>`
      : empty('folder', 'No applications here.');
  };
  view(`${header(citizen ? 'My applications' : 'Applications', citizen ? 'Track every application from submission to certificate.' : 'Verify documents and decide on applications.', citizen ? '<a class="btn btn-primary" href="#/services"><i class="bi bi-plus"></i> New application</a>' : '')}
    <div class="card p-3"><div class="mb-3 d-flex flex-wrap gap-2" id="tabs" role="group" aria-label="Filter">${['', 'pending', 'Returned', 'Approved', 'Rejected'].map((f, i) => `<button class="btn btn-sm ${i ? 'btn-light' : 'btn-primary'}" data-f="${f}" aria-pressed="${!i}">${f === '' ? 'All' : f === 'pending' ? 'Pending' : f}</button>`).join('')}</div><div id="list"></div></div>`);
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach(x => { x.className = 'btn btn-sm btn-light'; x.setAttribute('aria-pressed', 'false'); });
    b.className = 'btn btn-sm btn-primary'; b.setAttribute('aria-pressed', 'true'); draw(b.dataset.f);
  });
  draw('');
});

const APP_STEPS = ['Submitted', 'Fee Paid', 'Under Verification', 'Approved'];
route('/applications/:id', ['citizen', 'officer', 'admin'], async (id) => {
  const a = await api(`/api/applications/${id}`);
  const citizen = state.user.role === 'citizen';
  const reached = new Set(a.history.map(h => h.status));
  if (a.fee_paid) reached.add('Fee Paid');
  if (a.status === 'Approved') reached.add('Under Verification');
  const steps = a.status === 'Rejected' ? [...APP_STEPS.slice(0, 3), 'Rejected'] : APP_STEPS;
  view(`${header(`${esc(a.service)}`, `Reference <code>${esc(a.ref_no)}</code> &middot; ${esc(a.department)}`, badge(a.status))}
    <div class="card p-3 mb-3"><div class="steps">${steps.map((s, i) => `<div class="step ${reached.has(s) ? 'done' : ''}"><div class="n">${reached.has(s) ? '<i class="bi bi-check" aria-label="done"></i>' : i + 1}</div><div>${s}</div></div>`).join('')}</div></div>
    <div class="row g-3"><div class="col-lg-7">
      <div class="card p-3 mb-3"><h2 class="h6 fw-bold">Application details</h2><dl class="row mb-0 small">
        ${!citizen ? `<dt class="col-sm-4">Applicant</dt><dd class="col-sm-8">${esc(a.applicant)} (${esc(a.applicant_email)})</dd>` : ''}
        ${Object.entries(a.details).map(([k, v]) => `<dt class="col-sm-4">${esc(cap(k.replace(/_/g, ' ')))}</dt><dd class="col-sm-8">${esc(v)}</dd>`).join('')}
        <dt class="col-sm-4">Fee</dt><dd class="col-sm-8">${money(a.fee)} ${a.fee ? (a.fee_paid ? badge('Paid') : badge('Unpaid')) : ''}</dd>
        ${a.remarks ? `<dt class="col-sm-4">Officer remarks</dt><dd class="col-sm-8">${esc(a.remarks)}</dd>` : ''}</dl></div>
      <div class="card p-3 mb-3"><h2 class="h6 fw-bold">Documents</h2><div>${a.documents.map(d => `<button class="btn btn-sm btn-light me-1 mb-1" data-file="${d.id}"><i class="bi bi-paperclip"></i> ${esc(d.original_name)} <span class="text-secondary">(${Math.ceil(d.size / 1024)} KB)</span></button>`).join('') || empty('paperclip', 'No documents')}</div></div>
      <div class="card p-3" id="actions"></div>
    </div><div class="col-lg-5"><div class="card p-3"><h2 class="h6 fw-bold mb-3">History</h2><ul class="timeline">
      ${a.history.map(h => `<li><span class="dot"></span><div class="d-flex justify-content-between gap-2"><b class="small">${esc(h.status)}</b><span class="small text-secondary">${when(h.created_at)}</span></div><div class="small text-secondary">${esc(h.remark || '')}${h.by_name ? ` &middot; by ${esc(h.by_name)}` : ''}</div></li>`).join('')}</ul></div></div></div>`);
  document.querySelectorAll('[data-file]').forEach(b => b.onclick = () => openFile(b.dataset.file));
  const act = $('#actions');
  if (citizen) {
    const parts = [];
    if (!a.fee_paid && a.status !== 'Rejected') parts.push(`<button class="btn btn-primary" id="pay"><i class="bi bi-credit-card"></i> Pay fee ${money(a.fee)}</button>`);
    if (a.status === 'Approved') parts.push(`<a class="btn btn-success" href="#/certificate/${a.id}"><i class="bi bi-award"></i> View / download certificate</a>`);
    if (a.status === 'Returned') parts.push(`<div class="w-100"><div class="alert alert-warning small mb-2">Returned for correction: ${esc(a.remarks)}</div><label class="form-label small" for="redocs">Upload corrected documents</label><input id="redocs" class="form-control mb-2" type="file" multiple accept=".pdf,.jpg,.jpeg,.png"><button class="btn btn-primary" id="resub">Resubmit</button></div>`);
    act.innerHTML = parts.length ? `<h2 class="h6 fw-bold">Next steps</h2><div class="d-flex flex-wrap gap-2">${parts.join('')}</div>` : '<div class="small text-secondary">No action needed from you right now. You will be notified of every status change.</div>';
    if ($('#pay')) $('#pay').onclick = () => payFlow({ application_id: a.id });
    if ($('#resub')) $('#resub').onclick = async () => {
      const form = new FormData(); for (const f of $('#redocs').files) form.append('documents', f);
      try { await api(`/api/applications/${a.id}/resubmit`, { method: 'POST', form }); toast('Application resubmitted.'); render(); } catch (e) { fail(e); }
    };
  } else if (['Approved', 'Rejected'].includes(a.status)) {
    act.innerHTML = `<div class="small">Decision recorded${a.officer ? ` by ${esc(a.officer)}` : ''}.</div>${a.status === 'Approved' ? `<a class="btn btn-outline-primary btn-sm mt-2" href="#/certificate/${a.id}">View certificate</a>` : ''}`;
  } else if (a.status === 'Returned') {
    act.innerHTML = '<div class="small text-secondary">Returned to the citizen for correction. It will reappear as Submitted when resubmitted.</div>';
  } else {
    act.innerHTML = `<h2 class="h6 fw-bold">Officer decision</h2>
      ${!a.fee_paid ? '<div class="alert alert-warning small py-2">Service fee not paid yet - approval is blocked until payment is confirmed.</div>' : ''}
      <label class="form-label small" for="remarks">Remarks (required for return / reject)</label><textarea id="remarks" class="form-control mb-2" rows="2" maxlength="500"></textarea>
      <div class="d-flex flex-wrap gap-2">${a.status === 'Submitted' ? '<button class="btn btn-outline-primary" data-act="verify"><i class="bi bi-search"></i> Start verification</button>' : ''}
        <button class="btn btn-success" data-act="approve" ${a.fee_paid ? '' : 'disabled'}><i class="bi bi-check2"></i> Approve</button>
        <button class="btn btn-outline-warning" data-act="return"><i class="bi bi-arrow-counterclockwise"></i> Return for correction</button>
        <button class="btn btn-outline-danger" data-act="reject"><i class="bi bi-x"></i> Reject</button></div>`;
    act.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      busy(b, true);
      try { await api(`/api/applications/${a.id}/action`, { method: 'POST', body: { action: b.dataset.act, remarks: $('#remarks').value } }); toast('Decision saved and citizen notified.'); render(); } catch (e) { busy(b, false); fail(e); }
    });
  }
});

route('/certificate/:id', ['citizen', 'officer', 'admin'], async (id) => {
  const c = await api(`/api/applications/${id}/certificate`);
  view(`<div class="no-print mb-3 d-flex gap-2"><button class="btn btn-primary" id="print"><i class="bi bi-printer"></i> Print / Save as PDF</button><a class="btn btn-light" href="#/applications/${c.id}">Back</a></div>
    <div class="doc"><div class="cert-border">
      <div class="doc-head"><div><div class="small text-uppercase text-secondary" style="letter-spacing:2px">City Corporation</div><h1 class="h4 fw-bold mb-0" style="color:var(--navy)">${esc(c.service)}</h1><div class="small text-secondary">${esc(c.department)}</div></div><div class="seal" aria-hidden="true">CCAS</div></div>
      <p>This is to certify that the following particulars have been verified and recorded in the registers of the City Corporation.</p>
      <table class="table table-sm"><tbody>${Object.entries(c.details).map(([k, v]) => `<tr><th style="width:40%">${esc(cap(k.replace(/_/g, ' ')))}</th><td>${esc(v)}</td></tr>`).join('')}
        <tr><th>Applicant</th><td>${esc(c.applicant)}</td></tr><tr><th>Certificate / Ref. No.</th><td><code>${esc(c.ref_no)}</code></td></tr><tr><th>Date of issue</th><td>${when(c.updated_at)}</td></tr></tbody></table>
      <div class="d-flex justify-content-between align-items-end mt-4 gap-3 flex-wrap"><div><img src="${c.qr}" alt="QR code to verify this certificate online" width="120" height="120"><div class="small text-secondary">Scan to verify authenticity</div></div>
        <div class="text-end"><div class="fw-semibold">${esc(c.officer || 'Registrar')}</div><div class="small text-secondary">Digitally approved by the competent authority</div><div class="small text-secondary">${esc(c.department)}</div></div></div>
    </div></div>`);
  $('#print').onclick = () => window.print();
});

// ---------- M3: tax & payments ----------
async function payFlow(target) {
  let init;
  try { init = await api('/api/payments/initiate', { method: 'POST', body: target }); } catch (e) { return fail(e); }
  const m = openModal(`<div class="modal-header"><h2 class="modal-title h5"><i class="bi bi-shield-lock"></i> Payment gateway (sandbox)</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
    <div class="modal-body"><p class="mb-1 small text-secondary">${esc(init.purpose)}</p><div class="display-6 fw-bold" style="color:var(--navy)">${money(init.amount)}</div>
      ${init.penalty ? `<div class="small" style="color:var(--warn)">Includes late penalty of ${money(init.penalty)}</div>` : ''}<div class="small text-secondary mb-3">Transaction ${esc(init.txn_id)}</div>
      <label class="form-label" for="method">Payment method</label><select id="method" class="form-select"><option>UPI</option><option>Card</option><option>NetBanking</option></select>
      <div class="form-text">Prototype: no real money moves. Your bill is marked paid only after the gateway confirms.</div></div>
    <div class="modal-footer"><button class="btn btn-outline-danger" id="pfail">Simulate failure</button><button class="btn btn-success" id="pok">Pay ${money(init.amount)}</button></div>`);
  const confirm = async (outcome, btn) => {
    busy(btn, true, 'Processing...');
    try {
      const r = await api(`/api/payments/${init.txn_id}/confirm`, { method: 'POST', body: { outcome, method: $('#method', m).value } });
      closeModal();
      if (r.status === 'Success') { toast(`Payment successful. Receipt ${r.receipt_no}`); location.hash = `#/receipt/${r.payment_id}`; }
      else { toast(r.message, 'warning'); render(); }
    } catch (e) { busy(btn, false); fail(e); }
  };
  $('#pok', m).onclick = (e) => confirm('success', e.currentTarget);
  $('#pfail', m).onclick = (e) => confirm('failure', e.currentTarget);
}

route('/tax', null, async () => {
  const props = await api('/api/properties');
  const citizen = state.user.role === 'citizen', admin = state.user.role === 'admin';
  view(`${header(citizen ? 'Property tax' : 'Property register', citizen ? 'Bills include property tax and water charges. A 2% monthly penalty applies after the due date.' : 'All properties, bills and dues.',
    admin ? '<button class="btn btn-primary btn-sm" id="addp"><i class="bi bi-plus"></i> Add property</button> <button class="btn btn-outline-primary btn-sm" id="gen"><i class="bi bi-receipt"></i> Generate bills</button>' : '')}
    ${props.length ? props.map(p => `<div class="card p-3 mb-3"><div class="mb-2"><h2 class="h6 fw-bold mb-0">${esc(p.property_no)} &middot; ${esc(p.address)}</h2>
      <div class="small text-secondary">${esc(p.ward || '')} &middot; ${esc(p.usage)} &middot; ${p.area_sqft} sq ft &middot; Annual value ${money(p.annual_value)}${citizen ? '' : ` &middot; Owner ${esc(p.owner)}`}</div></div>
      <div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Year</th><th>Tax</th><th>Water</th><th>Due date</th><th>Penalty</th><th>Total</th><th>Status</th><th><span class="visually-hidden">Action</span></th></tr></thead><tbody>
      ${p.bills.map(b => `<tr><td>${esc(b.year)}</td><td>${money(b.tax_amount)}</td><td>${money(b.water_charge)}</td><td>${day(b.due_date)}</td>
        <td>${b.penalty ? `<span style="color:var(--warn)">${money(b.penalty)}</span>` : '-'}</td><td class="fw-semibold">${money(b.total)}</td><td>${b.overdue ? badge('Overdue') : badge(b.status)}</td>
        <td>${citizen && b.status !== 'Paid' ? `<button class="btn btn-sm btn-primary" data-bill="${b.id}">Pay</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`).join('')
    : `<div class="card">${empty('house', 'No properties are registered in your name. Contact the Revenue department to link a property.')}</div>`}`);
  document.querySelectorAll('[data-bill]').forEach(b => b.onclick = () => payFlow({ bill_id: Number(b.dataset.bill) }));
  if (admin) {
    await loadLookups();
    $('#addp').onclick = () => {
      const m = openModal(`<form id="pf"><div class="modal-header"><h2 class="modal-title h5">Add property</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body row g-2">
        <div class="col-6"><label class="form-label small" for="pn">Property no.</label><input class="form-control" id="pn" name="property_no" required></div>
        <div class="col-6"><label class="form-label small" for="oe">Owner e-mail (citizen)</label><input class="form-control" id="oe" name="owner_email" type="email" required></div>
        <div class="col-12"><label class="form-label small" for="ad">Address</label><input class="form-control" id="ad" name="address" required></div>
        <div class="col-6"><label class="form-label small" for="wd">Ward</label><select class="form-select" id="wd" name="ward_id">${state.wards.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
        <div class="col-6"><label class="form-label small" for="us">Usage</label><select class="form-select" id="us" name="usage"><option>Residential</option><option>Commercial</option></select></div>
        <div class="col-6"><label class="form-label small" for="ar">Area (sq ft)</label><input class="form-control" id="ar" name="area_sqft" type="number" min="1" required></div>
        <div class="col-6"><label class="form-label small" for="av">Annual value (Rs)</label><input class="form-control" id="av" name="annual_value" type="number" min="1" required></div></div>
        <div class="modal-footer"><button class="btn btn-primary">Save</button></div></form>`);
      $('#pf', m).onsubmit = async (ev) => { ev.preventDefault(); try { await api('/api/admin/properties', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); closeModal(); toast('Property added.'); render(); } catch (e) { fail(e); } };
    };
    $('#gen').onclick = () => {
      const y = new Date().getFullYear();
      const m = openModal(`<form id="gf"><div class="modal-header"><h2 class="modal-title h5">Generate yearly bills</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body">
        <label class="form-label small" for="fy">Financial year</label><input class="form-control mb-2" id="fy" name="year" value="${y + 1}-${String(y + 2).slice(2)}" required>
        <label class="form-label small" for="dd">Due date</label><input class="form-control" id="dd" type="date" name="due_date" value="${y + 2}-03-31" required>
        <div class="form-text">Tax is computed automatically from annual value, usage and area. Owners are notified.</div></div><div class="modal-footer"><button class="btn btn-primary">Generate</button></div></form>`);
      $('#gf', m).onsubmit = async (ev) => { ev.preventDefault(); try { const r = await api('/api/admin/bills/generate', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); closeModal(); toast(`${r.created} bill(s) generated.`); render(); } catch (e) { fail(e); } };
    };
  }
});

route('/payments', ['citizen', 'admin'], async () => {
  const rows = await api('/api/payments');
  const admin = state.user.role === 'admin';
  view(`${header('Payments', admin ? 'All transactions recorded by the system.' : 'Your payment history and receipts.')}
    <div class="card p-3">${rows.length ? `<div class="table-responsive"><table class="table align-middle"><thead><tr><th>Date</th>${admin ? '<th>Payer</th>' : ''}<th>Purpose</th><th>Amount</th><th>Method</th><th>Status</th><th>Receipt</th></tr></thead><tbody>
      ${rows.map(p => `<tr><td class="small">${when(p.created_at)}</td>${admin ? `<td>${esc(p.payer)}</td>` : ''}<td class="small">${esc(p.purpose)}</td><td>${money(p.amount)}</td><td>${esc(p.method || '-')}</td><td>${badge(p.status)}</td>
        <td>${p.status === 'Success' ? `<a class="btn btn-sm btn-outline-primary" href="#/receipt/${p.id}"><i class="bi bi-receipt"></i> ${esc(p.receipt_no)}</a>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('receipt', 'No payments yet.')}</div>`);
});

route('/receipt/:id', ['citizen', 'admin'], async (id) => {
  const p = await api(`/api/payments/${id}/receipt`);
  view(`<div class="no-print mb-3 d-flex gap-2"><button class="btn btn-primary" id="print"><i class="bi bi-printer"></i> Print / Save as PDF</button><a class="btn btn-light" href="#/payments">All payments</a></div>
    <div class="doc"><div class="doc-head"><div><div class="small text-uppercase text-secondary" style="letter-spacing:2px">City Corporation</div><h1 class="h4 fw-bold mb-0" style="color:var(--navy)">Payment Receipt</h1></div><div class="seal" aria-hidden="true">CCAS</div></div>
      <table class="table"><tbody><tr><th style="width:35%">Receipt no.</th><td><code>${esc(p.receipt_no)}</code></td></tr><tr><th>Transaction ID</th><td>${esc(p.txn_id)}</td></tr>
        <tr><th>Paid by</th><td>${esc(p.payer)} (${esc(p.email)})</td></tr><tr><th>Towards</th><td>${esc(p.purpose)}</td></tr>
        ${p.penalty ? `<tr><th>Principal</th><td>${money(p.amount - p.penalty)}</td></tr><tr><th>Late penalty</th><td>${money(p.penalty)}</td></tr>` : ''}
        <tr><th>Amount paid</th><td class="fs-5 fw-bold">${money(p.amount)}</td></tr><tr><th>Method</th><td>${esc(p.method)}</td></tr><tr><th>Date</th><td>${when(p.paid_at)}</td></tr><tr><th>Status</th><td>${badge('Success')}</td></tr></tbody></table>
      <p class="small text-secondary mb-0">This is a computer-generated receipt and does not require a signature.</p></div>`);
  $('#print').onclick = () => window.print();
});

// ---------- M4: complaints ----------
const C_STEPS = ['Open', 'Assigned', 'In Progress', 'Resolved'];

route('/complaints', null, async () => {
  const rows = await api('/api/complaints');
  const r = state.user.role;
  view(`${header(r === 'citizen' ? 'My complaints' : r === 'field' ? 'My assignments' : 'Complaints', r === 'citizen' ? 'Roads, drainage, garbage, street lights, water supply and more.' : r === 'field' ? 'Complaints assigned to you. Upload a photo as proof when resolved.' : 'Sorted by status and AI-assessed priority.',
    r === 'citizen' ? '<a class="btn btn-primary" href="#/complaints/new"><i class="bi bi-plus"></i> Lodge complaint</a>' : '')}
    <div class="card p-3">${rows.length ? `<div class="table-responsive"><table class="table align-middle"><thead><tr><th>Reference</th><th>Category</th><th>Location</th>${r === 'citizen' ? '' : '<th>Priority</th>'}<th>Department</th><th>Status</th><th>Lodged</th><th><span class="visually-hidden">Open</span></th></tr></thead><tbody>
      ${rows.map(c => `<tr><td><code>${esc(c.ref_no)}</code></td><td class="text-nowrap"><i class="bi bi-${CAT_ICON[c.category]}" aria-hidden="true"></i> ${esc(cap(c.category))}</td><td class="small">${esc(c.location)}</td>${r === 'citizen' ? '' : `<td>${prio(c.priority)}</td>`}
        <td class="small">${esc(c.department)}</td><td>${badge(c.status)}</td><td class="small">${when(c.created_at)}</td><td><a class="btn btn-sm btn-outline-primary" href="#/complaints/${c.id}">${r === 'citizen' ? 'Track' : 'Open'}</a></td></tr>`).join('')}</tbody></table></div>`
      : empty('megaphone', r === 'citizen' ? 'You have not lodged any complaints.' : 'Nothing in your queue.')}</div>`);
});

route('/complaints/new', ['citizen'], async () => {
  await loadLookups();
  view(`${header('Lodge a complaint', 'Describe the problem. Our AI assistant (running locally on Ollama) suggests the category and routes it to the right department.')}
    <div class="row g-3"><div class="col-lg-8"><div class="card p-4"><form id="f" novalidate>
      <div class="mb-3"><label class="form-label" for="description">What is the problem? <span class="text-danger">*</span></label>
        <textarea class="form-control" id="description" rows="4" minlength="10" maxlength="2000" required placeholder="e.g. Street light near the bus stop on Lake Road is not working for a week"></textarea>
        <div class="d-flex justify-content-between flex-wrap"><div class="form-text">At least 10 characters.</div><button type="button" class="btn btn-link btn-sm px-0" id="suggest"><i class="bi bi-stars"></i> Suggest category with AI</button></div></div>
      <div id="ai" class="mb-3" aria-live="polite"></div>
      <div class="row g-3"><div class="col-md-6"><label class="form-label" for="category">Category</label><select class="form-select" id="category">
          <option value="">Let AI decide</option>${Object.keys(CAT_ICON).map(c => `<option value="${c}">${cap(c)}</option>`).join('')}</select></div>
        <div class="col-md-6"><label class="form-label" for="ward">Ward</label><select class="form-select" id="ward"><option value="">Select ward</option>${state.wards.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
        <div class="col-12"><label class="form-label" for="location">Location / landmark <span class="text-danger">*</span></label>
          <div class="input-group"><input class="form-control" id="location" maxlength="300" required><button type="button" class="btn btn-outline-secondary" id="geo" title="Use my current location"><i class="bi bi-crosshair"></i> GPS</button></div>
          <div class="form-text" id="geotext"></div></div>
        <div class="col-12"><label class="form-label" for="photo">Photo (optional)</label><input class="form-control" id="photo" type="file" accept=".jpg,.jpeg,.png"><div class="form-text">JPG or PNG, max 5 MB.</div></div></div>
      <div class="mt-4"><button class="btn btn-primary" id="go">Submit complaint</button></div></form></div></div>
      <div class="col-lg-4"><div class="card p-3"><h2 class="h6 fw-bold">What happens next</h2><ul class="timeline mt-2">${['Complaint ID generated and acknowledgement sent', 'Routed to the concerned department', 'Officer assigns field staff', 'Field staff resolves and uploads proof', 'You are notified at every step'].map(s => `<li><span class="dot"></span><span class="small">${s}</span></li>`).join('')}</ul></div></div></div>`);
  let coords = null;
  $('#geo').onclick = () => {
    if (!navigator.geolocation) return toast('GPS not available in this browser.', 'warning');
    navigator.geolocation.getCurrentPosition((p) => { coords = p.coords; $('#geotext').textContent = `GPS: ${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`; }, () => toast('Could not read location.', 'warning'));
  };
  $('#suggest').onclick = async (ev) => {
    const text = $('#description').value.trim();
    if (text.length < 10) return toast('Please describe the problem first (10+ characters).', 'warning');
    const btn = ev.currentTarget; busy(btn, true, 'AI is thinking...');
    try {
      const r = await api('/api/complaints/classify', { method: 'POST', body: { text: `${text}\nLocation: ${$('#location').value}` } });
      $('#ai').innerHTML = `<div class="ai-chip"><i class="bi bi-stars"></i> <b>${esc(cap(r.category))}</b> &rarr; ${esc(r.department)} &middot; ${prio(r.priority)}
        ${r.summary ? `<div class="small text-secondary mt-1">${esc(r.summary)}</div>` : ''}<div class="small text-secondary mt-1">${r.source.startsWith('ollama') ? `Classified by local model ${esc(r.source.slice(7))}` : 'AI offline - keyword rules used'}</div></div>`;
      $('#category').value = r.category;
    } catch (e) { fail(e); } finally { busy(btn, false); }
  };
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    if (!ev.target.checkValidity()) { ev.target.classList.add('was-validated'); return toast('Please fill the required fields (description of at least 10 characters and location).', 'error'); }
    const f = $('#photo').files[0];
    if (f && (f.size > 5 * 1024 * 1024 || !/\.(jpe?g|png)$/i.test(f.name))) return toast('Photo must be JPG/PNG and at most 5 MB.', 'error');
    const form = new FormData();
    form.append('description', $('#description').value); form.append('location', $('#location').value);
    form.append('category', $('#category').value); form.append('ward_id', $('#ward').value);
    if (coords) { form.append('latitude', coords.latitude); form.append('longitude', coords.longitude); }
    if (f) form.append('photo', f);
    const btn = $('#go'); busy(btn, true, 'Submitting...');
    try {
      const r = await api('/api/complaints', { method: 'POST', form });
      toast(`Complaint ${r.ref_no} registered and sent to ${r.department}.`);
      location.hash = `#/complaints/${r.id}`;
    } catch (e) { busy(btn, false); fail(e); }
  };
});

route('/complaints/:id', null, async (id) => {
  const c = await api(`/api/complaints/${id}`);
  const r = state.user.role;
  const idx = C_STEPS.indexOf(c.status);
  const hours = c.resolved_at ? Math.max(0.1, (Date.parse(c.resolved_at.replace(' ', 'T') + 'Z') - Date.parse(c.created_at.replace(' ', 'T') + 'Z')) / 3600000).toFixed(1) : null;
  view(`${header(`Complaint <code>${esc(c.ref_no)}</code>`, `${esc(cap(c.category))} &middot; ${esc(c.department)}`, `${r === 'citizen' ? '' : prio(c.priority)} ${badge(c.status)}`)}
    <div class="card p-3 mb-3"><div class="steps">${C_STEPS.map((s, i) => `<div class="step ${i <= idx ? 'done' : ''}"><div class="n">${i <= idx ? '<i class="bi bi-check" aria-label="done"></i>' : i + 1}</div><div>${s}</div></div>`).join('')}</div></div>
    <div class="row g-3"><div class="col-lg-7">
      <div class="card p-3 mb-3"><h2 class="h6 fw-bold">Details</h2><p class="mb-2">${esc(c.description)}</p>
        <dl class="row small mb-0"><dt class="col-sm-4">Location</dt><dd class="col-sm-8">${esc(c.location)}${c.latitude != null ? ` <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${Number(c.latitude)}&mlon=${Number(c.longitude)}#map=18/${Number(c.latitude)}/${Number(c.longitude)}">(map)</a>` : ''}</dd>
          <dt class="col-sm-4">Ward</dt><dd class="col-sm-8">${esc(c.ward || '-')}</dd>${r !== 'citizen' ? `<dt class="col-sm-4">Citizen</dt><dd class="col-sm-8">${esc(c.citizen)}</dd>` : ''}
          <dt class="col-sm-4">Assigned to</dt><dd class="col-sm-8">${esc(c.assignee || '-')}</dd>
          ${c.resolution_note ? `<dt class="col-sm-4">Resolution</dt><dd class="col-sm-8">${esc(c.resolution_note)}</dd>` : ''}
          ${hours ? `<dt class="col-sm-4">Resolution time</dt><dd class="col-sm-8">${hours} hours</dd>` : ''}</dl>
        ${r !== 'citizen' && c.ai_source ? `<div class="ai-chip mt-3 small"><i class="bi bi-stars"></i> AI triage (${esc(c.ai_source)}): <b>${esc(cap(c.ai_category))}</b>, ${esc(c.ai_priority)} priority${c.ai_summary ? ` - ${esc(c.ai_summary)}` : ''}</div>` : ''}
        <div class="mt-3">${[...c.photos.map(p => ['Photo', p]), ...c.proofs.map(p => ['Proof', p])].map(([l, p]) => `<button class="btn btn-sm btn-light me-1 mb-1" data-file="${p.id}"><i class="bi bi-image"></i> ${l}: ${esc(p.original_name)}</button>`).join('')}</div></div>
      <div class="card p-3" id="actions"></div>
    </div><div class="col-lg-5"><div class="card p-3"><h2 class="h6 fw-bold mb-3">Progress</h2><ul class="timeline">
      ${c.updates.map(u => `<li><span class="dot"></span><div class="d-flex justify-content-between gap-2"><b class="small">${esc(u.status)}</b><span class="small text-secondary">${when(u.created_at)}</span></div><div class="small text-secondary">${esc(u.remark || '')}${u.by_name ? ` &middot; ${esc(u.by_name)}` : ''}</div></li>`).join('')}</ul></div></div></div>`);
  document.querySelectorAll('[data-file]').forEach(b => b.onclick = () => openFile(b.dataset.file));
  const act = $('#actions');
  if (c.status === 'Resolved' || r === 'citizen') {
    act.innerHTML = c.status === 'Resolved' ? '<div class="small"><i class="bi bi-check2-circle" style="color:var(--ok)"></i> This complaint is resolved.</div>' : '<div class="small text-secondary">You will be notified by SMS/e-mail and in-app when the status changes.</div>';
    return;
  }
  const parts = [];
  if (['officer', 'admin'].includes(r)) {
    const staff = await api(`/api/staff${r === 'admin' ? `?department_id=${c.department_id}` : ''}`);
    parts.push(`<h2 class="h6 fw-bold">Assign to field staff</h2><div class="input-group mb-3"><label class="visually-hidden" for="staff">Field staff</label><select id="staff" class="form-select">${staff.map(s => `<option value="${s.id}">${esc(s.name)} (${s.open_tasks} open)</option>`).join('') || '<option value="">No field staff in this department</option>'}</select><button class="btn btn-primary" id="assign">Assign</button></div>
      <h2 class="h6 fw-bold">Wrong department?</h2><div class="input-group mb-3"><label class="visually-hidden" for="cat">Category</label><select id="cat" class="form-select">${Object.keys(CAT_ICON).map(k => `<option value="${k}" ${k === c.category ? 'selected' : ''}>${cap(k)}</option>`).join('')}</select><button class="btn btn-outline-primary" id="reroute">Re-route</button></div>`);
  }
  parts.push(`<h2 class="h6 fw-bold">Update progress</h2><label class="visually-hidden" for="remark">Remark</label><textarea id="remark" class="form-control mb-2" rows="2" maxlength="500" placeholder="Remark / resolution details"></textarea>
    <label class="form-label small" for="proof">Proof photo ${r === 'field' ? '(required to resolve)' : '(optional)'}</label><input id="proof" class="form-control mb-2" type="file" accept=".jpg,.jpeg,.png">
    <div class="d-flex gap-2 flex-wrap">${c.status !== 'In Progress' ? '<button class="btn btn-outline-primary" data-s="In Progress">Mark in progress</button>' : ''}<button class="btn btn-success" data-s="Resolved">Mark resolved</button></div>`);
  act.innerHTML = parts.join('');
  if ($('#assign')) $('#assign').onclick = async () => { try { await api(`/api/complaints/${c.id}/assign`, { method: 'POST', body: { field_staff_id: $('#staff').value } }); toast('Assigned and notified.'); render(); } catch (e) { fail(e); } };
  if ($('#reroute')) $('#reroute').onclick = async () => { try { await api(`/api/complaints/${c.id}/reroute`, { method: 'POST', body: { category: $('#cat').value } }); toast('Complaint re-routed.'); location.hash = '#/complaints'; } catch (e) { fail(e); } };
  act.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
    const form = new FormData(); form.append('status', b.dataset.s); form.append('remark', $('#remark').value);
    if ($('#proof').files[0]) form.append('photo', $('#proof').files[0]);
    busy(b, true);
    try { await api(`/api/complaints/${c.id}/update`, { method: 'POST', form }); toast(`Marked ${b.dataset.s.toLowerCase()}; citizen notified.`); render(); } catch (e) { busy(b, false); fail(e); }
  });
});

// ---------- M5: notifications ----------
route('/notifications', null, async () => {
  const rows = await api('/api/notifications');
  view(`${header('Notifications', 'Status changes, payment confirmations and announcements. Also sent by SMS and e-mail where configured.', '<button class="btn btn-outline-primary btn-sm" id="all">Mark all as read</button>')}
    <div class="card">${rows.length ? `<ul class="list-group list-group-flush">${rows.map(n => `<li class="list-group-item ${n.read ? '' : 'bg-light'}"><div class="d-flex justify-content-between gap-2"><b class="small">${n.read ? '' : '<span class="status s-info me-1">New</span>'}${esc(n.title)}</b><span class="small text-secondary text-nowrap">${when(n.created_at)}</span></div><div class="small">${esc(n.body)}</div><div class="text-secondary" style="font-size:.72rem">via ${esc(n.channels)}</div></li>`).join('')}</ul>` : empty('bell', 'No notifications')}</div>`);
  $('#all').onclick = async () => { await api('/api/notifications/read-all', { method: 'POST' }); render(); };
});

// ---------- profile ----------
route('/profile', null, async () => {
  const [me, docs] = await Promise.all([api('/api/me'), api('/api/documents')]);
  view(`${header('Profile', `${esc(ROLE_LABEL[me.role])}${me.department ? ' &middot; ' + esc(me.department) : ''}`)}
    <div class="row g-3"><div class="col-lg-6"><div class="card p-3 mb-3"><h2 class="h6 fw-bold">Personal details</h2><form id="pf">
      <div class="mb-2"><label class="form-label small" for="em">E-mail (login)</label><input class="form-control" id="em" value="${esc(me.email)}" disabled></div>
      <div class="mb-2"><label class="form-label small" for="name">Name</label><input class="form-control" id="name" value="${esc(me.name)}" required></div>
      <div class="mb-2"><label class="form-label small" for="mobile">Mobile</label><input class="form-control" id="mobile" value="${esc(me.mobile)}" maxlength="10" required></div>
      <div class="mb-3"><label class="form-label small" for="address">Address</label><input class="form-control" id="address" value="${esc(me.address || '')}"></div>
      <button class="btn btn-primary btn-sm">Save changes</button></form></div>
      <div class="card p-3"><h2 class="h6 fw-bold">Change password</h2><form id="pw"><label class="visually-hidden" for="cur">Current password</label><input class="form-control mb-2" type="password" id="cur" placeholder="Current password" autocomplete="current-password" required>
        <label class="visually-hidden" for="npw">New password</label><input class="form-control mb-2" type="password" id="npw" placeholder="New password (8+ chars, letter and number)" autocomplete="new-password" required><button class="btn btn-outline-primary btn-sm">Update password</button></form></div></div>
    <div class="col-lg-6"><div class="card p-3"><h2 class="h6 fw-bold">My documents</h2><p class="small text-secondary">Keep ID proof and other documents ready for applications.</p>
      <form id="df" class="row g-2 mb-3"><div class="col-sm-5"><label class="visually-hidden" for="label">Label</label><input class="form-control form-control-sm" id="label" placeholder="Label e.g. Aadhaar" maxlength="80"></div><div class="col-sm-7"><label class="visually-hidden" for="file">File</label><input class="form-control form-control-sm" id="file" type="file" accept=".pdf,.jpg,.jpeg,.png" required></div><div class="col-12"><button class="btn btn-sm btn-primary">Upload</button></div></form>
      ${docs.length ? docs.map(d => `<div class="d-flex justify-content-between align-items-center border-bottom py-2 gap-2"><span class="small text-break"><i class="bi bi-file-earmark"></i> <b>${esc(d.label)}</b> - ${esc(d.original_name)}</span><button class="btn btn-sm btn-light" data-file="${d.id}">View</button></div>`).join('') : empty('folder', 'No documents uploaded')}</div></div></div>`);
  document.querySelectorAll('[data-file]').forEach(b => b.onclick = () => openFile(b.dataset.file));
  $('#pf').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const u = await api('/api/me', { method: 'PUT', body: { name: $('#name').value, mobile: $('#mobile').value, address: $('#address').value } });
      state.user = { ...state.user, ...u }; try { localStorage.setItem('ccas_user', JSON.stringify(state.user)); } catch { /* ignore */ }
      toast('Profile updated.');
    } catch (e) { fail(e); }
  };
  $('#pw').onsubmit = async (ev) => { ev.preventDefault(); try { toast((await api('/api/me/password', { method: 'PUT', body: { current: $('#cur').value, password: $('#npw').value } })).message); ev.target.reset(); } catch (e) { fail(e); } };
  $('#df').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = new FormData(); form.append('label', $('#label').value || 'Document'); form.append('file', $('#file').files[0]);
    try { await api('/api/documents', { method: 'POST', form }); toast('Document uploaded.'); render(); } catch (e) { fail(e); }
  };
});

// ---------- AI assistant ----------
route('/assistant', ['citizen', 'officer', 'admin'], async () => {
  const health = await api('/api/health');
  if (!state.chat.length) state.chat.push({ role: 'assistant', content: `Namaste ${state.user.name.split(' ')[0]}! I am CCAS Sahayak. Ask me about services, fees, documents, property tax or the status of your requests.` });
  view(`${header('AI Assistant', `Runs fully on a local open-source model via Ollama (${esc(health.ai.model)}). ${health.ai.up ? '<span class="status s-ok">online</span>' : '<span class="status s-bad">offline</span>'}`)}
    <div class="chat mb-3" id="chat" role="log" aria-live="polite"></div>
    <div class="d-flex flex-wrap gap-2 mb-2">${['Which services can I apply for and what are the fees?', 'How much is the trade licence fee?', 'What is the status of my applications?', 'How is the late tax penalty calculated?'].map(s => `<button class="btn btn-sm btn-light" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <form id="cf" class="input-group"><label for="q" class="visually-hidden">Your question</label><input id="q" class="form-control" placeholder="Type your question..." maxlength="1000" autocomplete="off"><button class="btn btn-primary" id="send"><i class="bi bi-send"></i> Send</button></form>`);
  const draw = () => { const el = $('#chat'); if (!el) return; el.innerHTML = state.chat.map(m => `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}">${esc(m.content)}</div>`).join(''); el.scrollTop = el.scrollHeight; };
  draw();
  const ask = async (text) => {
    if (!text.trim()) return;
    state.chat.push({ role: 'user', content: text }); draw();
    $('#chat').insertAdjacentHTML('beforeend', '<div class="msg bot" id="typing"><span class="spinner-grow spinner-grow-sm"></span> thinking...</div>');
    $('#chat').scrollTop = $('#chat').scrollHeight;
    const btn = $('#send'); busy(btn, true, '...');
    try {
      const r = await api('/api/chat', { method: 'POST', body: { messages: state.chat.slice(1) } });
      state.chat.push({ role: 'assistant', content: r.reply });
    } catch (e) { state.chat.pop(); state.chat.push({ role: 'user', content: text }, { role: 'assistant', content: `(${e.message})` }); }
    if ($('#chat')) { draw(); busy(btn, false); }
  };
  $('#cf').onsubmit = (ev) => { ev.preventDefault(); const v = $('#q').value; $('#q').value = ''; ask(v); };
  document.querySelectorAll('[data-q]').forEach(b => b.onclick = () => ask(b.dataset.q));
});

// ---------- admin ----------
route('/admin/users', ['admin'], async () => {
  await loadLookups();
  const users = await api('/api/admin/users');
  view(`${header('Users & staff', 'Manage citizens, officers, field staff and administrators.', '<button class="btn btn-primary btn-sm" id="add"><i class="bi bi-person-plus"></i> Add employee</button>')}
    <div class="card p-3"><div class="table-responsive"><table class="table align-middle"><thead><tr><th>Name</th><th>E-mail</th><th>Role</th><th>Department</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
    ${users.map(u => `<tr><td>${esc(u.name)}</td><td class="small">${esc(u.email)}</td><td>${esc(ROLE_LABEL[u.role])}</td><td class="small">${esc(u.department || '-')}</td>
      <td>${u.locked ? badge('Locked') : u.active ? (u.verified ? badge('Active') : badge('Unverified')) : badge('Disabled')}</td>
      <td class="text-nowrap">${u.locked ? `<button class="btn btn-sm btn-outline-primary" data-unlock="${u.id}">Unlock</button> ` : ''}
        ${u.id !== state.user.id ? `<button class="btn btn-sm btn-light" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`);
  document.querySelectorAll('[data-unlock]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/users/${b.dataset.unlock}`, { method: 'PUT', body: { unlock: true } }); toast('Account unlocked.'); render(); } catch (e) { fail(e); } });
  document.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/users/${b.dataset.toggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }); render(); } catch (e) { fail(e); } });
  $('#add').onclick = () => {
    const m = openModal(`<form id="uf"><div class="modal-header"><h2 class="modal-title h5">Add employee</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body row g-2">
      <div class="col-12"><label class="form-label small" for="un">Name</label><input class="form-control" id="un" name="name" required></div>
      <div class="col-6"><label class="form-label small" for="ue">E-mail</label><input class="form-control" id="ue" name="email" type="email" required></div>
      <div class="col-6"><label class="form-label small" for="um">Mobile</label><input class="form-control" id="um" name="mobile" maxlength="10" required></div>
      <div class="col-6"><label class="form-label small" for="ur">Role</label><select class="form-select" id="ur" name="role"><option value="officer">Department Officer</option><option value="field">Field Staff</option><option value="admin">Administrator</option></select></div>
      <div class="col-6"><label class="form-label small" for="ud">Department</label><select class="form-select" id="ud" name="department_id">${state.depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div class="col-12"><label class="form-label small" for="up">Initial password</label><input class="form-control" id="up" name="password" type="text" required minlength="8"></div></div>
      <div class="modal-footer"><button class="btn btn-primary">Create</button></div></form>`);
    $('#uf', m).onsubmit = async (ev) => { ev.preventDefault(); try { await api('/api/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); closeModal(); toast('Employee created.'); render(); } catch (e) { fail(e); } };
  };
});

route('/admin/services', ['admin'], async () => {
  await loadLookups();
  const rows = await api('/api/admin/services');
  view(`${header('Services & fees', 'Add new municipal services and change fees or service-level targets without code changes.', '<button class="btn btn-primary btn-sm" id="add"><i class="bi bi-plus"></i> Add service</button>')}
    <div class="card p-3"><div class="table-responsive"><table class="table align-middle"><thead><tr><th>Code</th><th>Service</th><th>Department</th><th>Fee (Rs)</th><th>SLA days</th><th>Active</th><th><span class="visually-hidden">Save</span></th></tr></thead><tbody>
    ${rows.map(s => `<tr data-id="${s.id}"><td><code>${esc(s.code)}</code></td><td>${esc(s.name)}</td><td class="small">${esc(s.department)}</td>
      <td style="min-width:110px"><input class="form-control form-control-sm" type="number" min="0" value="${s.fee}" data-k="fee" aria-label="Fee for ${esc(s.name)}"></td>
      <td style="min-width:90px"><input class="form-control form-control-sm" type="number" min="1" value="${s.sla_days}" data-k="sla_days" aria-label="SLA days for ${esc(s.name)}"></td>
      <td><input class="form-check-input" type="checkbox" ${s.active ? 'checked' : ''} data-k="active" aria-label="${esc(s.name)} active"></td><td><button class="btn btn-sm btn-outline-primary" data-save>Save</button></td></tr>`).join('')}</tbody></table></div></div>`);
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const tr = b.closest('tr'), get = (k) => tr.querySelector(`[data-k="${k}"]`);
    try { await api(`/api/admin/services/${tr.dataset.id}`, { method: 'PUT', body: { fee: get('fee').value, sla_days: get('sla_days').value, active: get('active').checked } }); state.services = []; toast('Service updated.'); } catch (e) { fail(e); }
  });
  $('#add').onclick = () => {
    const m = openModal(`<form id="sf"><div class="modal-header"><h2 class="modal-title h5">Add service</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body row g-2">
      <div class="col-4"><label class="form-label small" for="sc">Code</label><input class="form-control" id="sc" name="code" maxlength="10" required></div>
      <div class="col-8"><label class="form-label small" for="sn">Name</label><input class="form-control" id="sn" name="name" required></div>
      <div class="col-12"><label class="form-label small" for="sd">Description</label><input class="form-control" id="sd" name="description"></div>
      <div class="col-12"><label class="form-label small" for="sdep">Department</label><select class="form-select" id="sdep" name="department_id">${state.depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div class="col-6"><label class="form-label small" for="sfee">Fee (Rs)</label><input class="form-control" id="sfee" name="fee" type="number" min="0" value="0"></div>
      <div class="col-6"><label class="form-label small" for="ssla">SLA (days)</label><input class="form-control" id="ssla" name="sla_days" type="number" min="1" value="7"></div>
      <div class="col-12"><label class="form-label small" for="sfl">Form fields (comma separated)</label><input class="form-control" id="sfl" name="fields" placeholder="Applicant name, Address, Purpose" required></div></div>
      <div class="modal-footer"><button class="btn btn-primary">Create</button></div></form>`);
    $('#sf', m).onsubmit = async (ev) => { ev.preventDefault(); try { await api('/api/admin/services', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); closeModal(); state.services = []; toast('Service added.'); render(); } catch (e) { fail(e); } };
  };
});

route('/admin/announcements', ['admin'], async () => {
  const rows = await api('/api/announcements');
  view(`${header('Announcements', 'Publish notices and service deadlines. All citizens are notified.')}
    <div class="row g-3"><div class="col-lg-5"><div class="card p-3"><form id="af"><label class="form-label small" for="t">Title</label><input class="form-control mb-2" id="t" name="title" required maxlength="150">
      <label class="form-label small" for="b">Message</label><textarea class="form-control mb-2" id="b" name="body" rows="3" required maxlength="1000"></textarea>
      <label class="form-label small" for="d">Deadline (optional)</label><input class="form-control mb-3" id="d" name="deadline" type="date"><button class="btn btn-primary">Publish</button></form></div></div>
    <div class="col-lg-7"><div class="card p-3">${rows.map(a => `<div class="d-flex justify-content-between border-bottom py-2 gap-2"><div><b class="small">${esc(a.title)}</b><div class="small text-secondary">${esc(a.body)}</div>${a.deadline ? `<div class="small">Deadline ${day(a.deadline)}</div>` : ''}</div><button class="btn btn-sm btn-light" data-del="${a.id}" aria-label="Delete ${esc(a.title)}"><i class="bi bi-trash"></i></button></div>`).join('') || empty('broadcast', 'No announcements')}</div></div></div>`);
  $('#af').onsubmit = async (ev) => { ev.preventDefault(); try { await api('/api/admin/announcements', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); toast('Announcement published.'); render(); } catch (e) { fail(e); } };
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/announcements/${b.dataset.del}`, { method: 'DELETE' }); render(); } catch (e) { fail(e); } });
});

route('/admin/settings', ['admin'], async () => {
  const s = await api('/api/admin/settings');
  const LABELS = { tax_rate_residential: 'Residential tax rate (fraction of annual value)', tax_rate_commercial: 'Commercial tax rate (fraction of annual value)', water_charge_per_sqft: 'Water charge (Rs per sq ft)', penalty_rate_monthly: 'Late penalty per month (fraction)', penalty_cap: 'Maximum penalty (fraction)' };
  view(`${header('Tax settings', 'Rates used for automatic tax and penalty calculation.')}
    <div class="card p-3" style="max-width:560px"><form id="sf">${Object.entries(s).map(([k, v]) => `<div class="mb-2"><label class="form-label small" for="${k}">${esc(LABELS[k] || k)}</label><input class="form-control" id="${k}" name="${k}" type="number" step="0.01" min="0" value="${esc(v)}"></div>`).join('')}
      <button class="btn btn-primary mt-2">Save</button></form></div>`);
  $('#sf').onsubmit = async (ev) => { ev.preventDefault(); try { await api('/api/admin/settings', { method: 'PUT', body: Object.fromEntries(new FormData(ev.target)) }); toast('Settings saved.'); } catch (e) { fail(e); } };
});

route('/admin/audit', ['admin'], async () => {
  const rows = await api('/api/admin/audit');
  view(`${header('Audit log', 'Every important action is time-stamped and linked to a user (latest 300).')}
    <div class="card p-3"><div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead><tbody>
    ${rows.map(a => `<tr><td class="small text-nowrap">${when(a.created_at)}</td><td class="small">${esc(a.user_name || '-')}${a.role ? ` <span class="text-secondary">(${esc(a.role)})</span>` : ''}</td><td><code>${esc(a.action)}</code></td><td class="small">${esc(a.entity || '')}${a.entity_id ? ' #' + a.entity_id : ''}</td><td class="small text-secondary text-break">${esc(a.detail || '')}</td></tr>`).join('')}</tbody></table></div></div>`);
});

render();
