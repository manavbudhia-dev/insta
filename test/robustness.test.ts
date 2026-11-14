import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-robust-'));

const { db, setSetting } = await import('../src/db.js');
const { IgError } = await import('../src/instagram.js');
const { enqueue, recoverInterrupted, sendsInFlight } = await import('../src/queue.js');
const { handleMessaging, upsertContact } = await import('../src/engine.js');

test('a send interrupted by a restart is failed, never retried (no duplicate DMs)', () => {
  const id = enqueue({ kind: 'dm', target: 'U1', igsid: 'U1', payload: { text: 'hi' } });
  db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?").run(id);
  recoverInterrupted();
  const row = db.prepare('SELECT status, error FROM outbox WHERE id = ?').get(id) as { status: string; error: string };
  assert.equal(row.status, 'failed');
  assert.match(row.error, /Interrupted/);
});

test('an ambiguous network failure on a send is not retried; a pre-connection failure is', () => {
  assert.equal(new IgError('timeout', 503, undefined, undefined, true).transient, false);
  assert.equal(new IgError('refused', 503).transient, true);
  assert.equal(new IgError('rate limited', 429).transient, true);
});

test('an echo is held while a send is in flight, and a redelivered human echo pauses only once', async () => {
  setSetting('ig_user_id', 'OWN');
  setSetting('human_pause_min', 60);
  assert.equal(sendsInFlight(), 0);
  const echo = { sender: { id: 'OWN' }, recipient: { id: 'U2' }, message: { mid: 'mid.h1', text: 'by hand', is_echo: true } };
  await handleMessaging(echo);
  const first = (db.prepare('SELECT paused_until FROM contacts WHERE igsid = ?').get('U2') as any).paused_until;
  assert.ok(first > Date.now());
  db.prepare('UPDATE contacts SET paused_until = 0 WHERE igsid = ?').run('U2');
  await handleMessaging(echo); // same mid delivered again
  assert.equal((db.prepare('SELECT paused_until FROM contacts WHERE igsid = ?').get('U2') as any).paused_until, 0);
});

test('events that are not messages (reactions, receipts) are ignored', async () => {
  await handleMessaging({ sender: { id: 'U3' }, recipient: { id: 'OWN' }, timestamp: Date.now() });
  assert.equal(db.prepare('SELECT 1 FROM contacts WHERE igsid = ?').get('U3'), undefined);
  upsertContact('U4');
});

test('vault round-trips, rejects tampering, and logs never contain tokens', async () => {
  const { seal, open, isSealed } = await import('../src/vault.js');
  const { redact, log } = await import('../src/db.js');
  const s = seal('EAAB-secret-token-value');
  assert.ok(isSealed(s) && !s.includes('secret-token'));
  assert.equal(open(s), 'EAAB-secret-token-value');
  assert.equal(open(s.slice(0, -2) + 'AA'), ''); // tampered ciphertext is refused
  assert.equal(open('plain-legacy-token'), 'plain-legacy-token');

  assert.equal(redact('GET /x?access_token=abc123&fields=id'), 'GET /x?access_token=[redacted]&fields=id');
  assert.match(redact('failed with Bearer abc.def-123'), /Bearer \[redacted\]/);
  log('error', 'boom\nfake line access_token=zzz');
  const row = db.prepare('SELECT message FROM logs ORDER BY id DESC LIMIT 1').get() as { message: string };
  assert.ok(!row.message.includes('\n') && !row.message.includes('zzz'));
});
