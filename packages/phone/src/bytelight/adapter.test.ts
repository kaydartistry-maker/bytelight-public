import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message as BytelightMessage } from './protocol.js';
import { toPhoneMessage } from './adapter.js';

function row(over: Partial<BytelightMessage>): BytelightMessage {
  return {
    id: 'm1',
    thread_id: 't1',
    sequence: 1,
    role: 'system',
    content: 'hello',
    content_type: 'text',
    platform: 'discord',
    metadata: null,
    companion_id: null,
    reply_to_id: null,
    reply_to_preview: null,
    edited_at: null,
    deleted_at: null,
    original_content: null,
    created_at: '2026-08-15T09:00:00.000Z',
    delivered_at: null,
    read_at: null,
    ...over,
  } as BytelightMessage;
}

// The hop that quietly does not happen. The gateway can capture a guest's
// picture perfectly and the phone still draws a letter, because nothing in
// between carried it. This pins the carry, not the capture.
test('a Discord guest arrives with their picture', () => {
  const m = toPhoneMessage(row({
    metadata: {
      discordUsername: 'ash_ashen',
      discordDisplayName: 'Ash Ashen',
      discordAvatarUrl: 'https://cdn.discordapp.com/avatars/1/2.png?size=128',
    },
  }));
  assert.equal(m.sender, 'Ash Ashen');
  assert.equal(m.via, 'Discord');
  assert.equal(m.senderAvatar, 'https://cdn.discordapp.com/avatars/1/2.png?size=128');
});

// Every message stored before we started capturing it. The rail falls back to
// an initial, so absent has to stay absent rather than becoming a broken image.
test('a guest from before we captured pictures carries none', () => {
  const m = toPhoneMessage(row({
    metadata: { discordUsername: 'ash_ashen', discordDisplayName: 'Ash Ashen' },
  }));
  assert.equal(m.sender, 'Ash Ashen');
  assert.equal(m.senderAvatar, undefined);
});

// The house's own system lines are not guests and have no face to draw.
test('a house system line is not given an avatar', () => {
  const m = toPhoneMessage(row({ platform: 'web', content: 'Recycling.' }));
  assert.equal(m.isSystem, true);
  assert.equal(m.via, undefined);
  assert.equal(m.senderAvatar, undefined);
});

// Her own messages sent from Discord are hers, not a visitor's — they must not
// pick up a guest rail on the way through.
test('her own bridged message is not a guest', () => {
  const m = toPhoneMessage(row({
    role: 'user',
    metadata: { discordUsername: 'guest', discordAvatarUrl: 'https://cdn/x.png' },
  }));
  assert.equal(m.sender, undefined);
  assert.equal(m.direction, 'inbound');
});

test("the house's companion stamp rides onto companion messages only", () => {
  assert.equal(toPhoneMessage(row({ role: 'companion', companion_id: 'companion-a' })).companionId, 'companion-a');
  assert.equal(toPhoneMessage(row({ role: 'companion', companion_id: 'companion-a-b' })).companionId, 'companion-a-b');
  assert.equal(toPhoneMessage(row({ role: 'companion', companion_id: null })).companionId, undefined);
  assert.equal(toPhoneMessage(row({ role: 'user', companion_id: 'companion-a' })).companionId, undefined);
});
