# CCAS — City Corporation Automation System (Prototype)

Working prototype of the system specified in `docs/` (SRS, SE case-study report, design blueprint).
One web portal where **citizens** apply for certificates/licences, pay property tax, lodge complaints and track
everything; **department officers** verify and decide; **field staff** resolve complaints with photo proof;
**administrators** manage users, services, fees and see analytics.

AI features (SRS §6.2 complaint classification, §6.4 chatbot) run **locally on Ollama** with a free open-source
model — no paid/external LLM.

**Live site:** https://ccas-city-corporation.vercel.app — Vercel (free Hobby) + Turso (free hosted SQLite, Mumbai).

## Setup

### 1. Prerequisites

| Tool | Version | Get it |
|---|---|---|
| Node.js | 22 or newer (includes npm) | https://nodejs.org |
| Ollama *(optional, for AI)* | latest | https://ollama.com/download |
| Git *(optional)* | any | https://git-scm.com |

Check: `node -v` should print `v22.x` or higher.

### 2. Run locally

```bash
cd "G:/collage/SEM 5/SE/project"     # the project folder
npm install                          # install dependencies (once)
ollama pull qwen2.5:7b               # download the AI model (once, ~4.7 GB) — optional
npm start                            # open http://localhost:3000
```

- The first start creates `data/ccas.db` and fills it with demo data — no database setup needed.
- If Ollama is not running, the app still works: complaints are routed by keyword rules and the chatbot shows "offline".
- `npm run reset` wipes `data/` and starts again with fresh demo data.
- `npm test` runs the API test suite (report test cases TC01–TC06 and more).

Optional environment variables: `PORT` (default 3000), `OLLAMA_URL` (default `http://127.0.0.1:11434`),
`OLLAMA_MODEL` (default `qwen2.5:7b`), `JWT_SECRET`, `CCAS_MAX_UPLOAD_MB` (default 5), `CCAS_DEMO_OTP=0` (hide OTPs in the UI).

### 3. Deploy to Vercel (free) with a Turso database

Vercel has no permanent disk, so the live site stores data (including uploaded files) in **Turso**, a free hosted SQLite.

**a) Create the Turso database**
1. Sign up at https://app.turso.tech (GitHub login works).
2. **Create Database** → name `ccas` → location **AWS ap-south-1 (Mumbai)**.
3. Open the database → copy its **URL** (`libsql://ccas-<you>.….turso.io`).
4. **Create Token** → Expiration *Never*, Access *Read & Write* → copy the token (shown only once).
5. Save both in a file `.env.turso` in the project folder (it is git-ignored):
   ```
   TURSO_DATABASE_URL=libsql://ccas-<you>.aws-ap-south-1.turso.io
   TURSO_AUTH_TOKEN=<token>
   ```
6. Create the tables and demo data: `npm run reset:live`

**b) Create the Vercel project**
```bash
npm i -g vercel                # Vercel CLI
vercel login                   # opens a browser to sign in (free Hobby account)
vercel link --yes --project ccas-city-corporation
```

**c) Add the environment variables** (Vercel dashboard → Project → Settings → Environment Variables, for *Production*, or `vercel env add NAME production`):

| Name | Value |
|---|---|
| `TURSO_DATABASE_URL` | from `.env.turso` |
| `TURSO_AUTH_TOKEN` | from `.env.turso` |
| `JWT_SECRET` | any long random string, e.g. output of `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CCAS_AI_KEY` | another long random string (shared with the AI tunnel, step 4) |
| `CCAS_MAX_UPLOAD_MB` | `4` (Vercel rejects requests over 4.5 MB) |

**d) Deploy**
```bash
vercel deploy --prod
```
Open the printed URL and log in with a demo account. `vercel.json` sends `/api/*` to the Express app (`api/index.js`) and serves `public/`
as static files; `.vercelignore` keeps `docs/`, tests and secrets out of the upload.

### 4. Turn on AI for the live site (Ollama tunnel)

Vercel cannot reach `localhost`, so the live site uses **your PC's Ollama** through a free Cloudflare tunnel.

1. Copy `.env.ai.example` to `.env.ai` and fill it in (git-ignored):
   ```
   CCAS_AI_KEY=<the same value as CCAS_AI_KEY on Vercel>
   CCAS_SITE_URL=https://ccas-city-corporation.vercel.app
   ```
2. Make sure Ollama is running (`ollama list` shows `qwen2.5:7b`).
3. Run and **keep the window open**:
   ```bash
   npm run ai-tunnel
   ```
   It prints `Live site now uses this PC's Ollama` — the AI badge on the live *AI Assistant* page turns **online**.

The tunnel downloads `cloudflared` automatically the first time (no Cloudflare account needed). Its URL changes on every run;
the script re-registers it with the site, so no redeploy is needed. The local gateway only forwards `GET /api/tags` and
`POST /api/chat`, and only with the shared `CCAS_AI_KEY`. When the tunnel is closed, the site falls back to keyword rules.

