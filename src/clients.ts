/**
 * The owner's Clients page (main instance only): lists the client instances created by scripts/client.sh and
 * switches their apps on and off. scripts/client.sh writes clients/shared/clients.json (mounted read-only at
 * /clients), with each client's internal address and control secret; calls go over the private Docker network.
 */
import fs from 'node:fs';
import express from 'express';
import { APP_NAMES, APPS, managed, type AppId } from './apps.js';
import { getSetting, log, setSetting } from './db.js';
import { emailReady, esc, layout, ownerEmail, sendEmail } from './email.js';

interface Client { name: string; url: string; internal: string; ig: string; secret: string }

const DEFAULT_UPSELL = { message: "This tool isn't part of your plan yet. Get in touch to unlock it.", contact: '' };

let cache: { mtime: number; list: Client[] } = { mtime: -1, list: [] };
function file(): string {
  return (process.env.CLIENTS_FILE ?? '').trim();
}
export function clients(): Client[] {
  const f = file();
  if (!f) return [];
  try {
    const mtime = fs.statSync(f).mtimeMs;
    if (mtime !== cache.mtime) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const list = (Array.isArray(raw) ? raw : []).filter(
        (c: any) => c && /^[a-z0-9-]{2,31}$/.test(c.name) && /^https?:\/\//.test(c.internal) && String(c.secret ?? '').length >= 16,
      );
      cache = { mtime, list: list.map((c: any) => ({ name: c.name, url: String(c.url ?? ''), internal: String(c.internal).replace(/\/+$/, ''), ig: String(c.ig ?? ''), secret: String(c.secret) })) };
    }
  } catch {
    cache = { mtime: -1, list: [] };
  }
  return cache.list;
}
/** The Clients page exists on the main instance once client.sh has written the file. */
export const clientsAvailable = () => !managed() && !!file() && fs.existsSync(file());

export function ownerUpsell(): { message: string; contact: string } {
  try {
    return { ...DEFAULT_UPSELL, ...JSON.parse(getSetting('client_upsell') || '{}') };
  } catch {
    return DEFAULT_UPSELL;
  }
}

async function call(c: Client, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${c.internal}/internal${path}`, {
    method,
    headers: { 'X-Control-Secret': c.secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Number(process.env.CLIENT_CALL_TIMEOUT_MS ?? 5000)),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 404 ? 'the instance refused the control key (run scripts/client.sh sync on the server)' : json.error || `HTTP ${res.status}`);
  return json;
}

const view = (c: Client, s: any) => ({ name: c.name, url: c.url, ig: c.ig, online: true, ...s });
const offline = (c: Client, e: unknown) => ({ name: c.name, url: c.url, ig: c.ig, online: false, error: (e as Error).message || 'unreachable' });

export const clientsRouter = express.Router();
clientsRouter.use((_req, res, next) => (clientsAvailable() ? next() : void res.status(404).json({ error: 'No clients on this server' })));

clientsRouter.get('/', async (_req, res) => {
  const list = clients();
  const rows = await Promise.all(list.map((c) => call(c, 'GET', '/status').then((s) => view(c, s), (e) => offline(c, e))));
  res.json({ clients: rows, upsell: ownerUpsell(), apps: APPS, emailReady: emailReady() });
});

clientsRouter.put('/upsell', async (req, res) => {
  const u = { message: String(req.body?.message ?? '').trim().slice(0, 500), contact: String(req.body?.contact ?? '').trim().slice(0, 200) };
  setSetting('client_upsell', JSON.stringify(u));
  const results = await Promise.all(clients().map((c) => call(c, 'PUT', '/apps', { upsell: u }).then(() => ({ name: c.name, ok: true }), (e) => ({ name: c.name, ok: false, error: (e as Error).message }))));
  res.json({ upsell: u, results });
});

clientsRouter.put('/:name', async (req, res) => {
  const c = clients().find((x) => x.name === req.params.name);
  if (!c) return void res.status(404).json({ error: 'No such client' });
  const apps: Partial<Record<AppId, boolean>> = {};
  for (const a of APPS) if (typeof req.body?.apps?.[a] === 'boolean') apps[a] = req.body.apps[a];
  const body: Record<string, unknown> = { apps, upsell: ownerUpsell() };
  if (req.body?.loginEmails !== undefined) body.loginEmails = req.body.loginEmails;
  try {
    const s = await call(c, 'PUT', '/apps', body);
    if (Object.keys(apps).length) log('info', `Client ${c.name}: ${Object.entries(apps).map(([a, on]) => `${a} ${on ? 'on' : 'off'}`).join(', ')}`);
    res.json(view(c, s));
  } catch (e) {
    res.status(502).json({ error: `Could not reach ${c.name}: ${(e as Error).message}` });
  }
});

/** Welcome email to the client's login addresses: where their dashboard is and how to sign in (no password by email). */
clientsRouter.post('/:name/welcome', async (req, res) => {
  const c = clients().find((x) => x.name === req.params.name);
  if (!c) return void res.status(404).json({ error: 'No such client' });
  if (!emailReady()) return void res.status(400).json({ error: 'Email is not set up: add RESEND_API_KEY and EMAIL_FROM to .env' });
  let s: any;
  try {
    s = await call(c, 'GET', '/status');
  } catch (e) {
    return void res.status(502).json({ error: `Could not reach ${c.name}: ${(e as Error).message}` });
  }
  const to: string[] = s.loginEmails ?? [];
  if (!to.length) return void res.status(400).json({ error: 'Add the client\'s email first' });
  const tools = APPS.filter((a) => s.apps?.[a]).map((a) => APP_NAMES[a]);
  const host = c.url.replace(/^https?:\/\//, '');
  const r = await sendEmail({
    to, replyTo: ownerEmail() || undefined,
    subject: 'Your Autopilot dashboard is ready',
    text: `Your dashboard is ready: ${c.url}\n\nSign in with Google using this email address, or ask for a sign-in link on the login page.\n${tools.length ? `\nIncluded: ${tools.join(', ')}` : ''}\n\nFirst step: connect your Instagram account on the DM Automation page.`,
    html: layout({
      title: 'Your Autopilot dashboard is ready',
      rows: [
        `Your dashboard lives at <b>${esc(host)}</b>.`,
        `Sign in with <b>Google</b> using this email address, or enter it on the login page to get a one-time sign-in link. No password needed.`,
        ...(tools.length ? [`Included in your plan: ${tools.map((t) => `<b>${esc(t)}</b>`).join(', ')}.`] : []),
        'First step: connect your Instagram account from the dashboard.',
      ],
      button: { label: 'Open my dashboard', url: c.url },
      footer: ownerEmail() ? `Questions? Reply to this email.` : undefined,
    }),
  });
  if (!r.ok) return void res.status(502).json({ error: r.error });
  log('info', `Welcome email sent to ${c.name} (${to.join(', ')})`);
  res.json({ ok: true, to });
});
