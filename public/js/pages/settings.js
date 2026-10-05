import { esc, api, dt, usd, badge, attempt, modal, confirmDialog, toast, $, formData } from '../ui.js';
import { state } from '../app.js';

export async function settings(root) {
  const draw = async () => {
    const { keys } = (await api('GET', '/api-keys'));
    const u = state.user;
    const origin = location.origin;
    root.innerHTML = `<div class="page-head"><h1>Settings & API</h1></div>
      <div class="grid g2" style="align-items:start">
        <div class="card"><h2>Profile</h2><form id="profile"><label>Name</label><input name="name" value="${esc(u.name)}" maxlength="80"><label>Email</label><input value="${esc(u.email)}" disabled>
          <div class="mt-s">${u.google ? badge('Google linked', 'ok') : ''} ${u.microsoft ? badge('Microsoft linked', 'ok') : ''}</div><button class="primary mt" type="submit">Save profile</button></form></div>
        <div class="card"><h2>${u.has_password ? 'Change password' : 'Set a password'}</h2><form id="pw">${u.has_password ? '<label>Current password</label><input name="current" type="password" autocomplete="current-password">' : ''}
          <label>New password (min 8)</label><input name="next" type="password" minlength="8" required autocomplete="new-password"><button class="primary mt" type="submit">Update password</button></form></div>
      </div>
      <div class="card mt"><div class="row between"><h2>API keys</h2><button id="new-key">+ Create key</button></div>
        <p class="muted">Authenticate with <code>Authorization: Bearer xs_…</code>. Keys have the same access as your account. Every endpoint the dashboard uses is available: <code>/api/mailboxes</code>, <code>/api/domains</code>, <code>/api/leads</code>, <code>/api/campaigns</code>, <code>/api/inbox</code>, <code>/api/wallet</code>, <code>/api/activity</code>.</p>
        ${keys.length ? `<table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${keys.map((k) => `<tr><td>${esc(k.name)}</td><td class="mono">${esc(k.prefix)}…</td><td class="muted small">${dt(k.created_at)}</td><td class="muted small">${k.last_used_at ? dt(k.last_used_at) : 'never'}</td><td class="right"><button class="sm danger" data-key="${k.id}">Revoke</button></td></tr>`).join('')}</tbody></table>` : '<div class="muted">No keys yet.</div>'}
        <details class="mt"><summary>Example requests</summary><pre class="rec mono" style="overflow:auto">curl ${origin}/api/domains/lookup?name=example.com \\
  -H "Authorization: Bearer xs_YOUR_KEY"

curl -X POST ${origin}/api/leads \\
  -H "Authorization: Bearer xs_YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"leads":[{"email":"jane@acme.com","first_name":"Jane","company":"Acme"}]}'

curl -X POST ${origin}/api/campaigns/1/launch -H "Authorization: Bearer xs_YOUR_KEY"</pre></details></div>
      <div class="card mt" style="border-color:var(--bad)"><h2 style="color:var(--bad)">Danger zone</h2><p class="muted">Permanently delete your account, mailboxes, domains, leads, campaigns and history. This cannot be undone.</p><button class="danger" id="delete">Delete my account</button></div>`;
  };
  root.onsubmit = async (e) => {
    e.preventDefault();
    if (e.target.id === 'profile') { const r = await attempt(() => api('PATCH', '/me', formData(e.target)), 'Profile saved'); if (r?.user) state.user = r.user; }
    if (e.target.id === 'pw') { const f = formData(e.target); if (await attempt(() => api('POST', '/me/password', f), 'Password updated')) { state.user.has_password = true; draw(); } }
  };
  root.onclick = async (e) => {
    if (e.target.id === 'new-key') return modal({ title: 'Create API key', body: '<label>Name</label><input name="name" placeholder="e.g. Zapier" maxlength="60">', okText: 'Create', onOk: async (m) => {
      const r = await api('POST', '/api-keys', { name: $('[name=name]', m).value });
      modal({ title: 'Copy your key now', subtitle: 'It will not be shown again.', actions: false, body: `<div class="rec mono mt" style="word-break:break-all;user-select:all">${esc(r.key)}</div><div class="actions"><button data-x="cancel">Done</button></div>` }); draw(); } });
    const k = e.target.closest('[data-key]'); if (k && await confirmDialog('Revoke key', 'Anything using this key will stop working.', 'Revoke')) { await attempt(() => api('DELETE', `/api-keys/${k.dataset.key}`), 'Revoked'); draw(); }
    if (e.target.id === 'delete') modal({ title: 'Delete account', danger: true, okText: 'Delete everything', subtitle: 'This permanently removes all data.',
      body: `<label>Type your email (<b>${esc(state.user.email)}</b>) to confirm</label><input name="confirm" autocomplete="off">${state.user.has_password ? '<label>Password</label><input name="password" type="password">' : ''}`,
      onOk: async (m) => { await api('DELETE', '/me', formData(m)); state.user = null; location.hash = '#/login'; location.reload(); } });
  };
  await draw();
  return () => { root.onclick = root.onsubmit = null; };
}

export async function admin(root) {
  if (state.user.role !== 'admin') { root.innerHTML = '<div class="alert bad">Admins only</div>'; return; }
  const draw = async () => {
    const { users } = await api('GET', '/admin/users');
    root.innerHTML = `<div class="page-head"><h1>Admin · Users</h1></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Balance</th><th>Campaigns</th><th>Mailboxes</th><th>Sent</th><th>Last login</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><b>${esc(u.email)}</b><div class="muted small">${esc(u.name)}</div></td><td>${badge(u.role, u.role === 'admin' ? '' : 'gray')}</td><td>${usd(u.balance_micros, 2)}</td><td>${u.campaigns}</td><td>${u.mailboxes}</td><td>${u.sent}</td><td class="muted small">${u.last_login_at ? dt(u.last_login_at) : 'never'}</td>
      <td class="right"><button class="sm" data-credit="${u.id}" data-email="${esc(u.email)}">Adjust wallet</button> ${u.id !== state.user.id ? `<button class="sm" data-role="${u.id}" data-to="${u.role === 'admin' ? 'user' : 'admin'}">Make ${u.role === 'admin' ? 'user' : 'admin'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  };
  root.onclick = async (e) => {
    const c = e.target.closest('[data-credit]');
    if (c) modal({ title: 'Adjust wallet · ' + c.dataset.email, subtitle: 'Positive adds credit, negative deducts.', body: '<label>Amount (USD)</label><input name="amount" type="number" step="0.01"><label>Note</label><input name="note">', onOk: async (m) => { await api('POST', `/admin/users/${c.dataset.credit}/credit`, { amount_usd: +$('[name=amount]', m).value, note: $('[name=note]', m).value }); toast('Wallet adjusted', 'ok'); draw(); } });
    const r = e.target.closest('[data-role]'); if (r) { await attempt(() => api('POST', `/admin/users/${r.dataset.role}/role`, { role: r.dataset.to }), 'Role updated'); draw(); }
  };
  await draw();
  return () => { root.onclick = null; };
}
