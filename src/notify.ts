/**
 * Emails this instance sends by itself: problem alerts (batched, at most one email per gap), an optional daily
 * summary, and unlock requests from a client to the owner. Everything goes to the login list (see login.ts).
 */
import express from 'express';
import { APP_NAMES, APPS, appEnabled, managed, type AppId } from './apps.js';
import { config } from './config.js';
import { db, firstTime, getSetting, log, setSetting } from './db.js';
import { emailReady, esc, layout, ownerEmail, sendEmail } from './email.js';
import liDb from './linkedin/db.js';
import { expiryStatus } from './linkedin/settings.js';
import { loginEmails, loginOptions, parseEmails, setLoginEmails } from './login.js';

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const flag = (k: string, d: number) => Number(getSetting(k, String(d))) === 1;
export const alertsOn = () => flag('email_alerts', 1);
export const summaryOn = () => flag('email_summary', 0);
const where = () => config.baseUrl.replace(/^https?:\/\//, '');
const n = (sql: string, ...a: unknown[]) => {
  try {
    return Number((db.prepare(sql).get(...a) as { n: number }).n) || 0;
  } catch {
    return 0;
  }
};

// ---------- alerts ----------

interface Item { at: number; text: string }

/** New problems since the last alert email. Nothing is marked as sent until an email actually goes out. */
function collect(): { items: Item[]; lastLog: number; liIds: number[] } {
  const items: Item[] = [];
  const since = Number(getSetting('alert_last_log_id', '-1'));
  // First run: start from now, don't email the whole history.
  if (since < 0) {
    const max = n('SELECT COALESCE(MAX(id), 0) AS n FROM logs');
    setSetting('alert_last_log_id', max);
    return { items, lastLog: max, liIds: [] };
  }
  const rows = db.prepare(
    "SELECT id, level, message, created_at FROM logs WHERE id > ? AND (level = 'error' OR (level = 'warn' AND (message LIKE '%expire%' OR message LIKE '%rejected%' OR message LIKE '%interrupted%'))) ORDER BY id LIMIT 200",
  ).all(since) as { id: number; message: string; created_at: number }[];
  for (const r of rows) items.push({ at: r.created_at, text: r.message });
  const lastLog = Math.max(since, n('SELECT COALESCE(MAX(id), 0) AS n FROM logs'));

  let liIds: number[] = [];
  if (appEnabled('linkedin')) {
    let seen: number[] = [];
    try { seen = JSON.parse(getSetting('alert_li_failed', '[]')); } catch { /* reset */ }
    const failed = liDb.prepare("select id, text, error from posts where status='failed' order by id desc limit 50").all() as { id: number; text: string; error: string }[];
    for (const p of failed) if (!seen.includes(p.id)) items.push({ at: Date.now(), text: `LinkedIn post failed: "${String(p.text).slice(0, 60)}" (${p.error ?? 'error'})` });
    liIds = [...new Set([...failed.map((p) => p.id), ...seen])].slice(0, 300);
    for (const a of expiryStatus()) {
      if (firstTime(`alert-li-exp:${a.id}:${a.expires_at}:${a.expired ? 'x' : 's'}`)) {
        items.push({ at: Date.now(), text: a.expired ? `LinkedIn connection for ${a.name} has expired. Reconnect it.` : `LinkedIn connection for ${a.name} expires in ${a.days_left} day(s).` });
      }
    }
  }
  return { items, lastLog, liIds };
}

export async function alertTick(): Promise<void> {
  if (!emailReady() || !alertsOn() || !loginEmails().length) return;
  const gap = Number(env('ALERT_MIN_GAP_MS', '3600000'));
  if (Date.now() - Number(getSetting('alert_last_sent_at', '0')) < gap) return;
  const { items, lastLog, liIds } = collect();
  if (!items.length) {
    setSetting('alert_last_log_id', lastLog);
    return;
  }
  const shown = items.slice(0, 20);
  const r = await sendEmail({
    to: loginEmails(),
    subject: `Autopilot: ${items.length} problem${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} attention`,
    text: `${shown.map((i) => `- ${i.text}`).join('\n')}${items.length > 20 ? `\n…and ${items.length - 20} more` : ''}\n\nOpen ${config.baseUrl}`,
    html: layout({
      title: `${items.length} problem${items.length === 1 ? '' : 's'} on your dashboard`,
      rows: [
        `<ul style="padding-left:18px;margin:0">${shown.map((i) => `<li style="margin-bottom:6px">${esc(i.text)}</li>`).join('')}</ul>`,
        ...(items.length > 20 ? [`…and ${items.length - 20} more.`] : []),
      ],
      button: { label: 'Open dashboard', url: config.baseUrl },
      footer: `Alerts for ${where()}. Turn them off under Account.`,
    }),
  });
  if (!r.ok) return;
  setSetting('alert_last_sent_at', Date.now());
  setSetting('alert_last_log_id', lastLog);
  setSetting('alert_li_failed', JSON.stringify(liIds));
}

// ---------- daily summary ----------

function localParts(tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function summaryLines(since = Date.now() - 86400_000): string[] {
  const lines: string[] = [];
  if (appEnabled('dm')) {
    lines.push(`Instagram DMs received: ${n("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND created_at > ?", since)}`);
    lines.push(`Instagram auto-replies sent: ${n("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent' AND source = 'auto' AND sent_at > ?", since)}`);
  }
  if (appEnabled('scheduler')) lines.push(`Instagram posts published: ${n("SELECT COUNT(*) AS n FROM posts WHERE status = 'published' AND published_at > ?", since)}`);
  if (appEnabled('linkedin')) {
    let li = 0;
    try { li = Number((liDb.prepare("select count(*) as n from posts where status='published' and published_at > ?").get(since) as { n: number }).n); } catch { /* old database */ }
    lines.push(`LinkedIn posts published: ${li}`);
  }
  if (appEnabled('whatsapp')) {
    lines.push(`WhatsApp messages received: ${n("SELECT COUNT(*) AS n FROM wa_messages WHERE direction = 'in' AND created_at > ?", since)}`);
    lines.push(`WhatsApp messages sent: ${n("SELECT COUNT(*) AS n FROM wa_outbox WHERE status = 'sent' AND sent_at > ?", since)}`);
  }
  const failed = n("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed' AND created_at > ?", since)
    + n("SELECT COUNT(*) AS n FROM posts WHERE status = 'failed' AND created_at > ?", since)
    + n("SELECT COUNT(*) AS n FROM wa_outbox WHERE status = 'failed' AND created_at > ?", since);
  lines.push(`Failed: ${failed}`);
  return lines;
}

export async function summaryTick(): Promise<void> {
  if (!emailReady() || !summaryOn() || !loginEmails().length) return;
  const tz = env('SUMMARY_TZ', 'Asia/Kolkata');
  let parts;
  try { parts = localParts(tz); } catch { parts = localParts('UTC'); }
  if (parts.hour < Number(env('SUMMARY_HOUR', '9')) || getSetting('summary_last_date') === parts.date) return;
  const lines = summaryLines();
  const r = await sendEmail({
    to: loginEmails(),
    subject: `Autopilot daily summary · ${parts.date}`,
    text: `Last 24 hours on ${where()}:\n${lines.map((l) => `- ${l}`).join('\n')}\n\n${config.baseUrl}`,
    html: layout({
      title: 'Your last 24 hours',
      rows: [`<table style="width:100%;border-collapse:collapse">${lines.map((l) => { const [k, v] = l.split(': '); return `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;font-weight:700">${esc(v)}</td></tr>`; }).join('')}</table>`],
      button: { label: 'Open dashboard', url: config.baseUrl },
      footer: `Daily summary for ${where()}. Turn it off under Account.`,
    }),
  });
  if (r.ok) setSetting('summary_last_date', parts.date);
}

let timer: NodeJS.Timeout | undefined;
export function startNotify(): void {
  const tick = () => {
    alertTick().catch((e) => log('warn', `Alert email check failed: ${(e as Error).message}`));
    summaryTick().catch((e) => log('warn', `Summary email failed: ${(e as Error).message}`));
  };
  timer = setInterval(tick, Number(env('ALERT_TICK_MS', '600000')));
  timer.unref();
  setTimeout(tick, 15_000).unref();
}
export const stopNotify = () => clearInterval(timer);

// ---------- account API (signed in) ----------

export const accountRouter = express.Router();
accountRouter.get('/', (_req, res) => {
  res.json({ emails: loginEmails(), ...loginOptions(), emailReady: emailReady(), alerts: alertsOn(), summary: summaryOn(), managed: managed(), summaryHour: Number(env('SUMMARY_HOUR', '9')), summaryTz: env('SUMMARY_TZ', 'Asia/Kolkata') });
});
accountRouter.put('/', (req, res) => {
  const b = req.body ?? {};
  if (b.emails !== undefined) {
    const list = parseEmails(b.emails);
    const raw = (Array.isArray(b.emails) ? b.emails : String(b.emails).split(/[\s,;]+/)).filter((x: unknown) => String(x).trim());
    if (raw.length !== list.length && raw.length) return void res.status(400).json({ error: 'One of those is not a valid email address' });
    setLoginEmails(list);
  }
  if (b.alerts !== undefined) setSetting('email_alerts', b.alerts ? 1 : 0);
  if (b.summary !== undefined) setSetting('email_summary', b.summary ? 1 : 0);
  res.json({ emails: loginEmails(), alerts: alertsOn(), summary: summaryOn() });
});
accountRouter.post('/test-email', async (_req, res) => {
  if (!loginEmails().length) return void res.status(400).json({ error: 'Add an email address first' });
  const r = await sendEmail({
    to: loginEmails(), subject: 'Autopilot test email',
    text: `Email from ${where()} works.`,
    html: layout({ title: 'Email works ✓', rows: [`Alerts and sign-in links from <b>${esc(where())}</b> will reach this inbox.`] }),
  });
  res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true } : { error: r.error });
});

// ---------- unlock requests (client -> owner) ----------

export function unlockRequests(): Partial<Record<AppId, number>> {
  try { return JSON.parse(getSetting('unlock_requests', '{}')); } catch { return {}; }
}

export const unlockRouter = express.Router();
unlockRouter.post('/', async (req, res) => {
  const app = String(req.body?.app ?? '') as AppId;
  if (!APPS.includes(app)) return void res.status(400).json({ error: 'Unknown app' });
  if (appEnabled(app)) return void res.json({ ok: true, already: true });
  const reqs = unlockRequests();
  const fresh = !reqs[app] || Date.now() - reqs[app]! > 86400_000;
  reqs[app] = Date.now();
  setSetting('unlock_requests', JSON.stringify(reqs));
  log('info', `Unlock requested for ${APP_NAMES[app]}`);
  let emailed = false;
  if (fresh && emailReady() && ownerEmail()) {
    const who = env('CLIENT_NAME') || where();
    const main = env('GOOGLE_AUTH_VIA') || '';
    const r = await sendEmail({
      to: ownerEmail(), replyTo: loginEmails()[0],
      subject: `${who} wants ${APP_NAMES[app]}`,
      text: `${who} (${config.baseUrl}) asked to unlock ${APP_NAMES[app]}.${loginEmails().length ? `\nTheir email: ${loginEmails().join(', ')}` : ''}${main ? `\nSwitch it on: ${main}/clients` : ''}`,
      html: layout({
        title: `Unlock request: ${APP_NAMES[app]}`,
        rows: [
          `<b>${esc(who)}</b> (${esc(where())}) asked to unlock <b>${esc(APP_NAMES[app])}</b>.`,
          ...(loginEmails().length ? [`Their email: ${esc(loginEmails().join(', '))}. Reply to this email to reach them.`] : []),
        ],
        ...(main ? { button: { label: 'Open Clients page', url: `${main}/clients` } } : {}),
      }),
    });
    emailed = r.ok;
  }
  res.json({ ok: true, emailed });
});
