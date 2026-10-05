const crypto = require('crypto');
const config = require('../config');
const { one, run, tx, now } = require('../db');
const wallet = require('../lib/wallet');

const usd = (micros) => (micros / 1e6).toFixed(2);
const providerName = () => (config.stripe.key ? 'stripe' : config.paymentSandbox ? 'sandbox' : null);

async function stripe(path, params) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method: 'POST', headers: { Authorization: `Bearer ${config.stripe.key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Stripe error');
  return j;
}

/** Start a top-up of `amountUsd` dollars. Returns {url} to redirect to or {credited:true} (sandbox). */
async function startTopUp(user, amountUsd) {
  const cents = Math.round(amountUsd * 100);
  if (!(cents >= 500 && cents <= 100000)) throw Object.assign(new Error('Top-up must be between $5 and $1,000'), { status: 400 });
  const micros = cents * 10000;
  const provider = providerName();
  if (!provider) throw Object.assign(new Error('Payments are not configured'), { status: 503 });
  if (provider === 'sandbox') {
    const ref = 'sbx_' + crypto.randomUUID();
    run('INSERT INTO payments (user_id,provider,provider_ref,amount_micros,status,created_at,paid_at) VALUES (?,?,?,?,?,?,?)', user.id, 'sandbox', ref, micros, 'paid', now(), now());
    wallet.credit(user.id, micros, `Sandbox top-up $${usd(micros)}`, ref);
    return { credited: true, sandbox: true };
  }
  const s = await stripe('/checkout/sessions', {
    mode: 'payment', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(cents),
    'line_items[0][price_data][product_data][name]': 'Wallet credit', 'line_items[0][quantity]': '1',
    success_url: `${config.baseUrl}/#/wallet?paid=1`, cancel_url: `${config.baseUrl}/#/wallet?canceled=1`,
    customer_email: user.email, client_reference_id: String(user.id), 'metadata[user_id]': String(user.id),
  });
  run('INSERT INTO payments (user_id,provider,provider_ref,amount_micros,status,created_at) VALUES (?,?,?,?,?,?)', user.id, 'stripe', s.id, micros, 'pending', now());
  return { url: s.url };
}

// Stripe-Signature: t=...,v1=...  (tolerance 5 min)
function verifyStripeSignature(raw, header) {
  if (!config.stripe.webhookSecret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - +parts.t) > 300) return false;
  const exp = crypto.createHmac('sha256', config.stripe.webhookSecret).update(`${parts.t}.${raw}`).digest('hex');
  const a = Buffer.from(exp), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Idempotent: credits only once per checkout session. */
function handleStripeEvent(evt) {
  if (evt.type !== 'checkout.session.completed' && evt.type !== 'checkout.session.async_payment_succeeded') return;
  const s = evt.data.object;
  if (s.payment_status !== 'paid') return;
  tx(() => {
    const p = one('SELECT * FROM payments WHERE provider_ref=?', s.id);
    if (!p || p.status === 'paid') return;
    run("UPDATE payments SET status='paid', paid_at=? WHERE id=?", now(), p.id);
    wallet.credit(p.user_id, p.amount_micros, `Card top-up $${usd(p.amount_micros)}`, s.id);
  });
}
module.exports = { startTopUp, verifyStripeSignature, handleStripeEvent, providerName, usd };
