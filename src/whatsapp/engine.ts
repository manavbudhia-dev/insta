/**
 * Incoming WhatsApp webhooks: stores messages, answers with the best matching rule, handles STOP / START,
 * and tracks delivery receipts for sent messages.
 */
import { db, firstTime, getSetting, redact } from '../db.js';
import { matchesText } from '../engine.js';
import { build, cloud } from './cloud.js';
import { emit } from './hook.js';
import { enqueue } from './queue.js';
import { upsertContact, waLog, waOpt } from './store.js';

export interface WaRule {
  id: number; name: string; enabled: number; trigger_type: 'message' | 'welcome'; match_mode: 'contains' | 'exact' | 'any';
  keywords: string[]; reply_text: string; buttons: string[]; cooldown_minutes: number; priority: number; hits: number; created_at: number;
}

export function parseRule(row: any): WaRule {
  return { ...row, keywords: JSON.parse(row.keywords), buttons: JSON.parse(row.buttons) };
}

export const STOP_WORDS = ['stop', 'unsubscribe', 'stop all', 'opt out', 'optout'];
export const START_WORDS = ['start', 'subscribe', 'unstop'];
const isWord = (text: string, list: string[]) => list.includes(text.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim());

/** Highest priority first; at equal priority keyword rules beat catch-alls, then oldest first. */
export function pickRule(rules: WaRule[], text: string, isNew: boolean): WaRule | undefined {
  const on = rules.filter((r) => r.enabled);
  if (isNew) {
    const welcome = on.filter((r) => r.trigger_type === 'welcome').sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
    if (welcome) return welcome;
  }
  return on
    .filter((r) => r.trigger_type === 'message' && matchesText(r, text))
    .sort((a, b) => b.priority - a.priority || Number(a.match_mode === 'any') - Number(b.match_mode === 'any') || a.id - b.id)[0];
}

export function renderText(template: string, c: { name?: string | null; wa_id: string }): string {
  const name = (c.name ?? '').trim();
  return template
    .replace(/\{\{\s*first_name\s*\}\}/gi, name.split(/\s+/)[0] || 'there')
    .replace(/\{\{\s*name\s*\}\}/gi, name || 'there')
    .replace(/\{\{\s*phone\s*\}\}/gi, '+' + c.wa_id);
}

/** What a message says, as text: typed text, the tapped button, or a caption / placeholder for media. */
export function messageText(m: any): string {
  switch (m.type) {
    case 'text': return String(m.text?.body ?? '');
    case 'button': return String(m.button?.text ?? m.button?.payload ?? '');
    case 'interactive': return String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '');
    case 'image': case 'video': case 'document': return String(m[m.type]?.caption ?? '') || `[${m.type}]`;
    case 'location': return `[location] ${m.location?.name ?? ''} ${m.location?.latitude ?? ''},${m.location?.longitude ?? ''}`.trim();
    case 'reaction': return `[reaction ${m.reaction?.emoji ?? ''}]`;
    default: return `[${m.type ?? 'message'}]`;
  }
}

function onCooldown(rule: WaRule, waId: string): boolean {
  if (!rule.cooldown_minutes) return false;
  const since = Date.now() - rule.cooldown_minutes * 60_000;
  const sent = db.prepare("SELECT 1 FROM wa_outbox WHERE rule_id = ? AND wa_id = ? AND created_at > ? AND status IN ('pending', 'sending', 'sent') LIMIT 1").get(rule.id, waId, since);
  return !!sent;
}

function autoRepliesLastHour(waId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE wa_id = ? AND source = 'auto' AND created_at > ?").get(waId, Date.now() - 3600_000) as { n: number }).n;
}

