import crypto from 'node:crypto';
import { firstTime, getSetting, log, redact, setSetting } from './db.js';
import { open, seal } from './vault.js';

/**
 * Outgoing webhook: tells n8n (or Zapier, Make, a script) what happens in DM Autopilot, so leads can flow on to
 * Google Sheets, a CRM or WhatsApp. Each call is a JSON POST signed with HMAC-SHA256 over the raw body.
 * Delivery never blocks or breaks message handling: it runs in the background with a few retries.
 */

export const HOOK_EVENTS = ['message.received', 'comment.received', 'reply.sent', 'reply.failed'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number] | 'test';

const RETRY_DELAYS_MS = (process.env.OUTHOOK_RETRY_MS ?? '5000,30000').split(',').map(Number).filter((n) => n >= 0);
const TIMEOUT_MS = 10_000;

export interface HookConfig { url: string; secret: string; events: string[] }

export function hookConfig(): HookConfig {
  const saved = getSetting('outhook_events');
  return {
    url: getSetting('outhook_url'),
    secret: open(getSetting('outhook_secret')),
    events: saved ? saved.split(',').filter((e) => (HOOK_EVENTS as readonly string[]).includes(e)) : [...HOOK_EVENTS],
  };
}

/** True when a URL is set, so callers can skip extra work (like a profile lookup) when nobody is listening. */
export function hookActive(): boolean {
  return !!getSetting('outhook_url');
}

export function newSecret(): string {
  const s = 'whsec_' + crypto.randomBytes(24).toString('base64url');
  setSetting('outhook_secret', seal(s));
  return s;
}

/** Validates and saves. An empty URL turns the webhook off. Returns an error message, or '' when saved. */
export function saveHookConfig(input: { url?: unknown; events?: unknown }): string {
  const url = String(input.url ?? '').trim();
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return 'Enter a full URL, for example https://n8n.example.com/webhook/instagram';
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The URL must start with https:// or http://';
    if (u.username || u.password) return 'Put credentials in n8n, not in the URL';
  }
  if (input.events !== undefined) {
    if (!Array.isArray(input.events)) return 'events must be a list';
    const events = input.events.map(String).filter((e) => (HOOK_EVENTS as readonly string[]).includes(e));
    setSetting('outhook_events', events.join(','));
  }
  setSetting('outhook_url', url);
  if (url && !hookConfig().secret) newSecret();
  return '';
}

export function sign(secret: string, raw: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function account() {
  return { id: getSetting('ig_user_id') || null, username: getSetting('ig_username') || null };
}

async function post(cfg: HookConfig, event: HookEvent, raw: string, delivery: string): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DM-Autopilot-Webhook/1',
        'X-Autopilot-Event': event,
        'X-Autopilot-Delivery': delivery,
        'X-Autopilot-Signature': sign(cfg.secret, raw),
      },
      body: raw,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.arrayBuffer().catch(() => undefined);
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `answered HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: redact((e as Error).message || 'network error') };
  }
}

function remember(r: { ok: boolean; status: number; error?: string }, event: string): void {
  setSetting('outhook_last', JSON.stringify({ at: Date.now(), event, ok: r.ok, status: r.status, error: r.error ?? null }));
}

/** Sends one event now (used by the dashboard's "Send test event"). */
export async function deliverNow(event: HookEvent, data: Record<string, unknown>) {
  const cfg = hookConfig();
  if (!cfg.url) return { ok: false, status: 0, error: 'No webhook URL saved' };
  const delivery = crypto.randomUUID();
  const raw = JSON.stringify({ event, delivery, created_at: new Date().toISOString(), account: account(), data });
  const r = await post(cfg, event, raw, delivery);
  remember(r, event);
  return r;
}

let inFlight = 0;
export const hookDeliveriesInFlight = () => inFlight;

/** Fire-and-forget. Never throws; failures are retried a couple of times, then logged (at most once an hour). */
export function emit(event: Exclude<HookEvent, 'test'>, data: Record<string, unknown>): void {
  const cfg = hookConfig();
  if (!cfg.url || !cfg.secret || !cfg.events.includes(event)) return;
  const delivery = crypto.randomUUID();
  // Built once, so every retry carries the same body, delivery id and signature: n8n can de-duplicate on the id.
  const raw = JSON.stringify({ event, delivery, created_at: new Date().toISOString(), account: account(), data });
  inFlight++;
  void (async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await post(cfg, event, raw, delivery);
        if (r.ok || attempt >= RETRY_DELAYS_MS.length || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) {
          remember(r, event);
          if (!r.ok && firstTime(`outhook-fail:${Math.floor(Date.now() / 3600_000)}`)) {
            log('warn', `n8n webhook: could not deliver "${event}" (${r.error}). Check the URL in Settings and that the n8n workflow is active.`);
          }
          return;
        }
        await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
      }
    } finally {
      inFlight--;
    }
  })();
}
