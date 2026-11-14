/**
 * End-to-end: boots the real server against a mock Instagram Graph API and drives it
 * through the dashboard API and signed webhooks.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const APP_PORT = 34801;
const MOCK_PORT = 34802;
const APP = `http://127.0.0.1:${APP_PORT}`;
const SECRET = 'test-app-secret';
const OWN_ID = '17840000000000001';

interface Call { method: string; path: string; query: Record<string, string>; body: any; auth?: string }
const calls: Call[] = [];
let comments: any[] = [];
let commentsCount = 0;
let failNextSend = 0;
let assigned: any[] = [{ id: OWN_ID, username: 'myshop' }];

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname.replace(/^\/v[\d.]+/, '');
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method!, path: p, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
    const send = (code: number, json: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    // Unified Login: /me is the system user, never the Instagram account.
    if (p === '/oauth/access_token') return url.searchParams.get('code') === 'GOODCODE' && url.searchParams.get('client_secret') === SECRET
      ? send(200, { access_token: 'SUAT-from-oauth-1234567890', token_type: 'bearer' })
      : send(400, { error: { message: 'Invalid verification code', code: 100 } });
    if (p === '/debug_token') return send(200, { data: { is_valid: true, expires_at: 0 } });
    if (p === '/me' && req.method === 'GET') return send(200, { id: '999', client_business_id: 'BIZ1' });
    if (p === '/me/assigned_instagram_accounts') return send(200, { data: assigned });
    if (p === `/${OWN_ID}` || p === '/17840000000000002') return send(200, { username: p === `/${OWN_ID}` ? 'myshop' : 'secondshop', name: 'My Shop', followers_count: 1234 });
    if (/^\/\d+\/subscribed_apps$/.test(p)) return send(200, { success: true });
    if (p === '/me/messages' || p === '/me/media' || p === '/me/media_publish') return send(400, { error: { message: 'mock: /me is not the Instagram account', code: 100 } });
    if (p === `/${OWN_ID}/messages`) {
      if (failNextSend > 0) {
        failNextSend--;
        return send(400, { error: { message: 'Simulated permanent failure', code: 100 } });
      }
      return send(200, { recipient_id: body.recipient.id ?? 'IGSID_FROM_COMMENT', message_id: 'mid.out.' + calls.length });
    }
    if (/^\/[^/]+\/replies$/.test(p)) return send(200, { id: 'reply.' + calls.length });
    if (p === `/${OWN_ID}/media` && req.method === 'GET') return send(200, { data: [{ id: 'MEDIA1', caption: 'Launch post', media_type: 'IMAGE', media_url: 'https://cdn.test/a.jpg', comments_count: commentsCount, timestamp: new Date().toISOString() }] });
    if (p === '/MEDIA1/comments') return send(200, { data: comments });
    if (p === `/${OWN_ID}/media` && req.method === 'POST') return send(200, { id: 'CONTAINER1' });
    if (p === '/CONTAINER1') return send(200, { status_code: 'FINISHED' });
    if (p === `/${OWN_ID}/media_publish`) return send(200, { id: 'PUBLISHED1' });
    if (p === '/USER1') return send(200, { name: 'Asha Rao', username: 'asha' });
    send(404, { error: { message: `mock: no route ${p}`, code: 100 } });
  });
});

let child: ChildProcess;
let cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-e2e-'));

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(APP + p, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})), res };
}
async function webhook(payload: unknown, secret = SECRET) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(APP + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
}
const dm = (text: string, mid: string, extra: object = {}, sender = 'USER1') => ({
  object: 'instagram',
  entry: [{ id: OWN_ID, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: OWN_ID }, timestamp: Date.now(), message: { mid, text, ...extra } }] }],
});
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sends = () => calls.filter((c) => c.method === 'POST' && c.path === `/${OWN_ID}/messages`);

before(async () => {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, r));
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env, PORT: String(APP_PORT), BASE_URL: APP, DATA_DIR: dataDir,
      ADMIN_PASSWORD: 'correct-horse', SESSION_SECRET: 'x'.repeat(32),
      META_APP_ID: '123', META_APP_SECRET: SECRET, META_CONFIG_ID: 'CFG9', WEBHOOK_VERIFY_TOKEN: 'verify-me',
      GRAPH_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      QUEUE_TICK_MS: '100', SEND_GAP_MS: '10', SCHEDULER_TICK_MS: '200', CONTAINER_POLL_MS: '50',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await until(() => fetch(APP + '/healthz').then((r) => r.ok).catch(() => false), 'server start', 20000);
});
after(() => {
  child?.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('dashboard API requires a login; wrong password is rejected', async () => {
  assert.equal((await call('GET', '/api/status')).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  const ok = await call('POST', '/api/login', { password: 'correct-horse' });
  assert.equal(ok.status, 200);
  cookie = ok.res.headers.get('set-cookie')!.split(';')[0];
  assert.match(ok.res.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.equal((await call('GET', '/api/status')).status, 200);
});

test('webhook verification handshake', async () => {
  const good = await fetch(`${APP}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242`);
  assert.equal(good.status, 200);
  assert.equal(await good.text(), '4242');
  const bad = await fetch(`${APP}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242`);
  assert.equal(bad.status, 403);
});

test('connecting with a token loads the account and subscribes to webhooks', async () => {
  const r = await call('POST', '/api/account/token', { token: 'IGAA-test-token-1234567890' });
  assert.equal(r.status, 200);
  const s = (await call('GET', '/api/status')).json;
  assert.equal(s.account.username, 'myshop');
  assert.equal(s.account.webhooksSubscribed, 'messages,messaging_postbacks,comments');
  const sub = calls.find((c) => c.path === `/${OWN_ID}/subscribed_apps`)!;
  assert.equal(sub.auth, 'Bearer IGAA-test-token-1234567890');
  assert.equal(sub.query.subscribed_fields, 'messages,messaging_postbacks,comments');
  assert.equal(s.account.id, OWN_ID);
  assert.equal(s.account.tokenExpiresAt, 0);
});

test('Unified Login OAuth: dialog URL, state check, code exchange with the Meta app secret', async () => {
  const start = await fetch(APP + '/auth/instagram', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(start.status, 302);
  const dialog = new URL(start.headers.get('location')!);
  assert.equal(dialog.origin + dialog.pathname, 'https://www.facebook.com/dialog/oauth');
  assert.equal(dialog.searchParams.get('client_id'), '123');
  assert.equal(dialog.searchParams.get('config_id'), 'CFG9');
  assert.equal(dialog.searchParams.get('response_type'), 'code');
  assert.equal(dialog.searchParams.get('redirect_uri'), `${APP}/auth/instagram/callback`);
  assert.equal(dialog.searchParams.get('scope'), null, 'permissions come from the configuration, not the URL');
  const state = dialog.searchParams.get('state')!;

  const forged = await fetch(`${APP}/auth/instagram/callback?code=GOODCODE&state=forged`, { redirect: 'manual' });
  assert.match(forged.headers.get('location')!, /error=/);
  const badCode = await fetch(`${APP}/auth/instagram/callback?code=NOPE&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.match(badCode.headers.get('location')!, /error=/);
  const ok = await fetch(`${APP}/auth/instagram/callback?code=GOODCODE&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.equal(ok.headers.get('location'), '/?connected=1');
  const sub = calls.filter((c) => c.path === `/${OWN_ID}/subscribed_apps`).at(-1)!;
  assert.equal(sub.auth, 'Bearer SUAT-from-oauth-1234567890');
  assert.equal((await fetch(APP + '/auth/instagram', { redirect: 'manual' })).headers.get('location'), '/', 'login required to start OAuth');
});

test('a token with no Instagram account is refused; several shared accounts can be switched', async () => {
  assigned = [];
  const none = await call('POST', '/api/account/token', { token: 'SUAT-without-any-accounts-000' });
  assert.equal(none.status, 400);
  assert.match(none.json.error, /no Instagram account/);
  assert.equal((await call('GET', '/api/status')).json.account.username, 'myshop', 'previous connection is kept');

  assigned = [{ id: '17840000000000002', username: 'secondshop' }, { id: OWN_ID, username: 'myshop' }];
  assert.equal((await call('POST', '/api/account/token', { token: 'IGAA-test-token-1234567890' })).status, 200);
  let acc = (await call('GET', '/api/status')).json.account;
  assert.equal(acc.id, OWN_ID, 'the previously active account stays selected');
  assert.equal(acc.accounts.length, 2);
  assert.equal((await call('POST', '/api/account/select', { id: 'not-shared' })).status, 400);
  assert.equal((await call('POST', '/api/account/select', { id: '17840000000000002' })).status, 200);
  assert.equal((await call('GET', '/api/status')).json.account.username, 'secondshop');
  assert.equal((await call('POST', '/api/account/select', { id: OWN_ID })).status, 200);
  acc = (await call('GET', '/api/status')).json.account;
  assert.equal(acc.username, 'myshop');
});

test('rule validation', async () => {
  assert.equal((await call('POST', '/api/rules', { name: 'x', trigger_type: 'dm', match_mode: 'contains', keywords: [], reply_text: 'hi' })).status, 400);
  assert.equal((await call('POST', '/api/rules', { name: 'x', trigger_type: 'dm', match_mode: 'any', reply_text: 'hi', buttons: [{ title: 'Go', url: 'http://insecure.test' }] })).status, 400);
});

test('unsigned or wrongly signed webhooks are rejected and trigger nothing', async () => {
  await call('POST', '/api/rules', { name: 'Price', trigger_type: 'dm', match_mode: 'contains', keywords: ['price'], reply_text: 'Hi {{first_name}}, our price list:', buttons: [{ title: 'Open list', url: 'https://shop.test/prices' }], cooldown_minutes: 60 });
  const before = sends().length;
  assert.equal((await webhook(dm('price', 'mid.forged'), 'wrong-secret')).status, 401);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sends().length, before);
});

test('DM keyword → templated button reply; duplicates and cooldown are honoured', async () => {
  const before = sends().length;
  assert.equal((await webhook(dm('What is the PRICE?', 'mid.1'))).status, 200);
  const sent = await until(() => sends()[before], 'auto reply');
  assert.deepEqual(sent.body.recipient, { id: 'USER1' });
  assert.equal(sent.body.message.attachment.payload.text, 'Hi Asha, our price list:');
  assert.equal(sent.body.message.attachment.payload.buttons[0].url, 'https://shop.test/prices');

  await webhook(dm('What is the PRICE?', 'mid.1')); // Meta redelivery of the same message
  await webhook(dm('price again', 'mid.2')); // same person inside the cooldown
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sends().length, before + 1);

  const thread = (await call('GET', '/api/contacts/USER1/messages')).json;
  assert.equal(thread.contact.username, 'asha');
  assert.equal(thread.windowOpen, true);
  assert.deepEqual(thread.messages.map((m: any) => m.direction), ['in', 'out', 'in']);
});

test('echo of our own message is ignored; a manual reply from the Instagram app pauses automation', async () => {
  await call('POST', '/api/rules', { name: 'Hours', trigger_type: 'dm', match_mode: 'exact', keywords: ['hours'], reply_text: 'Open 9 to 6', quick_replies: ['Location'] });
  const before = sends().length;
  await webhook(dm('hours', 'mid.3', {}, 'USER2'));
  const sent = await until(() => sends()[before], 'hours reply');
  assert.equal(sent.body.message.quick_replies[0].title, 'Location');

  // Human reply typed in the Instagram app arrives as an echo with an unknown mid.
  await webhook({ object: 'instagram', entry: [{ id: OWN_ID, messaging: [{ sender: { id: OWN_ID }, recipient: { id: 'USER2' }, message: { mid: 'mid.human', text: 'Let me check', is_echo: true } }] }] });
  await until(async () => (await call('GET', '/api/contacts/USER2/messages')).json.contact.paused_until > Date.now(), 'pause after human reply', 9000);
  await webhook(dm('hours', 'mid.4', {}, 'USER2'));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sends().length, before + 1, 'no auto reply while paused');
});

test('comment webhook → one private reply plus a public reply; own comments ignored', async () => {
  await call('POST', '/api/rules', { name: 'Link', trigger_type: 'comment', match_mode: 'contains', keywords: ['link'], reply_text: 'Here you go @{{username}}', buttons: [{ title: 'Shop', url: 'https://shop.test' }], comment_replies: ['Sent you a DM!'] });
  const before = calls.length;
  const comment = (id: string, text: string, from: object) => ({ object: 'instagram', entry: [{ id: OWN_ID, changes: [{ field: 'comments', value: { comment_id: id, text, from, media: { id: 'MEDIA1' } } }] }] });
  await webhook(comment('C1', 'LINK please', { id: 'CU1', username: 'ravi' }));
  await webhook(comment('C1', 'LINK please', { id: 'CU1', username: 'ravi' }));
  await webhook(comment('C2', 'link', { id: OWN_ID, username: 'myshop' }));
  const pr = await until(() => calls.slice(before).find((c) => c.path === `/${OWN_ID}/messages`), 'private reply');
  assert.deepEqual(pr.body.recipient, { comment_id: 'C1' });
  assert.equal(pr.body.message.text, 'Here you go @ravi\n\nShop: https://shop.test');
  const pub = await until(() => calls.slice(before).find((c) => c.path === '/C1/replies'), 'public reply');
  assert.equal(pub.body.message, 'Sent you a DM!');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(calls.slice(before).filter((c) => c.method === 'POST').length, 2);
});

test('comment polling fallback picks up new comments exactly once', async () => {
  comments = [
    { id: 'C10', text: 'need the link', timestamp: new Date().toISOString(), username: 'meera', from: { id: 'CU10', username: 'meera' } },
    { id: 'C1', text: 'LINK please', timestamp: new Date().toISOString(), username: 'ravi', from: { id: 'CU1', username: 'ravi' } },
    { id: 'C0', text: 'link', timestamp: new Date(Date.now() - 30 * 86400_000).toISOString(), username: 'old', from: { id: 'CU0', username: 'old' } },
  ];
  commentsCount = 3;
  const before = calls.length;
  assert.equal((await call('POST', '/api/media/refresh')).status, 200);
  const pr = await until(() => calls.slice(before).find((c) => c.path === `/${OWN_ID}/messages`), 'polled private reply');
  assert.deepEqual(pr.body.recipient, { comment_id: 'C10' });
  await call('POST', '/api/media/refresh');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(calls.slice(before).filter((c) => c.path === `/${OWN_ID}/messages`).length, 1, 'C1 already handled, C0 too old');
  assert.equal(calls.slice(before).filter((c) => c.path === '/MEDIA1/comments').length, 1, 'unchanged count is not re-fetched');
  assert.equal((await call('GET', '/api/media')).json[0].id, 'MEDIA1');
});

test('manual reply is refused outside the 24-hour window and sent inside it', async () => {
  assert.equal((await call('POST', '/api/contacts/CU10/send', { text: 'hello' })).status, 400);
  const before = sends().length;
  assert.equal((await call('POST', '/api/contacts/USER1/send', { text: 'Thanks for asking!' })).status, 200);
  const sent = await until(() => sends()[before], 'manual send');
  assert.deepEqual(sent.body, { recipient: { id: 'USER1' }, message: { text: 'Thanks for asking!' } });
});

test('permanent send failures are recorded, not retried forever', async () => {
  await call('POST', '/api/rules', { name: 'Fail', trigger_type: 'dm', match_mode: 'exact', keywords: ['failme'], reply_text: 'x' });
  failNextSend = 1;
  await webhook(dm('failme', 'mid.fail', {}, 'USER3'));
  const row = await until(async () => (await call('GET', '/api/outbox')).json.find((o: any) => o.status === 'failed'), 'failed outbox row');
  assert.match(row.error, /Simulated permanent failure/);
});

test('scheduled post is published once when due', async () => {
  const bad = await call('POST', '/api/posts', { type: 'REELS', media: [{ url: 'https://x.test/a.jpg', kind: 'image' }], scheduled_at: Date.now() });
  assert.equal(bad.status, 400);
  const before = calls.length;
  const ok = await call('POST', '/api/posts', { type: 'IMAGE', caption: 'Hello world', media: [{ url: `${APP}/media/a.jpg`, kind: 'image' }], scheduled_at: Date.now() - 1000 });
  assert.equal(ok.status, 200);
  const post = await until(async () => (await call('GET', '/api/posts')).json.find((p: any) => p.status === 'published'), 'post published');
  assert.equal(post.ig_media_id, 'PUBLISHED1');
  const made = calls.slice(before);
  assert.deepEqual(made.find((c) => c.method === 'POST' && c.path === `/${OWN_ID}/media`)!.body, { image_url: `${APP}/media/a.jpg`, caption: 'Hello world' });
  assert.deepEqual(made.find((c) => c.path === `/${OWN_ID}/media_publish`)!.body, { creation_id: 'CONTAINER1' });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(calls.slice(before).filter((c) => c.path === `/${OWN_ID}/media_publish`).length, 1);
});

test('image upload is converted to JPEG and served publicly', async () => {
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } }).png().toBuffer();
  const form = new FormData();
  form.append('files', new Blob([png], { type: 'image/png' }), 'pic.png');
  const res = await fetch(APP + '/api/upload', { method: 'POST', headers: { Cookie: cookie }, body: form });
  assert.equal(res.status, 200);
  const [file] = await res.json();
  assert.match(file.url, /\/media\/[0-9a-f]{32}\.jpg$/);
  const pub = await fetch(file.url); // no cookie: Instagram fetches this anonymously
  assert.equal(pub.headers.get('content-type'), 'image/jpeg');
  const anon = await fetch(APP + '/api/upload', { method: 'POST', body: form });
  assert.equal(anon.status, 401);
});
