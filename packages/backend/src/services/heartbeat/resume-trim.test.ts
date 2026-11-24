// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Trimming the stale house out of a reopened room.
 *
 * A session start injects the whole CLAUDE.md as one attachment record and the
 * old copies never leave. Measured Sep 9 2026 on the live lane: three copies,
 * 1.1 MB of a 2.5 MB transcript, ~92k tokens each. Resume does not ADD the
 * room, it declines to throw it away, so the only NEW thing a restart injects
 * is another instruction copy.
 *
 * The delicate part is not the dropping, it is the RE-LINKING: every record
 * names its parent, so cutting one out of the middle orphans its child. These
 * pin that, including the consecutive case, because a chain of instruction
 * blocks is exactly what a twice-resumed transcript has in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  stripStaleInstructions, projectSlugFor, transcriptPathFor, prepareResumeTranscript,
} from './supervisor.js';

const instr = (uuid: string, parent?: string) => ({
  type: 'attachment', uuid, parentUuid: parent, attachment: { type: 'instructions', files: [] },
});
const other = (uuid: string, parent?: string, sub = 'total_tokens_reminder') => ({
  type: 'attachment', uuid, parentUuid: parent, attachment: { type: sub },
});
const said = (uuid: string, parent?: string) => ({
  type: 'assistant', uuid, parentUuid: parent, message: { content: [{ type: 'text', text: 'hi' }] },
});

test('the instruction copies come out and nothing else does', () => {
  const rows = [said('a'), instr('b', 'a'), other('c', 'b'), said('d', 'c')];
  const { rows: kept, dropped } = stripStaleInstructions(rows);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map(r => r.uuid), ['a', 'c', 'd']);
});

test('a record orphaned by the cut inherits the surviving parent', () => {
  const rows = [said('a'), instr('b', 'a'), said('c', 'b')];
  const { rows: kept } = stripStaleInstructions(rows);
  assert.equal(kept.find(r => r.uuid === 'c')?.parentUuid, 'a');
});

test('consecutive instruction blocks are walked, not stepped over once', () => {
  // A twice-resumed transcript has these back to back. Re-linking to the
  // immediate parent would point the survivor at another dropped record.
  const rows = [said('a'), instr('b', 'a'), instr('c', 'b'), instr('d', 'c'), said('e', 'd')];
  const { rows: kept, dropped } = stripStaleInstructions(rows);
  assert.equal(dropped, 3);
  assert.deepEqual(kept.map(r => r.uuid), ['a', 'e']);
  assert.equal(kept.find(r => r.uuid === 'e')?.parentUuid, 'a');
});

test('a transcript with nothing to trim is handed back untouched', () => {
  // prepareResumeTranscript reads this as "do not write a copy at all".
  const rows = [said('a'), other('b', 'a')];
  const { rows: kept, dropped } = stripStaleInstructions(rows);
  assert.equal(dropped, 0);
  assert.equal(kept, rows, 'same array, not a rebuilt one');
});

test('the other attachment kinds are never mistaken for instructions', () => {
  const rows = [
    other('a', undefined, 'prompt_snapshot'),
    other('b', 'a', 'deferred_tools_delta'),
    other('c', 'b', 'session_context'),
  ];
  assert.equal(stripStaleInstructions(rows).dropped, 0);
});

