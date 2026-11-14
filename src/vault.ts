import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Encrypts secrets (the Instagram access token) before they are written to SQLite, so a copied database or
 * backup does not hand over the token. The key is derived from SESSION_SECRET: rotating it means reconnecting.
 */
const PREFIX = 'enc:v1:';
let key: Buffer | undefined;
const getKey = () => (key ??= crypto.createHash('sha256').update(`insta-vault:${config.sessionSecret}`).digest());

export function seal(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function isSealed(v: string): boolean {
  return v.startsWith(PREFIX);
}

/** Plain (legacy) values pass through unchanged; a value that cannot be decrypted returns ''. */
export function open(v: string): string {
  if (!isSealed(v)) return v;
  try {
    const raw = Buffer.from(v.slice(PREFIX.length), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
