import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { db, log } from './db.js';

const SESSION_DAYS = 30;
// Over HTTPS the __Host- prefix makes browsers refuse a cookie that was planted by a subdomain or over plain HTTP.
const isHttps = () => config.baseUrl.startsWith('https://');
const cookieName = () => (isHttps() ? '__Host-sid' : 'sid');

function sign(data: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

/** Stateless signed token: "<purpose>.<expiry>.<nonce>.<hmac>". */
export function makeToken(purpose: string, ttlMs: number): string {
  const body = `${purpose}.${Date.now() + ttlMs}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${body}.${sign(body)}`;
}
export function checkToken(purpose: string, value: string | undefined): boolean {
  if (!value) return false;
  const i = value.lastIndexOf('.');
  if (i < 0) return false;
  const body = value.slice(0, i);
  const mac = Buffer.from(value.slice(i + 1));
  const expected = Buffer.from(sign(body));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return false;
  const [p, exp] = body.split('.');
  return p === purpose && Number(exp) > Date.now();
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Changing ADMIN_PASSWORD ends every session; the fingerprint is not reversible. */
function passwordFingerprint(): string {
  return crypto.createHash('sha256').update(`pw:${config.sessionSecret}:${config.adminPassword}`).digest('hex').slice(0, 16);
}

/** A session cookie is only honoured while its nonce is still on the server, so logout really ends it. */
function sessionNonce(value: string | undefined): string | undefined {
  return value && checkToken('session', value) ? value.split('.')[2] : undefined;
}

export function isLoggedIn(req: Request): boolean {
  const nonce = sessionNonce(readCookie(req, cookieName()));
  if (!nonce) return false;
  const row = db.prepare('SELECT expires_at, pw_fp FROM sessions WHERE nonce = ?').get(nonce) as { expires_at: number; pw_fp: string } | undefined;
  return !!row && row.expires_at > Date.now() && row.pw_fp === passwordFingerprint();
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (isLoggedIn(req)) return next();
  if (req.originalUrl.startsWith('/api/')) res.status(401).json({ error: 'Not signed in' });
  else res.redirect('/');
}

// Simple in-memory brute-force guard: 8 attempts per 15 minutes per IP.
const attempts = new Map<string, { n: number; reset: number }>();

export function login(req: Request, res: Response): void {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.reset > now && a.n >= 8) {
    res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    return;
  }
  const given = crypto.createHash('sha256').update(String(req.body?.password ?? '')).digest();
  const real = crypto.createHash('sha256').update(config.adminPassword).digest();
  if (!crypto.timingSafeEqual(given, real)) {
    const n = a && a.reset > now ? a.n + 1 : 1;
    attempts.set(ip, a && a.reset > now ? { n, reset: a.reset } : { n, reset: now + 15 * 60_000 });
    log('warn', `Failed dashboard login from ${ip.replace(/[^\w.:%-]/g, '')} (attempt ${n}${n >= 8 ? ', locked out for 15 minutes' : ''})`);
    res.status(401).json({ error: 'Wrong password' });
    return;
  }
  attempts.delete(ip);
  for (const [k, v] of attempts) if (v.reset <= now) attempts.delete(k); // keep the map from growing forever
  const secure = isHttps() ? '; Secure' : '';
  const ttl = SESSION_DAYS * 86400_000;
  const token = makeToken('session', ttl);
  db.prepare('INSERT INTO sessions (nonce, expires_at, pw_fp) VALUES (?, ?, ?)').run(token.split('.')[2], now + ttl, passwordFingerprint());
  res.setHeader('Set-Cookie', `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  res.json({ ok: true });
}

/** Ends the dashboard session (also used by the LinkedIn section's "Sign out"). Appends, so other cookies set on the same response survive. */
export function endSession(req: Request, res: Response): void {
  const nonce = sessionNonce(readCookie(req, cookieName()));
  if (nonce) db.prepare('DELETE FROM sessions WHERE nonce = ?').run(nonce);
  const clear = `${cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps() ? '; Secure' : ''}`;
  const prev = res.getHeader?.('Set-Cookie');
  res.setHeader('Set-Cookie', prev == null ? clear : [...(Array.isArray(prev) ? prev : [String(prev)]), clear]);
}

export function logout(req: Request, res: Response): void {
  endSession(req, res);
  res.json({ ok: true });
}
