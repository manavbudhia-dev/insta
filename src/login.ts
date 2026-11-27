/**
 * Sign-in without the password: Google, or a one-time link by email (Resend). Both only let in the addresses on this
 * instance's login list; the password keeps working as a backup.
 *
 * Google: the OAuth app (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) lives on the main instance, with one redirect URI
 * (<main>/auth/google/callback). A client instance (GOOGLE_AUTH_VIA=<main url>) sends the browser to the main
 * instance, which talks to Google and sends back a short-lived assertion signed with that client's CONTROL_SECRET.
 * So adding a client never means editing the Google Cloud console.
 */
import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { managed } from './apps.js';
import { startSession } from './auth.js';
import { clients } from './clients.js';
import { config } from './config.js';
import { firstTime, getSetting, log, redact, setSetting } from './db.js';
import { emailReady, esc, layout, sendEmail } from './email.js';
import { signPayload, verifyPayload } from './signed.js';

const env = (k: string) => (process.env[k] ?? '').trim();
const isEmail = (s: string) => /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,190}\.[a-z]{2,}$/i.test(s);

// ---------- login list ----------

/** Addresses allowed to sign in here (also who gets alerts). Seeded once from LOGIN_EMAILS / OWNER_EMAIL. */
export function loginEmails(): string[] {
  let v = getSetting('login_emails', '');
  if (!v && !getSetting('login_emails_seeded')) {
    const seed = parseEmails(`${env('LOGIN_EMAILS')},${managed() ? '' : env('OWNER_EMAIL')}`);
    setSetting('login_emails', seed.join(','));
    setSetting('login_emails_seeded', 1);
    v = seed.join(',');
  }
  return v ? v.split(',').filter(Boolean) : [];
}
export function parseEmails(raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/)).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  return [...new Set(list.filter(isEmail))].slice(0, 20);
}
export function setLoginEmails(list: string[]): void {
  setSetting('login_emails', parseEmails(list).join(','));
  setSetting('login_emails_seeded', 1);
}
const allowed = (email: string) => loginEmails().includes(email.toLowerCase());

// ---------- Google ----------

