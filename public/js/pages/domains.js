import { esc, api, num, ago, date, badge, attempt, modal, confirmDialog, toast, $, usd } from '../ui.js';
import { state } from '../app.js';

const dnsBadge = (label, c) => (c ? badge(label + (c.ok ? ' ✓' : ' ✕'), c.ok ? 'ok' : 'bad') : badge(label + ' ?', 'gray'));

export async function domains(root) {
  const draw = async () => {
    const { domains: list } = await api('GET', '/domains');
    root.innerHTML = `<div class="page-head"><h1>Domains</h1><button class="primary" id="add">+ Add domain</button></div>
      <div class="card mb"><h3>Registrar & availability check</h3><div class="row"><input id="lookup" placeholder="example.com" style="max-width:320px"><button id="do-lookup">Check</button></div><div id="lookup-out" class="mt-s"></div>
        <div class="muted small mt-s">Uses public RDAP (and GoDaddy's API when configured) to show availability, registrar, creation and expiry dates, and nameservers.</div></div>
      ${list.length ? list.map(card).join('') : '<div class="card empty"><h2>No domains yet</h2><p>Add your sending domains to monitor DNS health (SPF, DKIM, DMARC), blacklists and registration expiry.</p></div>'}`;
    root._list = list;
  };
  const card = (d) => {
    const dns = d.dns;
    const exp = d.expires_at ? Math.round((d.expires_at - Date.now()) / 86400000) : null;
    return `<div class="card mb" data-d="${d.id}"><div class="row between wrap"><div><h2 style="margin:0">${esc(d.name)}</h2><div class="muted small">${d.mailboxes} mailbox(es) · registrar: ${esc(d.registrar || 'unknown')}${exp !== null ? ` · expires ${date(d.expires_at)} ${exp < 30 ? badge(exp + ' days', exp < 0 ? 'bad' : 'warn') : ''}` : ''}</div></div>
      <div class="row wrap gap-s"><button class="sm" data-a="dns">Check DNS</button><button class="sm" data-a="reg">Registrar</button><button class="sm" data-a="bl" title="Costs ${usd(state.config.pricing.blacklist, 3)}">Blacklist check</button><button class="sm" data-a="dkim">${d.dkim ? 'Rotate DKIM' : 'Generate DKIM'}</button><button class="sm" data-a="rec">DNS records</button><button class="sm danger" data-a="del">Remove</button></div></div>
      <div class="row wrap gap-s mt">${dns ? `${dnsBadge('MX', dns.mx)} ${dnsBadge('SPF', dns.spf)} ${dnsBadge('DKIM', dns.dkim)} ${dnsBadge('DMARC', dns.dmarc)} <span class="muted small">health ${dns.score}% · ${ago(d.dns_checked_at)}</span>` : '<span class="muted">DNS not checked yet</span>'}
        <span style="margin-left:auto">${d.blacklist_status ? badge('blacklist: ' + d.blacklist_status, { clean: 'ok', listed: 'bad', unknown: 'warn' }[d.blacklist_status]) + ` <span class="muted small">${ago(d.blacklist_checked_at)}</span>` : badge('blacklist: not checked', 'gray')}</span></div>
      ${dns ? [...dns.spf.issues, ...dns.dkim.issues, ...dns.dmarc.issues, ...(dns.mx.ok ? [] : ['No MX records'])].map((i) => `<div class="small mt-s" style="color:var(--warn)">⚠ ${esc(i)}</div>`).join('') : ''}
      ${d.blacklist?.listed?.length ? `<div class="alert bad mt">Listed on: ${d.blacklist.listed.map((l) => `<b>${esc(l.list)}</b> (${esc(l.target)})`).join(', ')}</div>` : ''}
      ${d.blacklist && !d.blacklist.listed.length ? `<div class="muted small mt-s">${d.blacklist.checked - d.blacklist.unknown}/${d.blacklist.checked} blacklist lookups answered, none listed${d.blacklist.unknown ? ` · ${d.blacklist.unknown} inconclusive (public DNS resolvers are blocked by some lists)` : ''}.</div>` : ''}</div>`;
  };
  const showRecords = (recs, title = 'DNS records to publish') => modal({ title, subtitle: 'Add these at your DNS provider, then run “Check DNS”.', wide: true, actions: false,
    body: recs.map((r) => `<div class="rec"><div class="row between"><b>${esc(r.type)}</b><span class="muted small">${esc(r.note)}</span></div><div class="small muted mt-s">Host</div><code>${esc(r.host)}</code><div class="small muted mt-s">Value</div><code>${esc(r.value)}</code></div>`).join('') + '<div class="actions"><button data-x="cancel">Close</button></div>' });

  root.onclick = async (e) => {
    if (e.target.id === 'add') return modal({ title: 'Add domain', body: '<label>Domain</label><input name="name" placeholder="yourcompany.com">', okText: 'Add & scan', onOk: async (m) => { await api('POST', '/domains', { name: $('[name=name]', m).value }); toast('Domain added', 'ok'); draw(); } });
    if (e.target.id === 'do-lookup') {
      const out = $('#lookup-out', root); out.textContent = 'Checking…';
      try { const r = await api('GET', '/domains/lookup?name=' + encodeURIComponent($('#lookup', root).value));
        out.innerHTML = r.available === true ? `<div class="alert ok"><b>${esc(r.domain)}</b> appears to be <b>available</b> to register${r.price ? ` (~${r.price} ${esc(r.currency || 'USD')})` : ''}. <span class="small">(${esc(r.source)})</span></div>`
          : r.available === false ? `<div class="alert"><b>${esc(r.domain)}</b> is registered${r.registrar ? ' with <b>' + esc(r.registrar) + '</b>' : ''}${r.expiresAt ? ', expires ' + date(r.expiresAt) : ''}${r.createdAt ? ', created ' + date(r.createdAt) : ''}.${r.nameservers?.length ? '<br><span class="small">NS: ' + r.nameservers.map(esc).join(', ') + '</span>' : ''}</div>`
          : `<div class="alert warn">Could not determine availability${r.error ? ': ' + esc(r.error) : ''}.</div>`;
      } catch (err) { out.innerHTML = `<div class="alert bad">${esc(err.message)}</div>`; }
      return;
    }
    const b = e.target.closest('[data-a]'); if (!b) return;
    const id = +b.closest('[data-d]').dataset.d, d = root._list.find((x) => x.id === id);
    const busy = async (fn, ok) => { b.disabled = true; const r = await attempt(fn, ok); b.disabled = false; return r; };
    if (b.dataset.a === 'dns') { const r = await busy(() => api('POST', `/domains/${id}/check-dns`), 'DNS checked'); if (r) draw(); }
    if (b.dataset.a === 'reg') { const r = await busy(() => api('POST', `/domains/${id}/check-registrar`), 'Registrar info updated'); if (r) draw(); }
    if (b.dataset.a === 'bl') { const r = await busy(() => api('POST', `/domains/${id}/check-blacklist`), 'Blacklist check complete'); if (r) draw(); }
    if (b.dataset.a === 'dkim') { if (d.dkim && !(await confirmDialog('Rotate DKIM key', 'This creates a new key pair and selector. Publish the new DNS record before sending more email.', 'Rotate', false))) return; const r = await busy(() => api('POST', `/domains/${id}/dkim`)); if (r) { showRecords(r.records.filter((x) => x.host.includes('_domainkey')), 'Publish this DKIM record'); draw(); } }
    if (b.dataset.a === 'rec') { const r = await busy(() => api('GET', `/domains/${id}/records`)); if (r) showRecords(r.records); }
    if (b.dataset.a === 'del') { if (await confirmDialog('Remove domain', `Remove <b>${esc(d.name)}</b> from monitoring? (Does not affect your DNS.)`, 'Remove')) { await attempt(() => api('DELETE', `/domains/${id}`), 'Removed'); draw(); } }
  };
  await draw();
  return () => { root.onclick = null; };
}