### 5. Everyday commands

| Task | Command |
|---|---|
| Run locally | `npm start` |
| Run tests | `npm test` |
| Reset local demo data | `npm run reset` |
| Redeploy after code changes | `vercel deploy --prod` |
| Turn on AI for the live site | `npm run ai-tunnel` |
| Reset live demo data (e.g. after a presentation) | `npm run reset:live` |

### Troubleshooting

- **AI shows "offline" on the live site** → run `npm run ai-tunnel` and check `ollama list`; `CCAS_AI_KEY` in `.env.ai` must match Vercel.
- **"Something went wrong" on the live site right after deploying** → check the Turso variables on Vercel, then `vercel logs ccas-city-corporation.vercel.app`.
- **Changed an environment variable on Vercel** → redeploy (`vercel deploy --prod`); variables apply to new deployments only.
- **Port 3000 in use locally** → `PORT=3001 npm start` (PowerShell: `$env:PORT=3001; npm start`).

### Demo logins (password `Demo@1234`)

| Role | Email |
|---|---|
| Citizen | `citizen@ccas.gov` |
| Officer (Registration) | `officer@ccas.gov` |
| Officer (Roads) | `works.officer@ccas.gov` |
| Field staff | `field@ccas.gov` |
| Admin | `admin@ccas.gov` |

Also seeded: `citizen2@ccas.gov` (citizen), `revenue.officer@ccas.gov` (Revenue officer), `field2@ccas.gov` (Sanitation field staff).

Suggested demo: citizen applies for a Birth Certificate → pays fee → officer verifies and approves →
citizen downloads the QR certificate → open the QR link (public verification page).
Then citizen lodges "pothole on Station Road" → AI routes it to Roads → `works.officer` assigns → `field`
resolves with a photo → citizen sees the timeline. The admin dashboard reflects all of it.

## Architecture (report §6.1, three layers)

```
public/            Presentation: Bootstrap 5 SPA (citizen portal, officer/field dashboards, admin console)
src/server.js      Application: Express REST/JSON API — auth+RBAC, modules M1–M6, payments, reports, AI
src/lib.js         Business rules: scrypt hashing, JWT, penalty calc, Ollama classifier + chatbot
src/db.js          Data: libSQL (SQLite/Turso) schema (3NF, FKs), seed data; documents stored as BLOBs
```

| Report module | Implemented |
|---|---|
| M1 User & Access | Register with OTP, login, 5-strike lockout, password reset, RBAC on every request, profile + document vault |
| M2 Certificates & Licences | 7 services (birth, death, residence, trade licence, building plan, garbage pickup, water connection), dynamic forms, uploads, verify/approve/reject/return-with-remarks, resubmission, certificate with QR + public verification |
| M3 Property Tax & Payment | Property register, automatic tax + water charge, 2%/month penalty (capped 24%), sandbox gateway (success/failure), bill marked paid only after confirmation, double-payment guard, receipts |
| M4 Complaints | Category, description, location, ward, GPS, photo; **AI classification & priority** → department routing; officer assigns/re-routes; field staff updates with mandatory proof photo; resolution time |
| M5 Notifications | In-app notification on every state change (e-mail/SMS simulated in server log), announcements with deadlines |
| M6 Reports & Dashboard | Role dashboards; admin analytics (category, ward hotspots, service usage, department load, revenue, SLA breaches, AI agreement); CSV exports; audit log |

Security (report §9.2): salted scrypt password hashes, signed expiring JWTs, parameterised SQL only, output
escaping in the UI, server-side RBAC and ownership checks, upload type/size validation (PDF/JPG/PNG ≤ 5 MB; 4 MB on Vercel),
files served only to authorised users, CSV-injection-safe exports, audit trail.

## Prototype simplifications

| Spec | Prototype | Upgrade path |
|---|---|---|
| MySQL 8 | libSQL: local SQLite file in dev, Turso in production; uploads stored as BLOBs | swap `db.js` to `mysql2` |
| bcrypt | scrypt (Node stdlib, equivalent salted KDF) | — |
| Payment gateway | sandbox modal calling `/api/payments/:txn/confirm` | gateway webhook with signature check |
| SMS / e-mail | logged to console + in-app; OTP shown on screen in demo mode | provider call in `notify()` |
| PDF certificate | printable HTML (Print → Save as PDF) with a real QR code | server-side PDF if needed |
| HTTPS | HTTP on localhost; HTTPS on the Vercel deployment | TLS at Nginx for self-hosting (report §5.4) |

## Testing

- `npm test` — API/integration tests: TC01 login, TC02 lockout, TC03 duplicate registration, TC04 application ID,
  TC05 file type/size rejection, TC06 penalty (unit + API), certificate workflow, RBAC, complaint lifecycle,
  payment failure/retry/double-payment, admin functions, JWT tampering, live Ollama classification.
- A browser E2E pass (Playwright, every role through the real UI: 22 scenarios incl. live AI and 390 px mobile layout)
  was run during development.
