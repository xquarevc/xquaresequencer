const { one, run, now } = require('../db');
const sec = require('./security');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Not found') => new HttpError(404, what);

const COOKIE = 'xs_session';
const SESSION_TTL = 14 * 86400;
function setSession(res, user) {
  const token = sec.sign({ uid: user.id }, SESSION_TTL);
  const secure = require('../config').baseUrl.startsWith('https');
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}`);
}
const clearSession = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

/** Auth via session cookie (CSRF-guarded by custom header) or `Authorization: Bearer xs_...` API key. */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const key = one('SELECT * FROM api_keys WHERE key_hash=?', sec.sha256(h.slice(7).trim()));
    if (!key) return res.status(401).json({ error: 'Invalid API key' });
    run('UPDATE api_keys SET last_used_at=? WHERE id=?', now(), key.id);
    req.user = one('SELECT * FROM users WHERE id=?', key.user_id); req.viaApiKey = true;
  } else {
    const p = sec.verify(parseCookies(req)[COOKIE]);
    if (!p) return res.status(401).json({ error: 'Not authenticated' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'xs')
      return res.status(403).json({ error: 'Missing CSRF header' });
    req.user = one('SELECT * FROM users WHERE id=?', p.uid);
  }
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }));

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, balance_micros: u.balance_micros, has_password: !!u.password_hash, google: !!u.google_id, microsoft: !!u.microsoft_id, created_at: u.created_at });

/** Throws 404 unless the row belongs to the user. */
function owned(table, id, userId) {
  const row = one(`SELECT * FROM ${table} WHERE id=? AND user_id=?`, +id, userId);
  if (!row) throw notFound();
  return row;
}
module.exports = { wrap, HttpError, bad, notFound, auth, adminOnly, setSession, clearSession, publicUser, owned, parseCookies };
