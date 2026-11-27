/**
 * Which mini apps this instance may use. A client instance (CONTROL_SECRET set by scripts/client.sh) is switched by
 * the owner from the main dashboard's Clients page; the setting lives in this instance's database, so it survives
 * restarts. The client's own login cannot change it. The main instance (no CONTROL_SECRET) always has every app.
 */
import crypto from 'node:crypto';
import express from 'express';
import { db, getSetting, log, setSetting } from './db.js';
import { loginEmails, parseEmails, setLoginEmails } from './login.js';

export const APPS = ['dm', 'scheduler', 'linkedin', 'whatsapp'] as const;
export type AppId = (typeof APPS)[number];
export const APP_NAMES: Record<AppId, string> = {
  dm: 'Instagram DM Automation', scheduler: 'Instagram Scheduler', linkedin: 'LinkedIn Scheduler', whatsapp: 'WhatsApp Automation',
};

const controlSecret = () => (process.env.CONTROL_SECRET ?? '').trim();
/** True on a client instance managed from the main dashboard. */
export const managed = () => controlSecret().length >= 16;

export function enabledApps(): Record<AppId, boolean> {
  const all = Object.fromEntries(APPS.map((a) => [a, true])) as Record<AppId, boolean>;
  if (!managed()) return all;
  let saved: Partial<Record<AppId, boolean>> = {};
  try {
    saved = JSON.parse(getSetting('apps_enabled') || '{}');
  } catch {
    /* damaged value: treat as all on */
  }
  for (const a of APPS) if (typeof saved[a] === 'boolean') all[a] = saved[a]!;
  return all;
}
export const appEnabled = (id: AppId) => enabledApps()[id];

export interface Upsell { message: string; contact: string }
export function upsell(): Upsell {
  try {
    const u = JSON.parse(getSetting('apps_upsell') || '{}');
    return { message: String(u.message ?? ''), contact: String(u.contact ?? '') };
  } catch {
    return { message: '', contact: '' };
  }
}

/** What the dashboard pages need: which apps are on, and what a locked app should say. */
export function appsView() {
  return { managed: managed(), apps: enabledApps(), names: APP_NAMES, upsell: upsell() };
}

function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * Control API the main instance calls over the private Docker network. Never reachable from the internet: Caddy
 * answers /internal/* with 404 itself, and anything that came through a proxy (X-Forwarded-For) is refused here too.
 */
export function controlRouter(status: () => Record<string, unknown>) {
  const r = express.Router();
  r.use((req, res, next) => {
    if (!managed() || req.get('x-forwarded-for') || !safeEqual(String(req.get('x-control-secret') ?? ''), controlSecret())) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  r.use(express.json({ limit: '16kb' }));
  const requests = () => { try { return JSON.parse(getSetting('unlock_requests', '{}')); } catch { return {}; } };
  r.get('/status', (_req, res) => void res.json({ ...appsView(), ...status(), loginEmails: loginEmails(), unlockRequests: requests() }));
  r.put('/apps', (req, res) => {
    const b = req.body ?? {};
    if (b.apps && typeof b.apps === 'object') {
      const cur = enabledApps();
      for (const a of APPS) if (typeof b.apps[a] === 'boolean') cur[a] = b.apps[a];
      const before = getSetting('apps_enabled');
      setSetting('apps_enabled', JSON.stringify(cur));
      // A request for a tool that is now on has been answered.
      const reqs = requests();
      for (const a of APPS) if (cur[a]) delete reqs[a];
      setSetting('unlock_requests', JSON.stringify(reqs));
      if (before !== JSON.stringify(cur)) {
        log('info', `Apps changed by the owner: ${APPS.map((a) => `${APP_NAMES[a]} ${cur[a] ? 'on' : 'off'}`).join(', ')}`);
      }
    }
    if (b.upsell && typeof b.upsell === 'object') {
      setSetting('apps_upsell', JSON.stringify({ message: String(b.upsell.message ?? '').slice(0, 500), contact: String(b.upsell.contact ?? '').slice(0, 200) }));
    }
    if (b.loginEmails !== undefined) setLoginEmails(parseEmails(b.loginEmails));
    res.json({ ...appsView(), loginEmails: loginEmails(), unlockRequests: requests() });
  });
  return r;
}

/** Last time anything happened here (a message in or out, a post), for the owner's overview. */
export function lastActivity(): number | null {
  const q = (sql: string) => {
    try {
      return Number((db.prepare(sql).get() as { t: number | null } | undefined)?.t) || 0;
    } catch {
      return 0;
    }
  };
  const t = Math.max(
    q('SELECT MAX(created_at) AS t FROM messages'),
    q('SELECT MAX(created_at) AS t FROM wa_messages'),
    q('SELECT MAX(created_at) AS t FROM posts'),
  );
  return t || null;
}
