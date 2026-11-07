// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// A crash report becomes one bounded log line, and an empty one becomes none.

import test from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_CEILINGS, clientErrorLine, createReportCeiling } from './client-errors.js';

test('a crash report is one bounded line with what broke and where', () => {
  const line = clientErrorLine(
    { message: 'text.replace is not a function', stack: 'x'.repeat(5000), componentStack: '\n    at ThreadSwitcher', where: '/chat' },
    new Date('2026-03-03T20:00:00.000Z'),
  );
  assert.ok(line);
  assert.equal(line.includes('\n'), false, 'one line in the log, whatever the stack holds');
  const parsed = JSON.parse(line);
  assert.equal(parsed.message, 'text.replace is not a function');
  assert.equal(parsed.where, '/chat');
  assert.equal(parsed.at, '2026-03-03T20:00:00.000Z');
  assert.equal(parsed.stack.length, 2001, 'the stack is cut to its limit');
  assert.match(parsed.componentStack, /ThreadSwitcher/);
});

test('a report with nothing to say is refused', () => {
  assert.equal(clientErrorLine({}), null);
  assert.equal(clientErrorLine({ message: '   ' }), null);
  assert.equal(clientErrorLine(null), null);
  assert.equal(clientErrorLine({ message: 42 }), null);
});

test('the connection log has a ceiling of its own, and nothing else is held back', () => {
  let clock = 0;
  const admit = createReportCeiling(REPORT_CEILINGS, () => clock);
  const verdicts = Array.from({ length: 35 }, () => admit('toy-connect'));
  assert.equal(verdicts.filter((v) => v.write).length, 30);
  assert.equal(verdicts.filter((v) => !v.write).length, 5);
  for (let i = 0; i < 100; i++) assert.equal(admit('keyboard-close').write, true, 'other recorders are written as before');
  assert.equal(admit('/#chat').write, true);
  assert.equal(admit(undefined).write, true);
  assert.equal(admit('constructor').write, true, 'a kind is looked up as a name, never off the object prototype');
  clock += 10 * 60_000;
  assert.deepEqual(admit('toy-connect'), { write: true, heldBack: 5 });
  assert.deepEqual(admit('toy-connect'), { write: true, heldBack: 0 });
});

test('a line says how many of its kind were held back before it', () => {
  const line = clientErrorLine({ where: 'toy-connect', message: '{"kind":"attempt"}' }, new Date('2026-10-21T13:33:00.000Z'), 5);
  assert.ok(line);
  assert.equal(JSON.parse(line).heldBack, 5);
  const plain = clientErrorLine({ where: 'toy-connect', message: 'x' });
  assert.ok(plain);
  assert.equal('heldBack' in JSON.parse(plain), false);
});
