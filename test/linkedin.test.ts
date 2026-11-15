/**
 * The LinkedIn post scheduler mounted inside the platform at /linkedin: one login for both, its own API and pages,
 * team members kept out of the Instagram side.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';

const PORT = 34811;
const APP = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-li-'));
let child: ChildProcess;
let owner = '';

// Stands in for the Anthropic API: records each request and answers with the next scripted reply.
const AI_PORT = 34812;
const aiCalls: { headers: http.IncomingHttpHeaders; body: any }[] = [];
let aiReply: (body: any) => { stop_reason: string; posts?: string[] } = () => ({ stop_reason: 'end_turn', posts: [] });
const ai = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    aiCalls.push({ headers: req.headers, body });
    const r = aiReply(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: r.stop_reason, stop_sequence: null,
      content: r.posts ? [{ type: 'text', text: JSON.stringify({ posts: r.posts.map((text) => ({ text })) }) }] : [],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
  });
});

async function call(method: string, p: string, body?: unknown, cookie = owner, headers: Record<string, string> = {}) {
  const res = await fetch(APP + p, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.clone().json().catch(() => ({})), res };
}

before(async () => {
  await new Promise<void>((r) => ai.listen(AI_PORT, r));
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env, PORT: String(PORT), BASE_URL: APP, DATA_DIR: dataDir, ADMIN_PASSWORD: 'correct-horse', SESSION_SECRET: 'y'.repeat(32),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${AI_PORT}`, ANTHROPIC_API_KEY: 'sk-test-key',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const end = Date.now() + 20000;
  while (!(await fetch(APP + '/healthz').then((r) => r.ok).catch(() => false))) {
    if (Date.now() > end) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(() => {
  child?.kill();
  ai.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('LinkedIn API needs a login; the dashboard login signs you in there as admin', async () => {
  assert.equal((await call('GET', '/linkedin/api/me', undefined, '')).status, 401);
  const r = await call('POST', '/api/login', { password: 'correct-horse' }, '');
  owner = r.res.headers.get('set-cookie')!.split(';')[0];
  const me = await call('GET', '/linkedin/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.role, 'admin');
  assert.equal(me.json.owner, true);
  assert.equal((await call('GET', '/linkedin/api/setup')).json.needed, false);
});

test('pages are served under /linkedin with their own CSP; the Instagram dashboard keeps the strict one', async () => {
  for (const p of ['/linkedin/', '/linkedin/queue.html', '/linkedin/accounts.html', '/linkedin/classic.html']) {
    const r = await fetch(APP + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /\/linkedin\/api\//, p);
    assert.match(r.headers.get('content-security-policy')!, /script-src 'self' 'unsafe-inline'/);
  }
  const home = await fetch(APP + '/');
  assert.match(await home.text(), /src="\/home.js"/);
  assert.match(home.headers.get('content-security-policy')!, /script-src 'self';/);
  assert.equal((await call('GET', '/linkedin/api/posts')).res.headers.get('cache-control'), 'no-store');
});

test('settings show the prefixed redirect URL; the OAuth callback rejects a bad state without a session', async () => {
  const s = await call('GET', '/linkedin/api/settings');
  assert.equal(s.json.redirectUrl, `${APP}/linkedin/auth/linkedin/callback`);
  const cb = await call('GET', '/linkedin/auth/linkedin/callback?state=forged&code=x', undefined, '');
  assert.equal(cb.status, 400);
});

test('media upload, drafts and scheduled posts work through the mounted API', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const up = await fetch(APP + '/linkedin/api/media', { method: 'POST', headers: { Cookie: owner, 'Content-Type': 'image/png', 'X-Filename': 'a.png' }, body: png });
  assert.equal(up.status, 200);
  const media = await up.json();
  assert.equal(media.kind, 'image');

  // Connecting a real profile needs LinkedIn's OAuth, so put a connected account straight into the database.
  const db = new Database(path.join(dataDir, 'linkedin', 'autopilot.db'));
  const acc = db.prepare("insert into accounts(name,kind,urn,expires_at) values('Test User','member','urn:li:person:T1',?)").run(Date.now() + 864e5).lastInsertRowid;
  db.close();

  const draft = await call('POST', '/linkedin/api/posts', { draft: true, accountId: acc, text: 'Draft post', type: 'image', media: [{ id: media.id }] });
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  assert.equal(draft.json.status, 'draft');
  const sched = await call('POST', '/linkedin/api/posts', { accountId: acc, text: 'Hello LinkedIn', whenAt: Date.now() + 3600e3 });
  assert.equal(sched.json.status, 'scheduled');
  const list = await call('GET', '/linkedin/api/posts');
  assert.deepEqual(list.json.map((p: any) => p.text).sort(), ['Draft post', 'Hello LinkedIn']);

  // The shared content calendar gets scheduled posts in the asked range, never drafts.
  const cal = await call('GET', `/linkedin/api/calendar?from=${Date.now()}&to=${Date.now() + 86400e3}`);
  assert.deepEqual(cal.json.map((p: any) => p.text), ['Hello LinkedIn']);
  assert.equal(cal.json[0].account_name, 'Test User');
  assert.equal((await call('GET', `/linkedin/api/calendar?from=${Date.now() + 2 * 86400e3}&to=${Date.now() + 3 * 86400e3}`)).json.length, 0);
});

test('cross-site writes to the LinkedIn API are refused; the inbound webhook still needs its token', async () => {
  const x = await call('POST', '/linkedin/api/posts', { draft: true }, owner, { Origin: 'https://evil.example' });
  assert.equal(x.status, 403);
  assert.equal((await call('POST', '/linkedin/api/inbound', { text: 'hi' }, '')).status, 401);
});

test('an invited team member signs in to LinkedIn only, not to the Instagram dashboard', async () => {
  const inv = await call('POST', '/linkedin/api/users', { email: 'ed@example.com', role: 'editor' });
  assert.ok(inv.json.tempPassword);
  const login = await call('POST', '/linkedin/api/login', { email: 'ed@example.com', password: inv.json.tempPassword }, '');
  assert.equal(login.status, 200);
  const ed = login.res.headers.get('set-cookie')!.split(';')[0];
  assert.match(login.res.headers.get('set-cookie')!, /Path=\/linkedin/);
  const me = await call('GET', '/linkedin/api/me', undefined, ed);
  assert.equal(me.json.role, 'editor');
  assert.equal(me.json.owner, false);
  assert.equal((await call('GET', '/linkedin/api/settings', undefined, ed)).status, 403);
  assert.equal((await call('GET', '/api/status', undefined, ed)).status, 401);
});

test('AI studio: writes a post from an idea with structured output, then schedules it in the next free slot', async () => {
  const acc = (await call('GET', '/linkedin/api/accounts')).json[0];
  const cfg = { accountId: acc.id, topics: 'Building software products', days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00', '18:00'], tz: 'UTC', mode: 'approve', horizonDays: 7, maxPerDay: 2 };
  const saved = await call('PUT', '/linkedin/api/auto', { config: cfg });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  aiReply = () => ({ stop_reason: 'end_turn', posts: ['Shipping a side project in thirty days taught me focus beats features every single time.'] });
  const c = await call('POST', '/linkedin/api/auto/compose', { idea: 'lessons from shipping fast', count: 1 });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.posts.length, 1);
  assert.ok(c.json.nextSlot > Date.now());

  const req = aiCalls.at(-1)!;
  assert.equal(req.body.model, 'claude-sonnet-5-5');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.deepEqual(req.body.output_config.format.schema.required, ['posts']);
  assert.equal(req.body.fallbacks, 'default');
  assert.match(String(req.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  // The SDK sends the key as x-api-key or, with newer API versions, as a bearer token.
  assert.equal(req.headers['x-api-key'] ?? String(req.headers.authorization).replace(/^Bearer /, ''), 'sk-test-key');
  assert.match(req.body.messages[0].content, /lessons from shipping fast/);

  const add = await call('POST', '/linkedin/api/auto/add', { text: c.json.posts[0], status: 'scheduled' });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.equal(add.json.posts[0].status, 'scheduled');
  assert.equal(add.json.posts[0].when_at, c.json.nextSlot);
  const cal = await call('GET', `/linkedin/api/calendar?from=${Date.now()}&to=${Date.now() + 8 * 86400e3}`);
  assert.ok(cal.json.some((p: any) => p.text.startsWith('Shipping a side project') && p.status === 'scheduled'));
});

test('AI studio: planning fills empty slots as drafts on the calendar; approving schedules them', async () => {
  // Clearly different texts, so the duplicate filter keeps all of them.
  const ideas = ['Hiring slowly protects company culture', 'Pricing pages deserve weekly experiments', 'Onboarding emails should teach one habit',
    'Retention curves reveal product truth', 'Roadmaps belong to customers, not executives', 'Feedback loops shorten with daily demos',
    'Testing in production needs feature flags', 'Documentation reduces support tickets dramatically', 'Support conversations inspire marketing copy',
    'Launches work better as quiet betas', 'Metrics dashboards hide qualitative signals', 'Design reviews catch costly mistakes early',
    'Remote teams need written decisions', 'Saying no keeps startups alive'];
  aiReply = (body) => {
    const n = Number(/Write (\d+) new post/.exec(body.messages[0].content)?.[1] || 1);
    return { stop_reason: 'end_turn', posts: ideas.slice(0, n) };
  };
  const plan = await call('POST', '/linkedin/api/auto/plan', { brief: 'Product launch week', days: 7 });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.ok(plan.json.created >= 5, `created ${plan.json.created}`);
  assert.ok(plan.json.posts.every((p: any) => p.status === 'draft'));
  assert.match(aiCalls.at(-1)!.body.messages[0].content, /Product launch week/);

  // AI drafts sit in real slots, so the calendar shows them (as needing approval).
  const cal = await call('GET', `/linkedin/api/calendar?from=${Date.now()}&to=${Date.now() + 8 * 86400e3}`);
  assert.equal(cal.json.filter((p: any) => p.status === 'draft' && p.ai === 1).length, plan.json.created);

  const ok = await call('POST', '/linkedin/api/auto/approve-all');
  assert.equal(ok.json.approved, plan.json.created);
  const after = await call('GET', `/linkedin/api/calendar?from=${Date.now()}&to=${Date.now() + 8 * 86400e3}`);
  assert.equal(after.json.filter((p: any) => p.status === 'draft').length, 0);
});

test('AI studio: a refusal or a missing idea comes back as a clear error', async () => {
  aiReply = () => ({ stop_reason: 'refusal' });
  const r = await call('POST', '/linkedin/api/auto/compose', { idea: 'something' });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /declined/);
  assert.equal((await call('POST', '/linkedin/api/auto/compose', { idea: '   ' })).status, 400);
});

test('signing out from the LinkedIn section ends the dashboard session too', async () => {
  const out = await call('POST', '/linkedin/api/logout');
  assert.equal(out.json.owner, true);
  assert.equal((await call('GET', '/api/session')).json.loggedIn, false);
  assert.equal((await call('GET', '/linkedin/api/me')).status, 401);
});

test('the launcher at / and the two Instagram mini apps at /dm/ and /scheduler/', async () => {
  const home = await fetch(APP + '/');
  assert.equal(home.status, 200);
  const homeHtml = await home.clone().text();
  assert.match(homeHtml, /src="\/calendar.js"/); // the shared content calendar lives on the home page
  assert.match(homeHtml, /href="\/calendar.css"/);
  assert.match(home.headers.get('content-security-policy')!, /script-src 'self';/);
  for (const p of ['/dm/', '/scheduler/', '/dm', '/scheduler']) {
    const r = await fetch(APP + p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /src="\/app.js"/, p);
    assert.match(html, /href="\/" class="nav-home"/, p);
  }
  // The Instagram OAuth callback returns to the DM app.
  const cb = await fetch(APP + '/auth/instagram/callback?error=access_denied', { redirect: 'manual' });
  assert.match(cb.headers.get('location')!, /^\/dm\/\?error=/);
});
