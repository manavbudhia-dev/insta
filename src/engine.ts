import { db, firstTime, log, opt } from './db.js';
import { getProfile, isOwnAccount } from './instagram.js';
import { enqueue } from './queue.js';

export type TriggerType = 'dm' | 'comment' | 'story_reply' | 'story_mention' | 'welcome';

export interface Rule {
  id: number;
  name: string;
  enabled: number;
  trigger_type: TriggerType;
  match_mode: 'contains' | 'exact' | 'any';
  keywords: string[];
  media_id: string | null;
  reply_text: string;
  buttons: { title: string; url: string }[];
  quick_replies: string[];
  comment_replies: string[];
  cooldown_minutes: number;
  priority: number;
  hits: number;
  created_at: number;
}

export function parseRule(row: any): Rule {
  return {
    ...row,
    keywords: JSON.parse(row.keywords),
    buttons: JSON.parse(row.buttons),
    quick_replies: JSON.parse(row.quick_replies),
    comment_replies: JSON.parse(row.comment_replies),
  };
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** "contains" matches whole words/phrases, so the keyword "link" does not fire on "blink". */
export function matchesText(rule: Pick<Rule, 'match_mode' | 'keywords'>, text: string): boolean {
  if (rule.match_mode === 'any') return true;
  const t = norm(text);
  if (!t) return false;
  return rule.keywords.some((raw) => {
    const k = norm(raw);
    if (!k) return false;
    if (rule.match_mode === 'exact') return t === k;
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(t);
  });
}

/** Highest priority first; at equal priority keyword rules beat catch-all rules, then oldest first. */
export function pickRule(rules: Rule[], trigger: TriggerType, text: string, mediaId?: string): Rule | undefined {
  return rules
    .filter((r) => r.enabled && r.trigger_type === trigger)
    .filter((r) => trigger !== 'comment' || !r.media_id || r.media_id === mediaId)
    .filter((r) => matchesText(r, text))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        Number(a.match_mode === 'any') - Number(b.match_mode === 'any') ||
        Number(!!b.media_id) - Number(!!a.media_id) ||
        a.id - b.id,
    )[0];
}

export function render(template: string, c: { username?: string | null; name?: string | null }): string {
  const first = (c.name ?? '').trim().split(/\s+/)[0] || c.username || 'there';
  return template
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, (c.name ?? '').trim() || c.username || 'there')
    .replace(/\{\{\s*username\s*\}\}/gi, c.username ?? 'there');
}

/** Truncate to a UTF-8 byte budget without splitting a character. */
export function clip(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (used + n > maxBytes - 3) break;
    out += ch;
    used += n;
  }
  return out + '…';
}

/** Build the Send API `message` object for a rule. */
export function buildMessage(rule: Rule, contact: { username?: string | null; name?: string | null }, forPrivateReply = false) {
  const text = render(rule.reply_text, contact);
  if (forPrivateReply) {
    // Private replies are kept to plain text; button links are appended so nothing is lost.
    const links = rule.buttons.map((b) => `${b.title}: ${b.url}`).join('\n');
    return { text: clip(links ? `${text}\n\n${links}` : text, 1000) };
  }
  if (rule.buttons.length) {
    return {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: [...text].slice(0, 640).join(''),
          buttons: rule.buttons.slice(0, 3).map((b) => ({ type: 'web_url', url: b.url, title: b.title })),
        },
      },
    };
  }
  const message: any = { text: clip(text, 1000) };
  if (rule.quick_replies.length) {
    message.quick_replies = rule.quick_replies.slice(0, 13).map((title) => ({
      content_type: 'text',
      title: [...title].slice(0, 20).join(''),
      payload: title,
    }));
  }
  return message;
}

function activeRules(): Rule[] {
  return db.prepare('SELECT * FROM rules WHERE enabled = 1').all().map(parseRule);
}

