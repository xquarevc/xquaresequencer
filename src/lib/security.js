const crypto = require('crypto');
const config = require('../config');

const b64u = (b) => Buffer.from(b).toString('base64url');
const key32 = crypto.createHash('sha256').update('enc:' + config.secret).digest();
const sigKey = crypto.createHash('sha256').update('sig:' + config.secret).digest();

// ---- passwords (scrypt) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [v, saltHex, hashHex] = stored.split('$');
  if (v !== 's1') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const exp = Buffer.from(hashHex, 'hex');
  return exp.length === h.length && crypto.timingSafeEqual(h, exp);
}

// ---- signed tokens (HS256 JWT-like) ----
function sign(payload, ttlSec) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const data = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(body));
  return data + '.' + crypto.createHmac('sha256', sigKey).update(data).digest('base64url');
}
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const exp = crypto.createHmac('sha256', sigKey).update(parts[0] + '.' + parts[1]).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

// ---- AES-256-GCM for stored credentials ----
function encrypt(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key32, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
function decrypt(s) {
  if (!s) return null;
  const [v, iv, tag, enc] = s.split('.');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', key32, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

const randomToken = (n = 18) => crypto.randomBytes(n).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- tiny in-memory rate limiter ----
const buckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const k = name + ':' + (req.ip || '');
    const t = Date.now();
    let b = buckets.get(k);
    if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(k, b); }
    if (++b.n > max) return res.status(429).json({ error: 'Too many requests, slow down.' });
    next();
  };
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

module.exports = { hashPassword, verifyPassword, sign, verify, encrypt, decrypt, randomToken, sha256, rateLimit };
