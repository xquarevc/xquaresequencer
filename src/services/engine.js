// Campaign sending engine + reply/bounce detection.
const config = require('../config');
const { one, all, run, now } = require('../db');
const { randomToken } = require('../lib/security');
const { render, leadVars, sanitizeHtml, htmlToText } = require('../lib/template');
const wallet = require('../lib/wallet');
const { log } = require('../lib/activity');
const mailer = require('./mailer');

const DAY = 86400000;

// ---- time-window helpers (campaign timezone aware) ----
function localParts(ts, tz) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { hour: +p.hour, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), day: `${p.year}-${p.month}-${p.day}` };
  } catch { return localParts(ts, 'UTC'); }
}
function inWindow(c, ts = now()) {
  const l = localParts(ts, c.timezone);
  const days = JSON.parse(c.send_days || '[1,2,3,4,5]');
  return days.includes(l.dow) && l.hour >= c.send_start && l.hour < c.send_end;
}
function startOfLocalDay(ts, tz) {
  // find the earliest ts within the local day by stepping back hourly (≤ 26 steps)
  const day = localParts(ts, tz).day;
  let t = ts;
  for (let i = 0; i < 26; i++) { if (localParts(t - 3600000, tz).day !== day) break; t -= 3600000; }
  return t - (t % 3600000); // hour precision is enough for daily caps
}
const sentTodayByMailbox = (mbId, tz) => one("SELECT COUNT(*) n FROM messages WHERE mailbox_id=? AND direction='out' AND status='sent' AND created_at>=?", mbId, startOfLocalDay(now(), tz)).n;
const sentTodayByCampaign = (cId, tz) => one("SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND direction='out' AND status='sent' AND created_at>=?", cId, startOfLocalDay(now(), tz)).n;

// ---- campaign structure ----
function loadSteps(campaignId) {
  const steps = all('SELECT * FROM steps WHERE campaign_id=? ORDER BY position', campaignId);
  for (const s of steps) s.variants = all('SELECT * FROM variants WHERE step_id=? ORDER BY id', s.id);
  return steps;
}
function pickVariant(variants) {
  const total = variants.reduce((a, v) => a + Math.max(1, v.weight), 0);
  let r = Math.random() * total;
  for (const v of variants) { r -= Math.max(1, v.weight); if (r < 0) return v; }
  return variants[0];
}

/** Choose a mailbox with remaining capacity; sticky mailbox for a lead keeps threads consistent. */
function pickMailbox(campaign, cl, ts) {
  const mbs = all(`SELECT m.* FROM mailboxes m JOIN campaign_mailboxes cm ON cm.mailbox_id=m.id
                   WHERE cm.campaign_id=? AND m.status='active'`, campaign.id);
  const eligible = mbs.filter((m) => sentTodayByMailbox(m.id, campaign.timezone) < m.daily_limit
    && !(m.min_gap_sec && one("SELECT MAX(created_at) t FROM messages WHERE mailbox_id=? AND direction='out'", m.id).t > ts - m.min_gap_sec * 1000));
  if (cl.mailbox_id) return eligible.find((m) => m.id === cl.mailbox_id) || null; // wait for own mailbox
  if (!eligible.length) return null;
  eligible.sort((a, b) => sentTodayByMailbox(a.id, campaign.timezone) - sentTodayByMailbox(b.id, campaign.timezone));
  return eligible[0];
}

function addTracking(campaign, msgRow, html) {
  let out = html;
  if (campaign.track_clicks) {
    out = mailer.wrapLinks(out, msgRow.id, (mid, url) => {
      const token = randomToken(9);
      run('INSERT INTO links (message_id,token,url) VALUES (?,?,?)', mid, token, url);
      return `${config.baseUrl}/t/c/${token}`;
    });
  }
  if (campaign.include_unsubscribe) out += mailer.footerUnsub(msgRow.token);
  if (campaign.track_opens) out += `<img src="${config.baseUrl}/t/o/${msgRow.token}.gif" width="1" height="1" alt="" style="display:none">`;
  return out;
}

