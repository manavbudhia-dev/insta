/**
 * Instagram API with Unified Login (built on Facebook Login for Business).
 *
 * - Login: facebook.com OAuth dialog with a `config_id`; the person signs in with Instagram or Facebook.
 * - Token: a Business Integration System User Access Token, exchanged with the META app ID and secret.
 * - Host: graph.facebook.com. `/me` is the system user, so every call uses the Instagram account ID.
 */
import crypto from 'node:crypto';
import { config, WEBHOOK_FIELDS } from './config.js';
import { db, delSetting, getSetting, log, setSetting } from './db.js';
import { isSealed, open as openSecret, seal } from './vault.js';

export class IgError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
    public subcode?: number,
    /** A POST whose outcome is unknown (timeout / connection reset): it may already have been delivered. */
    public ambiguous = false,
  ) {
    super(message);
  }
  /**
   * Rate limits and server-side hiccups are worth retrying; everything else is not.
   * An ambiguous send is never retried: the Send API has no idempotency key, so a retry could message the person twice.
   */
  get transient(): boolean {
    if (this.ambiguous) return false;
    return this.status >= 500 || this.status === 429 || [1, 2, 4, 17, 32, 613].includes(this.code ?? -1);
  }
  get authFailure(): boolean {
    return this.code === 190;
  }
}

let tokenCache: { stored: string; plain: string } | undefined;
export function token(): string {
  const stored = getSetting('ig_token');
  if (!stored) return '';
  if (tokenCache?.stored !== stored) {
    const plain = openSecret(stored);
    if (!plain) log('error', 'The stored Instagram token cannot be decrypted (was SESSION_SECRET changed?). Reconnect the account from the Overview page.');
    tokenCache = { stored, plain };
  }
  return tokenCache.plain;
}

/** Encrypts a token that an older version stored as plain text. */
export function sealStoredToken(): void {
  const stored = getSetting('ig_token');
  if (stored && !isSealed(stored)) setSetting('ig_token', seal(stored));
}
export function connected(): boolean {
  return token() !== '' && getSetting('ig_user_id') !== '';
}
/** Path prefix for the connected Instagram professional account, e.g. "/17841400000000000". */
export function acct(): string {
  const id = getSetting('ig_user_id');
  if (!id) throw new IgError('No Instagram account is connected', 400);
  return `/${id}`;
}

type Params = Record<string, string | number | boolean | undefined>;

