import { config } from './config.js';
import { db, log, opt } from './db.js';
import { connected, IgError, replyToComment, sendDm, sendPrivateReply } from './instagram.js';

export const WINDOW_MS = 24 * 3600_000;
const MAX_ATTEMPTS = 5;

interface Job {
  id: number;
  kind: 'dm' | 'private_reply' | 'comment_reply';
  target: string;
  igsid: string | null;
  payload: string;
  preview: string | null;
  rule_id: number | null;
  source: string;
  attempts: number;
  created_at: number;
}

export function enqueue(job: {
  kind: Job['kind']; target: string; igsid?: string; payload: unknown; preview?: string;
  ruleId?: number | null; source?: 'auto' | 'manual';
}): number {
  const now = Date.now();
  const r = db
    .prepare(
      'INSERT INTO outbox (kind, target, igsid, payload, preview, rule_id, source, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(job.kind, job.target, job.igsid ?? null, JSON.stringify(job.payload), job.preview ?? null, job.ruleId ?? null, job.source ?? 'auto', now, now);
  return Number(r.lastInsertRowid);
}

/** Meta only allows a DM within 24 hours of the person's last message to the account. */
export function windowOpen(igsid: string): boolean {
  const row = db.prepare('SELECT last_inbound_at FROM contacts WHERE igsid = ?').get(igsid) as { last_inbound_at: number | null } | undefined;
  return !!row?.last_inbound_at && Date.now() - row.last_inbound_at < WINDOW_MS;
}

function sentLastHour(): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent' AND sent_at > ?").get(Date.now() - 3600_000) as { n: number };
  return r.n;
}

const finish = db.prepare('UPDATE outbox SET status = ?, error = ?, sent_at = ?, attempts = attempts + 1 WHERE id = ?');

async function process(job: Job): Promise<void> {
  if (job.kind === 'dm' && !windowOpen(job.target)) {
    finish.run('skipped', 'Outside the 24-hour messaging window', null, job.id);
    return;
  }
  if (job.kind === 'private_reply' && Date.now() - job.created_at > 7 * 86400_000) {
    finish.run('skipped', 'Comment is older than 7 days', null, job.id);
    return;
  }
  const payload = JSON.parse(job.payload);
  try {
    const res =
      job.kind === 'dm' ? await sendDm(job.target, payload)
      : job.kind === 'private_reply' ? await sendPrivateReply(job.target, payload)
      : await replyToComment(job.target, payload.message);
    const now = Date.now();
    finish.run('sent', null, now, job.id);

    const igsid = job.kind === 'dm' ? job.target : res.recipient_id ?? job.igsid;
    if (igsid) {
      if (job.kind === 'private_reply' && res.recipient_id && res.recipient_id !== job.igsid) {
        // The reply reveals the commenter's messaging ID; carry their username over to it.
        const prev = db.prepare('SELECT username FROM contacts WHERE igsid = ?').get(job.igsid) as { username?: string } | undefined;
        db.prepare('INSERT OR IGNORE INTO contacts (igsid, username, first_seen) VALUES (?, ?, ?)').run(res.recipient_id, prev?.username ?? null, now);
      }
      db.prepare('UPDATE contacts SET last_outbound_at = ? WHERE igsid = ?').run(now, igsid);
      db.prepare(
        'INSERT OR IGNORE INTO messages (igsid, direction, kind, text, mid, rule_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(igsid, 'out', job.kind, job.preview, res.message_id ?? res.id ?? null, job.rule_id, job.source, now);
    }
  } catch (e) {
    const err = e as IgError;
    const attempts = job.attempts + 1;
    if (err.transient && attempts < MAX_ATTEMPTS) {
      const delay = Math.min(30 * 60_000, 30_000 * 2 ** attempts);
      db.prepare('UPDATE outbox SET attempts = ?, next_attempt_at = ?, error = ? WHERE id = ?').run(attempts, Date.now() + delay, err.message, job.id);
      log('warn', `Send #${job.id} failed (attempt ${attempts}), retrying: ${err.message}`);
    } else {
      finish.run('failed', err.message, null, job.id);
      log('error', `Send #${job.id} (${job.kind}) failed: ${err.message}`);
    }
  }
}

let busy = false;
async function tick(): Promise<void> {
  if (busy || !connected()) return;
  busy = true;
  try {
    for (let i = 0; i < 20; i++) {
      if (sentLastHour() >= opt('dm_hourly_limit')) return; // hourly cap reached; jobs wait in the queue
      const job = db
        .prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY (source = 'manual') DESC, id LIMIT 1")
        .get(Date.now()) as Job | undefined;
      if (!job) return;
      await process(job);
      await new Promise((r) => setTimeout(r, config.sendGapMs));
    }
  } catch (e) {
    log('error', `Queue worker error: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

export function startQueue(): NodeJS.Timeout {
  return setInterval(tick, config.queueTickMs);
}
