/**
 * Owner's Clients page: a main instance switches a client instance's tools over the control API; switched-off tools
 * are locked (pages show the upsell, API answers 403, workers stop). Also: WhatsApp webhooks are passed on to clients.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const MAIN_PORT = 34831;
const CLIENT_PORT = 34832;
const MAIN = `http://127.0.0.1:${MAIN_PORT}`;
const CLIENT = `http://127.0.0.1:${CLIENT_PORT}`;
const SECRET = 'c'.repeat(48);
const APP_SECRET = 'shared-meta-secret';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-ctl-'));
const clientsFile = path.join(tmp, 'clients.json');
const forwardFile = path.join(tmp, 'forward.json');
fs.writeFileSync(clientsFile, JSON.stringify([
  { name: 'bakery', url: 'https://bakery.zealcoder.in', internal: CLIENT, ig: 'sweetbakes', secret: SECRET },
  { name: 'gone', url: 'https://gone.zealcoder.in', internal: 'http://127.0.0.1:34839', ig: 'gone', secret: 'd'.repeat(48) },
]));
fs.writeFileSync(forwardFile, JSON.stringify([CLIENT]));

const procs: ChildProcess[] = [];
let mainCookie = '';
let clientCookie = '';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot(port: number, extra: Record<string, string>) {
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, DATA_DIR: fs.mkdtempSync(path.join(tmp, 'd-')),
      ADMIN_PASSWORD: 'correct-horse-battery', SESSION_SECRET: 's'.repeat(32), META_APP_SECRET: APP_SECRET,
      GRAPH_BASE: 'http://127.0.0.1:1', CLIENT_CALL_TIMEOUT_MS: '1500', ...extra,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.push(p);
}
async function up(base: string) {
  const end = Date.now() + 20000;
  while (!(await fetch(base + '/healthz').then((r) => r.ok).catch(() => false))) {
    if (Date.now() > end) throw new Error(`${base} did not start`);
    await wait(100);
  }
}
async function call(base: string, cookie: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.clone().json().catch(() => ({})), res };
}
const M = (method: string, p: string, body?: unknown) => call(MAIN, mainCookie, method, p, body);
const C = (method: string, p: string, body?: unknown) => call(CLIENT, clientCookie, method, p, body);
async function login(base: string) {
  const r = await call(base, '', 'POST', '/api/login', { password: 'correct-horse-battery' });
  return r.res.headers.get('set-cookie')!.split(';')[0];
}

before(async () => {
  boot(MAIN_PORT, { CLIENTS_FILE: clientsFile, FORWARD_WEBHOOKS_FILE: forwardFile });
  boot(CLIENT_PORT, { CONTROL_SECRET: SECRET, CLIENT_NAME: 'bakery' });
  await Promise.all([up(MAIN), up(CLIENT)]);
  [mainCookie, clientCookie] = await Promise.all([login(MAIN), login(CLIENT)]);
});
after(() => {
  for (const p of procs) p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('control API: only with the secret, never through a proxy, never on the main instance', async () => {
  assert.equal((await call(CLIENT, '', 'GET', '/internal/status')).status, 404);
  assert.equal((await call(CLIENT, '', 'GET', '/internal/status', undefined, { 'X-Control-Secret': 'wrong' })).status, 404);
  assert.equal((await call(CLIENT, '', 'GET', '/internal/status', undefined, { 'X-Control-Secret': SECRET, 'X-Forwarded-For': '1.2.3.4' })).status, 404);
  // The client's own login cannot use it either.
  assert.equal((await C('PUT', '/internal/apps', { apps: { dm: false } })).status, 404);
  const ok = await call(CLIENT, '', 'GET', '/internal/status', undefined, { 'X-Control-Secret': SECRET });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.managed, true);
  assert.deepEqual(ok.json.apps, { dm: true, scheduler: true, linkedin: true, whatsapp: true });
  assert.equal((await call(MAIN, '', 'GET', '/internal/status', undefined, { 'X-Control-Secret': SECRET })).status, 404);
  // The Clients page is the owner's, not the client's.
  assert.equal((await C('GET', '/api/clients/')).status, 404);
  assert.equal((await C('GET', '/api/apps')).json.clients, false);
});

test('main lists clients with their tools; an unreachable client shows as offline', async () => {
  assert.equal((await M('GET', '/api/apps')).json.clients, true);
  assert.equal((await call(MAIN, '', 'GET', '/api/clients/')).status, 401);
  const r = await M('GET', '/api/clients/');
  assert.equal(r.status, 200);
  const bakery = r.json.clients.find((c: any) => c.name === 'bakery');
  assert.equal(bakery.online, true);
  assert.equal(bakery.apps.linkedin, true);
  const gone = r.json.clients.find((c: any) => c.name === 'gone');
  assert.equal(gone.online, false);
  assert.equal((await M('PUT', '/api/clients/gone', { apps: { dm: false } })).status, 502);
  assert.equal((await M('PUT', '/api/clients/nobody', { apps: { dm: false } })).status, 404);
  assert.equal((await fetch(MAIN + '/clients')).status, 200);
});

test('switching LinkedIn and WhatsApp off locks them; the rest keeps working', async () => {
  const r = await M('PUT', '/api/clients/bakery', { apps: { linkedin: false, whatsapp: false } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.apps, { dm: true, scheduler: true, linkedin: false, whatsapp: false });

  const apps = (await C('GET', '/api/apps')).json;
  assert.equal(apps.apps.linkedin, false);
  assert.match(apps.upsell.message, /plan/);

  const page = await C('GET', '/linkedin/');
  assert.equal(page.status, 302);
  assert.equal(page.res.headers.get('location'), '/locked?app=linkedin');
  const liApi = await C('GET', '/linkedin/api/posts');
  assert.equal(liApi.status, 403);
  assert.equal(liApi.json.locked, 'linkedin');
  assert.equal((await C('GET', '/whatsapp/api/status')).status, 403);
  assert.equal((await C('GET', '/whatsapp/')).res.headers.get('location'), '/locked?app=whatsapp');
  // Meta's webhook still gets its normal answers (not a redirect), so the subscription stays healthy.
  assert.equal((await fetch(CLIENT + '/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status, 403);
  assert.equal((await fetch(CLIENT + '/whatsapp/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  assert.equal((await C('GET', '/api/rules')).status, 200);
  assert.equal((await C('GET', '/api/posts')).status, 200);
  assert.equal((await fetch(CLIENT + '/locked?app=linkedin')).status, 200);
});

test('DM off: its API and page are locked, the Scheduler and shared account routes are not', async () => {
  await M('PUT', '/api/clients/bakery', { apps: { dm: false } });
  const rules = await C('GET', '/api/rules');
  assert.equal(rules.status, 403);
  assert.equal(rules.json.locked, 'dm');
  assert.equal((await C('GET', '/api/flows')).status, 403);
  assert.equal((await C('GET', '/api/contacts')).status, 403);
  assert.equal((await C('GET', '/api/posts')).status, 200);
  assert.equal((await C('GET', '/api/shell')).status, 200);
  assert.equal((await C('GET', '/dm/')).res.headers.get('location'), '/locked?app=dm');
  assert.equal((await C('GET', '/scheduler/')).status, 200);

  // Back on: everything is reachable again, and the setting survives in the client's own database.
  const back = await M('PUT', '/api/clients/bakery', { apps: { dm: true, whatsapp: true } });
  assert.deepEqual(back.json.apps, { dm: true, scheduler: true, linkedin: false, whatsapp: true });
  assert.equal((await C('GET', '/api/rules')).status, 200);
});

test('upsell message and contact reach every client', async () => {
  const r = await M('PUT', '/api/clients/upsell', { message: 'Upgrade to Pro for this tool.', contact: '+91 98765 43210' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.find((x: any) => x.name === 'bakery'), { name: 'bakery', ok: true });
  assert.equal(r.json.results.find((x: any) => x.name === 'gone').ok, false);
  const apps = (await C('GET', '/api/apps')).json;
  assert.deepEqual(apps.upsell, { message: 'Upgrade to Pro for this tool.', contact: '+91 98765 43210' });
  assert.equal((await M('GET', '/api/clients/')).json.upsell.message, 'Upgrade to Pro for this tool.');
});

test('WhatsApp webhooks reach the main instance once and are passed on to the client that owns the number', async () => {
  assert.equal((await C('PUT', '/whatsapp/api/settings', { phoneId: '5550001112223' })).status, 200);
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '5550001112223' }, contacts: [{ profile: { name: 'Meera' }, wa_id: '919800000009' }], messages: [{ from: '919800000009', id: 'wamid.fwd1', type: 'text', text: { body: 'hello bakery' } }] } }] }],
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  const r = await fetch(MAIN + '/whatsapp/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  assert.equal(r.status, 200);
  const end = Date.now() + 5000;
  let contacts: any[] = [];
  while (Date.now() < end) {
    contacts = (await C('GET', '/whatsapp/api/contacts')).json;
    if (contacts.length) break;
    await wait(100);
  }
  assert.equal(contacts[0]?.wa_id, '919800000009');
  assert.equal(contacts[0]?.last_text, 'hello bakery');
  // The main instance has no number connected, so it stored nothing.
  assert.deepEqual((await M('GET', '/whatsapp/api/contacts')).json, []);
});
