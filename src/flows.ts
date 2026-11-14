/**
 * Visual automation flows.
 *
 * A flow is a graph: one trigger node, then nodes joined by edges. Each edge leaves a named output
 * port of one node ("next", "yes", "q0" for the first quick reply, ...) and enters another node.
 * A run is one contact travelling through a flow. Runs stop at nodes that wait (for a reply, or for a
 * delay) and are resumed by the next inbound message, a button tap, or the flow timer.
 *
 * Every message goes through the normal send queue, so the 24-hour window, hourly caps, human takeover
 * pause and retries apply to flows exactly as they do to simple rules.
 */
import { config } from './config.js';
import { db, firstTime, log } from './db.js';
import { clip, render, type Rule, type TriggerType } from './engine.js';
import { enqueue } from './queue.js';

export const NODE_TYPES = ['trigger', 'message', 'media', 'wait_reply', 'condition', 'delay', 'comment_reply', 'tag', 'split', 'handoff'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
const TRIGGERS: TriggerType[] = ['dm', 'comment', 'story_reply', 'story_mention', 'welcome'];

export interface FNode { id: string; type: NodeType; x: number; y: number; data: any }
export interface FEdge { id: string; from: string; port: string; to: string }
export interface Graph { nodes: FNode[]; edges: FEdge[] }
export interface Issue { level: 'error' | 'warning'; node?: string; message: string }

const MAX_NODES = 150;
const MAX_STEPS_PER_ADVANCE = 40;
const REPLY_WAIT_MS = 24 * 3600_000;
/** Shrinks delays and reply timeouts in tests only (e.g. 0.001 turns a minute into 60 ms). */
const TIME_SCALE = Number(process.env.FLOW_TIME_SCALE ?? 1) || 1;

// ---------------------------------------------------------------- graph shape

/** Output ports of a node, in display order. Must match portsOf() in public/builder.js. */
export function portsOf(n: Pick<FNode, 'type' | 'data'>): string[] {
  const d = n.data ?? {};
  switch (n.type) {
    case 'message': {
      const opts = [
        ...(d.buttons ?? []).map((b: any, i: number) => (b.kind === 'flow' ? `b${i}` : null)).filter(Boolean),
        ...(d.buttons?.length ? [] : (d.quick ?? []).map((_: unknown, i: number) => `q${i}`)),
      ];
      return opts.length ? [...opts, 'other'] : ['next'];
    }
    case 'wait_reply':
      return ['reply', ...(d.validate && d.validate !== 'any' ? ['invalid'] : []), ...(d.timeout_minutes > 0 ? ['timeout'] : [])];
    case 'condition':
      return ['yes', 'no'];
    case 'split':
      return ['a', 'b'];
    case 'handoff':
      return [];
    default:
      return ['next'];
  }
}

class GraphError extends Error {}
const fail = (m: string): never => {
  throw new GraphError(m);
};
export { GraphError };

const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const int = (v: unknown, min: number, max: number, dflt = min) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const list = (v: unknown, maxItems: number, maxLen: number) =>
  (Array.isArray(v) ? v : []).map((s) => String(s ?? '').trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems);
const chars = (s: string, n: number) => [...s].slice(0, n).join('');
const VAR_RE = /^[a-z][a-z0-9_]{0,30}$/;

function cleanData(type: NodeType, d: any): any {
  d = d && typeof d === 'object' ? d : {};
  switch (type) {
    case 'trigger': {
      const on = TRIGGERS.includes(d.on) ? d.on : 'dm';
      let match = ['contains', 'exact', 'any'].includes(d.match_mode) ? d.match_mode : 'contains';
      if (on === 'welcome' || on === 'story_mention') match = 'any';
      return {
        on, match_mode: match, keywords: match === 'any' ? [] : list(d.keywords, 50, 100),
        media_id: on === 'comment' && d.media_id ? str(d.media_id, 64) : null,
        cooldown_minutes: int(d.cooldown_minutes, 0, 525600), priority: int(d.priority, -100, 100, 0),
      };
    }
    case 'message': {
      const buttons = (Array.isArray(d.buttons) ? d.buttons : []).slice(0, 3).map((b: any) => ({
        title: chars(str(b?.title, 80).trim(), 20),
        kind: b?.kind === 'flow' ? 'flow' : 'url',
        url: b?.kind === 'flow' ? '' : str(b?.url, 1000).trim(),
      }));
      return { text: str(d.text, 2000), buttons, quick: buttons.length ? [] : list(d.quick, 13, 80).map((q) => chars(q, 20)) };
    }
    case 'media':
      return { url: str(d.url, 1000).trim(), kind: d.kind === 'video' ? 'video' : 'image' };
    case 'wait_reply':
      return {
        save_as: VAR_RE.test(String(d.save_as ?? '')) ? d.save_as : '',
        validate: ['any', 'email', 'phone', 'number'].includes(d.validate) ? d.validate : 'any',
        timeout_minutes: int(d.timeout_minutes, 0, 23 * 60 + 59),
      };
    case 'condition':
      return {
        check: ['text', 'variable', 'tag'].includes(d.check) ? d.check : 'text',
        variable: VAR_RE.test(String(d.variable ?? '')) ? d.variable : '',
        op: ['contains', 'exact', 'is_set'].includes(d.op) ? d.op : 'contains',
        values: list(d.values, 30, 100),
      };
    case 'delay': {
      const unit = d.unit === 'hours' ? 'hours' : 'minutes';
      return { amount: int(d.amount, 1, unit === 'hours' ? 23 : 23 * 60, unit === 'hours' ? 1 : 5), unit };
    }
    case 'comment_reply':
      return { variants: list(d.variants, 10, 300) };
    case 'tag':
      return { action: d.action === 'remove' ? 'remove' : 'add', tag: str(d.tag, 30).trim().replace(/[^\p{L}\p{N} _-]/gu, '') };
    case 'split':
      return { percent_a: int(d.percent_a, 1, 99, 50) };
    case 'handoff':
      return { pause_hours: int(d.pause_hours, 0, 168, 24) };
  }
}

/** Normalise an untrusted graph from the dashboard: known types and fields only, valid edges only. */
export function sanitizeGraph(input: any): Graph {
  const rawNodes = Array.isArray(input?.nodes) ? input.nodes : [];
  if (rawNodes.length > MAX_NODES) fail(`A flow can have at most ${MAX_NODES} steps`);
  const nodes: FNode[] = [];
  const seen = new Set<string>();
  for (const n of rawNodes) {
    const id = str(n?.id, 40);
    if (!/^[\w-]{1,40}$/.test(id) || seen.has(id)) fail('Invalid or duplicate step id');
    if (!NODE_TYPES.includes(n.type)) fail(`Unknown step type: ${str(n?.type, 30)}`);
    seen.add(id);
    nodes.push({ id, type: n.type, x: int(n.x, -50000, 50000, 0), y: int(n.y, -50000, 50000, 0), data: cleanData(n.type, n.data) });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: FEdge[] = [];
  const used = new Set<string>();
  for (const e of Array.isArray(input?.edges) ? input.edges.slice(0, MAX_NODES * 14) : []) {
    const from = byId.get(str(e?.from, 40));
    const to = byId.get(str(e?.to, 40));
    const port = str(e?.port, 20);
    if (!from || !to || to.type === 'trigger' || !portsOf(from).includes(port)) continue; // dangling edges are dropped
    const key = `${from.id}:${port}`;
    if (used.has(key)) continue; // one connection per output
    used.add(key);
    edges.push({ id: str(e?.id, 40) || `e_${from.id}_${port}`, from: from.id, port, to: to.id });
  }
  return { nodes, edges };
}

const isHttps = (u: string) => /^https:\/\/[^\s]+$/i.test(u) || (u.startsWith(config.baseUrl + '/media/') && config.baseUrl.startsWith('https://'));

/** Problems that would stop a flow working (errors) or make it behave unexpectedly (warnings). */
export function validateGraph(g: Graph): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string, node?: string) => issues.push({ level: 'error', node, message });
  const warn = (message: string, node?: string) => issues.push({ level: 'warning', node, message });
  const triggers = g.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) err('Add a trigger: every flow starts with one.');
  if (triggers.length > 1) triggers.slice(1).forEach((t) => err('A flow can only have one trigger.', t.id));
  const trigger = triggers[0];
  const out = (id: string, port: string) => g.edges.find((e) => e.from === id && e.port === port);

  for (const n of g.nodes) {
    const d = n.data;
    if (n.type === 'trigger' && d.match_mode !== 'any' && !d.keywords.length) err('Add at least one keyword, or choose "any message".', n.id);
    if (n.type === 'message') {
      if (!d.text.trim()) err('This message is empty.', n.id);
      if (Buffer.byteLength(d.text) > 1000) err('Messages can be at most 1000 bytes.', n.id);
      if (d.buttons.length && [...d.text].length > 640) err('With buttons, a message can be at most 640 characters.', n.id);
      d.buttons.forEach((b: any, i: number) => {
        if (!b.title) err(`Button ${i + 1} needs a title.`, n.id);
        if (b.kind === 'url' && !isHttps(b.url)) err(`Button ${i + 1} needs an https:// link.`, n.id);
      });
    }
    if (n.type === 'media' && !isHttps(d.url)) err('Upload an image or paste an https:// link.', n.id);
    if (n.type === 'condition' && d.check === 'variable' && !d.variable) err('Choose which saved answer to check.', n.id);
    if (n.type === 'condition' && d.op !== 'is_set' && !d.values.length) err('Add at least one value to compare with.', n.id);
    if (n.type === 'tag' && !d.tag) err('Name the tag.', n.id);
    if (n.type === 'comment_reply' && !d.variants.length) err('Write at least one public reply.', n.id);
    if (n.type === 'comment_reply' && trigger && trigger.data.on !== 'comment') warn('Public replies only work when the flow starts from a comment.', n.id);
    if (n.type === 'wait_reply' && d.validate !== 'any' && !out(n.id, 'invalid')) warn('Connect "Invalid" so people who type something else get a reply.', n.id);
  }
  if (trigger && !out(trigger.id, 'next')) err('Connect the trigger to the first step.', trigger.id);

  // Reachability, and Instagram's comment rule: one private reply, then nothing until the person replies.
  if (trigger) {
    const reached = new Set<string>();
    const seenState = new Set<string>();
    const walk = (id: string, port: string, privateLeft: boolean, windowOpen: boolean) => {
      const e = out(id, port);
      if (!e) return;
      const key = `${e.to}:${privateLeft}:${windowOpen}`;
      if (seenState.has(key)) return;
      seenState.add(key);
      reached.add(e.to);
      const n = g.nodes.find((x) => x.id === e.to)!;
      let pl = privateLeft;
      if (n.type === 'message' || n.type === 'media') {
        if (pl) {
          pl = false;
          if (n.type === 'media') warn('The first reply to a comment must be a text message; Instagram does not allow images there.', n.id);
        } else if (!windowOpen) {
          warn('This will not be delivered: after replying to a comment, Instagram allows nothing more until the person answers. Add buttons, quick replies or "Wait for reply" before it.', n.id);
        }
      }
      for (const p of portsOf(n)) {
        // Any port reached because the person answered re-opens the 24-hour window.
        const answered = (n.type === 'message' && p !== 'next') || (n.type === 'wait_reply' && p !== 'timeout');
        walk(n.id, p, pl, windowOpen || answered);
      }
    };
    const fromComment = trigger.data.on === 'comment';
    walk(trigger.id, 'next', fromComment, !fromComment);
    for (const n of g.nodes) {
      if (n.type !== 'trigger' && !reached.has(n.id)) warn('Not connected: this step can never run.', n.id);
    }
  }
  return issues;
}

