// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json); static files come from public/.
import { createApp } from '../src/server.js';

export default createApp();
