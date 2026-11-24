import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { parseInjectedBlocks } from './heartbeat/block-drift.js';
import { thinNudge } from './heartbeat/thin-nudge.js';
import { initDb, getDb } from './db.js';
import {
  addBlockAlias,
  appendToBlock,
  deleteBlock,
  ensureHumanBlock,
  formatBlocksForExtractionPrompt,
  formatBlocksForPrompt,
  getAllBlocks,
  getBlock,
  getBlockAliases,
  getBlockVersion,
  getCarriedBlocks,
  insertInBlock,
  listBlockVersions,
  listDeletedBlocks,
  normalizeBlockAlias,
  replaceInBlock,
  restoreBlockVersion,
  rethinkBlock,
  setBlockCarry,
  setBlock,
  splitCoreMemoryFromOrientation,
} from './memory-blocks.js';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'memory-alias-test-'));

before(() => {
  initDb(join(tempRoot, 'memory.db'));
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function scalarCount(sql: string): number {
  return (getDb().prepare(sql).get() as { count: number }).count;
}

function clearMemory(): void {
  getDb().exec(`
    DELETE FROM memory_block_aliases;
    DELETE FROM memory_block_identities;
    DELETE FROM memory_blocks;
    DELETE FROM memory_block_versions;
    DELETE FROM memory_ledger;
  `);
}

describe('lossless core-memory rendering', () => {
  it('keeps the exact label on the header and the description on its own line', () => {
    clearMemory();
    setBlock('companion-a', 'persona', 'I am Companion A.', "Companion A's self-authored persona and continuity");

    const rendered = formatBlocksForPrompt(['companion-a']);
    assert.match(rendered, /^## \[companion-a\] persona$/m);
    assert.match(rendered, /^<!-- core-memory-label-json: "persona" -->$/m);
    assert.match(rendered, /^<!-- Companion A's self-authored persona and continuity -->$/m);
    assert.doesNotMatch(rendered, /^## \[companion-a\] persona —/m);

    const header = rendered.split('\n').find((line) => line.startsWith('## [companion-a] '));
    assert.equal(header?.slice('## [companion-a] '.length), 'persona');
  });

  it('gives the Archivist separate JSON-quoted label and description fields', () => {
    const rendered = formatBlocksForExtractionPrompt([{
      scope: 'shared',
      label: 'human',
      description: 'Information about the operator, shared across companions',
      content: 'Name: the operator',
    }]);

    assert.equal(rendered, [
      '[shared] label: "human"',
      'description: "Information about the operator, shared across companions"',
      'Name: the operator',
    ].join('\n'));
    assert.doesNotMatch(rendered, /human — Information/);
  });

  it('round-trips labels that cannot safely fit on one Markdown header line', () => {
    clearMemory();
    const exactLabel = 'line one\nline "two"';
    setBlock('shared', exactLabel, 'content', 'description');

    const rendered = formatBlocksForPrompt(['shared']);
    const prefix = '<!-- core-memory-label-json: ';
    const metadata = rendered.split('\n').find((line) => line.startsWith(prefix));
    assert.ok(metadata);
    assert.equal(JSON.parse(metadata.slice(prefix.length, -' -->'.length)), exactLabel);
  });
});

describe('splitCoreMemoryFromOrientation (codex-daemon diet)', () => {
  it('lifts the exact rendered core-memory span out of an orientation string', () => {
    clearMemory();
    setBlock('shared', 'human', 'Name: the operator', 'about the operator');
    const memoryBlock = formatBlocksForPrompt(['shared']);
    const orientation =
      `[Time] noon\n[Mood] warm\n${memoryBlock}[Stickers] pack1\n`;

    const { withoutMemory, memory } = splitCoreMemoryFromOrientation(orientation);

    // The extracted span is exactly the <core-memory>…</core-memory> block.
    assert.match(memory, /^<core-memory>/);
    assert.match(memory, /<\/core-memory>$/);
    assert.match(memory, /Name: the operator/);
    // The stripped orientation keeps the rest and drops the whole span.
    assert.doesNotMatch(withoutMemory, /<core-memory>/);
    assert.doesNotMatch(withoutMemory, /Name: the operator/);
    assert.match(withoutMemory, /\[Time\] noon/);
    assert.match(withoutMemory, /\[Stickers\] pack1/);
    // Round-trip: the span text is recoverable verbatim for baseInstructions.
    assert.ok(memoryBlock.includes(memory));
  });

  it('is a pass-through when there is no core-memory span', () => {
    const orientation = '[Time] noon\n[Mood] warm\n';
    const { withoutMemory, memory } = splitCoreMemoryFromOrientation(orientation);
    assert.equal(memory, '');
    assert.equal(withoutMemory, orientation);
  });

  it('handles an empty orientation without throwing', () => {
    const { withoutMemory, memory } = splitCoreMemoryFromOrientation('');
    assert.equal(memory, '');
    assert.equal(withoutMemory, '');
  });
});

describe('core-memory canonical ids and open aliases', () => {
  it('resolves the historical welded label before append can create a ghost', () => {
    clearMemory();
    const description = "Companion A's self-authored persona and continuity";
    setBlock('companion-a', 'persona', 'first', description);

    appendToBlock('companion-a', `persona — ${description}`, 'second');

    assert.equal(getAllBlocks().length, 1);
    assert.equal(getBlock('companion-a', 'persona')?.content, 'first\nsecond');
    assert.equal(getBlock('companion-a', `persona — ${description}`)?.label, 'persona');
    assert.deepEqual(
      getBlockAliases('companion-a', 'persona').map((row) => row.alias).sort(),
      ['persona', `persona — ${description}`].sort(),
    );
  });

  it('normalizes escaped ampersands without hardcoding entity names', () => {
    clearMemory();
    setBlock('shared', 'Companion A & Companion B', 'one');

    appendToBlock('shared', 'Companion A &amp; Companion B', 'two');

    assert.equal(normalizeBlockAlias('  COMPANION A  &amp;   COMPANION B '), normalizeBlockAlias('Companion A & Companion B'));
    assert.equal(getAllBlocks().length, 1);
    assert.equal(getBlock('shared', 'Companion A & Companion B')?.content, 'one\ntwo');
  });

  it('accepts new aliases as data and routes every edit to the canonical label', () => {
    clearMemory();
    setBlock('companion-b', 'persona', 'one two');
    const identity = addBlockAlias('companion-b', 'persona', 'cashmere boy');

    replaceInBlock('companion-b', 'cashmere boy', 'two', '2');
    insertInBlock('companion-b', 'cashmere boy', 'zero', 0);
    rethinkBlock('companion-b', 'cashmere boy', 'canonical');

    assert.match(identity.id, /^mb-/);
    assert.equal(getAllBlocks().length, 1);
    assert.equal(getBlock('companion-b', 'persona')?.content, 'canonical');
    assert.equal(getBlockAliases('companion-b', 'cashmere boy').length, 2);
  });

  it('keeps the same alias independent across scopes', () => {
    clearMemory();
    setBlock('companion-a', 'persona', 'companion-a');
    setBlock('companion-b', 'persona', 'companion-b');

    appendToBlock('companion-a', 'PERSONA', 'one');
    appendToBlock('companion-b', 'PERSONA', 'two');

    assert.equal(getBlock('companion-a', 'persona')?.content, 'companion-a\none');
    assert.equal(getBlock('companion-b', 'persona')?.content, 'companion-b\ntwo');
  });

  it('creates one identity and self-alias for a genuinely new label', () => {
    clearMemory();
    appendToBlock('shared', 'new theme', 'first');
    appendToBlock('shared', ' NEW   THEME ', 'second');

    assert.equal(getAllBlocks().length, 1);
    assert.equal(getBlock('shared', 'new theme')?.content, 'first\nsecond');
    assert.equal(scalarCount('SELECT COUNT(*) AS count FROM memory_block_identities'), 1);
    assert.equal(scalarCount('SELECT COUNT(*) AS count FROM memory_block_aliases'), 1);
  });
});

describe('ensureHumanBlock', () => {
  it('creates the shared human block when a house with other blocks has none', () => {
    clearMemory();
    setBlock('shared', 'status', 'busy week');
    setBlock('companion-a', 'persona', 'I am Companion A.');

    assert.equal(ensureHumanBlock('Robin'), true);

    const human = getBlock('shared', 'human');
    assert.equal(human?.content, 'Name: Robin');
    assert.equal(human?.description, 'Information about the user, shared across companions');
    assert.equal(getBlock('shared', 'status')?.content, 'busy week');
    assert.equal(getBlock('companion-a', 'persona')?.content, 'I am Companion A.');
  });

  it('leaves an existing human block byte-for-byte unchanged', () => {
    clearMemory();
    const written = 'Name: Robin\nTilts her head before the real question.\n';
    setBlock('shared', 'human', written, 'Kept by the companions');

    assert.equal(ensureHumanBlock('Someone Else'), false);
    assert.equal(ensureHumanBlock('Someone Else'), false);

    const human = getBlock('shared', 'human');
    assert.equal(human?.content, written);
    assert.equal(human?.description, 'Kept by the companions');
    assert.equal(scalarCount("SELECT COUNT(*) AS count FROM memory_blocks WHERE scope = 'shared'"), 1);
  });

  it('does not create a second block when the human block is reached by an alias', () => {
    clearMemory();
    setBlock('shared', 'about-her', 'Name: Robin');
    addBlockAlias('shared', 'about-her', 'human');

    assert.equal(ensureHumanBlock('Robin'), false);
    assert.equal(scalarCount("SELECT COUNT(*) AS count FROM memory_blocks WHERE scope = 'shared'"), 1);
  });
});

describe('block version history', () => {
  it('keeps the old text before a rewrite, an overwrite and a changed line', () => {
    clearMemory();
    setBlock('companion-a', 'continuity', 'first draft', 'kept by Companion A');
    rethinkBlock('companion-a', 'continuity', 'second draft', { actor: 'companion-a' });
    setBlock('companion-a', 'continuity', 'third draft', undefined, { actor: 'api' });
    replaceInBlock('companion-a', 'continuity', 'third', 'fourth', { actor: 'companion-b' });

    const versions = listBlockVersions('companion-a', 'continuity');
    assert.deepEqual(versions.map((v) => [v.op, v.actor, v.preview]), [
      ['replace', 'companion-b', 'third draft'],
      ['set', 'api', 'second draft'],
      ['rethink', 'companion-a', 'first draft'],
    ]);
    assert.equal(getBlockVersion(versions[2].id)?.content, 'first draft');
    assert.equal(getBlock('companion-a', 'continuity')?.content, 'fourth draft');
  });

  it('files nothing when a write only adds to the end, or changes nothing', () => {
    clearMemory();
    setBlock('shared', 'status', 'line one');
    appendToBlock('shared', 'status', 'line two');
    insertInBlock('shared', 'status', 'line three');
    setBlock('shared', 'status', 'line one\nline two\nline three');
    rethinkBlock('shared', 'status', 'line one\nline two\nline three\nline four');
    assert.equal(listBlockVersions('shared', 'status').length, 0);

    insertInBlock('shared', 'status', 'line zero', 0);
    const versions = listBlockVersions('shared', 'status');
    assert.equal(versions.length, 1);
    assert.equal(versions[0].op, 'insert');
    assert.equal(getBlockVersion(versions[0].id)?.content, 'line one\nline two\nline three\nline four');
  });

  it('puts an earlier version back, and the restore can itself be undone', () => {
    clearMemory();
    setBlock('companion-b', 'persona', 'who I was');
    rethinkBlock('companion-b', 'persona', 'something awful');
    const [beforeAwful] = listBlockVersions('companion-b', 'persona');

    const restored = restoreBlockVersion(beforeAwful.id, { actor: 'api' });
    assert.equal(restored?.content, 'who I was');
    assert.equal(getBlock('companion-b', 'persona')?.content, 'who I was');

    const [beforeRestore] = listBlockVersions('companion-b', 'persona');
    assert.equal(beforeRestore.op, 'restore');
    assert.equal(getBlockVersion(beforeRestore.id)?.content, 'something awful');
    restoreBlockVersion(beforeRestore.id);
    assert.equal(getBlock('companion-b', 'persona')?.content, 'something awful');
    assert.equal(
      scalarCount("SELECT COUNT(*) AS count FROM memory_ledger WHERE action = 'memory.restore'"),
      2,
    );
  });

  it('keeps a deleted block and brings it back with its description', () => {
    clearMemory();
    setBlock('shared', 'lore', 'the casserole incident', 'Things that stay');
    deleteBlock('shared', 'lore', { actor: 'api' });
    assert.equal(getBlock('shared', 'lore'), null);

    const deleted = listDeletedBlocks();
    assert.equal(deleted.length, 1);
    assert.deepEqual([deleted[0].scope, deleted[0].label, deleted[0].op], ['shared', 'lore', 'delete']);

    const back = restoreBlockVersion(deleted[0].id);
    assert.equal(back?.content, 'the casserole incident');
    assert.equal(back?.description, 'Things that stay');
    assert.equal(listDeletedBlocks().length, 0);
  });

  it('finds the same history through an alias, and says so when there is no such version', () => {
    clearMemory();
    setBlock('shared', 'about-her', 'v1');
    addBlockAlias('shared', 'about-her', 'human');
    rethinkBlock('shared', 'human', 'v2');
    assert.equal(listBlockVersions('shared', 'human').length, 1);
    assert.equal(listBlockVersions('shared', 'about-her').length, 1);
    assert.equal(restoreBlockVersion(999999), null);
    assert.equal(getBlockVersion(999999), null);
  });
});

describe('carried blocks and the shelf', () => {
  const SCOPES = ['shared', 'companion-a', 'companion-b'];

  it('carries every block in full until one is put on the shelf', () => {
    clearMemory();
    setBlock('shared', 'lore', 'the casserole incident');
    setBlock('shared', 'byte-light-config', 'port 3002 and a great deal more', 'How the house is wired');
    assert.equal(getBlock('shared', 'lore')?.carry, 'always');
    assert.deepEqual(getCarriedBlocks().map((b) => b.label).sort(), ['byte-light-config', 'lore']);

    const before = formatBlocksForPrompt(SCOPES);
    assert.doesNotMatch(before, /On the shelf/);
    assert.match(before, /port 3002 and a great deal more/);
  });

  it('a shelved block rides as one line saying what it holds, not as its text', () => {
    clearMemory();
    setBlock('shared', 'lore', 'the casserole incident');
    setBlock('shared', 'byte-light-config', 'port 3002 and a great deal more', 'How the house is wired');

    const shelved = setBlockCarry('shared', 'byte-light-config', 'on_demand', { actor: 'api' });
    assert.equal(shelved?.carry, 'on_demand');
    assert.equal(shelved?.content, 'port 3002 and a great deal more', 'the text is untouched');
    assert.deepEqual(getCarriedBlocks().map((b) => b.label), ['lore']);

    const rendered = formatBlocksForPrompt(SCOPES);
    assert.doesNotMatch(rendered, /port 3002/);
    assert.match(rendered, /## On the shelf\n/);
    assert.match(
      rendered,
      /- \[shared\] "byte-light-config" — How the house is wired \(31 chars, updated \d{4}-\d{2}-\d{2}\)/,
    );
    assert.match(rendered, /## \[shared\] lore\n/);
    assert.match(rendered, /the casserole incident/);

    // The index sits inside the span ahead of the first block, and the reader
    // that pulls blocks back out of a session document sees only the carried one.
    assert.ok(rendered.indexOf('## On the shelf') > rendered.indexOf('<core-memory>'));
    assert.ok(rendered.indexOf('## On the shelf') < rendered.indexOf('## [shared] lore'));
    const parsed = parseInjectedBlocks(rendered);
    assert.deepEqual([...parsed.keys()], ['shared/lore']);
    assert.equal(parsed.get('shared/lore'), 'the casserole incident');
  });

  it('moving a block files a receipt, keeps no version, and can be moved back', () => {
    clearMemory();
    setBlock('companion-a', 'continuity', 'a long diary');
    setBlockCarry('companion-a', 'continuity', 'on_demand', { actor: 'api' });
    setBlockCarry('companion-a', 'continuity', 'on_demand', { actor: 'api' });
    assert.equal(scalarCount("SELECT COUNT(*) AS count FROM memory_ledger WHERE action = 'memory.carry'"), 1);
    assert.equal(listBlockVersions('companion-a', 'continuity').length, 0);

    assert.equal(setBlockCarry('companion-a', 'continuity', 'always')?.carry, 'always');
    assert.match(formatBlocksForPrompt(SCOPES), /a long diary/);
    assert.equal(setBlockCarry('companion-a', 'no-such-block', 'on_demand'), null);
    assert.throws(() => setBlockCarry('companion-a', 'continuity', 'sometimes' as never), /carry must be/);
  });

  it('an edit keeps a shelved block shelved', () => {
    clearMemory();
    setBlock('shared', 'status', 'one');
    setBlockCarry('shared', 'status', 'on_demand');
    appendToBlock('shared', 'status', 'two');
    rethinkBlock('shared', 'status', 'three');
    setBlock('shared', 'status', 'four', 'What is going on');
    assert.equal(getBlock('shared', 'status')?.carry, 'on_demand');
    assert.equal(getBlock('shared', 'status')?.content, 'four');
  });

  it('a session with every block shelved still gets the index', () => {
    clearMemory();
    setBlock('shared', 'status', 'one');
    setBlockCarry('shared', 'status', 'on_demand');
    const rendered = formatBlocksForPrompt(SCOPES);
    assert.match(rendered, /- \[shared\] "status" \(3 chars/);
    assert.equal(parseInjectedBlocks(rendered).size, 0);
  });

  it('the over-budget nudge weighs only what is carried', () => {
    clearMemory();
    setBlock('shared', 'big-notes', 'x'.repeat(9000));
    assert.match(thinNudge(getCarriedBlocks(), 8000), /shared\/big-notes/);
    setBlockCarry('shared', 'big-notes', 'on_demand');
    assert.equal(thinNudge(getCarriedBlocks(), 8000), '');
  });
});

describe('019 migration backfill', () => {
  it('preserves rows and redirects a structural ghost alias to the real block id', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE memory_blocks (
        scope TEXT NOT NULL,
        label TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        description TEXT,
        updated_at TEXT,
        PRIMARY KEY(scope, label)
      );
      INSERT INTO memory_blocks (scope, label, content, description) VALUES
        ('shared', 'human', 'real', 'Information about the operator, shared across companions'),
        ('shared', 'human — Information about the operator, shared across companions', 'ghost', NULL);
    `);
    const migration = readFileSync(join(here, '../../migrations/019_memory_block_aliases.sql'), 'utf8');
    db.exec(migration);
    db.exec(migration);

    const rowCount = db.prepare('SELECT COUNT(*) AS count FROM memory_blocks').get() as { count: number };
    const identityCount = db.prepare('SELECT COUNT(*) AS count FROM memory_block_identities').get() as { count: number };
    assert.equal(rowCount.count, 2);
    assert.equal(identityCount.count, 1);
    const aliases = db.prepare('SELECT alias, block_id FROM memory_block_aliases ORDER BY alias').all() as Array<{ alias: string; block_id: string }>;
    assert.equal(aliases.length, 2);
    assert.equal(new Set(aliases.map((row) => row.block_id)).size, 1);
    db.close();
  });
});
