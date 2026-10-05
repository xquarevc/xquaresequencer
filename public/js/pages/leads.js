import { esc, api, num, dt, badge, attempt, modal, confirmDialog, toast, $, $$ } from '../ui.js';

export async function leads(root) {
  let listId = '', q = '', page = 0;
  const PAGE = 50;
  async function draw() {
    const [{ lists }, r] = await Promise.all([api('GET', '/lists'), api('GET', `/leads?limit=${PAGE}&offset=${page * PAGE}${listId ? '&list_id=' + listId : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`)]);
    root.innerHTML = `<div class="page-head"><h1>Leads</h1><div class="row"><button id="new-list">+ New list</button><button id="add-lead">+ Add lead</button><button class="primary" id="import">⬆ Import CSV</button></div></div>
      <div class="grid" style="grid-template-columns:240px 1fr;align-items:start">
        <div class="card"><h3>Lists</h3>
          <div class="nav"><a href="#" data-list="" class="${!listId ? 'active' : ''}">All leads</a>${lists.map((l) => `<a href="#" data-list="${l.id}" class="${String(l.id) === String(listId) ? 'active' : ''}"><span class="grow" style="overflow:hidden;text-overflow:ellipsis">${esc(l.name)}</span><span class="muted small">${num(l.leads)}</span></a>`).join('')}</div>
          ${listId ? `<button class="sm danger mt" id="del-list">Delete this list</button>` : ''}
          <hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><a href="#" id="unsubs" class="small">View unsubscribe list</a></div>
        <div><div class="row mb"><input id="q" placeholder="Search email, name, company…" value="${esc(q)}" style="max-width:360px"><span class="muted">${num(r.total)} leads</span></div>
          ${r.leads.length ? `<div class="table-wrap"><table><thead><tr><th>Email</th><th>Name</th><th>Company</th><th>Title</th><th>Added</th><th></th></tr></thead><tbody>
            ${r.leads.map((l) => `<tr><td>${esc(l.email)} ${l.unsubscribed ? badge('unsubscribed', 'warn') : ''}</td><td>${esc([l.first_name, l.last_name].join(' ').trim())}</td><td>${esc(l.company)}</td><td>${esc(l.title)}</td><td class="muted small">${dt(l.created_at)}</td><td class="right"><button class="sm danger" data-del="${l.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>
            <div class="row mt"><button class="sm" id="prev" ${page ? '' : 'disabled'}>← Prev</button><span class="muted small">Page ${page + 1}</span><button class="sm" id="next" ${(page + 1) * PAGE >= r.total ? 'disabled' : ''}>Next →</button></div>`
            : '<div class="card empty"><h2>No leads</h2><p>Import a CSV with an <code>email</code> column. Other columns (first_name, last_name, company, title, website, phone, plus any custom ones) become merge variables.</p></div>'}
        </div></div>`;
    $('#q', root).onchange = (e) => { q = e.target.value.trim(); page = 0; draw(); };
    return lists;
  }
  root.onclick = async (e) => {
    const a = e.target.closest('[data-list]'); if (a) { e.preventDefault(); listId = a.dataset.list; page = 0; return draw(); }
    const del = e.target.closest('[data-del]'); if (del) { if (await confirmDialog('Delete lead', 'Remove this lead from all lists and campaigns?', 'Delete')) { await attempt(() => api('DELETE', `/leads/${del.dataset.del}`), 'Deleted'); draw(); } return; }
    if (e.target.id === 'prev') { page--; return draw(); } if (e.target.id === 'next') { page++; return draw(); }
    if (e.target.id === 'new-list') return modal({ title: 'New list', body: '<label>List name</label><input name="name" maxlength="80">', okText: 'Create', onOk: async (m) => { await api('POST', '/lists', { name: $('[name=name]', m).value }); draw(); } });
    if (e.target.id === 'del-list') { if (await confirmDialog('Delete list', 'Delete this list? Leads are kept unless you choose otherwise in the next prompt.', 'Delete list')) { const withLeads = await confirmDialog('Also delete leads?', 'Delete all leads in this list as well?', 'Delete leads too'); await attempt(() => api('DELETE', `/lists/${listId}?with_leads=${withLeads ? 1 : 0}`), 'List deleted'); listId = ''; draw(); } return; }
    if (e.target.id === 'unsubs') { e.preventDefault(); const { unsubscribes } = await api('GET', '/unsubscribes'); return modal({ title: 'Unsubscribe list', subtitle: 'These addresses are never emailed.', wide: true, actions: false, body: `<div class="mt-s"><textarea id="u-new" rows="2" placeholder="Add emails (comma or newline separated)"></textarea><button class="sm mt-s" id="u-add">Add</button></div><div class="table-wrap mt"><table><tbody>${unsubscribes.map((u) => `<tr><td>${esc(u.email)}</td><td class="muted small">${dt(u.created_at)}</td></tr>`).join('') || '<tr><td class="empty">Empty</td></tr>'}</tbody></table></div><div class="actions"><button data-x="cancel">Close</button></div>`, onMount: (m) => { $('#u-add', m).onclick = async () => { const emails = $('#u-new', m).value.split(/[\s,;]+/).filter(Boolean); if (await attempt(() => api('POST', '/unsubscribes', { emails }), 'Added')) m.querySelector('[data-x=cancel]').click(); }; } }); }
    if (e.target.id === 'add-lead') return modal({ title: 'Add lead', body: `<div class="form-grid"><div><label>Email *</label><input name="email" type="email"></div><div><label>Company</label><input name="company"></div><div><label>First name</label><input name="first_name"></div><div><label>Last name</label><input name="last_name"></div><div><label>Title</label><input name="title"></div><div><label>Website</label><input name="website"></div></div><label>List</label><select name="list_id"><option value="">None</option>${(await api('GET', '/lists')).lists.map((l) => `<option value="${l.id}" ${String(l.id) === String(listId) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`, okText: 'Add', onOk: async (m) => { const f = Object.fromEntries($$('[name]', m).map((x) => [x.name, x.value])); const r = await api('POST', '/leads', { ...f, list_id: f.list_id ? +f.list_id : undefined }); if (r.invalid) throw new Error('Invalid email'); toast('Lead saved', 'ok'); draw(); } });
    if (e.target.id === 'import') {
      const { lists } = await api('GET', '/lists');
      modal({ title: 'Import leads from CSV', subtitle: 'Needs an <code>email</code> column. Header aliases like “First Name”, “Company Name”, “Job Title” are mapped automatically; unknown columns become custom variables.',
        body: `<label>Add to list</label><select name="list"><option value="">Create new list from file name</option>${lists.map((l) => `<option value="${l.id}" ${String(l.id) === String(listId) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select><label>CSV file</label><input type="file" name="file" accept=".csv,text/csv">`, okText: 'Import',
        onOk: async (m) => {
          const file = $('[name=file]', m).files[0]; if (!file) throw new Error('Choose a CSV file');
          if (file.size > 10e6) throw new Error('File larger than 10MB');
          let lid = $('[name=list]', m).value;
          if (!lid) lid = (await api('POST', '/lists', { name: file.name.replace(/\.csv$/i, '').slice(0, 80) })).id;
          const r = await api('POST', `/leads/import?list_id=${lid}`, await file.text(), { contentType: 'text/csv' });
          toast(`${r.added} added, ${r.updated} updated, ${r.invalid} invalid`, 'ok'); listId = String(lid); draw();
        } });
    }
  };
  await draw();
  return () => { root.onclick = null; };
}
