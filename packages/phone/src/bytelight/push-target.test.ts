import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { pushJumpFromMessage, pushJumpFromSearch, stripPushJumpParams } from './push-target.js';

// Run the worker's helper exactly as shipped (public/push-target.js).
const helperPath = fileURLToPath(new URL('../../public/push-target.js', import.meta.url));
const sandbox: { self: Record<string, any>; URL: typeof URL } = { self: {}, URL };
vm.runInNewContext(readFileSync(helperPath, 'utf8'), sandbox);
const { pushTarget, pushTargetUrl } = sandbox.self.bytelightPushTarget;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test('reply push: thread from threadId, message from the msg- tag', () => {
  assert.deepEqual(plain(pushTarget({ title: 'x', body: 'y', threadId: 't1', tag: 'msg-abc-123', url: '/chat' })), {
    threadId: 't1', messageId: 'abc-123',
  });
});

test('timer push: thread only (timer tag is not a message id)', () => {
  assert.deepEqual(plain(pushTarget({ threadId: 't1', tag: 'timer-9' })), { threadId: 't1', messageId: null });
});

test('push with no thread (limit warning, test push) targets nothing', () => {
  assert.deepEqual(plain(pushTarget({ tag: 'limit-codex-week' })), { threadId: null, messageId: null });
  assert.deepEqual(plain(pushTarget({ tag: 'test', url: '/chat' })), { threadId: null, messageId: null });
  assert.deepEqual(plain(pushTarget(null)), { threadId: null, messageId: null });
});

test('an explicit messageId wins over the tag; already-shown notification data still works', () => {
  assert.deepEqual(plain(pushTarget({ threadId: 't1', messageId: 'm9', tag: 'msg-m1' })), { threadId: 't1', messageId: 'm9' });
  assert.deepEqual(plain(pushTarget({ threadId: 't1' })), { threadId: 't1', messageId: null });
});

test('cold-start URL stays inside the scope and carries the target', () => {
  assert.equal(pushTargetUrl('https://h/phone/', { threadId: 't 1', messageId: 'm1' }), 'https://h/phone/?thread=t+1&message=m1');
  assert.equal(pushTargetUrl('https://h/phone/', { threadId: 't1', messageId: null }), 'https://h/phone/?thread=t1');
  assert.equal(pushTargetUrl('https://h/phone/', { threadId: null, messageId: null }), 'https://h/phone/');
});

test('the app reads back what the worker wrote', () => {
  const href = pushTargetUrl('https://h/phone/', { threadId: 't 1', messageId: 'm1' });
  assert.deepEqual(pushJumpFromSearch(new URL(href).search), { threadId: 't 1', messageId: 'm1' });
  assert.deepEqual(pushJumpFromSearch('?thread=t1'), { threadId: 't1', messageId: null });
  assert.equal(pushJumpFromSearch(''), null);
  assert.equal(pushJumpFromSearch('?message=m1'), null);
});

test('jump params are stripped, other params kept', () => {
  assert.equal(stripPushJumpParams('https://h/phone/?thread=t1&message=m1&x=1#a'), '/phone/?x=1#a');
  assert.equal(stripPushJumpParams('https://h/phone/?thread=t1'), '/phone/');
});

test('only our worker message type is accepted', () => {
  assert.deepEqual(pushJumpFromMessage({ type: 'bytelight:open-thread', threadId: 't1', messageId: 'm1' }), { threadId: 't1', messageId: 'm1' });
  assert.deepEqual(pushJumpFromMessage({ type: 'bytelight:open-thread', threadId: 't1', messageId: null }), { threadId: 't1', messageId: null });
  assert.equal(pushJumpFromMessage({ type: 'push', threadId: 't1' }), null);
  assert.equal(pushJumpFromMessage({ type: 'bytelight:open-thread' }), null);
  assert.equal(pushJumpFromMessage('bytelight:open-thread'), null);
});
