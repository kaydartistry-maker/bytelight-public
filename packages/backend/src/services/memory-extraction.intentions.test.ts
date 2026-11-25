// The Archivist catches promises nobody filed: an intention op is filed
// straight into intentions (no approval), marked as caught; one already filed,
// one whose time has gone by, or one from a stranger is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { loadConfig } = await import('../config.js');
loadConfig(join(mkdtempSync(join(tmpdir(), 'archivist-intentions-')), 'no-config.yaml'));

const { initDb, getDb } = await import('./db/init.js');
const { seatResidents } = await import('../test-support/pair-house.js');
const { applyOps, promisesBriefing, buildArchivistPrompt } = await import('./memory-extraction.js');
const { listOpenIntentions, fileCaughtIntention, createIntention, getIntention } = await import('./db/intentions.js');

function freshHouse(): void {
  initDb(':memory:');
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO threads (id, name, type, created_at, last_activity_at) VALUES ('home', 'Home', 'named', ?, ?)").run(now, now);
  // Phase 1.1: nobody is seeded; seat the pair this test expects.
  seatResidents(getDb(), ['home']);
  for (const [slug, name] of [['river', 'River'], ['stone', 'Stone']]) {
    getDb().prepare("INSERT OR IGNORE INTO companions (id, display_name, brain) VALUES (?, ?, 'test')").run(slug, name);
  }
}

const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

test('a caught promise is filed straight away, marked as the Archivist’s, in its thread', () => {
  freshHouse();
  const { applied } = applyOps([
    { op: 'intention', scope: '', label: '', companion: 'companion-a', text: 'ask how the meeting went', at: null, on_status_clears: true },
    { op: 'intention', scope: '', label: '', companion: 'companion-b', text: 'check she ate after her shift', at: inAnHour() },
  ] as never, 'home');
  assert.equal(applied, 2);
  const open = listOpenIntentions();
  assert.deepEqual(open.map((i) => [i.companion, i.source, i.threadId, i.onStatusClears]), [
    ['companion-a', 'archivist', 'home', true],
    ['companion-b', 'archivist', 'home', false],
  ]);
});

test('already filed, already past, or not from a companion here: skipped, never thrown', () => {
  freshHouse();
  createIntention({ companion: 'companion-a', text: 'ask how the meeting went', onStatusClears: true, threadId: 'home' });
  assert.equal(fileCaughtIntention({ companion: 'companion-a', text: 'Ask how the meeting went', on_status_clears: true }, 'home'), 'already filed');
  assert.equal(fileCaughtIntention({ companion: 'companion-a', text: 'old one', at: new Date(Date.now() - 60 * 60_000).toISOString() }, 'home'), 'already past');
  assert.equal(fileCaughtIntention({ companion: 'pat', text: 'x', at: inAnHour() }, 'home'), 'refused');
  assert.equal(fileCaughtIntention({ companion: 'companion-a', text: 'no when at all' }, 'home'), 'refused');
  const { applied, skipped } = applyOps([{ op: 'intention', scope: '', label: '', companion: 'pat', text: 'x', at: inAnHour() }] as never, 'home');
  assert.equal(applied, 0);
  assert.match(skipped[0], /intention pat: refused/);
  assert.equal(listOpenIntentions().length, 1);
});

test('the briefing gives the Archivist now with its offset, and every open one with its id', () => {
  freshHouse();
  const at = inAnHour();
  const { intention } = createIntention({ companion: 'companion-b', text: 'dentist Monday 2:30', at, threadId: 'home' });
  const { intention: loose } = createIntention({ companion: 'river', text: 'ask how the interview went', onStatusClears: true, threadId: 'home', kind: 'loose_end' });
  const text = promisesBriefing('America/New_York', new Date('2026-10-26T15:00:00Z'));
  assert.match(text, /UTC offset -04:00/);
  assert.match(text, /Open follow-ups/);
  assert.ok(text.includes(`- id ${intention.id} | companion-b | companion follow-up | pending | at ${at} | "dentist Monday 2:30"`));
  assert.ok(text.includes(`- id ${loose.id} | river | loose end | pending | when their status clears | "ask how the interview went"`));
});