// ---------------------------------------------------------------- storage

export interface FlowRow {
  id: number; name: string; enabled: number; graph: string; trigger_type: string; priority: number;
  runs: number; created_at: number; updated_at: number;
}
export interface Flow extends Omit<FlowRow, 'graph'> { graph: Graph }

export const parseFlow = (row: FlowRow): Flow => ({ ...row, graph: JSON.parse(row.graph) });
export function getFlow(id: number): Flow | undefined {
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as FlowRow | undefined;
  return row ? parseFlow(row) : undefined;
}
const triggerOf = (g: Graph) => g.nodes.find((n) => n.type === 'trigger');

/** Enabled flows as rule-shaped candidates, so they compete with simple rules on the same terms. */
export function flowCandidates(): (Rule & { flowId: number })[] {
  return (db.prepare('SELECT * FROM flows WHERE enabled = 1').all() as FlowRow[]).flatMap((row) => {
    const t = triggerOf(JSON.parse(row.graph));
    if (!t) return [];
    // Negative ids sort ahead of rules on a tie, so a flow wins over a rule with the same priority.
    return [{
      id: -row.id, flowId: row.id, name: row.name, enabled: 1, trigger_type: t.data.on, match_mode: t.data.match_mode,
      keywords: t.data.keywords, media_id: t.data.media_id, reply_text: '', buttons: [], quick_replies: [], comment_replies: [],
      cooldown_minutes: t.data.cooldown_minutes, priority: t.data.priority, hits: row.runs, created_at: row.created_at,
    }];
  });
}

