process.env.DB_FILE = ':memory:';
process.env.SEND_MODE = 'dry';
process.env.SCHEDULER = 'off';
process.env.PAYMENT_SANDBOX = 'true';
process.env.DATA_DIR = require('os').tmpdir() + '/xs-test-' + process.pid;
process.env.SIGNUP_BONUS_MICROS = '1000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { one, all, run } = require('../src/db');
const engine = require('../src/services/engine');
const { render, spin, sanitizeHtml } = require('../src/lib/template');

let server, base, cookie = '';
const call = async (method, path, body, extra = {}) => {
  const headers = { 'x-requested-with': 'xs', ...(cookie ? { cookie } : {}), ...extra };
  let payload = body;
  if (body !== undefined && typeof body !== 'string') { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
};

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('templates: variables, fallback, spintax, sanitize', () => {
  assert.equal(render('Hi {{first_name|there}}', { first_name: '' }), 'Hi there');
  assert.equal(render('Hi {{first_name}} at {{company}}', { first_name: 'Ann', company: 'X' }), 'Hi Ann at X');
  assert.ok(['a', 'b'].includes(spin('{a|b}')));
  assert.equal(spin('{a|b}', () => 0.99), 'b');
  assert.ok(!/script|onerror|javascript:/i.test(sanitizeHtml('<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>')));
});

test('auth: signup validation, login, CSRF, session', async () => {
  assert.equal((await call('POST', '/api/signup', { email: 'bad', password: 'longenough' })).status, 400);
  assert.equal((await call('POST', '/api/signup', { email: 'a@test.io', password: 'short' })).status, 400);
  const s = await call('POST', '/api/signup', { email: 'a@test.io', password: 'password123', name: 'Ann' });
  assert.equal(s.status, 200);
  assert.equal(s.body.user.role, 'admin'); // first user
  assert.equal(s.body.user.balance_micros, 1000000);
  assert.equal((await call('GET', '/api/me')).body.user.email, 'a@test.io');
  assert.equal((await call('POST', '/api/mailboxes', {}, { 'x-requested-with': '' })).status, 403); // CSRF header required
  const saved = cookie; cookie = '';
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'a@test.io', password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'a@test.io', password: 'password123' })).status, 200);
  assert.ok(cookie && saved);
});

