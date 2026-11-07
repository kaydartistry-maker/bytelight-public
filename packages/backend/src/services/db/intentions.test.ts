// Intentions: a promise is filed once, rides an impulse that comes due at its
// time or when her status clears, closes when she answers, gets one nudge if
// she doesn't, then rests; never inside the quiet hours.
import test from 'node:test';
import assert from 'node:assert/strict';

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { loadConfig } = await import('../../config.js');
loadConfig(join(mkdtempSync(join(tmpdir(), 'intentions-test-')), 'no-config.yaml'));

const { initDb, getDb } = await import('./init.js');
const {
  createIntention,
  cancelIntention,
  getIntention,
  getIntentionForTrigger,
  listOpenIntentions,
  markAsked,
  markNudged,
  followUps,
  inQuietWindow,
  intentionPrompt,
  nudgePrompt,
  intentionsContext,
  IntentionError,
} = await import('./intentions.js');
const { evaluateConditions } = await import('../triggers.js');
const { createMessage } = await import('../db.js');

const T0 = new Date('2026-10-25T18:00:00Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const opts = { quiet: false, nudgeAfterMinutes: 24 * 60, restAfterMinutes: 24 * 60 };

function freshHouse(): void {
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM companions').run();
  for (const [slug, name] of [['companion-a', 'Companion A'], ['companion-b', 'Companion B']] as const) {
    db.prepare("INSERT INTO companions (id, display_name, brain) VALUES (?, ?, 'test')").run(slug, name);
  }
  db.prepare("INSERT INTO threads (id, name, type, created_at, last_activity_at) VALUES ('home', 'Home', 'named', ?, ?)").run(T0.toISOString(), T0.toISOString());
}

function say(role: 'user' | 'companion', at: Date, content = 'hi'): { id: string; createdAt: string } {
  const id = `${role}-${at.getTime()}`;
  createMessage({ id, threadId: 'home', role, content, createdAt: at.toISOString() });
  return { id, createdAt: at.toISOString() };
}

test('a promise is filed on an impulse, and the same promise is not filed twice', () => {
  freshHouse();
  const { intention, existing } = createIntention({ companion: 'Companion-A', text: 'ask how  the meeting went', at: later(60).toISOString(), threadId: 'home' }, T0);
  assert.equal(existing, false);
  assert.equal(intention.companion, 'companion-a');
  assert.equal(intention.text, 'ask how the meeting went');
  assert.equal(intention.at, later(60).toISOString());
  const trigger = getDb().prepare('SELECT kind, status FROM triggers WHERE id = ?').get(intention.triggerId) as { kind: string; status: string };
  assert.deepEqual(trigger, { kind: 'impulse', status: 'pending' });
  assert.equal(getIntentionForTrigger(intention.triggerId)?.id, intention.id);

  const again = createIntention({ companion: 'companion-a', text: 'Ask how the meeting went', at: later(90).toISOString() }, T0);
  assert.equal(again.existing, true);
  assert.equal(again.intention.id, intention.id);
});

test('a promise needs a companion who lives here, words, and a when', () => {
  freshHouse();
  assert.throws(() => createIntention({ companion: 'companion-c', text: 'x', at: T0.toISOString() }), IntentionError);
  assert.throws(() => createIntention({ companion: 'companion-a', text: '  ', at: T0.toISOString() }), IntentionError);
  assert.throws(() => createIntention({ companion: 'companion-a', text: 'x' }), IntentionError);
  assert.throws(() => createIntention({ companion: 'companion-a', text: 'x', at: 'tuesday-ish' }), IntentionError);
});

test('`after` comes due at its time; status_clears only once armed and she is clear', () => {
  const base = { presenceNow: 'active', presencePrev: 'active', agentFree: true, statusText: '', hour: 12, minute: 0 } as const;
  const at = later(60).toISOString();
  assert.equal(evaluateConditions([{ type: 'after', at }], { ...base, nowMs: later(59).getTime() }), false);
  assert.equal(evaluateConditions([{ type: 'after', at }], { ...base, nowMs: later(60).getTime() }), true);
  assert.equal(evaluateConditions([{ type: 'status_clears' }], { ...base, ownerAway: false }), false, 'not armed yet');
  assert.equal(evaluateConditions([{ type: 'status_clears', armed: true }], { ...base, ownerAway: true }), false, 'still busy');
  assert.equal(evaluateConditions([{ type: 'status_clears', armed: true }], { ...base, ownerAway: false }), true);
});

test('her answer closes it', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'companion-b', text: 'check she ate', at: T0.toISOString(), threadId: 'home' }, T0);
  markAsked(intention.id, 'home', say('companion', later(1)));
  assert.deepEqual(followUps(later(2), opts), []);
  say('user', later(5));
  const [done] = followUps(later(6), opts);
  assert.equal(done.kind, 'answered');
  assert.equal(getIntention(intention.id)?.state, 'answered');
  assert.equal(listOpenIntentions().length, 0);
});

