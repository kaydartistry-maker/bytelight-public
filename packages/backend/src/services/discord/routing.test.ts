// Where Discord talk lands.
import assert from 'node:assert/strict';
import test from 'node:test';
import { routeKind, roomThreadName } from './routing.js';

test('Follow me home keeps everything in Home, as before', () => {
  assert.equal(routeKind('home', 'c1', []), 'home');
});

test('One Discord thread gathers every room', () => {
  assert.equal(routeKind('one', 'c1', []), 'one');
});

test('Each room its own thread', () => {
  assert.equal(routeKind('per-room', 'c1', []), 'room');
});

test('a room on the keep-their-own list gets its own thread in any mode', () => {
  assert.equal(routeKind('home', 'c1', ['c1']), 'room');
  assert.equal(routeKind('one', 'c1', ['c1']), 'room');
  assert.equal(routeKind('one', 'c2', ['c1']), 'one');
});

test('a room thread is named for its server and room, a DM for the person', () => {
  assert.equal(roomThreadName({ channelId: 'c', guildId: 'g', channelName: 'front-room', guildName: 'Porch' }), 'Porch · #front-room');
  assert.equal(roomThreadName({ channelId: 'c', guildId: 'g', channelName: 'general' }), '#general');
  assert.equal(roomThreadName({ channelId: 'd', guildId: null, dmName: 'Wren' }), 'DM · Wren');
});
