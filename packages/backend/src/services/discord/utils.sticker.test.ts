// Tests for sticker visibility in Discord message content. A sticker-only
// message has empty text content — formatDiscordMessageContent must append
// `<dsticker:<name>:<id>.<ext>>` tokens (sticker-content.ts, Aerie) so batches
// no longer store as blank content, the phone can draw the sticker, and channel
// history no longer mislabels stickers as '[embed]'. Lottie stickers (no image
// form) keep byte-light's readable `[sticker: <Name>]` token.
//
// Run with: npx tsx --test packages/backend/src/services/discord/utils.sticker.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { formatDiscordMessageContent, formatChannelHistory } = await import('./utils.js');

// Minimal stand-in for a discord.js Message. formatDiscordMessageContent only
// reaches cleanContent/content and stickers (.size + .values()); a real Map
// satisfies the Collection surface used. formatChannelHistory additionally
// reads createdAt, author.{bot,username}, and attachments.size.
function fakeMessage(opts: {
  content?: string;
  cleanContent?: string;
  stickers?: Array<{ id: string; name: string; url: string; format: number }>;
  attachments?: number;
} = {}): any {
  return {
    content: opts.content ?? '',
    cleanContent: opts.cleanContent ?? opts.content ?? '',
    stickers: new Map((opts.stickers ?? []).map(s => [s.id, s])),
    attachments: { size: opts.attachments ?? 0 },
    createdAt: new Date('2026-07-17T12:00:00Z'),
    author: { bot: false, username: 'tester' },
  };
}

const WAVE = { id: '111', name: 'Wave', url: 'https://cdn.example/wave.png', format: 1 };
const BLOB = { id: '222', name: 'Blob', url: 'https://cdn.example/blob.png', format: 4 };
const LOTTIE = { id: '333', name: 'Wiggle', url: 'https://cdn.example/wiggle.json', format: 3 };

describe('formatDiscordMessageContent', () => {
  it('text-only message passes through unchanged', () => {
    const msg = fakeMessage({ content: 'hello there' });
    assert.equal(formatDiscordMessageContent(msg), 'hello there');
  });

  it('sticker-only message renders the sticker token instead of empty string', () => {
    const msg = fakeMessage({ stickers: [WAVE] });
    assert.equal(formatDiscordMessageContent(msg), '<dsticker:Wave:111.png>');
  });

  it('text + sticker renders text followed by the sticker token', () => {
    const msg = fakeMessage({ content: 'look at this', stickers: [WAVE] });
    assert.equal(formatDiscordMessageContent(msg), 'look at this\n<dsticker:Wave:111.png>');
  });

  it('multiple stickers all render', () => {
    const msg = fakeMessage({ stickers: [WAVE, BLOB] });
    assert.equal(formatDiscordMessageContent(msg), '<dsticker:Wave:111.png> <dsticker:Blob:222.gif>');
  });

  it('a lottie sticker keeps its readable name token', () => {
    const msg = fakeMessage({ stickers: [LOTTIE] });
    assert.equal(formatDiscordMessageContent(msg), '[sticker: Wiggle]');
  });

  it('prefers cleanContent over raw content', () => {
    const msg = fakeMessage({ content: '<@123> hi', cleanContent: '@tester hi' });
    assert.equal(formatDiscordMessageContent(msg), '@tester hi');
  });
});

describe('formatChannelHistory sticker labeling', () => {
  it('sticker-only message shows the sticker token, not [embed]', () => {
    const history = formatChannelHistory([fakeMessage({ stickers: [WAVE] })]);
    assert.match(history, /<dsticker:Wave:111\.png>$/);
    assert.doesNotMatch(history, /\[embed\]/);
  });

  it('empty message with no attachments still labels as [embed]', () => {
    const history = formatChannelHistory([fakeMessage()]);
    assert.match(history, /\[embed\]$/);
  });

  it('empty message with an attachment still labels as [attachment]', () => {
    const history = formatChannelHistory([fakeMessage({ attachments: 1 })]);
    assert.match(history, /\[attachment\]$/);
  });
});
