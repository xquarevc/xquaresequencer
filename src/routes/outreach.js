const express = require('express');
const config = require('../config');
const { one, all, run, tx, now } = require('../db');
const { wrap, bad, owned, notFound } = require('../lib/http');
const { log } = require('../lib/activity');
const { render, leadVars, sanitizeHtml, htmlToText } = require('../lib/template');
const wallet = require('../lib/wallet');
const mailer = require('../services/mailer');
const engine = require('../services/engine');

const r = express.Router();
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const int = (v, d, lo, hi) => { const n = Number.isFinite(+v) && v !== '' && v != null ? Math.trunc(+v) : d; return Math.min(hi, Math.max(lo, n)); };

// =============== Leads ===============
r.get('/lists', (req, res) => res.json({ lists: all(`SELECT l.*, (SELECT COUNT(*) FROM leads WHERE list_id=l.id) leads FROM lead_lists l WHERE user_id=? ORDER BY id DESC`, req.user.id) }));
r.post('/lists', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) throw bad('Name is required');
  const id = Number(run('INSERT INTO lead_lists (user_id,name,created_at) VALUES (?,?,?)', req.user.id, name, now()).lastInsertRowid);
  log(req.user.id, 'list.created', 'list', id, name, req.ip);
  res.json({ id });
}));
r.delete('/lists/:id', wrap(async (req, res) => {
  const l = owned('lead_lists', req.params.id, req.user.id);
  tx(() => { if (req.query.with_leads === '1') run('DELETE FROM leads WHERE list_id=?', l.id); run('DELETE FROM lead_lists WHERE id=?', l.id); });
  log(req.user.id, 'list.deleted', 'list', l.id, l.name, req.ip);
  res.json({ ok: true });
}));

const CORE = ['first_name', 'last_name', 'company', 'phone', 'website', 'title'];
const ALIASES = { firstname: 'first_name', first: 'first_name', lastname: 'last_name', last: 'last_name', organization: 'company', company_name: 'company', job_title: 'title', url: 'website', mobile: 'phone', 'e-mail': 'email', email_address: 'email' };