/** Compose + send the next step for one campaign_lead. Throws on send errors (caller handles). */
async function sendStep(campaign, cl, steps, mailbox) {
  const lead = one('SELECT * FROM leads WHERE id=?', cl.lead_id);
  const step = steps[cl.current_step];
  const v = pickVariant(step.variants);
  const vars = leadVars(lead, mailbox);
  const first = cl.current_step === 0;
  const prevOut = first ? null : one("SELECT * FROM messages WHERE campaign_lead_id=? AND direction='out' AND status='sent' ORDER BY id DESC LIMIT 1", cl.id);
  const firstOut = first ? null : one("SELECT subject FROM messages WHERE campaign_lead_id=? AND direction='out' AND status='sent' ORDER BY id ASC LIMIT 1", cl.id);
  let subject = render(v.subject, vars).trim();
  if (!subject && firstOut) subject = /^re:/i.test(firstOut.subject) ? firstOut.subject : 'Re: ' + firstOut.subject;
  if (!subject) subject = '(no subject)';
  let html = sanitizeHtml(render(v.body, vars));
  if (mailbox.signature) html += `<div>${sanitizeHtml(mailbox.signature)}</div>`;

  const token = randomToken(12);
  const ins = run(`INSERT INTO messages (user_id,campaign_id,campaign_lead_id,lead_id,mailbox_id,step_id,variant_id,direction,from_email,to_email,subject,body,token,status,created_at)
                   VALUES (?,?,?,?,?,?,?,'out',?,?,?,?,?,'pending',?)`,
    campaign.user_id, campaign.id, cl.id, lead.id, mailbox.id, step.id, v.id, mailbox.email, lead.email, subject, html, token, now());
  const msgRow = { id: Number(ins.lastInsertRowid), token };
  try {
    const finalHtml = addTracking(campaign, msgRow, html);
    const unsub = `${config.baseUrl}/u/${token}`;
    const res = await mailer.send(mailbox, {
      to: lead.email, subject, html: finalHtml,
      inReplyTo: prevOut?.message_id, references: prevOut?.message_id,
      headers: campaign.include_unsubscribe ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    });
    run("UPDATE messages SET status='sent', message_id=?, in_reply_to=?, body=? WHERE id=?", res.messageId, prevOut?.message_id ?? null, html, msgRow.id);
    wallet.debit(campaign.user_id, config.price.email, `Email to ${lead.email} (${campaign.name})`, 'msg:' + msgRow.id);
    return msgRow.id;
  } catch (e) {
    run("UPDATE messages SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 500), msgRow.id);
    throw e;
  }
}

const jitter = (ms) => ms + Math.floor((Math.random() - 0.5) * 0.2 * ms);

async function processCampaign(campaign, ts = now()) {
  if (!inWindow(campaign, ts)) return { sent: 0, reason: 'outside window' };
  const steps = loadSteps(campaign.id);
  if (!steps.length) return { sent: 0 };
  let remaining = campaign.daily_limit - sentTodayByCampaign(campaign.id, campaign.timezone);
  let sent = 0;
  const due = all(`SELECT cl.* FROM campaign_leads cl WHERE cl.campaign_id=? AND cl.status='active' AND cl.next_send_at<=? ORDER BY cl.next_send_at LIMIT 100`, campaign.id, ts);
  for (const cl of due) {
    if (remaining <= 0) break;
    if (wallet.balance(campaign.user_id) < config.price.email) {
      run("UPDATE campaigns SET status='paused', updated_at=? WHERE id=?", now(), campaign.id);
      log(campaign.user_id, 'campaign.auto_paused', 'campaign', campaign.id, 'Insufficient wallet balance');
      return { sent, reason: 'insufficient funds' };
    }
    const lead = one('SELECT email FROM leads WHERE id=?', cl.lead_id);
    if (one('SELECT 1 x FROM unsubscribes WHERE user_id=? AND email=?', campaign.user_id, lead.email)) {
      run("UPDATE campaign_leads SET status='unsubscribed' WHERE id=?", cl.id); continue;
    }
    const mb = pickMailbox(campaign, cl, ts);
    if (!mb) continue;
    try {
      await sendStep(campaign, cl, steps, mb);
      sent++; remaining--;
      const nextIdx = cl.current_step + 1;
      if (nextIdx >= steps.length) run("UPDATE campaign_leads SET current_step=?, last_sent_at=?, mailbox_id=?, status='completed', next_send_at=NULL WHERE id=?", nextIdx, now(), mb.id, cl.id);
      else run('UPDATE campaign_leads SET current_step=?, last_sent_at=?, mailbox_id=?, next_send_at=? WHERE id=?', nextIdx, now(), mb.id, now() + jitter(steps[nextIdx].delay_days * DAY), cl.id);
    } catch (e) {
      if (e.status === 402) break;
      const permanent = /5\d\d\b.*(user unknown|no such user|mailbox unavailable|does not exist|invalid)/i.test(e.message);
      if (permanent) run("UPDATE campaign_leads SET status='bounced' WHERE id=?", cl.id);
      else if (/auth|credential|535|534|login/i.test(e.message)) {
        run("UPDATE mailboxes SET status='error', last_error=? WHERE id=?", e.message.slice(0, 300), mb.id);
        log(campaign.user_id, 'mailbox.error', 'mailbox', mb.id, e.message.slice(0, 200));
      } else run('UPDATE campaign_leads SET next_send_at=? WHERE id=?', now() + 15 * 60000, cl.id); // retry later
    }
  }
  const left = one("SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id=? AND status='active'", campaign.id).n;
  if (!left) {
    run("UPDATE campaigns SET status='completed', updated_at=? WHERE id=? AND status='active'", now(), campaign.id);
    log(campaign.user_id, 'campaign.completed', 'campaign', campaign.id);
  }
  return { sent };
}

let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    for (const c of all("SELECT * FROM campaigns WHERE status='active'")) {
      try { await processCampaign(c); } catch (e) { console.error('campaign', c.id, e.message); }
    }
  } finally { ticking = false; }
}

