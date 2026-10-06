// Wipes all data and re-seeds the demo records (keeps the registered AI tunnel URL).
// Live:  npm run reset:live   (uses .env.turso)      Local: npm run reset
import { openDb } from '../src/db.js';

const TABLES = ['audit_logs', 'notifications', 'payments', 'complaint_updates', 'complaints', 'documents', 'application_history',
  'applications', 'tax_bills', 'properties', 'announcements', 'services', 'users', 'wards', 'departments', 'settings'];

const db = openDb();
const ai = await db.one("SELECT value FROM settings WHERE key = 'ai_url'").catch(() => null);
await db.tx(async (t) => { for (const name of TABLES) await t.run(`DROP TABLE IF EXISTS ${name}`); });
db.close();

const fresh = openDb();
await fresh.ready();
if (ai) await fresh.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'ai_url', ai.value);
const c = await fresh.one('SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM applications) applications, (SELECT COUNT(*) FROM complaints) complaints');
console.log('Reset complete:', c, ai ? '(AI endpoint kept)' : '');
fresh.close();
