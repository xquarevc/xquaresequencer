const dns = require('dns').promises;
const crypto = require('crypto');
const config = require('../config');

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
function normalizeDomain(input) {
  const d = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return DOMAIN_RE.test(d) ? d : null;
}

const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
const safe = async (fn) => { try { return await fn(); } catch (e) { return e.code === 'ENODATA' || e.code === 'ENOTFOUND' ? [] : null; } };

// ---------- Registrar / registration info via RDAP ----------
let rdapBootstrap = null;
async function rdapBase(tld) {
  if (!rdapBootstrap) {
    const r = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`RDAP bootstrap unreachable (HTTP ${r.status}); outbound access to data.iana.org may be blocked`);
    rdapBootstrap = (await r.json()).services;
  }
  const svc = rdapBootstrap.find(([tlds]) => tlds.includes(tld));
  return svc ? svc[1][0].replace(/\/$/, '') : null;
}
/** returns { available, registrar, createdAt, expiresAt, nameservers, status, source } */
async function registrarCheck(domain) {
  const out = { domain, available: null, registrar: null, createdAt: null, expiresAt: null, nameservers: [], status: [], source: 'rdap' };
  try {
    const tld = domain.split('.').pop();
    const base = await rdapBase(tld);
    if (!base) throw new Error(`No RDAP server for .${tld}`);
    const r = await fetch(`${base}/domain/${domain}`, { headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(10000) });
    if (r.status === 404) { out.available = true; }
    else if (r.ok) {
      const j = await r.json();
      out.available = false;
      out.status = j.status || [];
      out.nameservers = (j.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase()).filter(Boolean);
      for (const ev of j.events || []) {
        if (ev.eventAction === 'registration') out.createdAt = Date.parse(ev.eventDate) || null;
        if (ev.eventAction === 'expiration') out.expiresAt = Date.parse(ev.eventDate) || null;
      }
      const reg = (j.entities || []).find((e) => (e.roles || []).includes('registrar'));
      const fn = reg?.vcardArray?.[1]?.find((x) => x[0] === 'fn');
      out.registrar = fn?.[3] || reg?.publicIds?.[0]?.identifier || null;
    } else throw new Error(`RDAP responded ${r.status}`);
  } catch (e) {
    out.error = e.message;
    // Fallback: DNS heuristic (NXDOMAIN ≠ proof of availability, flagged as such)
    const ns = await safe(() => resolver.resolveNs(domain));
    if (ns && ns.length) { out.available = false; out.nameservers = ns; out.source = 'dns-fallback'; }
  }
  if (config.godaddy.key && out.available !== false) {
    try {
      const r = await fetch(`${config.godaddy.api}/v1/domains/available?domain=${encodeURIComponent(domain)}`, {
        headers: { Authorization: `sso-key ${config.godaddy.key}:${config.godaddy.secret}` }, signal: AbortSignal.timeout(10000),
      });
      if (r.ok) { const j = await r.json(); out.available = !!j.available; out.price = j.price ? j.price / 1e6 : null; out.currency = j.currency; out.source = 'godaddy'; }
    } catch {}
  }
  return out;
}

// ---------- DNS health: MX / SPF / DKIM / DMARC ----------
const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 'k2', 'mail', 'dkim', 's1', 's2', 'smtp'];
const flat = (recs) => (recs || []).map((r) => r.join(''));

async function dnsCheck(domain, ownSelector) {
  const [mx, txt, dmarcTxt, a] = await Promise.all([
    safe(() => resolver.resolveMx(domain)), safe(() => resolver.resolveTxt(domain)),
    safe(() => resolver.resolveTxt('_dmarc.' + domain)), safe(() => resolver.resolve4(domain)),
  ]);
  const spfRec = flat(txt).find((t) => /^v=spf1\b/i.test(t));
  const dmarcRec = flat(dmarcTxt).find((t) => /^v=DMARC1\b/i.test(t));
  const selectors = [...new Set([ownSelector, ...DKIM_SELECTORS].filter(Boolean))];
  const dk = await Promise.all(selectors.map(async (s) => {
    const t = flat(await safe(() => resolver.resolveTxt(`${s}._domainkey.${domain}`))).find((x) => /v=DKIM1|k=rsa|p=/i.test(x));
    return t ? { selector: s, record: t } : null;
  }));
  const dkim = dk.filter(Boolean);

  const spfIssues = [];
  if (spfRec) {
    if (!/[-~]all\b/.test(spfRec)) spfIssues.push('SPF has no "-all"/"~all" terminator');
    if (/\+all\b/.test(spfRec)) spfIssues.push('SPF uses "+all" which allows anyone to send');
    const lookups = (spfRec.match(/\b(include:|a\b|mx\b|ptr\b|exists:|redirect=)/g) || []).length;
    if (lookups > 10) spfIssues.push(`SPF likely exceeds 10 DNS lookups (${lookups})`);
  }
  const dmarcPolicy = dmarcRec?.match(/\bp=(none|quarantine|reject)/i)?.[1]?.toLowerCase() || null;
  const result = {
    mx: { ok: !!(mx && mx.length), records: (mx || []).sort((x, y) => x.priority - y.priority).map((m) => `${m.priority} ${m.exchange}`) },
    spf: { ok: !!spfRec && spfIssues.length === 0, record: spfRec || null, issues: spfRec ? spfIssues : ['No SPF record found'] },
    dkim: { ok: dkim.length > 0, records: dkim, issues: dkim.length ? [] : ['No DKIM record found for common selectors'] },
    dmarc: {
      ok: !!dmarcRec && dmarcPolicy !== 'none', record: dmarcRec || null, policy: dmarcPolicy,
      issues: !dmarcRec ? ['No DMARC record found'] : dmarcPolicy === 'none' ? ['DMARC policy is "none" (monitoring only)'] : [],
    },
    a: a || [],
  };
  const checks = ['mx', 'spf', 'dkim', 'dmarc'];
  result.score = Math.round((checks.filter((c) => result[c].ok).length / checks.length) * 100);
  return result;
}

