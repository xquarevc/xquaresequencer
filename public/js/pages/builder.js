// Campaign builder: Leads → Sequence (drip steps + A/B variants) → Schedule → Mailboxes → Review & launch
import { esc, api, num, badge, attempt, modal, toast, $, $$, usd } from '../ui.js';
import { createEditor } from '../editor.js';
import { go, state } from '../app.js';

const TABS = ['Leads', 'Sequence', 'Schedule', 'Mailboxes', 'Review'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TEMPLATES = [
  { name: '3-step intro → bump → breakup', steps: [
    { delay_days: 0, variants: [{ subject: '{Quick question|Idea} for {{company|your team}}', body: '<p>Hi {{first_name|there}},</p><p>I noticed {{company|your company}} is growing fast. We help teams like yours book more qualified meetings without adding headcount.</p><p>Worth a 15-minute chat this week?</p><p>{{sender_name}}</p>' }] },
    { delay_days: 3, variants: [{ subject: '', body: '<p>Hi {{first_name|there}}, just floating this to the top of your inbox. Happy to share a quick example relevant to {{company|your business}}.</p><p>{{sender_name}}</p>' }] },
    { delay_days: 5, variants: [{ subject: '', body: '<p>Hi {{first_name|there}}, I\'ll assume this isn\'t a priority right now and close the loop. If that changes, just reply.</p><p>{{sender_name}}</p>' }] },
  ] },
  { name: 'Single email', steps: [{ delay_days: 0, variants: [{ subject: 'Hello {{first_name|there}}', body: '<p>Hi {{first_name|there}},</p><p></p><p>{{sender_name}}</p>' }] }] },
];
const blankStep = (first) => ({ delay_days: first ? 0 : 2, variants: [{ subject: '', body: '', weight: 1 }] });

export async function builder(root, [id], query) {
  let [{ campaign: c }, { mailboxes }, { lists }] = await Promise.all([api('GET', `/campaigns/${id}`), api('GET', '/mailboxes'), api('GET', '/lists')]);
  let tab = Math.min(+query.tab || 0, TABS.length - 1);
  let steps = c.steps.length ? c.steps.map((s) => ({ delay_days: s.delay_days, variants: s.variants.map((v) => ({ subject: v.subject, body: v.body, weight: v.weight })) })) : [blankStep(true)];
  const editors = [];
  let dirtySteps = false;

  const saveSettings = (extra = {}) => api('PUT', `/campaigns/${id}`, extra);
  const readSettings = () => {
    const g = (n) => $(`[name=${n}]`, root);
    return {
      name: g('name').value, timezone: g('timezone').value, send_start: +g('send_start').value, send_end: +g('send_end').value, daily_limit: +g('daily_limit').value,
      send_days: $$('[name=day]:checked', root).map((x) => +x.value), stop_on_reply: g('stop_on_reply').checked, track_opens: g('track_opens').checked,
      track_clicks: g('track_clicks').checked, include_unsubscribe: g('include_unsubscribe').checked,
    };
  };
  const persist = async () => {
    if (tab === 1) { const r = await attempt(() => saveSettings({ steps })); if (!r) return false; dirtySteps = false; }
    if (tab === 2) { if (!(await attempt(() => saveSettings(readSettings())))) return false; }
    if (tab === 3) { if (!(await attempt(() => saveSettings({ mailbox_ids: $$('[name=mb]:checked', root).map((x) => +x.value) })))) return false; }
    return true;
  };
  const reload = async () => { ({ campaign: c } = await api('GET', `/campaigns/${id}`)); };

  async function draw() {
    editors.length = 0;
    const tabsHtml = `<div class="stepper">${TABS.map((t, i) => `<button data-tab="${i}" class="${i === tab ? 'active' : i < tab ? 'done' : ''}">${i + 1}. ${t}</button>`).join('')}</div>`;
    let body = '';
    if (tab === 0) body = leadsTab();
    if (tab === 1) body = sequenceTab();
    if (tab === 2) body = scheduleTab();
    if (tab === 3) body = mailboxTab();
    if (tab === 4) body = reviewTab();
    root.innerHTML = `<div class="page-head"><div><a href="#/campaigns" class="muted small">← Campaigns</a><h1>${esc(c.name)}</h1></div>
      <div class="row">${badge(c.status, c.status === 'active' ? 'ok' : 'gray')}<button id="save-exit">Save & exit</button></div></div>${tabsHtml}${body}
      <div class="row between mt"><button id="back" ${tab === 0 ? 'disabled' : ''}>← Back</button>${tab < 4 ? '<button class="primary" id="next">Save & continue →</button>' : ''}</div>`;
    if (tab === 1) mountEditors();
  }

  // ---- tab: leads ----
  function leadsTab() {
    return `<div class="card"><h2>Add leads</h2><p class="muted">${num(c.stats.leads)} lead(s) currently in this campaign. Choose a list to add; leads already in the campaign or unsubscribed are skipped.</p>
      <div class="row wrap"><select id="list" style="max-width:320px"><option value="">Select a lead list…</option>${lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${num(l.leads)})</option>`).join('')}</select><button id="add-list">Add list to campaign</button><a class="btn" href="#/leads">Manage / import lists →</a></div></div>`;
  }
  // ---- tab: sequence ----
  function sequenceTab() {
    return `<div class="row between mb"><div class="muted">Drip sequence: each step sends after the previous one, unless the lead replies, bounces or unsubscribes. Follow-ups with an empty subject thread under the first email.</div>
      <div class="row"><select id="tpl" style="width:auto"><option value="">Load template…</option>${TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select></div></div>
      ${steps.map((s, i) => `<div class="step-card" data-step="${i}">
        ${i > 0 ? `<div class="delay">⏱ Wait <input type="number" min="0" max="60" data-delay="${i}" value="${s.delay_days}"> day(s) after previous email</div>` : ''}
        <div class="row between"><div class="row"><div class="step-no">${i + 1}</div><b>${i === 0 ? 'First email' : 'Follow-up'}</b></div>
          <div class="row gap-s"><button class="sm" data-addvar="${i}" ${s.variants.length >= 5 ? 'disabled' : ''}>+ A/B variant</button>${steps.length > 1 ? `<button class="sm danger" data-delstep="${i}">Remove step</button>` : ''}</div></div>
        ${s.variants.map((v, j) => `<div class="variant" data-var="${i}-${j}">
          <div class="row between"><b class="small muted">${s.variants.length > 1 ? `Variant ${'ABCDE'[j]}` : 'Email'}</b>
            <div class="row gap-s">${s.variants.length > 1 ? `<span class="small muted">weight</span><input type="number" min="1" max="100" style="width:64px" data-weight="${i}-${j}" value="${v.weight || 1}"><button class="sm danger" data-delvar="${i}-${j}">✕</button>` : ''}</div></div>
          <label>Subject ${i > 0 ? '<span class="muted">(leave empty to reply in the same thread)</span>' : ''}</label>
          <input data-subject="${i}-${j}" value="${esc(v.subject)}" placeholder="${i > 0 ? 'Re: …' : '{Quick question|Idea} for {{company}}'}">
          <label>Body</label><div data-editor="${i}-${j}"></div></div>`).join('')}
      </div>`).join('')}
      <button id="add-step">+ Add follow-up step</button>
      <p class="muted small mt">Variables: <code>{{first_name|there}}</code> (fallback after |), custom CSV columns work too (<code>{{industry}}</code>). Spintax: <code>{Hi|Hello|Hey}</code>.</p>`;
  }
  function mountEditors() {
    $$('[data-editor]', root).forEach((el) => {
      const [i, j] = el.dataset.editor.split('-').map(Number);
      createEditor(el, { value: steps[i].variants[j].body, onChange: (h) => { steps[i].variants[j].body = h; dirtySteps = true; }, withSubject: () => steps[i].variants[j].subject || (i > 0 ? steps[0].variants[0].subject : '') });
    });
  }
  // ---- tab: schedule ----
  function scheduleTab() {
    const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC'];
    if (!tzs.includes(c.timezone)) tzs.unshift(c.timezone);
    return `<div class="card"><h2>Schedule & settings</h2><div class="form-grid">
      <div><label>Campaign name</label><input name="name" value="${esc(c.name)}" maxlength="120"></div>
      <div><label>Timezone</label><select name="timezone">${tzs.map((z) => `<option ${z === c.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
      <div><label>Send from (hour)</label><input name="send_start" type="number" min="0" max="23" value="${c.send_start}"></div>
      <div><label>Send until (hour)</label><input name="send_end" type="number" min="1" max="24" value="${c.send_end}"></div>
      <div><label>Max emails per day (campaign)</label><input name="daily_limit" type="number" min="1" value="${c.daily_limit}"></div>
      <div><label>Sending days</label><div class="row wrap">${DAYS.map((d, i) => `<label class="inline"><input type="checkbox" name="day" value="${i}" ${c.send_days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div></div></div>
      <div class="mt">${[['stop_on_reply', 'Stop sequence when a lead replies'], ['track_opens', 'Track opens (tracking pixel)'], ['track_clicks', 'Track link clicks'], ['include_unsubscribe', 'Include unsubscribe link & List-Unsubscribe header']]
        .map(([k, l]) => `<div class="mt-s"><label class="inline"><input type="checkbox" name="${k}" ${c[k] ? 'checked' : ''}>${l}</label></div>`).join('')}</div></div>`;
  }
  // ---- tab: mailboxes ----
  function mailboxTab() {
    if (!mailboxes.length) return `<div class="card empty"><h2>No email accounts connected</h2><a class="btn primary" href="#/mailboxes">Connect an email account</a></div>`;
    return `<div class="card"><h2>Sending accounts</h2><p class="muted">Emails are rotated across the selected accounts, respecting each account's daily limit and minimum gap.</p>
      ${mailboxes.map((m) => `<div class="row mt-s"><label class="inline"><input type="checkbox" name="mb" value="${m.id}" ${c.mailbox_ids.includes(m.id) ? 'checked' : ''} ${m.status === 'error' ? 'disabled' : ''}><b>${esc(m.email)}</b></label>${badge(m.status, m.status === 'active' ? 'ok' : m.status === 'error' ? 'bad' : 'warn')}<span class="muted small">${m.daily_limit}/day</span></div>`).join('')}</div>`;
  }
  // ---- tab: review ----
  function reviewTab() {
    const issues = [];
    if (!c.steps.length) issues.push('No sequence yet'); if (!c.mailbox_ids.length) issues.push('No mailbox selected'); if (!c.stats.leads) issues.push('No leads added');
    const est = c.stats.leads * c.steps.length * (state.config?.pricing?.email || 2000);
    return `<div class="card"><h2>Review</h2>${issues.length ? `<div class="alert bad">${issues.map(esc).join(' · ')}</div>` : '<div class="alert ok">Everything looks good.</div>'}
      <dl class="kv"><dt>Leads</dt><dd>${num(c.stats.leads)}</dd><dt>Steps</dt><dd>${c.steps.length} (${c.steps.reduce((a, s) => a + s.variants.length, 0)} emails incl. variants)</dd><dt>Mailboxes</dt><dd>${c.mailbox_ids.length}</dd>
      <dt>Schedule</dt><dd>${c.send_days.map((d) => DAYS[d]).join(', ')} ${c.send_start}:00–${c.send_end}:00 ${esc(c.timezone)}</dd><dt>Max cost</dt><dd>${usd(est, 2)} <span class="muted small">(${num(c.stats.leads * c.steps.length)} emails max × ${usd(state.config?.pricing?.email || 2000, 4)})</span></dd></dl>
      <div class="row mt">${c.status === 'active' ? '<span class="badge ok">Running</span>' : `<button class="primary" id="launch" ${issues.length ? 'disabled' : ''}>🚀 Launch campaign</button>`}<button id="test-send">Send test email</button></div></div>`;
  }

  root.onclick = async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { if (await persist()) { tab = +t.dataset.tab; await reload(); draw(); } return; }
    if (e.target.id === 'next') { if (await persist()) { tab++; await reload(); draw(); } return; }
    if (e.target.id === 'back') { if (await persist()) { tab--; await reload(); draw(); } return; }
    if (e.target.id === 'save-exit') { if (await persist()) go('/campaigns'); return; }
    if (e.target.id === 'add-list') {
      const lid = $('#list', root).value; if (!lid) return toast('Select a list first', 'bad');
      const r = await attempt(() => api('POST', `/campaigns/${id}/leads`, { list_id: +lid })); if (r) { toast(`${r.added} added, ${r.skipped} skipped`, 'ok'); await reload(); draw(); } return;
    }
    if (e.target.id === 'launch') { if (await attempt(() => api('POST', `/campaigns/${id}/launch`), 'Campaign launched!')) go(`/campaigns/${id}`); return; }
    if (e.target.id === 'test-send') return testSend();
    // sequence editing
    const d = e.target.closest('[data-addvar],[data-delvar],[data-delstep]'); const addStep = e.target.id === 'add-step';
    if (tab === 1 && (d || addStep)) {
      if (addStep) steps.push(blankStep(false));
      else if (d.dataset.addvar !== undefined) steps[+d.dataset.addvar].variants.push({ subject: '', body: '', weight: 1 });
      else if (d.dataset.delvar) { const [i, j] = d.dataset.delvar.split('-').map(Number); steps[i].variants.splice(j, 1); }
      else if (d.dataset.delstep !== undefined) steps.splice(+d.dataset.delstep, 1);
      dirtySteps = true; draw();
    }
  };
  root.oninput = (e) => {
    const t = e.target;
    if (t.dataset.subject) { const [i, j] = t.dataset.subject.split('-').map(Number); steps[i].variants[j].subject = t.value; }
    if (t.dataset.weight) { const [i, j] = t.dataset.weight.split('-').map(Number); steps[i].variants[j].weight = +t.value || 1; }
    if (t.dataset.delay) steps[+t.dataset.delay].delay_days = +t.value || 0;
  };
  root.onchange = (e) => {
    if (e.target.id === 'tpl' && e.target.value !== '') {
      steps = JSON.parse(JSON.stringify(TEMPLATES[+e.target.value].steps)); dirtySteps = true; draw();
    }
  };
  async function testSend() {
    const first = c.steps[0]?.variants[0];
    if (!first) return toast('Save a sequence first', 'bad');
    const mb = mailboxes.find((m) => c.mailbox_ids.includes(m.id));
    if (!mb) return toast('Select a mailbox first', 'bad');
    modal({ title: 'Send test email', subtitle: `From ${esc(mb.email)} using a sample lead`, body: `<label>Send to</label><input name="to" value="${esc(state.user.email)}">`, okText: 'Send test',
      onOk: async (el) => {
        const p = await api('POST', '/preview', { subject: first.subject, body: first.body });
        await api('POST', `/mailboxes/${mb.id}/send-test`, { to: $('[name=to]', el).value, subject: '[TEST] ' + p.subject, html: p.html });
        toast('Test email sent', 'ok');
      } });
  }
  await draw();
  const beforeUnload = (e) => { if (dirtySteps) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return () => { window.removeEventListener('beforeunload', beforeUnload); root.onclick = root.oninput = root.onchange = null; };
}
