import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { firstTime, getSetting, log, setSetting } from './db.js';
import { handleComment, handleMessaging } from './engine.js';

/** GET /webhook — Meta's one-time endpoint verification handshake. */
export function verifyWebhook(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const tokenSent = String(req.query['hub.verify_token'] ?? '');
  const expected = config.webhookVerifyToken;
  if (mode === 'subscribe' && expected && safeEqual(tokenSent, expected)) {
    res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  } else {
    res.sendStatus(403);
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function validSignature(raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  if (!config.metaAppSecret) return false;
  const digest = 'sha256=' + crypto.createHmac('sha256', config.metaAppSecret).update(raw).digest('hex');
  return safeEqual(digest, header);
}

/** POST /webhook — event notifications. Acknowledge fast, process afterwards. */
export function receiveWebhook(req: Request, res: Response): void {
  const raw: Buffer | undefined = (req as any).rawBody;
  if (!raw || !validSignature(raw, req.get('x-hub-signature-256'))) {
    log('warn', 'Rejected a webhook call with a missing or invalid signature');
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);
  setSetting('last_webhook_at', Date.now());
  // Meta sends every account's events to one callback URL: pass them on to the client instances (never twice).
  if (!req.get('x-autopilot-forwarded')) forward(raw, req.get('x-hub-signature-256')!);

  const body = req.body;
  if (body?.object !== 'instagram' || !Array.isArray(body.entry)) return;
  const active = getSetting('ig_user_id');
  // No account connected yet: events here belong to other clients' accounts, so store nothing.
  if (!active) return;
  for (const entry of body.entry) {
    // Several Instagram accounts can be shared with the app; only act for the active one.
    if (entry.id && String(entry.id) !== active) continue;
    for (const ev of entry.messaging ?? []) {
      handleMessaging(ev).catch((e) => log('error', `Message handling failed: ${e.message}`));
    }
    for (const change of entry.changes ?? []) {
      if (change.field === 'comments' && change.value) {
        try {
          setSetting('last_comment_webhook_at', Date.now());
          // Unified Login payloads name the comment "comment_id"; older ones use "id".
          handleComment({ ...change.value, id: change.value.comment_id ?? change.value.id });
        } catch (e) {
          log('error', `Comment handling failed: ${(e as Error).message}`);
        }
      }
    }
  }
}

// ---------- multi-client fan-out ----------

let targets: { mtime: number; urls: string[] } = { mtime: -1, urls: [] };
function forwardTargets(): string[] {
  const file = config.forwardWebhooksFile;
  if (!file) return [];
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime !== targets.mtime) {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      targets = { mtime, urls: Array.isArray(list) ? list.map(String).filter((u) => /^https?:\/\//.test(u)) : [] };
    }
  } catch {
    targets = { mtime: -1, urls: [] };
  }
  return targets.urls;
}

/** Each client instance checks the same Meta signature itself and ignores entries for accounts that are not its own. */
function forward(raw: Buffer, signature: string): void {
  for (const base of forwardTargets()) {
    fetch(`${base.replace(/\/+$/, '')}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature, 'X-Autopilot-Forwarded': '1' },
      body: new Uint8Array(raw),
      signal: AbortSignal.timeout(10_000),
    }).then(
      (r) => { if (!r.ok && firstTime(`fwd:${base}:${Math.floor(Date.now() / 3600_000)}`)) log('warn', `Could not pass a webhook on to ${base}: HTTP ${r.status}`); },
      (e) => { if (firstTime(`fwd:${base}:${Math.floor(Date.now() / 3600_000)}`)) log('warn', `Could not pass a webhook on to ${base}: ${(e as Error).message}`); },
    );
  }
}
