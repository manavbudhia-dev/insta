import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { config, PERMISSIONS } from './config.js';
import { db, DEFAULTS, getSetting, log, opt, setSetting } from './db.js';
import { clip, parseRule } from './engine.js';
import { accounts, connected, disconnect, saveToken, selectAccount, subscribeWebhooks } from './instagram.js';
import { pollOnce } from './poller.js';
import { enqueue, windowOpen } from './queue.js';

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
      const status = e instanceof BadRequest ? 400 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({ error: (e as Error).message });
    }
  };
}

// ---------- status ----------

api.get('/status', h(() => {
  const now = Date.now();
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
      webhookUrl: `${config.baseUrl}/webhook`,
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
      pending: count("SELECT COUNT(*) n FROM outbox WHERE status = 'pending'"),
      failed24h: count("SELECT COUNT(*) n FROM outbox WHERE status = 'failed' AND created_at > ?", day),
      contacts: count('SELECT COUNT(*) n FROM contacts'),
      activeRules: count('SELECT COUNT(*) n FROM rules WHERE enabled = 1'),
      scheduledPosts: count("SELECT COUNT(*) n FROM posts WHERE status = 'scheduled'"),
    },
    hourlyLimit: opt('dm_hourly_limit'),
    automationEnabled: !!opt('automation_enabled'),
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
  await subscribeWebhooks();
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
    r.name AS rule_name, c.username FROM outbox o LEFT JOIN rules r ON r.id = o.rule_id LEFT JOIN contacts c ON c.igsid = o.igsid
    ORDER BY o.id DESC LIMIT 200`).all()));
api.get('/logs', h(() => db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all()));

// ---------- scheduled posts ----------

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.gif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov']);

api.post('/upload', upload.array('files', 20), h(async (req) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) bad('No file received');
  const out: { url: string; kind: 'image' | 'video'; name: string }[] = [];
  try {
    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase();
      const id = crypto.randomBytes(16).toString('hex');
      if (VIDEO_EXT.has(ext)) {
        const name = `${id}${ext}`;
        fs.renameSync(f.path, path.join(mediaDir, name));
        out.push({ url: `${config.baseUrl}/media/${name}`, kind: 'video', name: f.originalname });
      } else if (IMAGE_EXT.has(ext)) {
        // Instagram only accepts JPEG, so every image is normalised (and EXIF-rotated) to JPEG.
        const name = `${id}.jpg`;
        await sharp(f.path).rotate().resize({ width: 1440, withoutEnlargement: true }).flatten({ background: '#ffffff' })
          .jpeg({ quality: 90 }).toFile(path.join(mediaDir, name));
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
api.delete('/posts/:id', h((req) => {
  const info = db.prepare("DELETE FROM posts WHERE id = ? AND status != 'publishing'").run(Number(req.params.id));
  if (!info.changes) bad('This post is being published right now');
}));

// ---------- settings ----------

api.get('/settings', h(() => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, opt(k)]))));
api.put('/settings', h((req) => {
  const limits: Record<string, [number, number]> = {
    automation_enabled: [0, 1], poll_comments: [0, 1], poll_interval_sec: [30, 3600],
    poll_media_count: [1, 50], dm_hourly_limit: [1, 1000], human_pause_min: [0, 10080],
  };
  for (const [k, [min, max]] of Object.entries(limits)) {
    if (req.body?.[k] === undefined) continue;
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < min || n > max) bad(`${k} must be between ${min} and ${max}`);
    setSetting(k, Math.floor(n));
  }
  log('info', 'Settings updated');
}));
