import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isEffectivelyBlank } from './index.js';

test('isEffectivelyBlank strips zero-width characters before blank checks', () => {
  for (const value of ['', '​', '​‌', ' ​ ']) {
    assert.equal(isEffectivelyBlank(value), true, JSON.stringify(value));
  }
  for (const value of ['hi', '​hi']) {
    assert.equal(isEffectivelyBlank(value), false, JSON.stringify(value));
  }
});

test('peer-bot blank guard drops no-payload messages but admits attachments', () => {
  const shouldDrop = (content: string, attachmentCount: number): boolean => {
    const hasPayload = attachmentCount > 0;
    return isEffectivelyBlank(content) && !hasPayload;
  };

  assert.equal(shouldDrop('​', 0), true);
  assert.equal(shouldDrop('​', 1), false);
});

test('outbound blank guard suppresses zero-width output but admits text', () => {
  const shouldSend = (response: string): boolean =>
    !isEffectivelyBlank(response) && response !== '[No response]';

  assert.equal(shouldSend('​'), false);
  assert.equal(shouldSend('hi'), true);
});

test('service wires payload-preserving inbound and effective outbound guards', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  assert.match(source, /message\.attachments\.size > 0/);
  assert.match(source, /message\.embeds\.length > 0/);
  assert.match(source, /message\.stickers\?\.size \?\? 0/);
  assert.match(source, /isEffectivelyBlank\(message\.content\) && !hasPayload/);
  assert.match(source, /isEffectivelyBlank\(response\) \|\| response === '\[No response\]'/);
});
