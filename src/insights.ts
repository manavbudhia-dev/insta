/**
 * Metrics for the Insights page and data for the content calendar.
 *
 * Automation metrics come from this app's own database. Instagram metrics come from the Graph API:
 * follower counts, posts, likes and comments need only `instagram_basic`; reach, views, saves and
 * shares need `instagram_manage_insights` in the login configuration. Instagram calls are cached so
 * opening the page repeatedly does not eat into rate limits.
 */
import { db, getSetting, log } from './db.js';
import { acct, connected, ig, type IgError } from './instagram.js';

const DAY_MS = 86400_000;
const DM_KINDS = "('dm','story_reply','story_mention')";

// ---------------------------------------------------------------- follower history

db.exec(`CREATE TABLE IF NOT EXISTS ig_snapshots (
  account TEXT NOT NULL,
  day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  followers INTEGER, follows INTEGER, media_count INTEGER,
  taken_at INTEGER NOT NULL,
  PRIMARY KEY (account, day)
)`);

/** Instagram keeps no follower history for apps without insights access, so we record our own, once an hour. */
export async function takeSnapshot(): Promise<void> {
  if (!connected()) return;
  try {
    const p = await ig.get<any>(acct(), { fields: 'followers_count,follows_count,media_count' });
    db.prepare(`INSERT INTO ig_snapshots (account, day, followers, follows, media_count, taken_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account, day) DO UPDATE SET followers = excluded.followers, follows = excluded.follows, media_count = excluded.media_count, taken_at = excluded.taken_at`)
      .run(getSetting('ig_user_id'), new Date().toISOString().slice(0, 10), p.followers_count ?? null, p.follows_count ?? null, p.media_count ?? null, Date.now());
  } catch (e) {
    log('warn', `Could not record follower count: ${(e as Error).message}`);
  }
}
export function startSnapshots(): void {
  setTimeout(() => void takeSnapshot(), 15_000).unref();
  setInterval(() => void takeSnapshot(), 3600_000).unref();
}

// ---------------------------------------------------------------- Instagram data (cached)

const cache = new Map<string, { at: number; data: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}
export const clearInsightsCache = () => cache.clear();

export interface IgMedia {
  id: string; caption?: string; media_type?: string; media_product_type?: string; permalink?: string;
  thumbnail_url?: string; media_url?: string; timestamp?: string; like_count?: number; comments_count?: number;
}

/** The account's most recent posts (up to 100), newest first. */
export function recentMedia(): Promise<IgMedia[]> {
  return cached(`media:${getSetting('ig_user_id')}`, 15 * 60_000, async () => {
    const out: IgMedia[] = [];
    let res: any = await ig.get(`${acct()}/media`, {
      fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count', limit: 50,
    });
    out.push(...(res.data ?? []));
    if (res.paging?.next && out.length < 100) {
      res = await ig.next(res.paging.next);
      out.push(...(res.data ?? []));
    }
    return out;
  });
}

const noPermission = (e: unknown) => {
  const err = e as IgError;
  return err?.code === 10 || err?.code === 200 || /permission/i.test(err?.message ?? '');
};

