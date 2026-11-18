import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildReaderPrompt,
  parseSpellScene,
  castNames,
  engineSpellPrompt,
  sourcePath,
  isLookId,
  SpellbookError,
} = await import('./spellbook.js');

const ash = { slug: 'ash', label: 'Ash' };
const wren = { slug: 'wren', label: 'Wren' };

describe('Spellbook reader prompt', () => {
  it('asks for exactly as many character tokens as people cast', () => {
    const p = buildReaderPrompt(2, 'grungy-film');
    assert.match(p, /exactly 2 people/);
    assert.match(p, /\[Character 1\], \[Character 2\]/);
    assert.doesNotMatch(p, /\[Character 3\]/);
  });

  it('tells the reader to leave the source person\'s identity out', () => {
    const p = buildReaderPrompt(1, 'grungy-film');
    for (const trait of ['face', 'hair color', 'skin tone', 'tattoos', 'piercings', 'body type']) {
      assert.ok(p.includes(trait), `reader prompt should forbid ${trait}`);
    }
  });

  it('leaves style to the look layer, unless the picture\'s own look is kept', () => {
    assert.doesNotMatch(buildReaderPrompt(1, 'grungy-film'), /35mm film/);
    assert.match(buildReaderPrompt(1, 'grungy-film'), /style is added separately/);
    const keep = buildReaderPrompt(1, 'keep');
    assert.match(keep, /picture's own photographic style/);
  });

  it('only knows the built-in looks', () => {
    assert.equal(isLookId('grungy-film'), true);
    assert.equal(isLookId('keep'), true);
    assert.equal(isLookId('toString'), false);
    assert.equal(isLookId('vhs'), false);
  });
});

describe('Spellbook reader reply', () => {
  it('pulls the JSON out of chatter around it', () => {
    const raw = 'Sure!\n{"title":"Velvet Panther","scene":"[Character 1] sits on the bed.","tags":["Nightlife","flash"]}\nDone.';
    const s = parseSpellScene(raw, 1);
    assert.equal(s.title, 'Velvet Panther');
    assert.equal(s.scene, '[Character 1] sits on the bed.');
    assert.deepEqual(s.tags, ['nightlife', 'flash']);
  });

  it('never silently drops someone the reader forgot', () => {
    const s = parseSpellScene('{"title":"T","scene":"[Character 1] leans on the car.","tags":[]}', 2);
    assert.match(s.scene, /\[Character 2\] is also in the scene\.$/);
  });

  it('refuses a reply with no scene', () => {
    assert.throws(() => parseSpellScene('no json here', 1), SpellbookError);
    assert.throws(() => parseSpellScene('{"title":"x","scene":"  "}', 1), SpellbookError);
  });
});

describe('Casting names into a scene', () => {
  const scene = '[Character 1] sits on the hood. [Character 2] stands behind [Character 1].';

  it('writes every token as the cast member\'s name', () => {
    assert.equal(castNames(scene, [ash, wren]), 'Ash sits on the hood. Wren stands behind Ash.');
  });

  it('swapping the cast needs no new reading', () => {
    assert.equal(castNames(scene, [wren, ash]), 'Wren sits on the hood. Ash stands behind Wren.');
  });

  it('tells the engine to keep each person looking like their references', () => {
    const p = engineSpellPrompt(scene, [ash, wren]);
    assert.ok(p.startsWith('Ash sits on the hood.'));
    assert.match(p, /Ash, Wren must look exactly like their reference images/);
  });

  it('lays the look on the end of the prompt, and nothing for "keep"', async () => {
    const { fullPrompt, fullPromptNoNames } = await import('./spellbook.js');
    assert.match(fullPrompt(scene, [ash, wren], 'grungy-film'), /\n\nLook: Grainy 35mm film/);
    assert.equal(fullPrompt(scene, [ash, wren], 'keep'), 'Ash sits on the hood. Wren stands behind Ash.');
    const custom = { id: 'x', name: 'VHS', recipe: 'VHS tape, scanlines.', keepPicture: false };
    assert.equal(fullPromptNoNames(scene, custom), `${scene}\n\nLook: VHS tape, scanlines.`);
    assert.match(engineSpellPrompt(scene, [ash, wren], custom), /Look: VHS tape, scanlines\.\n\nIdentity:/);
  });
});

describe('Source pictures', () => {
  it('only resolves names the Spellbook itself made', () => {
    assert.equal(sourcePath('../../etc/passwd'), null);
    assert.equal(sourcePath('spell-1/../x.jpg'), null);
    assert.equal(sourcePath('notaspell.jpg'), null);
    assert.equal(sourcePath('spell-1-deadbeef.exe'), null);
  });
});

describe('Recasting with a different number of people', async () => {
  const { sceneCastSize, needsReRead, fitSceneToCast } = await import('./spellbook.js');
  const one = 'A grainy photo of [Character 1] lying on a couch.';

  it('counts the people a scene was written for', () => {
    assert.equal(sceneCastSize(one), 1);
    assert.equal(sceneCastSize('[Character 1] and [Character 2] at a bar.'), 2);
    assert.equal(sceneCastSize('An empty room.'), 0);
  });

  it('swapping one person for another reuses the scene', () => {
    assert.equal(needsReRead(one, 1), false);
  });

  it('adding or dropping someone needs a fresh read', () => {
    assert.equal(needsReRead(one, 2), true);
    assert.equal(needsReRead('[Character 1] and [Character 2] at a bar.', 1), true);
  });

  it('with the picture gone, nobody silently drops out', () => {
    const fitted = fitSceneToCast(one, 2);
    assert.ok(fitted.includes('[Character 1]'));
    assert.ok(fitted.includes('[Character 2]'));
  });
});

describe('Fitting a scene to who is cast', async () => {
  const { buildTailorPrompt, buildReaderPrompt: reader } = await import('./spellbook.js');
  const seats = [{ label: 'Ash', refPath: '/r/ash.jpg' }, { label: 'Wren', refPath: '/r/wren.jpg' }];

  it('names each slot and points at its reference picture', () => {
    const p = buildTailorPrompt('[Character 1] in a lace dress kisses [Character 2].', seats);
    assert.match(p, /\[Character 1\] is Ash \(attached image 1 is their reference picture\)/);
    assert.match(p, /\[Character 2\] is Wren \(attached image 2/);
    assert.match(p, /A man gets menswear: never a dress/);
    assert.match(p, /never describe their face/i);
  });

  it('the picture reader counts the dropped picture as image 1', () => {
    assert.match(reader(2, 'grungy-film', seats), /\[Character 1\] is Ash \(attached image 2/);
    assert.doesNotMatch(reader(2, 'grungy-film'), /Who is being cast/);
  });
});