// ---- inbound: reply + bounce handling ----
const OOO_RE = /(out of (the )?office|auto.?reply|automatic reply|on vacation|away from (my )?(desk|email))/i;
const BOUNCE_FROM = /(mailer-daemon|postmaster)@/i;

function handleInbound(mb, parsed) {
  const from = parsed.from?.value?.[0]?.address?.toLowerCase();
  if (!from) return null;
  const subject = parsed.subject || '';
  const html = parsed.html || `<pre>${(parsed.text || '').replace(/</g, '&lt;')}</pre>`;
  const mid = parsed.messageId;
  if (mid && one('SELECT 1 x FROM messages WHERE message_id=? AND user_id=?', mid, mb.user_id)) return null; // dedupe

  // bounce
  if (BOUNCE_FROM.test(from) || /undeliver|delivery status|returned mail|failure notice/i.test(subject)) {
    const failed = (parsed.text || '').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [];
    for (const addr of failed) {
      const lead = one('SELECT id FROM leads WHERE user_id=? AND email=?', mb.user_id, addr);
      if (lead) {
        run("UPDATE campaign_leads SET status='bounced' WHERE lead_id=? AND status IN ('active','completed')", lead.id);
        run("UPDATE messages SET status='bounced' WHERE lead_id=? AND direction='out' AND mailbox_id=? AND id=(SELECT MAX(id) FROM messages WHERE lead_id=? AND direction='out')", lead.id, mb.id, lead.id);
        log(mb.user_id, 'lead.bounced', 'lead', lead.id, addr);
      }
    }
    return null;
  }
  const refs = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references])].filter(Boolean);
  let parent = null;
  for (const r of refs) { parent = one("SELECT * FROM messages WHERE message_id=? AND user_id=? AND direction='out'", r, mb.user_id); if (parent) break; }
  const lead = parent ? one('SELECT * FROM leads WHERE id=?', parent.lead_id) : one('SELECT * FROM leads WHERE user_id=? AND email=?', mb.user_id, from);
  if (!parent && !lead) return null; // unrelated mail: ignore
  const category = OOO_RE.test(subject + ' ' + (parsed.text || '').slice(0, 400)) ? 'out_of_office' : null;
  const cl = parent?.campaign_lead_id ? one('SELECT * FROM campaign_leads WHERE id=?', parent.campaign_lead_id)
    : lead ? one("SELECT * FROM campaign_leads WHERE lead_id=? ORDER BY id DESC LIMIT 1", lead.id) : null;
  const ins = run(`INSERT INTO messages (user_id,campaign_id,campaign_lead_id,lead_id,mailbox_id,direction,from_email,to_email,subject,body,message_id,in_reply_to,status,created_at)
                   VALUES (?,?,?,?,?,'in',?,?,?,?,?,?,'received',?)`,
    mb.user_id, cl?.campaign_id ?? null, cl?.id ?? null, lead?.id ?? null, mb.id, from, mb.email, subject, sanitizeHtml(html), mid ?? null, parent?.message_id ?? null, now());
  if (cl && category !== 'out_of_office') {
    const camp = one('SELECT stop_on_reply FROM campaigns WHERE id=?', cl.campaign_id);
    if (camp?.stop_on_reply) run("UPDATE campaign_leads SET status='replied', next_send_at=NULL WHERE id=? AND status IN ('active','completed')", cl.id);
  }
  if (cl && category) run('UPDATE campaign_leads SET category=? WHERE id=?', category, cl.id);
  log(mb.user_id, 'reply.received', 'message', Number(ins.lastInsertRowid), from);
  return Number(ins.lastInsertRowid);
}

