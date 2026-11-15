import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
const key = () => createHash('sha256').update(String(process.env.LINKEDIN_ENCRYPTION_KEY)).digest();

// AES-256-GCM. Access tokens never sit in the database as plain text.
export function seal(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function open(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
