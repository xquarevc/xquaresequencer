const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency)
try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch {}

const e = process.env;
const prod = e.NODE_ENV === 'production';
if (prod && (!e.APP_SECRET || e.APP_SECRET.length < 24)) {
  throw new Error('APP_SECRET must be set (>=24 chars) in production');
}

const config = {
  prod,
  port: +e.PORT || 3000,
  baseUrl: (e.BASE_URL || `http://localhost:${e.PORT || 3000}`).replace(/\/$/, ''),
  secret: e.APP_SECRET || 'dev-insecure-secret-change-me',
  dataDir: path.resolve(e.DATA_DIR || path.join(__dirname, '..', 'data')),
  sendMode: e.SEND_MODE === 'live' ? 'live' : 'dry',
  google: { id: e.GOOGLE_CLIENT_ID, secret: e.GOOGLE_CLIENT_SECRET },
  microsoft: { id: e.MICROSOFT_CLIENT_ID, secret: e.MICROSOFT_CLIENT_SECRET, tenant: e.MICROSOFT_TENANT || 'common' },
  stripe: { key: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET },
  paymentSandbox: e.PAYMENT_SANDBOX === 'true' && !prod,
  price: {
    email: +e.PRICE_PER_EMAIL_MICROS || 2000,
    blacklist: +e.PRICE_PER_BLACKLIST_CHECK_MICROS || 10000,
    signupBonus: e.SIGNUP_BONUS_MICROS !== undefined ? +e.SIGNUP_BONUS_MICROS : 1000000,
  },
  godaddy: { key: e.GODADDY_KEY, secret: e.GODADDY_SECRET, api: e.GODADDY_API || 'https://api.godaddy.com' },
  schedulerEnabled: e.SCHEDULER !== 'off',
};
fs.mkdirSync(config.dataDir, { recursive: true });
module.exports = config;
