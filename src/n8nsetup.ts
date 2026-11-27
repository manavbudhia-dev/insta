import crypto from 'node:crypto';
import { getSetting, log, redact, setSetting } from './db.js';
import { deliverNow, saveHookConfig } from './outhook.js';
import { open, seal } from './vault.js';

/**
 * One-click n8n setup: with the n8n URL and an n8n API key, this creates (or updates) the
 * "DM Autopilot → Leads Sheet" workflow through n8n's public API, publishes it, points the outgoing
 * webhook at it and sends a test event. Running it again updates the same workflow instead of adding one.
 * The one thing it cannot do is the Google sign-in: that credential is made once in n8n by a person.
 */

const WORKFLOW_NAME = 'DM Autopilot → Leads Sheet';
const SHEETS_CRED_TYPE = 'googleSheetsOAuth2Api';

export class SetupError extends Error {}

export interface N8nStatus {
  baseUrl: string;
  hasApiKey: boolean;
  sheetUrl: string;
  workflowId: string | null;
  workflowUrl: string | null;
  webhookUrl: string | null;
  credential: { id: string; name: string } | null;
}

export function n8nStatus(): N8nStatus {
  const baseUrl = getSetting('n8n_base_url');
  const workflowId = getSetting('n8n_workflow_id') || null;
  const path = getSetting('n8n_webhook_path');
  let credential = null;
  try { credential = JSON.parse(getSetting('n8n_sheets_credential') || 'null'); } catch { /* ignore */ }
  return {
    baseUrl,
    hasApiKey: !!getSetting('n8n_api_key'),
    sheetUrl: getSetting('n8n_sheet_url'),
    workflowId,
    workflowUrl: baseUrl && workflowId ? `${baseUrl}/workflow/${workflowId}` : null,
    webhookUrl: baseUrl && path ? `${baseUrl}/webhook/${path}` : null,
    credential,
  };
}

function normBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SetupError('Enter your n8n address, for example https://n8n.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SetupError('The n8n address must start with https:// or http://');
  // People paste whatever is in the address bar: keep only the origin (and a sub-path install, minus n8n's own pages).
  const path = u.pathname.replace(/\/(home|workflow|workflows|signin|settings|projects)(\/.*)?$/, '').replace(/\/+$/, '');
  return u.origin + path;
}

function sheetId(url: string): string {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(url);
  if (!m) throw new SetupError('Paste the full Google Sheet link (https://docs.google.com/spreadsheets/d/…)');
  return m[1];
}

async function n8n(base: string, key: string, method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'X-N8N-API-KEY': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new SetupError(`Could not reach n8n at ${base}: ${redact((e as Error).message)}`);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new SetupError(
      res.status === 401 || res.status === 403
        ? 'n8n refused the API key. Create one in n8n → Settings → n8n API and paste it here.'
        : `n8n answered ${res.status} for ${method} ${path}${json?.message ? `: ${json.message}` : ''}`,
    ) as SetupError & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json;
}

/** The Google Sheets credential to use: the one picked before, else the first one in n8n. */
async function findSheetsCredential(base: string, key: string, preferId?: string) {
  if (preferId) return { id: preferId, name: 'Google Sheets account' };
  try {
    const list = await n8n(base, key, 'GET', '/credentials?limit=250');
    const c = (list?.data ?? []).find((x: any) => x.type === SHEETS_CRED_TYPE);
    return c ? { id: String(c.id), name: String(c.name) } : null;
  } catch (e) {
    // Older n8n versions have no list endpoint, and only owners/admins may call it.
    if ((e as { status?: number }).status === 404 || (e as { status?: number }).status === 405) return null;
    throw e;
  }
}

