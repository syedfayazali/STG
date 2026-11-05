import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

/** First start: create the administrator from ADMIN_USER / ADMIN_PASSWORD, or generate a one-time password. */
export function ensureAdmin(db) {
  if (db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) return;
  const username = (process.env.ADMIN_USER || 'admin').toLowerCase();
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)').run(username, hashPassword(password), 'admin');
  console.log('\n==============================================================');
  console.log(` Administrator account created`);
  console.log(`   username: ${username}`);
  console.log(`   password: ${generated ? password + '   (generated - save it now, it is shown only once)' : '(from ADMIN_PASSWORD)'}`);
  console.log('==============================================================\n');
}
