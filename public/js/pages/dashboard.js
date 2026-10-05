import { esc, api, usd, pct, num, ago, badge } from '../ui.js';

const ACTION_LABEL = (a) => a.replace(/[._]/g, ' ');

export async function dashboard(root) {
  const d = await api('GET', '/dashboard');
  const t = d.totals, c = d.counts;
  // build 14-day series
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const map = (dir) => Object.fromEntries(d.series.filter((s) => s.direction === dir).map((s) => [s.d, s.n]));
  const out = map('out'), inn = map('in');
  const max = Math.max(1, ...days.map((x) => Math.max(out[x] || 0, inn[x] || 0)));
  const setup = [
    [c.mailboxes > 0, 'Connect an email account', '#/mailboxes'],
    [c.domains > 0, 'Add & verify your sending domain (SPF / DKIM / DMARC)', '#/domains'],
    [c.leads > 0, 'Import your leads', '#/leads'],
    [c.campaigns > 0, 'Create your first campaign', '#/campaigns'],
    [d.balance_micros > 0, 'Add funds to your wallet', '#/wallet'],
  ];
  const done = setup.filter((s) => s[0]).length;
  root.innerHTML = `
    <div class="page-head"><h1>Dashboard</h1><a class="btn primary" href="#/campaigns">+ New campaign</a></div>
    ${c.mailboxes_error ? `<div class="alert bad">${c.mailboxes_error} email account(s) have errors. <a href="#/mailboxes">Fix now</a></div>` : ''}
    ${c.domains_listed ? `<div class="alert bad">${c.domains_listed} domain(s) are on a blacklist. <a href="#/domains">Review</a></div>` : ''}
    ${d.balance_micros < 20000 ? `<div class="alert warn">Wallet balance is low (${usd(d.balance_micros)}). Campaigns pause automatically at zero. <a href="#/wallet">Add funds</a></div>` : ''}
    <div class="grid g6">
      ${[['Emails sent', num(t.sent)], ['Open rate', pct(t.open_rate)], ['Reply rate', pct(t.reply_rate)], ['Bounce rate', pct(t.bounce_rate)], ['Active campaigns', c.campaigns_active], ['Unread replies', c.unread]]
        .map(([l, v]) => `<div class="card stat"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}
    </div>
    <div class="grid g2 mt" style="grid-template-columns:2fr 1fr">
      <div class="card"><div class="row between"><h2>Last 14 days</h2><div class="legend"><span><i style="background:var(--brand)"></i>Sent</span><span><i style="background:var(--ok)"></i>Replies</span></div></div>
        <div class="chart">${days.map((x) => `<div class="col" title="${x}: ${out[x] || 0} sent, ${inn[x] || 0} replies"><div class="bars"><div class="bar" style="height:${((out[x] || 0) / max) * 100}%"></div><div class="bar b2" style="height:${((inn[x] || 0) / max) * 100}%"></div></div><div class="x">${x.slice(8)}</div></div>`).join('')}</div>
      </div>
      <div class="card"><h2>Get started <span class="muted small">${done}/${setup.length}</span></h2>
        <div class="progress mb"><div style="width:${(done / setup.length) * 100}%"></div></div>
        ${setup.map(([ok, label, href]) => `<div class="row gap-s mt-s">${ok ? badge('✓', 'ok') : badge('•', 'gray')}<a href="${href}" ${ok ? 'class="muted"' : ''}>${esc(label)}</a></div>`).join('')}
      </div>
    </div>
    <div class="card mt"><div class="row between"><h2>Recent activity</h2><a href="#/activity">View all</a></div>
      ${d.recent.length ? `<table><tbody>${d.recent.map((a) => `<tr><td>${esc(ACTION_LABEL(a.action))}</td><td class="muted">${esc((a.detail || '').slice(0, 80))}</td><td class="right muted nowrap">${ago(a.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing yet.</div>'}
    </div>`;
}
