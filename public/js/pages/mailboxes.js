import { esc, api, num, ago, badge, attempt, modal, confirmDialog, toast, $, $$, formData } from '../ui.js';
import { state } from '../app.js';

const PRESETS = {
  custom: {}, gmail: { smtp_host: 'smtp.gmail.com', smtp_port: 465, imap_host: 'imap.gmail.com', imap_port: 993 },
  outlook: { smtp_host: 'smtp.office365.com', smtp_port: 587, imap_host: 'outlook.office365.com', imap_port: 993 },
  zoho: { smtp_host: 'smtp.zoho.com', smtp_port: 465, imap_host: 'imap.zoho.com', imap_port: 993 },
  sendgrid: { smtp_host: 'smtp.sendgrid.net', smtp_port: 587, imap_host: '', imap_port: 993 },
};
const statusKind = { active: 'ok', paused: 'warn', error: 'bad' };

export async function mailboxes(root, _p, query) {
  const draw = async () => {
    const { mailboxes: list } = await api('GET', '/mailboxes');
    const oauth = state.config.oauth || {};
    root.innerHTML = `<div class="page-head"><h1>Email Accounts</h1><button class="primary" id="add">+ Add account</button></div>
      ${query.connected ? '<div class="alert ok">Mailbox connected via OAuth.</div>' : ''}
      ${state.config.sendMode === 'dry' ? '<div class="alert warn"><b>Dry-run mode:</b> the server is not actually sending (SEND_MODE=dry). Set <code>SEND_MODE=live</code> to deliver real email.</div>' : ''}
      ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Status</th><th>Today</th><th>Limit / gap</th><th>IMAP sync</th><th></th></tr></thead><tbody>
      ${list.map((m) => `<tr><td><b>${esc(m.email)}</b><div class="muted small">${esc(m.from_name)}</div>${m.last_error ? `<div class="small" style="color:var(--bad)">${esc(m.last_error)}</div>` : ''}</td>
        <td>${badge(m.provider === 'smtp' ? 'SMTP' : m.provider, 'gray')}</td><td>${badge(m.status, statusKind[m.status])}</td><td>${num(m.sent_today)}/${m.daily_limit}</td><td>${m.daily_limit}/day · ${m.min_gap_sec}s</td>
        <td class="muted small">${m.imap_host ? ago(m.imap_checked_at) : 'not configured'}</td>
        <td class="right"><button class="sm" data-a="test" data-id="${m.id}">Test</button> <button class="sm" data-a="send" data-id="${m.id}">Send test</button> <button class="sm" data-a="edit" data-id="${m.id}">Edit</button>
          <button class="sm" data-a="toggle" data-id="${m.id}" data-st="${m.status}">${m.status === 'active' ? 'Pause' : 'Activate'}</button> <button class="sm danger" data-a="del" data-id="${m.id}" data-email="${esc(m.email)}">Remove</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="card empty"><h2>No email accounts</h2><p>Connect Gmail, Outlook or any SMTP/IMAP mailbox to start sending.</p></div>'}`;
    root._list = list;
  };

  const addModal = () => {
    const oauth = state.config.oauth || {};
    modal({ title: 'Add email account', wide: true, actions: false, body: `
      <div class="row wrap mt">${oauth.google ? '<button class="primary" id="o-google">Connect Google / Gmail</button>' : '<button disabled title="Set GOOGLE_CLIENT_ID/SECRET on the server">Google (not configured)</button>'}
        ${oauth.microsoft ? '<button class="primary" id="o-ms">Connect Microsoft / Outlook</button>' : '<button disabled title="Set MICROSOFT_CLIENT_ID/SECRET on the server">Microsoft (not configured)</button>'}</div>
      <div class="divider">or connect via SMTP / IMAP</div>
      <form id="smtp-form"><label>Preset</label><select id="preset">${Object.keys(PRESETS).map((k) => `<option>${k}</option>`).join('')}</select>
      <div class="form-grid"><div><label>Email *</label><input name="email" type="email" required></div><div><label>From name</label><input name="from_name"></div>
        <div><label>SMTP host *</label><input name="smtp_host" required></div><div><label>SMTP port</label><input name="smtp_port" type="number" value="587"></div>
        <div><label>SMTP username</label><input name="smtp_user" placeholder="defaults to email"></div><div><label>SMTP password / app password *</label><input name="smtp_pass" type="password" required autocomplete="new-password"></div>
        <div><label>IMAP host (for reply detection)</label><input name="imap_host"></div><div><label>IMAP port</label><input name="imap_port" type="number" value="993"></div>
        <div><label>Daily send limit</label><input name="daily_limit" type="number" value="30" min="1"></div><div><label>Min gap between emails (sec)</label><input name="min_gap_sec" type="number" value="60" min="0"></div></div>
      <label>Signature (HTML allowed)</label><textarea name="signature" rows="2"></textarea>
      <p class="muted small">Credentials are encrypted at rest (AES-256-GCM). For Gmail use an <a href="https://support.google.com/accounts/answer/185833" target="_blank" rel="noopener">app password</a>.</p>
      <div class="actions"><button type="button" data-x="cancel">Cancel</button><button class="primary" type="submit">Add & verify</button></div></form>`,
      onMount: (m, close) => {
        $('#preset', m).onchange = (e) => { for (const [k, v] of Object.entries(PRESETS[e.target.value])) { const i = $(`[name=${k}]`, m); if (i) i.value = v; } };
        const oa = async (p) => { const r = await attempt(() => api('GET', `/oauth/${p}/connect-mailbox`)); if (r) location.href = r.url; };
        $('#o-google', m)?.addEventListener('click', () => oa('google')); $('#o-ms', m)?.addEventListener('click', () => oa('microsoft'));
        $('#smtp-form', m).onsubmit = async (e) => {
          e.preventDefault(); const btn = e.submitter; btn.disabled = true; btn.textContent = 'Verifying…';
          try {
            const body = formData(e.target); body.smtp_port = +body.smtp_port; body.imap_port = +body.imap_port; body.daily_limit = +body.daily_limit; body.min_gap_sec = +body.min_gap_sec;
            const r = await api('POST', '/mailboxes', body);
            if (r.check?.smtp?.ok === false) toast('Added, but SMTP check failed: ' + r.check.smtp.error, 'bad');
            else if (r.check?.imap?.ok === false) toast('Added. SMTP ok, IMAP failed: ' + r.check.imap.error, 'bad');
            else toast('Account added and verified', 'ok');
            close(); draw();
          } catch (err) { toast(err.message, 'bad'); btn.disabled = false; btn.textContent = 'Add & verify'; }
        };
      } });
  };

  root.onclick = async (e) => {
    if (e.target.id === 'add') return addModal();
    const b = e.target.closest('[data-a]'); if (!b) return;
    const id = +b.dataset.id, m = root._list.find((x) => x.id === id);
    if (b.dataset.a === 'test') { b.disabled = true; const r = await attempt(() => api('POST', `/mailboxes/${id}/test`)); b.disabled = false; if (r) { const bad = [r.smtp, r.imap].filter((x) => x && !x.ok); bad.length ? toast(bad.map((x) => x.error).join(' | '), 'bad') : toast('Connection OK', 'ok'); draw(); } }
    if (b.dataset.a === 'toggle') { await attempt(() => api('PATCH', `/mailboxes/${id}`, { status: b.dataset.st === 'active' ? 'paused' : 'active' })); draw(); }
    if (b.dataset.a === 'send') modal({ title: 'Send test email', body: '<label>To</label><input name="to" value="' + esc(state.user.email) + '">', okText: 'Send', onOk: async (el) => { const r = await api('POST', `/mailboxes/${id}/send-test`, { to: $('[name=to]', el).value }); toast(r.dry ? 'Dry-run: recorded, not delivered' : 'Sent', 'ok'); } });
    if (b.dataset.a === 'edit') modal({ title: 'Edit ' + m.email, body: `<div class="form-grid"><div><label>From name</label><input name="from_name" value="${esc(m.from_name)}"></div><div><label>Daily limit</label><input name="daily_limit" type="number" value="${m.daily_limit}"></div><div><label>Min gap (sec)</label><input name="min_gap_sec" type="number" value="${m.min_gap_sec}"></div>${m.provider === 'smtp' ? '<div><label>New SMTP password</label><input name="smtp_pass" type="password" placeholder="leave blank to keep"></div>' : ''}</div><label>Signature</label><textarea name="signature" rows="3">${esc(m.signature)}</textarea>`, onOk: async (el) => { const f = formData(el); if (!f.smtp_pass) delete f.smtp_pass; f.daily_limit = +f.daily_limit; f.min_gap_sec = +f.min_gap_sec; await api('PATCH', `/mailboxes/${id}`, f); toast('Saved', 'ok'); draw(); } });
    if (b.dataset.a === 'del') { if (!(await confirmDialog('Remove account', `Remove <b>${esc(b.dataset.email)}</b>? Stored credentials are deleted. Sent-message history is kept.`, 'Remove'))) return; try { await api('DELETE', `/mailboxes/${id}`); toast('Removed', 'ok'); } catch (err) { if (/force/.test(err.message) && await confirmDialog('In use', err.message + '<br>Remove anyway?', 'Remove anyway')) await attempt(() => api('DELETE', `/mailboxes/${id}?force=1`), 'Removed'); else toast(err.message, 'bad'); } draw(); }
  };
  await draw();
  return () => { root.onclick = null; };
}
