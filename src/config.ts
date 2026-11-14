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
  graphVersion: env('GRAPH_VERSION', 'v26.0'),
  /** Overridable for tests only. */
  graphBase: env('GRAPH_BASE', 'https://graph.facebook.com').replace(/\/+$/, ''),
  /** Worker tick intervals (ms); lowered in tests. */
  queueTickMs: Number(env('QUEUE_TICK_MS', '2000')),
  sendGapMs: Number(env('SEND_GAP_MS', '1500')),
};

/** Permissions the login configuration must include (chosen in the Meta dashboard, not in the URL). */
export const PERMISSIONS = ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'instagram_content_publish'];

export const WEBHOOK_FIELDS = ['messages', 'messaging_postbacks', 'comments'];

export function assertConfig(): void {
  const missing: string[] = [];
  if (config.adminPassword.length < 8) missing.push('ADMIN_PASSWORD (min 8 characters)');
  if (config.sessionSecret.length < 16) missing.push('SESSION_SECRET (min 16 characters)');
  if (missing.length) {
    console.error('Missing required configuration:\n  - ' + missing.join('\n  - '));
    process.exit(1);
  }
}
