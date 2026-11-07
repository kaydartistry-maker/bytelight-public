import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { pushBackHandler, runBackHandler, resetBackHandlersForTest } from './back-stack.js';

beforeEach(() => resetBackHandlersForTest());

test('with nothing registered, back is not handled', () => {
  assert.equal(runBackHandler(), false);
});

test('a registered handler that takes it stops there', () => {
  let calls = 0;
  pushBackHandler(() => { calls += 1; return true; });
  assert.equal(runBackHandler(), true);
  assert.equal(calls, 1);
});

test('a handler that declines lets the app close', () => {
  pushBackHandler(() => false);
  assert.equal(runBackHandler(), false);
});

test('only the innermost screen is asked', () => {
  const asked: string[] = [];
  pushBackHandler(() => { asked.push('outer'); return true; });
  pushBackHandler(() => { asked.push('inner'); return true; });
  runBackHandler();
  assert.deepEqual(asked, ['inner']);
});

test('unregistering restores the screen underneath', () => {
  const asked: string[] = [];
  pushBackHandler(() => { asked.push('outer'); return true; });
  const remove = pushBackHandler(() => { asked.push('inner'); return true; });
  remove();
  runBackHandler();
  assert.deepEqual(asked, ['outer']);
});

test('a handler that throws does not trap her in the screen', () => {
  pushBackHandler(() => { throw new Error('boom'); });
  assert.equal(runBackHandler(), false);
});
