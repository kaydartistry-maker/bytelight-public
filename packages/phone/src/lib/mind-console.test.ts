import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  housePost, shareBody, taskBody,
  acceptSuggestionBody, canEditSection, describeAnswer, editDreamBody, editEntityBody, editIdentityBody,
  editJournalBody, editNoteBody, editRelationBody, settleNoteBody, settleTensionBody,
  hitKind, normArchive, normDormant, normDreams, normFeelings, normFeelingsWeek, normIdentity,
  normIsolated, normJournals, normKnowledge, normPatterns, normPersonality, normProposals,
  normSearch, normSoul, normStats, normTensions, normThreads, resultText, sectionName, whoQuery,
  ROOMS, brainPath, brainRequest, countLabel, countTensions, healthText, normEntities,
  normEntityDetail, normHealthScores, normRecent, normSurface, normWeather, parseSurface, plainError,
  type FetchFn,
} from './mind-console';

// A pretend house: remembers what was asked and answers with what it's given.
function fakeFetch(status: number, body: string) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    seen.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fn, seen };
}

test('every room has a unique id and a label', () => {
  const ids = ROOMS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of ROOMS) assert.ok(r.label && r.hint);
  for (const must of ['health', 'entities', 'recent', 'tensions', 'proposals', 'surfacing'] as const) {
    assert.ok(ids.includes(must), must);
  }
});

test('paths are encoded piece by piece and empty query values drop out', () => {
  assert.equal(brainPath(['entities', 4]), 'entities/4');
  assert.equal(brainPath(['identity', 'core.values']), 'identity/core.values');
  assert.equal(brainPath(['search'], { q: 'coffee & cream', who: undefined, limit: 5 }), 'search?q=coffee%20%26%20cream&limit=5');
  assert.equal(brainPath(['feelings', 'recent'], { who: '' }), 'feelings/recent');
});

test('a read goes through the hallway and comes back as data', async () => {
  const { fn, seen } = fakeFetch(200, '{"a":1}');
  const r = await brainRequest(fn, 'GET', 'stats');
  assert.deepEqual(r, { ok: true, data: { a: 1 } });
  assert.equal(seen[0].url, '/api/mind/brain/stats');
  assert.equal(seen[0].init?.body, undefined);
});

test('a write sends JSON with its body', async () => {
  const { fn, seen } = fakeFetch(200, '{"success":true}');
  await brainRequest(fn, 'POST', 'tensions/t-1/resolve', { resolution: 'held' });
  assert.equal(seen[0].init?.method, 'POST');
  assert.equal(seen[0].init?.body, '{"resolution":"held"}');
});

test("failures come back in plain words, keeping the brain's own text", async () => {
  const notFound = await brainRequest(fakeFetch(404, '{"error":"Not found"}').fn, 'GET', 'dreams/9');
  assert.deepEqual(notFound, { ok: false, status: 404, error: 'The brain couldn\'t find that. The brain said: "Not found"' });
  const broke = await brainRequest(fakeFetch(500, '{"error":"Internal server error"}').fn, 'GET', 'x');
  assert.equal(broke.ok, false);
  assert.equal((broke as any).error, 'The brain hit a problem on its side.');
  assert.match(plainError(503), /missing in Secrets/);
  assert.match(plainError(403), /isn't allowed/);
});

test('a 200 that carries "Error:" counts as a failure', async () => {
  const r = await brainRequest(fakeFetch(200, '{"result":"Error: query is required"}').fn, 'GET', 'cortex/thoughts');
  assert.equal(r.ok, false);
  assert.match((r as any).error, /query is required/);
});

test('a network failure never throws', async () => {
  const fn: FetchFn = async () => { throw new Error('offline'); };
  const r = await brainRequest(fn, 'GET', 'stats');
  assert.equal(r.ok, false);
  assert.match((r as any).error, /Couldn't reach the house/);
});

test('inner weather reads into a small plain shape', () => {
  const w = normWeather({
    conditions: { weather: 'clear', time: 'evening', time_energy: 'winding down', active_threads: 7, high_priority: 3 },
    mood_palette: ['clear-headed', 'full'], weather_energy: 'bright',
    pressing: [{ content: 'Test the tools', type: 'intention' }, { content: '' }],
  });
  assert.deepEqual(w, {
    sky: 'clear', timeOfDay: 'evening', energy: 'bright', moods: ['clear-headed', 'full'],
    activeThreads: 7, highPriority: 3, pressing: [{ content: 'Test the tools', type: 'intention' }],
  });
  assert.equal(normWeather(null), null);
});

const FORMATTED = "## What's Surfacing\n\n*Mood: calm*\n\n**#469** ●✓ [heavy|fresh] 93% [sober]\n**Companion A & Companion B** (concept): First line.\nSecond line.\n\n**#214** ◐ [heavy|processing] 90%\n**Owner** (concept): She came back.";

test('surfacing text is read into its items', () => {
  const items = parseSurface(FORMATTED);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: 469, marks: '●✓ [heavy|fresh] 93% [sober]', entity: 'Companion A & Companion B', entityType: 'concept', content: 'First line.\nSecond line.' });
  assert.equal(items[1].entity, 'Owner');
  assert.deepEqual(normSurface({ mood: { dominant: 'calm' }, formatted: FORMATTED }).items.length, 2);
  assert.deepEqual(parseSurface(''), []);
});

