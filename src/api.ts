import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { config, PERMISSIONS } from './config.js';
import { db, DEFAULTS, getSetting, log, opt, redact, setSetting } from './db.js';
import { clip, parseRule } from './engine.js';
import { getFlow, GraphError, sanitizeGraph, validateGraph, type Graph } from './flows.js';
import { automationMetrics, calendar, instagramMetrics } from './insights.js';
import { accounts, connected, disconnect, ensureWebhooks, IgError, saveToken, selectAccount, webhookState } from './instagram.js';
import { pollOnce } from './poller.js';
import { enqueue, windowOpen } from './queue.js';
import { deliverNow, HOOK_EVENTS, hookConfig, newSecret, saveHookConfig } from './outhook.js';
import { connectN8n, disconnectN8n, n8nStatus, SetupError } from './n8nsetup.js';

export const api = express.Router();

const mediaDir = path.join(config.dataDir, 'media');
const upload = multer({ dest: path.join(config.dataDir, 'tmp'), limits: { fileSize: 300 * 1024 * 1024, files: 20 } });

class BadRequest extends Error {}
const bad = (msg: string): never => {
  throw new BadRequest(msg);
};

/** Wrap a handler so thrown errors become JSON responses. */
function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      // Instagram's own message is useful to the admin (minus any secret); anything else stays in the server log.
      if (e instanceof BadRequest) return void res.status(400).json({ error: e.message });
      if (e instanceof IgError) return void res.status(502).json({ error: redact(e.message) });
      log('error', `API ${req.method} ${req.path} failed: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong. The details are in the Logs.' });
    }
  };
}

// ---------- status ----------

api.get('/status', h(() => {
  const now = Date.now();
  // Opening the dashboard also re-checks a subscription that has not been verified for a while (in the background).
  const wh = webhookState();
  if (connected() && now - wh.checkedAt > 10 * 60_000) void ensureWebhooks('check');
  const day = now - 86400_000;
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  return {
    config: {
      baseUrl: config.baseUrl,
      appId: !!config.metaAppId,
      appSecret: !!config.metaAppSecret,
      configId: !!config.metaConfigId,
      permissions: PERMISSIONS,
      verifyToken: !!config.webhookVerifyToken,
      https: config.baseUrl.startsWith('https://'),
      webhookUrl: config.webhookCallbackUrl,
      redirectUri: `${config.baseUrl}/auth/instagram/callback`,
      privacyUrl: `${config.baseUrl}/privacy`,
    },
    account: connected()
      ? {
          username: getSetting('ig_username'),
          name: getSetting('ig_name'),
          picture: getSetting('ig_picture'),
          followers: Number(getSetting('ig_followers', '0')),
          tokenExpiresAt: Number(getSetting('ig_token_expires_at', '0')),
          webhooksSubscribed: getSetting('webhooks_subscribed'),
          webhooks: wh,
          id: getSetting('ig_user_id'),
          accounts: accounts(),
        }
      : null,
    health: {
      lastWebhookAt: Number(getSetting('last_webhook_at', '0')),
      lastCommentWebhookAt: Number(getSetting('last_comment_webhook_at', '0')),
      lastPollAt: Number(getSetting('last_poll_at', '0')),
      lastPollError: getSetting('last_poll_error'),
    },
    stats: {
      inbound24h: count("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND created_at > ?", day),
      sent24h: count("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND sent_at > ?", day),
      sentLastHour: count("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND sent_at > ?", now - 3600_000),
      pending: count("SELECT COUNT(*) n FROM outbox WHERE status IN ('pending','sending')"),
      failed24h: count("SELECT COUNT(*) n FROM outbox WHERE status = 'failed' AND created_at > ?", day),
      contacts: count('SELECT COUNT(*) n FROM contacts'),
      activeRules: count('SELECT COUNT(*) n FROM rules WHERE enabled = 1'),
      scheduledPosts: count("SELECT COUNT(*) n FROM posts WHERE status = 'scheduled'"),
    },
    hourlyLimit: opt('dm_hourly_limit'),
    automationEnabled: !!opt('automation_enabled'),
  };
}));

// ---------- dashboard (shell + overview) ----------

const DAY_MS = 86400_000;
const DM_KINDS = "('dm','story_reply','story_mention')";

/** Small payload the page chrome (sidebar badge, account pill, bell, limit meter) refreshes on every view. */
api.get('/shell', h(() => {
  const now = Date.now();
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const on = connected();
  const expires = Number(getSetting('ig_token_expires_at', '0'));
  const alerts =
    one("SELECT COUNT(*) n FROM outbox WHERE status = 'failed' AND created_at > ?", now - DAY_MS) +
    (getSetting('last_poll_error') ? 1 : 0) +
    (on && expires > 0 && expires < now ? 1 : 0);
  return {
    account: on
      ? { id: getSetting('ig_user_id'), username: getSetting('ig_username'), name: getSetting('ig_name'), picture: getSetting('ig_picture'), accounts: accounts() }
      : null,
    // People whose latest message is still unanswered and whose 24-hour window is open.
    badge: one(`SELECT COUNT(*) n FROM contacts c WHERE c.last_inbound_at > ?
      AND (SELECT direction FROM messages m WHERE m.igsid = c.igsid ORDER BY m.created_at DESC, m.id DESC LIMIT 1) = 'in'`, now - DAY_MS),
    alerts,
    limit: { used: one("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND sent_at > ?", now - 3600_000), max: opt('dm_hourly_limit') },
    automationEnabled: !!opt('automation_enabled'),
  };
}));

/** Everything the Overview cards need: period totals with change vs the previous period, daily trend, per-rule activity, recent events. */
api.get('/overview', h((req) => {
  const now = Date.now();
  const days = Number(req.query.days) === 30 ? 30 : 7;
  const off = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(Number(req.query.tz) || 0))) * 60_000; // client's UTC offset
  const today = Math.floor((now + off) / DAY_MS);
  const start = (today - days + 1) * DAY_MS - off; // local midnight, `days` days ago
  const prevStart = start - days * DAY_MS;
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const change = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

  const received = (from: number, to: number) => one(`SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND kind IN ${DM_KINDS} AND created_at >= ? AND created_at < ?`, from, to);
  const sent = (from: number, to: number) => one("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND kind IN ('dm','private_reply') AND sent_at >= ? AND sent_at < ?", from, to);
  const recvNow = received(start, now + 1);
  const recvPrev = received(prevStart, start);
  const sentNow = sent(start, now + 1);
  const sentPrev = sent(prevStart, start);
  const contacts = one('SELECT COUNT(*) n FROM contacts');
  const newContacts = one('SELECT COUNT(*) n FROM contacts WHERE first_seen >= ?', start);

  const perDay = new Map<number, number>();
  for (const r of db.prepare(`SELECT CAST((created_at + ?) / 86400000 AS INTEGER) d, COUNT(*) n FROM messages
      WHERE direction = 'in' AND kind IN ${DM_KINDS} AND created_at >= ? GROUP BY d`).all(off, start) as { d: number; n: number }[]) perDay.set(r.d, r.n);
  const trend = Array.from({ length: days }, (_, i) => {
    const idx = today - days + 1 + i;
    return { date: new Date(idx * DAY_MS).toISOString().slice(0, 10), n: perDay.get(idx) ?? 0 };
  });

  const ruleReplies: Record<number, number> = {};
  for (const r of db.prepare(`SELECT rule_id, COUNT(*) n FROM messages WHERE direction = 'out' AND rule_id IS NOT NULL
      AND kind != 'comment_reply' AND created_at >= ? GROUP BY rule_id`).all(now - 7 * DAY_MS) as { rule_id: number; n: number }[]) ruleReplies[r.rule_id] = r.n;

  type Ev = { ts: number; type: 'reply' | 'dm' | 'comment' | 'post' | 'published' | 'rule'; title: string; sub: string };
  const ev: Ev[] = [];
  for (const o of db.prepare(`SELECT o.sent_at ts, o.kind, o.source, c.username FROM outbox o LEFT JOIN contacts c ON c.igsid = o.igsid
      WHERE o.status = 'sent' ORDER BY o.sent_at DESC LIMIT 6`).all() as any[])
    ev.push({ ts: o.ts, type: 'reply', title: o.source === 'manual' ? 'Reply sent' : 'Automation reply sent', sub: o.kind === 'comment_reply' ? 'public comment reply' : `to ${o.username ? '@' + o.username : 'a contact'}` });
  for (const m of db.prepare(`SELECT m.created_at ts, m.kind, c.username FROM messages m LEFT JOIN contacts c ON c.igsid = m.igsid
      WHERE m.direction = 'in' ORDER BY m.created_at DESC LIMIT 6`).all() as any[])
    ev.push({ ts: m.ts, type: m.kind === 'comment' ? 'comment' : 'dm', title: m.kind === 'comment' ? 'New comment received' : 'New DM received', sub: `from ${m.username ? '@' + m.username : 'a contact'}` });
  for (const p of db.prepare("SELECT created_at ts, caption, type FROM posts ORDER BY created_at DESC LIMIT 6").all() as any[])
    ev.push({ ts: p.ts, type: 'post', title: 'Post scheduled', sub: p.caption ? `“${clip(String(p.caption).split('\n')[0], 40)}”` : 'No caption' });
  for (const p of db.prepare("SELECT published_at ts, caption FROM posts WHERE status = 'published' AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 6").all() as any[])
    ev.push({ ts: p.ts, type: 'published', title: 'Post published', sub: p.caption ? `“${clip(String(p.caption).split('\n')[0], 40)}”` : 'No caption' });
  for (const r of db.prepare('SELECT created_at ts, name FROM rules ORDER BY created_at DESC LIMIT 6').all() as any[])
    ev.push({ ts: r.ts, type: 'rule', title: 'Automation created', sub: `“${clip(String(r.name), 40)}”` });
  ev.sort((a, b) => b.ts - a.ts);

  return {
    days,
    received: { value: recvNow, change: change(recvNow, recvPrev) },
    sent: { value: sentNow, change: change(sentNow, sentPrev) },
    scheduledPosts: one("SELECT COUNT(*) n FROM posts WHERE status = 'scheduled'"),
    conversations: { value: contacts, change: contacts - newContacts > 0 ? Math.round((newContacts / (contacts - newContacts)) * 100) : null },
    trend,
    prevTotal: recvPrev,
    ruleReplies,
    rules: db.prepare('SELECT * FROM rules ORDER BY priority DESC, id').all().map(parseRule),
    upcoming: (db.prepare("SELECT * FROM posts WHERE status IN ('scheduled','publishing') ORDER BY scheduled_at ASC LIMIT 3").all() as any[]).map((p) => ({ ...p, media: JSON.parse(p.media) })),
    postCount: one('SELECT COUNT(*) n FROM posts'),
    recent: ev.slice(0, 4),
  };
}));

// ---------- account ----------

api.post('/account/token', h(async (req) => {
  const t = String(req.body?.token ?? '').trim();
  if (t.length < 20) bad('Paste the access token generated under "API setup with Unified login" in the Meta App Dashboard');
  try {
    await saveToken(t);
  } catch (e) {
    bad(`Meta rejected that token: ${(e as Error).message}`);
  }
}));
api.post('/account/disconnect', h(() => disconnect()));
api.post('/account/select', h(async (req) => {
  try {
    await selectAccount(String(req.body?.id ?? ''));
  } catch (e) {
    bad((e as Error).message);
  }
}));
api.post('/account/subscribe', h(async () => {
  if (!connected()) bad('Connect an Instagram account first');
  await ensureWebhooks('manual');
  const s = webhookState();
  if (!s.ok) bad(s.error || 'Meta did not confirm the subscription');
  return s;
}));

// ---------- rules ----------

const TRIGGERS = ['dm', 'comment', 'story_reply', 'story_mention', 'welcome'];
const MODES = ['contains', 'exact', 'any'];

function cleanList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s).trim()).filter(Boolean).slice(0, max);
}

function ruleInput(b: any) {
  const trigger = TRIGGERS.includes(b.trigger_type) ? b.trigger_type : bad('Unknown trigger type');
  let mode = MODES.includes(b.match_mode) ? b.match_mode : 'contains';
  if (trigger === 'welcome' || trigger === 'story_mention') mode = 'any';
  const keywords = cleanList(b.keywords, 50);
  if (mode !== 'any' && !keywords.length) bad('Add at least one keyword, or choose "any message"');
  const reply = String(b.reply_text ?? '').trim();
  const commentReplies = trigger === 'comment' ? cleanList(b.comment_replies, 10) : [];
  if (!reply && !commentReplies.length) bad('Write a reply message');
  if (Buffer.byteLength(reply) > 1000) bad('The reply is too long (Instagram allows 1000 bytes)');
  const buttons = (Array.isArray(b.buttons) ? b.buttons : [])
    .map((x: any) => ({ title: String(x?.title ?? '').trim(), url: String(x?.url ?? '').trim() }))
    .filter((x: any) => x.title || x.url)
    .slice(0, 3);
  for (const btn of buttons) {
    if (!btn.title || !/^https:\/\/\S+$/i.test(btn.url)) bad('Each button needs a title and an https:// link');
    if ([...btn.title].length > 20) bad('Button titles can be at most 20 characters');
  }
  if (buttons.length && [...reply].length > 640) bad('With buttons, the reply can be at most 640 characters');
  const quick = buttons.length ? [] : cleanList(b.quick_replies, 13);
  if (quick.some((q) => [...q].length > 20)) bad('Quick replies can be at most 20 characters each');
  return {
    name: String(b.name ?? '').trim().slice(0, 80) || 'Untitled rule',
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
    trigger_type: trigger,
    match_mode: mode,
    keywords: JSON.stringify(mode === 'any' ? [] : keywords),
    media_id: trigger === 'comment' && b.media_id ? String(b.media_id) : null,
    reply_text: reply,
    buttons: JSON.stringify(buttons),
    quick_replies: JSON.stringify(quick),
    comment_replies: JSON.stringify(commentReplies.map((c) => clip(c, 300))),
    cooldown_minutes: Math.max(0, Math.min(525600, Math.floor(Number(b.cooldown_minutes) || 0))),
    priority: Math.max(-100, Math.min(100, Math.floor(Number(b.priority) || 0))),
  };
}

api.get('/rules', h(() => db.prepare('SELECT * FROM rules ORDER BY priority DESC, id').all().map(parseRule)));
api.post('/rules', h((req) => {
  const r = ruleInput(req.body ?? {});
  const info = db.prepare(`INSERT INTO rules (name, enabled, trigger_type, match_mode, keywords, media_id, reply_text, buttons, quick_replies, comment_replies, cooldown_minutes, priority, created_at)
    VALUES (@name, @enabled, @trigger_type, @match_mode, @keywords, @media_id, @reply_text, @buttons, @quick_replies, @comment_replies, @cooldown_minutes, @priority, @created_at)`)
    .run({ ...r, created_at: Date.now() });
  return { id: Number(info.lastInsertRowid) };
}));
api.put('/rules/:id', h((req) => {
  const r = ruleInput(req.body ?? {});
  const info = db.prepare(`UPDATE rules SET name=@name, enabled=@enabled, trigger_type=@trigger_type, match_mode=@match_mode, keywords=@keywords, media_id=@media_id,
    reply_text=@reply_text, buttons=@buttons, quick_replies=@quick_replies, comment_replies=@comment_replies, cooldown_minutes=@cooldown_minutes, priority=@priority WHERE id=@id`)
    .run({ ...r, id: Number(req.params.id) });
  if (!info.changes) bad('Rule not found');
}));
api.post('/rules/:id/toggle', h((req) => {
  db.prepare('UPDATE rules SET enabled = 1 - enabled WHERE id = ?').run(Number(req.params.id));
}));
api.delete('/rules/:id', h((req) => {
  db.prepare('DELETE FROM rules WHERE id = ?').run(Number(req.params.id));
}));

// ---------- visual flows ----------

function graphInput(raw: unknown): Graph {
  try {
    return sanitizeGraph(raw);
  } catch (e) {
    if (e instanceof GraphError) bad(e.message);
    throw e;
  }
}
const triggerFields = (g: Graph) => {
  const t = g.nodes.find((n) => n.type === 'trigger');
  return { trigger_type: t?.data.on ?? 'dm', priority: t?.data.priority ?? 0 };
};
function flowStats(id: number) {
  const hits: Record<string, number> = {};
  for (const r of db.prepare('SELECT node_id, hits FROM flow_stats WHERE flow_id = ?').all(id) as { node_id: string; hits: number }[]) hits[r.node_id] = r.hits;
  const runs = Object.fromEntries((db.prepare('SELECT status, COUNT(*) n FROM flow_runs WHERE flow_id = ? GROUP BY status').all(id) as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  return { hits, runs };
}
const flowOut = (row: any) => {
  const graph: Graph = JSON.parse(row.graph);
  return { ...row, graph, issues: validateGraph(graph) };
};

api.get('/flows', h(() =>
  (db.prepare('SELECT * FROM flows ORDER BY updated_at DESC').all() as any[]).map((row) => {
    const f = flowOut(row);
    const active = (db.prepare("SELECT COUNT(*) n FROM flow_runs WHERE flow_id = ? AND status IN ('running','waiting')").get(row.id) as { n: number }).n;
    const t = f.graph.nodes.find((n: any) => n.type === 'trigger');
    return { id: f.id, name: f.name, enabled: f.enabled, runs: f.runs, active, updated_at: f.updated_at, steps: f.graph.nodes.length,
      trigger: t?.data ?? null, errors: f.issues.filter((i: any) => i.level === 'error').length };
  })));
api.get('/flows/:id', h((req) => {
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(Number(req.params.id));
  if (!row) bad('Flow not found');
  return { ...flowOut(row), stats: flowStats(Number(req.params.id)) };
}));
api.post('/flows/validate', h((req) => ({ issues: validateGraph(graphInput(req.body?.graph)) })));
api.post('/flows', h((req) => {
  const graph = graphInput(req.body?.graph ?? { nodes: [], edges: [] });
  const now = Date.now();
  const name = String(req.body?.name ?? '').trim().slice(0, 80) || 'Untitled flow';
  const info = db.prepare('INSERT INTO flows (name, enabled, graph, trigger_type, priority, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?)')
    .run(name, JSON.stringify(graph), triggerFields(graph).trigger_type, triggerFields(graph).priority, now, now);
  return { id: Number(info.lastInsertRowid) };
}));
api.put('/flows/:id', h((req) => {
  const id = Number(req.params.id);
  const current = getFlow(id) ?? bad('Flow not found');
  const graph = graphInput(req.body?.graph);
  const issues = validateGraph(graph);
  const enabled = req.body?.enabled === undefined ? !!current.enabled : !!req.body.enabled;
  if (enabled && issues.some((i) => i.level === 'error')) {
    bad(`Fix ${issues.filter((i) => i.level === 'error').length} problem(s) before turning this flow on`);
  }
  const name = String(req.body?.name ?? current.name).trim().slice(0, 80) || 'Untitled flow';
  db.prepare('UPDATE flows SET name = ?, enabled = ?, graph = ?, trigger_type = ?, priority = ?, updated_at = ? WHERE id = ?')
    .run(name, enabled ? 1 : 0, JSON.stringify(graph), triggerFields(graph).trigger_type, triggerFields(graph).priority, Date.now(), id);
  // Runs parked on a step that no longer exists cannot continue.
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const r of db.prepare("SELECT id, node_id FROM flow_runs WHERE flow_id = ? AND status IN ('running','waiting')").all(id) as { id: number; node_id: string }[]) {
    if (!ids.has(r.node_id)) db.prepare("UPDATE flow_runs SET status = 'cancelled' WHERE id = ?").run(r.id);
  }
  if (!enabled) db.prepare("UPDATE flow_runs SET status = 'cancelled' WHERE flow_id = ? AND status IN ('running','waiting')").run(id);
  return { issues, enabled };
}));
api.post('/flows/:id/toggle', h((req) => {
  const f = getFlow(Number(req.params.id)) ?? bad('Flow not found');
  const errors = validateGraph(f.graph).filter((i) => i.level === 'error');
  if (!f.enabled && errors.length) bad(`Open the flow and fix ${errors.length} problem(s) before turning it on`);
  db.prepare('UPDATE flows SET enabled = ?, updated_at = ? WHERE id = ?').run(f.enabled ? 0 : 1, Date.now(), f.id);
  if (f.enabled) db.prepare("UPDATE flow_runs SET status = 'cancelled' WHERE flow_id = ? AND status IN ('running','waiting')").run(f.id);
}));
api.post('/flows/:id/duplicate', h((req) => {
  const f = getFlow(Number(req.params.id)) ?? bad('Flow not found');
  const now = Date.now();
  const info = db.prepare('INSERT INTO flows (name, enabled, graph, trigger_type, priority, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?)')
    .run(`${f.name} (copy)`.slice(0, 80), JSON.stringify(f.graph), f.trigger_type, f.priority, now, now);
  return { id: Number(info.lastInsertRowid) };
}));
api.post('/flows/:id/reset-stats', h((req) => {
  db.prepare('DELETE FROM flow_stats WHERE flow_id = ?').run(Number(req.params.id));
}));
api.delete('/flows/:id', h((req) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM flow_stats WHERE flow_id = ?').run(id);
  db.prepare('DELETE FROM flow_runs WHERE flow_id = ?').run(id);
  db.prepare('DELETE FROM flows WHERE id = ?').run(id);
}));

// ---------- media (for the "limit to one post" picker) ----------

api.get('/media', h(() => db.prepare('SELECT * FROM media_cache ORDER BY timestamp DESC LIMIT 50').all()));
api.post('/media/refresh', h(async () => {
  if (!connected()) bad('Connect an Instagram account first');
  await pollOnce();
}));

// ---------- inbox ----------

api.get('/contacts', h((req) => {
  const q = `%${String(req.query.q ?? '').trim()}%`;
  return db.prepare(`
    SELECT c.*, (SELECT text FROM messages m WHERE m.igsid = c.igsid ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text,
      (SELECT MAX(created_at) FROM messages m WHERE m.igsid = c.igsid) AS last_at
    FROM contacts c WHERE (c.username LIKE ? OR c.name LIKE ? OR c.igsid LIKE ?)
    ORDER BY last_at DESC NULLS LAST LIMIT 200`).all(q, q, q);
}));
api.get('/contacts/:id/messages', h((req) => {
  const id = String(req.params.id);
  return {
    contact: db.prepare('SELECT * FROM contacts WHERE igsid = ?').get(id) ?? bad('Contact not found'),
    windowOpen: windowOpen(id),
    messages: db.prepare('SELECT * FROM (SELECT * FROM messages WHERE igsid = ? ORDER BY created_at DESC, id DESC LIMIT 200) ORDER BY created_at, id').all(id),
  };
}));
api.post('/contacts/:id/send', h((req) => {
  const id = String(req.params.id);
  const text = String(req.body?.text ?? '').trim();
  if (!text) bad('Write a message first');
  if (Buffer.byteLength(text) > 1000) bad('Message is too long (1000 bytes max)');
  if (!connected()) bad('Connect an Instagram account first');
  if (!windowOpen(id)) bad('This person last messaged more than 24 hours ago, so Instagram does not allow a reply yet');
  enqueue({ kind: 'dm', target: id, igsid: id, payload: { text }, preview: text, source: 'manual' });
}));
api.post('/contacts/:id/pause', h((req) => {
  const minutes = Math.max(0, Number(req.body?.minutes) || 0);
  db.prepare('UPDATE contacts SET paused_until = ? WHERE igsid = ?').run(minutes ? Date.now() + minutes * 60_000 : 0, String(req.params.id));
}));

api.delete('/contacts/:id', h((req) => {
  const id = String(req.params.id);
  db.prepare("DELETE FROM outbox WHERE igsid = ? OR target = ?").run(id, id);
  db.prepare('DELETE FROM messages WHERE igsid = ?').run(id);
  db.prepare('DELETE FROM contacts WHERE igsid = ?').run(id);
}));

// ---------- activity ----------

api.get('/outbox', h(() =>
  db.prepare(`SELECT o.id, o.kind, o.target, o.igsid, o.preview, o.status, o.error, o.source, o.created_at, o.sent_at, o.attempts,
    COALESCE(r.name, f.name) AS rule_name, c.username FROM outbox o LEFT JOIN rules r ON r.id = o.rule_id LEFT JOIN flows f ON f.id = o.flow_id
    LEFT JOIN contacts c ON c.igsid = o.igsid
    ORDER BY o.id DESC LIMIT 200`).all()));
api.get('/logs', h(() => db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all()));

// ---------- scheduled posts ----------

/** Total size of the uploaded media on disk. */
function dirBytes(dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    try {
      total += fs.statSync(path.join(dir, name)).size;
    } catch {
      /* removed while scanning */
    }
  }
  return total;
}

/** MP4 and MOV files start with a box header: 4 size bytes, then a known box type. */
function looksLikeVideo(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(head.subarray(4, 8).toString('latin1'));
  } finally {
    fs.closeSync(fd);
  }
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.gif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov']);

api.post('/upload', upload.array('files', 20), h(async (req) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) {
    bad('No file received');
  }
  if (dirBytes(mediaDir) + files.reduce((n, f) => n + f.size, 0) > config.maxMediaBytes) {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
    bad('The media library is full. Delete old posts or raise MAX_MEDIA_MB.');
  }
  const out: { url: string; kind: 'image' | 'video'; name: string }[] = [];
  try {
    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase();
      const id = crypto.randomBytes(16).toString('hex');
      if (VIDEO_EXT.has(ext)) {
        if (!looksLikeVideo(f.path)) bad(`${f.originalname} is not a valid MP4/MOV video`);
        const name = `${id}${ext}`;
        fs.renameSync(f.path, path.join(mediaDir, name));
        out.push({ url: `${config.baseUrl}/media/${name}`, kind: 'video', name: f.originalname });
      } else if (IMAGE_EXT.has(ext)) {
        // Instagram only accepts JPEG, so every image is normalised (and EXIF-rotated) to JPEG.
        const name = `${id}.jpg`;
        try {
          await sharp(f.path, { limitInputPixels: 100_000_000 }).rotate().resize({ width: 1440, withoutEnlargement: true }).flatten({ background: '#ffffff' })
            .jpeg({ quality: 90 }).toFile(path.join(mediaDir, name));
        } catch {
          bad(`${f.originalname} could not be read as an image`);
        }
        out.push({ url: `${config.baseUrl}/media/${name}`, kind: 'image', name: f.originalname });
      } else {
        bad(`Unsupported file type: ${f.originalname} (use JPG/PNG/WebP images or MP4/MOV video)`);
      }
    }
  } finally {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
  }
  return out;
}));

const POST_TYPES = ['IMAGE', 'REELS', 'STORIES', 'CAROUSEL'];

function postInput(b: any) {
  const type = POST_TYPES.includes(b.type) ? b.type : bad('Unknown post type');
  const media = (Array.isArray(b.media) ? b.media : [])
    .map((m: any) => ({ url: String(m?.url ?? ''), kind: m?.kind === 'video' ? 'video' : 'image' }))
    .filter((m: any) => /^https?:\/\/\S+$/.test(m.url));
  if (!media.length) bad('Add a photo or video');
  if (type === 'CAROUSEL' && (media.length < 2 || media.length > 20)) bad('A carousel needs 2 to 20 items');
  if (type !== 'CAROUSEL' && media.length > 1) bad('Only carousels can hold more than one file');
  if (type === 'REELS' && media[0].kind !== 'video') bad('A reel needs a video file');
  if (type === 'IMAGE' && media[0].kind !== 'image') bad('An image post needs an image file');
  const caption = String(b.caption ?? '');
  if ([...caption].length > 2200) bad('Captions can be at most 2200 characters');
  const at = Number(b.scheduled_at);
  if (!Number.isFinite(at) || at <= 0) bad('Pick a date and time');
  return { type, media: JSON.stringify(media), caption, scheduled_at: at };
}

api.get('/posts', h(() =>
  db.prepare("SELECT * FROM posts ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'publishing' THEN 0 ELSE 1 END, CASE WHEN status IN ('scheduled','publishing') THEN scheduled_at END ASC, scheduled_at DESC LIMIT 200")
    .all().map((p: any) => ({ ...p, media: JSON.parse(p.media) }))));
api.post('/posts', h((req) => {
  const p = postInput(req.body ?? {});
  const info = db.prepare('INSERT INTO posts (type, caption, media, scheduled_at, created_at) VALUES (@type, @caption, @media, @scheduled_at, @created_at)')
    .run({ ...p, created_at: Date.now() });
  return { id: Number(info.lastInsertRowid) };
}));
api.put('/posts/:id', h((req) => {
  const p = postInput(req.body ?? {});
  const info = db.prepare("UPDATE posts SET type=@type, caption=@caption, media=@media, scheduled_at=@scheduled_at, status='scheduled', error=NULL WHERE id=@id AND status IN ('scheduled','failed')")
    .run({ ...p, id: Number(req.params.id) });
  if (!info.changes) bad('Only scheduled or failed posts can be edited');
}));
/** Drag-and-drop on the calendar: move a scheduled (or failed) post to a new time. */
api.post('/posts/:id/reschedule', h((req) => {
  const at = Number(req.body?.scheduled_at);
  if (!Number.isFinite(at) || at < Date.now() - 60_000) bad('Pick a time in the future');
  const info = db.prepare("UPDATE posts SET scheduled_at = ?, status = 'scheduled', error = NULL WHERE id = ? AND status IN ('scheduled','failed')").run(at, Number(req.params.id));
  if (!info.changes) bad('Only scheduled or failed posts can be moved');
}));
api.get('/calendar', h(async (req) => {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 50 * 86400_000) bad('Invalid date range');
  return calendar(from, to);
}));

// ---------- insights ----------

const periodOf = (v: unknown) => ([7, 30, 90].includes(Number(v)) ? Number(v) : 30);
const tzOf = (v: unknown) => Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(Number(v) || 0)));
api.get('/insights', h((req) => automationMetrics(periodOf(req.query.days), tzOf(req.query.tz))));
api.get('/insights/instagram', h(async (req) => instagramMetrics(periodOf(req.query.days))));

api.delete('/posts/:id', h((req) => {
  const info = db.prepare("DELETE FROM posts WHERE id = ? AND status != 'publishing'").run(Number(req.params.id));
  if (!info.changes) bad('This post is being published right now');
}));

// ---------- settings ----------

api.get('/settings', h(() => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, opt(k)]))));
api.put('/settings', h((req) => {
  const limits: Record<string, [number, number]> = {
    automation_enabled: [0, 1], poll_comments: [0, 1], poll_interval_sec: [30, 3600],
    poll_media_count: [1, 50], dm_hourly_limit: [1, 1000], human_pause_min: [0, 10080], contact_hourly_limit: [1, 100],
  };
  for (const [k, [min, max]] of Object.entries(limits)) {
    if (req.body?.[k] === undefined) continue;
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < min || n > max) bad(`${k} must be between ${min} and ${max}`);
    setSetting(k, Math.floor(n));
  }
  log('info', 'Settings updated');
}));

// ---------- n8n / outgoing webhook ----------

function hookView() {
  const c = hookConfig();
  let last = null;
  try { last = JSON.parse(getSetting('outhook_last') || 'null'); } catch { /* ignore */ }
  return { url: c.url, secret: c.secret, events: c.events, available: HOOK_EVENTS, last };
}
api.get('/integrations/webhook', h(() => hookView()));
api.put('/integrations/webhook', h((req) => {
  const err = saveHookConfig(req.body ?? {});
  if (err) bad(err);
  log('info', hookConfig().url ? 'n8n webhook saved' : 'n8n webhook turned off');
  return hookView();
}));
api.post('/integrations/webhook/secret', h(() => {
  newSecret();
  log('info', 'n8n webhook signing secret regenerated');
  return hookView();
}));
api.post('/integrations/webhook/test', h(async () => {
  const r = await deliverNow('test', {
    message: 'Test event from DM Autopilot. If you can read this in n8n, the connection works.',
    contact: { igsid: '0000000000', username: 'test_user', name: 'Test User' },
  });
  if (!r.ok) bad(`n8n did not accept the test event: ${r.error}`);
  return { ok: true, status: r.status };
}));

// ---------- one-click n8n setup ----------

api.get('/integrations/n8n', h(() => n8nStatus()));
api.post('/integrations/n8n/connect', h(async (req) => {
  try {
    return await connectN8n(req.body ?? {});
  } catch (e) {
    if (e instanceof SetupError) bad(e.message);
    throw e;
  }
}));
api.post('/integrations/n8n/disconnect', h(() => {
  disconnectN8n();
  return n8nStatus();
}));
