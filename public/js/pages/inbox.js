import { esc, api, ago, dt, badge, attempt, toast, $ } from '../ui.js';
import { createEditor } from '../editor.js';
import { refreshSide } from '../app.js';

const CATS = [['', '— No label'], ['interested', 'Interested'], ['meeting_booked', 'Meeting booked'], ['not_interested', 'Not interested'], ['out_of_office', 'Out of office'], ['wrong_person', 'Wrong person'], ['do_not_contact', 'Do not contact']];
const catKind = { interested: 'ok', meeting_booked: 'ok', not_interested: 'bad', do_not_contact: 'bad', out_of_office: 'warn' };

export async function inbox(root) {
  let filter = 'all', active = null;
  async function draw() {
    const r = await api('GET', `/inbox?filter=${filter}`);
    root.innerHTML = `<div class="page-head"><h1>Master Inbox</h1><div class="row"><select id="flt" style="width:auto"><option value="all">All replies</option><option value="unread" ${filter === 'unread' ? 'selected' : ''}>Unread (${r.unread})</option></select><button id="sync">↻ Sync mailboxes</button></div></div>
      <div class="inbox"><div class="list">${r.messages.map((m) => `<div class="item ${m.read ? '' : 'unread'} ${m.id === active ? 'active' : ''}" data-id="${m.id}"><div class="row between"><span class="t">${esc([m.first_name, m.last_name].join(' ').trim() || m.from_email)}</span><span class="muted small">${ago(m.created_at)}</span></div>
        <div class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.subject || '(no subject)')}</div><div class="small muted">${esc(m.company || m.from_email)}${m.campaign ? ' · ' + esc(m.campaign) : ''} ${m.category ? badge(m.category.replace(/_/g, ' '), catKind[m.category] || '') : ''}</div></div>`).join('') || '<div class="empty">No replies yet.<br>Replies to your campaigns appear here once IMAP sync picks them up.</div>'}</div>
        <div class="thread" id="thread"><div class="empty">Select a conversation</div></div></div>`;
    if (active) openThread(active);
  }
  async function openThread(id) {
    active = id;
    root.querySelectorAll('.item').forEach((i) => i.classList.toggle('active', +i.dataset.id === id));
    const t = await api('GET', `/inbox/thread/${id}`);
    root.querySelector(`.item[data-id="${id}"]`)?.classList.remove('unread');
    refreshSide();
    const el = $('#thread', root);
    el.innerHTML = `<div class="row between mb"><div><b>${esc(t.lead ? [t.lead.first_name, t.lead.last_name].join(' ').trim() || t.lead.email : '')}</b><div class="muted small">${esc(t.lead?.email || '')} ${t.lead?.company ? '· ' + esc(t.lead.company) : ''}</div></div>
      <select id="cat" style="width:auto" ${t.category ? '' : 'disabled'}>${CATS.map(([v, l]) => `<option value="${v}" ${v === (t.category?.category || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${t.thread.map((m) => `<div class="bubble ${m.direction}"><div class="meta"><b>${m.direction === 'out' ? 'You' : esc(m.from_email)}</b> · ${dt(m.created_at)} ${m.direction === 'out' ? (m.opens ? badge('opened', 'ok') : '') : ''}${m.status === 'bounced' ? badge('bounced', 'bad') : ''}<br>${esc(m.subject || '')}</div>
        <iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" class="preview content" style="height:${m.direction === 'in' ? 220 : 140}px" srcdoc="${esc('<base target=_blank><body style="font-family:Arial,sans-serif;font-size:13px;color:#222;margin:8px">' + m.body + '</body>')}"></iframe></div>`).join('')}
      <div class="mt"><b>Reply</b><div id="reply-ed" class="mt-s"></div><div class="row mt-s"><button class="primary" id="send-reply">Send reply</button></div></div>`;
    const ed = createEditor($('#reply-ed', el), { placeholder: 'Write a reply…' });
    $('#cat', el).onchange = (e) => attempt(() => api('POST', `/inbox/${id}/category`, { category: e.target.value || null }), 'Label saved');
    $('#send-reply', el).onclick = async (e) => {
      e.target.disabled = true;
      const ok = await attempt(() => api('POST', `/inbox/${id}/reply`, { html: ed.getHTML() }), 'Reply sent');
      e.target.disabled = false; if (ok) openThread(id);
    };
  }
  root.onclick = async (e) => {
    const it = e.target.closest('.item'); if (it) return openThread(+it.dataset.id);
    if (e.target.id === 'sync') { e.target.disabled = true; const r = await attempt(() => api('POST', '/inbox/sync')); e.target.disabled = false; if (r) { toast(`${r.new} new repl${r.new === 1 ? 'y' : 'ies'}`, 'ok'); draw(); } }
  };
  root.onchange = (e) => { if (e.target.id === 'flt') { filter = e.target.value; draw(); } };
  await draw();
  return () => { root.onclick = root.onchange = null; };
}
