const express = require('express');
const config = require('../config');
const { one, all, run, tx, now } = require('../db');
const sec = require('../lib/security');
const { wrap, bad, owned, notFound } = require('../lib/http');
const { log } = require('../lib/activity');
const wallet = require('../lib/wallet');
const mailer = require('../services/mailer');
const D = require('../services/domains');

const r = express.Router();
const MB_PUBLIC = 'id,email,from_name,provider,smtp_host,smtp_port,smtp_secure,smtp_user,imap_host,imap_port,imap_secure,imap_user,daily_limit,min_gap_sec,signature,status,last_error,imap_checked_at,created_at';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const int = (v, d, lo, hi) => { const n = Number.isFinite(+v) && v !== '' && v != null ? Math.trunc(+v) : d; return Math.min(hi, Math.max(lo, n)); };

// =============== Mailboxes ===============
const sentToday = (id) => one("SELECT COUNT(*) n FROM messages WHERE mailbox_id=? AND direction='out' AND status='sent' AND created_at>=?", id, Date.now() - (Date.now() % 86400000)).n;

r.get('/mailboxes', wrap(async (req, res) => {
  const rows = all(`SELECT ${MB_PUBLIC} FROM mailboxes WHERE user_id=? ORDER BY id DESC`, req.user.id);
  for (const m of rows) m.sent_today = sentToday(m.id);
  res.json({ mailboxes: rows });
}));

