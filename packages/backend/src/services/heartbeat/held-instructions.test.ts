// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * A restart hands a reopened room the walls that moved, not a second whole
 * copy of the instructions (theirs, Nov 10 2026).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastInjectedClaudeMd, planHold, HELD_NOTE_MAX_BYTES } from './held-instructions.js';
import { RESUME_PROMPT, resumePromptWithHeld } from './supervisor.js';

function md(walls: Record<string, string>, house = '# House\nrules\n'): string {
  const blocks = Object.entries(walls)
    .map(([key, body]) => {
      const [scope, label] = key.split('/');
      return `## [${scope}] ${label}\n${body}\n`;
    })
    .join('\n');
  return `${house}\n<core-memory>\n${blocks}\n</core-memory>\n\n# Heartbeat\n`;
}

test('the same file holds nothing, and a change outside the walls takes the whole copy', () => {
  const a = md({ 'shared/human': 'one' });
  assert.deepEqual(planHold(a, a), { hold: false, reason: 'same' });
  assert.deepEqual(planHold(null, a), { hold: false, reason: 'no-copy' });
  // The CLI keeps the file without its last newline.
  assert.deepEqual(planHold(a.trimEnd(), a), { hold: false, reason: 'same' });
  // ...and without the comment lines under each wall's heading.
  const commented = a.replace('## [shared] human\n', '## [shared] human\n<!-- Information about the user -->\n');
  assert.deepEqual(planHold(a.trimEnd(), commented), { hold: false, reason: 'same' });
  const b = md({ 'shared/human': 'two' }, '# House\nnew rule\n');
  assert.deepEqual(planHold(a, b), { hold: false, reason: 'outside-walls' });
});

test('a wall that moved is held, and only that wall goes in the note', () => {
  const room = md({ 'shared/human': 'old line', 'shared/lore': 'same', 'companion-a/persona': 'gone soon' });
  const now = md({ 'shared/human': 'old line\nnew line', 'shared/lore': 'same', 'companion-b/persona': 'brand new' });
  const plan = planHold(room, now);
  assert.equal(plan.hold, true);
  if (!plan.hold) return;
  assert.deepEqual(plan.changed.sort(), ['companion-b/persona', 'shared/human']);
  assert.deepEqual(plan.removed, ['companion-a/persona']);
  // A wall this short reads shorter whole than as a list of changes.
  assert.match(plan.note, /## \[shared\] human \(whole wall, rewritten\)\nold line\nnew line/);
  assert.match(plan.note, /## \[companion-b\] persona \(whole wall, new\)\nbrand new/);
  assert.doesNotMatch(plan.note, /\[shared\] lore/);
});

test('a long wall with one line edited sends that line, not the wall', () => {
  const long = Array.from({ length: 400 }, (_, i) => `fact number ${i} about the house`).join('\n');
  const room = md({ 'shared/status': long });
  const now = md({ 'shared/status': long.replace('fact number 7 about', 'fact number 7, corrected, about') + '\nnew fact' });
  const plan = planHold(room, now);
  assert.equal(plan.hold, true);
  if (!plan.hold) return;
  assert.match(plan.note, /- fact number 7 about the house/);
  assert.match(plan.note, /\+ fact number 7, corrected, about the house/);
  assert.match(plan.note, /\+ new fact/);
  assert.ok(plan.note.length < 1500, `note was ${plan.note.length}`);
});

test('a note too big for one argument takes the whole copy instead', () => {
  const room = md({ 'shared/lore': 'a' });
  const now = md({ 'shared/lore': Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n') });
  assert.deepEqual(planHold(room, now), { hold: false, reason: 'too-big' });
});

test('the resume prompt stops saying the file was re-read and carries the note', () => {
  for (const base of [RESUME_PROMPT]) {
    const out = resumePromptWithHeld(base, '[WALLS MOVED] x');
    assert.doesNotMatch(out, /re-read fresh/);
    assert.match(out, /walls that moved while the house was down are at the end/);
    assert.ok(out.endsWith('[WALLS MOVED] x'));
    assert.equal(resumePromptWithHeld(base, ''), base);
  }
});

test('the room copy is the newest one, found from the end across windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'held-'));
  try {
    const mdPath = '/lane/CLAUDE.md';
    const inst = (content: string) => JSON.stringify({
      type: 'attachment',
      attachment: { type: 'instructions', files: [{ path: '/other/MEMORY.md', content: 'm' }, { path: mdPath, content }] },
    });
    const filler = JSON.stringify({ type: 'user', message: { content: 'f'.repeat(3 * 1024 * 1024) } });
    // Lines bigger than a window's slack, so the newest copy straddles a window edge.
    const lines = [inst('OLDEST'), filler, filler, inst('MIDDLE ' + 'p'.repeat(5 * 1024 * 1024)), filler, filler, filler,
      inst('NEWEST ' + 'q'.repeat(10 * 1024 * 1024)), filler, JSON.stringify({ type: 'assistant', note: '"instructions" in passing, not a record' })];
    const path = join(dir, 't.jsonl');
    writeFileSync(path, lines.join('\n') + '\n');
    assert.ok(lastInjectedClaudeMd(path, mdPath)?.startsWith('NEWEST '));
    assert.equal(lastInjectedClaudeMd(path, '/nowhere/CLAUDE.md'), null);
    assert.equal(lastInjectedClaudeMd(join(dir, 'missing.jsonl'), mdPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('this house\'s own CLAUDE.md shape: the core-memory heading sits inside the walls', () => {
  // Lane CLAUDE.md here is the operational contract, then "## Core memory",
  // then the <core-memory> walls. A moved wall must hold, and the contract
  // above the walls must still count as "outside".
  const house = (walls: string) =>
    `# Heartbeat operation\ncontract\n\n## Core memory\n<core-memory>\n## [shared] status\n${walls}\n</core-memory>\n`;
  const plan = planHold(house('old'), house('old\nnew'));
  assert.equal(plan.hold, true);
  const outside = planHold(house('old'), house('old').replace('contract', 'contract changed'));
  assert.deepEqual(outside, { hold: false, reason: 'outside-walls' });
});

test('a held room keeps the old hash for the walls it still holds, so a compaction sees them as moved', async () => {
  const { heldBaseline } = await import('./held-instructions.js');
  const { baselineFrom, driftAgainstBaseline } = await import('./block-drift.js');
  const room = md({ 'shared/human': 'old line', 'shared/lore': 'same', 'companion-a/persona': 'gone soon' });
  const liveBlocks = [
    { scope: 'shared', label: 'human', content: 'old line\nnew line' },
    { scope: 'shared', label: 'lore', content: 'same' },
    { scope: 'companion-b', label: 'persona', content: 'brand new' },
  ];
  const plan = planHold(room, md({ 'shared/human': 'old line\nnew line', 'shared/lore': 'same', 'companion-b/persona': 'brand new' }));
  assert.equal(plan.hold, true);
  if (!plan.hold) return;

  // The old behaviour: a baseline from the live blocks reports nothing moved.
  assert.deepEqual(driftAgainstBaseline(baselineFrom(liveBlocks), liveBlocks).changed, []);

  const baseline = heldBaseline(baselineFrom(liveBlocks), room, plan.changed, plan.removed);
  const drift = driftAgainstBaseline(baseline, liveBlocks);
  assert.deepEqual(drift.changed.map((b) => `${b.scope}/${b.label}`).sort(), ['companion-b/persona', 'shared/human']);
  assert.deepEqual(drift.removed, ['companion-a/persona']);
});
