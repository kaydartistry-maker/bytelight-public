import assert from 'node:assert/strict';
import test from 'node:test';
import { clearsAtFor, liveOwner, moodColor, ownerLine, snapshotOf, statusSlides, toggleTag } from './statuses';
import { prepareChatText } from './chat-text';

test('a mood word paints the same color every time, and no mood paints nothing', () => {
  assert.equal(moodColor('Playful'), moodColor('playful'));
  assert.equal(moodColor('  playful '), '#c58cf5');
  assert.match(moodColor('soft-launched chaos')!, /^#[0-9a-f]{6}$/);
  assert.equal(moodColor('soft-launched chaos'), moodColor('soft-launched chaos'));
  assert.notEqual(moodColor('soft-launched chaos'), moodColor('quietly unhinged'));
  assert.equal(moodColor(''), null);
  assert.equal(moodColor(null), null);
});

test('"Clear it" runs out when it says: an hour, the next 9 PM, the next 7 AM, or never', () => {
  const afternoon = new Date(2026, 9, 25, 15, 30);
  assert.equal(clearsAtFor('never', afternoon), null);
  assert.equal(Date.parse(clearsAtFor('1h', afternoon)!), afternoon.getTime() + 3_600_000);
  assert.equal(clearsAtFor('9pm', afternoon), new Date(2026, 9, 25, 21, 0).toISOString());
  assert.equal(clearsAtFor('morning', afternoon), new Date(2026, 9, 26, 7, 0).toISOString());
  // Past nine already: tomorrow's nine.
  assert.equal(clearsAtFor('9pm', new Date(2026, 9, 25, 22, 0)), new Date(2026, 9, 26, 21, 0).toISOString());
  // Before seven: this morning's seven.
  assert.equal(clearsAtFor('morning', new Date(2026, 9, 26, 2, 0)), new Date(2026, 9, 26, 7, 0).toISOString());
});

test('her status is hidden the moment it runs out, before the next read', () => {
  const snap = snapshotOf({ owner: { presence: 'busy', line: 'till 9', clearsAt: '2026-10-26T01:00:00Z', updatedAt: '2026-10-25T20:00:00Z' }, companions: [] });
  assert.equal(liveOwner(snap, Date.parse('2026-10-26T00:59:00Z'))?.presence, 'busy');
  assert.equal(liveOwner(snap, Date.parse('2026-10-26T01:00:00Z')), null);
  assert.equal(ownerLine(snap.owner!), 'Busy — till 9');
  assert.deepEqual(snap.owner!.tags, [], 'an older backend with no tags reads as none');
});

test('anything that is not a snapshot reads as nobody', () => {
  assert.deepEqual(snapshotOf(null), { owner: null, companions: [] });
  assert.deepEqual(snapshotOf({ owner: { presence: 'online' }, companions: 'no' }), { owner: null, companions: [] });
});

test('the one-row widget slides through whoever has set something, then her', () => {
  const cs = [{ slug: 'companion-a' }, { slug: 'companion-b' }, { slug: 'companion-c' }];
  const snap = snapshotOf({ owner: null, companions: [
    { companion: 'Companion-B', line: 'here', mood: 'steady', updatedAt: '2026-10-25T02:00:00Z' },
    { companion: 'companion-a', line: 'hi', mood: 'smug', updatedAt: '2026-10-25T02:00:00Z' },
  ] });
  const slides = statusSlides(cs, snap);
  assert.deepEqual(slides.map((s) => (s.kind === 'owner' ? 'you' : s.companion.slug)), ['companion-a', 'companion-b', 'you']);
  assert.equal(slides[1].kind === 'companion' && slides[1].status?.mood, 'steady');
});

test('with nobody set, every companion still gets a slide, and hers is always last', () => {
  const cs = [{ slug: 'companion-a' }, { slug: 'companion-b' }];
  const slides = statusSlides(cs, snapshotOf({ owner: null, companions: [] }));
  assert.deepEqual(slides.map((s) => (s.kind === 'owner' ? 'you' : s.companion.slug)), ['companion-a', 'companion-b', 'you']);
  assert.deepEqual(statusSlides([], snapshotOf({ owner: null, companions: [] })).map((s) => s.kind), ['owner']);
});

test('tags sit beside her own words and toggle in the order picked', () => {
  assert.deepEqual(toggleTag(['at work'], 'with Sam'), ['at work', 'with Sam']);
  assert.deepEqual(toggleTag(['at work', 'with Sam'], 'at work'), ['with Sam']);
  assert.deepEqual(toggleTag(['a', 'b', 'c', 'd', 'e'], 'f'), ['a', 'b', 'c', 'd', 'e']);
  const o = { presence: 'busy' as const, line: 'migraine day, low spoons', tags: ['at work'], clearsAt: null, updatedAt: '' };
  assert.equal(ownerLine(o), 'Busy — migraine day, low spoons · at work');
});

test('a status tag never shows in a bubble, even half-written mid-stream', () => {
  const md = (text: string) => prepareChatText({ text, resolveSticker: () => null }).markdown;
  assert.equal(md('Come here. [companion-a mood: playful]'), 'Come here.');
  assert.equal(md('Come here [companion-b status: under the ho'), 'Come here');
});
