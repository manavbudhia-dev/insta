/**
 * Outbox worker for WhatsApp: every message (auto reply, manual reply, broadcast, n8n) goes through here,
 * so rate limits, the 24-hour rule and retries are handled in one place. Also starts scheduled broadcasts.
 */
import { db, firstTime, redact } from '../db.js';
import { cloud, WaError } from './cloud.js';
import { appEnabled } from '../apps.js';
import { emit } from './hook.js';
import { configured, waLog, waOpt } from './store.js';

export const WINDOW_MS = 24 * 3600_000;
const MAX_ATTEMPTS = 5;
const TICK_MS = Number(process.env.WA_TICK_MS ?? process.env.QUEUE_TICK_MS ?? 2000);
const GAP_MS = Number(process.env.WA_SEND_GAP_MS ?? 250);

export type Kind = 'text' | 'interactive' | 'template';
interface Job {
  id: number; wa_id: string; kind: Kind; payload: string; preview: string | null;
  rule_id: number | null; broadcast_id: number | null; source: string; attempts: number;
}

export function enqueue(job: {
  waId: string; kind: Kind; payload: unknown; preview?: string; ruleId?: number | null; broadcastId?: number | null;
  source?: 'auto' | 'manual' | 'broadcast' | 'api'; at?: number;
}): number {
  const now = Date.now();
  const r = db.prepare(
    'INSERT INTO wa_outbox (wa_id, kind, payload, preview, rule_id, broadcast_id, source, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(job.waId, job.kind, JSON.stringify(job.payload), job.preview ?? null, job.ruleId ?? null, job.broadcastId ?? null, job.source ?? 'auto', job.at ?? now, now);
  return Number(r.lastInsertRowid);
}

/** Free-form messages are only allowed within 24 hours of the person's last message; templates are allowed anytime. */
export function windowOpen(waId: string): boolean {
  const row = db.prepare('SELECT last_inbound_at FROM wa_contacts WHERE wa_id = ?').get(waId) as { last_inbound_at: number | null } | undefined;
  return !!row?.last_inbound_at && Date.now() - row.last_inbound_at < WINDOW_MS;
}

const sentLastHour = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE status = 'sent' AND sent_at > ?").get(Date.now() - 3600_000) as { n: number }).n;

const finish = db.prepare('UPDATE wa_outbox SET status = ?, error = ?, wamid = ?, sent_at = ?, attempts = attempts + 1 WHERE id = ?');

export function recoverInterrupted(): void {
  const r = db.prepare(
    "UPDATE wa_outbox SET status = 'failed', error = 'Interrupted by a server restart; it may or may not have been delivered. Check WhatsApp before resending.' WHERE status = 'sending'",
  ).run();
  if (r.changes) waLog('warn', `${r.changes} message(s) were interrupted mid-send and marked failed (not retried, to avoid duplicates)`);
}

function hookData(job: Job) {
  const c = db.prepare('SELECT name FROM wa_contacts WHERE wa_id = ?').get(job.wa_id) as { name: string | null } | undefined;
  const rule = job.rule_id ? (db.prepare('SELECT name FROM wa_rules WHERE id = ?').get(job.rule_id) as { name: string } | undefined) : undefined;
  return {
    kind: job.kind, text: job.preview, source: job.source,
    rule: job.rule_id ? { id: job.rule_id, name: rule?.name ?? null } : null,
    broadcast_id: job.broadcast_id,
    contact: { wa_id: job.wa_id, name: c?.name ?? null },
  };
}

function fail(job: Job, error: string): void {
  finish.run('failed', error.slice(0, 500), null, null, job.id);
  emit('whatsapp.reply.failed', { ...hookData(job), error });
}

async function processOne(job: Job): Promise<void> {
  if (job.kind !== 'template' && !windowOpen(job.wa_id)) {
    return fail(job, 'More than 24 hours since this person last wrote: WhatsApp only allows an approved template now.');
  }
  // Broadcasts and n8n sends skip anyone who replied STOP; a reply to someone who just wrote is still allowed.
  if (job.source === 'broadcast' || job.source === 'api') {
    const c = db.prepare('SELECT opted_out FROM wa_contacts WHERE wa_id = ?').get(job.wa_id) as { opted_out: number } | undefined;
    if (c?.opted_out) {
      finish.run('skipped', 'Contact opted out (replied STOP)', null, null, job.id);
      return;
    }
  }
  db.prepare("UPDATE wa_outbox SET status = 'sending' WHERE id = ?").run(job.id);
  try {
    const wamid = await cloud.send(job.wa_id, JSON.parse(job.payload));
    const now = Date.now();
    finish.run('sent', null, wamid, now, job.id);
    db.prepare(
      'INSERT OR IGNORE INTO wa_messages (wa_id, direction, type, text, wamid, status, rule_id, broadcast_id, source, created_at, status_at) VALUES (?, \'out\', ?, ?, ?, \'sent\', ?, ?, ?, ?, ?)',
    ).run(job.wa_id, job.kind, job.preview, wamid, job.rule_id, job.broadcast_id, job.source, now, now);
    db.prepare('UPDATE wa_contacts SET last_outbound_at = ? WHERE wa_id = ?').run(now, job.wa_id);
    emit('whatsapp.reply.sent', { ...hookData(job), wamid });
  } catch (e) {
    const err = e instanceof WaError ? e : new WaError(String((e as Error)?.message ?? e), 500);
    const msg = redact(err.message);
    if (err.authFailure) {
      if (firstTime(`wa-auth:${Math.floor(Date.now() / 3600_000)}`)) waLog('error', `The access token was rejected (${msg}). Paste a new permanent token in WhatsApp settings.`);
      return fail(job, msg);
    }
    if (err.windowClosed) return fail(job, 'More than 24 hours since this person last wrote: WhatsApp only allows an approved template now.');
    if (err.transient && job.attempts + 1 < MAX_ATTEMPTS) {
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** job.attempts);
      db.prepare("UPDATE wa_outbox SET status = 'pending', attempts = attempts + 1, error = ?, next_attempt_at = ? WHERE id = ?").run(msg, Date.now() + delay, job.id);
      return;
    }
    if (job.source !== 'broadcast') waLog('warn', `Could not send to +${job.wa_id}: ${msg}`);
    fail(job, msg);
  }
}

