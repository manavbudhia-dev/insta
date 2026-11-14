import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-unit-'));
const { matchesText, pickRule, render, clip, buildMessage } = await import('../src/engine.js');

const rule = (o: any) => ({
  id: 1, name: 'r', enabled: 1, trigger_type: 'dm', match_mode: 'contains', keywords: [], media_id: null,
  reply_text: 'hi', buttons: [], quick_replies: [], comment_replies: [], cooldown_minutes: 0, priority: 0, hits: 0, created_at: 0, ...o,
});

test('contains matches whole words only, case-insensitively', () => {
  const r = { match_mode: 'contains' as const, keywords: ['link', 'price list'] };
  assert.ok(matchesText(r, 'Send me the LINK please'));
  assert.ok(matchesText(r, 'link!'));
  assert.ok(matchesText(r, 'what is the   price list?'));
  assert.ok(!matchesText(r, 'blinking'));
  assert.ok(!matchesText(r, 'linked'));
  assert.ok(!matchesText(r, ''));
});

test('exact and any modes; non-latin keywords', () => {
  assert.ok(matchesText({ match_mode: 'exact', keywords: ['Yes'] }, '  yes '));
  assert.ok(!matchesText({ match_mode: 'exact', keywords: ['yes'] }, 'yes please'));
  assert.ok(matchesText({ match_mode: 'any', keywords: [] }, ''));
  assert.ok(matchesText({ match_mode: 'contains', keywords: ['कीमत'] }, 'इसकी कीमत क्या है'));
  assert.ok(matchesText({ match_mode: 'contains', keywords: ['c++ (v2)'] }, 'do you teach c++ (v2) ?'));
});

test('pickRule: keyword beats catch-all, priority wins, media filter applies', () => {
  const rules = [
    rule({ id: 1, match_mode: 'any' }),
    rule({ id: 2, keywords: ['price'] }),
    rule({ id: 3, keywords: ['price'], priority: 5 }),
    rule({ id: 4, keywords: ['price'], enabled: 0, priority: 9 }),
    rule({ id: 5, trigger_type: 'comment', keywords: ['price'], media_id: 'M1' }),
    rule({ id: 6, trigger_type: 'comment', keywords: ['price'] }),
  ];
  assert.equal(pickRule(rules, 'dm', 'price?')?.id, 3);
  assert.equal(pickRule(rules, 'dm', 'hello')?.id, 1);
  assert.equal(pickRule(rules, 'comment', 'price', 'M1')?.id, 5);
  assert.equal(pickRule(rules, 'comment', 'price', 'M2')?.id, 6);
  assert.equal(pickRule(rules, 'story_reply', 'price'), undefined);
});

test('render and clip', () => {
  assert.equal(render('Hi {{first_name}} (@{{ username }})', { name: 'Asha Rao', username: 'asha' }), 'Hi Asha (@asha)');
  assert.equal(render('Hi {{first_name}}', { username: 'asha' }), 'Hi asha');
  assert.equal(render('Hi {{first_name}}', {}), 'Hi there');
  const clipped = clip('é'.repeat(600), 1000);
  assert.ok(Buffer.byteLength(clipped) <= 1000);
  assert.ok(!clipped.includes('�'));
});

test('buildMessage shapes', () => {
  const withButtons = rule({ reply_text: 'Here', buttons: [{ title: 'Open', url: 'https://x.test' }] });
  const m: any = buildMessage(withButtons, {});
  assert.equal(m.attachment.payload.template_type, 'button');
  assert.deepEqual(m.attachment.payload.buttons[0], { type: 'web_url', url: 'https://x.test', title: 'Open' });
  assert.equal((buildMessage(withButtons, {}, true) as any).text, 'Here\n\nOpen: https://x.test');
  const q: any = buildMessage(rule({ quick_replies: ['Pricing'] }), {});
  assert.deepEqual(q.quick_replies, [{ content_type: 'text', title: 'Pricing', payload: 'Pricing' }]);
});
