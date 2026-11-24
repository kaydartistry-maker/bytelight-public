import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldRenewSession } from './auth.js';

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;
const NOW = Date.parse('2026-09-03T12:00:00.000Z');

const expiringIn = (ms: number) => new Date(NOW + ms).toISOString();

test('a session issued moments ago is not rewritten', () => {
  // Nothing of the window has been spent yet, so ordinary traffic on a fresh
  // login must cost neither a database write nor a Set-Cookie header.
  assert.equal(shouldRenewSession(expiringIn(YEAR), NOW), false);
  assert.equal(shouldRenewSession(expiringIn(YEAR - 60_000), NOW), false);
});

test('renewal holds off until a full day of the window is spent', () => {
  // One second short of a day in: still no write.
  assert.equal(shouldRenewSession(expiringIn(YEAR - DAY + 1000), NOW), false);
  // A day in: renew.
  assert.equal(shouldRenewSession(expiringIn(YEAR - DAY), NOW), true);
});

test('an old but still-valid session renews', () => {
  // Near expiry, a still-valid session renews before ordinary HTTP calls begin
  // failing while an already-open socket appears healthy.
  assert.equal(shouldRenewSession(expiringIn(DAY), NOW), true);
  assert.equal(shouldRenewSession(expiringIn(60_000), NOW), true);
});

test('an unreadable expiry never triggers a write', () => {
  // Absent is not false: if we cannot read the expiry we leave the row alone
  // rather than silently handing out a fresh week on a value we did not parse.
  assert.equal(shouldRenewSession('not a date', NOW), false);
  assert.equal(shouldRenewSession('', NOW), false);
});

test('clock skew into the future does not renew', () => {
  // An expiry further out than a whole window means someone else already
  // extended it, or the clock moved. Either way there is nothing to buy.
  assert.equal(shouldRenewSession(expiringIn(YEAR + DAY), NOW), false);
});
