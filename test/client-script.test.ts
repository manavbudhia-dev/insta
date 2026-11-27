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
    'META_CONFIG_ID=CFG', 'WEBHOOK_VERIFY_TOKEN=vt', 'GRAPH_VERSION=v27.0', 'ADMIN_PASSWORD=main-pass-123',
  ].join('\n') + '\n');
  const run = (...args: string[]) => execFileSync('bash', [path.join(dir, 'scripts/client.sh'), ...args, '--no-start'], { cwd: dir, encoding: 'utf8' });
  return { dir, run };
}

test('client.sh add / list / password / remove', () => {
  const { dir, run } = setup();
  try {
    const out = run('add', 'kalyanakuri', '@kalyanakuri.in');
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

    run('add', 'bakery', 'sweetbakes');
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
