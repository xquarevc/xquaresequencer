const nodemailer = require('nodemailer');
const crypto = require('crypto');
const config = require('../config');
const { one, run, now } = require('../db');
const { encrypt, decrypt } = require('../lib/security');
const oauth = require('./oauth');
const { htmlToText, escapeHtml } = require('../lib/template');

const PRESETS = {
  google: { smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.gmail.com', imap_port: 993 },
  microsoft: { smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: 0, imap_host: 'outlook.office365.com', imap_port: 993 },
};

/** Returns a fresh OAuth access token for oauth mailboxes (refreshing if needed). */
async function accessToken(mb) {
  if (mb.oauth_access_enc && mb.oauth_expires_at && mb.oauth_expires_at - 60000 > now()) return decrypt(mb.oauth_access_enc);
  const rt = decrypt(mb.oauth_refresh_enc);
  if (!rt) throw new Error('Mailbox needs to be reconnected (no refresh token)');
  const j = await oauth.refresh(mb.provider, rt);
  const exp = now() + (j.expires_in || 3600) * 1000;
  run('UPDATE mailboxes SET oauth_access_enc=?, oauth_expires_at=?, oauth_refresh_enc=COALESCE(?,oauth_refresh_enc) WHERE id=?',
    encrypt(j.access_token), exp, j.refresh_token ? encrypt(j.refresh_token) : null, mb.id);
  return j.access_token;
}

async function authFor(mb, kind) {
  if (mb.provider === 'smtp') {
    const user = kind === 'smtp' ? mb.smtp_user : mb.imap_user;
    const pass = decrypt(kind === 'smtp' ? mb.smtp_pass_enc : mb.imap_pass_enc);
    return { user, pass };
  }
  return { type: 'OAuth2', user: mb.email, accessToken: await accessToken(mb) };
}

async function buildTransport(mb) {
  const auth = await authFor(mb, 'smtp');
  return nodemailer.createTransport({
    host: mb.smtp_host, port: mb.smtp_port, secure: !!mb.smtp_secure, requireTLS: !mb.smtp_secure,
    auth, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}
async function imapConfig(mb) {
  const auth = await authFor(mb, 'imap');
  const a = auth.type ? { user: auth.user, accessToken: auth.accessToken } : auth;
  return { host: mb.imap_host, port: mb.imap_port, secure: mb.imap_secure !== 0, auth: a, logger: false, socketTimeout: 60000 };
}

function dkimFor(mb) {
  const domain = mb.email.split('@')[1];
  const d = one('SELECT * FROM domains WHERE user_id=? AND name=?', mb.user_id, domain);
  if (!d || !d.dkim_private_enc) return undefined;
  return { domainName: domain, keySelector: d.dkim_selector, privateKey: decrypt(d.dkim_private_enc) };
}

/** Send one message. Returns {messageId}. In dry mode nothing leaves the process. */
async function send(mb, { to, subject, html, text, inReplyTo, references, headers }) {
  const messageId = `<${crypto.randomUUID()}@${mb.email.split('@')[1]}>`;
  if (config.sendMode === 'dry') return { messageId, dry: true };
  const transport = await buildTransport(mb);
  try {
    await transport.sendMail({
      from: { name: mb.from_name || '', address: mb.email }, to, subject, html, text: text ?? htmlToText(html),
      messageId, inReplyTo, references, headers, dkim: dkimFor(mb),
    });
  } finally { transport.close(); }
  return { messageId };
}

/** Verify SMTP (and IMAP if configured) credentials. */
async function verifyMailbox(mb) {
  const out = { smtp: null, imap: null };
  if (config.sendMode === 'dry') return { smtp: { ok: true, note: 'dry-run mode: not contacted' }, imap: { ok: true, note: 'dry-run mode: not contacted' } };
  try { const t = await buildTransport(mb); await t.verify(); t.close(); out.smtp = { ok: true }; }
  catch (e) { out.smtp = { ok: false, error: e.message }; }
  if (mb.imap_host) {
    try {
      const { ImapFlow } = require('imapflow');
      const c = new ImapFlow(await imapConfig(mb));
      c.on('error', () => {});
      await c.connect(); await c.logout(); out.imap = { ok: true };
    } catch (e) { out.imap = { ok: false, error: e.message }; }
  }
  return out;
}

// ----- tracking injection -----
function wrapLinks(html, messageRowId, insertLink) {
  return html.replace(/<a\s([^>]*?)href="(https?:\/\/[^"]+)"([^>]*)>/gi, (m, pre, url, post) => {
    if (url.startsWith(config.baseUrl + '/u/')) return m;
    return `<a ${pre}href="${insertLink(messageRowId, url)}"${post}>`;
  });
}
function footerUnsub(token) {
  const u = `${config.baseUrl}/u/${token}`;
  return `<div style="margin-top:24px;font-size:11px;color:#888">If you'd rather not hear from me, <a href="${escapeHtml(u)}" style="color:#888">unsubscribe</a>.</div>`;
}

module.exports = { send, verifyMailbox, imapConfig, accessToken, wrapLinks, footerUnsub, PRESETS };
