/**
 * Email through Resend (https://resend.com). Set RESEND_API_KEY and EMAIL_FROM (an address on a domain verified in
 * Resend, e.g. "Autopilot <noreply@zealcoder.in>"). Without them every email feature is simply hidden.
 */
import { config } from './config.js';
import { log, redact } from './db.js';

const env = (k: string) => (process.env[k] ?? '').trim();
export const emailReady = () => !!(env('RESEND_API_KEY') && env('EMAIL_FROM'));
/** Where unlock requests from clients go (the platform owner). */
export const ownerEmail = () => env('OWNER_EMAIL').toLowerCase();

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** One consistent, plain layout for every email. `rows` are already-escaped HTML paragraphs. */
export function layout(o: { title: string; rows: string[]; button?: { label: string; url: string }; footer?: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f8;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1d1f3a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;padding:28px">
<tr><td style="font-weight:700;font-size:15px;color:#6d4aff;padding-bottom:14px">⚡ Autopilot</td></tr>
<tr><td style="font-size:20px;font-weight:700;padding-bottom:10px">${esc(o.title)}</td></tr>
${o.rows.map((r) => `<tr><td style="font-size:14.5px;line-height:1.55;padding-bottom:10px">${r}</td></tr>`).join('')}
${o.button ? `<tr><td style="padding:10px 0 16px"><a href="${esc(o.button.url)}" style="display:inline-block;background:#6d4aff;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${esc(o.button.label)}</a></td></tr>` : ''}
<tr><td style="font-size:12px;color:#8a8db0;padding-top:8px;border-top:1px solid #eee">${o.footer ? esc(o.footer) : `Sent by ${esc(config.baseUrl.replace(/^https?:\/\//, ''))}`}</td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendEmail(m: { to: string | string[]; subject: string; html: string; text: string; replyTo?: string }): Promise<{ ok: boolean; error?: string }> {
  if (!emailReady()) return { ok: false, error: 'Email is not set up (RESEND_API_KEY and EMAIL_FROM)' };
  const to = (Array.isArray(m.to) ? m.to : [m.to]).filter(Boolean).slice(0, 20);
  if (!to.length) return { ok: false, error: 'No recipient' };
  const base = (env('RESEND_API_BASE') || 'https://api.resend.com').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env('EMAIL_FROM'), to, subject: m.subject.slice(0, 200), html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    const j: any = await res.json().catch(() => ({}));
    const error = redact(String(j.message ?? j.error ?? `Resend answered HTTP ${res.status}`));
    log('warn', `Email "${m.subject}" was not sent: ${error}`);
    return { ok: false, error };
  } catch (e) {
    const error = redact((e as Error).message);
    log('warn', `Email "${m.subject}" was not sent: ${error}`);
    return { ok: false, error };
  }
}
