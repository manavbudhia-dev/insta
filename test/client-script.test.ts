/** scripts/client.sh writes the right files for a new client (without touching Docker). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const script = path.resolve('scripts/client.sh');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-clients-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(script, path.join(dir, 'scripts/client.sh'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, '.env'), [
    'DOMAIN=insta.zealcoder.in', 'BASE_URL=https://insta.zealcoder.in', 'META_APP_ID=123', 'META_APP_SECRET=s3cret',
    'META_CONFIG_ID=CFG', 'WEBHOOK_VERIFY_TOKEN=vt', 'GRAPH_VERSION=v27.0', 'ADMIN_PASSWORD=main-pass-123', 'LINKEDIN_CLIENT_ID=li-id-1',
    'RESEND_API_KEY=re_test_123456789abcdef', 'EMAIL_FROM=Autopilot <noreply@zealcoder.in>', 'OWNER_EMAIL=me@zealcoder.in', 'GOOGLE_CLIENT_ID=gid',
  ].join('\n') + '\n');
  const run = (...args: string[]) => execFileSync('bash', [path.join(dir, 'scripts/client.sh'), ...args, '--no-start'], { cwd: dir, encoding: 'utf8' });
  return { dir, run };
}

test('client.sh add / list / password / remove', () => {
  const { dir, run } = setup();
  try {
    assert.throws(() => run('add', 'x1', 'ig', 'not-an-email'), /not an email/);
    const out = run('add', 'kalyanakuri', '@kalyanakuri.in', 'Owner@Gmail.com');
    assert.match(out, /Login\s+: owner@gmail\.com/);
    assert.match(out, /https:\/\/kalyanakuri\.zealcoder\.in/);
    const env = fs.readFileSync(path.join(dir, 'clients/kalyanakuri/.env'), 'utf8');
    assert.match(env, /^BASE_URL=https:\/\/kalyanakuri\.zealcoder\.in$/m);
    assert.match(env, /^IG_ACCOUNT_LOCK=kalyanakuri\.in$/m);
    assert.match(env, /^WEBHOOK_CALLBACK_URL=https:\/\/insta\.zealcoder\.in\/webhook$/m);
    assert.match(env, /^META_APP_SECRET=s3cret$/m);
    assert.doesNotMatch(env, /main-pass-123/, 'clients get their own password');
    const pw = /^ADMIN_PASSWORD=(.+)$/m.exec(env)![1];
    assert.equal(pw.length, 20);
    assert.match(out, new RegExp(pw));
    assert.equal(fs.statSync(path.join(dir, 'clients/kalyanakuri/.env')).mode & 0o077, 0, 'secrets file is private');

    const compose = fs.readFileSync(path.join(dir, 'docker-compose.clients.yml'), 'utf8');
    assert.match(compose, /client-kalyanakuri:\n    image: insta-app:latest/);
    assert.match(compose, /env_file: clients\/kalyanakuri\/\.env/);
    assert.match(compose, /client-kalyanakuri-data:/);
    assert.match(fs.readFileSync(path.join(dir, 'clients/shared/caddy/client-kalyanakuri.caddy'), 'utf8'), /^kalyanakuri\.zealcoder\.in \{[\s\S]*reverse_proxy client-kalyanakuri:3000/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'clients/shared/forward.json'), 'utf8')), ['http://client-kalyanakuri:3000']);

    // Control key for the Clients page, LinkedIn app copied, and the control API closed to the internet.
    const secret = /^CONTROL_SECRET=([A-Za-z0-9]{48})$/m.exec(env)![1];
    assert.match(env, /^LINKEDIN_CLIENT_ID=li-id-1$/m);
    assert.match(env, /^LOGIN_EMAILS=owner@gmail\.com$/m);
    assert.match(env, /^RESEND_API_KEY=re_test_123456789abcdef$/m);
    assert.match(env, /^EMAIL_FROM=Autopilot <noreply@zealcoder\.in>$/m);
    assert.match(env, /^OWNER_EMAIL=me@zealcoder\.in$/m);
    assert.match(env, /^GOOGLE_AUTH_VIA=https:\/\/insta\.zealcoder\.in$/m, 'clients sign in with Google through the main site');
    assert.doesNotMatch(env, /GOOGLE_CLIENT_ID/, 'the Google app itself stays on the main instance');
    assert.doesNotMatch(env, /LINKEDIN_CLIENT_SECRET|ANTHROPIC_API_KEY/, 'only keys that are set are copied');
    assert.match(fs.readFileSync(path.join(dir, 'clients/shared/caddy/client-kalyanakuri.caddy'), 'utf8'), /respond \/internal\/\* 404\n\treverse_proxy/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'clients/shared/clients.json'), 'utf8')), [
      { name: 'kalyanakuri', url: 'https://kalyanakuri.zealcoder.in', internal: 'http://client-kalyanakuri:3000', ig: 'kalyanakuri.in', secret },
    ]);

    run('add', 'bakery', 'sweetbakes');
    // A client made before the Clients page existed gets a control key on the next sync.
    const benv = path.join(dir, 'clients/bakery/.env');
    fs.writeFileSync(benv, fs.readFileSync(benv, 'utf8').replace(/^CONTROL_SECRET=.*\n/m, ''));
    run('sync');
    assert.match(fs.readFileSync(benv, 'utf8'), /^CONTROL_SECRET=[A-Za-z0-9]{48}$/m);
    // Changing the main .env and syncing updates every client; removing a key removes it there too.
    fs.writeFileSync(path.join(dir, '.env'), fs.readFileSync(path.join(dir, '.env'), 'utf8').replace('OWNER_EMAIL=me@zealcoder.in', 'OWNER_EMAIL=new@zealcoder.in').replace(/^GOOGLE_CLIENT_ID=.*\n/m, ''));
    run('sync');
    const synced = fs.readFileSync(benv, 'utf8');
    assert.match(synced, /^OWNER_EMAIL=new@zealcoder\.in$/m);
    assert.equal((synced.match(/^OWNER_EMAIL=/gm) || []).length, 1);
    assert.doesNotMatch(synced, /GOOGLE_AUTH_VIA/);
    assert.equal(fs.statSync(benv).mode & 0o077, 0, 'still private after sync');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'clients/shared/clients.json'), 'utf8')).length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'clients/shared/forward.json'), 'utf8')), ['http://client-bakery:3000', 'http://client-kalyanakuri:3000']);
    assert.match(run('list'), /bakery\s+https:\/\/bakery\.zealcoder\.in\s+@sweetbakes/);
    assert.equal(run('password', 'kalyanakuri').trim(), pw);

    assert.throws(() => run('add', 'kalyanakuri', 'x'), /already exists/);
    assert.throws(() => run('add', 'insta', 'x'), /reserved/);
    assert.throws(() => run('add', 'Bad_Name', 'x'), /name must be/);

    run('remove', 'kalyanakuri');
    assert.ok(!fs.existsSync(path.join(dir, 'clients/kalyanakuri')));
    assert.ok(!fs.existsSync(path.join(dir, 'clients/shared/caddy/client-kalyanakuri.caddy')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'clients/shared/forward.json'), 'utf8')), ['http://client-bakery:3000']);
    run('remove', 'bakery');
    assert.match(fs.readFileSync(path.join(dir, 'docker-compose.clients.yml'), 'utf8'), /services:\n  \{\}/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