function onCooldown(rule: Rule, igsid: string): boolean {
  if (!rule.cooldown_minutes) return false;
  const since = Date.now() - rule.cooldown_minutes * 60_000;
  const sent = db
    .prepare("SELECT 1 FROM outbox WHERE rule_id = ? AND igsid = ? AND created_at > ? AND status IN ('pending','sent') LIMIT 1")
    .get(rule.id, igsid, since);
  return !!sent;
}

interface Contact {
  igsid: string;
  username: string | null;
  name: string | null;
  last_inbound_at: number | null;
  paused_until: number;
  profile_checked: number;
}

export function upsertContact(igsid: string, fields: { username?: string; name?: string } = {}): { contact: Contact; isNew: boolean } {
  const existing = db.prepare('SELECT * FROM contacts WHERE igsid = ?').get(igsid) as Contact | undefined;
  if (!existing) {
    db.prepare('INSERT INTO contacts (igsid, username, name, first_seen) VALUES (?, ?, ?, ?)').run(
      igsid, fields.username ?? null, fields.name ?? null, Date.now(),
    );
  } else if (fields.username || fields.name) {
    db.prepare('UPDATE contacts SET username = COALESCE(?, username), name = COALESCE(?, name) WHERE igsid = ?').run(
      fields.username ?? null, fields.name ?? null, igsid,
    );
  }
  return { contact: db.prepare('SELECT * FROM contacts WHERE igsid = ?').get(igsid) as Contact, isNew: !existing };
}

async function ensureProfile(contact: Contact): Promise<Contact> {
  if (contact.profile_checked) return contact;
  db.prepare('UPDATE contacts SET profile_checked = 1 WHERE igsid = ?').run(contact.igsid);
  try {
    const p = await getProfile(contact.igsid);
    return upsertContact(contact.igsid, { username: p.username, name: p.name }).contact;
  } catch {
    return contact; // profile lookups are best-effort
  }
}

const insertMessage = db.prepare(
  'INSERT OR IGNORE INTO messages (igsid, direction, kind, text, mid, rule_id, source, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
export function recordMessage(m: {
  igsid: string; direction: 'in' | 'out'; kind: string; text?: string | null; mid?: string | null;
  ruleId?: number | null; source?: string; meta?: unknown; at?: number;
}): void {
  insertMessage.run(
    m.igsid, m.direction, m.kind, m.text ?? null, m.mid ?? null, m.ruleId ?? null, m.source ?? null,
    m.meta ? JSON.stringify(m.meta) : null, m.at ?? Date.now(),
  );
}

// ---------- inbound direct messages ----------

export interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    quick_reply?: { payload?: string };
    attachments?: { type: string; payload?: { url?: string } }[];
    reply_to?: { mid?: string; story?: { id?: string; url?: string } };
  };
  postback?: { mid?: string; title?: string; payload?: string };
}

export async function handleMessaging(ev: MessagingEvent): Promise<void> {
  const msg = ev.message;
  const senderId = ev.sender?.id;
  if (!senderId) return;

  if (msg?.is_echo) return handleEcho(ev);
  if (isOwnAccount(senderId) || msg?.is_deleted) return;

  const mid = msg?.mid ?? ev.postback?.mid;
  if (mid && !firstTime(`mid:${mid}`)) return;

  const text = msg?.text ?? ev.postback?.title ?? '';
  const attachmentTypes = (msg?.attachments ?? []).map((a) => a.type);
  let kind: 'dm' | 'story_reply' | 'story_mention' = 'dm';
  if (attachmentTypes.includes('story_mention')) kind = 'story_mention';
  else if (msg?.reply_to?.story) kind = 'story_reply';

  const up = upsertContact(senderId);
  const now = Date.now();
  db.prepare('UPDATE contacts SET last_inbound_at = ? WHERE igsid = ?').run(now, senderId);
  const priorInbound = db.prepare("SELECT 1 FROM messages WHERE igsid = ? AND direction = 'in' AND kind != 'comment' LIMIT 1").get(senderId);
  recordMessage({
    igsid: senderId, direction: 'in', kind, mid,
    text: text || (attachmentTypes.length ? `[${attachmentTypes.join(', ')}]` : ''),
    meta: attachmentTypes.length ? { attachments: msg?.attachments } : undefined,
  });

  if (!opt('automation_enabled')) return;
  if (up.contact.paused_until > now) return;

  const contact = await ensureProfile(up.contact);
  const rules = activeRules();
  let rule = pickRule(rules, kind, text);
  // A story reply/mention with no dedicated rule falls back to ordinary DM rules.
  if (!rule && kind !== 'dm') rule = pickRule(rules, 'dm', text);
  // First-ever message: prefer a keyword match, otherwise greet with the welcome rule.
  if (!priorInbound && (!rule || rule.match_mode === 'any')) {
    rule = pickRule(rules, 'welcome', text) ?? rule;
  }
  if (!rule || onCooldown(rule, senderId)) return;

  enqueue({
    kind: 'dm', target: senderId, igsid: senderId, ruleId: rule.id,
    payload: buildMessage(rule, contact), preview: render(rule.reply_text, contact),
  });
  db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(rule.id);
}