async function request<T = any>(
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Params; body?: unknown; accessToken?: string | null } = {},
): Promise<T> {
  const url = new URL(`${config.graphBase}/${config.graphVersion}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const accessToken = opts.accessToken === null ? '' : opts.accessToken ?? token();
  const headers: Record<string, string> = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    // Required when the Meta app has "Require App Secret" on; harmless otherwise.
    if (config.metaAppSecret) {
      url.searchParams.set('appsecret_proof', crypto.createHmac('sha256', config.metaAppSecret).update(accessToken).digest('hex'));
    }
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // Failures before a connection exists are safe to retry; anything later on a POST may have been delivered.
    const code = String((e as any)?.cause?.code ?? '');
    const neverSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
    const ambiguous = method === 'POST' && !neverSent;
    throw new IgError(
      `Network error: ${(e as Error).message}${ambiguous ? ' (the request may still have been delivered; check Instagram before resending)' : ''}`,
      503, undefined, undefined, ambiguous,
    );
  }
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || json.error) {
    const err = json.error ?? {};
    throw new IgError(err.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, err.code, err.error_subcode);
  }
  return json as T;
}

export const ig = {
  get: <T = any>(path: string, query?: Params) => request<T>('GET', path, { query }),
  post: <T = any>(path: string, body?: unknown, query?: Params) => request<T>('POST', path, { body, query }),
  /** Follow a full `paging.next` URL returned by the API. */
  next: async <T = any>(url: string): Promise<T> => {
    const u = new URL(url);
    if (u.origin !== new URL(config.graphBase).origin) throw new IgError('Unexpected paging URL', 400);
    const path = u.pathname.replace(/^\/v[\d.]+/, '');
    const query = Object.fromEntries(u.searchParams);
    delete query.access_token;
    return request<T>('GET', path, { query });
  },
};

// ---------- login ----------

export function redirectUri(): string {
  return `${config.baseUrl}/auth/instagram/callback`;
}

/** The Unified Login dialog. `prompt=login` always offers both the Instagram and Facebook options. */
export function authorizeUrl(state: string): string {
  const u = new URL('https://www.facebook.com/dialog/oauth');
  u.searchParams.set('client_id', config.metaAppId);
  u.searchParams.set('config_id', config.metaConfigId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  // Same as the Login URL Meta generates: make sure we get an authorization code, whatever the configuration default is.
  u.searchParams.set('override_default_response_type', 'true');
  u.searchParams.set('prompt', 'login');
  u.searchParams.set('state', state);
  return u.toString();
}

export async function exchangeCode(code: string): Promise<void> {
  const base = { client_id: config.metaAppId, client_secret: config.metaAppSecret, code };
  let res: { access_token: string; expires_in?: number };
  try {
    res = await request('GET', '/oauth/access_token', { query: { ...base, redirect_uri: redirectUri() }, accessToken: null });
  } catch (e) {
    // Meta's Unified Login sample omits redirect_uri; fall back to that form if the standard one is refused.
    if ((e as IgError).status >= 500) throw e;
    res = await request('GET', '/oauth/access_token', { query: base, accessToken: null });
  }
  if (!res.access_token) throw new Error('Meta did not return an access token');
  await saveToken(res.access_token, res.expires_in);
}

export interface IgAccount {
  id: string;
  username: string;
}

/**
 * Stores a system user token, discovers the Instagram accounts it was granted
 * and subscribes the chosen account to webhooks.
 */
export async function saveToken(accessToken: string, expiresInSec?: number): Promise<void> {
  // Informational only: never let this block the connection.
  const me = await request<{ id: string; client_business_id?: string }>('GET', '/me', {
    query: { fields: 'client_business_id' },
    accessToken,
  }).catch(() => ({ id: '', client_business_id: '' }));
  const list = await request<{ data?: IgAccount[] }>('GET', '/me/assigned_instagram_accounts', {
    query: { fields: 'id,username' },
    accessToken,
  });
  const accounts = (list.data ?? []).map((a) => ({ id: String(a.id), username: a.username ?? '' }));
  if (!accounts.length) {
    throw new Error(
      'This token has no Instagram account assigned. Connect again and tick your Instagram professional account when asked which assets to share.',
    );
  }

  // Expiry comes from the login configuration: many system user tokens never expire.
  let expiresAt = expiresInSec ? Date.now() + expiresInSec * 1000 : 0;
  if (!expiresInSec && config.metaAppId && config.metaAppSecret) {
    try {
      const dbg = await request<{ data?: { expires_at?: number } }>('GET', '/debug_token', {
        query: { input_token: accessToken, access_token: `${config.metaAppId}|${config.metaAppSecret}` },
        accessToken: null,
      });
      if (dbg.data?.expires_at) expiresAt = dbg.data.expires_at * 1000;
    } catch {
      /* best-effort */
    }
  }

  setSetting('ig_token', seal(accessToken));
  setSetting('ig_token_saved_at', Date.now());
  setSetting('ig_token_expires_at', expiresAt);
  setSetting('client_business_id', me.client_business_id ?? '');
  setSetting('ig_accounts', JSON.stringify(accounts));
  if (!getSetting('connected_at')) setSetting('connected_at', Date.now());

  const previous = getSetting('ig_user_id');
  const chosen = accounts.find((a) => a.id === previous) ?? accounts[0];
  if (accounts.length > 1) {
    log('info', `${accounts.length} Instagram accounts were shared; using @${chosen.username}. Switch on the Overview page.`);
  }
  await selectAccount(chosen.id);
}

export function accounts(): IgAccount[] {
  try {
    return JSON.parse(getSetting('ig_accounts', '[]'));
  } catch {
    return [];
  }
}

/** Make one of the shared Instagram accounts the active one. */
export async function selectAccount(id: string): Promise<void> {
  const account = accounts().find((a) => a.id === id);
  if (!account) throw new Error('That Instagram account was not shared with this app');
  if (getSetting('ig_user_id') !== account.id) {
    // A different account: its older comments must not trigger replies, and queued sends belong to the old account.
    setSetting('connected_at', Date.now());
    db.prepare("UPDATE outbox SET status = 'skipped', error = 'Instagram account was switched before this was sent' WHERE status = 'pending'").run();
  }
  setSetting('ig_user_id', account.id);
  setSetting('ig_username', account.username);
  delSetting('webhooks_subscribed');
  for (const k of ['ig_name', 'ig_picture', 'ig_followers']) delSetting(k);
  try {
    const p = await ig.get<any>(acct(), { fields: 'username,name,profile_picture_url,followers_count' });
    if (p.username) setSetting('ig_username', p.username);
    setSetting('ig_name', p.name ?? '');
    setSetting('ig_picture', p.profile_picture_url ?? '');
    setSetting('ig_followers', p.followers_count ?? 0);
  } catch {
    /* profile details are cosmetic */
  }
  log('info', `Connected Instagram account @${getSetting('ig_username')}`);
  await subscribeWebhooks().catch((e) => log('warn', `Webhook subscription failed: ${e.message}`));
}

export async function subscribeWebhooks(): Promise<void> {
  await ig.post(`${acct()}/subscribed_apps`, undefined, { subscribed_fields: WEBHOOK_FIELDS.join(',') });
  setSetting('webhooks_subscribed', WEBHOOK_FIELDS.join(','));
  log('info', `Subscribed account to webhooks: ${WEBHOOK_FIELDS.join(', ')}`);
}

export function disconnect(): void {
  for (const k of ['ig_token', 'ig_token_saved_at', 'ig_token_expires_at', 'ig_user_id', 'ig_accounts', 'client_business_id',
    'ig_username', 'ig_name', 'ig_picture', 'ig_followers', 'webhooks_subscribed', 'connected_at']) {
    delSetting(k);
  }
  log('info', 'Instagram account disconnected');
}

/**
 * System user tokens usually never expire. If the login configuration gave this one an
 * expiry, warn ahead of time: reconnecting from the dashboard issues a fresh token.
 */
export function checkTokenExpiry(): void {
  if (!connected()) return;
  const expires = Number(getSetting('ig_token_expires_at', '0'));
  if (!expires) return;
  const days = Math.floor((expires - Date.now()) / 86400_000);
  if (days < 0) log('error', 'The Instagram access token has expired — reconnect the account from the Overview page');
  else if (days <= 7) log('warn', `The Instagram access token expires in ${days} day(s) — reconnect the account from the Overview page`);
}

export function isOwnAccount(id: string | undefined): boolean {
  return !!id && id === getSetting('ig_user_id');
}

// ---------- messaging ----------

export interface SendResult {
  recipient_id?: string;
  message_id?: string;
  id?: string;
}

export function sendDm(igsid: string, message: unknown): Promise<SendResult> {
  return ig.post(`${acct()}/messages`, { recipient: { id: igsid }, message });
}
/** One private DM in response to a comment (allowed once per comment, within 7 days). */
export function sendPrivateReply(commentId: string, message: unknown): Promise<SendResult> {
  return ig.post(`${acct()}/messages`, { recipient: { comment_id: commentId }, message });
}
export function replyToComment(commentId: string, text: string): Promise<SendResult> {
  return ig.post(`/${commentId}/replies`, { message: text });
}
export function getProfile(igsid: string): Promise<{ name?: string; username?: string }> {
  return ig.get(`/${igsid}`, { fields: 'name,username' });
}
