import { esc, api, usd, dt, badge, attempt, toast, $ } from '../ui.js';
import { state, refreshSide } from '../app.js';

export async function wallet(root, _p, query) {
  const draw = async () => {
    const w = await api('GET', '/wallet');
    if (query.paid) toast('Payment received — your balance updates as soon as Stripe confirms it.', 'ok');
    root.innerHTML = `<div class="page-head"><h1>Wallet</h1></div>
      <div class="grid g3"><div class="card stat"><div class="l">Balance</div><div class="v">${usd(w.balance_micros, 4)}</div></div>
        <div class="card stat"><div class="l">Price per email</div><div class="v">${usd(w.pricing.email, 4)}</div><div class="muted small">≈ ${Math.floor(w.balance_micros / w.pricing.email).toLocaleString()} emails left</div></div>
        <div class="card stat"><div class="l">Blacklist check</div><div class="v">${usd(w.pricing.blacklist, 3)}</div></div></div>
      <div class="card mt"><h2>Add funds</h2>
        ${w.provider ? `${w.provider === 'sandbox' ? '<div class="alert warn">Sandbox payments: balance is credited instantly with no real charge. Configure <code>STRIPE_SECRET_KEY</code> for live card payments.</div>' : ''}
        <div class="row wrap">${[10, 25, 50, 100, 250].map((a) => `<button data-amt="${a}">$${a}</button>`).join('')}<input id="custom" type="number" min="5" max="1000" placeholder="Custom $" style="width:120px"><button class="primary" id="pay">Add funds</button></div>`
          : '<div class="alert bad">No payment provider configured on this server.</div>'}</div>
      <div class="grid g2 mt" style="grid-template-columns:3fr 2fr;align-items:start">
        <div class="card"><h2>Transactions</h2><div class="table-wrap" style="border:0;max-height:480px"><table><thead><tr><th>Date</th><th>Description</th><th class="right">Amount</th><th class="right">Balance</th></tr></thead><tbody>
          ${w.transactions.map((t) => `<tr><td class="muted small nowrap">${dt(t.created_at)}</td><td>${esc(t.description)}</td><td class="right" style="color:var(--${t.type === 'credit' ? 'ok' : 'bad'})">${t.type === 'credit' ? '+' : '−'}${usd(t.amount_micros, 4)}</td><td class="right muted">${usd(t.balance_after_micros, 4)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No transactions</td></tr>'}</tbody></table></div></div>
        <div class="card"><h2>Payments</h2>${w.payments.map((p) => `<div class="row between mt-s"><div>${usd(p.amount_micros)} <span class="muted small">${esc(p.provider)}</span><div class="muted small">${dt(p.created_at)}</div></div>${badge(p.status, p.status === 'paid' ? 'ok' : p.status === 'failed' ? 'bad' : 'warn')}</div>`).join('') || '<div class="muted">No payments yet</div>'}</div></div>`;
  };
  let amount = 25;
  root.onclick = async (e) => {
    const a = e.target.closest('[data-amt]'); if (a) { amount = +a.dataset.amt; $('#custom', root).value = amount; return; }
    if (e.target.id === 'pay') {
      const amt = +$('#custom', root).value || amount;
      e.target.disabled = true; const r = await attempt(() => api('POST', '/wallet/topup', { amount: amt })); e.target.disabled = false;
      if (r?.url) location.href = r.url; else if (r?.credited) { toast('Funds added', 'ok'); await draw(); refreshSide(); }
    }
  };
  await draw();
  return () => { root.onclick = null; };
}