r.post('/mailboxes', wrap(async (req, res) => {
  const b = req.body || {};
  if (!EMAIL_RE.test(b.email || '')) throw bad('Valid email is required');
  if (!b.smtp_host || !b.smtp_pass) throw bad('SMTP host and password are required');
  const email = b.email.toLowerCase();
  if (one('SELECT 1 x FROM mailboxes WHERE user_id=? AND email=?', req.user.id, email)) throw bad('Mailbox already added');
  const host = String(b.smtp_host).trim();
  if (!/^[a-z0-9.-]+$/i.test(host) || (b.imap_host && !/^[a-z0-9.-]+$/i.test(b.imap_host))) throw bad('Invalid host name');
  const mb = {
    smtp_port: int(b.smtp_port, 587, 1, 65535), imap_port: int(b.imap_port, 993, 1, 65535),
  };
  const id = Number(run(`INSERT INTO mailboxes (user_id,email,from_name,provider,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass_enc,imap_host,imap_port,imap_secure,imap_user,imap_pass_enc,daily_limit,min_gap_sec,signature,created_at)
    VALUES (?,?,?,'smtp',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.user.id, email, String(b.from_name || '').slice(0, 80), host, mb.smtp_port, mb.smtp_port === 465 || b.smtp_secure ? 1 : 0,
    b.smtp_user || email, sec.encrypt(b.smtp_pass), b.imap_host ? String(b.imap_host).trim() : null, mb.imap_port, b.imap_secure === false ? 0 : 1,
    b.imap_user || b.smtp_user || email, sec.encrypt(b.imap_pass || b.smtp_pass),
    int(b.daily_limit, 30, 1, 2000), int(b.min_gap_sec, 60, 0, 3600), String(b.signature || '').slice(0, 2000), now()).lastInsertRowid);
  log(req.user.id, 'mailbox.added', 'mailbox', id, email, req.ip);
  const row = one('SELECT * FROM mailboxes WHERE id=?', id);
  const check = await mailer.verifyMailbox(row);
  if (!check.smtp?.ok) run("UPDATE mailboxes SET status='error', last_error=? WHERE id=?", String(check.smtp?.error).slice(0, 300), id);
  res.json({ id, check });
}));

r.patch('/mailboxes/:id', wrap(async (req, res) => {
  const m = owned('mailboxes', req.params.id, req.user.id);
  const b = req.body || {};
  const sets = [], vals = [];
  const put = (c, v) => { sets.push(`${c}=?`); vals.push(v); };
  if (b.from_name !== undefined) put('from_name', String(b.from_name).slice(0, 80));
  if (b.daily_limit !== undefined) put('daily_limit', int(b.daily_limit, 30, 1, 2000));
  if (b.min_gap_sec !== undefined) put('min_gap_sec', int(b.min_gap_sec, 60, 0, 3600));
  if (b.signature !== undefined) put('signature', String(b.signature).slice(0, 2000));
  if (b.status && ['active', 'paused'].includes(b.status)) { put('status', b.status); put('last_error', null); }
  if (b.smtp_pass) put('smtp_pass_enc', sec.encrypt(b.smtp_pass));
  if (b.imap_pass) put('imap_pass_enc', sec.encrypt(b.imap_pass));
  if (sets.length) run(`UPDATE mailboxes SET ${sets.join(',')} WHERE id=?`, ...vals, m.id);
  log(req.user.id, 'mailbox.updated', 'mailbox', m.id, Object.keys(b).filter((k) => !/pass/.test(k)).join(','), req.ip);
  res.json({ ok: true });
}));

r.post('/mailboxes/:id/test', wrap(async (req, res) => {
  const m = owned('mailboxes', req.params.id, req.user.id);
  const check = await mailer.verifyMailbox(m);
  if (check.smtp?.ok) run("UPDATE mailboxes SET status=CASE WHEN status='error' THEN 'active' ELSE status END, last_error=NULL WHERE id=?", m.id);
  else run("UPDATE mailboxes SET status='error', last_error=? WHERE id=?", String(check.smtp?.error).slice(0, 300), m.id);
  res.json(check);
}));

r.post('/mailboxes/:id/send-test', wrap(async (req, res) => {
  const m = owned('mailboxes', req.params.id, req.user.id);
  const to = String(req.body?.to || req.user.email);
  if (!EMAIL_RE.test(to)) throw bad('Invalid recipient');
  wallet.debit(req.user.id, config.price.email, `Test email to ${to}`, 'test');
  const out = await mailer.send(m, { to, subject: req.body?.subject || 'Test email from XquareSequencer', html: req.body?.html || '<p>Your mailbox is connected and can send.</p>' });
  log(req.user.id, 'mailbox.test_sent', 'mailbox', m.id, to, req.ip);
  res.json({ ok: true, dry: !!out.dry });
}));

r.delete('/mailboxes/:id', wrap(async (req, res) => {
  const m = owned('mailboxes', req.params.id, req.user.id);
  const active = one("SELECT COUNT(*) n FROM campaign_mailboxes cm JOIN campaigns c ON c.id=cm.campaign_id WHERE cm.mailbox_id=? AND c.status='active'", m.id).n;
  if (active && !req.query.force) throw bad(`Mailbox is used by ${active} active campaign(s). Pause them or retry with force.`);
  run('DELETE FROM mailboxes WHERE id=?', m.id);
  log(req.user.id, 'mailbox.deleted', 'mailbox', m.id, m.email, req.ip);
  res.json({ ok: true });
}));

// =============== Domains ===============
const parseDomain = (d) => ({
  id: d.id, name: d.name, registrar: d.registrar, registered_at: d.registered_at, expires_at: d.expires_at,
  nameservers: d.nameservers ? JSON.parse(d.nameservers) : [],
  dns: d.dns_json ? JSON.parse(d.dns_json) : null, dns_checked_at: d.dns_checked_at,
  dkim: d.dkim_public ? { selector: d.dkim_selector, public: d.dkim_public } : null,
  blacklist_status: d.blacklist_status, blacklist: d.blacklist_json ? JSON.parse(d.blacklist_json) : null, blacklist_checked_at: d.blacklist_checked_at,
  mailboxes: all("SELECT COUNT(*) n FROM mailboxes WHERE user_id=? AND email LIKE ?", d.user_id, '%@' + d.name)[0].n,
  created_at: d.created_at,
});

// Availability / registrar lookup for ANY domain (no need to own it).
r.get('/domains/lookup', wrap(async (req, res) => {
  const d = D.normalizeDomain(req.query.name);
  if (!d) throw bad('Invalid domain name');
  res.json(await D.registrarCheck(d));
}));

r.get('/domains', (req, res) => res.json({ domains: all('SELECT * FROM domains WHERE user_id=? ORDER BY id DESC', req.user.id).map(parseDomain) }));

r.post('/domains', wrap(async (req, res) => {
  const name = D.normalizeDomain(req.body?.name);
  if (!name) throw bad('Invalid domain name');
  if (one('SELECT 1 x FROM domains WHERE user_id=? AND name=?', req.user.id, name)) throw bad('Domain already added');
  const id = Number(run('INSERT INTO domains (user_id,name,created_at) VALUES (?,?,?)', req.user.id, name, now()).lastInsertRowid);
  log(req.user.id, 'domain.added', 'domain', id, name, req.ip);
  // best-effort initial registrar + DNS check
  try { await refreshRegistrar(id, name); await refreshDns(id, name); } catch {}
  res.json({ domain: parseDomain(one('SELECT * FROM domains WHERE id=?', id)) });
}));

async function refreshRegistrar(id, name) {
  const x = await D.registrarCheck(name);
  run('UPDATE domains SET registrar=?, registered_at=?, expires_at=?, nameservers=? WHERE id=?', x.registrar, x.createdAt, x.expiresAt, JSON.stringify(x.nameservers), id);
  return x;
}
async function refreshDns(id, name) {
  const d = one('SELECT dkim_selector FROM domains WHERE id=?', id);
  const x = await D.dnsCheck(name, d?.dkim_selector);
  run('UPDATE domains SET dns_json=?, dns_checked_at=? WHERE id=?', JSON.stringify(x), now(), id);
  return x;
}

r.post('/domains/:id/check-registrar', wrap(async (req, res) => {
  const d = owned('domains', req.params.id, req.user.id);
  const x = await refreshRegistrar(d.id, d.name);
  log(req.user.id, 'domain.registrar_checked', 'domain', d.id, d.name, req.ip);
  res.json({ result: x, domain: parseDomain(one('SELECT * FROM domains WHERE id=?', d.id)) });
}));
r.post('/domains/:id/check-dns', wrap(async (req, res) => {
  const d = owned('domains', req.params.id, req.user.id);
  const x = await refreshDns(d.id, d.name);
  log(req.user.id, 'domain.dns_checked', 'domain', d.id, `${d.name} score=${x.score}`, req.ip);
  res.json({ result: x, records: D.recommendedRecords(d.name, d.dkim_selector, d.dkim_public), domain: parseDomain(one('SELECT * FROM domains WHERE id=?', d.id)) });
}));
r.get('/domains/:id/records', wrap(async (req, res) => {
  const d = owned('domains', req.params.id, req.user.id);
  res.json({ records: D.recommendedRecords(d.name, d.dkim_selector, d.dkim_public) });
}));
r.post('/domains/:id/dkim', wrap(async (req, res) => {
  const d = owned('domains', req.params.id, req.user.id);
  const k = D.generateDkim();
  run('UPDATE domains SET dkim_selector=?, dkim_private_enc=?, dkim_public=? WHERE id=?', k.selector, sec.encrypt(k.privateKey), k.publicKey, d.id);
  log(req.user.id, 'domain.dkim_generated', 'domain', d.id, d.name, req.ip);
  res.json({ records: D.recommendedRecords(d.name, k.selector, k.publicKey) });
}));
r.post('/domains/:id/check-blacklist', wrap(async (req, res) => {
  const d = owned('domains', req.params.id, req.user.id);
  wallet.debit(req.user.id, config.price.blacklist, `Blacklist check ${d.name}`, 'bl:' + d.id);
  const x = await D.blacklistCheck(d.name);
  run('UPDATE domains SET blacklist_json=?, blacklist_status=?, blacklist_checked_at=? WHERE id=?', JSON.stringify(x), x.status, now(), d.id);
  log(req.user.id, 'domain.blacklist_checked', 'domain', d.id, `${d.name}: ${x.status} (${x.listed.length} listings)`, req.ip);
  res.json({ result: x, domain: parseDomain(one('SELECT * FROM domains WHERE id=?', d.id)) });
}));
r.delete('/domains/:id', wrap(async (req, res) => {
  const d = owned('domains', req.params.id, req.user.id);
  run('DELETE FROM domains WHERE id=?', d.id);
  log(req.user.id, 'domain.deleted', 'domain', d.id, d.name, req.ip);
  res.json({ ok: true });
}));

// =============== Wallet ===============
const payments = require('../services/payments');
r.get('/wallet', (req, res) => res.json({
  balance_micros: wallet.balance(req.user.id), provider: payments.providerName(), pricing: config.price,
  transactions: all('SELECT * FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 200', req.user.id),
  payments: all('SELECT id,provider,amount_micros,status,created_at,paid_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id),
}));
r.post('/wallet/topup', wrap(async (req, res) => {
  const out = await payments.startTopUp(req.user, +req.body?.amount);
  log(req.user.id, 'wallet.topup_started', 'wallet', null, `$${req.body?.amount}`, req.ip);
  res.json(out);
}));

// =============== Activity logs ===============
r.get('/activity', (req, res) => {
  const limit = int(req.query.limit, 50, 1, 200), before = int(req.query.before, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
  const q = String(req.query.q || '').trim();
  const rows = q
    ? all('SELECT * FROM activity_logs WHERE user_id=? AND id<? AND (action LIKE ? OR detail LIKE ?) ORDER BY id DESC LIMIT ?', req.user.id, before, `%${q}%`, `%${q}%`, limit)
    : all('SELECT * FROM activity_logs WHERE user_id=? AND id<? ORDER BY id DESC LIMIT ?', req.user.id, before, limit);
  res.json({ logs: rows });
});

// =============== Dashboard ===============
r.get('/dashboard', (req, res) => {
  const uid = req.user.id;
  const since = Date.now() - 14 * 86400000;
  const count = (sql, ...p) => one(sql, uid, ...p).n;
  const sent = count("SELECT COUNT(*) n FROM messages WHERE user_id=? AND direction='out' AND status='sent'");
  const opened = count("SELECT COUNT(*) n FROM messages WHERE user_id=? AND direction='out' AND opens>0");
  const clicked = count("SELECT COUNT(*) n FROM messages WHERE user_id=? AND direction='out' AND clicks>0");
  const replies = count("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE user_id=? AND direction='in'");
  const bounced = count("SELECT COUNT(*) n FROM campaign_leads cl JOIN campaigns c ON c.id=cl.campaign_id WHERE c.user_id=? AND cl.status='bounced'");
  const series = all(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') d, direction,
      COUNT(*) n, SUM(CASE WHEN opens>0 THEN 1 ELSE 0 END) o FROM messages WHERE user_id=? AND created_at>=? AND status IN ('sent','received') GROUP BY d, direction`, uid, since);
  res.json({
    totals: { sent, opened, clicked, replies, bounced,
      open_rate: sent ? opened / sent : 0, reply_rate: sent ? replies / sent : 0, bounce_rate: sent ? bounced / sent : 0 },
    counts: {
      campaigns_active: count("SELECT COUNT(*) n FROM campaigns WHERE user_id=? AND status='active'"),
      campaigns: count('SELECT COUNT(*) n FROM campaigns WHERE user_id=?'),
      mailboxes: count('SELECT COUNT(*) n FROM mailboxes WHERE user_id=?'),
      mailboxes_error: count("SELECT COUNT(*) n FROM mailboxes WHERE user_id=? AND status='error'"),
      domains: count('SELECT COUNT(*) n FROM domains WHERE user_id=?'),
      domains_listed: count("SELECT COUNT(*) n FROM domains WHERE user_id=? AND blacklist_status='listed'"),
      leads: count('SELECT COUNT(*) n FROM leads WHERE user_id=?'),
      unread: count("SELECT COUNT(*) n FROM messages WHERE user_id=? AND direction='in' AND read=0"),
    },
    series, balance_micros: wallet.balance(uid),
    recent: all('SELECT * FROM activity_logs WHERE user_id=? ORDER BY id DESC LIMIT 8', uid),
  });
});

// =============== Admin ===============
const admin = express.Router();
admin.use((req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' })));
admin.get('/users', (req, res) => res.json({ users: all(`SELECT u.id,u.email,u.name,u.role,u.balance_micros,u.created_at,u.last_login_at,
  (SELECT COUNT(*) FROM campaigns WHERE user_id=u.id) campaigns, (SELECT COUNT(*) FROM mailboxes WHERE user_id=u.id) mailboxes,
  (SELECT COUNT(*) FROM messages WHERE user_id=u.id AND direction='out' AND status='sent') sent FROM users u ORDER BY u.id`) }));
admin.post('/users/:id/credit', wrap(async (req, res) => {
  const amt = Math.round(+req.body?.amount_usd * 1e6);
  if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 1e9) throw bad('Invalid amount');
  const u = one('SELECT id FROM users WHERE id=?', +req.params.id);
  if (!u) throw notFound('User not found');
  const bal = amt > 0 ? wallet.credit(u.id, amt, `Admin adjustment${req.body.note ? ': ' + String(req.body.note).slice(0, 100) : ''}`, 'admin:' + req.user.id)
                      : wallet.debit(u.id, -amt, `Admin adjustment${req.body.note ? ': ' + String(req.body.note).slice(0, 100) : ''}`, 'admin:' + req.user.id);
  log(req.user.id, 'admin.wallet_adjust', 'user', u.id, `${amt / 1e6} USD`, req.ip);
  res.json({ balance_micros: bal });
}));
admin.post('/users/:id/role', wrap(async (req, res) => {
  const role = req.body?.role;
  if (!['user', 'admin'].includes(role)) throw bad('Invalid role');
  if (+req.params.id === req.user.id) throw bad('You cannot change your own role');
  run('UPDATE users SET role=? WHERE id=?', role, +req.params.id);
  log(req.user.id, 'admin.role_changed', 'user', +req.params.id, role, req.ip);
  res.json({ ok: true });
}));
r.use('/admin', admin);

module.exports = r;