export function flowOnCooldown(flowId: number, igsid: string): boolean {
  const f = getFlow(flowId);
  const minutes = f ? triggerOf(f.graph)?.data.cooldown_minutes ?? 0 : 0;
  if (!minutes) return false;
  return !!db.prepare('SELECT 1 FROM flow_runs WHERE flow_id = ? AND igsid = ? AND started_at > ? LIMIT 1').get(flowId, igsid, Date.now() - minutes * 60_000);
}

// ---------------------------------------------------------------- runs

interface Run {
  id: number; flow_id: number; igsid: string; status: string; node_id: string | null; wait: string | null;
  resume_at: number | null; expires_at: number | null; vars: string; comment_id: string | null;
  private_sent: number; last_text: string; steps: number; started_at: number;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

function renderVars(template: string, contact: { username?: string | null; name?: string | null }, vars: Record<string, string>): string {
  const withVars = template.replace(/\{\{\s*([a-z][a-z0-9_]{0,30})\s*\}\}/gi, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k.toLowerCase()) ? vars[k.toLowerCase()] : m);
  return render(withVars, contact);
}

function contactOf(igsid: string): { username: string | null; name: string | null; tags: string[]; paused_until: number } {
  const c = db.prepare('SELECT username, name, tags, paused_until FROM contacts WHERE igsid = ?').get(igsid) as any;
  return { username: c?.username ?? null, name: c?.name ?? null, tags: safeJson(c?.tags, []), paused_until: c?.paused_until ?? 0 };
}
function safeJson<T>(s: unknown, fallback: T): T {
  try {
    return s ? JSON.parse(String(s)) : fallback;
  } catch {
    return fallback;
  }
}

