/**
 * Visual flows end-to-end: the real server against a mock Instagram API, driven through the
 * dashboard API and signed webhooks.
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
const APP = `http://127.0.0.1:${APP_PORT}`;
const SECRET = 'flows-app-secret';
const OWN = '17840000000000009';

interface Call { method: string; path: string; body: any }
const calls: Call[] = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const p = new URL(req.url!, 'http://x').pathname.replace(/^\/v[\d.]+/, '');
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method!, path: p, body });
    const send = (code: number, json: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (p === '/me') return send(200, { id: '1', client_business_id: 'B' });
    if (p === '/me/assigned_instagram_accounts') return send(200, { data: [{ id: OWN, username: 'shop' }] });
    if (p === `/${OWN}`) return send(200, { username: 'shop' });
    if (/subscribed_apps$/.test(p)) return send(200, { success: true });
    // A private reply reveals the commenter's messaging ID, which differs from the comment's "from" ID here.
    if (p === `/${OWN}/messages`) return send(200, { recipient_id: body.recipient.id ?? `IG_${body.recipient.comment_id}`, message_id: `mid.${calls.length}` });
    if (/\/replies$/.test(p)) return send(200, { id: `r.${calls.length}` });
    if (p === '/USER_A') return send(200, { name: 'Asha Rao', username: 'asha' });
    if (p === `/${OWN}/media`) return send(200, { data: [] });
    send(404, { error: { message: 'no route', code: 100 } });
  });
});

let child: ChildProcess;
let cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-flows-'));
async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(APP + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any, res };
}
async function hook(payload: unknown) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const r = await fetch(APP + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  assert.equal(r.status, 200);
}
let midN = 0;
const dm = (sender: string, text: string, extra: object = {}) => hook({ object: 'instagram', entry: [{ id: OWN, messaging: [{ sender: { id: sender }, recipient: { id: OWN }, timestamp: Date.now(), message: { mid: `in.${++midN}`, text, ...extra } }] }] });
const postback = (sender: string, title: string, payload: string) => hook({ object: 'instagram', entry: [{ id: OWN, messaging: [{ sender: { id: sender }, recipient: { id: OWN }, timestamp: Date.now(), postback: { mid: `pb.${++midN}`, title, payload } }] }] });
const comment = (id: string, from: string, text: string) => hook({ object: 'instagram', entry: [{ id: OWN, changes: [{ field: 'comments', value: { comment_id: id, text, from: { id: from, username: from.toLowerCase() }, media: { id: 'M1' } } }] }] });
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}
const msgs = () => calls.filter((c) => c.method === 'POST' && c.path === `/${OWN}/messages`);
const to = (id: string) => msgs().filter((c) => c.body.recipient.id === id);
const quiet = () => new Promise((r) => setTimeout(r, 500));

let seq = 0;
const node = (type: string, data: object = {}, x = 0, y = 0) => ({ id: `n${++seq}`, type, x, y, data });
const edge = (from: { id: string }, port: string, toN: { id: string }) => ({ id: `e${++seq}`, from: from.id, port, to: toN.id });
async function makeFlow(name: string, nodes: any[], edges: any[], enabled = true) {
  const { json } = await call('POST', '/api/flows', { name, graph: { nodes, edges } });
  const r = await call('PUT', `/api/flows/${json.id}`, { name, enabled, graph: { nodes, edges } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return json.id as number;
}

before(async () => {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, r));
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env, PORT: String(APP_PORT), BASE_URL: APP, DATA_DIR: dataDir, ADMIN_PASSWORD: 'correct-horse', SESSION_SECRET: 'y'.repeat(32),
      META_APP_ID: '1', META_APP_SECRET: SECRET, META_CONFIG_ID: 'C', WEBHOOK_VERIFY_TOKEN: 'verify-flows', GRAPH_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      QUEUE_TICK_MS: '60', SEND_GAP_MS: '5', FLOW_TICK_MS: '60', FLOW_TIME_SCALE: '0.002',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await until(() => fetch(APP + '/healthz').then((r) => r.ok).catch(() => false), 'server start', 20000);
  const login = await call('POST', '/api/login', { password: 'correct-horse' });
  cookie = login.res.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('POST', '/api/account/token', { token: 'SUAT-flows-token-1234567890' })).status, 200);
});
after(() => {
  child?.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('graphs are sanitised and validated; a broken flow cannot go live', async () => {
  const t = node('trigger', { on: 'dm', match_mode: 'contains', keywords: [] });
  const m = node('message', { text: '' , evil: '<script>' });
  const bad = await call('POST', '/api/flows/validate', { graph: { nodes: [t, m], edges: [edge(t, 'next', m), edge(m, 'nonexistent', t)] } });
  const msgsOut = bad.json.issues.map((i: any) => i.message).join(' | ');
  assert.match(msgsOut, /keyword/);
  assert.match(msgsOut, /empty/);
  const { json } = await call('POST', '/api/flows', { name: 'Broken', graph: { nodes: [t, m], edges: [edge(t, 'next', m)] } });
  const live = await call('PUT', `/api/flows/${json.id}`, { enabled: true, graph: { nodes: [t, m], edges: [edge(t, 'next', m)] } });
  assert.equal(live.status, 400);
  assert.match(live.json.error, /Fix 2 problem/);
  assert.equal((await call('POST', `/api/flows/${json.id}/toggle`)).status, 400);
  const saved = (await call('GET', `/api/flows/${json.id}`)).json;
  assert.equal(saved.enabled, 0);
  assert.equal(saved.graph.nodes[1].data.evil, undefined, 'unknown fields are dropped');
  assert.equal((await call('POST', '/api/flows', { graph: { nodes: [{ id: 'x', type: 'rm -rf', x: 0, y: 0 }], edges: [] } })).status, 400);
  await call('DELETE', `/api/flows/${json.id}`);
});

test('DM flow: quick replies branch, saved answers are validated and reused, tags drive conditions', async () => {
  const t = node('trigger', { on: 'dm', keywords: ['menu'] });
  const m = node('message', { text: 'Hi {{first_name}}! Pick one', quick: ['Get guide', 'Human'] });
  const ask = node('message', { text: 'Your email?' });
  const w = node('wait_reply', { save_as: 'email', validate: 'email' });
  const oops = node('message', { text: 'Not an email, try again' });
  const tag = node('tag', { action: 'add', tag: 'lead' });
  const cond = node('condition', { check: 'tag', values: ['lead'] });
  const done = node('message', { text: 'Sent to {{email}}', buttons: [{ title: 'Open', kind: 'url', url: 'https://x.test/g' }, { title: 'More', kind: 'flow' }] });
  const more = node('message', { text: 'Here is more' });
  const human = node('handoff', { pause_hours: 2 });
  const id = await makeFlow('Menu', [t, m, ask, w, oops, tag, cond, done, more, human], [
    edge(t, 'next', m), edge(m, 'q0', ask), edge(m, 'q1', human), edge(ask, 'next', w), edge(w, 'reply', tag), edge(w, 'invalid', oops),
    edge(oops, 'next', w), edge(tag, 'next', cond), edge(cond, 'yes', done), edge(done, 'b1', more),
  ]);

  await dm('USER_A', 'show me the MENU please');
  const first = await until(() => to('USER_A')[0], 'menu message');
  assert.equal(first.body.message.text, 'Hi Asha! Pick one');
  assert.deepEqual(first.body.message.quick_replies.map((q: any) => q.title), ['Get guide', 'Human']);
  const payload = first.body.message.quick_replies[0].payload;
  assert.match(payload, new RegExp(`^flow:${id}:${m.id}:q0$`));

  await dm('USER_A', 'Get guide', { quick_reply: { payload } });
  await until(() => to('USER_A')[1], 'email question');
  assert.equal(to('USER_A')[1].body.message.text, 'Your email?');

  await dm('USER_A', 'nope');
  await until(() => to('USER_A')[2], 'invalid answer reply');
  assert.equal(to('USER_A')[2].body.message.text, 'Not an email, try again');

  await dm('USER_A', ' asha@example.com ');
  const last = await until(() => to('USER_A')[3], 'final message');
  const tplPayload = last.body.message.attachment.payload;
  assert.equal(tplPayload.text, 'Sent to asha@example.com');
  assert.deepEqual(tplPayload.buttons[0], { type: 'web_url', title: 'Open', url: 'https://x.test/g' });
  assert.equal(tplPayload.buttons[1].type, 'postback');

  // Postback button continues the flow, even though the run had finished.
  await postback('USER_A', 'More', tplPayload.buttons[1].payload);
  await until(() => to('USER_A')[4], 'postback branch');
  assert.equal(to('USER_A')[4].body.message.text, 'Here is more');

  const f = (await call('GET', `/api/flows/${id}`)).json;
  assert.equal(f.stats.hits[w.id], 2, 'wait step ran twice (once after the invalid answer)');
  assert.ok(f.stats.runs.done >= 1);
  const outbox = (await call('GET', '/api/outbox')).json;
  assert.equal(outbox[0].rule_name, 'Menu', 'activity shows the flow name');
});

test('a free-text answer with nothing connected falls through to simple rules', async () => {
  await call('POST', '/api/rules', { name: 'Hours', trigger_type: 'dm', match_mode: 'contains', keywords: ['hours'], reply_text: 'We are open 9 to 6' });
  const t = node('trigger', { on: 'dm', keywords: ['start'] });
  const m = node('message', { text: 'Choose', quick: ['A'] });
  await makeFlow('Fallthrough', [t, m], [edge(t, 'next', m)]);
  await dm('USER_B', 'start');
  await until(() => to('USER_B')[0], 'flow message');
  await dm('USER_B', 'what are your hours?');
  await until(() => to('USER_B')[1], 'rule reply');
  assert.equal(to('USER_B')[1].body.message.text, 'We are open 9 to 6');
});

test('comment flow: public reply, text-only private reply, then the run follows the commenter into DMs', async () => {
  const t = node('trigger', { on: 'comment', keywords: ['link'] });
  const pub = node('comment_reply', { variants: ['Check your DMs!'] });
  const m = node('message', { text: 'Want the link?', quick: ['Yes'], buttons: [] });
  const link = node('message', { text: 'Here it is', buttons: [{ title: 'Open', kind: 'url', url: 'https://x.test/l' }] });
  await makeFlow('Comment link', [t, pub, m, link], [edge(t, 'next', pub), edge(pub, 'next', m), edge(m, 'q0', link)]);

  await comment('C100', 'FAN1', 'LINK pls');
  const pr = await until(() => msgs().find((c) => c.body.recipient.comment_id === 'C100'), 'private reply');
  assert.equal(pr.body.message.text, 'Want the link?\n\nReply with: Yes', 'choices are written into the text');
  assert.equal(pr.body.message.quick_replies, undefined);
  await until(() => calls.find((c) => c.path === '/C100/replies'), 'public reply');
  // The commenter answers in DMs from their messaging ID (different from the comment's from.id).
  await dm('IG_C100', 'yes');
  const sent = await until(() => to('IG_C100')[0], 'link after reply');
  assert.equal(sent.body.message.attachment.payload.text, 'Here it is');
});

test('delays resume on the timer and reply timeouts take the "no reply" path', async () => {
  const t = node('trigger', { on: 'dm', keywords: ['later'] });
  const d = node('delay', { amount: 1, unit: 'minutes' }); // 120 ms with the test time scale
  const m = node('message', { text: 'After the delay' });
  const w = node('wait_reply', { timeout_minutes: 1 });
  const late = node('message', { text: 'Still there?' });
  await makeFlow('Timers', [t, d, m, w, late], [edge(t, 'next', d), edge(d, 'next', m), edge(m, 'next', w), edge(w, 'timeout', late)]);
  await dm('USER_C', 'later');
  await quiet();
  const a = await until(() => to('USER_C')[0], 'message after delay');
  assert.equal(a.body.message.text, 'After the delay');
  const b = await until(() => to('USER_C')[1], 'timeout message');
  assert.equal(b.body.message.text, 'Still there?');
});

test('cooldown, A/B split and hand-off', async () => {
  const t = node('trigger', { on: 'dm', keywords: ['split'], cooldown_minutes: 60 });
  const s = node('split', { percent_a: 99 });
  const a = node('message', { text: 'Path A' });
  const b = node('message', { text: 'Path B' });
  const h = node('handoff', { pause_hours: 3 });
  await makeFlow('Split', [t, s, a, b, h], [edge(t, 'next', s), edge(s, 'a', a), edge(s, 'b', b), edge(a, 'next', h), edge(b, 'next', h)]);
  await dm('USER_D', 'split');
  await until(() => to('USER_D')[0], 'split message');
  assert.match(to('USER_D')[0].body.message.text, /^Path [AB]$/);
  const c = (await call('GET', '/api/contacts/USER_D/messages')).json.contact;
  assert.ok(c.paused_until > Date.now() + 2.9 * 3600_000, 'hand-off pauses automation for this person');
  await call('POST', '/api/contacts/USER_D/pause', { minutes: 0 });
  await dm('USER_D', 'split');
  await quiet();
  assert.equal(to('USER_D').length, 1, 'cooldown stops a second run');
});

test('turning a flow off cancels people in the middle of it', async () => {
  const t = node('trigger', { on: 'dm', keywords: ['pause'] });
  const w = node('wait_reply', {});
  const m = node('message', { text: 'Thanks' });
  const id = await makeFlow('Cancel me', [t, w, m], [edge(t, 'next', w), edge(w, 'reply', m)]);
  await dm('USER_E', 'pause');
  await until(async () => (await call('GET', `/api/flows/${id}`)).json.stats.runs.waiting === 1, 'waiting run');
  await call('POST', `/api/flows/${id}/toggle`);
  const f = (await call('GET', `/api/flows/${id}`)).json;
  assert.equal(f.enabled, 0);
  assert.equal(f.stats.runs.cancelled, 1);
  await dm('USER_E', 'here is my answer');
  await quiet();
  assert.equal(to('USER_E').length, 0);
});
