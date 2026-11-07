import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'companion-card-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb } = await import('../db.js');
const { listCompanions, updateCompanionCard } = await import('./rooms.js');

before(() => initDb(dbPath));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('companion card', () => {
  it('a fresh house has the card columns (migration 026)', () => {
    const compA = listCompanions().find((c) => c.id === 'companion-a');
    assert.ok(compA);
    assert.equal(compA.bio, null);
    assert.equal(compA.status, null);
    assert.equal(compA.phone, null);
  });

  it('re-running init on the same DB is harmless (duplicate columns are fine)', () => {
    assert.doesNotThrow(() => initDb(dbPath));
  });

  it('writes only the fields sent and reads them back', () => {
    const updated = updateCompanionCard('companion-a', { bio: 'Plainspoken, modern, heartfelt.' });
    assert.equal(updated?.bio, 'Plainspoken, modern, heartfelt.');
    assert.equal(updated?.display_name, 'Companion A');
    assert.equal(listCompanions().find((c) => c.id === 'companion-a')?.bio, 'Plainspoken, modern, heartfelt.');
    // Companion B untouched.
    assert.equal(listCompanions().find((c) => c.id === 'companion-b')?.bio, null);
  });

  it('null clears a field', () => {
    updateCompanionCard('companion-a', { status: 'Online' });
    assert.equal(updateCompanionCard('companion-a', { status: null })?.status, null);
  });

  it('an unknown companion is null, not a crash', () => {
    assert.equal(updateCompanionCard('nobody', { bio: 'x' }), null);
  });
});
