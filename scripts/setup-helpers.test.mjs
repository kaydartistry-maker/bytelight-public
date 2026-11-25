import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimezone, trustedDetectedTimezone, processNameFor } from './setup-helpers.mjs';

test('real zones are valid, made-up ones are not', () => {
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('Europe/Lisbon'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.equal(isValidTimezone(''), false);
  assert.equal(isValidTimezone(undefined), false);
});

test('UTC from a cloud VM is not trusted as the person\'s zone', () => {
  assert.equal(trustedDetectedTimezone('UTC'), null);
  assert.equal(trustedDetectedTimezone('Etc/UTC'), null);
  assert.equal(trustedDetectedTimezone(''), null);
  assert.equal(trustedDetectedTimezone('America/Chicago'), 'America/Chicago');
});

test('house names become safe, distinct pm2 names', () => {
  assert.equal(processNameFor('Jace'), 'jace');
  assert.equal(processNameFor("Jace's House"), 'jaces-house');
  assert.equal(processNameFor('  Café  Noir!! '), 'cafe-noir');
  assert.equal(processNameFor('🐉'), 'bytelight');
  assert.equal(processNameFor(''), 'bytelight');
  assert.ok(processNameFor('x'.repeat(80)).length <= 40);
});