export function handleMessage(m: any, profileName: string | null): void {
  if (!m?.id || !m.from || !firstTime(`wa:${m.id}`)) return;
  const waId = String(m.from);
  const now = Date.now();
  const text = messageText(m);
  const { isNew } = upsertContact(waId, profileName);
  db.prepare('UPDATE wa_contacts SET last_inbound_at = ? WHERE wa_id = ?').run(now, waId);
  db.prepare("INSERT OR IGNORE INTO wa_messages (wa_id, direction, type, text, wamid, created_at) VALUES (?, 'in', ?, ?, ?, ?)").run(waId, String(m.type ?? 'text'), text, m.id, now);
  const contact = db.prepare('SELECT * FROM wa_contacts WHERE wa_id = ?').get(waId) as { name: string | null; paused_until: number; opted_out: number };
  emit('whatsapp.message.received', { wamid: m.id, type: m.type, text, contact: { wa_id: waId, name: contact.name, is_new: isNew } });

  if (waOpt('wa_mark_read')) cloud.markRead(m.id).catch(() => undefined);
  if (m.type === 'reaction') return;

  if (isWord(text, STOP_WORDS)) {
    db.prepare('UPDATE wa_contacts SET opted_out = 1 WHERE wa_id = ?').run(waId);
    emit('whatsapp.opt_out', { contact: { wa_id: waId, name: contact.name }, opted_out: true });
    const msg = getSetting('wa_stop_reply', "You've been unsubscribed and won't get broadcasts from us. Reply START to subscribe again.");
    if (msg) enqueue({ waId, kind: 'text', payload: build.text(msg), preview: msg, source: 'auto' });
    return;
  }
  if (contact.opted_out && isWord(text, START_WORDS)) {
    db.prepare('UPDATE wa_contacts SET opted_out = 0 WHERE wa_id = ?').run(waId);
    emit('whatsapp.opt_out', { contact: { wa_id: waId, name: contact.name }, opted_out: false });
    enqueue({ waId, kind: 'text', payload: build.text("You're subscribed again. Welcome back!"), preview: "You're subscribed again. Welcome back!", source: 'auto' });
    return;
  }

  if (!waOpt('wa_automation_enabled')) return;
  if (contact.paused_until > now) return;
  const rules = (db.prepare('SELECT * FROM wa_rules').all() as any[]).map(parseRule);
  const rule = pickRule(rules, text, isNew);
  if (!rule || onCooldown(rule, waId)) return;
  if (autoRepliesLastHour(waId) >= waOpt('wa_contact_hourly_limit')) {
    if (firstTime(`wa-contact-limit:${waId}:${Math.floor(now / 3600_000)}`)) waLog('warn', `+${waId} hit the per-contact hourly limit; automatic replies to them wait until next hour`);
    return;
  }
  const body = renderText(rule.reply_text, { name: contact.name, wa_id: waId }).slice(0, 4096);
  const buttons = rule.buttons.filter(Boolean);
  enqueue({
    waId, kind: buttons.length ? 'interactive' : 'text',
    payload: buttons.length ? build.buttons(body.slice(0, 1024), buttons) : build.text(body),
    preview: body, ruleId: rule.id, source: 'auto',
  });
  db.prepare('UPDATE wa_rules SET hits = hits + 1 WHERE id = ?').run(rule.id);
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/** Delivery receipts. Never moves backwards (a late "delivered" after "read" is ignored); "failed" always wins. */
export function handleStatus(s: any): void {
  if (!s?.id || !s.status) return;
  const row = db.prepare('SELECT id, status FROM wa_messages WHERE wamid = ?').get(String(s.id)) as { id: number; status: string | null } | undefined;
  if (!row) return;
  const at = Number(s.timestamp) ? Number(s.timestamp) * 1000 : Date.now();
  if (s.status === 'failed') {
    const e = s.errors?.[0];
    const msg = redact(String(e?.error_data?.details ?? e?.message ?? e?.title ?? 'Failed'));
    db.prepare("UPDATE wa_messages SET status = 'failed', error = ?, status_at = ? WHERE id = ?").run(msg.slice(0, 500), at, row.id);
    return;
  }
  if (row.status === 'failed' || (RANK[s.status] ?? 0) <= (RANK[row.status ?? ''] ?? 0)) return;
  db.prepare('UPDATE wa_messages SET status = ?, status_at = ? WHERE id = ?').run(s.status, at, row.id);
}

/** One webhook "value" from a messages change. */
export function handleChange(value: any): void {
  const names = new Map<string, string>();
  for (const c of value?.contacts ?? []) if (c?.wa_id && c.profile?.name) names.set(String(c.wa_id), String(c.profile.name));
  for (const m of value?.messages ?? []) {
    try {
      handleMessage(m, names.get(String(m.from)) ?? null);
    } catch (e) {
      waLog('error', `Message handling failed: ${(e as Error).message}`);
    }
  }
  for (const s of value?.statuses ?? []) {
    try {
      handleStatus(s);
    } catch (e) {
      waLog('error', `Status handling failed: ${(e as Error).message}`);
    }
  }
}
