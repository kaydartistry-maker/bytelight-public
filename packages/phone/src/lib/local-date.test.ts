import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ymd, todayYmd, parseYmd, addDays, mondayOf } from './local-date.js';

// Run under TZ=America/New_York. 8:30 PM Tuesday on Eastern time is already Wednesday in UTC;
// the Command Center must still call it Tuesday.
const inNewYork = new Date('2026-10-21T00:30:00Z').getTimezoneOffset() === 240;

test('an evening log stays on the local day, not the UTC one', { skip: !inNewYork && 'run with TZ=America/New_York' }, () => {
  assert.equal(ymd(new Date('2026-10-21T00:30:00Z')), '2026-10-20');
  assert.equal(ymd(new Date('2026-10-21T03:59:00Z')), '2026-10-20');
  assert.equal(ymd(new Date('2026-10-21T04:00:00Z')), '2026-10-21');
});

test('todayYmd is the local calendar date', () => {
  const now = new Date();
  assert.equal(todayYmd(), ymd(now));
});

test('parseYmd reads a date as local midnight, so its day number never slips', () => {
  const d = parseYmd('2026-10-21');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 21);
  assert.equal(d.getDay(), 3); // Wednesday
});

test('addDays steps across months, years and the DST change', () => {
  assert.equal(addDays('2026-10-20', 1), '2026-10-21');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // DST ends Nov 1 in the US
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('mondayOf finds the Monday of the local week', () => {
  assert.equal(mondayOf('2026-10-21'), '2026-10-19'); // Wed -> Mon
  assert.equal(mondayOf('2026-10-19'), '2026-10-19'); // Mon stays
  assert.equal(mondayOf('2026-10-25'), '2026-10-19'); // Sun -> previous Mon
});

test('no Command Center screen derives a calendar day from UTC', () => {
  const ccDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'cc');
  for (const f of ['CcCare.tsx', 'CcCalendar.tsx', 'CcPlanner.tsx', 'CcOverview.tsx']) {
    const src = readFileSync(join(ccDir, f), 'utf8');
    assert.ok(!/toISOString\(\)\.(split|slice)/.test(src), `${f} still builds a date from UTC`);
  }
});