function recommendedRecords(domain, selector, dkimPublic) {
  const recs = [
    { type: 'TXT', host: '@', value: 'v=spf1 include:_spf.google.com include:spf.protection.outlook.com ~all', note: 'SPF – edit includes to match the providers you actually send from' },
    { type: 'TXT', host: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; adkim=r; aspf=r; pct=100`, note: 'DMARC – start with p=none to monitor, then tighten' },
  ];
  if (dkimPublic) recs.push({ type: 'TXT', host: `${selector}._domainkey`, value: `v=DKIM1; k=rsa; p=${dkimPublic}`, note: 'DKIM – outgoing mail from this platform is signed with the matching private key' });
  return recs;
}

function generateDkim() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { selector: 'xs' + new Date().toISOString().slice(0, 7).replace('-', ''), publicKey: pub, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// ---------- Blacklists (DNSBL) ----------
const IP_LISTS = [
  ['Spamhaus ZEN', 'zen.spamhaus.org'], ['Barracuda', 'b.barracudacentral.org'], ['SpamCop', 'bl.spamcop.net'],
  ['SORBS', 'dnsbl.sorbs.net'], ['PSBL', 'psbl.surriel.com'], ['UCEPROTECT L1', 'dnsbl-1.uceprotect.net'],
  ['Mailspike', 'bl.mailspike.net'], ['Truncate', 'truncate.gbudb.net'],
];
const DOMAIN_LISTS = [['Spamhaus DBL', 'dbl.spamhaus.org'], ['SURBL', 'multi.surbl.org'], ['URIBL', 'multi.uribl.com']];

async function queryList(name, zone, target) {
  try {
    const ans = await resolver.resolve4(`${target}.${zone}`);
    // Spamhaus returns 127.255.255.x when the querying resolver is blocked/rate-limited: not a listing.
    if (ans.some((a) => a.startsWith('127.255.255.'))) return { list: name, zone, target, status: 'unknown', note: 'Query refused (public resolver blocked by list)' };
    return { list: name, zone, target, status: 'listed', response: ans.join(',') };
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return { list: name, zone, target, status: 'clean' };
    return { list: name, zone, target, status: 'unknown', note: e.code || e.message };
  }
}
const reverseIp = (ip) => ip.split('.').reverse().join('.');

async function blacklistCheck(domain) {
  const mx = (await safe(() => resolver.resolveMx(domain))) || [];
  const hosts = [domain, ...mx.map((m) => m.exchange)].slice(0, 4);
  const ips = new Set();
  for (const h of hosts) for (const ip of (await safe(() => resolver.resolve4(h))) || []) ips.add(ip);
  const jobs = [];
  for (const [n, z] of DOMAIN_LISTS) jobs.push(queryList(n, z, domain));
  for (const ip of [...ips].slice(0, 6)) for (const [n, z] of IP_LISTS) jobs.push(queryList(n, z, reverseIp(ip)).then((r) => ({ ...r, ip })));
  const results = await Promise.all(jobs);
  const listed = results.filter((r) => r.status === 'listed');
  const unknown = results.filter((r) => r.status === 'unknown').length;
  return {
    status: listed.length ? 'listed' : unknown === results.length ? 'unknown' : 'clean',
    ips: [...ips], checked: results.length, unknown, listed, results,
  };
}

module.exports = { normalizeDomain, registrarCheck, dnsCheck, recommendedRecords, generateDkim, blacklistCheck };