/** Insert/update leads. rows: [{email, first_name, ..., custom fields}] */
function upsertLeads(userId, listId, rows) {
  let added = 0, updated = 0, invalid = 0;
  tx(() => {
    for (const row of rows) {
      const email = String(row.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) { invalid++; continue; }
      const custom = {};
      for (const [k, v] of Object.entries(row)) if (k !== 'email' && !CORE.includes(k) && v !== '' && v != null) custom[k.toLowerCase().replace(/[^a-z0-9_]/g, '_')] = String(v).slice(0, 500);
      const vals = CORE.map((c) => String(row[c] ?? '').slice(0, 200));
      const ex = one('SELECT id FROM leads WHERE user_id=? AND email=?', userId, email);
      if (ex) {
        run(`UPDATE leads SET first_name=COALESCE(NULLIF(?,''),first_name), last_name=COALESCE(NULLIF(?,''),last_name), company=COALESCE(NULLIF(?,''),company), phone=COALESCE(NULLIF(?,''),phone), website=COALESCE(NULLIF(?,''),website), title=COALESCE(NULLIF(?,''),title), list_id=COALESCE(?,list_id) WHERE id=?`, ...vals, listId ?? null, ex.id);
        updated++;
      } else {
        run(`INSERT INTO leads (user_id,list_id,email,${CORE.join(',')},custom_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, userId, listId ?? null, email, ...vals, JSON.stringify(custom), now());
        added++;
      }
    }
  });
  return { added, updated, invalid };
}

// RFC4180-ish CSV parser (quoted fields, escaped quotes, CRLF)
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
r.post('/leads/import', express.text({ type: 'text/csv', limit: '10mb' }), wrap(async (req, res) => {
  const body = typeof req.body === 'string' ? req.body : '';
  const listId = req.query.list_id ? owned('lead_lists', req.query.list_id, req.user.id).id : null;
  const [head, ...rest] = parseCsv(body);
  if (!head) throw bad('Empty CSV');
  const cols = head.map((h) => { const k = h.trim().toLowerCase().replace(/\s+/g, '_'); return ALIASES[k] || k; });
  if (!cols.includes('email')) throw bad('CSV needs an "email" column');
  if (rest.length > 50000) throw bad('Max 50,000 rows per import');
  const rows = rest.map((cells) => Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').trim()])));
  const out = upsertLeads(req.user.id, listId, rows);
  log(req.user.id, 'leads.imported', 'list', listId, out, req.ip);
  res.json(out);
}));
r.post('/leads', wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.leads) ? req.body.leads.slice(0, 5000) : [req.body];
  const listId = req.body?.list_id ? owned('lead_lists', req.body.list_id, req.user.id).id : null;
  const out = upsertLeads(req.user.id, listId, rows);
  log(req.user.id, 'leads.added', 'lead', null, out, req.ip);
  res.json(out);
}));
r.get('/leads', (req, res) => {
  const limit = int(req.query.limit, 50, 1, 200), offset = int(req.query.offset, 0, 0, 1e7);
  const where = ['l.user_id=?'], p = [req.user.id];
  if (req.query.list_id) { where.push('l.list_id=?'); p.push(+req.query.list_id); }
  if (req.query.q) { where.push('(l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ? OR l.company LIKE ?)'); const q = `%${req.query.q}%`; p.push(q, q, q, q); }
  const total = one(`SELECT COUNT(*) n FROM leads l WHERE ${where.join(' AND ')}`, ...p).n;
  const rows = all(`SELECT l.*, EXISTS(SELECT 1 FROM unsubscribes u WHERE u.user_id=l.user_id AND u.email=l.email) unsubscribed FROM leads l WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  res.json({ total, leads: rows });
});
r.delete('/leads/:id', wrap(async (req, res) => {
  const l = owned('leads', req.params.id, req.user.id);
  run('DELETE FROM leads WHERE id=?', l.id);
  log(req.user.id, 'lead.deleted', 'lead', l.id, l.email, req.ip);
  res.json({ ok: true });
}));
r.get('/unsubscribes', (req, res) => res.json({ unsubscribes: all('SELECT * FROM unsubscribes WHERE user_id=? ORDER BY created_at DESC LIMIT 1000', req.user.id) }));
r.post('/unsubscribes', wrap(async (req, res) => {
  const emails = (Array.isArray(req.body?.emails) ? req.body.emails : [req.body?.email]).map((e) => String(e || '').toLowerCase().trim()).filter((e) => EMAIL_RE.test(e));
  if (!emails.length) throw bad('No valid emails');
  tx(() => { for (const e of emails) { run('INSERT OR IGNORE INTO unsubscribes (user_id,email,created_at) VALUES (?,?,?)', req.user.id, e, now()); run("UPDATE campaign_leads SET status='unsubscribed' WHERE status IN ('active','paused','completed') AND lead_id IN (SELECT id FROM leads WHERE user_id=? AND email=?)", req.user.id, e); } });
  log(req.user.id, 'unsubscribe.added', 'lead', null, `${emails.length} emails`, req.ip);
  res.json({ ok: true, count: emails.length });
}));

// =============== Campaigns ===============
const campaignStats = (c) => {
  const q = (sql) => one(sql, c.id).n;
  const sent = q("SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND direction='out' AND status='sent'");
  return {
    leads: q('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id=?'),
    sent, opened: q("SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND direction='out' AND opens>0"),
    clicked: q("SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND direction='out' AND clicks>0"),
    replied: q("SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id=? AND status='replied'"),
    bounced: q("SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id=? AND status='bounced'"),
    unsubscribed: q("SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id=? AND status='unsubscribed'"),
    pending: q("SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id=? AND status='active'"),
  };
};
const full = (c) => ({
  ...c, send_days: JSON.parse(c.send_days),
  mailbox_ids: all('SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id=?', c.id).map((x) => x.mailbox_id),
  steps: engine.loadSteps(c.id), stats: campaignStats(c),
});

r.get('/campaigns', (req, res) => res.json({ campaigns: all('SELECT * FROM campaigns WHERE user_id=? ORDER BY id DESC', req.user.id).map((c) => ({ ...c, stats: campaignStats(c) })) }));
r.get('/campaigns/:id', wrap(async (req, res) => res.json({ campaign: full(owned('campaigns', req.params.id, req.user.id)) })));

function validateSettings(b) {
  const o = {};
  if (b.name !== undefined) { o.name = String(b.name).trim().slice(0, 120); if (!o.name) throw bad('Campaign name is required'); }
  if (b.timezone !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); o.timezone = b.timezone; } catch { throw bad('Invalid timezone'); } }
  if (b.send_days !== undefined) { const d = [...new Set((b.send_days || []).map(Number).filter((x) => x >= 0 && x <= 6))]; if (!d.length) throw bad('Pick at least one sending day'); o.send_days = JSON.stringify(d); }
  if (b.send_start !== undefined) o.send_start = int(b.send_start, 9, 0, 23);
  if (b.send_end !== undefined) o.send_end = int(b.send_end, 17, 1, 24);
  if (b.daily_limit !== undefined) o.daily_limit = int(b.daily_limit, 200, 1, 100000);
  for (const k of ['stop_on_reply', 'track_opens', 'track_clicks', 'include_unsubscribe']) if (b[k] !== undefined) o[k] = b[k] ? 1 : 0;
  return o;
}
function saveSteps(campaignId, steps) {
  if (!Array.isArray(steps) || !steps.length) throw bad('Add at least one email step');
  if (steps.length > 10) throw bad('Max 10 steps');
  run('DELETE FROM steps WHERE campaign_id=?', campaignId);
  steps.forEach((s, i) => {
    if (!Array.isArray(s.variants) || !s.variants.length) throw bad(`Step ${i + 1} needs at least one email`);
    if (s.variants.length > 5) throw bad('Max 5 variants per step');
    const sid = Number(run('INSERT INTO steps (campaign_id,position,delay_days) VALUES (?,?,?)', campaignId, i, i === 0 ? 0 : int(s.delay_days, 2, 0, 60)).lastInsertRowid);
    for (const v of s.variants) {
      if (i === 0 && !String(v.subject || '').trim()) throw bad('The first email needs a subject');
      run('INSERT INTO variants (step_id,subject,body,weight) VALUES (?,?,?,?)', sid, String(v.subject || '').slice(0, 300), sanitizeHtml(String(v.body || '')).slice(0, 100000), int(v.weight, 1, 1, 100));
    }
  });
}
function saveMailboxes(userId, campaignId, ids) {
  run('DELETE FROM campaign_mailboxes WHERE campaign_id=?', campaignId);
  for (const id of [...new Set((ids || []).map(Number))]) { owned('mailboxes', id, userId); run('INSERT INTO campaign_mailboxes (campaign_id,mailbox_id) VALUES (?,?)', campaignId, id); }
}

r.post('/campaigns', wrap(async (req, res) => {
  const b = req.body || {};
  const o = validateSettings({ name: 'Untitled campaign', ...b });
  const id = tx(() => {
    const cols = Object.keys(o);
    const id = Number(run(`INSERT INTO campaigns (user_id,created_at,updated_at,${cols.join(',')}) VALUES (?,?,?,${cols.map(() => '?').join(',')})`, req.user.id, now(), now(), ...cols.map((c) => o[c])).lastInsertRowid);
    if (b.steps) saveSteps(id, b.steps);
    if (b.mailbox_ids) saveMailboxes(req.user.id, id, b.mailbox_ids);
    return id;
  });
  log(req.user.id, 'campaign.created', 'campaign', id, o.name, req.ip);
  res.json({ id });
}));

r.put('/campaigns/:id', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  const b = req.body || {};
  const o = validateSettings(b);
  tx(() => {
    const cols = Object.keys(o);
    if (cols.length) run(`UPDATE campaigns SET ${cols.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...cols.map((k) => o[k]), now(), c.id);
    if (b.steps) {
      // Editing a running sequence: keep per-lead progress, but never skip past the new length
      saveSteps(c.id, b.steps);
    }
    if (b.mailbox_ids) saveMailboxes(req.user.id, c.id, b.mailbox_ids);
  });
  log(req.user.id, 'campaign.updated', 'campaign', c.id, c.name, req.ip);
  res.json({ ok: true });
}));

r.post('/campaigns/:id/leads', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  const b = req.body || {};
  let leadRows = [];
  if (b.list_id) leadRows = all('SELECT id,email FROM leads WHERE list_id=? AND user_id=?', owned('lead_lists', b.list_id, req.user.id).id, req.user.id);
  if (Array.isArray(b.lead_ids)) leadRows.push(...b.lead_ids.map((id) => one('SELECT id,email FROM leads WHERE id=? AND user_id=?', +id, req.user.id)).filter(Boolean));
  let added = 0, skipped = 0;
  const startAt = c.status === 'active' ? now() : null;
  tx(() => {
    for (const l of leadRows) {
      if (one('SELECT 1 x FROM unsubscribes WHERE user_id=? AND email=?', req.user.id, l.email)) { skipped++; continue; }
      const r2 = run('INSERT OR IGNORE INTO campaign_leads (campaign_id,lead_id,status,next_send_at) VALUES (?,?,?,?)', c.id, l.id, 'active', startAt);
      r2.changes ? added++ : skipped++;
    }
  });
  log(req.user.id, 'campaign.leads_added', 'campaign', c.id, `${added} added, ${skipped} skipped`, req.ip);
  res.json({ added, skipped });
}));
r.get('/campaigns/:id/leads', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  const limit = int(req.query.limit, 50, 1, 200), offset = int(req.query.offset, 0, 0, 1e7);
  const st = req.query.status ? 'AND cl.status=?' : '';
  const p = req.query.status ? [c.id, req.query.status] : [c.id];
  res.json({
    total: one(`SELECT COUNT(*) n FROM campaign_leads cl WHERE cl.campaign_id=? ${st}`, ...p).n,
    leads: all(`SELECT cl.id,cl.status,cl.current_step,cl.next_send_at,cl.last_sent_at,cl.category,l.email,l.first_name,l.last_name,l.company FROM campaign_leads cl JOIN leads l ON l.id=cl.lead_id WHERE cl.campaign_id=? ${st} ORDER BY cl.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset),
  });
}));
r.delete('/campaigns/:id/leads/:clid', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  run('DELETE FROM campaign_leads WHERE id=? AND campaign_id=?', +req.params.clid, c.id);
  res.json({ ok: true });
}));

