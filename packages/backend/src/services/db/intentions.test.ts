// Intentions: a promise is filed once, rides an impulse that comes due at its
// time or when the operator's status clears, closes when they answer, gets one nudge if
// they don't, then rests; never inside the quiet hours.
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
  intentionSimilarity,
  sameFollowUp,
  resolveIntention,
  updateIntention,
  deferIntention,
  statusFallbackDue,
  statusFallbackGapOpen,
  noteStatusFallbackUsed,
  evidenceInHerWords,
  applyCaughtChange,
  fileCaughtIntention,
  looksLikeWorkItem,
  openIntentionsSummary,
  intentionSettings,
} = await import('./intentions.js');
const { setConfig } = await import('./config.js');
const { evaluateConditions } = await import('../triggers.js');
const { createMessage } = await import('../db.js');

const T0 = new Date('2026-10-25T18:00:00Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const opts = { quiet: false, nudgeAfterMinutes: 24 * 60, restAfterMinutes: 24 * 60 };

function freshHouse(): void {
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM companions').run();
  for (const [slug, name] of [['companion-a', 'Companion A'], ['companion-b', 'Companion B'], ['river', 'River'], ['stone', 'Stone']] as const) {
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

test('the due prompt is controller state in its keeper\'s hands, never a promise she made', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'river', text: 'ask how the meeting went', onStatusClears: true }, T0);
  const fire = intentionPrompt(intention, 'Owner', later(120));
  assert.match(fire, /^\[A follow-up coming due\] River, you chose 2 hours ago to follow up on this with Owner: "ask how the meeting went"/);
  assert.match(fire, /controller state/);
  assert.match(fire, /not evidence that anything happened/);
  assert.match(fire, /Read the recent conversation first/);
  assert.match(fire, new RegExp(`resolve_intention \\(id ${intention.id}\\)`));
  assert.match(fire, /do not make up a question/);
  assert.match(fire, /ONE brief, natural check-in/);
  assert.match(fire, /Never say they went/);
  assert.match(fire, /Don't call it a reminder/);
  assert.doesNotMatch(fire, /you told|promised you|Owner promised/);

  const nudge = nudgePrompt({ ...intention, askedAt: T0.toISOString() }, 'Owner', later(24 * 60));
  assert.match(nudge, /only nudge/);
  assert.match(nudge, /controller state/);
  assert.match(nudge, /resolve_intention/);

  const loose = createIntention({ companion: 'stone', text: 'ask how the dentist appointment went', at: later(60).toISOString(), kind: 'loose_end' }, T0).intention;
  assert.match(intentionPrompt(loose, 'Owner', later(120)), /Owner mentioned this 2 hours ago, and you're the one checking in on it/);
});

test('per-turn context is lean: a count, only what waits on her answer, and how to file', () => {
  freshHouse();
  createIntention({ companion: 'river', text: 'ask how the meeting went', onStatusClears: true }, T0);
  createIntention({ companion: 'stone', text: 'ask about the swim class', at: later(600).toISOString(), kind: 'loose_end' }, T0);
  const { intention: asked } = createIntention({ companion: 'river', text: 'check she ate', at: T0.toISOString(), threadId: 'home' }, T0);
  markAsked(asked.id, 'home', say('companion', later(1)));

  const ctx = intentionsContext('Owner', 'UTC', later(61));
  assert.match(ctx, /^Holding 3 follow-ups for Owner; list_intentions shows them\./);
  assert.match(ctx, /Waiting on Owner's answer:/);
  assert.match(ctx, new RegExp(`- River: "check she ate" \\(your own follow-up; asked 60 minutes ago; id ${asked.id}\\)`));
  assert.doesNotMatch(ctx, /meeting|swim class/, 'pending ones are counted, not listed');
  assert.match(ctx, /your choice to file with set_intention/);
  assert.match(ctx, /resolve_intention/);
  assert.ok(ctx.split('\n').length <= 4);

  freshHouse();
  assert.doesNotMatch(intentionsContext('Owner', 'UTC'), /Holding/, 'nothing held, no count line');
});

test('near-duplicate wording is one follow-up; different things are not', () => {
  // Same follow-up, worded differently.
  assert.equal(intentionSimilarity('ask how the dentist appointment went', 'ask her how her dentist appointment went'), 1);
  assert.ok(sameFollowUp('check she ate after her shift', 'check if she ate after the shift'));
  assert.ok(sameFollowUp('Ask how the piano recital went!', 'see how her piano-recital went'));
  assert.ok(sameFollowUp('ask how the dentist appointment went', 'ask how the dentist appointment with the new doctor went'), 'shorter one wholly inside the longer');
  // Different things.
  assert.ok(intentionSimilarity('ask how the dentist appointment went', 'ask how the meeting went') < 0.6);
  assert.equal(sameFollowUp('ask how the dentist appointment went', 'ask how the meeting went'), false);
  assert.equal(sameFollowUp('ask about the job interview', 'ask about the swim class'), false);
  assert.equal(sameFollowUp('dentist', 'dentist appointment monday follow'), false, 'one meaning word is too little to call it contained');
  // The threshold is a setting.
  assert.equal(intentionSettings().similarityThreshold, 0.6);
});

test('one follow-up, one row: same keeper for promises, anyone for loose ends', () => {
  freshHouse();
  const first = createIntention({ companion: 'river', text: 'ask how the dentist appointment went', at: later(60).toISOString() }, T0);
  const again = createIntention({ companion: 'river', text: 'ask her how her dentist appointment went', at: later(90).toISOString() }, T0);
  assert.equal(again.existing, true);
  assert.equal(again.intention.id, first.intention.id);
  const other = createIntention({ companion: 'stone', text: 'ask how the dentist appointment went', at: later(60).toISOString() }, T0);
  assert.equal(other.existing, false, 'another companion\'s own follow-up is theirs');
  const loose = createIntention({ companion: 'stone', text: 'ask how her dentist appointment went', at: later(60).toISOString(), kind: 'loose_end' }, T0);
  assert.equal(loose.existing, true, 'a loose end she mentioned is held once, by anyone');
  assert.equal(listOpenIntentions().length, 2);
});

test('resolve and cancel close it with a note; the impulse goes with it', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'river', text: 'ask how the meeting went', at: later(60).toISOString() }, T0);
  assert.throws(() => resolveIntention(intention.id, '  '), IntentionError);
  assert.equal(resolveIntention(intention.id, 'she said it went great', later(5)), true);
  const closed = getIntention(intention.id)!;
  assert.equal(closed.state, 'resolved');
  assert.equal(closed.closeNote, 'she said it went great');
  assert.equal(closed.closedAt, later(5).toISOString());
  const t = getDb().prepare('SELECT status FROM triggers WHERE id = ?').get(intention.triggerId) as { status: string };
  assert.equal(t.status, 'cancelled');
  assert.equal(resolveIntention(intention.id, 'again'), false);

  const other = createIntention({ companion: 'river', text: 'ask about the job interview', at: later(60).toISOString() }, T0).intention;
  assert.equal(cancelIntention(other.id, later(1), 'she called it off'), true);
  assert.equal(getIntention(other.id)?.closeNote, 'she called it off');
});

