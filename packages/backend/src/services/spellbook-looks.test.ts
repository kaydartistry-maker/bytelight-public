import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from './db/init.js';

const {
  listLooks, getLook, createLook, deleteLook, resolveLook, resolveCreateLook, setLookFavorite, seedStarterLooks,
  resetLooksSeededForTests, saveLookImage,
} = await import('./spellbook-store.js');
const { STARTER_LOOKS, starterLookId } = await import('./starter-looks.js');
const { prepareCast } = await import('./spellbook-cast.js');
const { styleReferenceBlock, styleReferencePathBlock, STYLE_REFERENCE_INSTRUCTION } = await import('./style-reference.js');
const { resolveStyleRefs } = await import('./image-gen.js');

before(() => { initDb(join(mkdtempSync(join(tmpdir(), 'spellbook-looks-')), 'test.db')); });

// A 1x1 PNG, enough for a style picture on disk.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('Starter looks', () => {
  it('seeds every old word preset once, tagged starter, not default', () => {
    const starters = listLooks().filter((l) => l.starter);
    assert.equal(starters.length, STARTER_LOOKS.length);
    const water = getLook(starterLookId('Watercolor'));
    assert.ok(water);
    assert.equal(water.recipe, 'soft watercolor painting, bleeding colors, paper texture, delicate washes');
    assert.equal(water.isDefault, false);
    assert.equal(water.builtin, false);
    assert.deepEqual(water.images, []);
    assert.equal(listLooks().filter((l) => l.isDefault).length, 1, 'still exactly one default');
  });

  it('is idempotent and never resurrects a deleted starter', async () => {
    assert.equal(seedStarterLooks(), 0, 'second run adds nothing');
    assert.equal(await deleteLook(starterLookId('Pixel Art')), true, 'starters are deletable');
    resetLooksSeededForTests();
    listLooks(); // seeds again as a restarted process would
    assert.equal(seedStarterLooks(), 0);
    assert.equal(getLook(starterLookId('Pixel Art')), null, 'deleted starter stays deleted');
    assert.equal(listLooks().filter((l) => l.starter).length, STARTER_LOOKS.length - 1);
  });

  it('starters are editable like any look', async () => {
    const { updateLook } = await import('./spellbook-store.js');
    const l = updateLook(starterLookId('Comic'), { recipe: 'bold comic, halftone' });
    assert.equal(l?.recipe, 'bold comic, halftone');
    assert.equal(l?.starter, true);
  });
});

describe('Favorite looks', () => {
  it('toggles and sorts favorites first, separate from default', () => {
    const vhs = createLook({ name: 'VHS', recipe: 'VHS tape', images: [] });
    assert.equal(vhs.favorite, false);
    const fav = setLookFavorite(vhs.id, true);
    assert.equal(fav?.favorite, true);
    assert.equal(fav?.isDefault, false, 'favorite is not default');
    assert.equal(listLooks()[0].id, vhs.id, 'favorites sort first');
    assert.equal(setLookFavorite(vhs.id, false)?.favorite, false);
    assert.notEqual(listLooks()[0].id, vhs.id);
    assert.equal(setLookFavorite('nope', true), null);
  });
});

describe('Style pictures ride the render', () => {
  it('a look with pictures resolves their paths; a words-only look resolves none', async () => {
    const img = await saveLookImage(PNG, 'image/png');
    const board = createLook({ name: 'Board', recipe: 'soft pastel', images: [img] });
    const words = createLook({ name: 'Words', recipe: 'grainy', images: [] });
    try {
      const r = resolveLook(board.id);
      assert.equal(r.styleImages?.length, 1);
      assert.ok(r.styleImages?.[0].endsWith(img));
      assert.deepEqual(resolveLook(words.id).styleImages, []);
      assert.deepEqual(resolveLook('keep').styleImages, [], 'keep never carries style pictures');

      assert.equal(resolveCreateLook(undefined), null, 'Create without a pick stays plain');
      assert.equal(resolveCreateLook('keep'), null);
      assert.equal(resolveCreateLook(board.id)?.styleImages?.length, 1);

      const spell = { id: 's1', title: 'T', scene: '[Character 1] on a couch', originalText: null, tags: [], look: null,
        origin: 'mine' as const, author: null, credit: null, link: null, source: null, vault: null, engine: null,
        neutralized: true, createdAt: '', timesCast: 0, lastCastAt: null, castSize: 1 };
      const withPics = await prepareCast(spell, [{ slug: 'ash', label: 'Ash' }], board.id, { justRead: true });
      assert.equal(withPics.styleRefs.length, 1);
      assert.match(withPics.enginePrompt, /Look: soft pastel/);
      const noPics = await prepareCast(spell, [{ slug: 'ash', label: 'Ash' }], words.id, { justRead: true });
      assert.deepEqual(noPics.styleRefs, []);
      assert.deepEqual(resolveStyleRefs({ prompt: 'x', styleRefs: withPics.styleRefs }), withPics.styleRefs);
      assert.deepEqual(resolveStyleRefs({ prompt: 'x', styleRefs: ['/no/such/file.png'] }), []);
    } finally {
      await deleteLook(board.id);
      await deleteLook(words.id);
    }
  });
});

describe('Style reference instruction', () => {
  it('is present only when there are style pictures', () => {
    assert.equal(styleReferenceBlock(2, 0), '');
    assert.equal(styleReferencePathBlock(['/a.png'], []), '');
    const block = styleReferenceBlock(2, 3);
    assert.ok(block.includes(STYLE_REFERENCE_INSTRUCTION));
    assert.ok(styleReferencePathBlock(['/a.png'], ['/s.png']).includes(STYLE_REFERENCE_INSTRUCTION));
  });

  it('labels likeness and style images apart, by attachment order', () => {
    const block = styleReferenceBlock(2, 3);
    assert.match(block, /images 1 to 2 are LIKENESS references/);
    assert.match(block, /images 3 to 5 are STYLE references/);
    assert.match(block, /not people in this scene/);
    const solo = styleReferenceBlock(0, 1);
    assert.doesNotMatch(solo, /LIKENESS/);
    assert.match(solo, /image 1 is a STYLE reference/);
  });

  it('tells style apart from content', () => {
    assert.match(STYLE_REFERENCE_INSTRUCTION, /decide HOW/);
    assert.match(STYLE_REFERENCE_INSTRUCTION, /Never copy the people/);
  });
});
