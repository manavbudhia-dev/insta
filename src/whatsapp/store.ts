/**
 * WhatsApp automation: tables and settings. Everything lives in the platform database (app.db) with a "wa_" prefix,
 * so one backup covers Instagram and WhatsApp together.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, delSetting, getSetting, log, setSetting } from '../db.js';
import { open, seal } from '../vault.js';

db.exec(`
CREATE TABLE IF NOT EXISTS wa_contacts (
  wa_id TEXT PRIMARY KEY,               -- phone number in international format, digits only
  name TEXT,
  first_seen INTEGER NOT NULL,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  paused_until INTEGER NOT NULL DEFAULT 0,
  opted_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_inbound ON wa_contacts(last_inbound_at);

CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL,
  direction TEXT NOT NULL,              -- in | out
  type TEXT NOT NULL,                   -- text | interactive | template | image | ...
  text TEXT,
  wamid TEXT UNIQUE,
  status TEXT,                          -- out: sent | delivered | read | failed
  error TEXT,
  rule_id INTEGER,
  broadcast_id INTEGER,
  source TEXT,                          -- auto | manual | broadcast | api
  created_at INTEGER NOT NULL,
  status_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_contact ON wa_messages(wa_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_rule ON wa_messages(rule_id, wa_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_broadcast ON wa_messages(broadcast_id, status);
CREATE INDEX IF NOT EXISTS idx_wa_messages_dir ON wa_messages(direction, created_at);

CREATE TABLE IF NOT EXISTS wa_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_type TEXT NOT NULL DEFAULT 'message', -- message | welcome
  match_mode TEXT NOT NULL DEFAULT 'contains',  -- contains | exact | any
  keywords TEXT NOT NULL DEFAULT '[]',
  reply_text TEXT NOT NULL,
  buttons TEXT NOT NULL DEFAULT '[]',           -- up to 3 quick-reply button titles
  cooldown_minutes INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- text | interactive | template
  payload TEXT NOT NULL,                -- Cloud API message fields (type + its object)
  preview TEXT,
  rule_id INTEGER,
  broadcast_id INTEGER,
  source TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  error TEXT,
  wamid TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_status ON wa_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_broadcast ON wa_outbox(broadcast_id, status);

CREATE TABLE IF NOT EXISTS wa_templates (
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL,
  category TEXT,
  body TEXT,
  params INTEGER NOT NULL DEFAULT 0,    -- number of {{n}} variables in the body
  header_type TEXT,                     -- TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION | null
  buttons TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (name, language)
);

CREATE TABLE IF NOT EXISTS wa_broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  language TEXT NOT NULL,
  recipients TEXT NOT NULL,             -- [{to, params:[]}] until the broadcast starts
  total INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | running | done | cancelled
  scheduled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wa_broadcasts_due ON wa_broadcasts(status, scheduled_at);
`);

export const WA_DEFAULTS: Record<string, number> = {
  wa_automation_enabled: 1,
  wa_mark_read: 1,
  /** Minutes the bot stays quiet with a contact after you reply to them by hand. */
  wa_human_pause_min: 60,
  /** Automatic replies one contact can trigger per hour (stops two bots looping). */
  wa_contact_hourly_limit: 10,
  /** Messages per hour across everything (auto, manual, broadcasts). Keep it under your WhatsApp messaging tier. */
  wa_hourly_limit: 1000,
};

export function waOpt(key: keyof typeof WA_DEFAULTS): number {
  const n = Number(getSetting(key, String(WA_DEFAULTS[key])));
  return Number.isFinite(n) ? n : WA_DEFAULTS[key];
}

/** The two secrets are stored encrypted with the platform vault, like the Instagram token. */
export const waToken = () => open(getSetting('wa_token'));
export const setWaToken = (v: string) => (v ? setSetting('wa_token', seal(v)) : delSetting('wa_token'));
export const waOwnAppSecret = () => open(getSetting('wa_app_secret'));
export const setWaAppSecret = (v: string) => (v ? setSetting('wa_app_secret', seal(v)) : delSetting('wa_app_secret'));
/** The WhatsApp product can live in a different Meta app than Instagram; its own secret wins, META_APP_SECRET is the default. */
export const waAppSecret = () => waOwnAppSecret() || config.metaAppSecret;

export const phoneId = () => getSetting('wa_phone_id');
export const wabaId = () => getSetting('wa_waba_id');
export const configured = () => !!(phoneId() && waToken());

/** Meta's webhook handshake token, generated once. */
export function verifyToken(): string {
  let v = getSetting('wa_verify_token');
  if (!v) {
    v = crypto.randomBytes(18).toString('base64url');
    setSetting('wa_verify_token', v);
  }
  return v;
}

/** Key n8n (or any tool) sends as "Authorization: Bearer ..." to send WhatsApp messages through this app. */
export function apiKeyMatches(given: string): boolean {
  const stored = open(getSetting('wa_api_key'));
  if (!stored || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(stored).digest();
  return crypto.timingSafeEqual(a, b);
}
export function newApiKey(): string {
  const k = 'wak_' + crypto.randomBytes(24).toString('base64url');
  setSetting('wa_api_key', seal(k));
  return k;
}

export function waLog(level: 'info' | 'warn' | 'error', message: string): void {
  log(level, `WhatsApp: ${message}`);
}

/**
 * Turns what people type ("+91 98765-43210", "0091…", "9876543210") into WhatsApp's wa_id format (digits with country code).
 * A 10-digit local number gets the default country code from Settings, when one is set. Returns '' when it is not a phone number.
 */
export function normalizePhone(input: string, defaultCc = getSetting('wa_default_cc')): string {
  let s = String(input ?? '').trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  s = s.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(s)) return '';
  s = s.replace(/^\+/, '');
  if (!plus && s.startsWith('00')) s = s.slice(2);
  else if (!plus && defaultCc && (s.length === 10 || (s.length === 11 && s.startsWith('0')))) s = defaultCc + s.replace(/^0/, '');
  return s.length >= 8 && s.length <= 15 ? s : '';
}

export function upsertContact(waId: string, name?: string | null): { isNew: boolean } {
  const now = Date.now();
  const r = db.prepare('INSERT OR IGNORE INTO wa_contacts (wa_id, name, first_seen) VALUES (?, ?, ?)').run(waId, name ?? null, now);
  if (!r.changes && name) db.prepare('UPDATE wa_contacts SET name = ? WHERE wa_id = ?').run(name, waId);
  return { isNew: r.changes === 1 };
}

export function prune(): void {
  const now = Date.now();
  db.prepare("DELETE FROM wa_outbox WHERE status NOT IN ('pending', 'sending') AND created_at < ?").run(now - 60 * 86400_000);
}
