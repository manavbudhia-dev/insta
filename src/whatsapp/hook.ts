/**
 * Tells n8n what happens on WhatsApp: a signed JSON POST per event, sent in the background with a couple of retries.
 * Same signature scheme as the Instagram webhook (X-Autopilot-Signature: sha256=HMAC(secret, raw body)).
 */
import crypto from 'node:crypto';
import { firstTime, getSetting, redact, setSetting } from '../db.js';
import { sign } from '../outhook.js';
import { open, seal } from '../vault.js';
import { waLog } from './store.js';

export const WA_EVENTS = ['whatsapp.message.received', 'whatsapp.reply.sent', 'whatsapp.reply.failed', 'whatsapp.opt_out'] as const;
export type WaEvent = (typeof WA_EVENTS)[number] | 'whatsapp.test';

const RETRY_DELAYS_MS = (process.env.OUTHOOK_RETRY_MS ?? '5000,30000').split(',').map(Number).filter((n) => n >= 0);

export function hookConfig() {
  return { url: getSetting('wa_hook_url'), secret: open(getSetting('wa_hook_secret')) };
}
export function newHookSecret(): string {
  const s = 'whsec_' + crypto.randomBytes(24).toString('base64url');
  setSetting('wa_hook_secret', seal(s));
  return s;
}
/** Returns an error message, or '' when saved. An empty URL turns it off. */
export function saveHookUrl(raw: unknown): string {
  const url = String(raw ?? '').trim();
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return 'Enter a full URL, for example https://n8n.example.com/webhook/whatsapp';
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The URL must start with https:// or http://';
    if (u.username || u.password) return 'Put credentials in n8n, not in the URL';
  }
  setSetting('wa_hook_url', url);
  if (url && !hookConfig().secret) newHookSecret();
  return '';
}

function account() {
  return { phone_number_id: getSetting('wa_phone_id') || null, display_phone_number: getSetting('wa_display_phone') || null };
}

async function post(event: WaEvent, raw: string, delivery: string) {
  const cfg = hookConfig();
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'User-Agent': 'WhatsApp-Autopilot-Webhook/1',
        'X-Autopilot-Event': event, 'X-Autopilot-Delivery': delivery, 'X-Autopilot-Signature': sign(cfg.secret, raw),
      },
      body: raw, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer().catch(() => undefined);
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `answered HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: redact((e as Error).message || 'network error') };
  }
}

function body(event: WaEvent, data: Record<string, unknown>) {
  const delivery = crypto.randomUUID();
  return { delivery, raw: JSON.stringify({ event, delivery, created_at: new Date().toISOString(), account: account(), data }) };
}

export async function deliverTest() {
  const cfg = hookConfig();
  if (!cfg.url) return { ok: false, status: 0, error: 'No webhook URL saved' };
  const { delivery, raw } = body('whatsapp.test', { message: 'Test event from WhatsApp Autopilot' });
  const r = await post('whatsapp.test', raw, delivery);
  setSetting('wa_hook_last', JSON.stringify({ at: Date.now(), event: 'whatsapp.test', ...r }));
  return r;
}

export function emit(event: Exclude<WaEvent, 'whatsapp.test'>, data: Record<string, unknown>): void {
  const cfg = hookConfig();
  if (!cfg.url || !cfg.secret) return;
  const { delivery, raw } = body(event, data);
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      const r = await post(event, raw, delivery);
      if (r.ok || attempt >= RETRY_DELAYS_MS.length || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) {
        setSetting('wa_hook_last', JSON.stringify({ at: Date.now(), event, ...r }));
        if (!r.ok && firstTime(`wa-outhook-fail:${Math.floor(Date.now() / 3600_000)}`)) {
          waLog('warn', `n8n webhook could not take "${event}" (${r.error}). Check the URL in WhatsApp settings and that the workflow is active.`);
        }
        return;
      }
      await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
    }
  })();
}