export function buildWorkflow(path: string, sheetUrl: string, cred: { id: string; name: string } | null) {
  const v = (expr: string) => `={{ ${expr} }}`;
  const col = (id: string) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true });
  return {
    name: WORKFLOW_NAME,
    nodes: [
      {
        parameters: { httpMethod: 'POST', path, options: {} },
        id: crypto.randomUUID(), name: 'From DM Autopilot', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: crypto.randomUUID(),
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: 'ev1', leftValue: v("['message.received', 'comment.received'].includes($json.body.event)"), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
            combinator: 'and',
          },
          options: {},
        },
        id: crypto.randomUUID(), name: 'New DM or Comment?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [220, 0],
      },
      {
        parameters: {
          operation: 'append',
          documentId: { __rl: true, value: sheetUrl, mode: 'url' },
          sheetName: { __rl: true, value: 'Leads', mode: 'name' },
          columns: {
            mappingMode: 'defineBelow',
            value: {
              Time: v("DateTime.fromISO($json.body.created_at).setZone('Asia/Kolkata').toFormat('yyyy-MM-dd HH:mm')"),
              Event: v("$json.body.event === 'comment.received' ? 'Comment' : 'DM'"),
              Username: v("$json.body.data.contact.username ? '@' + $json.body.data.contact.username : ''"),
              Name: v("$json.body.data.contact.name || ''"),
              IGSID: v("$json.body.data.contact.igsid || ''"),
              Text: v('$json.body.data.text'),
            },
            matchingColumns: [],
            schema: ['Time', 'Event', 'Username', 'Name', 'IGSID', 'Text'].map(col),
          },
          options: {},
        },
        id: crypto.randomUUID(), name: 'Save Lead', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [460, -20],
        ...(cred ? { credentials: { [SHEETS_CRED_TYPE]: cred } } : {}),
      },
    ],
    connections: {
      'From DM Autopilot': { main: [[{ node: 'New DM or Comment?', type: 'main', index: 0 }]] },
      'New DM or Comment?': { main: [[{ node: 'Save Lead', type: 'main', index: 0 }], []] },
    },
    settings: { executionOrder: 'v1' },
  };
}

export interface ConnectInput { baseUrl?: unknown; apiKey?: unknown; sheetUrl?: unknown; credentialId?: unknown }

export async function connectN8n(input: ConnectInput) {
  const base = normBase(String(input.baseUrl ?? getSetting('n8n_base_url')));
  const key = String(input.apiKey ?? '').trim() || open(getSetting('n8n_api_key'));
  if (!key) throw new SetupError('Paste an n8n API key (n8n → Settings → n8n API → Create an API key).');
  const sheetUrl = String(input.sheetUrl ?? getSetting('n8n_sheet_url')).trim();
  sheetId(sheetUrl);

  // 1. The key works.
  await n8n(base, key, 'GET', '/workflows?limit=1');
  setSetting('n8n_base_url', base);
  setSetting('n8n_api_key', seal(key));
  setSetting('n8n_sheet_url', sheetUrl);

  // 2. Google Sheets credential (made once in n8n by a person).
  const cred = await findSheetsCredential(base, key, String(input.credentialId ?? '').trim() || undefined);
  setSetting('n8n_sheets_credential', JSON.stringify(cred));

  // 3. Create or update the workflow. A secret-looking path, so nobody can guess the URL and post fake leads.
  const path = getSetting('n8n_webhook_path') || `dm-autopilot-${crypto.randomBytes(8).toString('hex')}`;
  const body = buildWorkflow(path, sheetUrl, cred);
  let id = getSetting('n8n_workflow_id');
  if (id) {
    try {
      await n8n(base, key, 'PUT', `/workflows/${encodeURIComponent(id)}`, body);
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
      id = ''; // deleted in n8n: make a new one
    }
  }
  if (!id) {
    const created = await n8n(base, key, 'POST', '/workflows', body);
    id = String(created?.id ?? '');
    if (!id) throw new SetupError('n8n did not return the new workflow id');
  }
  setSetting('n8n_workflow_id', id);
  setSetting('n8n_webhook_path', path);

  const status = n8nStatus();
  if (!cred) {
    log('warn', 'n8n setup: workflow created, but no Google Sheets credential was found in n8n');
    return { ...status, published: false, tested: false, needs: 'google' as const };
  }

  // 4. Publish (n8n 2.x) / activate (1.x): same endpoint.
  try {
    await n8n(base, key, 'POST', `/workflows/${encodeURIComponent(id)}/activate`);
  } catch (e) {
    throw new SetupError(`The workflow was saved but n8n would not publish it: ${(e as Error).message}. Open it in n8n to see what is missing.`);
  }

  // 5. Point our webhook at it and prove it works.
  const err = saveHookConfig({ url: status.webhookUrl });
  if (err) throw new SetupError(err);
  const test = await deliverNow('test', { message: 'DM Autopilot connected to n8n by one-click setup.' });
  log('info', `n8n one-click setup finished (workflow ${id}); test event ${test.ok ? 'delivered' : `failed: ${test.error}`}`);
  return { ...status, published: true, tested: test.ok, testError: test.ok ? null : test.error, needs: null };
}

export function disconnectN8n(): void {
  for (const k of ['n8n_api_key', 'n8n_workflow_id', 'n8n_webhook_path', 'n8n_sheets_credential']) setSetting(k, '');
  log('info', 'n8n one-click setup forgotten (the workflow in n8n was left as it is)');
}