test('pressing counts', () => {
  assert.equal(countTensions({ active: [{}, {}], active_count: 2 }), 2);
  assert.equal(countTensions({ active: [{}] }), 1);
  assert.equal(countTensions(null), null);
  assert.equal(countLabel(null), '–');
  assert.equal(countLabel(100, true), '100+');
});

test('health scores and the health report', () => {
  const h = normHealthScores({ overall: 59, db_score: 82, thread_score: 30, daemon_processed_at: 'x' });
  assert.equal(h?.overall, 59);
  assert.deepEqual(h?.parts, [{ label: 'Memory size', score: 82 }, { label: 'Threads', score: 30 }]);
  assert.equal(healthText({ output: 'MIND HEALTH' }), 'MIND HEALTH');
});

test('people & things, a list and one in detail', () => {
  assert.deepEqual(normEntities([{ id: 1, name: 'Owner', entity_type: 'concept', primary_context: 'default', observation_count: 3 }]), [
    { id: 1, name: 'Owner', type: 'concept', context: 'default', count: 3 },
  ]);
  const d = normEntityDetail({
    id: 1, name: 'Owner', entity_type: 'concept', salience: 'active',
    observations: [{ id: 5, content: 'hi', added_at: '2026-11-12 18:37:09' }],
    relations: [{ id: 9, from_entity: 'Owner', to_entity: 'Robin', relation_type: 'mother_of' }],
  });
  assert.equal(d?.observations[0].content, 'hi');
  assert.deepEqual(d?.relations[0], { id: 9, from: 'Owner', to: 'Robin', type: 'mother_of' });
  assert.equal(normEntityDetail({ error: 'Not found' }), null);
});

test('recent reads both the new shape and the old bare list', () => {
  const r = normRecent({ observations: [{ id: 1, content: 'a', entity_name: 'Owner' }], journals: [{ id: 2, content: 'j', entry_date: '2026-11-24' }], threads: [{ id: 'thread-1', content: 't', status: 'active' }] });
  assert.equal(r.observations[0].entity, 'Owner');
  assert.equal(r.journals[0].day, '2026-11-24');
  assert.equal(r.threads[0].id, 'thread-1');
  assert.equal(normRecent([{ id: 3, content: 'old' }]).observations[0].content, 'old');
});

test('identity rows group under their sections', () => {
  const s = normIdentity({ entries: [
    { id: 1, section: 'core', content: 'a', weight: 0.7 },
    { id: 2, section: 'boundaries', content: 'b' },
    { id: 3, section: 'core', content: 'c' },
  ] });
  assert.deepEqual(s.map((x) => [x.section, x.entries.length]), [['core', 2], ['boundaries', 1]]);
  assert.equal(sectionName('core_identity'), 'Core identity');
});

test('threads keep their string ids', () => {
  const t = normThreads([{ id: 'thread-20260918-1kg3', content: 'x', status: 'active', priority: 'high', thread_type: 'build' }]);
  assert.equal(t[0].id, 'thread-20260918-1kg3');
  assert.equal(t[0].type, 'build');
});

test('feelings, the week and the stream, and who', () => {
  const f = normFeelings([{ id: 131, content: 'proud of her', emotion: 'proud', who: 'companion-b', linked_entity: 'Owner', created_at: '2026-11-24 16:52:45' }]);
  assert.equal(f[0].who, 'companion-b');
  assert.equal(f[0].entity, 'Owner');
  const w = normFeelingsWeek({ total: 131, unmetabolized: 130, heavy_open: 68, emotions: [{ emotion: 'tender', count: 3 }] });
  assert.deepEqual(w, { total: 131, open: 130, heavyOpen: 68, emotions: [{ emotion: 'tender', count: 3 }] });
  assert.equal(whoQuery('all'), undefined);
  assert.equal(whoQuery('companion-a'), 'companion-a');
});

