import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendMaintenanceEntry,
  listMaintenanceEntries,
  verifyMaintenanceStartup,
} from './maintenance-ledger.js';

test('maintenance ledger preserves stages and caps retained history', () => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-ledger-'));
  try {
    for (let i = 0; i < 105; i++) {
      appendMaintenanceEntry(root, {
        kind: 'night_watch', title: `Repair ${i}`, summary: 'bounded repair',
        stage: 'built', checks: ['regression passed'], restartRequired: true,
      });
    }
    const entries = listMaintenanceEntries(root);
    assert.equal(entries.length, 100);
    assert.equal(entries[0].title, 'Repair 104');
    assert.equal(entries[0].stage, 'built');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('startup verification promotes only older waiting entries when checks pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-startup-'));
  try {
    const phone = join(root, 'phone'); mkdirSync(phone); writeFileSync(join(phone, 'index.html'), 'ok');
    appendMaintenanceEntry(root, {
      kind: 'deep_work', title: 'Loaded repair', summary: 'ready', stage: 'waiting_for_restart',
      checks: ['build passed'], restartRequired: true, builtAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await verifyMaintenanceStartup(root, {
      compiledAt: new Date('2026-01-02T00:00:00.000Z'), phoneBuildPath: phone,
      databaseCheck: () => 'ok', scheduleCheck: async () => 3,
    });
    assert.equal(result.stage, 'verified_live');
    const repaired = listMaintenanceEntries(root).find((e) => e.title === 'Loaded repair');
    assert.equal(repaired?.stage, 'verified_live');
    assert.equal(repaired?.restartRequired, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed startup proof stays visible and does not promote waiting work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-startup-fail-'));
  try {
    appendMaintenanceEntry(root, {
      kind: 'night_watch', title: 'Still waiting', summary: 'ready', stage: 'waiting_for_restart',
      checks: [], restartRequired: true, builtAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await verifyMaintenanceStartup(root, {
      compiledAt: new Date('2026-01-02T00:00:00.000Z'), phoneBuildPath: null,
      databaseCheck: () => 'ok', scheduleCheck: async () => 0,
    });
    assert.equal(result.stage, 'blocked');
    assert.equal(listMaintenanceEntries(root).find((e) => e.title === 'Still waiting')?.stage, 'waiting_for_restart');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
