import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo } from './time';

const NOW = new Date('2026-07-15T12:00:00.000Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('minutes, hours and days count down with floor', () => {
  assert.equal(timeAgo(ago(30_000), {}, NOW), 'just now');
  assert.equal(timeAgo(ago(90_000), {}, NOW), '1m ago');
  assert.equal(timeAgo(ago(59 * MIN), {}, NOW), '59m ago');
  assert.equal(timeAgo(ago(100 * MIN), {}, NOW), '1h ago');
  assert.equal(timeAgo(ago(30 * DAY), {}, NOW), '30d ago');
});

test('future timestamps read as just now', () => {
  assert.equal(timeAgo(ago(-5 * MIN), {}, NOW), 'just now');
});

test('dateAfterDays switches to a calendar date', () => {
  assert.equal(timeAgo(ago(6 * DAY), { dateAfterDays: 7 }, NOW), '6d ago');
  assert.equal(timeAgo(ago(7 * DAY), { dateAfterDays: 7 }, NOW), '8 Jul');
  assert.equal(timeAgo(ago(25 * HOUR), { dateAfterDays: 1 }, NOW), '14 Jul');
  assert.equal(
    timeAgo(ago(8 * DAY), { dateAfterDays: 7, formatDate: () => 'custom' }, NOW),
    'custom',
  );
});

test('sqliteUtc reads zone-less timestamps as UTC', () => {
  assert.equal(timeAgo('2026-07-15 11:00:00', { sqliteUtc: true }, NOW), '1h ago');
});

test('unparseable input comes back unchanged', () => {
  assert.equal(timeAgo('not a date', {}, NOW), 'not a date');
});