test('full outreach flow: mailbox → leads → campaign → send → track → reply → unsubscribe', async () => {
  const mb = await call('POST', '/api/mailboxes', { email: 'sender@test.io', from_name: 'Sam', smtp_host: 'smtp.test.io', smtp_pass: 'secret', imap_host: 'imap.test.io', daily_limit: 50, min_gap_sec: 0 });
  assert.equal(mb.status, 200);
  const mbRow = one('SELECT * FROM mailboxes WHERE id=?', mb.body.id);
  assert.notEqual(mbRow.smtp_pass_enc, 'secret'); // encrypted at rest
  assert.equal((await call('GET', '/api/mailboxes')).body.mailboxes[0].smtp_pass_enc, undefined);

  const list = (await call('POST', '/api/lists', { name: 'Batch 1' })).body.id;
  const csv = 'Email,First Name,Company,Industry\nbob@acme.com,Bob,Acme,SaaS\n"carol@beta.io","Carol ""CJ""",Beta,Fintech\nnot-an-email,X,Y,Z\nbob@acme.com,Bob,Acme,SaaS\ndan@gamma.org,,Gamma,Retail\n';
  const imp = await call('POST', `/api/leads/import?list_id=${list}`, csv, { 'content-type': 'text/csv' });
  assert.deepEqual(imp.body, { added: 3, updated: 1, invalid: 1 });
  assert.equal((await call('GET', '/api/leads')).body.total, 3);

  const c = await call('POST', '/api/campaigns', {
    name: 'Q4 outreach', timezone: 'UTC', send_days: [0, 1, 2, 3, 4, 5, 6], send_start: 0, send_end: 24, daily_limit: 100,
    mailbox_ids: [mb.body.id],
    steps: [
      { variants: [{ subject: '{Quick|Fast} question, {{first_name|friend}}', body: '<p>Hi {{first_name|there}}, saw {{company}} in {{industry}}. <a href="https://example.com/x">Look</a></p>' }] },
      { delay_days: 3, variants: [{ subject: '', body: '<p>Bumping this</p>' }] },
    ],
  });
  assert.equal(c.status, 200);
  const cid = c.body.id;
  assert.equal((await call('POST', `/api/campaigns/${cid}/launch`)).status, 400); // no leads yet
  assert.equal((await call('POST', `/api/campaigns/${cid}/leads`, { list_id: list })).body.added, 3);
  assert.equal((await call('POST', `/api/campaigns/${cid}/launch`)).status, 200);

  const camp = one('SELECT * FROM campaigns WHERE id=?', cid);
  const r1 = await engine.processCampaign(camp);
  assert.equal(r1.sent, 3);
  const out = all("SELECT * FROM messages WHERE campaign_id=? AND direction='out'", cid);
  assert.equal(out.length, 3);
  const bob = out.find((m) => m.to_email === 'bob@acme.com');
  assert.match(bob.subject, /^(Quick|Fast) question, Bob$/);
  assert.match(bob.body, /Acme in SaaS/);
  assert.equal(one('SELECT balance_micros b FROM users WHERE id=1').b, 1000000 - 3 * 2000);

  // follow-up only after the delay
  assert.equal((await engine.processCampaign(one('SELECT * FROM campaigns WHERE id=?', cid))).sent, 0);
  run('UPDATE campaign_leads SET next_send_at=?', Date.now() - 1000);
  assert.equal((await engine.processCampaign(one('SELECT * FROM campaigns WHERE id=?', cid))).sent, 3);
  const followup = one("SELECT * FROM messages WHERE to_email='bob@acme.com' AND direction='out' ORDER BY id DESC");
  assert.equal(followup.subject, 'Re: ' + bob.subject);          // threaded under first subject
  assert.equal(followup.in_reply_to, bob.message_id);
  assert.equal(one("SELECT status FROM campaign_leads WHERE lead_id=(SELECT id FROM leads WHERE email='bob@acme.com')").status, 'completed');

  // tracking
  const pix = await fetch(`${base}/t/o/${bob.token}.gif`);
  assert.equal(pix.headers.get('content-type'), 'image/gif');
  const link = one('SELECT * FROM links WHERE message_id=?', bob.id);
  const clk = await fetch(`${base}/t/c/${link.token}`, { redirect: 'manual' });
  assert.equal(clk.status, 302);
  assert.equal(clk.headers.get('location'), 'https://example.com/x');
  assert.equal(one('SELECT opens,clicks FROM messages WHERE id=?', bob.id).opens, 1);

  // reply detection stops sequence, lands in inbox
  const carol = one("SELECT * FROM messages WHERE to_email='carol@beta.io' AND direction='out' ORDER BY id ASC");
  run("UPDATE campaign_leads SET status='active' WHERE lead_id=(SELECT id FROM leads WHERE email='carol@beta.io')");
  engine.handleInbound(mbRow, { from: { value: [{ address: 'carol@beta.io' }] }, subject: 'Re: hi', text: 'Sounds good', html: '<p>Sounds good<script>x</script></p>', messageId: '<r1@beta.io>', inReplyTo: carol.message_id });
  assert.equal(one("SELECT status FROM campaign_leads WHERE lead_id=(SELECT id FROM leads WHERE email='carol@beta.io')").status, 'replied');
  const inbox = (await call('GET', '/api/inbox')).body;
  assert.equal(inbox.unread, 1);
  const th = (await call('GET', `/api/inbox/thread/${inbox.messages[0].id}`)).body;
  assert.ok(th.thread.length >= 2);
  assert.ok(!/script/.test(th.thread.at(-1).body));
  assert.equal((await call('GET', '/api/inbox')).body.unread, 0);
  assert.equal((await call('POST', `/api/inbox/${inbox.messages[0].id}/reply`, { html: '<p>Great, Tuesday?</p>' })).status, 200);

  // unsubscribe (GET must NOT unsubscribe; POST does)
  const dan = one("SELECT * FROM messages WHERE to_email='dan@gamma.org' ORDER BY id ASC");
  await fetch(`${base}/u/${dan.token}`);
  assert.equal(one('SELECT COUNT(*) n FROM unsubscribes').n, 0);
  assert.equal((await fetch(`${base}/u/${dan.token}`, { method: 'POST' })).status, 200);
  assert.equal(one('SELECT COUNT(*) n FROM unsubscribes').n, 1);

  const stats = (await call('GET', `/api/campaigns/${cid}`)).body.campaign.stats;
  assert.equal(stats.sent, 7); assert.equal(stats.replied, 1); assert.equal(stats.unsubscribed, 1);
  const dash = (await call('GET', '/api/dashboard')).body;
  assert.equal(dash.totals.sent, 7); // 6 sequence emails + 1 manual reply
  assert.ok((await call('GET', `/api/campaigns/${cid}/analytics`)).body.variants.length === 2);
});