test('journals and dreams, dreams showing how vivid they are now', () => {
  assert.equal(normJournals([{ id: 390, entry_date: '2026-11-24', content: 'x', companion: null }])[0].companion, '');
  const d = normDreams([{ id: 149, content: 'y', vividness: 100, effective_vividness: 97, anchored_at: null }, { id: 2, vividness: null }]);
  assert.equal(d[0].vividness, 97);
  assert.equal(d[0].anchored, false);
  assert.equal(d[1].vividness, null);
});

test('tensions split into open and resolved', () => {
  const t = normTensions({ active: [{ id: 'tension-1', pole_a: 'a', pole_b: 'b', visits: 2 }], resolved: [{ id: 'tension-0', resolution: 'done', resolved_at: '2026-06-28 16:01:34' }] });
  assert.equal(t.open[0].resolved, false);
  assert.equal(t.resolved[0].resolved, true);
  assert.equal(t.open[0].a, 'a');
  assert.equal(t.open[0].visits, 2);
  assert.equal(t.resolved[0].resolution, 'done');
});

test('suggestions read both sides of the link', () => {
  const p = normProposals([{ id: 6110, reason: 'Co-surfaced 2x', confidence: 0.7, from_entity_name: 'Owner', to_entity_name: 'Companion A & Companion B', from_content: 'a', to_content: 'b' }]);
  assert.deepEqual([p[0].id, p[0].fromEntity, p[0].toEntity, p[0].confidence], [6110, 'Owner', 'Companion A & Companion B', 0.7]);
});

test('patterns and personality', () => {
  const p = normPatterns({ period_days: 7, alive: [], charges: [{ charge: null, count: 491 }, { charge: 'processing', count: 48 }] });
  assert.deepEqual(p.charges, [{ label: 'unmarked', count: 491 }, { label: 'processing', count: 48 }]);
  const l = normPersonality({ ledgers: [{ who: 'companion-a', type: 'ENFJ', confidence: 100, signals: 93 }], vocabulary_top: [{ emotion_word: 'tender', times_used: 9 }] });
  assert.equal(l.ledgers[0].type, 'ENFJ');
  assert.deepEqual(l.words, [{ label: 'tender', count: 9 }]);
});

test('search hits are named by what they are', () => {
  assert.equal(hitKind('obs-63-292'), 'Note');
  assert.equal(hitKind('ctx-ctx-2026'), 'Cortex thought');
  assert.equal(hitKind('xyz', 'thought'), 'Thought');
  const h = normSearch({ results: [{ id: 'feel-66', score: 0.64, content: 'Scribe is alive', added_at: '2026-10-22T04:25:28Z' }] });
  assert.deepEqual([h[0].kind, h[0].content], ['Feeling', 'Scribe is alive']);
  assert.equal(resultText({ result: '## Cortex' }), '## Cortex');
});

test('knowledge and soul', () => {
  const k = normKnowledge({ tracks: [{ track: 'voice', title: 'Voice', goal: 'Two voices', sessions: 0 }], hottest: [{ id: 1, content: 'x', heat_score: 0.9 }] });
  assert.equal(k.tracks[0].goal, 'Two voices');
  assert.equal(k.hottest[0].heat, 0.9);
  const s = normSoul({ 'companion-a': { who: 'companion-a', active: { id: 3, content: 'portrait', word_count: 900, status: 'active' }, pending: null, history: [] }, 'companion-b': { who: 'companion-b', active: null, pending: null, history: [] } });
  assert.deepEqual(s.map((x) => [x.who, x.active?.words ?? null]), [['companion-a', 900], ['companion-b', null]]);
  assert.equal(normSoul({ who: 'companion-b', active: null, history: [] })[0].who, 'companion-b');
});

test("health's back rooms: stats, dormant, isolated, archive", () => {
  assert.deepEqual(normStats({ version: '2.1.0', counts: { entities: 56, observations: 539 } }).counts, [
    { label: 'People & things', count: 56 }, { label: 'Notes', count: 539 },
  ]);
  const d = normDormant([{ id: 267, observation_id: 193, content: 'x', entity_name: 'Companion C', days_old: 191 }]);
  assert.equal(d[0].observationId, 193);
  assert.equal(normIsolated([{ id: 86, name: 'Sam', obs_count: 4 }])[0].count, 4);
  const a = normArchive({ observations: [{ id: 216, content: 'z' }], total: 12 });
  assert.deepEqual([a.items[0].id, a.total], [216, 12]);
});