test('update changes words and a pending when; defer moves it later and re-arms', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'river', text: 'ask how the dentist went', at: later(60).toISOString(), threadId: 'home' }, T0);
  const updated = updateIntention(intention.id, { text: 'ask how the dentist and the cleaning went', at: later(120).toISOString() })!;
  assert.equal(updated.text, 'ask how the dentist and the cleaning went');
  assert.equal(updated.at, later(120).toISOString());
  const both = updateIntention(intention.id, { onStatusClears: true })!;
  assert.equal(both.onStatusClears, true);
  assert.equal(both.at, later(120).toISOString());
  assert.throws(() => updateIntention(intention.id, { at: null, onStatusClears: false }), IntentionError);

  // Asked already: its time can't move by update, but defer puts it back in line.
  markAsked(intention.id, 'home', say('companion', later(130)));
  getDb().prepare("UPDATE triggers SET status = 'fired' WHERE id = ?").run(intention.triggerId);
  assert.throws(() => updateIntention(intention.id, { at: later(300).toISOString() }), IntentionError);
  assert.throws(() => deferIntention(intention.id, later(100).toISOString(), later(140)), IntentionError, 'defer is later, never earlier');
  const deferred = deferIntention(intention.id, later(24 * 60).toISOString(), later(140))!;
  assert.equal(deferred.state, 'pending');
  assert.equal(deferred.at, later(24 * 60).toISOString());
  assert.equal(deferred.onStatusClears, true, 'still waits on her status too');
  const t = getDb().prepare('SELECT status FROM triggers WHERE id = ?').get(intention.triggerId) as { status: string };
  assert.equal(t.status, 'pending');
  assert.equal(deferIntention('nope', later(24 * 60).toISOString(), later(140)), null);
});

