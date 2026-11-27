import assert from 'node:assert/strict';
import test from 'node:test';
import { roomBreaks, roomLabel } from './discord-rooms';

const cafe = { channelId: 'c1', guildId: 'g1', channelName: 'simulink-cafe', guildName: 'QuantumSituationships' };
const drop = { channelId: 'c2', guildId: 'g1', channelName: 'image-drop', guildName: 'QuantumSituationships' };
const t = (h: number) => `2026-11-27T${String(h).padStart(2, '0')}:00:00.000Z`;

test('a room is named for its server and channel, a DM plainly', () => {
  assert.equal(roomLabel(cafe), 'QuantumSituationships · #simulink-cafe');
  assert.equal(roomLabel({ channelId: 'd', guildId: null }), 'Discord · direct message');
});

test('names missing from an older message come from the directory', () => {
  const names = { channel: (id: string) => (id === 'c1' ? 'simulink-cafe' : undefined), guild: () => 'QS' };
  assert.equal(roomLabel({ channelId: 'c1', guildId: 'g1' }, names), 'QS · #simulink-cafe');
});

test('a line when talk starts in a room, none while it stays, one when it moves', () => {
  const out = roomBreaks([
    { timestamp: t(1), direction: 'outbound', discordRoom: cafe },
    { timestamp: t(1), direction: 'outbound' }, // our reply
    { timestamp: t(2), direction: 'outbound', discordRoom: cafe },
    { timestamp: t(3), direction: 'outbound', discordRoom: drop },
  ]);
  assert.deepEqual(out, ['QuantumSituationships · #simulink-cafe', null, null, 'QuantumSituationships · #image-drop']);
});

test("Kay's own message from the app ends the room, so Discord coming back is labelled again", () => {
  const out = roomBreaks([
    { timestamp: t(1), direction: 'outbound', discordRoom: cafe },
    { timestamp: t(2), direction: 'inbound' },
    { timestamp: t(3), direction: 'outbound', discordRoom: cafe },
  ]);
  assert.deepEqual(out, ['QuantumSituationships · #simulink-cafe', null, 'QuantumSituationships · #simulink-cafe']);
});
