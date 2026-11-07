// The seams where the phone meets main's backend (UI flip, slice U1). Each one
// was a silent mismatch: the URL matched, the shape or syntax did not.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStickers, resolveStickerRef, getStickerPacks } from '../bytelight/stickers';
import { prepareChatText } from './chat-text';
import { normalizeCompanionRow } from './companion-row';

await test("main's flat packs-with-stickers rows fold into packs, resolvable by name or alias in any case", async () => {
  const originalFetch = globalThis.fetch;
  // services/stickers.ts getAllStickersWithPacks: one row per sticker + pack_name.
  globalThis.fetch = async () => new Response(JSON.stringify([
    { id: 's1', pack_id: 'p1', name: 'wink', filename: 'w.png', aliases: ['smirk'], sort_order: 0, url: '/stickers/w.png', created_at: '', pack_name: 'Companion_A', user_only: false },
    { id: 's2', pack_id: 'p1', name: 'hug', filename: 'h.png', aliases: [], sort_order: 1, url: '/stickers/h.png', created_at: '', pack_name: 'Companion_A', user_only: false },
    { id: 's3', pack_id: 'p2', name: 'glare', filename: 'g.png', aliases: [], sort_order: 0, url: '/stickers/g.png', created_at: '', pack_name: 'Companion_B', user_only: false },
  ]));
  try { await loadStickers(true); } finally { globalThis.fetch = originalFetch; }

  const packs = getStickerPacks();
  assert.deepEqual(packs.map((p) => [p.name, (p.stickers || []).length]), [['Companion_A', 2], ['Companion_B', 1]]);
  assert.equal(resolveStickerRef('companion_a_wink'), '/stickers/w.png');
  assert.equal(resolveStickerRef('Companion_A_Wink'), '/stickers/w.png');
  assert.equal(resolveStickerRef('companion_a_smirk'), '/stickers/w.png', 'aliases resolve, as on main');
  assert.equal(resolveStickerRef('companion_b_glare'), '/stickers/g.png');
});

await test("main's single-colon :pack_name: refs render as stickers; unknown ones stay text", () => {
  const resolveSticker = (ref: string) => (ref.toLowerCase() === 'companion_a_wink' ? '/stickers/w.png' : null);
  assert.equal(prepareChatText({ text: ':companion_a_wink:', resolveSticker }).markdown, '![sticker:companion_a_wink](/stickers/w.png)');
  assert.equal(prepareChatText({ text: 'hey :companion_a_wink: you', resolveSticker }).stickerSharesText, true);
  assert.equal(prepareChatText({ text: '::companion_a_wink::', resolveSticker }).markdown, '![sticker:companion_a_wink](/stickers/w.png)', 'the fork double-colon form still reads');
  assert.equal(prepareChatText({ text: 'at 10:30_ish: maybe', resolveSticker }).markdown, 'at 10:30_ish: maybe');
  assert.equal(prepareChatText({ text: ':nobody_here:', resolveSticker }).markdown, ':nobody_here:');
});

test("main's companion rows gain the slug/avatar_url fields the phone reads", () => {
  const row = normalizeCompanionRow({ id: 'companion-a', display_name: 'Companion A', avatar: '/api/files/abc', brain: 'companion-a-b', model: null });
  assert.equal(row.slug, 'companion-a');
  assert.equal(row.avatar_url, '/api/files/abc');
  assert.equal(row.color, null);
  assert.equal(row.brain, 'companion-a-b', 'main-only fields pass through');
  const forkRow = normalizeCompanionRow({ id: 'x1', slug: 'companion-b', display_name: 'Companion B', avatar_url: '/a.png', color: '#111', emoji: '🖤' });
  assert.equal(forkRow.slug, 'companion-b', 'an explicit slug wins');
  assert.equal(forkRow.avatar_url, '/a.png');
});
