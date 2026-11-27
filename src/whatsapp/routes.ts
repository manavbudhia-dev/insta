/**
 * WhatsApp automation, mounted at /whatsapp: Meta webhook, dashboard API (behind the platform login),
 * an API-key endpoint n8n can send messages through, and the dashboard page.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { config } from '../config.js';
import { db, delSetting, getSetting, log, redact, setSetting } from '../db.js';
import { build, cloud, WaError } from './cloud.js';
import { handleChange, parseRule } from './engine.js';
import { deliverTest, hookConfig, newHookSecret, saveHookUrl } from './hook.js';
import { enqueue, startQueue, stopQueue, tick, windowOpen } from './queue.js';
import {
  apiKeyMatches, configured, newApiKey, normalizePhone, phoneId, prune, setWaAppSecret, setWaToken, upsertContact,
  verifyToken, WA_DEFAULTS, waAppSecret, waLog, waOpt, waOwnAppSecret, waToken,
} from './store.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'whatsapp');
export const webhookUrl = () => `${config.baseUrl}/whatsapp/webhook`;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function validSignature(raw: Buffer, header: string | undefined): boolean {
  const secret = waAppSecret();
  if (!header?.startsWith('sha256=') || !secret) return false;
  return safeEqual('sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'), header);
}

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const int = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const bad = (res: Response, error: string, status = 400) => void res.status(status).json({ error });
const waErr = (res: Response, e: unknown) => {
  const err = e as WaError;
  bad(res, redact(err.message ?? String(e)), err.status && err.status < 500 ? 400 : 502);
};

/** Validates a rule from the dashboard. Returns the row or an error message. */
function ruleInput(b: any): { row: any } | { error: string } {
  const name = clean(b.name, 80);
  const trigger = b.trigger_type === 'welcome' ? 'welcome' : 'message';
  const mode = ['contains', 'exact', 'any'].includes(b.match_mode) ? b.match_mode : 'contains';
  const keywords = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords ?? '').split(','))
    .map((k: unknown) => clean(k, 60)).filter(Boolean).slice(0, 30);
  const reply = String(b.reply_text ?? '').trim().slice(0, 4096);
  const buttons = (Array.isArray(b.buttons) ? b.buttons : []).map((t: unknown) => clean(t, 20)).filter(Boolean).slice(0, 3);
  if (!name) return { error: 'Give the rule a name' };
  if (!reply) return { error: 'Write the reply message' };
  if (trigger === 'message' && mode !== 'any' && !keywords.length) return { error: 'Add at least one keyword, or choose "Any message"' };
  if (buttons.length && reply.length > 1024) return { error: 'With buttons, WhatsApp allows at most 1024 characters' };
  if (new Set(buttons.map((t: string) => t.toLowerCase())).size !== buttons.length) return { error: 'Button titles must be different' };
  return {
    row: {
      name, enabled: b.enabled === false || b.enabled === 0 ? 0 : 1, trigger_type: trigger, match_mode: trigger === 'welcome' ? 'any' : mode,
      keywords: JSON.stringify(trigger === 'welcome' ? [] : keywords), reply_text: reply, buttons: JSON.stringify(buttons),
      cooldown_minutes: int(b.cooldown_minutes, 0, 10080, 0), priority: int(b.priority, -100, 100, 0),
    },
  };
}

/** Parses pasted recipients: one per line, "number" or "number, var1, var2" (CSV with optional header). */
export function parseRecipients(text: string, params: number): { list: { to: string; params: string[] }[]; invalid: string[] } {
  const seen = new Set<string>();
  const list: { to: string; params: string[] }[] = [];
  const invalid: string[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const to = normalizePhone(cells[0]);
    if (!to) {
      if (!/^(phone|number|mobile|to|wa_id)/i.test(cells[0])) invalid.push(line.trim().slice(0, 40));
      continue;
    }
    if (seen.has(to)) continue;
    const p = cells.slice(1, 1 + params).map((c) => c.slice(0, 200));
    if (p.length < params || p.some((c) => !c)) {
      invalid.push(line.trim().slice(0, 40));
      continue;
    }
    seen.add(to);
    list.push({ to, params: p });
  }
  return { list, invalid };
}