/**
 * Echoes are copies of messages sent by the business account. If we did not send it,
 * the owner replied by hand in the Instagram app, so automation backs off for that chat.
 */
async function handleEcho(ev: MessagingEvent): Promise<void> {
  const mid = ev.message?.mid;
  const igsid = ev.recipient?.id;
  if (!mid || !igsid) return;
  const known = () => db.prepare('SELECT 1 FROM messages WHERE mid = ?').get(mid);
  if (!known()) await new Promise((r) => setTimeout(r, 4000)); // our own send may still be recording
  if (known()) return;
  upsertContact(igsid);
  recordMessage({ igsid, direction: 'out', kind: 'dm', text: ev.message?.text ?? '[attachment]', mid, source: 'human' });
  const pauseMin = opt('human_pause_min');
  db.prepare('UPDATE contacts SET last_outbound_at = ?, paused_until = ? WHERE igsid = ?').run(
    Date.now(), pauseMin ? Date.now() + pauseMin * 60_000 : 0, igsid,
  );
}

// ---------- inbound comments ----------

export interface CommentEvent {
  id: string;
  text?: string;
  from?: { id?: string; username?: string };
  username?: string;
  media?: { id?: string };
  mediaId?: string;
  parent_id?: string;
  timestamp?: number;
}

export function handleComment(c: CommentEvent): void {
  if (!c.id || !firstTime(`comment:${c.id}`)) return;
  const fromId = c.from?.id;
  const username = c.from?.username ?? c.username;
  if (isOwnAccount(fromId) || (username && username === ownUsername())) return;

  const mediaId = c.media?.id ?? c.mediaId;
  const contactId = fromId ?? `user:${username ?? 'unknown'}`;
  upsertContact(contactId, { username });
  recordMessage({ igsid: contactId, direction: 'in', kind: 'comment', text: c.text ?? '', mid: `comment:${c.id}`, meta: { mediaId, commentId: c.id } });

  if (!opt('automation_enabled')) return;
  const rule = pickRule(activeRules(), 'comment', c.text ?? '', mediaId);
  if (!rule || onCooldown(rule, contactId)) return;

  const contact = { username, name: null };
  if (rule.reply_text.trim()) {
    enqueue({
      kind: 'private_reply', target: c.id, igsid: contactId, ruleId: rule.id,
      payload: buildMessage(rule, contact, true), preview: render(rule.reply_text, contact),
    });
  }
  if (rule.comment_replies.length) {
    const variant = rule.comment_replies[Math.floor(Math.random() * rule.comment_replies.length)];
    const text = render(variant, contact);
    enqueue({ kind: 'comment_reply', target: c.id, igsid: contactId, ruleId: rule.id, payload: { message: text }, preview: text });
  }
  db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(rule.id);
  log('info', `Comment by @${username ?? fromId} matched rule "${rule.name}"`);
}

function ownUsername(): string {
  return (db.prepare("SELECT value FROM settings WHERE key = 'ig_username'").get() as { value: string } | undefined)?.value ?? '';
}