r.post('/campaigns/:id/launch', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  const errs = [];
  if (!engine.loadSteps(c.id).length) errs.push('Add at least one email to the sequence');
  if (!one('SELECT 1 x FROM campaign_mailboxes cm JOIN mailboxes m ON m.id=cm.mailbox_id WHERE cm.campaign_id=? AND m.status=\'active\'', c.id)) errs.push('Select at least one active mailbox');
  if (!one('SELECT 1 x FROM campaign_leads WHERE campaign_id=?', c.id)) errs.push('Add leads to the campaign');
  if (wallet.balance(req.user.id) < config.price.email) errs.push('Wallet balance too low — add funds');
  if (errs.length) throw bad(errs.join('; '));
  tx(() => {
    run("UPDATE campaigns SET status='active', updated_at=? WHERE id=?", now(), c.id);
    run("UPDATE campaign_leads SET next_send_at=? WHERE campaign_id=? AND status='active' AND next_send_at IS NULL", now(), c.id);
  });
  log(req.user.id, 'campaign.launched', 'campaign', c.id, c.name, req.ip);
  if (config.schedulerEnabled) engine.tick().catch(() => {});
  res.json({ ok: true });
}));
r.post('/campaigns/:id/pause', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  run("UPDATE campaigns SET status='paused', updated_at=? WHERE id=? AND status='active'", now(), c.id);
  log(req.user.id, 'campaign.paused', 'campaign', c.id, c.name, req.ip);
  res.json({ ok: true });
}));
r.post('/campaigns/:id/resume', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  if (wallet.balance(req.user.id) < config.price.email) throw bad('Wallet balance too low — add funds');
  run("UPDATE campaigns SET status='active', updated_at=? WHERE id=? AND status='paused'", now(), c.id);
  log(req.user.id, 'campaign.resumed', 'campaign', c.id, c.name, req.ip);
  res.json({ ok: true });
}));
r.post('/campaigns/:id/duplicate', wrap(async (req, res) => {
  const c = full(owned('campaigns', req.params.id, req.user.id));
  const id = tx(() => {
    const id = Number(run(`INSERT INTO campaigns (user_id,name,timezone,send_days,send_start,send_end,daily_limit,stop_on_reply,track_opens,track_clicks,include_unsubscribe,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.user.id, c.name + ' (copy)', c.timezone, JSON.stringify(c.send_days), c.send_start, c.send_end, c.daily_limit, c.stop_on_reply, c.track_opens, c.track_clicks, c.include_unsubscribe, now(), now()).lastInsertRowid);
    saveSteps(id, c.steps.map((s) => ({ delay_days: s.delay_days, variants: s.variants })));
    saveMailboxes(req.user.id, id, c.mailbox_ids);
    return id;
  });
  log(req.user.id, 'campaign.duplicated', 'campaign', id, c.name, req.ip);
  res.json({ id });
}));
r.delete('/campaigns/:id', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  run('DELETE FROM campaigns WHERE id=?', c.id);
  log(req.user.id, 'campaign.deleted', 'campaign', c.id, c.name, req.ip);
  res.json({ ok: true });
}));

// Per-step performance (A/B variants included)
r.get('/campaigns/:id/analytics', wrap(async (req, res) => {
  const c = owned('campaigns', req.params.id, req.user.id);
  const rows = all(`SELECT s.position, v.id variant_id, v.subject,
     COUNT(m.id) sent, SUM(CASE WHEN m.opens>0 THEN 1 ELSE 0 END) opened, SUM(CASE WHEN m.clicks>0 THEN 1 ELSE 0 END) clicked
     FROM steps s JOIN variants v ON v.step_id=s.id LEFT JOIN messages m ON m.variant_id=v.id AND m.direction='out' AND m.status='sent'
     WHERE s.campaign_id=? GROUP BY v.id ORDER BY s.position, v.id`, c.id);
  const replies = all(`SELECT out.variant_id, COUNT(DISTINCT out.campaign_lead_id) n FROM messages out
     JOIN campaign_leads cl ON cl.id=out.campaign_lead_id AND cl.status='replied' WHERE out.campaign_id=? AND out.direction='out' GROUP BY out.variant_id`, c.id);
  const rm = Object.fromEntries(replies.map((x) => [x.variant_id, x.n]));
  res.json({ variants: rows.map((x) => ({ ...x, replied: rm[x.variant_id] || 0 })) });
}));

// Preview a template against a sample lead (rendered server-side so spintax/vars match sending)
r.post('/preview', wrap(async (req, res) => {
  const lead = req.body?.lead || { first_name: 'Alex', last_name: 'Morgan', company: 'Acme Inc', email: 'alex@acme.com', title: 'Head of Growth' };
  const vars = leadVars({ ...lead, custom_json: JSON.stringify(lead.custom || {}) }, { from_name: req.user.name, email: req.user.email });
  res.json({ subject: render(req.body?.subject, vars), html: sanitizeHtml(render(req.body?.body, vars)) });
}));

// =============== Inbox ===============
r.get('/inbox', (req, res) => {
  const uid = req.user.id;
  const limit = int(req.query.limit, 40, 1, 100), offset = int(req.query.offset, 0, 0, 1e6);
  const filter = req.query.filter === 'unread' ? 'AND m.read=0' : '';
  const rows = all(`SELECT m.id,m.lead_id,m.campaign_id,m.mailbox_id,m.from_email,m.subject,m.read,m.created_at,
      c.name campaign, cl.category, cl.status lead_status, l.first_name, l.last_name, l.company
      FROM messages m LEFT JOIN campaigns c ON c.id=m.campaign_id LEFT JOIN campaign_leads cl ON cl.id=m.campaign_lead_id LEFT JOIN leads l ON l.id=m.lead_id
      WHERE m.user_id=? AND m.direction='in' ${filter} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, uid, limit, offset);
  res.json({ messages: rows, unread: one("SELECT COUNT(*) n FROM messages WHERE user_id=? AND direction='in' AND read=0", uid).n });
});
r.get('/inbox/thread/:id', wrap(async (req, res) => {
  const m = owned('messages', req.params.id, req.user.id);
  const thread = m.campaign_lead_id
    ? all('SELECT id,direction,from_email,to_email,subject,body,status,opens,clicks,created_at FROM messages WHERE campaign_lead_id=? AND status IN (\'sent\',\'received\',\'bounced\') ORDER BY created_at', m.campaign_lead_id)
    : all('SELECT id,direction,from_email,to_email,subject,body,status,opens,clicks,created_at FROM messages WHERE id=?', m.id);
  run("UPDATE messages SET read=1 WHERE user_id=? AND direction='in' AND (id=? OR (campaign_lead_id IS NOT NULL AND campaign_lead_id=?))", req.user.id, m.id, m.campaign_lead_id);
  res.json({ thread, lead: m.lead_id ? one('SELECT id,email,first_name,last_name,company,title FROM leads WHERE id=?', m.lead_id) : null,
    category: m.campaign_lead_id ? one('SELECT category,status FROM campaign_leads WHERE id=?', m.campaign_lead_id) : null });
}));
r.post('/inbox/:id/reply', wrap(async (req, res) => {
  const m = owned('messages', req.params.id, req.user.id);
  if (m.direction !== 'in') throw bad('Can only reply to received messages');
  const mb = one('SELECT * FROM mailboxes WHERE id=? AND user_id=?', m.mailbox_id, req.user.id);
  if (!mb) throw bad('The mailbox that received this message no longer exists');
  const html = sanitizeHtml(String(req.body?.html || ''));
  if (!htmlToText(html)) throw bad('Reply is empty');
  wallet.debit(req.user.id, config.price.email, `Reply to ${m.from_email}`, 'reply:' + m.id);
  const subject = /^re:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || '');
  const out = await mailer.send(mb, { to: m.from_email, subject, html, inReplyTo: m.message_id, references: m.message_id });
  run(`INSERT INTO messages (user_id,campaign_id,campaign_lead_id,lead_id,mailbox_id,direction,from_email,to_email,subject,body,message_id,in_reply_to,status,created_at) VALUES (?,?,?,?,?,'out',?,?,?,?,?,?,'sent',?)`,
    req.user.id, m.campaign_id, m.campaign_lead_id, m.lead_id, mb.id, mb.email, m.from_email, subject, html, out.messageId, m.message_id, now());
  log(req.user.id, 'inbox.replied', 'message', m.id, m.from_email, req.ip);
  res.json({ ok: true });
}));
r.post('/inbox/:id/category', wrap(async (req, res) => {
  const m = owned('messages', req.params.id, req.user.id);
  const cat = req.body?.category;
  if (![null, 'interested', 'meeting_booked', 'not_interested', 'out_of_office', 'wrong_person', 'do_not_contact'].includes(cat)) throw bad('Invalid category');
  if (!m.campaign_lead_id) throw bad('Message is not part of a campaign');
  run('UPDATE campaign_leads SET category=? WHERE id=?', cat, m.campaign_lead_id);
  if (cat === 'do_not_contact' && m.lead_id) {
    const l = one('SELECT email FROM leads WHERE id=?', m.lead_id);
    run('INSERT OR IGNORE INTO unsubscribes (user_id,email,created_at) VALUES (?,?,?)', req.user.id, l.email, now());
  }
  log(req.user.id, 'inbox.categorized', 'message', m.id, cat, req.ip);
  res.json({ ok: true });
}));
r.post('/inbox/sync', wrap(async (req, res) => {
  let n = 0;
  for (const mb of all("SELECT * FROM mailboxes WHERE user_id=? AND status='active' AND imap_host IS NOT NULL", req.user.id)) {
    try { n += await engine.pollMailbox(mb); } catch (e) { run('UPDATE mailboxes SET last_error=? WHERE id=?', String(e.message).slice(0, 300), mb.id); }
  }
  res.json({ new: n });
}));

module.exports = r;
