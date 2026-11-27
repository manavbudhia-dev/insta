/**
 * Google sign-in (main instance, and client instances through it), email-link sign-in, and the Resend emails:
 * account test email, unlock requests, welcome email and problem alerts. Google and Resend are mocked.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';

const MAIN_PORT = 34851;
const CLIENT_PORT = 34852;
const MOCK_PORT = 34853;
const MAIN = `http://127.0.0.1:${MAIN_PORT}`;
const CLIENT = `http://127.0.0.1:${CLIENT_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SECRET = 'k'.repeat(48);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-login-'));
const clientData = fs.mkdtempSync(path.join(tmp, 'c-'));
const clientsFile = path.join(tmp, 'clients.json');
fs.writeFileSync(clientsFile, JSON.stringify([{ name: 'bakery', url: CLIENT, internal: CLIENT, ig: 'sweetbakes', secret: SECRET }]));

// ---- mock Google + Resend ----
const USERS: Record<string, { email: string; email_verified: boolean }> = {
  ownercode: { email: 'Owner@Zeal.in', email_verified: true },
  meeracode: { email: 'meera@bakery.in', email_verified: true },
  strangercode: { email: 'x@evil.com', email_verified: true },
  unverified: { email: 'owner@zeal.in', email_verified: false },
};
const emails: any[] = [];
const tokenCalls: any[] = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url!, MOCK);
    const send = (code: number, j: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (url.pathname === '/token') {
      const p = new URLSearchParams(raw);
      tokenCalls.push(Object.fromEntries(p));
      if (p.get('client_secret') !== 'gsecret' || !USERS[p.get('code')!]) return send(400, { error: 'invalid_grant' });
      return send(200, { access_token: `at-${p.get('code')}`, token_type: 'Bearer' });
    }
    if (url.pathname === '/userinfo') {
      const code = String(req.headers.authorization ?? '').replace('Bearer at-', '');
      return USERS[code] ? send(200, USERS[code]) : send(401, { error: 'invalid_token' });
    }
    if (url.pathname === '/emails' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer re_test_key_1234567890abc') return send(401, { message: 'API key is invalid' });
      emails.push(JSON.parse(raw));
      return send(200, { id: `em_${emails.length}` });
    }
    send(404, {});
  });
});

const procs: ChildProcess[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const common = {
  ADMIN_PASSWORD: 'correct-horse-battery', SESSION_SECRET: 'q'.repeat(32), META_APP_SECRET: 'm',
  GRAPH_BASE: 'http://127.0.0.1:1', RESEND_API_KEY: 're_test_key_1234567890abc', EMAIL_FROM: 'Autopilot <noreply@zealcoder.in>',
  RESEND_API_BASE: MOCK, OWNER_EMAIL: 'owner@zeal.in',
};
function boot(port: number, dataDir: string, extra: Record<string, string>) {
  procs.push(spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, ...common, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, DATA_DIR: dataDir, ...extra },
    stdio: ['ignore', 'ignore', 'inherit'],
  }));
}
async function up(base: string) {
  const end = Date.now() + 20000;
  while (!(await fetch(base + '/healthz').then((r) => r.ok).catch(() => false))) {
    if (Date.now() > end) throw new Error(`${base} did not start`);
    await wait(100);
  }
}

/** A tiny cookie jar: one per site, like a browser on two different domains. */
class Jar {
  c = new Map<string, string>();
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [kv, ...attrs] = line.split(';');
      const [k, ...v] = kv.split('=');
      if (attrs.some((a) => /max-age=0/i.test(a))) this.c.delete(k.trim());
      else this.c.set(k.trim(), v.join('='));
    }
  }
}
async function get(url: string, jar?: Jar) {
  const res = await fetch(url, { redirect: 'manual', headers: jar ? { Cookie: jar.header() } : {} });
  jar?.take(res);
  return { status: res.status, location: res.headers.get('location') ?? '', res };
}
async function api(base: string, jar: Jar, method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, { method, redirect: 'manual', headers: { Cookie: jar.header(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  jar.take(res);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const loggedIn = async (base: string, jar: Jar) => (await api(base, jar, 'GET', '/api/session')).json.loggedIn === true;
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await wait(50); }
}

const google = { GOOGLE_AUTH_URL: `${MOCK}/auth`, GOOGLE_TOKEN_URL: `${MOCK}/token`, GOOGLE_USERINFO_URL: `${MOCK}/userinfo` };
const ownerJar = new Jar();

before(async () => {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, r));
  boot(MAIN_PORT, fs.mkdtempSync(path.join(tmp, 'm-')), { ...google, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', CLIENTS_FILE: clientsFile });
  boot(CLIENT_PORT, clientData, {
    ...google, CONTROL_SECRET: SECRET, CLIENT_NAME: 'bakery', GOOGLE_AUTH_VIA: MAIN, LOGIN_EMAILS: 'meera@bakery.in',
    ALERT_TICK_MS: '300', ALERT_MIN_GAP_MS: '0',
  });
  await Promise.all([up(MAIN), up(CLIENT)]);
});
after(() => {
  for (const p of procs) p.kill();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the login card offers Google and the email link when they are set up', async () => {
  const s = await (await fetch(MAIN + '/api/session')).json();
  assert.deepEqual([s.loggedIn, s.google, s.emailLink], [false, true, true]);
  const c = await (await fetch(CLIENT + '/api/session')).json();
  assert.deepEqual([c.google, c.emailLink], [true, true]);
});

test('owner signs in with Google on the main instance; only listed, verified accounts, in the same browser', async () => {
  async function attempt(code: string, jar: Jar, keepCookie = true) {
    const start = await get(MAIN + '/auth/google', jar);
    assert.equal(start.status, 302);
    const u = new URL(start.location);
    assert.equal(u.origin + u.pathname, `${MOCK}/auth`);
    assert.equal(u.searchParams.get('redirect_uri'), `${MAIN}/auth/google/callback`);
    assert.equal(u.searchParams.get('scope'), 'openid email');
    const cb = await get(`${MAIN}/auth/google/callback?code=${code}&state=${encodeURIComponent(u.searchParams.get('state')!)}`, keepCookie ? jar : new Jar());
    return cb;
  }
  const stranger = await attempt('strangercode', new Jar());
  assert.match(decodeURIComponent(stranger.location), /login_error=x@evil\.com is not allowed/);
  const unverified = await attempt('unverified', new Jar());
  assert.match(decodeURIComponent(unverified.location), /no verified email/);
  const otherBrowser = await attempt('ownercode', new Jar(), false);
  assert.match(decodeURIComponent(otherBrowser.location), /could not be verified/);
  const forged = await get(`${MAIN}/auth/google/callback?code=ownercode&state=abc.def`, ownerJar);
  assert.match(decodeURIComponent(forged.location), /expired/);

  const ok = await attempt('ownercode', ownerJar);
  assert.equal(ok.location, '/');
  assert.ok(await loggedIn(MAIN, ownerJar), 'OWNER_EMAIL seeds the login list; case does not matter');
  assert.equal(tokenCalls.at(-1).redirect_uri, `${MAIN}/auth/google/callback`);
});

test('a client signs in with Google through the main instance, with the client\'s own login list', async () => {
  async function flow(code: string, jar: Jar) {
    const s1 = await get(CLIENT + '/auth/google', jar);
    const hop = new URL(s1.location);
    assert.equal(hop.origin + hop.pathname, `${MAIN}/auth/google`);
    assert.equal(hop.searchParams.get('client'), 'bakery');
    const s2 = await get(s1.location); // the main instance; no cookies needed there
    const state = new URL(s2.location).searchParams.get('state')!;
    const s3 = await get(`${MAIN}/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`);
    return s3;
  }
  const jar = new Jar();
  const back = await flow('meeracode', jar);
  assert.ok(back.location.startsWith(`${CLIENT}/auth/google/finish?a=`));
  // Another browser cannot use it, and it works only once.
  assert.match(decodeURIComponent((await get(back.location, new Jar())).location), /could not be verified/);
  const done = await get(back.location, jar);
  assert.equal(done.location, '/');
  assert.ok(await loggedIn(CLIENT, jar));
  assert.match(decodeURIComponent((await get(back.location, jar)).location), /could not be verified/);

  // The owner's Google account is not on this client's list.
  const j2 = new Jar();
  const ownerAtClient = await get((await flow('ownercode', j2)).location, j2);
  assert.match(decodeURIComponent(ownerAtClient.location), /owner@zeal\.in is not allowed to sign in here/);
  assert.equal(await loggedIn(CLIENT, j2), false);
  // An unknown client name is refused by the main instance.
  assert.equal((await get(`${MAIN}/auth/google?client=nope&cs=${'a'.repeat(24)}`)).status, 400);
});

test('email link: same answer for everyone, one-time link only for listed addresses, opened via a confirm button', async () => {
  const before = emails.length;
  const jar = new Jar();
  const r1 = await api(CLIENT, jar, 'POST', '/api/login/email', { email: 'nobody@else.com' });
  assert.equal(r1.status, 200);
  const r2 = await api(CLIENT, jar, 'POST', '/api/login/email', { email: 'Meera@Bakery.in' });
  assert.deepEqual(r2.json, r1.json);
  await until(() => emails.length === before + 1);
  await wait(200);
  assert.equal(emails.length, before + 1, 'no email for an address not on the list');
  const mail = emails.at(-1);
  assert.deepEqual(mail.to, ['meera@bakery.in']);
  assert.equal(mail.from, 'Autopilot <noreply@zealcoder.in>');
  const link = /(http:\/\/127\.0\.0\.1:34852\/auth\/email\?t=[^\s"<]+)/.exec(mail.text)![1];

  const page = await get(link, jar);
  assert.equal(page.status, 200);
  assert.equal(await loggedIn(CLIENT, jar), false, 'opening the link alone does not sign in (mail scanners)');
  const html = await page.res.text();
  const t = /name="t" value="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&');
  const post = async (j: Jar) => {
    const res = await fetch(CLIENT + '/auth/email', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: j.header() }, body: new URLSearchParams({ t }) });
    j.take(res);
    return res.headers.get('location') ?? '';
  };
  assert.equal(await post(jar), '/');
  assert.ok(await loggedIn(CLIENT, jar));
  assert.match(decodeURIComponent(await post(new Jar())), /already used/);
  assert.equal((await api(CLIENT, new Jar(), 'POST', '/api/login/email', { email: 'bad' })).status, 400);
});

test('account: login list and test email; the password still works', async () => {
  const pw = new Jar();
  assert.equal((await api(MAIN, pw, 'POST', '/api/login', { password: 'correct-horse-battery' })).status, 200);
  assert.ok(await loggedIn(MAIN, pw));
  const a = await api(MAIN, ownerJar, 'GET', '/api/account');
  assert.deepEqual(a.json.emails, ['owner@zeal.in']);
  assert.equal(a.json.alerts, true);
  assert.equal((await api(MAIN, ownerJar, 'PUT', '/api/account', { emails: 'owner@zeal.in, not-an-email' })).status, 400);
  const saved = await api(MAIN, ownerJar, 'PUT', '/api/account', { emails: 'owner@zeal.in, ops@zeal.in', summary: true });
  assert.deepEqual(saved.json.emails, ['owner@zeal.in', 'ops@zeal.in']);
  assert.equal(saved.json.summary, true);
  const before = emails.length;
  assert.equal((await api(MAIN, ownerJar, 'POST', '/api/account/test-email')).status, 200);
  assert.deepEqual(emails.at(-1).to, ['owner@zeal.in', 'ops@zeal.in']);
  assert.equal(emails.length, before + 1);
  assert.equal((await api(MAIN, new Jar(), 'GET', '/api/account')).status, 401);
});

test('unlock request from a client emails the owner and shows on the Clients page; switching it on clears it', async () => {
  const cj = new Jar();
  await api(CLIENT, cj, 'POST', '/api/login', { password: 'correct-horse-battery' });
  await api(MAIN, ownerJar, 'PUT', '/api/clients/bakery', { apps: { whatsapp: false } });
  const before = emails.length;
  const r = await api(CLIENT, cj, 'POST', '/api/apps/unlock-request', { app: 'whatsapp' });
  assert.deepEqual(r.json, { ok: true, emailed: true });
  const mail = emails.at(-1);
  assert.equal(emails.length, before + 1);
  assert.deepEqual(mail.to, ['owner@zeal.in']);
  assert.equal(mail.reply_to, 'meera@bakery.in');
  assert.match(mail.subject, /bakery wants WhatsApp Automation/);
  assert.match(mail.html, new RegExp(`${MAIN}/clients`));
  // Asking again the same day does not email again.
  assert.equal((await api(CLIENT, cj, 'POST', '/api/apps/unlock-request', { app: 'whatsapp' })).json.emailed, false);

  const list = (await api(MAIN, ownerJar, 'GET', '/api/clients/')).json;
  assert.ok(list.clients[0].unlockRequests.whatsapp > 0);
  assert.equal(list.emailReady, true);
  const on = await api(MAIN, ownerJar, 'PUT', '/api/clients/bakery', { apps: { whatsapp: true } });
  assert.deepEqual(on.json.unlockRequests, {});
});

test('owner sets the client\'s login emails and sends a welcome email', async () => {
  const r = await api(MAIN, ownerJar, 'PUT', '/api/clients/bakery', { loginEmails: 'meera@bakery.in, Staff@Bakery.in, junk' });
  assert.deepEqual(r.json.loginEmails, ['meera@bakery.in', 'staff@bakery.in']);
  const before = emails.length;
  const w = await api(MAIN, ownerJar, 'POST', '/api/clients/bakery/welcome');
  assert.equal(w.status, 200);
  const mail = emails.at(-1);
  assert.equal(emails.length, before + 1);
  assert.deepEqual(mail.to, ['meera@bakery.in', 'staff@bakery.in']);
  assert.equal(mail.reply_to, 'owner@zeal.in');
  assert.match(mail.html, new RegExp(CLIENT));
  assert.match(mail.text, /Sign in with Google/);
  assert.doesNotMatch(mail.text + mail.html, /correct-horse-battery/, 'no password by email');
});

test('problem alerts reach the login list, batched into one email', async () => {
  const db = new Database(path.join(clientData, 'app.db'));
  const now = Date.now();
  db.prepare("INSERT INTO logs (level, message, created_at) VALUES ('error', 'Scheduled post #7 failed: media expired', ?), ('info', 'all fine', ?), ('error', 'WhatsApp: The access token was rejected', ?)").run(now, now, now);
  db.close();
  await until(() => emails.some((m) => /2 problems need attention/.test(m.subject)), 8000);
  const mail = emails.find((m) => /2 problems need attention/.test(m.subject));
  assert.deepEqual(mail.to, ['meera@bakery.in', 'staff@bakery.in']);
  assert.match(mail.text, /Scheduled post #7 failed/);
  assert.doesNotMatch(mail.text, /all fine/);
  const count = emails.length;
  await wait(1200);
  assert.equal(emails.filter((m) => /need attention/.test(m.subject)).length, 1, 'the same problems are not emailed twice');
  assert.ok(emails.length >= count);
});
