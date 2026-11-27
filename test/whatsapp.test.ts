/**
 * WhatsApp automation end to end: boots the real server against a mock WhatsApp Cloud API and drives it with
 * signed webhooks, the dashboard API and the n8n API key.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const APP_PORT = 34821;
const MOCK_PORT = 34822;
const HOOK_PORT = 34823;
const APP = `http://127.0.0.1:${APP_PORT}`;
const SECRET = 'wa-test-app-secret';
const PHONE_ID = '1112223334445556';
const WABA_ID = '9998887776665554';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-wa-'));

interface Call { method: string; path: string; body: any; auth?: string }
const calls: Call[] = [];
let nextId = 1;
let failNext: { code: number; status: number } | null = null;
const sends = () => calls.filter((c) => c.method === 'POST' && c.path === `/${PHONE_ID}/messages` && c.body.type);

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname.replace(/^\/v[\d.]+/, '');
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method!, path: p, body, auth: req.headers.authorization });
    const send = (code: number, json: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== 'Bearer EAAtest-token-123456789012345') return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (p === `/${PHONE_ID}` && req.method === 'GET') return send(200, { display_phone_number: '+91 98765 00000', verified_name: 'Zeal Shop', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' });
    if (p === `/${PHONE_ID}/messages`) {
      if (body.status === 'read') return send(200, { success: true });
      if (failNext) {
        const f = failNext;
        failNext = null;
        return send(f.status, { error: { message: 'Simulated failure', code: f.code } });
      }
      return send(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out${nextId++}` }] });
    }
    if (p === `/${WABA_ID}/subscribed_apps`) return send(200, { success: true });
    if (p === `/${WABA_ID}/message_templates`) {
      return send(200, {
        data: [
          { name: 'offer', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}, use code {{2}} today!' }] },
          { name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello World' }] },
          { name: 'pending_one', language: 'en_US', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Soon' }] },
        ],
      });
    }
    send(404, { error: { message: `mock: unknown ${p}` } });
  });
});

// Stands in for n8n's Webhook node.
const hookHits: { headers: http.IncomingHttpHeaders; raw: string }[] = [];
const hook = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    hookHits.push({ headers: req.headers, raw });
    res.writeHead(200).end('ok');
  });
});

let child: ChildProcess;
let cookie = '';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(50);
  }
}

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(APP + p, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.clone().json().catch(() => ({})), res };
}

let seq = 0;
async function webhook(value: any, secret = SECRET) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, ...value } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(APP + '/whatsapp/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
}
const inbound = (from: string, text: string, name = 'Asha Rao') =>
  webhook({ contacts: [{ profile: { name }, wa_id: from }], messages: [{ from, id: `wamid.in${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] });

before(async () => {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, r));
  await new Promise<void>((r) => hook.listen(HOOK_PORT, r));
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env, PORT: String(APP_PORT), BASE_URL: APP, DATA_DIR: dataDir, ADMIN_PASSWORD: 'correct-horse-battery', SESSION_SECRET: 'z'.repeat(32),
      META_APP_SECRET: SECRET, GRAPH_BASE: `http://127.0.0.1:${MOCK_PORT}`, WA_TICK_MS: '100', WA_SEND_GAP_MS: '0', QUEUE_TICK_MS: '100', OUTHOOK_RETRY_MS: '',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const end = Date.now() + 20000;
  while (!(await fetch(APP + '/healthz').then((r) => r.ok).catch(() => false))) {
    if (Date.now() > end) throw new Error('server did not start');
    await wait(100);
  }
});
after(() => {
  child?.kill();
  mock.close();
  hook.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('dashboard API needs the platform login; the page is served with the strict CSP', async () => {
  assert.equal((await call('GET', '/whatsapp/api/status')).status, 401);
  const r = await call('POST', '/api/login', { password: 'correct-horse-battery' });
  cookie = r.res.headers.get('set-cookie')!.split(';')[0];
  const s = await call('GET', '/whatsapp/api/status');
  assert.equal(s.status, 200);
  assert.equal(s.json.configured, false);
  assert.equal(s.res.headers.get('cache-control'), 'no-store');

  const page = await fetch(APP + '/whatsapp/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /src="\/whatsapp\/app.js"/);
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self';/);
  assert.equal((await fetch(APP + '/whatsapp', { redirect: 'manual' })).headers.get('location'), '/whatsapp/');
  assert.equal((await fetch(APP + '/whatsapp/app.js')).status, 200);
});

test('settings: save IDs and token, test the connection, subscribe; secrets are never echoed back', async () => {
  assert.equal((await call('PUT', '/whatsapp/api/settings', { phoneId: '+91 98765' })).status, 400);
  const s = await call('PUT', '/whatsapp/api/settings', { phoneId: PHONE_ID, wabaId: WABA_ID, token: 'EAAtest-token-123456789012345', defaultCc: '91' });
  assert.equal(s.status, 200);
  assert.equal(s.json.tokenSet, true);
  assert.equal(s.json.appSecretFromEnv, true);
  assert.equal(s.json.webhookUrl, `${APP}/whatsapp/webhook`);
  assert.ok(!JSON.stringify(s.json).includes('EAAtest'));
  const t = await call('POST', '/whatsapp/api/settings/test');
  assert.equal(t.status, 200);
  assert.equal(t.json.info.verified_name, 'Zeal Shop');
  assert.equal((await call('POST', '/whatsapp/api/settings/subscribe')).json.ok, true);
  assert.ok(calls.some((c) => c.path === `/${WABA_ID}/subscribed_apps` && c.method === 'POST'));
  // The token is stored encrypted.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(dataDir, 'app.db'), { readonly: true });
  const row = db.prepare("SELECT value FROM settings WHERE key = 'wa_token'").get() as { value: string };
  db.close();
  assert.match(row.value, /^enc:v1:/);
});

test('webhook: verify handshake, signature required', async () => {
  const { json } = await call('GET', '/whatsapp/api/settings');
  const ok = await fetch(`${APP}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${json.verifyToken}&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  assert.equal((await fetch(`${APP}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status, 403);
  assert.equal((await webhook({ messages: [] }, 'wrong-secret')).status, 401);
});

test('auto-replies: welcome on the first message, keyword rule with buttons after, cooldown respected', async () => {
  const w = await call('POST', '/whatsapp/api/rules', { name: 'Welcome', trigger_type: 'welcome', reply_text: 'Hi {{first_name}}, welcome!' });
  assert.equal(w.status, 200);
  assert.equal((await call('POST', '/whatsapp/api/rules', { name: 'No keywords', reply_text: 'x' })).status, 400);
  const k = await call('POST', '/whatsapp/api/rules', { name: 'Price', keywords: ['price', 'cost'], reply_text: 'Plans start at 999.', buttons: ['Buy now', 'Talk to us'], cooldown_minutes: 60 });
  assert.equal(k.status, 200);

  await inbound('919800000001', 'hello there');
  await until(() => sends().length === 1);
  const first = sends()[0].body;
  assert.equal(first.to, '919800000001');
  assert.equal(first.type, 'text');
  assert.equal(first.text.body, 'Hi Asha, welcome!');
  assert.ok(calls.some((c) => c.body.status === 'read' && c.body.message_id === `wamid.in${seq}`), 'marks as read');

  await inbound('919800000001', 'what is the PRICE?');
  await until(() => sends().length === 2);
  const second = sends()[1].body;
  assert.equal(second.type, 'interactive');
  assert.equal(second.interactive.body.text, 'Plans start at 999.');
  assert.deepEqual(second.interactive.action.buttons.map((b: any) => b.reply.title), ['Buy now', 'Talk to us']);

  await inbound('919800000001', 'price again');
  await wait(400);
  assert.equal(sends().length, 2, 'cooldown stops a second price reply');
  // "blink" must not match "link"-style partial words: "pricey" is not "price".
  await inbound('919800000001', 'pricey');
  await wait(300);
  assert.equal(sends().length, 2);

  const rules = (await call('GET', '/whatsapp/api/rules')).json;
  assert.equal(rules.find((r: any) => r.name === 'Price').hits, 1);
});

test('delivery receipts move forward only; inbox shows the thread', async () => {
  const wamid = 'wamid.out2';
  await webhook({ statuses: [{ id: wamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919800000001' }] });
  await webhook({ statuses: [{ id: wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919800000001' }] });
  await wait(100);
  const t = await call('GET', '/whatsapp/api/contacts/919800000001/messages');
  assert.equal(t.status, 200);
  assert.equal(t.json.contact.name, 'Asha Rao');
  assert.equal(t.json.contact.window_open, true);
  const m = t.json.messages.find((x: any) => x.wamid === wamid);
  assert.equal(m.status, 'read');
  assert.ok(t.json.messages.some((x: any) => x.direction === 'in' && x.text === 'what is the PRICE?'));
});

test('manual reply pauses the bot for that chat; outside the 24h window only templates go', async () => {
  const before = sends().length;
  const r = await call('POST', '/whatsapp/api/contacts/919800000001/send', { text: 'Hey, I am here' });
  assert.equal(r.status, 200);
  await until(() => sends().length === before + 1);
  assert.equal(sends().at(-1)!.body.text.body, 'Hey, I am here');
  // Paused: the bot no longer answers this person by itself.
  await call('POST', '/whatsapp/api/rules', { name: 'Hours', keywords: ['hours'], reply_text: 'We are open 9-6.' });
  await inbound('919800000001', 'hours?');
  await wait(400);
  assert.equal(sends().length, before + 1);

  const closed = await call('POST', '/whatsapp/api/contacts/919811111111/send', { text: 'cold message' });
  assert.equal(closed.status, 400);
  assert.match(closed.json.error, /24 hours/);
});

test('STOP opts out (and gets a confirmation); broadcasts skip opted-out numbers', async () => {
  const before = sends().length;
  await inbound('919800000002', 'STOP', 'Ravi');
  await until(() => sends().length === before + 1);
  assert.match(sends().at(-1)!.body.text.body, /unsubscribed/);

  const sync = await call('POST', '/whatsapp/api/templates/sync');
  assert.equal(sync.json.count, 3);
  const pending = await call('POST', '/whatsapp/api/broadcasts', { name: 'x', template: 'pending_one', language: 'en_US', recipients: '919800000003' });
  assert.equal(pending.status, 400);
  const missingVars = await call('POST', '/whatsapp/api/broadcasts', { name: 'x', template: 'offer', language: 'en_US', recipients: '919800000003' });
  assert.equal(missingVars.status, 400);

  const preview = await call('POST', '/whatsapp/api/broadcasts/preview', { template: 'offer', language: 'en_US', recipients: 'phone,name,code\n9800000003, Meera, SAVE10\n919800000002, Ravi, SAVE10\nnot-a-number, a, b\n+91 98000 00003, dup, X' });
  assert.equal(preview.json.valid, 2);
  assert.equal(preview.json.invalidCount, 1);

  const b = await call('POST', '/whatsapp/api/broadcasts', { name: 'Diwali', template: 'offer', language: 'en_US', recipients: '9800000003, Meera, SAVE10\n919800000002, Ravi, SAVE10' });
  assert.equal(b.status, 200);
  assert.equal(b.json.total, 2);
  await until(async () => (await call('GET', '/whatsapp/api/broadcasts')).json[0].status === 'done');
  const tpl = sends().filter((c) => c.body.type === 'template');
  assert.equal(tpl.length, 1, 'opted-out number skipped');
  assert.equal(tpl[0].body.to, '919800000003', 'default country code added');
  assert.deepEqual(tpl[0].body.template, { name: 'offer', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Meera' }, { type: 'text', text: 'SAVE10' }] }] });
  const row = (await call('GET', '/whatsapp/api/broadcasts')).json[0];
  assert.equal(row.sent, 1);
  assert.equal(row.skipped, 1);
});

test('n8n: API key sends messages; events are signed and delivered', async () => {
  assert.equal((await call('POST', '/whatsapp/api/external/send', { to: '919800000001', text: 'x' }, { Cookie: '' })).status, 401);
  const { json } = await call('POST', '/whatsapp/api/settings/api-key');
  assert.match(json.key, /^wak_/);
  const before = sends().length;
  const r = await fetch(APP + '/whatsapp/api/external/send', {
    method: 'POST', headers: { Authorization: `Bearer ${json.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: '+91 98000 00004', template: 'hello_world', language: 'en_US' }),
  });
  assert.equal(r.status, 202);
  const q = await r.json();
  await until(() => sends().length === before + 1);
  assert.equal(sends().at(-1)!.body.to, '919800000004');
  const st = await fetch(`${APP}/whatsapp/api/external/status/${q.id}`, { headers: { Authorization: `Bearer ${json.key}` } }).then((x) => x.json());
  assert.equal(st.queue_status, 'sent');

  const s = await call('PUT', '/whatsapp/api/settings', { hookUrl: `http://127.0.0.1:${HOOK_PORT}/webhook/wa` });
  assert.match(s.json.hookSecret, /^whsec_/);
  await inbound('919800000005', 'hi from n8n test', 'Kiran');
  await until(() => hookHits.some((h) => h.headers['x-autopilot-event'] === 'whatsapp.message.received'));
  const hit = hookHits.find((h) => h.headers['x-autopilot-event'] === 'whatsapp.message.received')!;
  const expected = 'sha256=' + crypto.createHmac('sha256', s.json.hookSecret).update(hit.raw).digest('hex');
  assert.equal(hit.headers['x-autopilot-signature'], expected);
  const evt = JSON.parse(hit.raw);
  assert.equal(evt.data.text, 'hi from n8n test');
  assert.equal(evt.data.contact.wa_id, '919800000005');
  assert.equal(evt.account.phone_number_id, PHONE_ID);
});

test('a failed send shows in Activity and can be retried; auth failure is not retried', async () => {
  failNext = { code: 190, status: 401 };
  const r = await call('POST', '/whatsapp/api/contacts/919800000005/send', { text: 'will fail' });
  assert.equal(r.status, 200);
  await until(async () => (await call('GET', '/whatsapp/api/activity')).json.failed.length === 1);
  const a = (await call('GET', '/whatsapp/api/activity')).json;
  assert.match(a.failed[0].error, /Simulated failure/);
  const before = sends().length;
  assert.equal((await call('POST', `/whatsapp/api/outbox/${a.failed[0].id}/retry`)).status, 200);
  await until(() => sends().length === before + 1);
  assert.equal((await call('GET', '/whatsapp/api/status')).json.configured, true);
});