const ACCOUNT_TOTALS = ['views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'profile_links_taps', 'follows_and_unfollows'];

/** Account-level insights. Needs instagram_manage_insights; Meta allows at most 30 days per request. */
export function accountInsights(days: number) {
  const span = Math.min(days, 30);
  return cached(`acct:${getSetting('ig_user_id')}:${span}`, 15 * 60_000, async () => {
    const until = Math.floor(Date.now() / 1000);
    const since = until - span * 86400;
    let reach: { date: string; value: number }[] = [];
    try {
      const r: any = await ig.get(`${acct()}/insights`, { metric: 'reach', period: 'day', metric_type: 'time_series', since, until });
      reach = (r.data?.[0]?.values ?? []).map((v: any) => ({ date: String(v.end_time ?? '').slice(0, 10), value: Number(v.value) || 0 }));
    } catch (e) {
      if (noPermission(e)) return { available: false, needsPermission: true, span, error: (e as Error).message, reach: [], totals: {} as Record<string, number> };
      return { available: false, needsPermission: false, span, error: (e as Error).message, reach: [], totals: {} as Record<string, number> };
    }
    // One request per metric: a metric Meta cannot return (e.g. follows below 100 followers) must not sink the rest.
    const totals: Record<string, number> = {};
    await Promise.all(ACCOUNT_TOTALS.map(async (m) => {
      try {
        const r: any = await ig.get(`${acct()}/insights`, { metric: m, period: 'day', metric_type: 'total_value', since, until });
        const v = r.data?.[0]?.total_value?.value;
        if (typeof v === 'number') totals[m] = v;
      } catch {
        /* not available for this account */
      }
    }));
    return { available: true, needsPermission: false, span, error: '', reach, totals };
  });
}

/** Per-post reach, views, saves and shares for the most recent posts (needs instagram_manage_insights). */
async function mediaInsights(m: IgMedia): Promise<Record<string, number> | null> {
  if (m.media_product_type === 'STORY') return null;
  return cached(`mi:${m.id}`, 60 * 60_000, async () => {
    const read = async (metrics: string) => {
      const r: any = await ig.get(`/${m.id}/insights`, { metric: metrics });
      const out: Record<string, number> = {};
      for (const d of r.data ?? []) out[d.name] = Number(d.values?.[0]?.value ?? d.total_value?.value) || 0;
      return out;
    };
    try {
      return await read('reach,views,saved,shares,total_interactions');
    } catch (e) {
      if (noPermission(e)) throw e;
      try {
        return await read('reach');
      } catch {
        return null;
      }
    }
  });
}

export async function instagramMetrics(days: number) {
  if (!connected()) return { connected: false };
  const id = getSetting('ig_user_id');
  // First visit (or a new day before the hourly job ran): record today's follower count now.
  if (!db.prepare('SELECT 1 FROM ig_snapshots WHERE account = ? AND day = ?').get(id, new Date().toISOString().slice(0, 10))) await takeSnapshot();
  const [media, insights] = await Promise.all([recentMedia(), accountInsights(days)]);
  const top = media.slice(0, 18);
  let perPost: Record<string, Record<string, number> | null> = {};
  if (insights.available) {
    const queue = [...top];
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try { perPost[m.id] = await mediaInsights(m); } catch { perPost[m.id] = null; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } else perPost = {};
  const snaps = db.prepare('SELECT day, followers, follows, media_count FROM ig_snapshots WHERE account = ? AND day >= ? ORDER BY day')
    .all(id, new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)) as { day: string; followers: number; follows: number; media_count: number }[];
  const first = db.prepare('SELECT MIN(day) d FROM ig_snapshots WHERE account = ?').get(id) as { d: string | null };
  return {
    connected: true,
    account: {
      username: getSetting('ig_username'), followers: Number(getSetting('ig_followers', '0')) || snaps.at(-1)?.followers || 0,
      mediaCount: snaps.at(-1)?.media_count ?? null, follows: snaps.at(-1)?.follows ?? null,
    },
    followers: snaps.map((s) => ({ date: s.day, value: s.followers })),
    trackingSince: first.d,
    media: top.map((m) => ({ ...m, insights: perPost[m.id] ?? null })),
    insights,
  };
}

// ---------------------------------------------------------------- automation metrics (local)

/** Everything the Insights page shows about conversations and automations for a period. */
export function automationMetrics(days: number, tzMinutes: number) {
  const now = Date.now();
  const off = tzMinutes * 60_000;
  const today = Math.floor((now + off) / DAY_MS);
  const start = (today - days + 1) * DAY_MS - off;
  const prevStart = start - days * DAY_MS;
  const one = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
  const pair = (sql: string) => ({ value: one(sql, start, now + 1), prev: one(sql, prevStart, start) });

  const totals = {
    received: pair(`SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND kind IN ${DM_KINDS} AND created_at >= ? AND created_at < ?`),
    comments: pair("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND kind = 'comment' AND created_at >= ? AND created_at < ?"),
    autoReplies: pair("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND source = 'auto' AND kind IN ('dm','private_reply') AND sent_at >= ? AND sent_at < ?"),
    manualReplies: pair("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND source = 'manual' AND sent_at >= ? AND sent_at < ?"),
    commentReplies: pair("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND kind = 'comment_reply' AND sent_at >= ? AND sent_at < ?"),
    newContacts: pair('SELECT COUNT(*) n FROM contacts WHERE first_seen >= ? AND first_seen < ?'),
    flowRuns: pair('SELECT COUNT(*) n FROM flow_runs WHERE started_at >= ? AND started_at < ?'),
  };

  // Daily series in the viewer's timezone.
  const series = (sql: string) => {
    const m = new Map<number, number>();
    for (const r of db.prepare(sql).all(off, start) as { d: number; n: number }[]) m.set(r.d, r.n);
    return Array.from({ length: days }, (_, i) => m.get(today - days + 1 + i) ?? 0);
  };
  const dates = Array.from({ length: days }, (_, i) => new Date((today - days + 1 + i) * DAY_MS).toISOString().slice(0, 10));
  const daily = {
    dates,
    received: series(`SELECT CAST((created_at + ?) / 86400000 AS INTEGER) d, COUNT(*) n FROM messages WHERE direction = 'in' AND kind IN ${DM_KINDS} AND created_at >= ? GROUP BY d`),
    sent: series("SELECT CAST((sent_at + ?) / 86400000 AS INTEGER) d, COUNT(*) n FROM outbox WHERE status = 'sent' AND kind IN ('dm','private_reply') AND sent_at >= ? GROUP BY d"),
  };

  // First-reply time: from a person's message to the next message we sent them, within 24 hours.
  const msgs = db.prepare(`SELECT igsid, direction, created_at FROM messages WHERE created_at >= ? AND (direction = 'out' OR kind IN ${DM_KINDS}) ORDER BY igsid, created_at LIMIT 50000`)
    .all(start) as { igsid: string; direction: string; created_at: number }[];
  const waits: number[] = [];
  let pending: number | null = null;
  let who = '';
  for (const m of msgs) {
    if (m.igsid !== who) { who = m.igsid; pending = null; }
    if (m.direction === 'in') pending ??= m.created_at;
    else if (pending !== null) {
      if (m.created_at - pending <= DAY_MS) waits.push(m.created_at - pending);
      pending = null;
    }
  }
  waits.sort((a, b) => a - b);
  const q = (p: number) => (waits.length ? waits[Math.min(waits.length - 1, Math.floor(p * waits.length))] : null);
  const response = { median: q(0.5), p90: q(0.9), within5m: waits.length ? Math.round((waits.filter((w) => w <= 300_000).length / waits.length) * 100) : null, count: waits.length };

  // When people reach out: weekday (Mon=0) x hour, local time.
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of db.prepare(`SELECT created_at FROM messages WHERE direction = 'in' AND created_at >= ? LIMIT 100000`).all(start) as { created_at: number }[]) {
    const d = new Date(r.created_at + off);
    heat[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++;
  }

  const automations = (db.prepare(`SELECT COALESCE(r.name, f.name, 'Deleted automation') name, CASE WHEN o.flow_id IS NOT NULL THEN 'flow' ELSE 'rule' END kind, COUNT(*) n
      FROM outbox o LEFT JOIN rules r ON r.id = o.rule_id LEFT JOIN flows f ON f.id = o.flow_id
      WHERE o.status = 'sent' AND o.source = 'auto' AND o.sent_at >= ? AND (o.rule_id IS NOT NULL OR o.flow_id IS NOT NULL)
      GROUP BY o.rule_id, o.flow_id ORDER BY n DESC LIMIT 8`).all(start)) as { name: string; kind: string; n: number }[];

  const flows = (db.prepare(`SELECT f.id, f.name, f.enabled,
      SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END) started,
      SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) finished,
      SUM(CASE WHEN r.status IN ('running','waiting') THEN 1 ELSE 0 END) active,
      SUM(CASE WHEN r.status IN ('expired','cancelled','failed') THEN 1 ELSE 0 END) dropped
      FROM flows f LEFT JOIN flow_runs r ON r.flow_id = f.id AND r.started_at >= ?
      GROUP BY f.id ORDER BY started DESC, f.name LIMIT 20`).all(start)) as any[];

  const delivery = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) n FROM outbox WHERE created_at >= ? GROUP BY status`).all(start) as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const reasons = db.prepare(`SELECT status, error, COUNT(*) n FROM outbox WHERE created_at >= ? AND status IN ('failed','skipped') AND error IS NOT NULL
      GROUP BY status, error ORDER BY n DESC LIMIT 5`).all(start) as { status: string; error: string; n: number }[];

  const tagCounts = new Map<string, number>();
  for (const r of db.prepare("SELECT tags FROM contacts WHERE tags != '[]'").all() as { tags: string }[]) {
    try { for (const t of JSON.parse(r.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1); } catch { /* ignore */ }
  }
  const tags = [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n }));

  return { days, totals, daily, response, heat, automations, flows, delivery, reasons, tags };
}

// ---------------------------------------------------------------- calendar

/** Posts scheduled or published in [from, to), plus posts on Instagram that were not published from here. */
export async function calendar(from: number, to: number) {
  const posts = (db.prepare(`SELECT * FROM posts WHERE (COALESCE(published_at, scheduled_at) >= ? AND COALESCE(published_at, scheduled_at) < ?)
      ORDER BY COALESCE(published_at, scheduled_at) LIMIT 1000`).all(from, to) as any[]).map((p) => ({ ...p, media: JSON.parse(p.media) }));
  let instagram: any[] = [];
  let error = '';
  if (connected()) {
    try {
      const ours = new Set((db.prepare('SELECT ig_media_id FROM posts WHERE ig_media_id IS NOT NULL').all() as { ig_media_id: string }[]).map((r) => r.ig_media_id));
      const media = await recentMedia();
      const byId = new Map(media.map((m) => [m.id, m]));
      for (const p of posts) {
        const m = p.ig_media_id && byId.get(p.ig_media_id);
        if (m) p.instagram = { permalink: m.permalink ?? '', likes: m.like_count ?? 0, comments: m.comments_count ?? 0 };
      }
      instagram = media
        .filter((m) => m.timestamp && !ours.has(m.id))
        .map((m) => ({ id: m.id, at: Date.parse(m.timestamp!), caption: m.caption ?? '', type: m.media_product_type === 'REELS' ? 'REELS' : m.media_type === 'CAROUSEL_ALBUM' ? 'CAROUSEL' : m.media_product_type === 'STORY' ? 'STORIES' : 'IMAGE',
          thumb: m.thumbnail_url ?? (m.media_type === 'VIDEO' ? '' : m.media_url ?? ''), permalink: m.permalink ?? '', likes: m.like_count ?? 0, comments: m.comments_count ?? 0 }))
        .filter((m) => m.at >= from && m.at < to);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return { posts, instagram, error };
}
