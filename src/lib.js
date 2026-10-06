import crypto from 'node:crypto';

// ---------- Passwords: salted scrypt (stdlib; same role as bcrypt in the report) ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

// ---------- JWT (HS256) ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function signJwt(payload, secret, ttlSec = 8 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iat: now, exp: now + ttlSec });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export function verifyJwt(token, secret) {
  const [head, body, sig] = String(token).split('.');
  if (!sig) return null;
  const good = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() / 1000 ? p : null;
}

// ---------- Business rules ----------
export const refNo = (prefix) =>
  `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
export const otp = () => String(crypto.randomInt(100000, 1000000));

/** Penalty = rate per started month after due date, capped. (TC06) */
export function penaltyFor(principal, dueDate, { rate = 0.02, cap = 0.24, today = new Date() } = {}) {
  const due = new Date(`${dueDate}T23:59:59`);
  if (today <= due) return 0;
  const months = (today.getFullYear() - due.getFullYear()) * 12 + (today.getMonth() - due.getMonth())
    + (today.getDate() > due.getDate() ? 1 : 0);
  return Math.round(principal * Math.min(Math.max(months, 1) * rate, cap) * 100) / 100;
}

export const MOBILE_RULE = /^[6-9]\d{9}$/;
export const EMAIL_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- AI via local Ollama (free, open-source models only) ----------
export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
// Shared secret for the local AI gateway (scripts/ai-tunnel.js) when Ollama is reached through a tunnel.
const aiHeaders = () => (process.env.CCAS_AI_KEY ? { 'x-ccas-key': process.env.CCAS_AI_KEY } : {});

export const COMPLAINT_CATEGORIES = {
  roads: 'ROAD', drainage: 'DRN', garbage: 'SAN', streetlight: 'ELEC', water: 'WTR', other: 'GEN',
};

async function ollamaChat(messages, { url = OLLAMA_URL, format, timeoutMs = 50000, temperature = 0.2 } = {}) {
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...aiHeaders() },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false, format, options: { temperature }, keep_alive: '30m' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).message.content;
}

const KEYWORDS = {
  streetlight: /street ?light|lamp ?post|light pole|bulb|lights? (is |are )?not working|dark street/i,
  drainage: /drain|sewer|sewage|manhole|gutter|waterlog|flood|overflow|clog/i,
  garbage: /garbage|trash|waste|dustbin|litter|dump|rubbish|stink|dead animal/i,
  water: /water|tap|pipeline|leak|supply|contaminat|pressure|borewell/i,
  roads: /pothole|road|footpath|pavement|speed ?breaker|asphalt/i,
};
export function keywordClassify(text) {
  for (const [cat, re] of Object.entries(KEYWORDS)) if (re.test(text)) return cat;
  return 'other';
}

/** AI-based complaint classification (SRS 6.2). Falls back to keywords if Ollama is down. */
export async function classifyComplaint(text, { url } = {}) {
  const schema = {
    type: 'object',
    properties: {
      category: { type: 'string', enum: Object.keys(COMPLAINT_CATEGORIES) },
      priority: { type: 'string', enum: ['Low', 'Medium', 'High'] },
      summary: { type: 'string' },
    },
    required: ['category', 'priority', 'summary'],
  };
  try {
    const out = JSON.parse(await ollamaChat([
      { role: 'system', content:
        'You triage citizen complaints for an Indian city corporation. Choose exactly one category: ' +
        'roads (potholes, damaged roads, footpaths), drainage (blocked drains, sewage, waterlogging), ' +
        'garbage (uncollected waste, dumping, dead animals), streetlight (non-working street lights/poles), ' +
        'water (drinking water supply, pipe leaks, contamination), other. ' +
        'Priority High = safety/health hazard or affects many people; Low = cosmetic. Summary: max 12 words. Reply as JSON.' },
      { role: 'user', content: text.slice(0, 2000) },
    ], { url, format: schema, timeoutMs: 45000, temperature: 0 }));
    if (!COMPLAINT_CATEGORIES[out.category]) throw new Error('bad category');
    return {
      category: out.category,
      priority: ['Low', 'Medium', 'High'].includes(out.priority) ? out.priority : 'Medium',
      summary: String(out.summary || '').slice(0, 200),
      source: `ollama:${OLLAMA_MODEL}`,
    };
  } catch (e) {
    return { category: keywordClassify(text), priority: 'Medium', summary: '', source: 'keyword-fallback', error: e.message };
  }
}

/** Citizen help chatbot (SRS 6.4), grounded on live service data. */
export async function chatbotReply(history, context, { url } = {}) {
  const system =
    'You are "CCAS Sahayak", the help assistant of the City Corporation Automation System. ' +
    'Answer briefly (max 120 words) and only about municipal services. Use ONLY the facts below; ' +
    'if unsure, tell the citizen to contact the ward office. Never invent fees, dates or reference numbers.\n\n' +
    `FACTS:\n${context}\n\nHow-to: Apply = Services > Apply. Complaints = Complaints > Lodge complaint (photo optional, max 5 MB). ` +
    'Property tax = Property Tax > Pay. Track status = My Applications / Complaints. Certificates can be downloaded after approval and carry a QR code.';
  return ollamaChat([{ role: 'system', content: system }, ...history.slice(-8)], { url, temperature: 0.3, timeoutMs: 50000 });
}

export async function ollamaHealth(url = OLLAMA_URL) {
  try {
    const r = await fetch(`${url}/api/tags`, { headers: aiHeaders(), signal: AbortSignal.timeout(5000) });
    const models = (await r.json()).models.map(m => m.name);
    return { up: true, model: OLLAMA_MODEL, modelInstalled: models.includes(OLLAMA_MODEL) };
  } catch { return { up: false, model: OLLAMA_MODEL, modelInstalled: false }; }
}
