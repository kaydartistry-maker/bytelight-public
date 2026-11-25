/**
 * Phase 1.3 — wakes, voice, tools and status come from the roster.
 *
 *  - a wake preamble rendered for 0, 1, 2 and 3 seats (0 = no prompt at all);
 *  - the pair preamble is byte-identical to the historical rule;
 *  - voice splitting for 1, 2 and 3 speakers, and the pair pattern is
 *    byte-identical to the historical literal;
 *  - memory accepts only resident scopes plus 'shared';
 *  - the Codex contract shows the configured port;
 *  - tool enums, music-drop permission and image drawers follow the registry;
 *  - an empty roster makes no model call.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';

import type Database from 'better-sqlite3';

import { createRoutingThreadShell, createThread, getDb, initDb } from './db.js';
import { renderWakePrompt, wakeRosterRule, WAKE_ROSTER_TOKEN, WAKE_USER_TOKEN } from './wake-roster.js';
import { VoiceService, buildSpeakerRegex, type VoiceSpeaker } from './voice.js';
import { companionScopes, resolveScope, validScopesHint } from './memory-blocks.js';
import { codexOperatingContract, CODEX_OPERATING_CONTRACT } from './runtimes/codex-operating-contract.js';
import { getBeltToolSchemas } from './chat-tool-belt.js';
import { readDropRequest } from './needle.js';
import { listDrawers } from './image-gen.js';
import { AgentService, hasResidentSeat } from './agent.js';
import { residents } from './residents.js';
import { roomBiosReady } from './heartbeat/lane-identity.js';

const root = mkdtempSync(join(tmpdir(), 'roster-voices-'));
let n = 0;

function house(seats: ReadonlyArray<[id: string, name: string, brain?: string]>): Database.Database {
  try { getDb().close(); } catch { /* none */ }
  const db = initDb(join(root, `h-${n++}.db`));
  const ins = db.prepare('INSERT INTO companions (id, display_name, brain, slug, sort_order, bio) VALUES (?, ?, ?, ?, ?, ?)');
  seats.forEach(([id, name, brain], i) => ins.run(id, name, brain ?? 'companion-a-b', id, i, `${name} bio`));
  return db;
}

const PAIR: VoiceSpeaker[] = [
  { id: 'companion-a', name: 'Companion A', glyph: '🔷' },
  { id: 'companion-b', name: 'Companion B', glyph: '🔶' },
];

describe('wake preamble from the roster', () => {
  const prefix = `Ground first.\n\n${WAKE_ROSTER_TOKEN}\n\nWhat was ${WAKE_USER_TOKEN} doing?`;

  test('0 seats renders nothing (no model call)', () => {
    assert.equal(wakeRosterRule([]), null);
    assert.equal(renderWakePrompt(prefix, [], 'Owner'), null);
  });

  test('1 seat asks for one voice', () => {
    const out = renderWakePrompt(prefix, ['Alpha'], 'Owner')!;
    assert.match(out, /Show up as yourself\.\*\* Alpha, one voice/);
    assert.doesNotMatch(out, /both|two people/);
    assert.match(out, /What was Owner doing\?/);
    assert.equal(out.includes(WAKE_ROSTER_TOKEN), false);
  });

  test('2 seats is the historical rule, byte for byte', () => {
    assert.equal(
      wakeRosterRule(['Companion A', 'Companion B']),
      '3. **Show up as both.** Companion A AND Companion B. Always. Not one merged voice. Distinct registers, different textures. If one speaks first, the other adds something different — not the same thought in a different font. You are two people. Be two people.',
    );
  });

  test('3 seats asks for three distinct voices', () => {
    const rule = wakeRosterRule(['A', 'B', 'C'])!;
    assert.match(rule, /Show up as all three\.\*\* A, B AND C\./);
    assert.match(rule, /You are three people\. Be three people\./);
  });
});

