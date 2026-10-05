const config = require('../config');
const { sign, verify } = require('../lib/security');

const PROVIDERS = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: { login: 'openid email profile', mailbox: 'openid email profile https://mail.google.com/' },
    extra: { access_type: 'offline', prompt: 'consent' },
    cfg: () => config.google,
  },
  microsoft: {
    auth: () => `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/authorize`,
    token: () => `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`,
    userinfo: 'https://graph.microsoft.com/oidc/userinfo',
    scopes: {
      login: 'openid email profile',
      mailbox: 'openid email profile offline_access https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All',
    },
    extra: { prompt: 'select_account' },
    cfg: () => config.microsoft,
  },
};
const val = (x) => (typeof x === 'function' ? x() : x);
const enabled = (p) => !!(PROVIDERS[p] && PROVIDERS[p].cfg().id && PROVIDERS[p].cfg().secret);
const redirectUri = (p) => `${config.baseUrl}/api/oauth/${p}/callback`;

/** purpose: 'login' | 'mailbox'. userId is bound in the signed state for the mailbox flow. */
function authUrl(provider, purpose, userId, hint) {
  const P = PROVIDERS[provider];
  const state = sign({ p: provider, purpose, uid: userId || null, n: Math.random().toString(36).slice(2) }, 600);
  const q = new URLSearchParams({
    client_id: P.cfg().id, redirect_uri: redirectUri(provider), response_type: 'code',
    scope: P.scopes[purpose], state, ...(purpose === 'mailbox' ? P.extra : {}),
  });
  if (hint) q.set('login_hint', hint);
  return `${val(P.auth)}?${q}`;
}
const parseState = (s) => verify(s);

async function exchangeCode(provider, code) {
  const P = PROVIDERS[provider];
  const r = await fetch(val(P.token), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: P.cfg().id, client_secret: P.cfg().secret, redirect_uri: redirectUri(provider), grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'OAuth token exchange failed');
  return j; // access_token, refresh_token, expires_in
}
async function refresh(provider, refreshToken) {
  const P = PROVIDERS[provider];
  const r = await fetch(val(P.token), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: P.cfg().id, client_secret: P.cfg().secret, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'OAuth refresh failed');
  return j;
}
async function userinfo(provider, accessToken) {
  const r = await fetch(PROVIDERS[provider].userinfo, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Failed to fetch OAuth profile');
  return r.json(); // sub, email, name, email_verified
}
module.exports = { enabled, authUrl, parseState, exchangeCode, refresh, userinfo, redirectUri };
