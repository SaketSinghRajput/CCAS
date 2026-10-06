// Connects the live CCAS site to the Ollama running on this PC.
// 1) a local gateway on 127.0.0.1:11435 that only forwards GET /api/tags and POST /api/chat, and only with the shared key
// 2) a free Cloudflare quick tunnel (no account) pointing at that gateway
// 3) registers the tunnel URL with the live site, so no redeploy is needed when the URL changes.
// Run: npm run ai-tunnel   (needs .env.ai with CCAS_AI_KEY and CCAS_SITE_URL; keep this window open)
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { bin, install, Tunnel } from 'cloudflared';

const KEY = process.env.CCAS_AI_KEY;
const SITE = (process.env.CCAS_SITE_URL || '').replace(/\/+$/, '');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const PORT = 11435;
if (!KEY || KEY.length < 16 || !SITE) {
  console.error('Missing config: create .env.ai with CCAS_AI_KEY (16+ chars, same as on Vercel) and CCAS_SITE_URL.');
  process.exit(1);
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ALLOWED = new Set(['GET /api/tags', 'POST /api/chat']);

const gateway = http.createServer((req, res) => {
  if (!ALLOWED.has(`${req.method} ${req.url}`) || !safeEqual(req.headers['x-ccas-key'], KEY)) return res.writeHead(403).end();
  const up = http.request(OLLAMA + req.url, { method: req.method, headers: { 'content-type': 'application/json' } }, (r) => {
    res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json' });
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `Ollama not reachable: ${e.message}` })); });
  req.pipe(up);
});

async function register(url) {
  for (let i = 1; i <= 10; i++) {
    try {
      const r = await fetch(`${SITE}/api/ai/endpoint`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ccas-key': KEY }, body: JSON.stringify({ url }) });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.ai?.up) return console.log(`Live site now uses this PC's Ollama (${body.ai.model}). Keep this window open.`);
      console.log(`  registering (attempt ${i}): ${r.status} ${body.error || (body.ai?.up === false ? 'site cannot reach tunnel yet' : '')}`);
    } catch (e) { console.log(`  registering (attempt ${i}): ${e.message}`); }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.error('Could not register the tunnel with the live site. Check CCAS_SITE_URL and that CCAS_AI_KEY matches Vercel.');
}

gateway.listen(PORT, '127.0.0.1', async () => {
  console.log(`Gateway on http://127.0.0.1:${PORT} -> ${OLLAMA}`);
  // warm the model so the first citizen request is fast
  fetch(`${OLLAMA}/api/chat`, { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: false, keep_alive: '30m' }) })
    .then(() => console.log(`Model ${MODEL} loaded.`)).catch((e) => console.error(`Ollama not reachable at ${OLLAMA}: ${e.message}`));
  if (!fs.existsSync(bin)) { console.log('Downloading cloudflared (one time)...'); await install(bin); }
  const tunnel = Tunnel.quick(`http://127.0.0.1:${PORT}`);
  const url = await new Promise((resolve) => tunnel.once('url', resolve));
  console.log(`Tunnel: ${url}`);
  await new Promise((resolve) => tunnel.once('connected', resolve));
  await register(url);
  tunnel.on('exit', (code) => { console.log(`Tunnel closed (${code}). The site falls back to keyword rules until you run this again.`); process.exit(0); });
  process.on('SIGINT', () => tunnel.stop());
});
