import path from 'node:path';

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

export const config = {
  port: Number(env('PORT', '3000')),
  /** Public HTTPS origin, e.g. https://insta.zealcoder.in (no trailing slash). */
  baseUrl: env('BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  adminPassword: env('ADMIN_PASSWORD'),
  sessionSecret: env('SESSION_SECRET'),
  /** Meta app credentials (App settings > Basic) — not the legacy "Instagram app" ID/secret. */
  metaAppId: env('META_APP_ID'),
  metaAppSecret: env('META_APP_SECRET'),
  /** Login configuration ID from "API setup with Unified login" > Configure your app. */
  metaConfigId: env('META_CONFIG_ID'),
  webhookVerifyToken: env('WEBHOOK_VERIFY_TOKEN'),
  graphVersion: env('GRAPH_VERSION', 'v27.0'),
  /** Overridable for tests only. */
  graphBase: env('GRAPH_BASE', 'https://graph.facebook.com').replace(/\/+$/, ''),
  /** Worker tick intervals (ms); lowered in tests. */
  queueTickMs: Number(env('QUEUE_TICK_MS', '2000')),
  sendGapMs: Number(env('SEND_GAP_MS', '1500')),
  /** Upper bound for uploaded post media on disk. */
  maxMediaBytes: Number(env('MAX_MEDIA_MB', '5120')) * 1024 * 1024,
};

/** Permissions the login configuration must include (chosen in the Meta dashboard, not in the URL). */
export const PERMISSIONS = ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'instagram_content_publish', 'instagram_manage_insights'];

export const WEBHOOK_FIELDS = ['messages', 'messaging_postbacks', 'comments'];

export function assertConfig(): void {
  const missing: string[] = [];
  if (config.adminPassword.length < 8) missing.push('ADMIN_PASSWORD (min 8 characters)');
  if (config.sessionSecret.length < 16) missing.push('SESSION_SECRET (min 16 characters)');
  if (missing.length) {
    console.error('Missing required configuration:\n  - ' + missing.join('\n  - '));
    process.exit(1);
  }
  // Warnings only: refusing to start would take a working deployment down on upgrade.
  const warn: string[] = [];
  const weak = ['password', 'changeme', 'admin', '12345678', 'qwertyui', 'letmein'];
  if (config.adminPassword.length < 12 || weak.some((w) => config.adminPassword.toLowerCase().includes(w))) {
    warn.push('ADMIN_PASSWORD is short or easy to guess; use 12+ random characters');
  }
  if (config.sessionSecret.length < 32) warn.push('SESSION_SECRET should be at least 32 characters (openssl rand -hex 32)');
  if (config.adminPassword === config.sessionSecret) warn.push('ADMIN_PASSWORD and SESSION_SECRET must not be the same value');
  if (process.env.NODE_ENV === 'production' && !config.baseUrl.startsWith('https://')) {
    warn.push('BASE_URL is not https: the session cookie will not be marked Secure and traffic is unencrypted');
  }
  if (!config.metaAppSecret) warn.push('META_APP_SECRET is not set: webhooks cannot be verified, so every webhook is rejected');
  for (const w of warn) console.warn(`[security] ${w}`);
}
