import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import db from './db.js';
import { getSetting, setSetting, setSecret, getSecret, sendWebhook, appUrl } from './settings.js';
import { PREFIX } from './paths.js';

/* Auto content: asks Claude to write posts for the empty slots in your schedule.
   Approve first (default): posts are saved as drafts and wait for a click.
   Full auto: posts are scheduled straight away and the normal scheduler publishes them. */

const API = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const HOUR = 36e5, DAY = 864e5;
const MAX_PER_24H = 30;      // hard stop on generated posts per day, whatever the settings say
const MAX_PER_RUN = 14;

export const DEFAULTS = {
  enabled: false, mode: 'approve', accountId: null,
  topics: '', audience: '', tone: '', language: 'English', examples: '', avoid: '',
  days: [1, 3, 5], times: ['10:00'],       // 0 = Sunday ... 6 = Saturday, local time in `tz`
  horizonDays: 7, maxPerDay: 1, tz: 'UTC',
  inboundMode: 'draft'               // posts pushed in by n8n/Zapier: 'draft' (review first) or 'schedule'
};

export function getConfig() {
  let c = {}; try { c = JSON.parse(getSetting('auto_config') || '{}'); } catch { /* use defaults */ }
  return { ...DEFAULTS, ...c };
}
export const apiKey = () => getSecret('anthropic_key') || process.env.ANTHROPIC_API_KEY || '';
export const getModel = () => getSetting('auto_model') || DEFAULT_MODEL;
export const lastRun = () => { try { return JSON.parse(getSetting('auto_last') || 'null'); } catch { return null; } };
const setLast = (o) => setSetting('auto_last', JSON.stringify({ at: Date.now(), ...o }));

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