test('no answer: one nudge after a day (not in quiet hours), then it rests a day later', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'companion-a', text: 'dentist', at: T0.toISOString(), threadId: 'home' }, T0);
  markAsked(intention.id, 'home', say('companion', T0));
  assert.deepEqual(followUps(later(24 * 60 - 1), opts), []);
  assert.deepEqual(followUps(later(24 * 60), { ...opts, quiet: true }), [], 'quiet hours hold the nudge');
  const [nudge] = followUps(later(24 * 60), opts);
  assert.equal(nudge.kind, 'nudge');

  markNudged(intention.id, say('companion', later(24 * 60)));
  assert.deepEqual(followUps(later(24 * 60 + 60), opts), [], 'never a second nudge');
  const [rest] = followUps(later(48 * 60), opts);
  assert.equal(rest.kind, 'rest');
  assert.equal(getIntention(intention.id)?.state, 'resting');
});

test('taking a promise back cancels its impulse too', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'companion-a', text: 'x', onStatusClears: true }, T0);
  assert.equal(intention.onStatusClears, true);
  assert.equal(cancelIntention(intention.id), true);
  assert.equal(getIntention(intention.id)?.state, 'cancelled');
  const t = getDb().prepare('SELECT status FROM triggers WHERE id = ?').get(intention.triggerId) as { status: string };
  assert.equal(t.status, 'cancelled');
  assert.equal(cancelIntention(intention.id), false);
});

test('quiet hours wrap midnight or not, and a broken window is never quiet', () => {
  assert.equal(inQuietWindow('03:00', '09:00', 2, 59), false);
  assert.equal(inQuietWindow('03:00', '09:00', 3, 0), true);
  assert.equal(inQuietWindow('03:00', '09:00', 8, 59), true);
  assert.equal(inQuietWindow('03:00', '09:00', 9, 0), false);
  assert.equal(inQuietWindow('23:00', '07:00', 1, 0), true);
  assert.equal(inQuietWindow('23:00', '07:00', 12, 0), false);
  assert.equal(inQuietWindow('nope', '09:00', 4, 0), false);
});

test('the prompts hand the promise to its promiser; context lists what they hold', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'companion-a', text: 'ask how the meeting went', onStatusClears: true }, T0);
  const fire = intentionPrompt(intention, 'the operator', later(120));
  assert.match(fire, /^\[A promise coming due\] Companion A, you told the operator 2 hours ago: "ask how the meeting went"/);
  assert.match(fire, /Don't call it a reminder/);
  assert.match(nudgePrompt({ ...intention, askedAt: T0.toISOString() }, 'the operator', later(24 * 60)), /only nudge/);
  const ctx = intentionsContext('the operator', 'UTC');
  assert.match(ctx, /- companion-a: "ask how the meeting went" \(when her status clears\)/);
  assert.match(ctx, /set_intention/);
});