async function pollMailbox(mb) {
  if (config.sendMode === 'dry' || !mb.imap_host) return 0;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow(await mailer.imapConfig(mb));
  client.on('error', () => {});
  let n = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      let maxUid = mb.imap_last_uid;
      // First poll: only look at the last 3 days instead of the whole mailbox.
      const uids = maxUid ? null : await client.search({ since: new Date(Date.now() - 3 * DAY) }, { uid: true });
      const range = maxUid ? `${maxUid + 1}:*` : (uids && uids.length ? uids.join(',') : null);
      if (range) {
        for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= maxUid) continue; // IMAP "n:*" always returns the last message
          maxUid = Math.max(maxUid, msg.uid);
          if (handleInbound(mb, await simpleParser(msg.source))) n++;
        }
      } else if (!maxUid) {
        const st = await client.status('INBOX', { uidNext: true });
        maxUid = Math.max(0, (st.uidNext || 1) - 1);
      }
      run('UPDATE mailboxes SET imap_last_uid=?, imap_checked_at=?, last_error=NULL WHERE id=?', maxUid, now(), mb.id);
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  return n;
}
let polling = false;
async function pollAll() {
  if (polling) return; polling = true;
  try {
    for (const mb of all("SELECT * FROM mailboxes WHERE status='active' AND imap_host IS NOT NULL")) {
      try { await pollMailbox(mb); } catch (e) { run('UPDATE mailboxes SET last_error=? WHERE id=?', String(e.message).slice(0, 300), mb.id); }
    }
  } finally { polling = false; }
}

function start() {
  if (!config.schedulerEnabled) return;
  setInterval(() => tick().catch(console.error), 30000).unref();
  setInterval(() => pollAll().catch(console.error), 120000).unref();
}
module.exports = { start, tick, processCampaign, pollMailbox, handleInbound, inWindow, loadSteps, localParts };
