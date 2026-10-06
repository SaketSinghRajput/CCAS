# CCAS — City Corporation Automation System (Prototype)

Working prototype of the system specified in `docs/` (SRS, SE case-study report, design blueprint).
One web portal where **citizens** apply for certificates/licences, pay property tax, lodge complaints and track
everything; **department officers** verify and decide; **field staff** resolve complaints with photo proof;
**administrators** manage users, services, fees and see analytics.

AI features (SRS §6.2 complaint classification, §6.4 chatbot) run **locally on Ollama** with a free open-source
model — no paid/external LLM.

## Run

Requirements: Node.js ≥ 22.13 (uses built-in `node:sqlite`), Ollama with `qwen2.5:7b` (optional — the app falls back to keyword rules if Ollama is down).

```bash
ollama pull qwen2.5:7b      # once
npm install
npm start                   # http://localhost:3000
npm test                    # API tests incl. report test cases TC01–TC06 + live Ollama check
```

`npm run reset` deletes `data/` and starts with fresh demo data.
Env: `PORT`, `OLLAMA_URL` (default `http://127.0.0.1:11434`), `OLLAMA_MODEL` (default `qwen2.5:7b`), `JWT_SECRET`, `CCAS_DEMO_OTP=0` to hide OTPs in the UI.

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
src/db.js          Data: SQLite schema (3NF, FKs), seed data; data/uploads = protected file store
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
escaping in the UI, server-side RBAC and ownership checks, upload type/size validation (PDF/JPG/PNG ≤ 5 MB),
files served only to authorised users, CSV-injection-safe exports, audit trail.

## Prototype simplifications

| Spec | Prototype | Upgrade path |
|---|---|---|
| MySQL 8 | SQLite (`node:sqlite`), same SQL schema | swap `db.js` to `mysql2` |
| bcrypt | scrypt (Node stdlib, equivalent salted KDF) | — |
| Payment gateway | sandbox modal calling `/api/payments/:txn/confirm` | gateway webhook with signature check |
| SMS / e-mail | logged to console + in-app; OTP shown on screen in demo mode | provider call in `notify()` |
| PDF certificate | printable HTML (Print → Save as PDF) with a real QR code | server-side PDF if needed |
| HTTPS | HTTP on localhost | TLS at Nginx (report §5.4) |

## Testing

- `npm test` — API/integration tests: TC01 login, TC02 lockout, TC03 duplicate registration, TC04 application ID,
  TC05 file type/size rejection, TC06 penalty (unit + API), certificate workflow, RBAC, complaint lifecycle,
  payment failure/retry/double-payment, admin functions, JWT tampering, live Ollama classification.
- A browser E2E pass (Playwright, every role through the real UI: 22 scenarios incl. live AI and 390 px mobile layout)
  was run during development.
