/**
 * The operator's custom emojis reach the CLI lane as shortcode text (":panda_1000089375:"),
 * so we answered pictures we never saw (bug #2, Oct 31). The turn now names the
 * file behind each known shortcode so the lane can Read it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmojiSightBlock } from './emoji-sight.js';

const known: Record<string, string> = {
  panda_1000089375: 'panda_1000089375.gif',
  qsfavs_cutecry: 'qsfavs_cutecry.webp',
};
const lookup = (name: string) => (known[name] ? { name, filename: known[name] } : null);

describe('buildEmojiSightBlock', () => {
  it('names the file behind a custom emoji shortcode', () => {
    const b = buildEmojiSightBlock(':panda_1000089375:', lookup, '/srv/emojis');
    assert.match(b, /:panda_1000089375:/);
    assert.match(b, /\/srv\/emojis\/panda_1000089375\.gif/);
    assert.match(b, /Read/);
  });

  it('lists each distinct emoji once', () => {
    const b = buildEmojiSightBlock('hi :qsfavs_cutecry: :qsfavs_cutecry: and :panda_1000089375:', lookup, '/e');
    assert.equal(b.match(/qsfavs_cutecry\.webp/g)?.length, 1);
    assert.match(b, /panda_1000089375\.gif/);
  });

  it('says nothing for plain text, unknown codes, or stickers', () => {
    assert.equal(buildEmojiSightBlock('no emojis here', lookup, '/e'), '');
    assert.equal(buildEmojiSightBlock(':not_a_thing:', lookup, '/e'), '');
    assert.equal(buildEmojiSightBlock('::Companion_A_hi::', lookup, '/e'), '');
  });

  it('never throws when the lookup fails', () => {
    const boom = () => { throw new Error('db gone'); };
    assert.equal(buildEmojiSightBlock(':panda_1000089375:', boom, '/e'), '');
  });
});
