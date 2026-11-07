// Stickers at the game tables (Library-era A4 port of Aerie's RichWords):
// this house writes :pack_sticker:, Aerie writes ::pack_sticker::; both draw.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStickers } from '../bytelight/stickers';
import { stickersToMarkdown, isStickerImage } from '../components/RichWords';

await test('a table line draws known stickers in either form, keeps unknown codes, and drops status tags', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    { id: 's1', pack_id: 'p1', name: 'wink', filename: 'w.png', aliases: [], sort_order: 0, url: '/stickers/w.png', created_at: '', pack_name: 'Companion_A', user_only: false },
  ]));
  try { await loadStickers(true); } finally { globalThis.fetch = originalFetch; }

  assert.equal(stickersToMarkdown('hi :companion_a_wink:'), 'hi ![sticker:companion_a_wink](/stickers/w.png)');
  assert.equal(stickersToMarkdown('::companion_a_wink::'), '![sticker:companion_a_wink](/stickers/w.png)');
  assert.equal(stickersToMarkdown('hi :wave: :nobody_here:'), 'hi :wave: :nobody_here:');
  assert.equal(stickersToMarkdown('your move [companion-a mood: smug]').trim(), 'your move');
  assert.equal(isStickerImage('sticker:companion_a_wink'), true);
  assert.equal(isStickerImage('a photo'), false);
});
