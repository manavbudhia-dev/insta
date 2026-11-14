import { config } from './config.js';
import { db, log, opt, redact, setSetting } from './db.js';
import { moveRuns } from './flows.js';
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
  flow_id: number | null;
  ignore_pause: number;
  source: string;
  attempts: number;
  created_at: number;
}

export function enqueue(job: {
  kind: Job['kind']; target: string; igsid?: string; payload: unknown; preview?: string;
  ruleId?: number | null; flowId?: number | null; source?: 'auto' | 'manual';
}): number {
  const now = Date.now();
  const r = db
    .prepare(
      'INSERT INTO outbox (kind, target, igsid, payload, preview, rule_id, flow_id, source, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(job.kind, job.target, job.igsid ?? null, JSON.stringify(job.payload), job.preview ?? null, job.ruleId ?? null, job.flowId ?? null, job.source ?? 'auto', now, now);
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

/** Sends currently talking to Instagram. The echo handler waits on this so it never mistakes our own message for a human reply. */
let inFlight = 0;
export function sendsInFlight(): number {
  return inFlight;
}

/**
 * A job is claimed ('sending') before the API call. If the process dies mid-send we cannot know whether
 * Instagram delivered it, and the Send API has no idempotency key, so it is failed rather than retried.
 */
export function recoverInterrupted(): void {
  const r = db
    .prepare("UPDATE outbox SET status = 'failed', error = 'Interrupted by a server restart; it may or may not have been delivered. Check Instagram before resending.' WHERE status = 'sending'")
    .run();
  if (r.changes) log('warn', `${r.changes} message(s) were interrupted mid-send and marked failed (not retried, to avoid duplicates)`);
}

async function process(job: Job): Promise<void> {
  if (job.kind === 'dm' && !windowOpen(job.target)) {
    finish.run('skipped', 'Outside the 24-hour messaging window', null, job.id);
    return;
  }
  if (job.kind === 'private_reply' && Date.now() - job.created_at > 7 * 86400_000) {
    finish.run('skipped', 'Comment is older than 7 days', null, job.id);
    return;
  }
  if (job.source === 'auto' && job.kind === 'dm' && !job.ignore_pause) {
    // The owner may have taken over the chat while this reply was waiting in the queue.
    const c = db.prepare('SELECT paused_until FROM contacts WHERE igsid = ?').get(job.target) as { paused_until: number } | undefined;
    if (c && c.paused_until > Date.now()) {
      finish.run('skipped', 'Automation is paused for this person', null, job.id);
      return;
    }
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
        if (job.igsid) moveRuns(job.igsid, res.recipient_id); // a flow waiting on this commenter follows them
      }
      db.prepare('UPDATE contacts SET last_outbound_at = ? WHERE igsid = ?').run(now, igsid);
      db.prepare(
        'INSERT OR IGNORE INTO messages (igsid, direction, kind, text, mid, rule_id, flow_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(igsid, 'out', job.kind, job.preview, res.message_id ?? res.id ?? null, job.rule_id, job.flow_id, job.source, now);
    }
  } catch (e) {
    const err = e as IgError;
    err.message = redact(err.message);
    const attempts = job.attempts + 1;
    if (err.code === 368) {
      // Instagram temporarily blocked the account for policy reasons. Continuing to send makes that worse.
      setSetting('automation_enabled', 0);
      log('error', 'Instagram temporarily blocked sending from this account (code 368). Automation has been switched off; review your rules, then turn it back on in Settings.');
    }
    if (err.transient && attempts < MAX_ATTEMPTS) {
      const delay = Math.min(30 * 60_000, 30_000 * 2 ** attempts);
      db.prepare("UPDATE outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ? WHERE id = ?").run(attempts, Date.now() + delay, err.message, job.id);
      log('warn', `Send #${job.id} failed (attempt ${attempts}), retrying: ${err.message}`);
    } else {
      finish.run('failed', err.message, null, job.id);
      log('error', `Send #${job.id} (${job.kind}) failed: ${err.message}`);
    }
  }
}

const claim = db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'pending'");
let busy = false;
let stopping = false;
let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (busy || stopping || !connected()) return;
  busy = true;
  try {
    for (let i = 0; i < 20 && !stopping; i++) {
      if (sentLastHour() >= opt('dm_hourly_limit')) return; // hourly cap reached; jobs wait in the queue
      // With the automation switch off, only messages typed by hand go out; automated ones wait.
      const job = db
        .prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? AND (source = 'manual' OR ? = 1) ORDER BY (source = 'manual') DESC, id LIMIT 1")
        .get(Date.now(), opt('automation_enabled') ? 1 : 0) as Job | undefined;
      if (!job) return;
      if (!claim.run(job.id).changes) continue; // deleted or changed since it was read
      inFlight++;
      try {
        await process(job);
      } finally {
        inFlight--;
      }
      await new Promise((r) => setTimeout(r, config.sendGapMs));
    }
  } catch (e) {
    log('error', `Queue worker error: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

export function startQueue(): NodeJS.Timeout {
  recoverInterrupted();
  timer = setInterval(tick, config.queueTickMs);
  return timer;
}

/** Stop picking up work and let the send in progress finish (used on shutdown). */
export async function stopQueue(timeoutMs = 25_000): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  const end = Date.now() + timeoutMs;
  while (busy && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}
