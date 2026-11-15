/**
 * The LinkedIn post scheduler mounted inside the platform at /linkedin: one login for both, its own API and pages,
 * team members kept out of the Instagram side.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';

const PORT = 34811;
const APP = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-li-'));
let child: ChildProcess;
let owner = '';

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
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(PORT), BASE_URL: APP, DATA_DIR: dataDir, ADMIN_PASSWORD: 'correct-horse', SESSION_SECRET: 'y'.repeat(32) },
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

test('signing out from the LinkedIn section ends the dashboard session too', async () => {
  const out = await call('POST', '/linkedin/api/logout');
  assert.equal(out.json.owner, true);
  assert.equal((await call('GET', '/api/session')).json.loggedIn, false);
  assert.equal((await call('GET', '/linkedin/api/me')).status, 401);
});

test('the launcher at / and the two Instagram mini apps at /dm/ and /scheduler/', async () => {
  const home = await fetch(APP + '/');
  assert.equal(home.status, 200);
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
