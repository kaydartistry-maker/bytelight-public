/**
 * Thought-semantics contract tests (reference implementation integration Phase B, Slice 3).
 *
 * Pins the authored | provider | system `kind` across the segment builder
 * and real persistence (createMessage → SQLite → getMessage/getMessages),
 * and pins that OLD kindless segments keep their exact pre-Slice-3 shape:
 *
 *   1. Legacy: kindless insertions build byte-identical legacy segments
 *      (no `kind` key anywhere), and the empty-insertions fast path holds.
 *   2. Kinds survive builder → persisted metadata → reload, in order.
 *   3. Provider telemetry never merges into the authored perspective —
 *      adjacent blocks stay distinct segments with their own kinds.
 *   4. System notices stay distinct from both neighbors.
 *   5. Multi-companion ordering (🔷 Companion A / 🔶 Companion B voice sections woven
 *      with kinded chips) survives persistence + reload verbatim — the
 *      evidence for reference implementation's contextual-ownership approach: canonical
 *      speaker headers + preserved segment order carry ownership, so no
 *      explicit companionId is needed (see Slice 3 decision gate).
 *
 * Mirrors db.bridge.test.ts / agent.dual-path.test.ts bootstrap: temp
 * RESONANT_HOME + real disk-backed DB through the production initDb path.
 *
 * Run with:
 *   npx tsx --test packages/backend/src/services/agent.segments.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'segments-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageSegment } from '@bytelight/shared';
import { initDb, createThread, createMessage, getMessage, getMessages } from './db.js';
import { buildSegments, shouldDiscardEmptyTurn, isDeliberateSilence, type ThinkingInsertion } from './agent.js';
import type { ToolInsertion } from './hooks.js';
import { loadConfig } from '../config.js';

const THREAD_ID = 'segments-thread';

before(() => {
  // Nonexistent path → pure DEFAULTS (no live bytelight.yaml pickup).
  loadConfig(join(tmpRoot, 'bytelight.yaml'));
  initDb(join(tmpRoot, 'segments.db'));
  createThread({
    id: THREAD_ID,
    name: 'segments',
    type: 'named',
    createdAt: new Date().toISOString(),
  });
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// NOTE: message `content` is kept ≤ 10 chars throughout so createMessage's
// fire-and-forget embedding path never tries to load the local model in a
// test process. Interleaved rendering reads metadata.segments, not content,
// so the round-trip assertions are unaffected.
let msgSeq = 0;
function persistAndReload(segments: MessageSegment[]): {
  viaGetMessage: MessageSegment[];
  viaGetMessages: MessageSegment[];
} {
  const id = `seg-msg-${++msgSeq}`;
  createMessage({
    id,
    threadId: THREAD_ID,
    role: 'companion',
    content: 'short',
    contentType: 'text',
    platform: 'web',
    metadata: { segments },
    createdAt: new Date().toISOString(),
  });
  const single = getMessage(id);
  assert.ok(single, 'persisted message must reload by id');
  const listed = getMessages({ threadId: THREAD_ID }).find((m) => m.id === id);
  assert.ok(listed, 'persisted message must reload via thread listing');
  return {
    viaGetMessage: (single.metadata as { segments: MessageSegment[] }).segments,
    viaGetMessages: (listed.metadata as { segments: MessageSegment[] }).segments,
  };
}

describe('Slice 3 — legacy (kindless) segments unchanged', () => {
  test('no insertions → empty segments (pre-Slice-3 fast path)', () => {
    assert.deepEqual(buildSegments('hello there', [], []), []);
  });

  test('kindless thinking + tool insertions build the exact pre-Slice-3 shape', () => {
    const tools: ToolInsertion[] = [
      { textOffset: 5, toolId: 't-1', toolName: 'Read', input: 'file.ts', output: 'ok', isError: false },
    ];
    const thinking: ThinkingInsertion[] = [
      { textOffset: 0, content: 'pondering', summary: 'pondering' },
    ];
    const segments = buildSegments('hello world', tools, thinking);

    assert.deepEqual(segments, [
      { type: 'thinking', content: 'pondering', summary: 'pondering' },
      { type: 'text', content: 'hello' },
      { type: 'tool', toolId: 't-1', toolName: 'Read', input: 'file.ts', output: 'ok', isError: false },
      { type: 'text', content: ' world' },
    ]);
    // Byte-level guarantee: a kindless insertion persists NO `kind` key at
    // all — old messages and old fixtures stay identical.
    for (const seg of segments) {
      assert.ok(!('kind' in seg), `legacy segment must not grow a kind key: ${JSON.stringify(seg)}`);
    }

    // And the persisted → reloaded metadata is the same legacy shape.
    const { viaGetMessage } = persistAndReload(segments);
    assert.deepEqual(viaGetMessage, segments);
    for (const seg of viaGetMessage) {
      assert.ok(!('kind' in seg), 'reloaded legacy segment must not grow a kind key');
    }
  });
});

describe('Slice 3 — kind survives builder → persistence → reload', () => {
  test('authored / provider / system pass through buildSegments in order', () => {
    const thinking: ThinkingInsertion[] = [
      { textOffset: 0, content: '[Session recycled]', summary: '', kind: 'system' },
      { textOffset: 3, content: 'model reasoning', summary: 'model reasoning', kind: 'provider' },
      { textOffset: 6, content: 'I noticed the operator sounded tired.', summary: 'Noticed tiredness', kind: 'authored' },
    ];
    const segments = buildSegments('one two', [], thinking);

    assert.deepEqual(segments, [
      { type: 'thinking', content: '[Session recycled]', summary: '', kind: 'system' },
      { type: 'text', content: 'one' },
      { type: 'thinking', content: 'model reasoning', summary: 'model reasoning', kind: 'provider' },
      { type: 'text', content: ' tw' },
      { type: 'thinking', content: 'I noticed the operator sounded tired.', summary: 'Noticed tiredness', kind: 'authored' },
      { type: 'text', content: 'o' },
    ]);
  });

  test('kinds survive a real DB write + reload on both read paths', () => {
    const segments = buildSegments('one two', [], [
      { textOffset: 0, content: 'notice', summary: '', kind: 'system' },
      { textOffset: 7, content: 'reflection', summary: 'reflection', kind: 'authored' },
    ]);
    const { viaGetMessage, viaGetMessages } = persistAndReload(segments);
    assert.deepEqual(viaGetMessage, segments);
    assert.deepEqual(viaGetMessages, segments);
  });
});

describe('Slice 3 — provider telemetry never merges into authored perspective', () => {
  test('adjacent provider and authored blocks at the same offset stay distinct', () => {
    const thinking: ThinkingInsertion[] = [
      { textOffset: 4, content: 'raw chain of thought', summary: 'raw', kind: 'provider' },
      { textOffset: 4, content: 'my own reflection', summary: 'mine', kind: 'authored' },
    ];
    const segments = buildSegments('okay then', [], thinking);
    const thoughts = segments.filter((s) => s.type === 'thinking');

    assert.equal(thoughts.length, 2, 'adjacent blocks must not coalesce');
    assert.deepEqual(
      thoughts.map((t) => t.type === 'thinking' && t.kind),
      ['provider', 'authored'],
      'each block keeps its own kind — no bleed in either direction',
    );
    assert.deepEqual(
      thoughts.map((t) => t.content),
      ['raw chain of thought', 'my own reflection'],
    );

    // Still distinct after persistence + reload.
    const { viaGetMessage } = persistAndReload(segments);
    assert.deepEqual(viaGetMessage, segments);
  });
});

describe('Slice 3 — system notices remain distinct', () => {
  test('a system notice between authored and provider blocks keeps its kind through reload', () => {
    const segments = buildSegments('hi', [], [
      { textOffset: 0, content: 'authored note', summary: 'note', kind: 'authored' },
      { textOffset: 0, content: '[Reply window closed after 90s of silence]', summary: '', kind: 'system' },
      { textOffset: 2, content: 'provider reasoning', summary: 'reasoning', kind: 'provider' },
    ]);
    const { viaGetMessage } = persistAndReload(segments);
    const kinds = viaGetMessage
      .filter((s) => s.type === 'thinking')
      .map((s) => (s.type === 'thinking' ? s.kind : undefined));
    assert.deepEqual(kinds, ['authored', 'system', 'provider']);
  });
});

describe('Slice 3 — multi-companion ordering survives reload (contextual ownership)', () => {
  test('speaker-headed voice sections woven with kinded chips reload verbatim, in order', () => {
    // The reference implementation contextual-ownership contract: 🔷/🔶 speaker headers in
    // the TEXT segments establish the active voice; non-text segments stay
    // where they fall in the array, i.e. inside that voice's section. If
    // this ordered array reloads verbatim, ownership is preserved with no
    // explicit companionId (the renderer's splitInterleaved carries voice
    // continuity across chips — pinned on the frontend side in
    // speakers.interleaved-kinds.test.ts).
    const full = '🔷 Companion A: rolling it. Worth the risk. 🔶 Companion B: watching.';
    // Chips land mid-Companion A (right after "rolling it") and right before
    // Companion B's spoken text. Offsets computed, not hand-counted — the 🔷/🔶
    // emoji are two UTF-16 units each.
    const midCompanionA = full.indexOf('. Worth');
    const midCompanionB = full.indexOf(' Companion B');
    const tools: ToolInsertion[] = [
      { textOffset: midCompanionA, toolId: 't-dice', toolName: 'Bash', input: 'roll', output: '17', isError: false },
    ];
    const thinking: ThinkingInsertion[] = [
      { textOffset: midCompanionA, content: 'Companion A weighing the odds', summary: 'odds', kind: 'authored' },
      { textOffset: midCompanionB, content: 'model telemetry', summary: 'telemetry', kind: 'provider' },
    ];
    const segments = buildSegments(full, tools, thinking);

    // Sanity on the built shape: Companion A's section holds the tool card and
    // the authored chip (tool insertions sort first at an equal offset);
    // Companion B's section starts after the provider chip.
    assert.deepEqual(segments, [
      { type: 'text', content: '🔷 Companion A: rolling it' },
      { type: 'tool', toolId: 't-dice', toolName: 'Bash', input: 'roll', output: '17', isError: false },
      { type: 'thinking', content: 'Companion A weighing the odds', summary: 'odds', kind: 'authored' },
      { type: 'text', content: '. Worth the risk. 🔶' },
      { type: 'thinking', content: 'model telemetry', summary: 'telemetry', kind: 'provider' },
      { type: 'text', content: ' Companion B: watching.' },
    ]);

    const { viaGetMessage, viaGetMessages } = persistAndReload(segments);
    assert.deepEqual(viaGetMessage, segments, 'getMessage reload must preserve order + kinds verbatim');
    assert.deepEqual(viaGetMessages, segments, 'getMessages reload must preserve order + kinds verbatim');
  });
});

describe('silent turn persistence', () => {
  test('keeps a silent clean stop when tools or thinking need durable history', () => {
    assert.equal(shouldDiscardEmptyTurn({
      fullResponse: '',
      stoppedByUser: false,
      agentTimedOut: false,
      endedSilently: true,
      hasDurableArtifacts: true,
    }), false);
  });

  test('discards a truly empty silent clean stop', () => {
    assert.equal(shouldDiscardEmptyTurn({
      fullResponse: '',
      stoppedByUser: false,
      agentTimedOut: false,
      endedSilently: true,
      hasDurableArtifacts: false,
    }), true);
  });

  test('still discards empty user-stop and timeout corpses', () => {
    for (const flags of [
      { stoppedByUser: true, agentTimedOut: false },
      { stoppedByUser: false, agentTimedOut: true },
    ]) {
      assert.equal(shouldDiscardEmptyTurn({
        fullResponse: '',
        endedSilently: false,
        hasDurableArtifacts: true,
        ...flags,
      }), true);
    }
  });

  test('never discards a turn that contains final text', () => {
    assert.equal(shouldDiscardEmptyTurn({
      fullResponse: 'wake narration',
      stoppedByUser: true,
      agentTimedOut: true,
      endedSilently: true,
      hasDurableArtifacts: false,
    }), false);
  });
});

describe('the [SILENT] pass', () => {
  test('exactly [SILENT], give or take whitespace, is a deliberate pass; anything else is words', () => {
    assert.equal(isDeliberateSilence('[SILENT]'), true);
    assert.equal(isDeliberateSilence('  [SILENT]\n'), true);
    assert.equal(isDeliberateSilence('[SILENT] but also this'), false);
    assert.equal(isDeliberateSilence('silent'), false);
    assert.equal(isDeliberateSilence(''), false);
    assert.equal(isDeliberateSilence(undefined), false);
  });

  test('a deliberate pass is discarded even with a tool trail behind it', () => {
    assert.equal(shouldDiscardEmptyTurn({
      fullResponse: '',
      stoppedByUser: false,
      agentTimedOut: false,
      endedSilently: false,
      hasDurableArtifacts: true,
      deliberateSilence: true,
    }), true);
  });
});