test('a transcript past the size ceiling is reopened untrimmed rather than read whole', () => {
  // A throwaway lane, so the transcript lands in a project folder nothing
  // else owns — and that folder goes at the end, whatever the assertions did.
  const lane = join(tmpdir(), `hb-trim-test-${randomUUID()}`);
  const id = randomUUID();
  const src = transcriptPathFor(lane, id);
  mkdirSync(dirname(src), { recursive: true });
  try {
    // Two instruction copies, so there IS something to trim.
    const rows = [instr('a'), said('b', 'a'), instr('c', 'b'), said('d', 'c')]
      .map((r) => ({ ...r, sessionId: id }));
    writeFileSync(src, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // Over the ceiling: no copy written, the untrimmed id stands.
    assert.equal(prepareResumeTranscript(lane, id, 10), null);
    assert.deepEqual(readdirSync(dirname(src)), [`${id}.jsonl`]);

    // Under it: the trim runs exactly as before.
    const trimmed = prepareResumeTranscript(lane, id);
    assert.ok(trimmed && trimmed !== id);
    assert.equal(existsSync(transcriptPathFor(lane, trimmed)), true);
  } finally {
    rmSync(dirname(src), { recursive: true, force: true });
  }
});

test('the project slug matches this box own folder naming', () => {
  // BUILT from the environment, never written down — a tracked file must not
  // carry the owner's home directory. The expectation is spelled out here independently of the function
  // under test: every non-alphanumeric becomes a dash, which is why an
  // underscore in a username lands as one.
  const lane = join(homedir(), 'bytelight', 'data', 'heartbeat', 'primary');
  const expected = lane.replace(/[^a-zA-Z0-9]/g, '-');
  assert.match(expected, /^-.+-bytelight-data-heartbeat-primary$/);
  assert.equal(projectSlugFor(lane), expected);
  assert.equal(
    transcriptPathFor(lane, 'abc').endsWith(`/.claude/projects/${expected}/abc.jsonl`),
    true,
  );
});

test('the ceiling is well under this house\'s live transcript sizes', async () => {
  const { RESUME_TRIM_MAX_BYTES } = await import('./supervisor.js');
  // Lane transcripts here already run 58-67 MB; reading one whole into the
  // backend heap is the failure the ceiling exists to prevent.
  assert.ok(RESUME_TRIM_MAX_BYTES <= 32 * 1024 * 1024);
});

test('when the dropped record is the root, its child keeps an explicit null parent', () => {
  const rows = [instr('a'), said('b', 'a')];
  const { rows: kept } = stripStaleInstructions(rows);
  const line = JSON.parse(JSON.stringify(kept[0]));
  assert.equal('parentUuid' in line, true, 'the key survives serialisation');
  assert.equal(line.parentUuid, null);
});

// ─── Which way a reopened room sheds its stale copy, and the disk it leaves ──

test('the hold is preferred: the trim only runs when the room takes a whole new copy anyway', async () => {
  const { resumeInstructionPath } = await import('./supervisor.js');
  assert.equal(resumeInstructionPath('hold'), 'hold', 'only the moved walls ride; nothing to trim');
  assert.equal(resumeInstructionPath('same'), 'none', 'the CLI attaches nothing new; a trim would only cost disk');
  for (const r of ['outside-walls', 'too-big', 'no-copy'] as const) {
    assert.equal(resumeInstructionPath(r), 'trim', `${r}: a whole new copy is coming, so drop the stale ones`);
  }
});

// ─── The trimmed copy replaces the original only once it is proven sound ──
//
// Minimal disk: no fallback copy is kept around. The trimmed copy is written
// and read back; only if every line parses, every parent it names is present
// and the last record made it, is the original deleted in the same step.
// Otherwise the copy goes and the original is reopened untrimmed.

function trimmableLane() {
  const lane = join(tmpdir(), `hb-trim-validate-${randomUUID()}`);
  const id = randomUUID();
  const src = transcriptPathFor(lane, id);
  mkdirSync(dirname(src), { recursive: true });
  const rows = [said('root'), instr('i1', 'root'), said('b', 'i1'), instr('i2', 'b'), said('last', 'i2')]
    .map((r) => ({ ...r, sessionId: id }));
  writeFileSync(src, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { lane, id, src, folder: dirname(src) };
}

test('a sound trimmed copy replaces the original: exactly one transcript, no record file', async () => {
  const { prepareResumeTranscript: prepare } = await import('./supervisor.js');
  const t = trimmableLane();
  try {
    const next = prepare(t.lane, t.id);
    assert.ok(next && next !== t.id);
    assert.deepEqual(readdirSync(t.folder), [`${next}.jsonl`], 'the original is gone, the copy stands alone');
    assert.equal(existsSync(join(t.lane, 'io', '.superseded-transcript')), false);
  } finally { rmSync(t.folder, { recursive: true, force: true }); }
});

test('a copy that fails validation is discarded and the original is reopened untrimmed', async () => {
  const { prepareResumeTranscript: prepare } = await import('./supervisor.js');
  const t = trimmableLane();
  const before = readFileSync(t.src, 'utf8');
  try {
    const next = prepare(t.lane, t.id, undefined, () => false);
    assert.equal(next, null, 'resume the original id');
    assert.deepEqual(readdirSync(t.folder), [`${t.id}.jsonl`], 'only the original remains');
    assert.equal(readFileSync(t.src, 'utf8'), before, 'untouched');
  } finally { rmSync(t.folder, { recursive: true, force: true }); }
});

test('validation catches a torn line, a dangling parent, a missing last record and a short copy', async () => {
  const { validateTrimmedTranscript } = await import('./supervisor.js');
  const dir = mkdtempSync(join(tmpdir(), 'hb-validate-'));
  const p = join(dir, 'b.jsonl');
  const good = [said('a'), said('b', 'a'), said('c', 'b')];
  const expect = { count: 3, last: JSON.stringify(good[2]) };
  const write = (rows: unknown[], tail = '') => writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n' + tail);
  try {
    write(good);
    assert.equal(validateTrimmedTranscript(p, expect), true);
    write(good, '{"torn":');
    assert.equal(validateTrimmedTranscript(p, expect), false, 'torn line');
    write([said('a'), said('b', 'gone'), said('c', 'b')]);
    assert.equal(validateTrimmedTranscript(p, { count: 3, last: JSON.stringify(said('c', 'b')) }), false, 'dangling parent');
    write(good.slice(0, 2));
    assert.equal(validateTrimmedTranscript(p, expect), false, 'last record missing / short');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty or missing original is not reopened at all', async () => {
  const { transcriptUsable } = await import('./supervisor.js');
  const t = trimmableLane();
  try {
    assert.equal(transcriptUsable(t.lane, t.id), true);
    writeFileSync(t.src, '');
    assert.equal(transcriptUsable(t.lane, t.id), false);
    assert.equal(transcriptUsable(t.lane, randomUUID()), false);
  } finally { rmSync(t.folder, { recursive: true, force: true }); }
});

test('the new id is banked before the original goes; if banking fails, the original stays and is resumed', async () => {
  const { prepareResumeTranscript: prepare } = await import('./supervisor.js');
  const t = trimmableLane();
  try {
    let originalAtCommit: boolean | null = null;
    const next = prepare(t.lane, t.id, undefined, undefined, () => { originalAtCommit = existsSync(t.src); return false; });
    assert.equal(originalAtCommit, true, 'the id is written while the original still exists');
    assert.equal(next, null, 'a failed id write resumes the original untrimmed');
    assert.deepEqual(readdirSync(t.folder), [`${t.id}.jsonl`], 'original kept, copy discarded');
  } finally { rmSync(t.folder, { recursive: true, force: true }); }
});