const googleSelf = () => !managed() && !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
const googleVia = () => (managed() ? env('GOOGLE_AUTH_VIA').replace(/\/+$/, '') : '');
export const googleReady = () => googleSelf() || (!!googleVia() && !!env('CLIENT_NAME'));
const G = {
  auth: () => env('GOOGLE_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: () => env('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token',
  userinfo: () => env('GOOGLE_USERINFO_URL') || 'https://openidconnect.googleapis.com/v1/userinfo',
};
const isHttps = () => config.baseUrl.startsWith('https://');
const STATE_COOKIE = 'g_state';

function readCookie(req: Request, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}
function setStateCookie(res: Response, value: string): void {
  // Lax: Google's (and the main instance's) redirect back is a top-level GET from another site.
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${isHttps() ? '; Secure' : ''}`);
}
const clearStateCookie = `${STATE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${isHttps() ? '; Secure' : ''}`;
const fail = (res: Response, msg: string) => res.redirect(`/?login_error=${encodeURIComponent(msg)}`);

function finishLogin(res: Response, email: string, how: string): void {
  res.setHeader('Set-Cookie', clearStateCookie);
  startSession(res);
  log('info', `Signed in with ${how} as ${email}`);
  res.redirect('/');
}

async function googleUser(code: string): Promise<{ email: string; verified: boolean }> {
  const tokenRes = await fetch(G.token(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: `${config.baseUrl}/auth/google/callback`, grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tok: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.access_token) throw new Error(tok.error_description || tok.error || `Google answered HTTP ${tokenRes.status}`);
  const infoRes = await fetch(G.userinfo(), { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(15_000) });
  const info: any = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || !info.email) throw new Error('Google did not share the email address');
  return { email: String(info.email).toLowerCase(), verified: info.email_verified === true || info.email_verified === 'true' };
}

export const loginRouter = express.Router();

/** Starts Google sign-in. On the main instance `?client=&cs=` means "for that client instance". */
loginRouter.get('/auth/google', (req, res) => {
  if (googleVia()) {
    // Client instance: remember a nonce in this browser, then let the main instance do the Google part.
    const nonce = crypto.randomBytes(18).toString('base64url');
    setStateCookie(res, nonce);
    return res.redirect(`${googleVia()}/auth/google?client=${encodeURIComponent(env('CLIENT_NAME'))}&cs=${nonce}`);
  }
  if (!googleSelf()) return fail(res, 'Google sign-in is not set up on this server');
  let state: string;
  const clientName = String(req.query.client ?? '');
  if (clientName) {
    const c = clients().find((x) => x.name === clientName);
    const cs = String(req.query.cs ?? '');
    if (!c || !/^[\w-]{16,64}$/.test(cs)) return res.status(400).type('text/plain').send('Unknown client');
    state = signPayload({ c: c.name, cs }, config.sessionSecret, 10 * 60_000);
  } else {
    const nonce = crypto.randomBytes(18).toString('base64url');
    setStateCookie(res, nonce);
    state = signPayload({ s: nonce }, config.sessionSecret, 10 * 60_000);
  }
  const url = new URL(G.auth());
  url.search = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: `${config.baseUrl}/auth/google/callback`, response_type: 'code',
    scope: 'openid email', state, prompt: 'select_account',
  }).toString();
  res.redirect(url.toString());
});

loginRouter.get('/auth/google/callback', async (req, res) => {
  if (!googleSelf()) return fail(res, 'Google sign-in is not set up on this server');
  const st = verifyPayload<{ s?: string; c?: string; cs?: string }>(String(req.query.state ?? ''), config.sessionSecret);
  const client = st?.c ? clients().find((x) => x.name === st.c) : undefined;
  const back = (msg: string) => (client ? res.redirect(`${client.url}/?login_error=${encodeURIComponent(msg)}`) : fail(res, msg));
  if (!st) return fail(res, 'The sign-in link expired. Please try again.');
  if (req.query.error) return back(req.query.error === 'access_denied' ? 'Google sign-in was cancelled' : String(req.query.error));
  if (st.c && !client) return fail(res, 'Unknown client');
  if (!st.c && (!st.s || readCookie(req, STATE_COOKIE) !== st.s)) return fail(res, 'Sign-in could not be verified. Please try again in the same browser.');
  let user: { email: string; verified: boolean };
  try {
    user = await googleUser(String(req.query.code ?? ''));
  } catch (e) {
    log('warn', `Google sign-in failed: ${redact((e as Error).message)}`);
    return back('Google sign-in failed. Please try again.');
  }
  if (!user.verified) return back('That Google account has no verified email address');
  if (client) {
    // The client instance checks its own login list; this only vouches for who the person is, for two minutes.
    const a = signPayload({ email: user.email, c: client.name, cs: st.cs, n: crypto.randomBytes(9).toString('base64url') }, client.secret, 2 * 60_000);
    return res.redirect(`${client.url}/auth/google/finish?a=${encodeURIComponent(a)}`);
  }
  if (!allowed(user.email)) {
    log('warn', `Google sign-in refused for ${user.email} (not on the login list)`);
    return fail(res, `${user.email} is not allowed to sign in here`);
  }
  finishLogin(res, user.email, 'Google');
});

/** Client instance: the main instance vouched for the Google account; check it belongs to this browser and this list. */
loginRouter.get('/auth/google/finish', (req, res) => {
  if (!googleVia()) return fail(res, 'Google sign-in is not set up on this server');
  const a = verifyPayload<{ email: string; c: string; cs: string; n: string }>(String(req.query.a ?? ''), env('CONTROL_SECRET'));
  if (!a || a.c !== env('CLIENT_NAME') || !a.cs || readCookie(req, STATE_COOKIE) !== a.cs || !firstTime(`g-assert:${a.n}`)) {
    return fail(res, 'Sign-in could not be verified. Please try again in the same browser.');
  }
  if (!allowed(a.email)) {
    log('warn', `Google sign-in refused for ${a.email} (not on the login list)`);
    return fail(res, `${a.email} is not allowed to sign in here. Ask your account manager to add it.`);
  }
  finishLogin(res, a.email, 'Google');
});

// ---------- email link ----------

const linkAttempts = new Map<string, { n: number; reset: number }>();
function rateLimited(key: string, max: number): boolean {
  const now = Date.now();
  const a = linkAttempts.get(key);
  if (!a || a.reset < now) {
    linkAttempts.set(key, { n: 1, reset: now + 15 * 60_000 });
    if (linkAttempts.size > 5000) for (const [k, v] of linkAttempts) if (v.reset < now) linkAttempts.delete(k);
    return false;
  }
  a.n++;
  return a.n > max;
}

/** Always answers the same way, so the form never reveals which addresses can sign in. */
loginRouter.post('/api/login/email', express.json({ limit: '4kb' }), async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const answer = { ok: true, message: 'If that address can sign in here, a sign-in link is on its way. It works for 15 minutes.' };
  if (!emailReady()) return void res.status(400).json({ error: 'Email sign-in is not set up on this server' });
  if (!isEmail(email)) return void res.status(400).json({ error: 'Enter a valid email address' });
  if (rateLimited(`ip:${req.ip}`, 10) || rateLimited(`em:${email}`, 3)) return void res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
  res.json(answer);
  if (!allowed(email)) return;
  const t = signPayload({ email, n: crypto.randomBytes(12).toString('base64url') }, config.sessionSecret, 15 * 60_000);
  const url = `${config.baseUrl}/auth/email?t=${encodeURIComponent(t)}`;
  await sendEmail({
    to: email,
    subject: 'Your Autopilot sign-in link',
    text: `Sign in to ${config.baseUrl}:\n${url}\n\nThe link works once, for 15 minutes. If you did not ask for it, ignore this email.`,
    html: layout({
      title: 'Sign in to Autopilot', button: { label: 'Sign in', url },
      rows: [`Click the button to sign in to <b>${esc(config.baseUrl.replace(/^https?:\/\//, ''))}</b>.`, 'The link works once, for 15 minutes. If you did not ask for it, you can ignore this email.'],
    }),
  });
});