test('a pending one that never came up rests after the expiry window, counted from its time', () => {
  freshHouse();
  const old = createIntention({ companion: 'river', text: 'ask about the old thing', onStatusClears: true }, T0).intention;
  const far = createIntention({ companion: 'stone', text: 'ask about the trip', at: later(10 * 24 * 60).toISOString() }, T0).intention;
  assert.deepEqual(followUps(later(7 * 24 * 60 - 1), opts), []);
  const out = followUps(later(7 * 24 * 60), opts);
  assert.deepEqual(out.map((f) => [f.kind, f.intention.id]), [['expired', old.id]]);
  assert.equal(getIntention(old.id)?.state, 'resting');
  assert.ok(getIntention(old.id)?.closedAt);
  const t = getDb().prepare('SELECT status FROM triggers WHERE id = ?').get(old.triggerId) as { status: string };
  assert.equal(t.status, 'cancelled');
  assert.equal(getIntention(far.id)?.state, 'pending', 'a future time is not stale');
  assert.equal(followUps(later(17 * 24 * 60), { ...opts, expireAfterDays: 7 })[0]?.kind, 'expired');
  setConfig('intentions.expire_after_days', '3');
  assert.equal(intentionSettings().expireAfterDays, 3);
  assert.equal(intentionSettings().statusFallbackHours, 6);
});

test('waiting on her status: the fallback comes due only when she is here, free, and it has waited', () => {
  freshHouse();
  const { intention } = createIntention({ companion: 'river', text: 'ask how the shift went', onStatusClears: true }, T0);
  const base = { presence: 'active', ownerAway: false, agentFree: true, nowMs: later(6 * 60).getTime(), afterHours: 6 };
  assert.equal(statusFallbackDue(intention, base), true);
  assert.equal(statusFallbackDue(intention, { ...base, nowMs: later(6 * 60 - 1).getTime() }), false, 'not long enough');
  assert.equal(statusFallbackDue(intention, { ...base, presence: 'idle' }), false);
  assert.equal(statusFallbackDue(intention, { ...base, ownerAway: true }), false);
  assert.equal(statusFallbackDue(intention, { ...base, agentFree: false }), false);
  const timed = createIntention({ companion: 'river', text: 'ask about lunch', at: later(60).toISOString() }, T0).intention;
  assert.equal(statusFallbackDue(timed, base), false, 'only for ones waiting on her status');
  const deferred = createIntention({ companion: 'river', text: 'ask about the card', onStatusClears: true, at: later(3 * 24 * 60).toISOString() }, T0).intention;
  assert.equal(statusFallbackDue(deferred, base), false, 'a deferral holds it until its time');
  assert.equal(statusFallbackDue(deferred, { ...base, nowMs: later(3 * 24 * 60).getTime() }), true, 'and lets it through once the time comes');
});

