import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// ---- mock Graph API ----
let publishCalls = 0;
let publishWorks = false; // whether a destroyed first attempt really published
let published = false;
let commentList: any[] = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname.replace(/^\/v[\d.]+/, '');
    const send = (code: number, json: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (p === '/OWN/media' && req.method === 'POST') return send(200, { id: 'C1' });
    if (p === '/C1') return send(200, { status_code: published ? 'PUBLISHED' : 'FINISHED' });
    if (p === '/OWN/media_publish') {
      publishCalls++;
      if (publishCalls === 1) { published = publishWorks; return void req.socket.destroy(); } // timeout-like failure
      published = true;
      return send(200, { id: 'M5' });
    }
    if (p === '/OWN/media' && req.method === 'GET') {
      return send(200, { data: [{ id: 'MEDIA1', caption: 'x', media_type: 'IMAGE', comments_count: 1, timestamp: new Date().toISOString() }, ...(published ? [{ id: 'M99', caption: 'c', timestamp: new Date().toISOString() }] : [])] });
    }
    if (p === '/MEDIA1/comments') return send(200, { data: commentList });
    send(404, { error: { message: 'nope', code: 100 } });
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
after(() => mock.close());

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-gaps-'));
process.env.GRAPH_BASE = `http://127.0.0.1:${(mock.address() as any).port}`;
process.env.CONTAINER_POLL_MS = '10';
process.env.PUBLISH_RETRY_MS = '10';
process.env.COMMENT_RESCAN_MS = '0';
process.env.ADMIN_PASSWORD = 'correct-horse';
process.env.SESSION_SECRET = 'x'.repeat(32);

const { db, setSetting } = await import('../src/db.js');
const { publish } = await import('../src/scheduler.js');
const { pollOnce } = await import('../src/poller.js');
const { login, logout, isLoggedIn } = await import('../src/auth.js');
const { config } = await import('../src/config.js');
setSetting('ig_token', 'T'.repeat(30));
setSetting('ig_user_id', 'OWN');
setSetting('ig_username', 'me');

const post = { id: 1, type: 'IMAGE' as const, caption: 'c', media: JSON.stringify([{ url: 'https://x/a.jpg', kind: 'image' }]), scheduled_at: 0, status: 'publishing' };

test('publish timeout that actually published is recorded as published, not failed', async () => {
  publishCalls = 0; published = false; publishWorks = true;
  assert.equal(await publish(post), 'M99');
  assert.equal(publishCalls, 1); // not published twice
});

test('publish timeout that did not go through is retried safely', async () => {
  publishCalls = 0; published = false; publishWorks = false;
  assert.equal(await publish(post), 'M5');
  assert.equal(publishCalls, 2);
});

test('comment polling catches a new comment even when the comment count is unchanged', async () => {
  setSetting('connected_at', Date.now() - 5000);
  const at = () => new Date().toISOString();
  commentList = [{ id: 'c1', text: 'first', timestamp: at(), username: 'ann' }];
  await pollOnce();
  commentList = [{ id: 'c2', text: 'second', timestamp: at(), username: 'bob' }]; // one gone, one new: count still 1
  await pollOnce();
  const mids = (db.prepare("SELECT mid FROM messages WHERE kind = 'comment'").all() as { mid: string }[]).map((m) => m.mid);
  assert.deepEqual(mids.sort(), ['comment:c1', 'comment:c2']);
});

test('logout really ends a session, and changing the admin password ends all of them', () => {
  const res = () => { const r: any = { headers: {} as any, setHeader(k: string, v: string) { r.headers[k] = v; }, status() { return r; }, json() { return r; } }; return r; };
  const as = (cookie?: string) => ({ headers: { cookie }, body: {}, ip: '1.1.1.1', originalUrl: '/api/x' }) as any;
  const r = res();
  login({ body: { password: 'correct-horse' }, ip: '1.1.1.1' } as any, r);
  const cookie = String(r.headers['Set-Cookie']).split(';')[0];
  assert.equal(isLoggedIn(as(cookie)), true);
  logout(as(cookie), res());
  assert.equal(isLoggedIn(as(cookie)), false); // the old cookie is dead even though its signature is valid

  const r2 = res();
  login({ body: { password: 'correct-horse' }, ip: '1.1.1.1' } as any, r2);
  const c2 = String(r2.headers['Set-Cookie']).split(';')[0];
  assert.equal(isLoggedIn(as(c2)), true);
  config.adminPassword = 'a-new-password';
  assert.equal(isLoggedIn(as(c2)), false);
});