test('the Archivist prompt says what belongs on the page about the owner', () => {
  const prompt = buildArchivistPrompt('Owner', ['river', 'stone'], ['River', 'Stone']);
  assert.match(prompt, /labelled "human", that block is the page about Owner as a person/);
  assert.match(prompt, /A durable fact about their life belongs there/);
  assert.match(prompt, /Notes about building or running the house's software never belong on it\./);
  // Still bound by the rule that keeps it from inventing blocks.
  assert.match(prompt, /NEVER invent a new label/);
});

test('the Archivist prompt carries the hard rules word for word, listens to her, and skips work to-dos', () => {
  const prompt = buildArchivistPrompt('Owner', ['river', 'stone'], ['River', 'Stone']);
  assert.ok(prompt.includes('Time having passed is never a reason to resolve.'));
  assert.ok(prompt.includes('An event being due is not evidence that it happened.'));
  assert.ok(prompt.includes('A reply that does not actually answer an open item is never resolve or update, however close the subject sounds.'));
  assert.match(prompt, /notice .*update .*resolve .*cancel .*none/s);
  assert.match(prompt, /"op":"intention_update"/);
  assert.match(prompt, /"op":"intention_resolve"/);
  assert.match(prompt, /"op":"intention_cancel"/);
  assert.match(prompt, /kind "loose_end": Owner's OWN loose ends/);
  assert.match(prompt, /NEVER file a companion's work or build to-dos/);
  assert.match(prompt, /never a promise Owner made/);
  assert.doesNotMatch(prompt, /not Owner's own plans/);
});

test('the Archivist closes an open one only on her own words from the batch', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'river', text: 'ask how the dentist went', at: inAnHour(), threadId: 'home', kind: 'loose_end' });
  // No evidence, a paraphrase, or no words of hers at all: refused.
  let r = applyOps([{ op: 'intention_resolve', id: intention.id, evidence: 'the appointment time has passed' }] as never, 'home', { herWords: 'dentist was easy, no cavities' });
  assert.equal(r.applied, 0);
  assert.match(r.skipped[0], /no evidence/);
  r = applyOps([{ op: 'intention_resolve', id: intention.id, evidence: '"no cavities"' }] as never, 'home');
  assert.match(r.skipped[0], /no evidence/);
  assert.equal(getIntention(intention.id)?.state, 'pending');
  // Her words: resolved, and the words are kept.
  r = applyOps([{ op: 'intention_resolve', id: intention.id, evidence: '"dentist was easy, no cavities"' }] as never, 'home', { herWords: 'dentist was easy, no cavities' });
  assert.equal(r.applied, 1);
  assert.equal(getIntention(intention.id)?.state, 'resolved');
  assert.equal(getIntention(intention.id)?.closeNote, '"dentist was easy, no cavities"');
  // An unknown id is skipped, never thrown.
  r = applyOps([{ op: 'intention_cancel', id: 'nope', reason: '"x"' }] as never, 'home', { herWords: 'x' });
  assert.match(r.skipped[0], /not open/);
});

test('the Archivist updates an open one by id instead of filing it twice', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'river', text: 'ask how the dentist appointment went', at: inAnHour(), threadId: 'home', kind: 'loose_end' });
  const later = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  const r = applyOps([
    { op: 'intention_update', id: intention.id, at: later },
    { op: 'intention', kind: 'loose_end', companion: 'stone', text: 'ask her how her dentist appointment went', at: later },
  ] as never, 'home', { herWords: 'dentist got moved to 5' });
  assert.equal(r.applied, 1);
  assert.match(r.skipped[0], /already filed/);
  assert.equal(getIntention(intention.id)?.at, later);
  assert.equal(listOpenIntentions().length, 1);
});