const hitStmt = db.prepare('INSERT INTO flow_stats (flow_id, node_id, hits) VALUES (?, ?, 1) ON CONFLICT(flow_id, node_id) DO UPDATE SET hits = hits + 1');
const saveRun = db.prepare(`UPDATE flow_runs SET status = @status, node_id = @node_id, wait = @wait, resume_at = @resume_at, expires_at = @expires_at,
  vars = @vars, private_sent = @private_sent, last_text = @last_text, steps = @steps, updated_at = @updated_at WHERE id = @id`);

function persist(run: Run): void {
  saveRun.run({ ...run, updated_at: Date.now() });
}

/** The Send API `message` for a message step, plus the text stored in the inbox. */
export function buildFlowMessage(flowId: number, node: FNode, text: string, privateReply: boolean): { payload: any; preview: string } {
  const d = node.data;
  if (privateReply) {
    // Instagram documents private replies as text only: links and choices are written into the text.
    const links = d.buttons.filter((b: any) => b.kind === 'url').map((b: any) => `${b.title}: ${b.url}`);
    const choices = [...d.buttons.filter((b: any) => b.kind === 'flow').map((b: any) => b.title), ...d.quick];
    const extra = [links.join('\n'), choices.length ? `Reply with: ${choices.join(' · ')}` : ''].filter(Boolean).join('\n\n');
    const full = clip(extra ? `${text}\n\n${extra}` : text, 1000);
    return { payload: { text: full }, preview: full };
  }
  if (d.buttons.length) {
    return {
      payload: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: chars(text, 640),
            buttons: d.buttons.map((b: any, i: number) =>
              b.kind === 'flow'
                ? { type: 'postback', title: b.title, payload: `flow:${flowId}:${node.id}:b${i}` }
                : { type: 'web_url', title: b.title, url: b.url }),
          },
        },
      },
      preview: text,
    };
  }
  const payload: any = { text: clip(text, 1000) };
  if (d.quick.length) {
    payload.quick_replies = d.quick.map((title: string, i: number) => ({ content_type: 'text', title, payload: `flow:${flowId}:${node.id}:q${i}` }));
  }
  return { payload, preview: payload.text };
}

