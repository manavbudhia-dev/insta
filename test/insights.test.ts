/**
 * Content calendar and Insights: the real server against a mock Instagram API.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const APP_PORT = 34831;
const MOCK_PORT = 34832;
const APP = `http://127.0.0.1:${APP_PORT}`;
const SECRET = 'insights-secret';
const OWN = '17840000000000077';
const DAY = 86400_000;
let insightsAllowed = false;
const media = [
  { id: 'P1', caption: 'Made here', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://instagram.com/p/P1', timestamp: new Date(Date.now() - 2 * DAY).toISOString(), like_count: 40, comments_count: 4 },
  { id: 'P2', caption: 'Posted in the app', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://instagram.com/p/P2', timestamp: new Date(Date.now() - 5 * DAY).toISOString(), like_count: 90, comments_count: 10 },
];

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => route(req, res, raw));
});
function route(req: http.IncomingMessage, res: http.ServerResponse, raw: string) {
  const u = new URL(req.url!, 'http://x');
  const p = u.pathname.replace(/^\/v[\d.]+/, '');
  const send = (code: number, json: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
  if (p === '/me') return send(200, { id: '1' });
  if (p === '/me/assigned_instagram_accounts') return send(200, { data: [{ id: OWN, username: 'shop' }] });
  if (p === `/${OWN}`) return send(200, { username: 'shop', followers_count: 1000, follows_count: 50, media_count: 2 });
  if (/subscribed_apps$/.test(p)) return send(200, req.method === 'POST' ? { success: true } : { data: [{ id: '1', subscribed_fields: ['messages', 'messaging_postbacks', 'comments'] }] });
  if (p === `/${OWN}/media`) return send(200, { data: media });
  if (p === `/${OWN}/messages`) return send(200, { recipient_id: JSON.parse(raw || '{}').recipient?.id, message_id: `m.${Math.random()}` });
  if (p === `/${OWN}/insights` || /^\/P\d\/insights$/.test(p)) {
    if (!insightsAllowed) return send(400, { error: { message: '(#10) Application does not have permission for this action', code: 10 } });
    if (u.searchParams.get('metric') === 'reach' && p === `/${OWN}/insights`) return send(200, { data: [{ name: 'reach', values: [{ value: 120, end_time: new Date(Date.now() - DAY).toISOString() }, { value: 150, end_time: new Date().toISOString() }] }] });
    if (p === `/${OWN}/insights`) return send(200, { data: [{ name: u.searchParams.get('metric'), total_value: { value: 77 } }] });
    return send(200, { data: [{ name: 'reach', values: [{ value: 500 }] }, { name: 'saved', values: [{ value: 9 }] }] });
  }
  send(404, { error: { message: 'no route', code: 100 } });
}

let child: ChildProcess;
let cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-ins-'));
async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(APP + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}
async function hook(payload: unknown) {
  const raw = JSON.stringify(payload);
  await fetch(APP + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex') }, body: raw });
}
async function until<T>(fn: () => Promise<T>, what: string, ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

before(async () => {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, r));
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(APP_PORT), BASE_URL: APP, DATA_DIR: dataDir, ADMIN_PASSWORD: 'correct-horse', SESSION_SECRET: 'z'.repeat(32),
      META_APP_ID: '1', META_APP_SECRET: SECRET, META_CONFIG_ID: 'C', WEBHOOK_VERIFY_TOKEN: 'verify-ins', GRAPH_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      QUEUE_TICK_MS: '60', SEND_GAP_MS: '5', SCHEDULER_TICK_MS: '600000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await until(() => fetch(APP + '/healthz').then((r) => r.ok).catch(() => false), 'server start', 20000);
  const login = await fetch(APP + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('POST', '/api/account/token', { token: 'SUAT-insights-1234567890' })).status, 200);
});
after(() => {
  child?.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const img = [{ url: 'https://cdn.test/a.jpg', kind: 'image' }];

test('calendar returns posts in range plus posts made directly on Instagram', async () => {
  const soon = Date.now() + 3 * DAY;
  const { json } = await call('POST', '/api/posts', { type: 'IMAGE', caption: 'Planned', media: img, scheduled_at: soon });
  const later = await call('POST', '/api/posts', { type: 'IMAGE', caption: 'Next month', media: img, scheduled_at: Date.now() + 45 * DAY });
  assert.equal(later.status, 200);
  const cal = (await call('GET', `/api/calendar?from=${Date.now() - 10 * DAY}&to=${Date.now() + 10 * DAY}`)).json;
  assert.deepEqual(cal.posts.map((p: any) => p.caption), ['Planned']);
  assert.equal(cal.posts[0].id, json.id);
  assert.deepEqual(cal.instagram.map((m: any) => m.id).sort(), ['P1', 'P2']);
  assert.equal(cal.instagram.find((m: any) => m.id === 'P2').type, 'REELS');
  assert.equal((await call('GET', `/api/calendar?from=0&to=${Date.now() + 365 * DAY}`)).status, 400, 'range is capped');
});

test('dragging a post reschedules it; past times and published posts are refused', async () => {
  const { json } = await call('POST', '/api/posts', { type: 'IMAGE', caption: 'Move me', media: img, scheduled_at: Date.now() + 2 * DAY });
  const target = Date.now() + 4 * DAY;
  assert.equal((await call('POST', `/api/posts/${json.id}/reschedule`, { scheduled_at: target })).status, 200);
  const moved = (await call('GET', '/api/posts')).json.find((p: any) => p.id === json.id);
  assert.equal(moved.scheduled_at, target);
  assert.equal((await call('POST', `/api/posts/${json.id}/reschedule`, { scheduled_at: Date.now() - DAY })).status, 400);
  assert.equal((await call('POST', '/api/posts/99999/reschedule', { scheduled_at: target })).status, 400);
});

test('conversation metrics: totals, daily series, first-reply time, heatmap and top automations', async () => {
  await call('POST', '/api/rules', { name: 'Hello rule', trigger_type: 'dm', match_mode: 'contains', keywords: ['hello'], reply_text: 'Hi there' });
  for (let i = 0; i < 3; i++) {
    await hook({ object: 'instagram', entry: [{ id: OWN, messaging: [{ sender: { id: `PERSON${i}` }, recipient: { id: OWN }, timestamp: Date.now(), message: { mid: `ins.${i}`, text: 'hello' } }] }] });
  }
  const m = await until(async () => { const r = (await call('GET', '/api/insights?days=7&tz=330')).json; return r.totals.autoReplies.value >= 3 ? r : null; }, 'three automated replies');
  assert.equal(m.days, 7);
  assert.equal(m.totals.received.value, 3);
  assert.equal(m.daily.dates.length, 7);
  assert.equal(m.daily.received.reduce((a: number, b: number) => a + b, 0), 3);
  assert.equal(m.daily.sent.at(-1), 3, "today's replies land on the last day");
  assert.equal(m.response.count, 3);
  assert.ok(m.response.median < 30_000, 'replied within seconds');
  assert.equal(m.heat.flat().reduce((a: number, b: number) => a + b, 0), 3);
  assert.deepEqual(m.automations[0], { name: 'Hello rule', kind: 'rule', n: 3 });
  assert.equal(m.delivery.sent, 3);
  assert.equal((await call('GET', '/api/insights?days=13')).json.days, 30, 'unknown periods fall back to 30 days');
});

test('Instagram metrics work without the insights permission and add reach once it is granted', async () => {
  const without = (await call('GET', '/api/insights/instagram?days=30')).json;
  assert.equal(without.connected, true);
  assert.equal(without.media.length, 2);
  assert.equal(without.media[0].like_count, 40);
  assert.equal(without.insights.available, false);
  assert.equal(without.insights.needsPermission, true);
  assert.ok(without.trackingSince, 'follower snapshots start being recorded');

  insightsAllowed = true;
  // Cached for 15 minutes; a different period is a different cache entry.
  const withIns = (await call('GET', '/api/insights/instagram?days=7')).json;
  assert.equal(withIns.insights.available, true);
  assert.deepEqual(withIns.insights.reach.map((r: any) => r.value), [120, 150]);
  assert.equal(withIns.insights.totals.views, 77);
  assert.equal(withIns.media[0].insights.reach, 500);
});
