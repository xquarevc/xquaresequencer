import { $, $$, esc, api, toast, usd, pct, num, ago, dt, badge, attempt, formData, modal, confirmDialog } from './ui.js';

export const state = { user: null, config: null };
const routes = {};
export const route = (pattern, loader) => { routes[pattern] = loader; };

const NAV = [
  ['dashboard', 'Dashboard', '📊'], ['campaigns', 'Campaigns', '🚀'], ['leads', 'Leads', '👥'], ['inbox', 'Master Inbox', '📥'],
  ['mailboxes', 'Email Accounts', '✉️'], ['domains', 'Domains', '🌐'], ['wallet', 'Wallet', '💳'], ['activity', 'Activity Log', '🕒'], ['settings', 'Settings & API', '⚙️'],
];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
export const go = (p) => { location.hash = p; };

let cleanup = null;
async function render() {
  const { path, query } = parseHash();
  if (typeof cleanup === 'function') { try { cleanup(); } catch {} cleanup = null; }
  if (!state.user) {
    try { state.user = (await api('GET', '/me', undefined, { quiet: true })).user; } catch { state.user = null; }
    state.config ??= await api('GET', '/config').catch(() => ({ oauth: {}, pricing: {} }));
  }
  if (!state.user) return renderAuth(path.startsWith('/signup') ? 'signup' : 'login', query);
  if (path.startsWith('/login') || path.startsWith('/signup')) return go('/dashboard');

  const segs = path.split('/').filter(Boolean);
  const section = segs[0] || 'dashboard';
  let match = null, params = [];
  for (const [pat, loader] of Object.entries(routes)) {
    const ps = pat.split('/').filter(Boolean);
    if (ps.length !== segs.length) continue;
    const got = [];
    if (ps.every((p, i) => (p.startsWith(':') ? (got.push(segs[i]), true) : p === segs[i]))) { match = loader; params = got; break; }
  }
  shell(section);
  const main = $('#main');
  if (!match) { main.innerHTML = '<div class="empty"><h2>Page not found</h2></div>'; return; }
  main.innerHTML = '<div class="empty muted">Loading…</div>';
  try { cleanup = await (await match())(main, params, query); }
  catch (e) { main.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
}

function shell(active) {
  if (!$('#main')) {
    $('#app').innerHTML = `<div class="layout"><aside class="side">
      <div class="brand"><i>✉</i> XquareSequencer</div>
      <nav class="nav">${NAV.map(([k, l, i]) => `<a href="#/${k}" data-nav="${k}"><span>${i}</span>${l}<span class="badge" data-badge="${k}" hidden></span></a>`).join('')}
        ${state.user.role === 'admin' ? '<a href="#/admin" data-nav="admin"><span>🛡️</span>Admin</a>' : ''}</nav>
      <div class="foot"><div class="small muted" id="side-balance"></div><div class="row between mt-s"><div class="small" style="overflow:hidden;text-overflow:ellipsis" title="${esc(state.user.email)}">${esc(state.user.name || state.user.email)}</div><button class="sm" id="logout">Log out</button></div></div>
    </aside><main class="main" id="main"></main></div>`;
    $('#logout').onclick = async () => { await api('POST', '/logout', {}).catch(() => {}); state.user = null; location.hash = '#/login'; render(); };
  }
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === active));
  refreshSide();
}
export async function refreshSide() {
  try {
    const d = await api('GET', '/dashboard', undefined, { quiet: true });
    const el = $('#side-balance'); if (el) el.innerHTML = `Wallet: <b>${usd(d.balance_micros)}</b>`;
    const b = $('[data-badge="inbox"]'); if (b) { b.hidden = !d.counts.unread; b.textContent = d.counts.unread; }
  } catch {}
}
window.addEventListener('hashchange', render);
window.addEventListener('xs-unauth', () => { state.user = null; render(); });

// ---------------- Auth screens ----------------
function renderAuth(mode, query) {
  const o = state.config.oauth || {};
  const signup = mode === 'signup';
  $('#app').innerHTML = `<div class="auth"><div class="card">
    <div class="brand" style="padding-left:0"><i>✉</i> XquareSequencer</div>
    <h1>${signup ? 'Create your account' : 'Welcome back'}</h1>
    <p class="muted">${signup ? 'Cold email outreach, self-hosted. Start with a free welcome credit.' : 'Log in to manage your campaigns.'}</p>
    ${query.error ? `<div class="alert bad">${esc(query.error)}</div>` : ''}
    ${o.google ? `<a class="btn oauth-btn" href="/api/oauth/google/login">Continue with Google</a>` : ''}
    ${o.microsoft ? `<a class="btn oauth-btn" href="/api/oauth/microsoft/login">Continue with Microsoft</a>` : ''}
    ${o.google || o.microsoft ? '<div class="divider">or with email</div>' : ''}
    <form id="auth-form">
      ${signup ? '<label>Name</label><input name="name" autocomplete="name" maxlength="80">' : ''}
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Password</label><input name="password" type="password" required minlength="${signup ? 8 : 1}" autocomplete="${signup ? 'new-password' : 'current-password'}">
      <button class="primary mt" style="width:100%;justify-content:center" type="submit">${signup ? 'Sign up' : 'Log in'}</button>
    </form>
    <p class="muted small mt">${signup ? 'Already have an account? <a href="#/login">Log in</a>' : `New here? <a href="#/signup">Create an account</a>`}</p>
  </div></div>`;
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true;
    const r = await attempt(() => api('POST', signup ? '/signup' : '/login', formData(e.target), { quiet: true }));
    btn.disabled = false;
    if (r?.user) { state.user = r.user; location.hash = '#/dashboard'; render(); }
  };
}

// ---------------- Dashboard ----------------
route('/dashboard', async () => {
  const { dashboard } = await import('./pages/dashboard.js');
  return dashboard;
});
route('/campaigns', () => import('./pages/campaigns.js').then((m) => m.list));
route('/campaigns/:id', () => import('./pages/campaigns.js').then((m) => m.detail));
route('/campaigns/:id/edit', () => import('./pages/builder.js').then((m) => m.builder));
route('/leads', () => import('./pages/leads.js').then((m) => m.leads));
route('/inbox', () => import('./pages/inbox.js').then((m) => m.inbox));
route('/mailboxes', () => import('./pages/mailboxes.js').then((m) => m.mailboxes));
route('/domains', () => import('./pages/domains.js').then((m) => m.domains));
route('/wallet', () => import('./pages/wallet.js').then((m) => m.wallet));
route('/activity', () => import('./pages/activity.js').then((m) => m.activity));
route('/settings', () => import('./pages/settings.js').then((m) => m.settings));
route('/admin', () => import('./pages/settings.js').then((m) => m.admin));

render();
