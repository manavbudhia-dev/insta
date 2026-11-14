import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { getSetting, log, setSetting } from './db.js';
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

  const body = req.body;
  if (body?.object !== 'instagram' || !Array.isArray(body.entry)) return;
  const active = getSetting('ig_user_id');
  for (const entry of body.entry) {
    // Several Instagram accounts can be shared with the app; only act for the active one.
    if (active && entry.id && String(entry.id) !== active) continue;
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
