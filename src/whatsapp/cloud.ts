/**
 * WhatsApp Business Cloud API (graph.facebook.com), official and hosted by Meta.
 * Needs: the phone number ID, the WhatsApp Business Account ID, and a permanent System User access token
 * with whatsapp_business_messaging + whatsapp_business_management.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { phoneId, waAppSecret, wabaId, waToken } from './store.js';

export class WaError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
    /** A POST whose outcome is unknown (timeout / reset): it may already have been delivered. */
    public ambiguous = false,
  ) {
    super(message);
  }
  /** Rate limits and Meta-side hiccups are retried; a send that may have gone through never is. */
  get transient(): boolean {
    if (this.ambiguous) return false;
    return this.status >= 500 || this.status === 429 || [1, 2, 4, 80007, 130429, 131016, 131048, 131056, 133004].includes(this.code ?? -1);
  }
  get authFailure(): boolean {
    return this.code === 190;
  }
  /** 131047: more than 24 hours since the person last wrote, so only a template can be sent. */
  get windowClosed(): boolean {
    return this.code === 131047;
  }
}

type Params = Record<string, string | number | undefined>;

async function request<T = any>(method: 'GET' | 'POST', path: string, opts: { query?: Params; body?: unknown } = {}): Promise<T> {
  const token = waToken();
  if (!token) throw new WaError('WhatsApp is not connected: add the access token in Settings', 400);
  const url = new URL(`${config.graphBase}/${config.graphVersion}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const secret = waAppSecret();
  // Required when the Meta app has "Require App Secret" on; harmless otherwise.
  if (secret) url.searchParams.set('appsecret_proof', crypto.createHmac('sha256', secret).update(token).digest('hex'));
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method, headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const code = String((e as any)?.cause?.code ?? '');
    const neverSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
    const ambiguous = method === 'POST' && !neverSent;
    throw new WaError(`Network error: ${(e as Error).message}${ambiguous ? ' (it may still have been delivered)' : ''}`, 503, undefined, ambiguous);
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
    const detail = err.error_data?.details;
    const msg = (err.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`) + (detail && detail !== err.message ? ` (${detail})` : '');
    throw new WaError(msg, res.status, err.code);
  }
  return json as T;
}

function needPhone(): string {
  const id = phoneId();
  if (!id) throw new WaError('Add the WhatsApp phone number ID in Settings', 400);
  return id;
}
function needWaba(): string {
  const id = wabaId();
  if (!id) throw new WaError('Add the WhatsApp Business Account ID in Settings', 400);
  return id;
}

export interface PhoneInfo { display_phone_number?: string; verified_name?: string; quality_rating?: string; messaging_limit_tier?: string }

export const cloud = {
  phoneInfo: () => request<PhoneInfo>('GET', `/${needPhone()}`, { query: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier' } }),

  /** Sends one message. `message` is the type-specific part, e.g. {type:'text', text:{body}}. Returns the wamid. */
  async send(to: string, message: Record<string, unknown>): Promise<string> {
    const r = await request<{ messages?: { id: string }[] }>('POST', `/${needPhone()}/messages`, {
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message },
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new WaError('WhatsApp accepted the request but returned no message id', 502);
    return id;
  },

  /** Blue ticks for the person: marks their message as read. */
  markRead: (wamid: string) => request('POST', `/${needPhone()}/messages`, { body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid } }),

  /** Points this WhatsApp Business Account's webhooks at the Meta app that owns the token. */
  subscribeApp: () => request<{ success?: boolean }>('POST', `/${needWaba()}/subscribed_apps`),

  async templates(): Promise<any[]> {
    const out: any[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await request<{ data: any[]; paging?: { cursors?: { after?: string }; next?: string } }>('GET', `/${needWaba()}/message_templates`, {
        query: { fields: 'name,language,status,category,components', limit: 100, after },
      });
      out.push(...(r.data ?? []));
      after = r.paging?.next ? r.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  },
};

/** Message bodies the queue sends. */
export const build = {
  text: (body: string) => ({ type: 'text', text: { body, preview_url: /https?:\/\//.test(body) } }),
  buttons: (body: string, titles: string[]) => ({
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: titles.slice(0, 3).map((t, i) => ({ type: 'reply', reply: { id: `btn_${i + 1}`, title: t.slice(0, 20) } })) },
    },
  }),
  template: (name: string, language: string, params: string[] = []) => ({
    type: 'template',
    template: {
      name,
      language: { code: language },
      ...(params.length ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }] } : {}),
    },
  }),
};
