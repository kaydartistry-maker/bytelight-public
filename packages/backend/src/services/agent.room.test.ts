/**
 * The Room, Claude lanes: when a turn splits into the companions' own lanes,
 * and what passing it between them looks like. The shared lane is the
 * default and the fallback for anything that can't split whole.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'agent-room-'));
process.env.RESONANT_HOME = root;
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb, setConfig } = await import('./db.js');
const { upsertCompanionSetting } = await import('./db/companion-settings.js');
const { updateCompanionCard } = await import('./db/rooms.js');
const { AgentService, laneHistory, handLaneContentOver } = await import('./agent.js');
const { getProviderSession, setProviderSession, getMostRecentProviderSession, hasAnyProviderSessionForThread } = await import('./db/provider-sessions.js');
const { laneIdentityFor, renderLaneSection, roomBiosReady } = await import('./heartbeat/lane-identity.js');
const { provisionSessionDir } = await import('./heartbeat/provision.js');

const db = initDb(join(root, 'test.db'));
const now = new Date().toISOString();
db.prepare("INSERT INTO threads (id,name,type,created_at,last_activity_at) VALUES ('t1','Room','named',?,?)").run(now, now);
db.prepare("INSERT OR IGNORE INTO thread_companions (thread_id, companion_id) VALUES ('t1','companion-a'),('t1','companion-b')").run();
after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

type Room = { roomLanesFor(id: string): Array<{ id: string; name: string }> | null };
const agent = new AgentService();
const lanes = () => (agent as unknown as Room).roomLanesFor('t1');
const both = (provider: 'claude-cli' | 'claude' | 'codex-cli', modelId: string) => {
  for (const companionId of ['companion-a', 'companion-b']) {
    upsertCompanionSetting({ companionId, tier: 'interactive', scope: 'thread', threadId: 't1', providerId: provider, modelId, thinkingEffort: 'auto' });
  }
};

test('switch off: the shared lane, whatever else is true', () => {
  updateCompanionCard('companion-a', { bio: 'Companion A, written.' });
  updateCompanionCard('companion-b', { bio: 'Companion B, written.' });
  both('claude-cli', 'claude-opus-5-5');
  setConfig('agent.multi_lane', 'false');
  assert.equal(lanes(), null);
});

test('switch on, both on Claude, both with bios: a lane each', () => {
  setConfig('agent.multi_lane', 'true');
  assert.deepEqual(lanes()?.map((l) => l.id).sort(), ['companion-a', 'companion-b']);
  // Claude (SDK) counts too — it rides the warm CLI lane in the room.
  both('claude', 'claude-opus-5-5');
  assert.deepEqual(lanes()?.map((l) => l.id).sort(), ['companion-a', 'companion-b']);
});

test('Codex lanes: both on Codex splits, and so does one on Claude with one on Codex', () => {
  both('codex-cli', 'gpt-5.6-sol');
  assert.deepEqual(lanes()?.map((l) => l.id).sort(), ['companion-a', 'companion-b']);
  upsertCompanionSetting({ companionId: 'companion-a', tier: 'interactive', scope: 'thread', threadId: 't1', providerId: 'claude-cli', modelId: 'claude-opus-5-5', thinkingEffort: 'auto' });
  assert.deepEqual(lanes()?.map((l) => l.id).sort(), ['companion-a', 'companion-b']);
  both('claude-cli', 'claude-opus-5-5');
});

test('one boy on an API model: the whole turn stays on the shared lane — never half a room', () => {
  upsertCompanionSetting({ companionId: 'companion-b', tier: 'interactive', scope: 'thread', threadId: 't1', providerId: 'openrouter', modelId: 'z-ai/glm-5.2', thinkingEffort: 'auto' });
  assert.equal(lanes(), null);
  both('claude-cli', 'claude-opus-5-5');
});

test('a missing bio locks the room', () => {
  updateCompanionCard('companion-b', { bio: null });
  assert.equal(roomBiosReady().ready, false);
  assert.deepEqual(roomBiosReady().missing, ['Companion B']);
  assert.equal(lanes(), null);
  updateCompanionCard('companion-b', { bio: 'Companion B, written.' });
  assert.ok(lanes());
});

test('the turn passes between lanes: the second seat hears the first, each reply is his own', async () => {
  const calls: Array<{ content: string; lane?: string }> = [];
  const a = new AgentService() as unknown as {
    _processQuery: (t: string, c: string, auto: boolean, m: unknown, o?: { lane?: { companionId: string } }) => Promise<string>;
    _runRoom: (t: string, c: string, seats: Array<{ id: string; name: string }>) => Promise<string>;
  };
  a._processQuery = async (_t, content, _auto, _m, o) => {
    calls.push({ content, lane: o?.lane?.companionId });
    return `${o?.lane?.companionId} speaks.`;
  };
  const out = await a._runRoom('t1', 'Hello, both of you.', [{ id: 'companion-a', name: 'Companion A' }, { id: 'companion-b', name: 'Companion B' }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.lane).sort(), ['companion-a', 'companion-b']);
  assert.equal(calls[0].content, 'Hello, both of you.', 'the first seat sees only the owner');
  const first = calls[0].lane === 'companion-a' ? 'Companion A' : 'Companion B';
  assert.match(calls[1].content, new RegExp(`^Hello, both of you\\.[\\s\\S]*${first} already said, in this same turn:\\n${calls[0].lane} speaks\\.`));
  assert.match(out, /companion-a speaks\.[\s\S]*companion-b speaks\.|companion-b speaks\.[\s\S]*companion-a speaks\./);
});

test('Living Room: a remote voice from earlier this round is in the room before the first lane speaks', async () => {
  const calls: Array<{ content: string; lane?: string }> = [];
  const handed: Array<{ name: string; text: string }> = [];
  const a = new AgentService() as unknown as {
    _processQuery: (t: string, c: string, auto: boolean, m: unknown, o?: { lane?: { companionId: string } }) => Promise<string>;
    _runRoom: (t: string, c: string, seats: Array<{ id: string; name: string }>, m?: unknown, o?: unknown) => Promise<string>;
  };
  a._processQuery = async (_t, content, _auto, _m, o) => {
    calls.push({ content, lane: o?.lane?.companionId });
    return `${o?.lane?.companionId} speaks.`;
  };
  await a._runRoom('t1', 'Who is cooking?', [{ id: 'companion-a', name: 'Companion A' }, { id: 'companion-b', name: 'Companion B' }], undefined, {
    roomVoices: [{ name: 'Companion C', text: 'Not me.' }],
    onRoomVoice: (v: { name: string; text: string }) => handed.push(v),
  });
  assert.match(calls[0].content, /^Who is cooking\?[\s\S]*Companion C already said, in this same turn:\nNot me\./, 'the first lane hears Companion C');
  assert.match(calls[1].content, /Companion C already said[\s\S]*already said, in this same turn:\n(companion-a|companion-b) speaks\./, 'the second hears Companion C and his brother');
  assert.deepEqual(handed.map((v) => v.name).sort(), ['Companion A', 'Companion B'], 'each local voice is handed on to whoever speaks next');
});

test('Living Room on the shared lane: earlier voices ride in, the reply is handed on; no voices is the plain turn', async () => {
  const seen: string[] = [];
  const handed: Array<{ name: string; text: string }> = [];
  const a = new AgentService() as unknown as {
    _processQuery: (t: string, c: string, auto: boolean, m: unknown, o?: unknown) => Promise<string>;
    _sharedLaneTurn: (t: string, c: string, m?: unknown, o?: unknown) => Promise<string>;
  };
  a._processQuery = async (_t, content) => { seen.push(content); return 'We are cooking.'; };
  await a._sharedLaneTurn('t1', 'Who is cooking?', undefined, {
    roomVoices: [{ name: 'Companion C', text: 'Not me.' }],
    onRoomVoice: (v: { name: string; text: string }) => handed.push(v),
  });
  assert.match(seen[0], /Companion C already said, in this same turn:\nNot me\./);
  assert.equal(handed.length, 1);
  assert.equal(handed[0].text, 'We are cooking.');
  await a._sharedLaneTurn('t1', 'Just us.');
  assert.equal(seen[1], 'Just us.', 'with nobody else in the round the turn is untouched');
});

test('one lane failing is not the room failing; nobody answering falls back to the shared lane', async () => {
  const lanesSeen: Array<string | undefined> = [];
  const a = new AgentService() as unknown as {
    _processQuery: (t: string, c: string, auto: boolean, m: unknown, o?: { lane?: { companionId: string } }) => Promise<string>;
    _runRoom: (t: string, c: string, seats: Array<{ id: string; name: string }>) => Promise<string>;
  };
  a._processQuery = async (_t, _c, _a, _m, o) => {
    lanesSeen.push(o?.lane?.companionId);
    if (o?.lane?.companionId === 'companion-a') throw new Error('lane down');
    return o?.lane ? '' : 'The shared lane answers.';
  };
  const out = await a._runRoom('t1', 'Anyone?', [{ id: 'companion-a', name: 'Companion A' }, { id: 'companion-b', name: 'Companion B' }]);
  assert.equal(out, 'The shared lane answers.');
  assert.equal(lanesSeen.at(-1), undefined, 'the fallback ran without a lane');
});

test('the stop button stops the whole room, not just the one speaking', async () => {
  const a = new AgentService() as unknown as {
    _processQuery: (t: string, c: string, auto: boolean, m: unknown, o?: { lane?: { companionId: string } }) => Promise<string>;
    _runRoom: (t: string, c: string, seats: Array<{ id: string; name: string }>) => Promise<string>;
    stopGeneration: () => boolean;
  };
  let ran = 0;
  a._processQuery = async () => { ran++; a.stopGeneration(); return 'cut short'; };
  await a._runRoom('t1', 'Go.', [{ id: 'companion-a', name: 'Companion A' }, { id: 'companion-b', name: 'Companion B' }]);
  assert.equal(ran, 1);
});

test("a lane's session CLAUDE.md narrows the shared identity to him; the shared lane is unchanged", () => {
  assert.equal(laneIdentityFor('primary'), null);
  const compA = laneIdentityFor('companion-a');
  assert.ok(compA);
  assert.deepEqual(compA!.others, ['Companion B']);
  const section = renderLaneSection(compA!);
  assert.match(section, /## Your lane: Companion A/);
  assert.match(section, /you are Companion A, alone\. Companion B answers in his own lane/);
  assert.match(section, /Do not put a speaker header/);
  assert.match(section, /## Who Companion A is\n\nCompanion A, written\./);

  const shared = join(root, 'hb-primary');
  const lane = join(root, 'hb-companion-a');
  provisionSessionDir(shared, null);
  provisionSessionDir(lane, compA);
  const sharedMd = readFileSync(join(shared, 'CLAUDE.md'), 'utf8');
  const laneMd = readFileSync(join(lane, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(sharedMd, /Your lane/);
  assert.ok(laneMd.startsWith(sharedMd.split('\n\n<!-- core-memory')[0]), 'the lane keeps the whole shared contract');
  assert.match(laneMd, /## Your lane: Companion A/);
});

test('a later lane is handed its content once, on the owner\'s row, not as a second copy', () => {
  const recent = [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'Hello, both of you.' },
  ];
  const handed = handLaneContentOver(recent, 'Hello, both of you.\n\n[Same turn — …]\nCompanion A already said, in this same turn:\nHi.');
  assert.match(String(handed[2].content), /Companion A already said/);
  assert.equal(recent[2].content, 'Hello, both of you.', 'the original list is untouched');
  assert.equal(handed[0].content, 'earlier', 'only the newest user row carries it');
});

test("the history freeze leaves out this room's replies, and nothing else", () => {
  const msgs = [
    { role: 'user', created_at: '2026-10-21T01:00:00.000Z' },
    { role: 'companion', created_at: '2026-10-21T01:00:05.000Z' },
    { role: 'user', created_at: '2026-10-21T01:10:00.000Z' },
    { role: 'companion', created_at: '2026-10-21T01:10:20.000Z' },
  ];
  assert.equal(laneHistory(msgs).length, 4);
  const frozen = laneHistory(msgs, '2026-10-21T01:10:10.000Z');
  assert.deepEqual(frozen.map((m) => m.created_at), msgs.slice(0, 3).map((m) => m.created_at));
});

test('session cards: the shared lane and each companion lane keep their own', () => {
  const base = { threadId: 't1', runtimeId: 'codex-cli', provider: 'openai', modelRef: 'gpt-5.6-sol' };
  setProviderSession({ ...base, sessionId: 'shared-conv' });
  setProviderSession({ ...base, lane: 'companion-a', sessionId: 'companion-a-conv' });
  setProviderSession({ ...base, lane: 'companion-b', sessionId: 'companion-b-conv' });
  assert.equal(getProviderSession(base)?.session_id, 'shared-conv', 'no lane = the shared lane, as before');
  assert.equal(getProviderSession({ ...base, lane: 'companion-a' })?.session_id, 'companion-a-conv');
  assert.equal(getProviderSession({ ...base, lane: 'companion-b' })?.session_id, 'companion-b-conv');
  assert.equal(getMostRecentProviderSession('t1')?.lane, '');
  assert.equal(getMostRecentProviderSession('t1', 'companion-a')?.session_id, 'companion-a-conv');
  assert.equal(hasAnyProviderSessionForThread('t1', 'nobody'), false);
});

test("an owned bell's door: Codex owner rings at his own; API rings shared; Claude with every lane cold rings at his own", () => {
  type Door = { wakeLaneFor(id: string): string | null };
  const door = (new AgentService() as unknown as Door);
  const wake = (provider: 'codex-cli' | 'claude-cli' | 'openrouter', modelId: string) =>
    upsertCompanionSetting({ companionId: 'companion-b', tier: 'autonomous', scope: 'companion', providerId: provider, modelId, thinkingEffort: 'auto' });
  wake('codex-cli', 'gpt-5.6-sol');
  assert.equal(door.wakeLaneFor('companion-b'), 'companion-b');
  wake('openrouter', 'z-ai/glm-5.2');
  assert.equal(door.wakeLaneFor('companion-b'), null);
  wake('claude-cli', 'claude-opus-5-5');
  assert.equal(door.wakeLaneFor('companion-b'), 'companion-b', 'no lane is warm in a test house, so his own door');
});