// Validates and saves the settings form. Returns { error } or { ok }.
export function saveConfig(body, userId) {
  const cur = getConfig(), c = body.config || {};
  const next = {
    enabled: !!c.enabled,
    mode: c.mode === 'auto' ? 'auto' : 'approve',
    accountId: c.accountId ? +c.accountId : null,
    topics: str(c.topics, 1500), audience: str(c.audience, 500), tone: str(c.tone, 300),
    language: ['English', 'Hinglish', 'Hindi'].includes(c.language) ? c.language : 'English',
    examples: str(c.examples, 4000), avoid: str(c.avoid, 500),
    days: [...new Set((Array.isArray(c.days) ? c.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort(),
    times: [...new Set((Array.isArray(c.times) ? c.times : []).map(String).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort().slice(0, 3),
    horizonDays: Math.min(14, Math.max(2, parseInt(c.horizonDays, 10) || 7)),
    maxPerDay: Math.min(3, Math.max(1, parseInt(c.maxPerDay, 10) || 1)),
    inboundMode: c.inboundMode === 'schedule' ? 'schedule' : 'draft',
    tz: validTz(c.tz) ? c.tz : cur.tz, updatedBy: userId
  };
  if (next.accountId && !db.prepare('select 1 from accounts where id=?').get(next.accountId)) return { error: 'Choose a connected account to post as' };
  if (next.enabled) {
    if (!next.accountId) return { error: 'Choose which account to post as' };
    if (!next.topics) return { error: 'Add at least one topic so Claude knows what to write about' };
    if (!next.days.length || !next.times.length) return { error: 'Pick at least one day and one time' };
    if (!(body.anthropicKey || apiKey())) return { error: 'Add your Anthropic API key first' };
  }
  setSetting('auto_config', JSON.stringify(next));
  if (typeof body.anthropicKey === 'string' && body.anthropicKey.trim()) setSecret('anthropic_key', body.anthropicKey.trim());
  if (body.clearKey) setSecret('anthropic_key', '');
  if (typeof body.model === 'string') setSetting('auto_model', /^[\w.:-]{3,80}$/.test(body.model.trim()) ? body.model.trim() : '');
  return { ok: true };
}

/* ---- time helpers: slots are entered in the user's own time zone ---- */
function zoned(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(guess)).reduce((o, p) => (p.type !== 'literal' ? { ...o, [p.type]: +p.value } : o), {});
  return guess - (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - guess);
}
const localDay = (ts, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ts)); // YYYY-MM-DD

// Future slots inside the horizon, minus the ones that already have a post.
export function emptySlots(cfg, now = Date.now()) {
  if (!cfg.accountId) return [];
  const out = [], tz = cfg.tz;
  const t0 = new Date(localDay(now, tz) + 'T00:00:00Z');
  const taken = db.prepare("select when_at from posts where account_id=? and status in ('draft','scheduled','publishing','published') and when_at between ? and ?")
    .all(cfg.accountId, now - DAY, now + (cfg.horizonDays + 2) * DAY).map((r) => r.when_at);
  const perDay = {};
  for (const t of taken) { const k = localDay(t, tz); perDay[k] = (perDay[k] || 0) + 1; }
  for (let i = 0; i < cfg.horizonDays; i++) {
    const d = new Date(t0.getTime() + i * DAY);
    if (!cfg.days.includes(d.getUTCDay())) continue;
    for (const hm of cfg.times) {
      const [hh, mm] = hm.split(':').map(Number);
      const ts = zoned(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, tz);
      if (ts < now + 30 * 60_000 || ts > now + cfg.horizonDays * DAY) continue;
      if (taken.some((t) => Math.abs(t - ts) < 3 * HOUR)) continue;       // slot already has a post
      const k = localDay(ts, tz);
      if ((perDay[k] || 0) >= cfg.maxPerDay) continue;                     // daily cap
      perDay[k] = (perDay[k] || 0) + 1;
      out.push(ts);
    }
  }
  return out.sort((a, b) => a - b);
}

/* ---- Claude ---- */
const words = (s) => new Set(String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3));
const similar = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / (A.size + B.size - n); };

const langName = (l) => ({ English: 'English', Hinglish: 'Hinglish (Hindi written in the Roman alphabet, mixed with English the way people speak)', Hindi: 'Hindi in Devanagari script' }[l] || 'English');
const rules = (cfg) => `Rules for every post:
- Language: ${langName(cfg.language)}.
- Start with a short hook line that earns the click. Short paragraphs, plenty of line breaks. Usually 600 to 1300 characters, never over 2500.
- Vary the format across the batch: a lesson, a numbered list, a contrarian opinion, a question for the audience, a mini framework.
- Never invent facts. No made-up statistics, studies, quotes, client names or events that supposedly happened to the author. Write from general knowledge, reasoning and opinion. If a personal story would help, write a short prompt-style post instead of pretending it happened.
- No emojis spam (at most 1 or 2), no more than 3 hashtags, no "I'm thrilled to announce", no engagement bait like "comment YES".
- Each post must stand on its own and differ clearly from the recent posts listed below.`;

const details = (cfg, recent) => [
    `Topics to write about:\n${cfg.topics}`,
    cfg.audience && `Audience: ${cfg.audience}`,
    cfg.tone && `Voice and tone: ${cfg.tone}`,
    cfg.avoid && `Avoid: ${cfg.avoid}`,
    cfg.examples && `Examples of the author's own writing (match the voice, don't copy):\n${cfg.examples}`,
    recent.length && `Recent posts, don't repeat these ideas:\n${recent.map((t, i) => `${i + 1}. ${t.slice(0, 280).replace(/\s+/g, ' ')}`).join('\n')}`
  ].filter(Boolean).join('\n\n');

function prompt(cfg, count, recent) {
  const system = `You write LinkedIn posts for one person, in their voice. Reply with JSON only, no markdown fences, no commentary.\n\n${rules(cfg)}\n\nReturn exactly: {"posts":[{"text":"..."}]} with ${count} item${count === 1 ? '' : 's'}.`;
  const user = `${details(cfg, recent)}\n\nWrite ${count} new post${count === 1 ? '' : 's'}.`;
  return { system, user };
}

async function askClaude({ system, user, max = 4000 }) {
  const key = apiKey();
  if (!key) throw new Error('No Anthropic API key set');
  const res = await fetch(`${API()}/v1/messages`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: getModel(), max_tokens: max, system, messages: [{ role: 'user', content: user }] })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = j?.error?.message || `Anthropic answered ${res.status}`;
    throw new Error(res.status === 401 ? 'Anthropic rejected the API key' : res.status === 429 ? 'Anthropic rate limit reached. Will retry later.' : m);
  }
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function parsePosts(text) {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const from = clean.indexOf('{'), to = clean.lastIndexOf('}');
  const j = JSON.parse(from >= 0 ? clean.slice(from, to + 1) : clean);
  return (Array.isArray(j.posts) ? j.posts : []).map((p) => String(p?.text ?? '').trim()).filter(Boolean);
}

