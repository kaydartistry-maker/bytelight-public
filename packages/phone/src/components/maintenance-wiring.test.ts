import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8');

test('Status owns a Maintenance tab backed by the maintenance endpoint', () => {
  const status = read('StatusApp');
  const maintenance = read('MaintenanceApp');
  assert.match(status, /id: 'maintenance', label: 'Maintenance'/);
  assert.match(status, /<MaintenanceApp/);
  assert.match(maintenance, /\/api\/maintenance/);
  for (const stage of ['Found', 'Fixed', 'Built', 'Waiting for restart', 'Verified live', 'Needs attention']) {
    assert.match(maintenance, new RegExp(stage));
  }
});
