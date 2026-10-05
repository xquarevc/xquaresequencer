const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const config = require('./config');

const file = process.env.DB_FILE || path.join(config.dataDir, 'app.db');
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  google_id TEXT UNIQUE,
  microsoft_id TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  balance_micros INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  from_name TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'smtp',          -- smtp | google | microsoft
  smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER DEFAULT 0,
  smtp_user TEXT, smtp_pass_enc TEXT,
  imap_host TEXT, imap_port INTEGER, imap_secure INTEGER DEFAULT 1,
  imap_user TEXT, imap_pass_enc TEXT,
  oauth_refresh_enc TEXT, oauth_access_enc TEXT, oauth_expires_at INTEGER,
  daily_limit INTEGER NOT NULL DEFAULT 30,
  min_gap_sec INTEGER NOT NULL DEFAULT 60,
  signature TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',          -- active | paused | error
  last_error TEXT,
  imap_last_uid INTEGER NOT NULL DEFAULT 0,
  imap_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, email)
);
CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  registrar TEXT, registered_at INTEGER, expires_at INTEGER, nameservers TEXT,
  dns_json TEXT, dns_checked_at INTEGER,
  dkim_selector TEXT, dkim_private_enc TEXT, dkim_public TEXT,
  blacklist_json TEXT, blacklist_status TEXT, blacklist_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS lead_lists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id INTEGER REFERENCES lead_lists(id) ON DELETE SET NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', company TEXT DEFAULT '',
  phone TEXT DEFAULT '', website TEXT DEFAULT '', title TEXT DEFAULT '',
  custom_json TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, email)
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',           -- draft | active | paused | completed
  timezone TEXT NOT NULL DEFAULT 'UTC',
  send_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  send_start INTEGER NOT NULL DEFAULT 9,          -- hour
  send_end INTEGER NOT NULL DEFAULT 17,
  daily_limit INTEGER NOT NULL DEFAULT 200,
  stop_on_reply INTEGER NOT NULL DEFAULT 1,
  track_opens INTEGER NOT NULL DEFAULT 1,
  track_clicks INTEGER NOT NULL DEFAULT 1,
  include_unsubscribe INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_mailboxes (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, mailbox_id)
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0,          -- wait after previous step (0 for first)
  UNIQUE(campaign_id, position)
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY,
  step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '',               -- empty on follow-ups => thread under previous subject
  body TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS campaign_leads (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',          -- active | replied | bounced | unsubscribed | completed | paused
  current_step INTEGER NOT NULL DEFAULT 0,        -- number of steps already sent
  next_send_at INTEGER,
  last_sent_at INTEGER,
  category TEXT,
  UNIQUE(campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_cl_due ON campaign_leads(status, next_send_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  step_id INTEGER, variant_id INTEGER,
  direction TEXT NOT NULL,                        -- out | in
  from_email TEXT, to_email TEXT,
  subject TEXT, body TEXT,
  message_id TEXT, in_reply_to TEXT,
  token TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'sent',            -- sent | failed | received | bounced
  error TEXT,
  opens INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
  first_open_at INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_mid ON messages(message_id);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS unsubscribes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, email)
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                             -- credit | debit
  amount_micros INTEGER NOT NULL,
  balance_after_micros INTEGER NOT NULL,
  description TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT UNIQUE,
  amount_micros INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | paid | failed
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity TEXT, entity_id INTEGER,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_user ON activity_logs(user_id, id DESC);
`);

const now = () => Date.now();
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn(); // re-entrant: join the outer transaction
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { txDepth--; }
}
module.exports = { db, one, all, run, tx, now };