function templateRow(t: any) {
  const comps: any[] = t.components ?? [];
  const body = comps.find((c) => c.type === 'BODY')?.text ?? '';
  const nums = [...String(body).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  const header = comps.find((c) => c.type === 'HEADER');
  const buttons = (comps.find((c) => c.type === 'BUTTONS')?.buttons ?? []).map((b: any) => ({ type: b.type, text: b.text }));
  return { name: t.name, language: t.language, status: t.status, category: t.category ?? null, body, params: nums.length ? Math.max(...nums) : 0, header_type: header?.format ?? null, buttons: JSON.stringify(buttons) };
}

function settingsView() {
  const hook = hookConfig();
  let hookLast = null;
  try { hookLast = JSON.parse(getSetting('wa_hook_last') || 'null'); } catch { /* ignore */ }
  return {
    phoneId: phoneId(), wabaId: getSetting('wa_waba_id'), tokenSet: !!waToken(),
    appSecretSet: !!waOwnAppSecret(), appSecretFromEnv: !waOwnAppSecret() && !!config.metaAppSecret,
    verifyToken: verifyToken(), webhookUrl: webhookUrl(),
    display: { phone: getSetting('wa_display_phone') || null, name: getSetting('wa_display_name') || null, quality: getSetting('wa_quality') || null, tier: getSetting('wa_tier') || null },
    defaultCc: getSetting('wa_default_cc'),
    stopReply: getSetting('wa_stop_reply', "You've been unsubscribed and won't get broadcasts from us. Reply START to subscribe again."),
    automation: !!waOpt('wa_automation_enabled'), markRead: !!waOpt('wa_mark_read'),
    humanPauseMin: waOpt('wa_human_pause_min'), contactHourlyLimit: waOpt('wa_contact_hourly_limit'), hourlyLimit: waOpt('wa_hourly_limit'),
    hookUrl: hook.url, hookSecret: hook.secret, hookLast,
    apiKeySet: !!getSetting('wa_api_key'), sendUrl: `${config.baseUrl}/whatsapp/api/external/send`,
  };
}

/** Queues a manual / API message. Text needs an open 24h window; a template does not. */
function queueSend(waId: string, b: any, source: 'manual' | 'api'): { id: number } | { error: string } {
  if (b.template) {
    const name = clean(b.template, 512);
    const language = clean(b.language || 'en_US', 15);
    const params = (Array.isArray(b.params) ? b.params : []).map((p: unknown) => clean(p, 1000));
    if (params.some((p: string) => !p)) return { error: 'Template variables cannot be empty' };
    upsertContact(waId);
    return { id: enqueue({ waId, kind: 'template', payload: build.template(name, language, params), preview: `Template: ${name}${params.length ? ` (${params.join(', ')})` : ''}`, source }) };
  }
  const text = String(b.text ?? '').trim().slice(0, 4096);
  if (!text) return { error: 'Write a message' };
  if (!windowOpen(waId)) return { error: 'More than 24 hours since this person last wrote. WhatsApp only allows an approved template now.' };
  return { id: enqueue({ waId, kind: 'text', payload: build.text(text), preview: text, source }) };
}

export function createWhatsAppApp(opts: { isLoggedIn: (req: Request) => boolean }) {
  const app = express.Router();

  // ---- Meta webhook (public; authenticated by the verify token / the X-Hub-Signature-256 header) ----
  app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && safeEqual(String(req.query['hub.verify_token'] ?? ''), verifyToken())) {
      res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    } else res.sendStatus(403);
  });
  app.post('/webhook', express.json({ limit: '2mb', verify: (req, _res, buf) => void ((req as any).rawBody = buf) }), (req, res) => {
    const raw: Buffer | undefined = (req as any).rawBody;
    if (!raw || !validSignature(raw, req.get('x-hub-signature-256'))) {
      waLog('warn', 'Rejected a webhook call with a missing or invalid signature (check the app secret in WhatsApp settings)');
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200);
    setSetting('wa_last_webhook_at', Date.now());
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return;
    const mine = phoneId();
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages' || !change.value) continue;
        // One WhatsApp Business Account can hold several numbers; only act for the connected one.
        const pid = String(change.value.metadata?.phone_number_id ?? '');
        if (mine && pid && pid !== mine) continue;
        handleChange(change.value);
      }
    }
    void tick();
  });

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ---- n8n / external tools: send with the API key, no dashboard session ----
  app.post('/api/external/send', express.json({ limit: '64kb' }), (req, res) => {
    const given = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!apiKeyMatches(given)) return bad(res, 'Invalid or missing API key', 401);
    if (!configured()) return bad(res, 'WhatsApp is not connected yet');
    const to = normalizePhone(req.body?.to);
    if (!to) return bad(res, 'Give "to" as a phone number with country code, e.g. 919876543210');
    const r = queueSend(to, req.body ?? {}, 'api');
    if ('error' in r) return bad(res, r.error);
    void tick();
    res.status(202).json({ queued: true, id: r.id, to });
  });
  app.get('/api/external/status/:id', (req, res) => {
    const given = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!apiKeyMatches(given)) return bad(res, 'Invalid or missing API key', 401);
    const row = db.prepare(
      "SELECT o.id, o.wa_id, o.status AS queue_status, o.error, o.wamid, m.status AS delivery FROM wa_outbox o LEFT JOIN wa_messages m ON m.wamid = o.wamid WHERE o.id = ? AND o.source = 'api'",
    ).get(Number(req.params.id));
    if (!row) return bad(res, 'Not found', 404);
    res.json(row);
  });

  // ---- dashboard API ----
  app.use('/api', (req, res, next) => (opts.isLoggedIn(req) ? next() : bad(res, 'Not signed in', 401)));
  app.use('/api', express.json({ limit: '2mb' }));

  app.get('/api/status', (_req, res) => {
    const now = Date.now();
    const week = now - 7 * 86400_000;
    const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
    res.json({
      configured: configured(),
      automation: !!waOpt('wa_automation_enabled'),
      display: { phone: getSetting('wa_display_phone') || null, name: getSetting('wa_display_name') || null, quality: getSetting('wa_quality') || null },
      lastWebhookAt: Number(getSetting('wa_last_webhook_at')) || null,
      received7d: n("SELECT COUNT(*) AS n FROM wa_messages WHERE direction = 'in' AND created_at > ?", week),
      sent7d: n("SELECT COUNT(*) AS n FROM wa_outbox WHERE status = 'sent' AND sent_at > ?", week),
      autoSent7d: n("SELECT COUNT(*) AS n FROM wa_outbox WHERE status = 'sent' AND source = 'auto' AND sent_at > ?", week),
      contacts: n('SELECT COUNT(*) AS n FROM wa_contacts'),
      awaiting: n('SELECT COUNT(*) AS n FROM wa_contacts WHERE last_inbound_at > ? AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at)', now - 86400_000),
      failed24h: n("SELECT COUNT(*) AS n FROM wa_outbox WHERE status = 'failed' AND created_at > ?", now - 86400_000),
      pending: n("SELECT COUNT(*) AS n FROM wa_outbox WHERE status IN ('pending', 'sending')"),
      rulesOn: n('SELECT COUNT(*) AS n FROM wa_rules WHERE enabled = 1'),
      broadcastsScheduled: n("SELECT COUNT(*) AS n FROM wa_broadcasts WHERE status IN ('scheduled', 'running')"),
      nextBroadcast: db.prepare("SELECT id, name, scheduled_at FROM wa_broadcasts WHERE status = 'scheduled' ORDER BY scheduled_at LIMIT 1").get() ?? null,
    });
  });

  // settings
  app.get('/api/settings', (_req, res) => void res.json(settingsView()));
  app.put('/api/settings', (req, res) => {
    const b = req.body ?? {};
    if (b.phoneId !== undefined) {
      const v = clean(b.phoneId, 30);
      if (v && !/^\d{5,30}$/.test(v)) return bad(res, 'The phone number ID is a long number from WhatsApp > API Setup (not the phone number itself)');
      if (v !== phoneId()) ['wa_display_phone', 'wa_display_name', 'wa_quality', 'wa_tier'].forEach(delSetting);
      setSetting('wa_phone_id', v);
    }
    if (b.wabaId !== undefined) {
      const v = clean(b.wabaId, 30);
      if (v && !/^\d{5,30}$/.test(v)) return bad(res, 'The WhatsApp Business Account ID is a long number');
      setSetting('wa_waba_id', v);
    }
    if (typeof b.token === 'string' && b.token.trim()) setWaToken(b.token.trim());
    if (b.clearToken === true) setWaToken('');
    if (typeof b.appSecret === 'string') setWaAppSecret(b.appSecret.trim());
    if (b.defaultCc !== undefined) {
      const v = clean(b.defaultCc, 4).replace(/^\+/, '');
      if (v && !/^\d{1,4}$/.test(v)) return bad(res, 'Country code is 1-4 digits, e.g. 91');
      setSetting('wa_default_cc', v);
    }
    if (b.stopReply !== undefined) setSetting('wa_stop_reply', String(b.stopReply).trim().slice(0, 1000));
    if (b.automation !== undefined) setSetting('wa_automation_enabled', b.automation ? 1 : 0);
    if (b.markRead !== undefined) setSetting('wa_mark_read', b.markRead ? 1 : 0);
    if (b.humanPauseMin !== undefined) setSetting('wa_human_pause_min', int(b.humanPauseMin, 0, 10080, WA_DEFAULTS.wa_human_pause_min));
    if (b.contactHourlyLimit !== undefined) setSetting('wa_contact_hourly_limit', int(b.contactHourlyLimit, 1, 100, WA_DEFAULTS.wa_contact_hourly_limit));
    if (b.hourlyLimit !== undefined) setSetting('wa_hourly_limit', int(b.hourlyLimit, 1, 100000, WA_DEFAULTS.wa_hourly_limit));
    if (b.hookUrl !== undefined) {
      const err = saveHookUrl(b.hookUrl);
      if (err) return bad(res, err);
    }
    res.json(settingsView());
  });
  app.post('/api/settings/test', async (_req, res) => {
    try {
      const info = await cloud.phoneInfo();
      setSetting('wa_display_phone', info.display_phone_number ?? '');
      setSetting('wa_display_name', info.verified_name ?? '');
      setSetting('wa_quality', info.quality_rating ?? '');
      setSetting('wa_tier', info.messaging_limit_tier ?? '');
      log('info', `WhatsApp: connected ${info.display_phone_number ?? ''} (${info.verified_name ?? ''})`);
      res.json({ ok: true, info });
    } catch (e) {
      waErr(res, e);
    }
  });
  app.post('/api/settings/subscribe', async (_req, res) => {
    try {
      await cloud.subscribeApp();
      res.json({ ok: true });
    } catch (e) {
      waErr(res, e);
    }
  });
  app.post('/api/settings/api-key', (_req, res) => void res.json({ key: newApiKey() }));
  app.post('/api/settings/hook-secret', (_req, res) => void res.json({ secret: newHookSecret() }));
  app.post('/api/settings/hook-test', async (_req, res) => void res.json(await deliverTest()));

  // rules
  app.get('/api/rules', (_req, res) => void res.json((db.prepare('SELECT * FROM wa_rules ORDER BY priority DESC, id').all() as any[]).map(parseRule)));
  app.post('/api/rules', (req, res) => {
    const r = ruleInput(req.body ?? {});
    if ('error' in r) return bad(res, r.error);
    const x = r.row;
    const info = db.prepare(
      'INSERT INTO wa_rules (name, enabled, trigger_type, match_mode, keywords, reply_text, buttons, cooldown_minutes, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(x.name, x.enabled, x.trigger_type, x.match_mode, x.keywords, x.reply_text, x.buttons, x.cooldown_minutes, x.priority, Date.now());
    res.json(parseRule(db.prepare('SELECT * FROM wa_rules WHERE id = ?').get(info.lastInsertRowid)));
  });
  app.put('/api/rules/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM wa_rules WHERE id = ?').get(id) as any;
    if (!cur) return bad(res, 'Rule not found', 404);
    // A bare {enabled} toggles; anything else is a full edit.
    const keys = Object.keys(req.body ?? {});
    if (keys.length === 1 && keys[0] === 'enabled') {
      db.prepare('UPDATE wa_rules SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, id);
    } else {
      const r = ruleInput({ ...parseRule(cur), ...req.body });
      if ('error' in r) return bad(res, r.error);
      const x = r.row;
      db.prepare('UPDATE wa_rules SET name=?, enabled=?, trigger_type=?, match_mode=?, keywords=?, reply_text=?, buttons=?, cooldown_minutes=?, priority=? WHERE id=?')
        .run(x.name, x.enabled, x.trigger_type, x.match_mode, x.keywords, x.reply_text, x.buttons, x.cooldown_minutes, x.priority, id);
    }
    res.json(parseRule(db.prepare('SELECT * FROM wa_rules WHERE id = ?').get(id)));
  });
  app.delete('/api/rules/:id', (req, res) => {
    db.prepare('DELETE FROM wa_rules WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // inbox
  app.get('/api/contacts', (req, res) => {
    const q = clean(req.query.q, 60);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const rows = db.prepare(`
      SELECT c.*, (SELECT text FROM wa_messages m WHERE m.wa_id = c.wa_id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_text,
        MAX(COALESCE(c.last_inbound_at, 0), COALESCE(c.last_outbound_at, 0), c.first_seen) AS last_at
      FROM wa_contacts c ${q ? 'WHERE c.wa_id LIKE ? OR c.name LIKE ?' : ''}
      ORDER BY last_at DESC LIMIT 200`).all(...(q ? [like, like] : [])) as any[];
    const now = Date.now();
    res.json(rows.map((r) => ({
      ...r, window_open: !!r.last_inbound_at && now - r.last_inbound_at < 86400_000,
      awaiting: !!r.last_inbound_at && (!r.last_outbound_at || r.last_outbound_at < r.last_inbound_at), paused: r.paused_until > now,
    })));
  });
  app.get('/api/contacts/:waId/messages', (req, res) => {
    const waId = normalizePhone(req.params.waId, '');
    const contact = db.prepare('SELECT * FROM wa_contacts WHERE wa_id = ?').get(waId) as any;
    if (!contact) return bad(res, 'Contact not found', 404);
    const messages = db.prepare('SELECT * FROM (SELECT * FROM wa_messages WHERE wa_id = ? ORDER BY created_at DESC, id DESC LIMIT 200) ORDER BY created_at, id').all(waId);
    const queued = db.prepare("SELECT id, kind, preview, status, error, created_at FROM wa_outbox WHERE wa_id = ? AND status IN ('pending', 'sending', 'failed', 'skipped') AND created_at > ? ORDER BY id").all(waId, Date.now() - 7 * 86400_000);
    res.json({ contact: { ...contact, window_open: windowOpen(waId), paused: contact.paused_until > Date.now() }, messages, queued });
  });
  app.post('/api/contacts/:waId/send', (req, res) => {
    if (!configured()) return bad(res, 'Connect WhatsApp in Settings first');
    const waId = normalizePhone(req.params.waId);
    if (!waId) return bad(res, 'Enter a phone number with country code');
    const r = queueSend(waId, req.body ?? {}, 'manual');
    if ('error' in r) return bad(res, r.error);
    // You are talking to them yourself: the bot stays out of the way for a while.
    const pause = waOpt('wa_human_pause_min');
    if (pause > 0) db.prepare('UPDATE wa_contacts SET paused_until = MAX(paused_until, ?) WHERE wa_id = ?').run(Date.now() + pause * 60_000, waId);
    void tick();
    res.json({ queued: true, id: r.id, wa_id: waId });
  });
  app.put('/api/contacts/:waId', (req, res) => {
    const waId = normalizePhone(req.params.waId, '');
    if (!db.prepare('SELECT 1 FROM wa_contacts WHERE wa_id = ?').get(waId)) return bad(res, 'Contact not found', 404);
    const b = req.body ?? {};
    if (b.paused !== undefined) db.prepare('UPDATE wa_contacts SET paused_until = ? WHERE wa_id = ?').run(b.paused ? Date.now() + 365 * 86400_000 : 0, waId);
    if (b.opted_out !== undefined) db.prepare('UPDATE wa_contacts SET opted_out = ? WHERE wa_id = ?').run(b.opted_out ? 1 : 0, waId);
    if (b.name !== undefined) db.prepare('UPDATE wa_contacts SET name = ? WHERE wa_id = ?').run(clean(b.name, 80) || null, waId);
    res.json({ ok: true });
  });

  // templates
  app.get('/api/templates', (_req, res) => {
    const rows = db.prepare('SELECT * FROM wa_templates ORDER BY status = \'APPROVED\' DESC, name, language').all() as any[];
    res.json({ templates: rows.map((r) => ({ ...r, buttons: JSON.parse(r.buttons) })), syncedAt: Number(getSetting('wa_templates_synced_at')) || null });
  });
  app.post('/api/templates/sync', async (_req, res) => {
    try {
      const list = (await cloud.templates()).map(templateRow);
      db.transaction(() => {
        db.prepare('DELETE FROM wa_templates').run();
        const ins = db.prepare('INSERT OR REPLACE INTO wa_templates (name, language, status, category, body, params, header_type, buttons, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const t of list) ins.run(t.name, t.language, t.status, t.category, t.body, t.params, t.header_type, t.buttons, Date.now());
      })();
      setSetting('wa_templates_synced_at', Date.now());
      res.json({ ok: true, count: list.length });
    } catch (e) {
      waErr(res, e);
    }
  });

  // broadcasts
  app.get('/api/broadcasts', (_req, res) => {
    const rows = db.prepare('SELECT id, name, template, language, total, skipped, status, scheduled_at, created_at, started_at, finished_at FROM wa_broadcasts ORDER BY id DESC LIMIT 100').all() as any[];
    const stats = db.prepare(`
      SELECT broadcast_id AS id,
        SUM(status = 'pending' OR status = 'sending') AS queued, SUM(status = 'failed') AS failed, SUM(status = 'skipped') AS optout
      FROM wa_outbox WHERE broadcast_id IS NOT NULL GROUP BY broadcast_id`).all() as any[];
    const delivery = db.prepare(`
      SELECT broadcast_id AS id, COUNT(*) AS sent, SUM(status IN ('delivered', 'read')) AS delivered, SUM(status = 'read') AS read, SUM(status = 'failed') AS failed
      FROM wa_messages WHERE broadcast_id IS NOT NULL GROUP BY broadcast_id`).all() as any[];
    const by = (arr: any[]) => new Map(arr.map((r) => [r.id, r]));
    const s = by(stats);
    const d = by(delivery);
    res.json(rows.map((b) => {
      const q = s.get(b.id) ?? {};
      const m = d.get(b.id) ?? {};
      return { ...b, queued: q.queued ?? 0, sent: m.sent ?? 0, delivered: m.delivered ?? 0, read: m.read ?? 0, failed: (q.failed ?? 0) + (m.failed ?? 0), skipped: b.skipped + (q.optout ?? 0) };
    }));
  });
  app.post('/api/broadcasts/preview', (req, res) => {
    const t = db.prepare('SELECT params FROM wa_templates WHERE name = ? AND language = ?').get(clean(req.body?.template, 512), clean(req.body?.language, 15)) as { params: number } | undefined;
    const r = parseRecipients(String(req.body?.recipients ?? ''), t?.params ?? 0);
    res.json({ valid: r.list.length, invalid: r.invalid.slice(0, 20), invalidCount: r.invalid.length });
  });
  app.post('/api/broadcasts', (req, res) => {
    if (!configured()) return bad(res, 'Connect WhatsApp in Settings first');
    const b = req.body ?? {};
    const name = clean(b.name, 80) || 'Broadcast';
    const t = db.prepare('SELECT * FROM wa_templates WHERE name = ? AND language = ?').get(clean(b.template, 512), clean(b.language, 15)) as any;
    if (!t) return bad(res, 'Pick a template (sync templates first)');
    if (t.status !== 'APPROVED') return bad(res, `That template is ${t.status.toLowerCase()}, not approved yet`);
    if (t.header_type && t.header_type !== 'TEXT') return bad(res, `Templates with a ${t.header_type.toLowerCase()} header are not supported for broadcasts yet; use one with a text or no header`);
    if (/\{\{/.test(String(JSON.parse(t.buttons).map((x: any) => x.text).join(' ')))) return bad(res, 'Templates with variable buttons are not supported for broadcasts yet');
    const r = parseRecipients(String(b.recipients ?? ''), t.params);
    if (!r.list.length) return bad(res, t.params ? `Add recipients as "number, ${Array.from({ length: t.params }, (_, i) => `var${i + 1}`).join(', ')}" (one per line)` : 'Add at least one phone number');
    if (r.list.length > 50000) return bad(res, 'At most 50,000 recipients per broadcast');
    const at = b.scheduled_at ? Number(new Date(b.scheduled_at)) : Date.now();
    if (!Number.isFinite(at)) return bad(res, 'Pick a valid date and time');
    if (at > Date.now() + 90 * 86400_000) return bad(res, 'Schedule at most 90 days ahead');
    const info = db.prepare('INSERT INTO wa_broadcasts (name, template, language, recipients, total, scheduled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, t.name, t.language, JSON.stringify(r.list), r.list.length, Math.max(at, Date.now()), Date.now());
    waLog('info', `Broadcast "${name}" created for ${r.list.length} recipient(s)`);
    void tick();
    res.json({ id: Number(info.lastInsertRowid), total: r.list.length, invalid: r.invalid.length });
  });
  app.post('/api/broadcasts/:id/cancel', (req, res) => {
    const id = Number(req.params.id);
    const b = db.prepare('SELECT status FROM wa_broadcasts WHERE id = ?').get(id) as { status: string } | undefined;
    if (!b) return bad(res, 'Not found', 404);
    if (b.status !== 'scheduled' && b.status !== 'running') return bad(res, 'This broadcast has already finished');
    db.transaction(() => {
      db.prepare("UPDATE wa_outbox SET status = 'skipped', error = 'Broadcast cancelled' WHERE broadcast_id = ? AND status = 'pending'").run(id);
      db.prepare("UPDATE wa_broadcasts SET status = 'cancelled', finished_at = ? WHERE id = ?").run(Date.now(), id);
    })();
    res.json({ ok: true });
  });
  app.delete('/api/broadcasts/:id', (req, res) => {
    const id = Number(req.params.id);
    const b = db.prepare('SELECT status FROM wa_broadcasts WHERE id = ?').get(id) as { status: string } | undefined;
    if (!b) return bad(res, 'Not found', 404);
    if (b.status === 'running' || b.status === 'scheduled') return bad(res, 'Cancel it first');
    db.prepare('DELETE FROM wa_broadcasts WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // activity
  app.get('/api/activity', (_req, res) => {
    res.json({
      failed: db.prepare("SELECT id, wa_id, kind, preview, error, source, created_at FROM wa_outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 50").all(),
      logs: db.prepare("SELECT level, message, created_at FROM logs WHERE message LIKE 'WhatsApp:%' ORDER BY id DESC LIMIT 100").all(),
    });
  });
  app.post('/api/outbox/:id/retry', (req, res) => {
    const r = db.prepare("UPDATE wa_outbox SET status = 'pending', attempts = 0, error = NULL, next_attempt_at = ? WHERE id = ? AND status = 'failed'").run(Date.now(), Number(req.params.id));
    if (!r.changes) return bad(res, 'Only failed messages can be retried');
    void tick();
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => bad(res, 'Not found', 404));

  // ---- the dashboard page (its script checks the session and sends you to sign in) ----
  app.get('/', (req, res) => {
    const [p, q] = req.originalUrl.split('?');
    if (!p.endsWith('/')) return res.redirect(301, `/whatsapp/${q ? `?${q}` : ''}`);
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
  app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: 'deny' }));

  let pruneTimer: NodeJS.Timeout | undefined;
  return {
    app,
    start() {
      startQueue();
      pruneTimer = setInterval(prune, 6 * 3600_000);
      prune();
    },
    async stop() {
      clearInterval(pruneTimer);
      await stopQueue();
    },
  };
}
