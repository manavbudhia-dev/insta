/** Small signed, expiring tokens: base64url(JSON payload) + "." + HMAC-SHA256. Used for login links and OAuth state. */
import crypto from 'node:crypto';

export function signPayload(payload: Record<string, unknown>, key: string, ttlMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function verifyPayload<T = Record<string, any>>(token: string, key: string): (T & { exp: number }) | null {
  const [body, mac, extra] = String(token ?? '').split('.');
  if (!body || !mac || extra !== undefined || !key) return null;
  const want = Buffer.from(crypto.createHmac('sha256', key).update(body).digest('base64url'));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && typeof p === 'object' && Number(p.exp) > Date.now() ? p : null;
  } catch {
    return null;
  }
}