test('closing on evidence: only her own words, quoted, settle it', () => {
  const words = 'ok the dentist was fine, no cavities!\nalso the interview got moved';
  assert.equal(evidenceInHerWords('"the dentist was fine, no cavities"', words), true);
  assert.equal(evidenceInHerWords('She said “no cavities” at the dentist', words), true);
  assert.equal(evidenceInHerWords('the dentist went well', words), false, 'a paraphrase is not her words');
  assert.equal(evidenceInHerWords('it is past the appointment time', words), false);
  assert.equal(evidenceInHerWords('"fine"', ''), false);

  freshHouse();
  const { intention } = createIntention({ companion: 'river', text: 'ask how the dentist went', at: later(60).toISOString(), kind: 'loose_end' }, T0);
  assert.equal(applyCaughtChange({ op: 'intention_resolve', id: intention.id, evidence: 'time has passed' }, words), 'no evidence');
  assert.equal(applyCaughtChange({ op: 'intention_resolve', id: intention.id, evidence: '"no cavities"' }, ''), 'no evidence');
  assert.equal(getIntention(intention.id)?.state, 'pending');
  assert.equal(applyCaughtChange({ op: 'intention_update', id: intention.id, at: later(180).toISOString() }, '', later(10)), 'updated');
  assert.equal(getIntention(intention.id)?.at, later(180).toISOString());
  assert.equal(applyCaughtChange({ op: 'intention_resolve', id: intention.id, evidence: '"the dentist was fine, no cavities"' }, words), 'resolved');
  assert.equal(getIntention(intention.id)?.closeNote, '"the dentist was fine, no cavities"');
  assert.equal(applyCaughtChange({ op: 'intention_cancel', id: intention.id, reason: '"moved"' }, words), 'not open');

  const other = createIntention({ companion: 'river', text: 'ask how the interview went', at: later(60).toISOString(), kind: 'loose_end' }, T0).intention;
  assert.equal(applyCaughtChange({ op: 'intention_cancel', id: other.id, reason: 'she probably forgot' }, words), 'no evidence');
  assert.equal(applyCaughtChange({ op: 'intention_cancel', id: other.id, reason: 'she said "the interview got moved"' }, words), 'cancelled');
  assert.equal(getIntention(other.id)?.state, 'cancelled');
});

test('the Archivist files her loose ends, never build or code to-dos', () => {
  freshHouse();
  assert.equal(looksLikeWorkItem('bring the review verdict before the merge'), true);
  assert.equal(looksLikeWorkItem('deploy the branch after the smoke test'), true);
  assert.equal(looksLikeWorkItem('ask how the dentist appointment went'), false);
  assert.equal(fileCaughtIntention({ companion: 'river', text: 'report back once the merge is done', at: later(60).toISOString() }, 'home', T0), 'work item');
  assert.equal(fileCaughtIntention({ companion: 'stone', text: 'ask how the dentist appointment went', at: later(60).toISOString(), kind: 'loose_end' }, 'home', T0), 'filed');
  const [row] = listOpenIntentions();
  assert.equal(row.kind, 'loose_end');
  assert.equal(row.source, 'archivist');
  const [summary] = openIntentionsSummary('Owner', 'UTC');
  assert.equal(summary.origin, 'something Owner mentioned');
  assert.equal(summary.owner, 'stone');
  assert.equal(summary.state, 'pending');
  assert.match(summary.when, /\d/);
});

test('rows filed before kinds existed read as a companion\'s own follow-up', () => {
  freshHouse();
  getDb().prepare("INSERT INTO triggers (id, kind, label, conditions, status, created_at) VALUES ('t-old', 'impulse', 'old', '[{\"type\":\"status_clears\"}]', 'pending', ?)").run(T0.toISOString());
  getDb().prepare("INSERT INTO intentions (id, companion, text, trigger_id, state, created_at) VALUES ('i-old', 'river', 'old one', 't-old', 'pending', ?)").run(T0.toISOString());
  const old = getIntention('i-old')!;
  assert.equal(old.kind, 'promise');
  assert.equal(old.source, 'companion');
  assert.equal(old.closeNote, null);
  assert.equal(old.onStatusClears, true);
});

test('the status fallback gap: one per window, remembered in config', () => {
  freshHouse();
  assert.equal(intentionSettings().statusFallbackGapHours, 3);
  assert.equal(statusFallbackGapOpen(T0.getTime(), 3), true, 'never used: open');
  noteStatusFallbackUsed(T0);
  assert.equal(statusFallbackGapOpen(later(179).getTime(), 3), false);
  assert.equal(statusFallbackGapOpen(later(180).getTime(), 3), true);
  setConfig('intentions.status_fallback_gap_hours', '1');
  assert.equal(intentionSettings().statusFallbackGapHours, 1);
});
