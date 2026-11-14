import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { open as openSecret } from './vault.js';

// Everything under the data directory (database, uploads) is readable by this user only.
process.umask(0o077);
fs.mkdirSync(path.join(config.dataDir, 'media'), { recursive: true });

export const db = new Database(path.join(config.dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS contacts (
  igsid TEXT PRIMARY KEY,
  username TEXT,
  name TEXT,
  first_seen INTEGER NOT NULL,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  paused_until INTEGER NOT NULL DEFAULT 0,
  profile_checked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  igsid TEXT NOT NULL,
  direction TEXT NOT NULL,            -- in | out
  kind TEXT NOT NULL,                 -- dm | comment | private_reply | comment_reply | story_reply | story_mention
  text TEXT,
  mid TEXT UNIQUE,
  rule_id INTEGER,
  source TEXT,                        -- auto | manual | human (sent from the Instagram app)
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(igsid, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_rule ON messages(rule_id, igsid, created_at);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_type TEXT NOT NULL,         -- dm | comment | story_reply | story_mention | welcome
  match_mode TEXT NOT NULL DEFAULT 'contains',  -- contains | exact | any
  keywords TEXT NOT NULL DEFAULT '[]',
  media_id TEXT,                      -- comment rules: limit to one post (null = every post)
  reply_text TEXT NOT NULL,
  buttons TEXT NOT NULL DEFAULT '[]', -- [{title,url}]
  quick_replies TEXT NOT NULL DEFAULT '[]', -- ["title", ...]
  comment_replies TEXT NOT NULL DEFAULT '[]', -- public reply variants
  cooldown_minutes INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- dm | private_reply | comment_reply
  target TEXT NOT NULL,               -- igsid or comment id
  igsid TEXT,
  payload TEXT NOT NULL,              -- JSON message object, or {message} for comment replies
  preview TEXT,
  rule_id INTEGER,
  source TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS seen_events (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS media_cache (
  id TEXT PRIMARY KEY,
  caption TEXT,
  permalink TEXT,
  media_type TEXT,
  thumbnail TEXT,
  comments_count INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER,
  updated_at INTEGER NOT NULL,
  comments_polled_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  pw_fp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                 -- IMAGE | REELS | STORIES | CAROUSEL
  caption TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL,                -- [{url, kind: image|video}]
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | publishing | published | failed
  ig_media_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  published_at INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_dir ON messages(direction, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_sent ON outbox(status, sent_at);
CREATE INDEX IF NOT EXISTS idx_contacts_inbound ON contacts(last_inbound_at);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, scheduled_at);
`);

// Existing databases predate this column.
if (!(db.prepare('PRAGMA table_info(media_cache)').all() as { name: string }[]).some((c) => c.name === 'comments_polled_at')) {
  db.exec('ALTER TABLE media_cache ADD COLUMN comments_polled_at INTEGER NOT NULL DEFAULT 0');
}

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);
const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');

export function getSetting(key: string, fallback = ''): string {
  const row = getStmt.get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}
export function getNum(key: string, fallback: number): number {
  const n = Number(getSetting(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}
export function setSetting(key: string, value: string | number): void {
  setStmt.run(key, String(value));
}
export function delSetting(key: string): void {
  delStmt.run(key);
}

/** Dashboard-editable settings and their defaults. */
export const DEFAULTS: Record<string, number> = {
  automation_enabled: 1,
  poll_comments: 1,
  poll_interval_sec: 120,
  poll_media_count: 10,
  dm_hourly_limit: 200,
  human_pause_min: 60,
  /** Automated replies one person can trigger per hour; stops two bots (or a spammer) looping with us. */
  contact_hourly_limit: 10,
};
export function opt(key: keyof typeof DEFAULTS | string): number {
  return getNum(key, DEFAULTS[key] ?? 0);
}

/** Strips tokens and secrets from text before it is logged, stored or shown in the dashboard. */
export function redact(text: string): string {
  let out = String(text)
    .replace(/((?:access_token|client_secret|appsecret_proof|input_token|code)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[\w.\-|]+/gi, '$1[redacted]')
    .replace(/\b(?:EAA|IGAA|IGQ)[A-Za-z0-9_-]{20,}/g, '[redacted]');
  const stored = openSecret((db.prepare("SELECT value FROM settings WHERE key = 'ig_token'").get() as { value: string } | undefined)?.value ?? '');
  for (const s of [stored, config.metaAppSecret, config.adminPassword, config.sessionSecret, config.webhookVerifyToken]) {
    if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  }
  return out;
}

const logStmt = db.prepare('INSERT INTO logs (level, message, created_at) VALUES (?, ?, ?)');
export function log(level: 'info' | 'warn' | 'error', message: string): void {
  // Control characters could forge extra log lines.
  const line = redact(message).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 1000);
  logStmt.run(level, line, Date.now());
  (level === 'error' ? console.error : console.log)(`[${level}] ${line}`);
}

/** Returns true the first time a key is seen (used for webhook / comment de-duplication). */
const seenStmt = db.prepare('INSERT OR IGNORE INTO seen_events (key, created_at) VALUES (?, ?)');
export function firstTime(key: string): boolean {
  return seenStmt.run(key, Date.now()).changes === 1;
}

export function prune(): void {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM seen_events WHERE created_at < ?').run(now - 30 * 86400_000);
  db.prepare('DELETE FROM logs WHERE created_at < ?').run(now - 30 * 86400_000);
  db.prepare("DELETE FROM outbox WHERE status != 'pending' AND created_at < ?").run(now - 60 * 86400_000);
}
