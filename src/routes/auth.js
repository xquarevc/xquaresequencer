const express = require('express');
const config = require('../config');
const { one, all, run, tx, now } = require('../db');
const sec = require('../lib/security');
const { wrap, bad, auth, setSession, clearSession, publicUser, parseCookies } = require('../lib/http');
const { log } = require('../lib/activity');
const wallet = require('../lib/wallet');
const oauth = require('../services/oauth');
const mailer = require('../services/mailer');

const r = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function createUser({ email, name, password, googleId, microsoftId }) {
  return tx(() => {
    const first = one('SELECT COUNT(*) n FROM users').n === 0;
    const res = run('INSERT INTO users (email,name,password_hash,google_id,microsoft_id,role,created_at) VALUES (?,?,?,?,?,?,?)',
      email.toLowerCase(), name || email.split('@')[0], password ? sec.hashPassword(password) : null, googleId ?? null, microsoftId ?? null, first ? 'admin' : 'user', now());
    const id = Number(res.lastInsertRowid);
    if (config.price.signupBonus > 0) wallet.credit(id, config.price.signupBonus, 'Welcome bonus', 'signup');
    return one('SELECT * FROM users WHERE id=?', id);
  });
}

r.get('/config', (req, res) => res.json({
  oauth: { google: oauth.enabled('google'), microsoft: oauth.enabled('microsoft') },
  payments: require('../services/payments').providerName(), sendMode: config.sendMode,
  pricing: config.price,
}));

r.post('/signup', sec.rateLimit('signup', 10, 3600000), wrap(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!EMAIL_RE.test(email || '')) throw bad('Enter a valid email address');
  if (typeof password !== 'string' || password.length < 8) throw bad('Password must be at least 8 characters');
  if (one('SELECT 1 x FROM users WHERE email=?', email)) throw bad('An account with this email already exists');
  const u = createUser({ email, name: String(name || '').slice(0, 80), password });
  log(u.id, 'user.signup', 'user', u.id, null, req.ip);
  setSession(res, u);
  res.json({ user: publicUser(u) });
}));

r.post('/login', sec.rateLimit('login', 20, 900000), wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const u = one('SELECT * FROM users WHERE email=?', String(email || ''));
  if (!u || !sec.verifyPassword(String(password || ''), u.password_hash)) {
    if (u) log(u.id, 'user.login_failed', 'user', u.id, null, req.ip);
    throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  }
  run('UPDATE users SET last_login_at=? WHERE id=?', now(), u.id);
  log(u.id, 'user.login', 'user', u.id, null, req.ip);
  setSession(res, u);
  res.json({ user: publicUser(u) });
}));

r.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
r.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

r.patch('/me', auth, wrap(async (req, res) => {
  const { name } = req.body || {};
  if (typeof name === 'string') run('UPDATE users SET name=? WHERE id=?', name.slice(0, 80), req.user.id);
  log(req.user.id, 'user.profile_updated', 'user', req.user.id, null, req.ip);
  res.json({ user: publicUser(one('SELECT * FROM users WHERE id=?', req.user.id)) });
}));

r.post('/me/password', auth, sec.rateLimit('pw', 10, 900000), wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (typeof next !== 'string' || next.length < 8) throw bad('New password must be at least 8 characters');
  if (req.user.password_hash && !sec.verifyPassword(String(current || ''), req.user.password_hash)) throw bad('Current password is incorrect');
  run('UPDATE users SET password_hash=? WHERE id=?', sec.hashPassword(next), req.user.id);
  log(req.user.id, 'user.password_changed', 'user', req.user.id, null, req.ip);
  res.json({ ok: true });
}));

// Permanently delete the account and all associated data.
r.delete('/me', auth, sec.rateLimit('del', 5, 900000), wrap(async (req, res) => {
  const { password, confirm } = req.body || {};
  if (confirm !== req.user.email) throw bad('Type your email address to confirm deletion');
  if (req.user.password_hash && !sec.verifyPassword(String(password || ''), req.user.password_hash)) throw bad('Password is incorrect');
  if (req.user.role === 'admin' && one("SELECT COUNT(*) n FROM users WHERE role='admin'").n === 1 && one('SELECT COUNT(*) n FROM users').n > 1)
    throw bad('You are the only admin. Promote another admin before deleting this account.');
  log(null, 'user.deleted', 'user', req.user.id, req.user.email, req.ip);
  run('DELETE FROM users WHERE id=?', req.user.id);
  clearSession(res);
  res.json({ ok: true });
}));