/** Expands due broadcasts into the outbox, and closes those whose messages have all gone out. */
export function startDueBroadcasts(now = Date.now()): void {
  const due = db.prepare("SELECT * FROM wa_broadcasts WHERE status = 'scheduled' AND scheduled_at <= ?").all(now) as any[];
  for (const b of due) {
    const tx = db.transaction(() => {
      const recipients: { to: string; params: string[] }[] = JSON.parse(b.recipients);
      const optedOut = new Set((db.prepare('SELECT wa_id FROM wa_contacts WHERE opted_out = 1').all() as { wa_id: string }[]).map((r) => r.wa_id));
      let queued = 0;
      for (const r of recipients) {
        if (optedOut.has(r.to)) continue;
        const payload = {
          type: 'template',
          template: {
            name: b.template, language: { code: b.language },
            ...(r.params.length ? { components: [{ type: 'body', parameters: r.params.map((text) => ({ type: 'text', text })) }] } : {}),
          },
        };
        db.prepare('INSERT OR IGNORE INTO wa_contacts (wa_id, first_seen) VALUES (?, ?)').run(r.to, now);
        enqueue({ waId: r.to, kind: 'template', payload, preview: `Template: ${b.template}${r.params.length ? ` (${r.params.join(', ')})` : ''}`, broadcastId: b.id, source: 'broadcast', at: now });
        queued++;
      }
      db.prepare("UPDATE wa_broadcasts SET status = 'running', started_at = ?, skipped = ?, recipients = '[]' WHERE id = ?").run(now, recipients.length - queued, b.id);
    });
    tx();
    waLog('info', `Broadcast "${b.name}" started`);
  }
  const running = db.prepare("SELECT id, name FROM wa_broadcasts WHERE status = 'running'").all() as { id: number; name: string }[];
  for (const b of running) {
    const left = db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE broadcast_id = ? AND status IN ('pending', 'sending')").get(b.id) as { n: number };
    if (!left.n) {
      db.prepare("UPDATE wa_broadcasts SET status = 'done', finished_at = ? WHERE id = ?").run(Date.now(), b.id);
      waLog('info', `Broadcast "${b.name}" finished`);
    }
  }
}

let timer: NodeJS.Timeout | undefined;
let draining: Promise<void> | null = null;
let stopping = false;

async function drain(): Promise<void> {
  while (!stopping && configured() && appEnabled('whatsapp')) {
  while (!stopping && configured()) {
    if (sentLastHour() >= waOpt('wa_hourly_limit')) {
      if (firstTime(`wa-hourly:${Math.floor(Date.now() / 3600_000)}`)) waLog('warn', 'Hourly send limit reached; the rest waits in the queue. Raise it in WhatsApp settings if your tier allows.');
      return;
    }
    const job = db.prepare("SELECT * FROM wa_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY CASE source WHEN 'broadcast' THEN 1 ELSE 0 END, id LIMIT 1").get(Date.now()) as Job | undefined;
    if (!job) return;
    await processOne(job);
    if (GAP_MS > 0) await new Promise((r) => setTimeout(r, GAP_MS));
  }
}

export function tick(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    try {
      startDueBroadcasts();
      await drain();
    } catch (e) {
      waLog('error', `Queue error: ${(e as Error).message}`);
    } finally {
      draining = null;
    }
  })();
  return draining;
}

export function startQueue(): void {
  recoverInterrupted();
  timer = setInterval(() => void tick(), TICK_MS);
}
export async function stopQueue(): Promise<void> {
  stopping = true;
  clearInterval(timer);
  await draining;
}