describe('voice splitting from the registry', () => {
  test('the pair pattern is byte-identical to the historical literal', () => {
    const historical = /(?:\*\*\s*🔷?\s*Companion A\s*:?\s*[—–-][^*\n]*\*\*|\*\*\s*🔶?\s*Companion B\s*:?\s*[—–-][^*\n]*\*\*|\*\*\s*🔷?\s*Companion A:?\s*\*\*|\*\*\s*🔶?\s*Companion B:?\s*\*\*|\*\*\s*Companion A\s*:?\s*🔷\s*\*\*|\*\*\s*Companion B\s*:?\s*🔶\s*\*\*|🔷?\s*\*\*\s*Companion A:?\s*\*\*|🔶?\s*\*\*\s*Companion B:?\s*\*\*|\*\*\s*Companion A:?\s*\*\*|\*\*\s*Companion B:?\s*\*\*|🔷?\s*Companion A:|🔶?\s*Companion B:|Companion A\s*:?\s*🔷|Companion B\s*:?\s*🔶|🔷|🔶)/g;
    assert.equal(buildSpeakerRegex(PAIR).source, historical.source);
  });

  test('1 speaker: everything is that voice', () => {
    const solo: VoiceSpeaker[] = [{ id: 'alpha', name: 'Alpha', glyph: null }];
    assert.deepEqual(VoiceService.splitByCompanion('hello there\n\nmore', solo), [{ voice: 'alpha', text: 'hello there\n\nmore' }]);
  });

  test('2 speakers split as before', () => {
    const segs = VoiceService.splitByCompanion('**🔷 Companion A —** first\n\n**🔶 Companion B —** second', PAIR);
    assert.deepEqual(segs.map((s) => s.voice), ['companion-a', 'companion-b']);
    assert.deepEqual(segs.map((s) => s.text), ['first', 'second']);
  });

  test('3 speakers split, including one without a glyph by bold name', () => {
    const trio: VoiceSpeaker[] = [...PAIR, { id: 'nova', name: 'Nova', glyph: null }];
    const segs = VoiceService.splitByCompanion('🔷 Companion A: one\n🔶 Companion B: two\n**Nova:** three', trio);
    assert.deepEqual(segs.map((s) => s.voice), ['companion-a', 'companion-b', 'nova']);
    // Plain prose "Nova:" without bold or a glyph is not a header.
    assert.equal(VoiceService.splitByCompanion('I told Nova: no.', trio).length, 1);
  });

  test('the house speakers come from residents, with legacy glyphs for rows without one', () => {
    house([['companion-a', 'Companion A'], ['companion-b', 'Companion B'], ['visitor', 'Visitor', 'elsewhere']]);
    const segs = VoiceService.splitByCompanion('🔷 hi\n🔶 yo');
    assert.deepEqual(segs.map((s) => s.voice), ['companion-a', 'companion-b']);
    assert.deepEqual(residents().map((r) => r.id), ['companion-a', 'companion-b'], 'a visitor from another brain is not a resident');
  });

  test('an empty house still reads text aloud in the default voice', () => {
    assert.deepEqual(VoiceService.splitByCompanion('hello', []), [{ voice: '', text: 'hello' }]);
  });
});

describe('memory scopes', () => {
  beforeEach(() => { house([['alpha', 'Alpha'], ['beta', 'Beta'], ['guest', 'Guest', 'elsewhere']]); });

  test('only resident scopes plus shared are accepted', () => {
    assert.deepEqual(companionScopes(), ['alpha', 'beta']);
    assert.equal(resolveScope('shared'), 'shared');
    assert.equal(resolveScope('ALPHA'), 'alpha');
    assert.equal(resolveScope('guest'), null);
    assert.equal(resolveScope('companion-a'), null);
    assert.equal(validScopesHint(), "'shared', 'alpha', 'beta'");
  });

  test('an empty house has only the shared scope', () => {
    house([]);
    assert.deepEqual(companionScopes(), []);
    assert.equal(validScopesHint(), "'shared'");
  });
});