const VALIDATORS: Record<string, (s: string) => boolean> = {
  any: (s) => s.trim().length > 0,
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim()),
  phone: (s) => /^\+?[\d\s().-]{7,20}$/.test(s.trim()) && s.replace(/\D/g, '').length >= 7,
  number: (s) => /^-?\d+([.,]\d+)?$/.test(s.trim()),
};

function evaluate(d: any, run: Run, vars: Record<string, string>, tags: string[]): boolean {
  if (d.check === 'tag') return d.values.some((v: string) => tags.some((t) => norm(t) === norm(v)));
  const subject = d.check === 'variable' ? vars[d.variable] ?? '' : run.last_text ?? '';
  if (d.op === 'is_set') return subject.trim().length > 0;
  const t = norm(subject);
  return d.values.some((raw: string) => {
    const k = norm(raw);
    if (!k) return false;
    if (d.op === 'exact') return t === k;
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(t);
  });
}

/**
 * Move a run along the edge leaving `fromId` through `port`, executing steps until one has to wait
 * or the path ends. Everything here is synchronous, so two events for the same person cannot interleave.
 */
function advance(run: Run, flow: Flow, fromId: string, port: string): void {
  const g = flow.graph;
  const vars: Record<string, string> = safeJson(run.vars, {});
  let at = fromId;
  let via = port;
  run.status = 'running';
  run.wait = null;
  run.resume_at = null;
  run.expires_at = null;

  for (let i = 0; ; i++) {
    const edge = g.edges.find((e) => e.from === at && e.port === via);
    const node = edge && g.nodes.find((n) => n.id === edge.to);
    if (!node) {
      run.status = 'done';
      break;
    }
    if (i >= MAX_STEPS_PER_ADVANCE || run.steps >= 500) {
      run.status = 'failed';
      log('warn', `Flow "${flow.name}" stopped: too many steps without waiting (check for a loop)`);
      break;
    }
    run.steps++;
    run.node_id = node.id;
    hitStmt.run(flow.id, node.id);
    const d = node.data;
    const contact = contactOf(run.igsid);
    at = node.id;
    via = 'next';

    if (node.type === 'message') {
      const text = renderVars(d.text, contact, vars);
      const privateReply = !!run.comment_id && !run.private_sent;
      const { payload, preview } = buildFlowMessage(flow.id, node, text, privateReply);
      if (privateReply) {
        enqueue({ kind: 'private_reply', target: run.comment_id!, igsid: run.igsid, flowId: flow.id, payload, preview });
        run.private_sent = 1;
      } else {
        enqueue({ kind: 'dm', target: run.igsid, igsid: run.igsid, flowId: flow.id, payload, preview });
      }
      if (portsOf(node)[0] !== 'next') {
        run.status = 'waiting';
        run.wait = 'reply';
        run.expires_at = Date.now() + REPLY_WAIT_MS;
        break;
      }
    } else if (node.type === 'media') {
      if (run.comment_id && !run.private_sent) {
        log('warn', `Flow "${flow.name}": skipped an image, the first reply to a comment must be text`);
      } else {
        enqueue({ kind: 'dm', target: run.igsid, igsid: run.igsid, flowId: flow.id, payload: { attachment: { type: d.kind, payload: { url: d.url } } }, preview: `[${d.kind}] ${d.url}` });
      }
    } else if (node.type === 'wait_reply') {
      run.status = 'waiting';
      run.wait = 'reply';
      run.resume_at = d.timeout_minutes > 0 ? Date.now() + d.timeout_minutes * 60_000 * TIME_SCALE : null;
      run.expires_at = Date.now() + REPLY_WAIT_MS;
      break;
    } else if (node.type === 'condition') {
      via = evaluate(d, run, vars, contact.tags) ? 'yes' : 'no';
    } else if (node.type === 'delay') {
      run.status = 'waiting';
      run.wait = 'delay';
      run.resume_at = Date.now() + d.amount * (d.unit === 'hours' ? 3600_000 : 60_000) * TIME_SCALE;
      break;
    } else if (node.type === 'comment_reply') {
      if (run.comment_id && d.variants.length) {
        const text = renderVars(d.variants[Math.floor(Math.random() * d.variants.length)], contact, vars);
        enqueue({ kind: 'comment_reply', target: run.comment_id, igsid: run.igsid, flowId: flow.id, payload: { message: text }, preview: text });
      }
    } else if (node.type === 'tag') {
      const tags = new Set(contact.tags);
      if (d.action === 'add') tags.add(d.tag);
      else for (const t of [...tags]) if (norm(t) === norm(d.tag)) tags.delete(t);
      db.prepare('UPDATE contacts SET tags = ? WHERE igsid = ?').run(JSON.stringify([...tags].slice(0, 50)), run.igsid);
    } else if (node.type === 'split') {
      via = Math.random() * 100 < d.percent_a ? 'a' : 'b';
    } else if (node.type === 'handoff') {
      const until = d.pause_hours ? Date.now() + d.pause_hours * 3600_000 : 0;
      db.prepare('UPDATE contacts SET paused_until = ? WHERE igsid = ?').run(until, run.igsid);
      // Messages this flow queued just before handing off still go out; only later automation is paused.
      db.prepare("UPDATE outbox SET ignore_pause = 1 WHERE igsid = ? AND flow_id = ? AND status = 'pending'").run(run.igsid, flow.id);
      log('info', `Flow "${flow.name}" handed @${contact.username ?? run.igsid} over to you${d.pause_hours ? ` (automation paused ${d.pause_hours}h)` : ''}`);
      run.status = 'done';
      break;
    }
  }
  run.vars = JSON.stringify(vars);
  persist(run);
}

