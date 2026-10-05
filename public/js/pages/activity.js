import { esc, api, dt, $ } from '../ui.js';

export async function activity(root) {
  let q = '', logs = [], more = true;
  const load = async (reset) => {
    if (reset) { logs = []; more = true; }
    const before = logs.length ? logs[logs.length - 1].id : '';
    const r = await api('GET', `/activity?limit=50${before ? '&before=' + before : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    logs.push(...r.logs); more = r.logs.length === 50;
    draw();
  };
  const draw = () => {
    root.innerHTML = `<div class="page-head"><h1>Activity Log</h1><input id="q" placeholder="Filter (e.g. mailbox, login, campaign)…" value="${esc(q)}" style="max-width:320px"></div>
      <div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Details</th><th>IP</th></tr></thead><tbody>
      ${logs.map((l) => `<tr><td class="nowrap muted small">${dt(l.created_at)}</td><td><b>${esc(l.action)}</b></td><td class="muted">${esc((l.detail || '').slice(0, 160))}</td><td class="muted small">${esc(l.ip || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No activity</td></tr>'}</tbody></table></div>
      ${more ? '<div class="mt"><button id="more">Load more</button></div>' : ''}`;
    const i = $('#q', root); i.onchange = () => { q = i.value.trim(); load(true); };
    $('#more', root)?.addEventListener('click', () => load(false));
  };
  await load(true);
}
