import db from './db.js';
import { PREFIX } from './paths.js';
import { seal, open } from './crypto.js';

const DAY = 864e5;

export const getSetting = (k) => db.prepare('select value from settings where key=?').get(k)?.value ?? null;
export function setSetting(k, v) {
  if (v == null || v === '') db.prepare('delete from settings where key=?').run(k);
  else db.prepare('insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value').run(k, String(v));
}

// Secrets (like the LinkedIn client secret) are stored encrypted.
export const setSecret = (k, v) => setSetting(k, v ? seal(v) : '');
export const getSecret = (k) => { const v = getSetting(k); if (!v) return ''; try { return open(v); } catch { return ''; } };

// Settings saved in the app win; .env is the starting default.
export const currentVersion = () => getSetting('linkedin_version') || process.env.LINKEDIN_VERSION || '202606';
export const versionSource = () => (getSetting('linkedin_version') ? 'settings' : process.env.LINKEDIN_VERSION ? 'env' : 'default');
export const reminderDays = () => Math.min(30, Math.max(1, parseInt(getSetting('reminder_days') || '7', 10) || 7));
export const webhookUrl = () => getSetting('webhook_url') || '';

export const linkedinCreds = () => ({
  id: getSetting('li_client_id') || process.env.LINKEDIN_CLIENT_ID || '',
  secret: getSecret('li_client_secret') || process.env.LINKEDIN_CLIENT_SECRET || ''
});
export const linkedinScopes = () => getSetting('li_scopes') || process.env.LINKEDIN_SCOPES || 'openid profile w_member_social';
// Public address of this site. Empty means "work it out from the request".
export const appUrl = () => (getSetting('app_url') || process.env.APP_URL || '').replace(/\/+$/, '');

export const isValidVersion = (v) => /^20\d{2}(0[1-9]|1[0-2])$/.test(String(v));

// LinkedIn retires a version about a year after release. Warn from month 10, alarm from month 12.
export function versionHealth(v = currentVersion(), now = new Date()) {
  const m = /^(\d{4})(\d{2})$/.exec(v);
  if (!m) return { value: v, age: null, level: 'old' };
  const age = (now.getFullYear() - +m[1]) * 12 + (now.getMonth() + 1 - +m[2]);
  return { value: v, age, level: age >= 12 ? 'old' : age >= 10 ? 'soon' : 'ok' };
}
// Last month's release is always published; the current month's may not be yet.
export function suggestedVersion(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Profile connections that have expired or will within the reminder window.
export function expiryStatus(now = Date.now()) {
  const window = reminderDays() * DAY;
  return db.prepare("select id,name,expires_at,notified from accounts where kind='member' and expires_at is not null").all()
    .map((a) => ({ ...a, days_left: Math.ceil((a.expires_at - now) / DAY), expired: a.expires_at <= now, soon: a.expires_at > now && a.expires_at - now <= window }))
    .filter((a) => a.expired || a.soon);
}

export async function sendWebhook(text) {
  const url = webhookUrl();
  if (!url) return false;
  // "text" is read by Slack, "content" by Discord; other tools can pick either.
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Webhook answered ${res.status}`);
  return true;
}

// Each account gets one message when it enters the window and one when it actually expires.
export async function checkExpiry() {
  if (!webhookUrl()) return;
  for (const a of expiryStatus()) {
    const key = `${a.expires_at}:${a.expired ? 'expired' : 'soon'}`;
    if (a.notified === key) continue;
    const where = appUrl() ? `: ${appUrl()}${PREFIX}/accounts.html` : '.';
    const text = a.expired
      ? `Autopilot: the LinkedIn connection for ${a.name} has expired. Scheduled posts will fail until it is reconnected${where}`
      : `Autopilot: the LinkedIn connection for ${a.name} expires in ${a.days_left} day${a.days_left === 1 ? '' : 's'}. Reconnect it before then${where}`;
    try { await sendWebhook(text); db.prepare('update accounts set notified=? where id=?').run(key, a.id); }
    catch (e) { console.error('Reminder webhook failed:', e.message); }
  }
}