function newRun(flow: Flow, igsid: string, ctx: { text?: string; commentId?: string }): Run {
  db.prepare("UPDATE flow_runs SET status = 'cancelled', updated_at = ? WHERE igsid = ? AND status IN ('running','waiting')").run(Date.now(), igsid);
  const now = Date.now();
  const info = db.prepare(`INSERT INTO flow_runs (flow_id, igsid, status, vars, comment_id, last_text, started_at, updated_at)
    VALUES (?, ?, 'running', '{}', ?, ?, ?, ?)`).run(flow.id, igsid, ctx.commentId ?? null, ctx.text ?? '', now, now);
  db.prepare('UPDATE flows SET runs = runs + 1 WHERE id = ?').run(flow.id);
  return db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(Number(info.lastInsertRowid)) as Run;
}

/** Start a flow for one person (its trigger matched). */
export function startRun(flowId: number, igsid: string, ctx: { text?: string; commentId?: string } = {}): void {
  const flow = getFlow(flowId);
  if (!flow?.enabled) return;
  const trigger = triggerOf(flow.graph);
  if (!trigger) return;
  const run = newRun(flow, igsid, ctx);
  hitStmt.run(flow.id, trigger.id);
  advance(run, flow, trigger.id, 'next');
}

function finish(run: Run, status: string): void {
  run.status = status;
  run.wait = null;
  persist(run);
}

/**
 * Offer an inbound DM to the flows first. Returns true when a flow consumed it, in which case
 * simple rules must not also answer it.
 */
