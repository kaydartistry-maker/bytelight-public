import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { initDb, getDb, setConfig } from './db.js';
import { addStyleReference, composeStyledPrompt, deleteStyle, duplicateStyle, getStudioStyles, hasMJFlags, resolveImageModel, saveStyle, setDefaultChatStyle, snapshotStyle, styleAssetPath } from './studio-styles.js';
import { parsePromptGame, promptWritingInstruction } from './studio-prompts.js';

const tmp = mkdtempSync(join(tmpdir(), 'studio-styles-test-'));
initDb(join(tmp, 'db.sqlite'));
const assets: string[] = [];
after(() => { for (const file of assets) rmSync(file, { force: true }); getDb().close(); rmSync(tmp, { recursive: true, force: true }); });

describe('personal saved styles', () => {
  it('starts empty: no built-in presets and no default chat style', () => {
    assert.deepEqual(getStudioStyles(), { styles: [], defaultChatStyleId: null });
  });
  it('preserves written prompts exactly and edits them independently of the scene', () => {
    const text = '  Opal paper, fine botanical textures\nprecise small highlights.  ';
    const s = saveStyle({ title: 'Example test', prompt: text });
    assert.equal(getStudioStyles().styles[0].prompt, text);
    assert.equal(composeStyledPrompt('a moon garden', s), `${text}\n\nScene: a moon garden`);
    assert.equal(saveStyle({ title: s.title, prompt: 'new writing', revision: s.revision }, s.id).prompt, 'new writing');
    assert.throws(() => saveStyle({ title: s.title, prompt: 'stale', revision: s.revision }, s.id), /changed elsewhere/);
  });
  it('applies the starred style to the chat door, never to explicit No style', () => {
    const s = saveStyle({ title: 'Chat default', prompt: 'luminous gouache' });
    setDefaultChatStyle(s.id);
    assert.equal(snapshotStyle(undefined)?.id, s.id);
    assert.equal(snapshotStyle(''), undefined);
    assert.equal(snapshotStyle(s.id)?.prompt, s.prompt);
    setDefaultChatStyle(null);
    assert.equal(snapshotStyle(undefined), undefined);
  });
  it('keeps an already-submitted snapshot stable while edits affect future chat pictures', () => {
    const s = saveStyle({ title: 'Changing style', prompt: 'old writing' }); setDefaultChatStyle(s.id);
    const submitted = snapshotStyle(undefined)!;
    saveStyle({ title: s.title, prompt: 'new writing', revision: s.revision }, s.id);
    assert.equal(submitted.prompt, 'old writing'); assert.equal(snapshotStyle(undefined)?.prompt, 'new writing');
    deleteStyle(s.id); assert.equal(getStudioStyles().defaultChatStyleId, null);
    assert.equal(submitted.prompt, 'old writing');
  });
  it('accepts all five ordered reference artworks, supports reordering, and preserves assets for queued jobs', async () => {
    let s = saveStyle({ title: 'Five references', prompt: 'a written style' });
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c0c8ef' } }).png().toBuffer();
    for (let i = 0; i < 5; i++) { s = await addStyleReference(s.id, bytes, `${i + 1}.png`, s.revision); assets.push(styleAssetPath(s.references.at(-1)!.filename)); }
    assert.equal(s.references.length, 5);
    const ids = s.references.map(r => r.id).reverse();
    s = saveStyle({ title: s.title, prompt: s.prompt, referenceIds: ids, revision: s.revision }, s.id);
    assert.deepEqual(snapshotStyle(s.id)?.references.map(r => r.id), ids);
    const copy = duplicateStyle(s.id); assert.equal(copy.references.length, 5); assert.notEqual(copy.id, s.id);
    deleteStyle(s.id); assert.ok(assets.every(existsSync));
    assert.equal(snapshotStyle(copy.id)?.references.length, 5);
  });
  it('rejects unknown reference IDs, traversal and non-image uploads', async () => {
    const s = saveStyle({ title: 'Validation', prompt: '' });
    assert.throws(() => saveStyle({ title: s.title, prompt: '', referenceIds: ['not-owned'], revision: s.revision }, s.id), /unknown/);
    assert.throws(() => styleAssetPath('../../secrets'), /Invalid/);
    await assert.rejects(addStyleReference(s.id, Buffer.from('not an image'), 'fake.png', s.revision), /valid PNG/);
  });
  it('never offers silently metered generation', () => {
    assert.equal(resolveImageModel().id, 'subscription-auto');
    assert.throws(() => resolveImageModel('gpt-image-2.5-sunburst'), /Enable them explicitly/);
    assert.throws(() => resolveImageModel('made-up-model'), /not supported/);
    setConfig('studio.allow_metered_images', 'true');
    assert.equal(resolveImageModel('gpt-image-2.5-sunburst').backend, 'openrouter');
    assert.equal(resolveImageModel('gpt-image-2.5-flare').backend, 'openrouter');
    assert.equal(resolveImageModel('gpt-image-2').backend, 'openrouter');
    assert.throws(() => resolveImageModel('gpt-image-1.5'), /not supported/);
    setConfig('studio.allow_metered_images', 'false');
  });
});
describe('concise flag-free prompt writing', () => {
  it('requests three different compositions using the selected written style as immutable context', () => {
    const text = promptWritingInstruction('game', 'celadon, lunaria, tarnish', 'opal illustration');
    assert.match(text, /exactly three/); assert.match(text, /different composition/); assert.match(text, /No Midjourney flags/); assert.match(text, /opal illustration/);
  });
  it('parses exactly three copy-ready prompts and rejects duplicates and flags', () => {
    assert.deepEqual(parsePromptGame('["one scene", "second scene", "third scene"]'), ['one scene', 'second scene', 'third scene']);
    assert.throws(() => parsePromptGame('["one", "one", "three"]'), /different/);
    assert.throws(() => parsePromptGame('["one --ar 2:3", "two", "three"]'), /without flags/);
    assert.throws(() => parsePromptGame('["one", "two"]'), /three/);
    assert.ok(hasMJFlags('art --sref https://example.test'));
    assert.throws(() => saveStyle({ title: 'No flags', prompt: 'art --ar 2:3' }), /Leave Midjourney flags out/);
  });
});
