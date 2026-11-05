// usage: npm run create-user -- <username> <password> [admin|staff]
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const [, , username, password, role = 'staff'] = process.argv;
if (!username || !password || !['admin', 'staff'].includes(role)) { console.error('usage: npm run create-user -- <username> <password> [admin|staff]'); process.exit(1); }
const file = process.env.DB_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'inventory.db');
const db = openDb(file);
db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role')
  .run(username.toLowerCase(), hashPassword(password), role);
console.log(`User "${username.toLowerCase()}" saved with role ${role}.`);
