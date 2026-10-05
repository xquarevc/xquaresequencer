// Variables {{first_name}} (with fallback {{first_name|there}}), spintax {a|b|c}, HTML helpers.
const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g;

function renderVars(text, vars) {
  return String(text ?? '').replace(VAR_RE, (_, k, fb) => {
    const v = vars[k.toLowerCase()];
    return v != null && String(v).trim() !== '' ? String(v) : (fb ?? '');
  });
}
// {Hi|Hello|Hey} -> random option. Nested supported (innermost first). Doesn't touch {{vars}}.
function spin(text, rnd = Math.random) {
  let s = String(text ?? '');
  const re = /(?<!\{)\{([^{}]*\|[^{}]*)\}(?!\})/; // skip {{var|fallback}}
  for (let i = 0; i < 200 && re.test(s); i++) {
    s = s.replace(re, (_, g) => { const o = g.split('|'); return o[Math.floor(rnd() * o.length)]; });
  }
  return s;
}
function leadVars(lead, mailbox) {
  const custom = (() => { try { return JSON.parse(lead.custom_json || '{}'); } catch { return {}; } })();
  const v = {
    first_name: lead.first_name, last_name: lead.last_name, email: lead.email,
    company: lead.company, phone: lead.phone, website: lead.website, title: lead.title,
    full_name: [lead.first_name, lead.last_name].filter(Boolean).join(' '),
    sender_name: mailbox?.from_name, sender_email: mailbox?.email,
  };
  for (const [k, val] of Object.entries(custom)) v[String(k).toLowerCase()] = val;
  return v;
}
const render = (text, vars, rnd) => renderVars(spin(text, rnd), vars);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
// Allow-list sanitizer for the rich-text editor output (also used before rendering previews).
function sanitizeHtml(html) {
  let s = String(html ?? '');
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta)[\s\S]*?(<\/\1>|$)/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta)\b[^>]*>/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, '$1=$2#$2');
  return s;
}
module.exports = { renderVars, spin, render, leadVars, escapeHtml, htmlToText, sanitizeHtml };