test('campaign auto-pauses when wallet is empty', async () => {
  const mbId = one('SELECT id FROM mailboxes').id;
  const c = (await call('POST', '/api/campaigns', { name: 'Broke', send_days: [0, 1, 2, 3, 4, 5, 6], send_start: 0, send_end: 24, mailbox_ids: [mbId], steps: [{ variants: [{ subject: 'x', body: 'y' }] }] })).body.id;
  const l = (await call('POST', '/api/leads', { leads: [{ email: 'zed@zed.io' }] }));
  assert.equal(l.body.added, 1);
  await call('POST', `/api/campaigns/${c}/leads`, { lead_ids: [one("SELECT id FROM leads WHERE email='zed@zed.io'").id] });
  assert.equal((await call('POST', `/api/campaigns/${c}/launch`)).status, 200);
  run('UPDATE users SET balance_micros=0 WHERE id=1');
  const out = await engine.processCampaign(one('SELECT * FROM campaigns WHERE id=?', c));
  assert.equal(out.sent, 0);
  assert.equal(one('SELECT status FROM campaigns WHERE id=?', c).status, 'paused');
  assert.equal((await call('POST', `/api/campaigns/${c}/resume`)).status, 400);
});

test('wallet top-up (sandbox) + ledger + activity log', async () => {
  const t = await call('POST', '/api/wallet/topup', { amount: 20 });
  assert.equal(t.body.credited, true);
  const w = (await call('GET', '/api/wallet')).body;
  assert.equal(w.balance_micros, 20000000);
  assert.equal(w.transactions[0].type, 'credit');
  assert.equal((await call('POST', '/api/wallet/topup', { amount: 1 })).status, 400);
  const act = (await call('GET', '/api/activity?q=campaign')).body.logs;
  assert.ok(act.some((a) => a.action === 'campaign.launched'));
});

test('stripe webhook: signature verified, credit is idempotent', async () => {
  const crypto = require('crypto');
  const config = require('../src/config');
  config.stripe.webhookSecret = 'whsec_test';
  run("INSERT INTO payments (user_id,provider,provider_ref,amount_micros,status,created_at) VALUES (1,'stripe','cs_1',5000000,'pending',?)", Date.now());
  const before = one('SELECT balance_micros b FROM users WHERE id=1').b;
  const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid' } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')}`;
  const post = (s) => fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': s, 'content-type': 'application/json' }, body: raw });
  assert.equal((await post('t=1,v1=bad')).status, 400);
  assert.equal((await post(sig)).status, 200);
  assert.equal((await post(sig)).status, 200);
  assert.equal(one('SELECT balance_micros b FROM users WHERE id=1').b, before + 5000000);
});

test('api keys, tenant isolation, domains validation', async () => {
  const k = (await call('POST', '/api/api-keys', { name: 'ci' })).body.key;
  assert.match(k, /^xs_/);
  const viaKey = await fetch(base + '/api/mailboxes', { headers: { authorization: 'Bearer ' + k } });
  assert.equal(viaKey.status, 200);
  assert.equal((await fetch(base + '/api/mailboxes', { headers: { authorization: 'Bearer xs_nope' } })).status, 401);

  const mine = cookie; cookie = '';
  await call('POST', '/api/signup', { email: 'b@test.io', password: 'password123' });
  assert.equal((await call('GET', '/api/campaigns')).body.campaigns.length, 0);
  assert.equal((await call('GET', '/api/campaigns/1')).status, 404);
  assert.equal((await call('DELETE', '/api/mailboxes/1')).status, 404);
  assert.equal((await call('GET', '/api/admin/users')).status, 403);
  assert.equal((await call('POST', '/api/domains', { name: 'not a domain' })).status, 400);

  // account deletion removes everything
  assert.equal((await call('DELETE', '/api/me', { confirm: 'wrong@x.io', password: 'password123' })).status, 400);
  assert.equal((await call('DELETE', '/api/me', { confirm: 'b@test.io', password: 'password123' })).status, 200);
  assert.equal(one("SELECT COUNT(*) n FROM users WHERE email='b@test.io'").n, 0);
  cookie = mine;
});

test('domains: add, dkim generation, records (offline-safe)', async () => {
  const d = await call('POST', '/api/domains', { name: 'https://WWW.Example-Test.com/' });
  assert.equal(d.status, 200);
  assert.equal(d.body.domain.name, 'example-test.com');
  const id = d.body.domain.id;
  const dk = await call('POST', `/api/domains/${id}/dkim`);
  assert.ok(dk.body.records.find((r) => r.host.endsWith('._domainkey')).value.startsWith('v=DKIM1'));
  assert.equal((await call('POST', '/api/domains', { name: 'example-test.com' })).status, 400);
  assert.equal((await call('DELETE', `/api/domains/${id}`)).status, 200);
});