describe('ports, tools and permissions', () => {
  test('the Codex contract shows the configured port', () => {
    assert.match(codexOperatingContract(3999), /127\.0\.0\.1:3999\/api\/internal\/journal/);
    assert.doesNotMatch(codexOperatingContract(3999), /3002/);
    assert.match(CODEX_OPERATING_CONTRACT, /127\.0\.0\.1:3002\/api\/internal\/journal/);
    const prior = process.env.RESONANT_PORT;
    process.env.RESONANT_PORT = '4321';
    try {
      assert.match(codexOperatingContract(), /127\.0\.0\.1:4321\//);
    } finally {
      if (prior === undefined) delete process.env.RESONANT_PORT; else process.env.RESONANT_PORT = prior;
    }
  });

  test('voice tool enums list exactly the residents, and drop the enum in an empty house', () => {
    house([['alpha', 'Alpha']]);
    const voiceNote = getBeltToolSchemas().find((s) => s.name === 'send_voice_note')!;
    const props = (voiceNote.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    assert.deepEqual(props.voice.enum, ['alpha']);
    house([]);
    const empty = getBeltToolSchemas().find((s) => s.name === 'send_voice_note')!;
    assert.equal((empty.input_schema as { properties: Record<string, { enum?: string[] }> }).properties.voice.enum, undefined);
  });

  test('only residents may drop the needle', () => {
    house([['alpha', 'Alpha'], ['guest', 'Guest', 'elsewhere']]);
    const uri = 'spotify:track:5googFqOqpopYdcvV22T3t';
    assert.equal(readDropRequest({ companion: 'alpha', uri }).ok, true);
    assert.equal(readDropRequest({ companion: 'guest', uri }).ok, false);
    assert.equal(readDropRequest({ companion: 'companion-a', uri }).ok, false);
  });

  test('image drawers are the residents (plus the owner when configured)', () => {
    house([['alpha', 'Alpha'], ['beta', 'Beta']]);
    const builtIn = listDrawers().filter((d) => d.isDefault).map((d) => d.slug);
    assert.deepEqual(builtIn.slice(0, 2), ['alpha', 'beta']);
    assert.equal(builtIn.includes('companion-a'), false);
  });

  test("The Room's bio lock reads the configured brain", () => {
    house([['alpha', 'Alpha'], ['beta', 'Beta']]);
    assert.equal(roomBiosReady().ready, true);
    const prior = process.env.BYTELIGHT_LOCAL_BRAIN_ID;
    process.env.BYTELIGHT_LOCAL_BRAIN_ID = 'another';
    try {
      assert.equal(roomBiosReady().ready, false);
    } finally {
      if (prior === undefined) delete process.env.BYTELIGHT_LOCAL_BRAIN_ID; else process.env.BYTELIGHT_LOCAL_BRAIN_ID = prior;
    }
  });
});

describe('an empty roster makes no model call', () => {
  test('a thread with nobody seated answers empty without queueing a turn', async () => {
    house([['alpha', 'Alpha'], ['guest', 'Guest', 'elsewhere']]);
    const now = new Date().toISOString();
    createRoutingThreadShell({ id: 'empty', name: 'Empty', type: 'named', createdAt: now });
    createThread({ id: 'guest-only', name: 'Guest', type: 'named', createdAt: now, companionIds: ['guest'] });
    createThread({ id: 'solo', name: 'Solo', type: 'named', createdAt: now, companionIds: ['alpha'] });
    assert.equal(hasResidentSeat('empty'), false);
    assert.equal(hasResidentSeat('guest-only'), false);
    assert.equal(hasResidentSeat('solo'), true);

    const agent = new AgentService();
    assert.equal(await agent.processAutonomous('empty', 'wake'), '');
    assert.equal(await agent.processMessage('guest-only', 'hello'), '');
    assert.equal(agent.isProcessing(), false);
  });
});
