#!/usr/bin/env node
/**
 * One-command helper. Uses only Node's built-in modules, so no `npm install` is needed.
 *
 *   node scripts/setup.mjs            Wizard: makes the secrets, saves them, prints exactly what to paste where.
 *   node scripts/setup.mjs check      Doctor: tests your deployed app and tells you what is still missing.
 *
 * Options:  --file <path>   where the secrets file lives (default: next to the project folder, NOT inside it,
 *                           so it can never be uploaded to GitHub by accident)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const command = args.find((a) => !a.startsWith('--') && a !== flag('file')) ?? 'setup';
const secretsFile = path.resolve(flag('file') ?? path.join(projectDir, '..', 'insta-automation-secrets.env'));

const hex = () => crypto.randomBytes(32).toString('hex');
const line = (c = '-') => console.log(c.repeat(64));

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const ORDER = [
  'BASE_URL', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'WEBHOOK_VERIFY_TOKEN',
  'META_APP_ID', 'META_APP_SECRET', 'META_CONFIG_ID', 'GRAPH_VERSION',
];

// ------------------------------------------------------------------ wizard

async function wizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, current) => {
    const hint = current ? ` [Enter = rakho: ${current.length > 28 ? current.slice(0, 25) + '...' : current}]` : ' [Enter = abhi skip]';
    const a = (await rl.question(`${q}${hint}\n> `)).trim();
    return a || current || '';
  };

  const env = readEnvFile(secretsFile);
  console.log('\n=== Insta Autopilot setup ===');
  console.log(fs.existsSync(secretsFile)
    ? `Purani settings mili (${secretsFile}). Jo pehle bhara tha wo waisa hi rahega.\n`
    : 'Pehli baar chal raha hai. Sab secrets main khud bana dunga.\n');

  // 1. public URL
  for (;;) {
    const u = (await ask('1) Nimbuz ka public URL (jaise https://insta-xxxx.nimbuz.app, aakhir mein / nahi)', env.BASE_URL)).replace(/\/+$/, '');
    if (!u) break;
    if (/^https:\/\/[^\s/]+/.test(u)) { env.BASE_URL = u; break; }
    console.log('   URL "https://" se shuru hona chahiye. Dobara likho.');
  }

  // 2. secrets
  env.SESSION_SECRET ||= hex();
  env.WEBHOOK_VERIFY_TOKEN ||= hex();
  let generatedPassword = false;
  if (!env.ADMIN_PASSWORD) {
    const p = (await rl.question('\n2) Dashboard ka password (kam se kam 8 characters). Enter dabao to main strong banaa dunga\n> ')).trim();
    if (p && p.length < 8) console.log('   Bahut chhota hai, main khud bana raha hoon.');
    env.ADMIN_PASSWORD = p.length >= 8 ? p : crypto.randomBytes(9).toString('base64url');
    generatedPassword = !(p.length >= 8);
  }

  // 3. Meta values (can be filled later by re-running)
  console.log('\n3) Meta ki values. Abhi nahi pata to Enter dabao, baad mein ye command dobara chalana.');
  env.META_APP_ID = await ask('   META_APP_ID (App settings -> Basic -> App ID)', env.META_APP_ID);
  env.META_APP_SECRET = await ask('   META_APP_SECRET (App settings -> Basic -> App secret)', env.META_APP_SECRET);
  env.META_CONFIG_ID = await ask('   META_CONFIG_ID (Unified login -> Configure your app -> config_id)', env.META_CONFIG_ID);
  env.GRAPH_VERSION ||= 'v26.0';
  rl.close();

  fs.writeFileSync(
    secretsFile,
    '# Private. Do NOT upload this file anywhere public.\n' + ORDER.filter((k) => env[k]).map((k) => `${k}=${env[k]}`).join('\n') + '\n',
    { mode: 0o600 },
  );

  const base = env.BASE_URL || 'https://YOUR-NIMBUZ-URL';
  console.log('\n');
  line('=');
  console.log('A) NIMBUZ -> Environment Variables mein ye daalo (copy-paste)');
  line('=');
  for (const k of ORDER) console.log(`${k}=${env[k] || ''}${env[k] ? '' : '      <-- abhi khaali, Meta se milega'}`);
  console.log('\nVolume: ek persistent volume banao, mount path:  /data');
  console.log('Variables badalne ke baad Nimbuz mein app Redeploy/Restart karo.');

  line('=');
  console.log('B) META dashboard mein ye URLs daalo');
  line('=');
  console.log(`Redirect URL (Unified login configuration):\n  ${base}/auth/instagram/callback`);
  console.log(`Privacy Policy URL (App settings -> Basic):\n  ${base}/privacy`);
  console.log(`Webhook Callback URL:\n  ${base}/webhook`);
  console.log(`Webhook Verify token:\n  ${env.WEBHOOK_VERIFY_TOKEN}`);
  console.log('Webhook fields: messages, messaging_postbacks, comments');

  line('=');
  if (generatedPassword) console.log(`DASHBOARD PASSWORD (note kar lo): ${env.ADMIN_PASSWORD}`);
  console.log(`Sab kuch yahan save hai:\n  ${secretsFile}`);
  console.log('Ye file project folder ke BAHAR hai, to galti se GitHub par nahi jayegi. Kisi ko mat dena.');
  line('=');
  console.log('\nAgla step: Nimbuz mein deploy hone ke baad ye chalao:\n  node scripts/setup.mjs check\n');
}

// ------------------------------------------------------------------ doctor

let problems = 0;
const ok = (msg) => console.log(`  [OK]  ${msg}`);
const fix = (msg, how) => { problems++; console.log(`  [FIX] ${msg}${how ? `\n        -> ${how}` : ''}`); };
const note = (msg) => console.log(`  [..]  ${msg}`);

async function http(url, opts = {}) {
  try {
    return await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...opts });
  } catch (e) {
    return { _error: e.cause?.code ?? e.message };
  }
}

async function check() {
  const env = readEnvFile(secretsFile);
  const base = (flag('url') ?? env.BASE_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    console.log('BASE_URL nahi mila. Pehle `node scripts/setup.mjs` chalao, ya --url https://... do.');
    process.exit(1);
  }
  console.log(`\nChecking ${base}\n`);

  // 1. server up?
  const h = await http(`${base}/healthz`);
  if (h._error) {
    fix(`Server tak pahunch nahi paya (${h._error})`, 'Nimbuz mein build/deploy pass hua? Status "Running" hona chahiye. View logs dekho.');
    return finish();
  }
  if (h.status === 200) ok('Server chal raha hai (/healthz)');
  else {
    fix(`Server ne ${h.status} diya`, 'Nimbuz logs dekho. Kabhi-kabhi URL galat hota hai, ya app crash ho raha hai.');
    return finish();
  }

  // 2. webhook handshake
  if (!env.WEBHOOK_VERIFY_TOKEN) {
    note('WEBHOOK_VERIFY_TOKEN local file mein nahi hai, webhook test skip');
  } else {
    const challenge = String(Math.floor(Math.random() * 1e9));
    const w = await http(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.WEBHOOK_VERIFY_TOKEN)}&hub.challenge=${challenge}`);
    if (w._error) fix(`Webhook URL nahi khula (${w._error})`);
    else if (w.status === 200 && (await w.text()) === challenge) ok('Webhook verify token sahi kaam kar raha hai');
    else fix(`Webhook verify fail (HTTP ${w.status})`, 'Nimbuz ke WEBHOOK_VERIFY_TOKEN ki value is file wali value se match karni chahiye, phir Redeploy.');
  }

  // 3. privacy page
  const p = await http(`${base}/privacy`);
  if (p.status === 200) ok('Privacy page khulta hai (Meta ko ye URL chahiye)');
  else fix(`/privacy ne ${p.status} diya`);

  // 4. log in and read the app's own checklist
  if (!env.ADMIN_PASSWORD) {
    note('ADMIN_PASSWORD file mein nahi hai, andar ka checklist skip');
    return finish();
  }
  const l = await http(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
  });
  if (l._error || l.status !== 200) {
    fix(`Dashboard login nahi hua (${l._error ?? l.status})`, 'Nimbuz ka ADMIN_PASSWORD aur is file ka ADMIN_PASSWORD same hona chahiye.');
    return finish();
  }
  ok('Dashboard login ho gaya');
  const cookie = (l.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const sres = await http(`${base}/api/status`, { headers: { Cookie: cookie } });
  if (sres._error || sres.status !== 200) {
    fix('Status nahi padh paya');
    return finish();
  }
  const s = await sres.json();
  const c = s.config;

  if (c.baseUrl === base) ok('Nimbuz ka BASE_URL sahi hai');
  else fix(`Nimbuz mein BASE_URL "${c.baseUrl}" hai, par asli URL "${base}" hai`, 'BASE_URL ko asli URL par set karo (bina / ke) aur Redeploy.');
  if (c.https) ok('HTTPS on hai');
  else fix('BASE_URL https:// se shuru nahi hota');
  if (c.appId && c.appSecret) ok('META_APP_ID aur META_APP_SECRET set hain');
  else fix('META_APP_ID / META_APP_SECRET Nimbuz mein nahi hain', 'Meta -> App settings -> Basic se copy karke Nimbuz mein daalo, Redeploy.');
  if (c.configId) ok('META_CONFIG_ID set hai');
  else fix('META_CONFIG_ID nahi hai', 'Meta -> Unified login -> Configure your app se config_id copy karo.');
  if (c.verifyToken) ok('Webhook verify token set hai');
  else fix('WEBHOOK_VERIFY_TOKEN Nimbuz mein nahi hai');

  const a = s.account;
  if (!a) {
    fix('Instagram account abhi connect nahi hai', `Browser mein ${base} kholo -> login -> "Connect Instagram account".`);
  } else {
    ok(`Instagram account connected: @${a.username}`);
    if (a.webhooksSubscribed) ok(`Webhooks subscribed: ${a.webhooksSubscribed}`);
    else fix('Account webhooks ke liye subscribe nahi hai', 'Dashboard -> Overview -> "Re-subscribe webhooks". Na chale to Meta dashboard mein webhook fields subscribe karo.');
    if (s.health.lastWebhookAt > 0) ok('Meta se webhook aa chuka hai');
    else note('Abhi tak koi webhook nahi aaya. Doosre account se apne account ko DM bhejo (Meta app Live mode mein honi chahiye).');
    if (s.health.lastPollError) fix(`Comment polling error: ${s.health.lastPollError}`);
  }
  finish();
}

function finish() {
  console.log(problems
    ? `\n${problems} cheez(en) theek karni baaki hain. Upar jahan [FIX] likha hai wahan se shuru karo, phir dobara chalao.\n`
    : '\nSab theek hai.\n');
  process.exit(problems ? 1 : 0);
}

if (command === 'check') await check();
else await wizard();