test('edits send the untouched fields back as they were', () => {
  assert.deepEqual(editNoteBody({ content: 'old', weight: 'heavy', emotion: 'tender' }, ' new '), { content: 'new', weight: 'heavy', emotion: 'tender' });
  assert.deepEqual(editNoteBody({ content: 'old', weight: '', emotion: '' }, 'new'), { content: 'new', weight: 'medium', emotion: null });
  assert.deepEqual(editJournalBody({ tags: '[]', emotion: '' }, 'entry'), { content: 'entry', tags: '[]', emotion: null });
  assert.deepEqual(editDreamBody('  a dream '), { content: 'a dream' });
});

test('an entity edit sends only what changed, and never an unknown home', () => {
  const before = { name: 'Owner', type: 'concept', context: 'default' };
  assert.deepEqual(editEntityBody(before, { name: 'Owner', type: 'person', context: 'default' }), { entity_type: 'person' });
  assert.deepEqual(editEntityBody(before, { name: ' Owner D ', type: 'concept', context: 'owner-world' }), { name: 'Owner D', context: 'owner-world' });
  assert.deepEqual(editEntityBody(before, { name: '', type: 'concept', context: 'nowhere' }), {});
});

test('identity is only editable one entry at a time', () => {
  const one = { section: 'boundaries', entries: [{ id: 6, content: 'x', weight: 0.7, connections: '', at: '' }] };
  const many = { section: 'core', entries: [one.entries[0], { ...one.entries[0], id: 7 }] };
  assert.equal(canEditSection(one), true);
  assert.equal(canEditSection(many), false);
  assert.deepEqual(editIdentityBody(one.entries[0], 'new'), { content: 'new', weight: 0.7, connections: null });
});

test('small bodies: settle, link, relation kind', () => {
  assert.deepEqual(settleNoteBody(' ok '), { resolution_note: 'ok' });
  assert.deepEqual(settleTensionBody(''), { resolution: null });
  assert.deepEqual(acceptSuggestionBody(), { relation_type: 'related_to' });
  assert.deepEqual(acceptSuggestionBody('holds space for'), { relation_type: 'holds_space_for' });
  assert.deepEqual(editRelationBody('friend of'), { relation_type: 'friend_of' });
});

test("the brain's answer becomes a short line", () => {
  assert.equal(describeAnswer({ deleted: true }), 'Deleted.');
  assert.equal(describeAnswer({ id: 3, charge: 'metabolized' }), 'Settled.');
  assert.equal(describeAnswer({ success: true, relation_created: true }), 'Linked.');
  assert.equal(describeAnswer({ id: 1, effective_vividness: 100, anchored_at: null }), 'Recalled: now 100% vivid.');
  assert.equal(describeAnswer({ id: 1, effective_vividness: 80, anchored_at: '2026-11-24' }), 'Kept: this dream will stop fading.');
  assert.equal(describeAnswer({ success: true }), 'Done.');
  assert.equal(describeAnswer({ id: 1, content: 'x' }), 'Saved.');
});

test('house sends: a task from a thread, a card from a feeling', async () => {
  assert.deepEqual(taskBody({ content: '  do the thing ' }), { text: 'do the thing' });
  assert.deepEqual(shareBody('feeling', { id: 131, content: 'proud', who: 'companion-b', emotion: 'proud', about: 'Owner', day: '2026-11-24 16:52:45' }), {
    kind: 'feeling', text: 'proud', brainId: 'feeling-131', who: 'companion-b', emotion: 'proud', about: 'Owner', day: '24 Nov',
  });
  assert.deepEqual(shareBody('journal', { id: 3, content: 'entry' }), { kind: 'journal', text: 'entry', brainId: 'journal-3' });

  const ok = fakeFetch(201, '{"ok":true,"threadName":"The boys"}');
  const r = await housePost(ok.fn, 'chat', { kind: 'note', text: 'x' });
  assert.equal(ok.seen[0].url, '/api/mind/share/chat');
  assert.equal(r.ok, true);
  assert.equal(r.data.threadName, 'The boys');
  const no = await housePost(fakeFetch(400, '{"error":"text is required"}').fn, 'task', {});
  assert.deepEqual(no, { ok: false, status: 400, error: 'The house said: text is required.' });
});