export function resumeFromInbound(igsid: string, text: string, payload?: string): boolean {
  // 1. A tap on a flow button or quick reply. Works even after the run expired, as long as the flow is on.
  const m = /^flow:(\d+):([\w-]{1,40}):([a-z]\d{0,2})$/.exec(payload ?? '');
  if (m) {
    const flow = getFlow(Number(m[1]));
    const node = flow?.graph.nodes.find((n) => n.id === m[2]);
    if (flow?.enabled && node && portsOf(node).includes(m[3])) {
      let run = db.prepare("SELECT * FROM flow_runs WHERE igsid = ? AND flow_id = ? AND node_id = ? AND status = 'waiting' AND wait = 'reply' ORDER BY id DESC LIMIT 1")
        .get(igsid, flow.id, node.id) as Run | undefined;
      if (!run) {
        if (!firstTime(`flowtap:${igsid}:${payload}:${Math.floor(Date.now() / 5000)}`)) return true; // double tap
        run = newRun(flow, igsid, { text });
      }
      run.last_text = text;
      advance(run, flow, node.id, m[3]);
      return true;
    }
  }

  // 2. An answer to a run that is waiting for one.
  const run = db.prepare("SELECT * FROM flow_runs WHERE igsid = ? AND status = 'waiting' AND wait = 'reply' ORDER BY id DESC LIMIT 1").get(igsid) as Run | undefined;
  if (!run) return false;
  if (run.expires_at && run.expires_at < Date.now()) {
    finish(run, 'expired');
    return false;
  }
  const flow = getFlow(run.flow_id);
  const node = flow?.graph.nodes.find((n) => n.id === run.node_id);
  if (!flow?.enabled || !node) {
    finish(run, 'cancelled');
    return false;
  }
  run.last_text = text;
  const has = (p: string) => flow.graph.edges.some((e) => e.from === node.id && e.port === p);

  if (node.type === 'message') {
    const d = node.data;
    const t = norm(text);
    const flowButtons = d.buttons.map((b: any, i: number) => ({ b, i })).filter(({ b }: any) => b.kind === 'flow');
    const hitBtn = flowButtons.find(({ b }: any) => norm(b.title) === t);
    const hitQuick = d.quick.findIndex((q: string) => norm(q) === t);
    const port = hitBtn ? `b${hitBtn.i}` : hitQuick >= 0 ? `q${hitQuick}` : 'other';
    if (port === 'other' && !has('other')) {
      finish(run, 'done'); // nothing to do with a free-text answer here: let the simple rules have it
      return false;
    }
    advance(run, flow, node.id, port);
    return true;
  }
  if (node.type === 'wait_reply') {
    const d = node.data;
    const ok = (VALIDATORS[d.validate] ?? VALIDATORS.any)(text);
    if (ok && d.save_as) {
      const vars = safeJson<Record<string, string>>(run.vars, {});
      vars[d.save_as] = text.trim().slice(0, 500);
      run.vars = JSON.stringify(vars);
    }
    const port = ok ? 'reply' : 'invalid';
    if (!has(port) && port === 'invalid') {
      finish(run, 'done');
      return false;
    }
    advance(run, flow, node.id, port);
    return true;
  }
  finish(run, 'cancelled');
  return false;
}

/** After a private reply, Instagram tells us the commenter's messaging ID; keep their run attached to it. */
export function moveRuns(fromIgsid: string, toIgsid: string): void {
  db.prepare("UPDATE flow_runs SET igsid = ? WHERE igsid = ? AND status IN ('running','waiting')").run(toIgsid, fromIgsid);
}

/** Resume delays, fire reply timeouts, expire stale waits. */
export function tickFlows(): void {
  const now = Date.now();
  const due = db.prepare("SELECT * FROM flow_runs WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= ? ORDER BY resume_at LIMIT 50").all(now) as Run[];
  for (const run of due) {
    try {
      const flow = getFlow(run.flow_id);
      const node = flow?.graph.nodes.find((n) => n.id === run.node_id);
      if (!flow?.enabled || !node) {
        finish(run, 'cancelled');
        continue;
      }
      const c = contactOf(run.igsid);
      if (c.paused_until > now) {
        finish(run, 'cancelled'); // the owner took over this chat
        continue;
      }
      if (run.wait === 'delay') advance(run, flow, node.id, 'next');
      else if (run.wait === 'reply') {
        if (flow.graph.edges.some((e) => e.from === node.id && e.port === 'timeout')) advance(run, flow, node.id, 'timeout');
        else finish(run, 'expired');
      }
    } catch (e) {
      log('error', `Flow run #${run.id} failed: ${(e as Error).message}`);
      finish(run, 'failed');
    }
  }
  db.prepare("UPDATE flow_runs SET status = 'expired' WHERE status = 'waiting' AND wait = 'reply' AND resume_at IS NULL AND expires_at < ?").run(now);
  db.prepare("DELETE FROM flow_runs WHERE status NOT IN ('running','waiting') AND updated_at < ?").run(now - 30 * 86400_000);
}

export function startFlowTimer(): NodeJS.Timeout {
  const t = setInterval(() => {
    try {
      tickFlows();
    } catch (e) {
      log('error', `Flow timer error: ${(e as Error).message}`);
    }
  }, Number(process.env.FLOW_TICK_MS ?? 15_000));
  t.unref();
  return t;
}

