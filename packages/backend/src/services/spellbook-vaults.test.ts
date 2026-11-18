import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from './db/init.js';

const {
  parseCommunityArchive, parseNotionExport, previewImport, commitImport, buildNeutralizePrompt, parseNeutralizeReply,
} = await import('./spellbook-vaults.js');
const {
  contentHash, insertSpell, listSpells, surpriseSpell, markCast, tagCounts, filterCounts, listLooks, defaultLook,
  setDefaultLook, createLook, resolveLook, deleteLook,
} = await import('./spellbook-store.js');

before(() => { initDb(join(mkdtempSync(join(tmpdir(), 'spellbook-')), 'test.db')); });

const ARCHIVE = `# community prompt archive

## Ash
### 2026-03-02
Midjourney
\`\`\`
A woman in a red slip dress leaning on a vintage car at night, flash photo --ar 2:3
\`\`\`
\`\`\`
Two people dancing in a neon laundromat, grainy film
\`\`\`

## Wren
### Apr 9, 2026, 11:35 AM · 1 image(s)
Gpt (or any)
A man and a woman slow dancing in an empty diner at 2am, jukebox glow, rain on the windows, grainy candid film photo

### 2026-04-10
**Sora**
\`\`\`
A man reading on a rainy balcony, 35mm film
\`\`\`
### 2026-04-11
nothing here today

## Ash
### 2026-05-01
gpt-image
\`\`\`
a woman in a red slip dress leaning on a vintage car at night, flash photo --ar 2:3
\`\`\`
`;

describe('community archive parser', () => {
  it('follows ## author → ### date → engine → code block', () => {
    const { candidates, unparsed } = parseCommunityArchive(ARCHIVE);
    assert.equal(candidates.length, 5);
    assert.equal(candidates[0].author, 'Ash');
    assert.equal(candidates[0].credit, 'Ash');
    assert.equal(candidates[0].engine, 'Midjourney');
    assert.equal(candidates[0].origin, 'community');
    assert.equal(candidates[1].engine, 'Midjourney');
    assert.equal(candidates[2].author, 'Wren');
    assert.equal(candidates[2].engine, 'Gpt (or any)', 'a date with no block uses its text as the prompt');
    assert.match(candidates[2].prompt, /^A man and a woman slow dancing/);
    assert.equal(candidates[3].engine, 'Sora');
    assert.equal(unparsed.length, 1);
    assert.match(unparsed[0].why, /too short|nothing under/);
  });
});

describe('Notion export parser', () => {
  it('drops the meta tag, keeps hers as mine, and reports empty pages', () => {
    const json = JSON.stringify({ items: [
      { title: 'Balcony', tags: ['Image Prompt', 'Spice', 'Thirst traps'], prompt: '[name] on a balcony at dusk', url: 'https://n/1' },
      { title: '', tags: ['Couple'], prompt: 'two lovers in a hot tub' },
      { title: 'Empty', tags: [], prompt: '' },
    ] });
    const { candidates, unparsed } = parseNotionExport(json, '/nonexistent');
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates[0].tags, ['Spice', 'Thirst traps']);
    assert.equal(candidates[0].origin, 'mine');
    assert.equal(candidates[1].title, 'Two lovers in a hot');
    assert.equal(unparsed.length, 1);
  });
});

describe('Dry run → commit, with dedupe', () => {
  it('previews new / duplicates / unparsed and never doubles on re-import', async () => {
    const parsed = parseCommunityArchive(ARCHIVE);
    const p1 = previewImport('archive', parsed);
    assert.equal(p1.newCount, 4, 'the case-only repeat is a duplicate');
    assert.equal(p1.duplicates, 1);
    assert.equal(p1.unparsedCount, 1);
    assert.equal(listSpells().length, 0, 'a dry run writes nothing');
    const done = await commitImport(p1.token, { neutralize: false });
    assert.equal(done.added, 4);
    const p2 = previewImport('archive', parseCommunityArchive(ARCHIVE));
    assert.equal(p2.newCount, 0);
    assert.equal(p2.duplicates, 5);
    await assert.rejects(() => commitImport(p1.token), /expired/);
  });

  it('hashes prompts ignoring case, spacing and punctuation', () => {
    assert.equal(contentHash('A  woman, at night!'), contentHash('a woman at night'));
    assert.notEqual(contentHash('a woman at night'), contentHash('a man at night'));
  });
});

describe('Neutralize pass', () => {
  it('asks for tokens and reads the reply back by index', () => {
    const p = buildNeutralizePrompt([{ i: 0, text: 'the operator in a bathtub' }]);
    assert.match(p, /\[Character 1\]/);
    const r = parseNeutralizeReply('ok [{"i":0,"people":1,"scene":"[Character 1] in a bathtub"},{"i":1}] done');
    assert.equal(r.get(0)?.scene, '[Character 1] in a bathtub');
    assert.equal(r.get(0)?.people, 1);
    assert.equal(r.has(1), false);
    assert.equal(parseNeutralizeReply('nope').size, 0);
  });
});

describe('The wall', () => {
  it('filters mine / community / not made, by tag and by words', () => {
    const mine = insertSpell({ title: 'Quiet couch', scene: '[Character 1] on a couch', tags: ['Couple', 'wholesome'], origin: 'mine' });
    assert.ok(mine);
    assert.equal(listSpells({ filter: 'mine' }).length, 1);
    assert.equal(listSpells({ filter: 'community' }).length, 4);
    assert.equal(listSpells({ filter: 'unmade' }).length, 5);
    markCast(mine!.id);
    assert.equal(listSpells({ filter: 'unmade' }).length, 4);
    assert.equal(listSpells({ tag: 'couple' }).length, 1);
    assert.equal(listSpells({ q: 'laundromat' }).length, 1);
    assert.equal(filterCounts().all, 5);
    assert.ok(tagCounts().some((t) => t.tag === 'Couple'));
  });

  it('Surprise me pulls a never-made spell first', () => {
    for (let i = 0; i < 10; i++) assert.equal(surpriseSpell()!.timesCast, 0);
    const pick = surpriseSpell({ filter: 'mine' });
    assert.equal(pick?.title, 'Quiet couch', 'falls back to the least recently cast');
  });
});

describe('Looks', () => {
  it('seeds Grungy film as the default and Keep the picture\'s look', () => {
    const looks = listLooks();
    assert.deepEqual(looks.filter((l) => l.builtin).map((l) => l.id).sort(), ['grungy-film', 'keep']);
    assert.equal(defaultLook().id, 'grungy-film');
    assert.equal(resolveLook('keep').keepPicture, true);
  });

  it('a new look can be the default, and deleting it falls back', async () => {
    const vhs = createLook({ name: 'VHS', recipe: 'VHS tape, scanlines', images: [] });
    setDefaultLook(vhs.id);
    assert.equal(resolveLook(undefined).name, 'VHS');
    assert.equal(resolveLook('nope').id, vhs.id, 'an unknown look id means the default');
    await deleteLook(vhs.id);
    assert.equal(defaultLook().id, 'grungy-film');
    await assert.rejects(() => deleteLook('keep'), /not deleted/);
  });
});
