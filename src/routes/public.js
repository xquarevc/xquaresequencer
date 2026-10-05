// Unauthenticated endpoints: open/click tracking, unsubscribe, Stripe webhook.
const express = require('express');
const { one, run, now } = require('../db');
const { log } = require('../lib/activity');
const { escapeHtml } = require('../lib/template');
const payments = require('../services/payments');

const r = express.Router();
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

r.get('/t/o/:token.gif', (req, res) => {
  const m = one("SELECT id,first_open_at FROM messages WHERE token=? AND direction='out'", req.params.token);
  // Ignore obvious prefetch-by-sender (first 3s) noise; count the rest.
  if (m) run('UPDATE messages SET opens=opens+1, first_open_at=COALESCE(first_open_at,?) WHERE id=?', now(), m.id);
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(PIXEL);
});

r.get('/t/c/:token', (req, res) => {
  const l = one('SELECT * FROM links WHERE token=?', req.params.token);
  if (!l || !/^https?:\/\//i.test(l.url)) return res.status(404).send('Link not found');
  run('UPDATE messages SET clicks=clicks+1 WHERE id=?', l.message_id);
  res.redirect(302, l.url);
});

function unsubscribe(token) {
  const m = one("SELECT * FROM messages WHERE token=? AND direction='out'", token);
  if (!m) return null;
  run('INSERT OR IGNORE INTO unsubscribes (user_id,email,created_at) VALUES (?,?,?)', m.user_id, m.to_email.toLowerCase(), now());
  run("UPDATE campaign_leads SET status='unsubscribed', next_send_at=NULL WHERE status IN ('active','paused','completed') AND lead_id IN (SELECT id FROM leads WHERE user_id=? AND email=?)", m.user_id, m.to_email);
  log(m.user_id, 'lead.unsubscribed', 'lead', m.lead_id, m.to_email);
  return m;
}
const page = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#222"><div style="background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 2px 12px #0001;max-width:420px;text-align:center">${body}</div>`;
// GET shows a confirm button (prefetchers/scanners must not unsubscribe people); POST is also the RFC 8058 one-click target.
r.get('/u/:token', (req, res) => {
  const m = one("SELECT to_email FROM messages WHERE token=? AND direction='out'", req.params.token);
  if (!m) return res.status(404).send(page('<h2>Link not found</h2>'));
  res.send(page(`<h2>Unsubscribe</h2><p>Stop all emails to <b>${escapeHtml(m.to_email)}</b>?</p><form method="post"><button style="padding:10px 22px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-size:15px;cursor:pointer">Yes, unsubscribe me</button></form>`));
});
r.post('/u/:token', express.urlencoded({ extended: false }), (req, res) => {
  const m = unsubscribe(req.params.token);
  if (!m) return res.status(404).send(page('<h2>Link not found</h2>'));
  res.send(page(`<h2>You're unsubscribed</h2><p>${escapeHtml(m.to_email)} will not receive further emails.</p>`));
});

r.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const raw = req.body.toString('utf8');
  if (!payments.verifyStripeSignature(raw, req.headers['stripe-signature'])) return res.status(400).send('bad signature');
  try { payments.handleStripeEvent(JSON.parse(raw)); } catch (e) { console.error('stripe webhook', e); return res.status(500).send('error'); }
  res.json({ received: true });
});
module.exports = r;