const recentTexts = (accountId) => db.prepare("select text from posts where account_id=? and status!='failed' order by when_at desc limit 15").all(accountId).map((r) => r.text);

// Generates `count` fresh, de-duplicated posts.
async function write(cfg, count) {
  const recent = recentTexts(cfg.accountId), { system, user } = prompt(cfg, count, recent);
  const out = [];
  for (const t of parsePosts(await askClaude({ system, user }))) {
    if (t.length > 3000) continue;
    if ([...recent, ...out].some((r) => similar(t, r) > 0.55)) continue;
    out.push(t);
  }
  return out;
}

/* ---- the job ---- */
let running = false;
export async function runAuto({ force = false } = {}) {
  if (running) return { created: 0, busy: true };
  running = true;
  try {
    const cfg = getConfig();
    if (!force && !cfg.enabled) return { created: 0 };
    if (!cfg.accountId) throw new Error('Choose which account to post as');
    const acc = db.prepare('select * from accounts where id=?').get(cfg.accountId);
    if (!acc) throw new Error('The account was removed. Choose another one.');
    let slots = emptySlots(cfg);
    // Batch up: wait until a few slots are empty, unless the next one is close.
    if (!force && slots.length < Math.min(3, cfg.days.length * cfg.times.length) && !(slots[0] && slots[0] < Date.now() + DAY)) slots = [];
    const budget = MAX_PER_24H - db.prepare('select count(*) n from posts where ai=1 and created_at>?').get(Date.now() - DAY).n;
    slots = slots.slice(0, Math.max(0, Math.min(MAX_PER_RUN, budget)));
    if (!slots.length) { if (force) setLast({ ok: true, created: 0, note: 'Every slot already has a post' }); return { created: 0 }; }

    const texts = await write(cfg, slots.length);

    // The call above can take up to two minutes. In that time a webhook push, a paste-import or a person may have
    // taken some of the slots, or changed the settings. Decide what to do from the situation NOW, not the one before.
    const now = Date.now(), fresh = getConfig();
    if (fresh.accountId !== cfg.accountId || (!force && !fresh.enabled)) { setLast({ ok: true, created: 0, note: 'Settings changed while writing. Nothing was added.' }); return { created: 0 }; }
    const status = fresh.mode === 'auto' ? 'scheduled' : 'draft';
    const author = fresh.updatedBy || db.prepare("select id from users where role='admin' order by id limit 1").get()?.id || null;
    const ins = db.prepare("insert into posts(account_id,text,when_at,status,created_by,created_at,updated_at,type,ai) values(?,?,?,?,?,?,?,'text',1)");
    // Re-check the slots and insert in one transaction, so nothing can slip in between.
    const created = db.transaction(() => {
      const open = emptySlots(fresh, now).slice(0, texts.length);
      open.forEach((when, i) => ins.run(fresh.accountId, texts[i], when, status, author, now, now));
      return open.length;
    })();
    setLast({ ok: true, created, mode: fresh.mode, ...(created < texts.length ? { note: 'Some slots were filled while writing' } : {}) });
    if (created) sendWebhook(fresh.mode === 'auto'
      ? `Autopilot: ${created} AI post${created === 1 ? '' : 's'} scheduled for ${acc.name}${appUrl() ? ': ' + appUrl() + PREFIX + '/queue.html' : '.'}`
      : `Autopilot: ${created} new AI draft${created === 1 ? ' is' : 's are'} waiting for your approval${appUrl() ? ': ' + appUrl() + PREFIX + '/auto.html' : '.'}`).catch(() => {});
    return { created };
  } catch (e) {
    const prev = lastRun();
    setLast({ ok: false, error: e.message });
    // One alert per distinct error per day, so a bad key doesn't spam the webhook.
    if (!(prev && !prev.ok && prev.error === e.message && Date.now() - prev.at < DAY))
      sendWebhook(`Autopilot: auto content could not run. ${e.message}${appUrl() ? ' ' + appUrl() + PREFIX + '/auto.html' : ''}`).catch(() => {});
    throw e;
  } finally { running = false; }
}

export async function rewriteDraft(post) {
  const cfg = getConfig();
  if (!cfg.topics) throw new Error('Add topics in the Auto content settings first');
  const t = (await write({ ...cfg, accountId: post.account_id }, 1))[0];
  if (!t) throw new Error('Claude returned nothing new. Try again.');
  return t;
}