/**
 * Opening the link shows a button rather than signing in straight away: mail scanners that open links ahead of the
 * person must not use up the one-time token.
 */
loginRouter.get('/auth/email', (req, res) => {
  const t = String(req.query.t ?? '');
  const p = verifyPayload<{ email: string }>(t, config.sessionSecret);
  if (!p) return fail(res, 'That sign-in link has expired. Ask for a new one.');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sign in · Autopilot</title><link rel="stylesheet" href="/home.css"></head>
<body><main class="login"><form class="panel login-card" method="post" action="/auth/email"><div class="brand">⚡ Autopilot</div>
<p class="muted">Sign in as <b>${esc(p.email)}</b>?</p><input type="hidden" name="t" value="${esc(t)}"><button class="btn primary" type="submit">Sign in</button></form></main></body></html>`);
});
loginRouter.post('/auth/email', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const p = verifyPayload<{ email: string; n: string }>(String(req.body?.t ?? ''), config.sessionSecret);
  if (!p || !firstTime(`email-link:${p.n}`)) return fail(res, 'That sign-in link has expired or was already used. Ask for a new one.');
  if (!allowed(p.email)) return fail(res, `${p.email} is no longer allowed to sign in here`);
  startSession(res);
  log('info', `Signed in with an email link as ${p.email}`);
  res.redirect('/');
});

/** What the login card offers. */
export const loginOptions = () => ({ google: googleReady(), emailLink: emailReady() });