// ---- API keys ----
r.get('/api-keys', auth, (req, res) => res.json({ keys: all('SELECT id,name,prefix,created_at,last_used_at FROM api_keys WHERE user_id=? ORDER BY id DESC', req.user.id) }));
r.post('/api-keys', auth, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) throw bad('Name is required');
  if (req.viaApiKey) throw bad('Create keys from the dashboard session');
  const key = 'xs_' + sec.randomToken(30);
  const id = run('INSERT INTO api_keys (user_id,name,prefix,key_hash,created_at) VALUES (?,?,?,?,?)', req.user.id, name, key.slice(0, 8), sec.sha256(key), now()).lastInsertRowid;
  log(req.user.id, 'apikey.created', 'api_key', Number(id), name, req.ip);
  res.json({ id: Number(id), key }); // shown once
}));
r.delete('/api-keys/:id', auth, wrap(async (req, res) => {
  run('DELETE FROM api_keys WHERE id=? AND user_id=?', +req.params.id, req.user.id);
  log(req.user.id, 'apikey.deleted', 'api_key', +req.params.id, null, req.ip);
  res.json({ ok: true });
}));

// ---- OAuth: login + mailbox connect ----
const ok = (p) => { if (!oauth.enabled(p)) throw bad(`${p} OAuth is not configured on this server`); };
r.get('/oauth/:provider/login', wrap(async (req, res) => {
  ok(req.params.provider);
  res.redirect(oauth.authUrl(req.params.provider, 'login'));
}));
r.get('/oauth/:provider/connect-mailbox', auth, wrap(async (req, res) => {
  ok(req.params.provider);
  res.json({ url: oauth.authUrl(req.params.provider, 'mailbox', req.user.id, req.query.email) });
}));

r.get('/oauth/:provider/callback', wrap(async (req, res) => {
  const provider = req.params.provider;
  ok(provider);
  const st = oauth.parseState(String(req.query.state || ''));
  const fail = (m, to = '/') => res.redirect(`${to}#/login?error=${encodeURIComponent(m)}`);
  if (!st || st.p !== provider) return fail('Invalid or expired OAuth state');
  if (req.query.error) return fail(String(req.query.error_description || req.query.error), st.purpose === 'mailbox' ? '/#/mailboxes' : '/');
  try {
    const tok = await oauth.exchangeCode(provider, String(req.query.code));
    const info = await oauth.userinfo(provider, tok.access_token);
    const email = String(info.email || '').toLowerCase();
    if (!email) throw new Error('Provider did not return an email address');

    if (st.purpose === 'login') {
      if (info.email_verified === false) throw new Error('Email address is not verified with the provider');
      const col = provider === 'google' ? 'google_id' : 'microsoft_id';
      let u = one(`SELECT * FROM users WHERE ${col}=?`, info.sub);
      if (!u) {
        // Only link to an existing password account when the provider vouches for the email (prevents account takeover).
        const byEmail = one('SELECT * FROM users WHERE email=?', email);
        if (byEmail && !(provider === 'google' && info.email_verified === true))
          throw new Error('An account with this email exists. Sign in with your password, then connect the provider.');
        u = byEmail;
      }
      if (!u) u = createUser({ email, name: info.name, [provider === 'google' ? 'googleId' : 'microsoftId']: info.sub });
      else if (!u[col]) run(`UPDATE users SET ${col}=? WHERE id=?`, info.sub, u.id);
      run('UPDATE users SET last_login_at=? WHERE id=?', now(), u.id);
      log(u.id, `user.login_${provider}`, 'user', u.id, null, req.ip);
      setSession(res, u);
      return res.redirect('/#/dashboard');
    }

    // purpose === 'mailbox'
    const user = one('SELECT * FROM users WHERE id=?', st.uid);
    if (!user) throw new Error('User not found');
    if (!tok.refresh_token) throw new Error('No refresh token returned. Remove the app from your account permissions and try again.');
    const preset = mailer.PRESETS[provider];
    const exp = now() + (tok.expires_in || 3600) * 1000;
    const existing = one('SELECT id FROM mailboxes WHERE user_id=? AND email=?', user.id, email);
    let id;
    if (existing) {
      id = existing.id;
      run("UPDATE mailboxes SET provider=?, oauth_refresh_enc=?, oauth_access_enc=?, oauth_expires_at=?, status='active', last_error=NULL WHERE id=?", provider, sec.encrypt(tok.refresh_token), sec.encrypt(tok.access_token), exp, id);
    } else {
      id = Number(run(`INSERT INTO mailboxes (user_id,email,from_name,provider,smtp_host,smtp_port,smtp_secure,smtp_user,imap_host,imap_port,imap_secure,imap_user,oauth_refresh_enc,oauth_access_enc,oauth_expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`, user.id, email, info.name || '', provider, preset.smtp_host, preset.smtp_port, preset.smtp_secure, email, preset.imap_host, preset.imap_port, email,
        sec.encrypt(tok.refresh_token), sec.encrypt(tok.access_token), exp, now()).lastInsertRowid);
    }
    log(user.id, 'mailbox.connected_oauth', 'mailbox', id, `${provider}:${email}`, req.ip);
    setSession(res, user);
    res.redirect('/#/mailboxes?connected=1');
  } catch (e) {
    fail(e.message, st.purpose === 'mailbox' ? '/' : '/');
  }
}));

module.exports = r;
