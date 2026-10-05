import { esc, api, pct, num, ago, dt, badge, attempt, modal, confirmDialog, toast, $, $$ } from '../ui.js';
import { go } from '../app.js';

const STATUS = { draft: 'gray', active: 'ok', paused: 'warn', completed: '' };
export const statusBadge = (s) => badge(s, STATUS[s] ?? '');

export async function list(root) {
  const draw = async () => {
    const { campaigns } = await api('GET', '/campaigns');
    root.innerHTML = `<div class="page-head"><h1>Campaigns</h1><button class="primary" id="new">+ New campaign</button></div>
      ${campaigns.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Leads</th><th>Sent</th><th>Open</th><th>Reply</th><th>Bounce</th><th></th></tr></thead><tbody>
      ${campaigns.map((c) => { const s = c.stats; return `<tr>
        <td><a href="#/campaigns/${c.id}"><b>${esc(c.name)}</b></a></td><td>${statusBadge(c.status)}</td><td>${num(s.leads)}</td><td>${num(s.sent)}</td>
        <td>${s.sent ? pct(s.opened / s.sent) : '—'}</td><td>${s.sent ? pct(s.replied / s.sent) : '—'}</td><td>${s.sent ? pct(s.bounced / s.sent) : '—'}</td>
        <td class="right">
          ${c.status === 'active' ? `<button class="sm" data-a="pause" data-id="${c.id}">Pause</button>` : c.status === 'paused' ? `<button class="sm" data-a="resume" data-id="${c.id}">Resume</button>` : ''}
          <a class="btn sm" href="#/campaigns/${c.id}/edit">Edit</a>
          <button class="sm" data-a="dup" data-id="${c.id}">Duplicate</button>
          <button class="sm danger" data-a="del" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button></td></tr>`; }).join('')}
      </tbody></table></div>` : `<div class="card empty"><h2>No campaigns yet</h2><p>Build a multi-step drip sequence with variants, delays and smart sending windows.</p><button class="primary" id="new2">Create your first campaign</button></div>`}`;
  };
  const create = () => modal({ title: 'New campaign', body: '<label>Campaign name</label><input name="name" placeholder="e.g. Q4 SaaS founders" maxlength="120">', okText: 'Create & continue',
    onOk: async (el) => { const name = $('[name=name]', el).value.trim() || 'Untitled campaign'; const r = await api('POST', '/campaigns', { name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); go(`/campaigns/${r.id}/edit`); } });
  root.addEventListener('click', async (e) => {
    if (e.target.closest('#new,#new2')) return create();
    const b = e.target.closest('[data-a]'); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.a === 'pause') await attempt(() => api('POST', `/campaigns/${id}/pause`), 'Paused');
    if (b.dataset.a === 'resume') await attempt(() => api('POST', `/campaigns/${id}/resume`), 'Resumed');
    if (b.dataset.a === 'dup') { const r = await attempt(() => api('POST', `/campaigns/${id}/duplicate`), 'Duplicated'); if (r?.id) go(`/campaigns/${r.id}/edit`); return; }
    if (b.dataset.a === 'del') { if (!(await confirmDialog('Delete campaign', `Delete <b>${esc(b.dataset.name)}</b> and all its sending history? This cannot be undone.`, 'Delete'))) return; await attempt(() => api('DELETE', `/campaigns/${id}`), 'Deleted'); }
    draw();
  });
  await draw();
}

export async function detail(root, [id]) {
  let tab = 'overview', page = 0, leadStatus = '';
  const draw = async () => {
    const { campaign: c } = await api('GET', `/campaigns/${id}`);
    const s = c.stats;
    const rate = (n) => (s.sent ? pct(n / s.sent) : '—');
    let content = '';
    if (tab === 'overview') {
      const an = await api('GET', `/campaigns/${id}/analytics`);
      content = `<div class="grid g6">${[['Leads', num(s.leads)], ['Sent', num(s.sent)], ['Opened', `${num(s.opened)} · ${rate(s.opened)}`], ['Clicked', `${num(s.clicked)} · ${rate(s.clicked)}`], ['Replied', `${num(s.replied)} · ${rate(s.replied)}`], ['Bounced', `${num(s.bounced)} · ${rate(s.bounced)}`]]
        .map(([l, v]) => `<div class="card stat"><div class="l">${l}</div><div class="v" style="font-size:20px">${v}</div></div>`).join('')}</div>
        <div class="card mt"><h2>Sequence performance</h2><div class="table-wrap" style="border:0"><table><thead><tr><th>Step</th><th>Subject / variant</th><th>Sent</th><th>Open</th><th>Click</th><th>Replies</th></tr></thead><tbody>
        ${an.variants.map((v) => `<tr><td>${v.position + 1}</td><td>${esc(v.subject || '(threaded follow-up)')}</td><td>${num(v.sent)}</td><td>${v.sent ? pct(v.opened / v.sent) : '—'}</td><td>${v.sent ? pct(v.clicked / v.sent) : '—'}</td><td>${v.sent ? pct(v.replied / v.sent) : '—'}</td></tr>`).join('')}
        </tbody></table></div></div>
        <div class="card mt"><h2>Settings</h2><dl class="kv"><dt>Schedule</dt><dd>${c.send_days.map((d) => 'SMTWTFS'[d]).join(' ')} · ${c.send_start}:00–${c.send_end}:00 (${esc(c.timezone)})</dd><dt>Daily limit</dt><dd>${num(c.daily_limit)}</dd><dt>Steps</dt><dd>${c.steps.length}</dd><dt>Mailboxes</dt><dd>${c.mailbox_ids.length}</dd><dt>Tracking</dt><dd>${[c.track_opens && 'opens', c.track_clicks && 'clicks'].filter(Boolean).join(', ') || 'off'}</dd></dl></div>`;
    } else {
      const r = await api('GET', `/campaigns/${id}/leads?limit=25&offset=${page * 25}${leadStatus ? '&status=' + leadStatus : ''}`);
      content = `<div class="row mb"><select id="lf" style="width:auto">${['', 'active', 'replied', 'completed', 'bounced', 'unsubscribed'].map((x) => `<option value="${x}" ${x === leadStatus ? 'selected' : ''}>${x || 'All statuses'}</option>`).join('')}</select><span class="muted">${num(r.total)} leads</span></div>
        <div class="table-wrap"><table><thead><tr><th>Lead</th><th>Company</th><th>Status</th><th>Step</th><th>Next send</th><th>Last sent</th></tr></thead><tbody>
        ${r.leads.map((l) => `<tr><td>${esc(l.email)}<div class="muted small">${esc([l.first_name, l.last_name].join(' '))}</div></td><td>${esc(l.company)}</td><td>${badge(l.status, { replied: 'ok', bounced: 'bad', unsubscribed: 'warn', completed: '' }[l.status] ?? 'gray')}${l.category ? ' ' + badge(l.category.replace(/_/g, ' '), 'gray') : ''}</td><td>${l.current_step}/${c.steps.length}</td><td>${l.next_send_at ? dt(l.next_send_at) : '—'}</td><td>${ago(l.last_sent_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No leads</td></tr>'}
        </tbody></table></div>
        <div class="row mt"><button class="sm" id="prev" ${page ? '' : 'disabled'}>← Prev</button><button class="sm" id="next" ${(page + 1) * 25 >= r.total ? 'disabled' : ''}>Next →</button></div>`;
    }
    root.innerHTML = `<div class="page-head"><div><a href="#/campaigns" class="muted small">← Campaigns</a><h1>${esc(c.name)} ${statusBadge(c.status)}</h1></div>
      <div class="row">${c.status === 'active' ? '<button id="pause">Pause</button>' : c.status === 'paused' ? '<button class="primary" id="resume">Resume</button>' : c.status === 'draft' ? '<button class="primary" id="launch">Launch</button>' : ''}<a class="btn" href="#/campaigns/${c.id}/edit">Edit</a></div></div>
      <div class="tabs"><button data-t="overview" class="${tab === 'overview' ? 'active' : ''}">Overview</button><button data-t="leads" class="${tab === 'leads' ? 'active' : ''}">Leads</button></div>${content}`;
  };
  root.onclick = async (e) => {
    const t = e.target.closest('[data-t]'); if (t) { tab = t.dataset.t; page = 0; return draw(); }
    const post = async (a, m) => { await attempt(() => api('POST', `/campaigns/${id}/${a}`), m); draw(); };
    if (e.target.id === 'pause') post('pause', 'Paused'); if (e.target.id === 'resume') post('resume', 'Resumed'); if (e.target.id === 'launch') post('launch', 'Launched!');
    if (e.target.id === 'prev') { page--; draw(); } if (e.target.id === 'next') { page++; draw(); }
  };
  root.onchange = (e) => { if (e.target.id === 'lf') { leadStatus = e.target.value; page = 0; draw(); } };
  await draw();
  const timer = setInterval(() => { if (!document.querySelector('.modal-bg')) draw(); }, 20000);
  return () => { clearInterval(timer); root.onclick = root.onchange = null; };
}