// Moves an unapproved draft to "scheduled". A slot that already passed posts about 10 minutes from now.
export function approve(id, now = Date.now()) {
  const p = db.prepare("select * from posts where id=? and status='draft'").get(id);
  if (!p) return null;
  const when = p.when_at < now + 2 * 60_000 ? now + 10 * 60_000 : p.when_at;
  db.prepare("update posts set status='scheduled', when_at=?, updated_at=?, error=null where id=? and status='draft'").run(when, now, id);
  return when;
}

/* ---- Free route: write in the claude.ai chat, bring the posts here ---- */
// Text to paste into a claude.ai chat. Asks for plain posts separated by a line with three dashes.
export function chatPrompt(cfg, count) {
  const recent = cfg.accountId ? recentTexts(cfg.accountId) : [];
  return `You write LinkedIn posts for one person, in their voice.

${rules(cfg)}

${details(cfg, recent)}

Write ${count} new post${count === 1 ? '' : 's'}.
Output format: only the post texts, one after another, with a line containing only --- between posts. No numbering, no titles, no commentary before or after.`;
}

// Splits pasted text into posts at lines that contain only ---
export function splitPosts(raw) {
  return String(raw || '').replace(/\r\n/g, '\n').split(/^\s*---+\s*$/m).map((t) => t.trim()).filter(Boolean);
}

/* Saves ready-made posts (pasted by you, or pushed in by n8n/Zapier) into the empty slots of your schedule.
   items: [{ text, when? }]. status 'draft' waits for approval; 'scheduled' goes out by itself. */
export function addPosts(items, { status = 'draft', userId = null } = {}) {
  const cfg = getConfig();
  if (!cfg.accountId || !db.prepare('select 1 from accounts where id=?').get(cfg.accountId)) throw Object.assign(new Error('Choose an account to post as in Auto content first'), { status: 422 });
  const now = Date.now(), recent = recentTexts(cfg.accountId), added = [];
  const slots = (cfg.days.length && cfg.times.length) ? emptySlots({ ...cfg, horizonDays: 60 }, now) : [];
  const skipped = { invalid: 0, duplicate: 0, noSlot: 0 };
  const author = userId || cfg.updatedBy || db.prepare("select id from users where role='admin' order by id limit 1").get()?.id || null;
  const ins = db.prepare("insert into posts(account_id,text,when_at,status,created_by,created_at,updated_at,type,ai) values(?,?,?,?,?,?,?,'text',1)");
  db.transaction(() => {
    for (const it of items) {
      const text = String(it?.text ?? '').trim();
      if (!text || text.length > 3000) { skipped.invalid++; continue; }
      if ([...recent, ...added.map((a) => a.text)].some((r) => similar(text, r) > 0.8)) { skipped.duplicate++; continue; }
      let when = it.when ? Date.parse(it.when) : NaN;
      if (!Number.isFinite(when) || when < now + 2 * 60_000) {
        when = slots.shift();
        if (!when) { skipped.noSlot++; continue; }
      } else { const k = slots.findIndex((s) => Math.abs(s - when) < 3 * HOUR); if (k >= 0) slots.splice(k, 1); }
      const r = ins.run(cfg.accountId, text, when, status, author, now, now);
      added.push({ id: r.lastInsertRowid, text, when_at: when, status });
    }
  })();
  return { created: added.length, skipped, posts: added.map(({ id, when_at, status }) => ({ id, when_at, status })) };
}

/* ---- Webhook token for n8n / Zapier / Make. Only a hash is kept, so it is shown once. ---- */
const sha = (t) => createHash('sha256').update(String(t)).digest();
export function newInboundToken() {
  const t = 'ap_' + randomBytes(24).toString('base64url');
  setSetting('inbound_token_hash', sha(t).toString('hex'));
  return t;
}
export const revokeInboundToken = () => setSetting('inbound_token_hash', '');
export const inboundSet = () => !!getSetting('inbound_token_hash');
export function checkInboundToken(t) {
  const h = getSetting('inbound_token_hash');
  if (!h || !t) return false;
  const a = Buffer.from(h, 'hex'), b = sha(t);
  return a.length === b.length && timingSafeEqual(a, b);
}
