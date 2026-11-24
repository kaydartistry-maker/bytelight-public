import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';
import { getDb, initDb, setConfig } from './db.js';
import { addStyleReference, deleteStyle, saveStyle, setDefaultChatStyle, styleAssetPath } from './studio-styles.js';
import { setSecret } from './secrets.js';
import { randomBytes } from 'node:crypto';

// The real vault rejects /tmp's world-writable ancestry. Match its security rules.
const dir = mkdtempSync(join(homedir(), '.studio-render-test-'));
const priorDataDir = process.env.BYTELIGHT_STUDIO_DATA_DIR;
process.env.BYTELIGHT_STUDIO_DATA_DIR = join(dir, 'studio-data');
initDb(join(dir, 'db.sqlite'));
const { generateImage, prepareStudioGeneration, recordGalleryMeta, listGallery, deleteGalleryItem, saveReference, deleteReference, monthlyImageSpendUsd, createDrawer, renameDrawer, deleteDrawer, getDrawerDescription, saveDrawerDescription, listReferences } = await import('./image-gen.js');
const picture = join(dir, 'fixture.png'), capture = join(dir, 'calls.jsonl'), refuse = join(dir, 'refuse'), cli = join(dir, 'fake-codex.mjs');
writeFileSync(picture, await sharp({ create: { width: 12, height: 12, channels: 3, background: '#adc4cb' } }).png().toBuffer());
writeFileSync(cli, `#!/usr/bin/env node
import fs from 'node:fs';let text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),text})+'\\n');if(fs.existsSync(${JSON.stringify(refuse)})){console.error('The request was rejected by the safety system');process.exit(1)}console.log('RESULT_PATH='+${JSON.stringify(picture)})});`, { mode: 0o700 });
setConfig('image_gen.enabled', 'true'); setConfig('image_gen.codex_bin', cli); setConfig('image_gen.codex_home', dir);
const assets: string[] = [], results: string[] = [], subjectRefs: string[] = [];
after(async () => {
  for (const f of results) await deleteGalleryItem(f);
  for (const f of subjectRefs) await deleteReference('user', f);
  for (const f of assets) rmSync(f, { force: true });
  getDb().close();
  if (priorDataDir === undefined) delete process.env.BYTELIGHT_STUDIO_DATA_DIR;
  else process.env.BYTELIGHT_STUDIO_DATA_DIR = priorDataDir;
  rmSync(dir, { recursive: true, force: true });
});

it('the actual chat generation door sends all five ordered style artworks plus separate subject images to the renderer', async () => {
  let style = saveStyle({ title: 'Renderer fixture', prompt: 'opal paper, luminous botanical illustration' });
  for (let i = 0; i < 5; i++) { style = await addStyleReference(style.id, readFileSync(picture), `reference-${i}.png`, style.revision); assets.push(styleAssetPath(style.references.at(-1)!.filename)); }
  subjectRefs.push(await saveReference('user', `studio-test-${crypto.randomUUID()}.png`, readFileSync(picture)));
  setDefaultChatStyle(style.id);
  const prepared = prepareStudioGeneration({ prompt: 'a moonlit garden', subjects: ['user'] });
  assert.equal(prepared.styleSnapshot?.references.length, 5);
  assert.equal(prepared.styleId, style.id, 'chat images with omitted styleId use the starred default');
  assert.equal(prepareStudioGeneration({ prompt: 'a garden', styleId: '' }).styleSnapshot, undefined);
  assert.equal(prepareStudioGeneration({ prompt: 'a spell scene', styleRefs: [picture] }).styleSnapshot, undefined, 'spell style references suppress the chat default');
  // Editing/deleting after submission cannot mutate the submitted snapshot/assets.
  deleteStyle(style.id);
  const result = await generateImage(prepared); results.push(result.filename);
  const call = JSON.parse(readFileSync(capture, 'utf8').trim());
  const imageArgs = call.args.flatMap((a: string, i: number) => a === '-i' ? [call.args[i + 1]] : []);
  assert.equal(imageArgs.length, 6); assert.deepEqual(imageArgs.slice(0, 5), assets);
  assert.match(call.text, /opal paper/); assert.match(call.text, /Scene: a moonlit garden/); assert.match(call.text, /first 5 attached images define HOW to render/);
  assert.match(call.text, /Every person depicted in those style images is style-only/);
  assert.match(call.text, /remaining subject reference images are grouped in this exact written-subject order: You/);
  assert.match(call.text, /identity authority for each named subject's face, hair, body/);
  await recordGalleryMeta(result.filename, { prompt: 'a moonlit garden', messageId: 'chat-fixture', threadId: 'test-thread' });
  const row = (await listGallery()).find(r => r.filename === result.filename)!;
  assert.equal(row.styleId, style.id); assert.match(row.prompt!, /opal paper/); assert.equal(row.sourcePrompt, 'a moonlit garden'); assert.equal(row.messageId, 'chat-fixture');
});

it('supports description-only and mixed casts without deleting or attaching the described person’s photos', async () => {
  const description = { slug: 'user', description: 'Rosy hair and a yellow raincoat.' };
  const companionRef = await saveReference('companion-a', `studio-test-${crypto.randomUUID()}.png`, readFileSync(picture));
  try {
    for (const subjects of [[], ['companion-a']]) {
      const input = { prompt: 'Waiting at a station.', styleId: '', subjects, subjectDescriptions: [description] };
      const preview = prepareStudioGeneration(input);
      const result = await generateImage(input); results.push(result.filename);
      const call = JSON.parse(readFileSync(capture, 'utf8').trim().split('\n').at(-1)!);
      const imageArgs = call.args.flatMap((a: string, i: number) => a === '-i' ? [call.args[i + 1]] : []);
      assert.equal(imageArgs.length, subjects.length);
      if (subjects.length) assert.ok(imageArgs[0].endsWith(companionRef));
      assert.ok(call.text.includes(preview.prompt));
      assert.match(preview.prompt, /Written subject references \(appearance\):\nYou: Rosy hair and a yellow raincoat\./);
      const row = (await listGallery()).find(r => r.filename === result.filename)!;
      assert.equal(row.sourcePrompt, input.prompt);
      assert.equal(row.prompt, preview.prompt);
      assert.deepEqual(row.subjectDescriptions, [description]);
    }
    assert.equal(prepareStudioGeneration({ prompt: 'Another scene.', subjects: ['user'], styleId: '' }).prompt, 'Another scene.');
    const result = await generateImage({ prompt: 'Another scene.', subjects: ['user'], styleId: '' }); results.push(result.filename);
    const call = JSON.parse(readFileSync(capture, 'utf8').trim().split('\n').at(-1)!);
    assert.ok(call.args.some((arg: string) => arg.endsWith(subjectRefs[0])));
  } finally { await deleteReference('companion-a', companionRef); }
});

it('rejects blank, oversized, unknown, duplicate or conflicting subject descriptions before rendering', () => {
  const input = { prompt: 'A low-key portrait.', styleId: '' };
  const valid = { slug: 'user', description: 'Pink hair' };
  for (const subjectDescriptions of [[{ ...valid, description: ' ' }], [{ ...valid, description: 'x'.repeat(1201) }], [{ ...valid, slug: 'missing' }]]) {
    assert.throws(() => prepareStudioGeneration({ ...input, subjectDescriptions }), /description of up to 1,200/);
  }
  assert.throws(() => prepareStudioGeneration({ ...input, subjectDescriptions: [valid, valid] }), /either photos or a description/);
  assert.throws(() => prepareStudioGeneration({ ...input, subjects: ['You'], subjectDescriptions: [valid] }), /either photos or a description/);
});

it('saved drawer descriptions are reused by slug without photos and are snapshotted before rendering', async () => {
  const drawer = createDrawer(`Saved subject ${randomBytes(4).toString('hex')}`);
  try {
    const image = await saveReference(drawer.slug, 'retained.png', readFileSync(picture));
    const input = { prompt: 'At the station.', styleId: '', descriptionSubjects: [drawer.slug] };
    assert.throws(() => prepareStudioGeneration(input), /Save a written description/);
    assert.equal(saveDrawerDescription(drawer.slug, '  Copper curls and green glasses.  '), 'Copper curls and green glasses.');
    renameDrawer(drawer.slug, 'Renamed subject');
    assert.equal(getDrawerDescription(drawer.slug), 'Copper curls and green glasses.');
    assert.deepEqual(await listReferences(drawer.slug), [image]);
    const prepared = prepareStudioGeneration(input);
    assert.match(prepared.prompt, /Renamed subject: Copper curls and green glasses\./);
    assert.throws(() => prepareStudioGeneration({ ...input, subjects: [drawer.slug] }), /either photos or a description/);
    saveDrawerDescription(drawer.slug, 'Steel-blue glasses.');
    assert.match(prepareStudioGeneration(input).prompt, /Steel-blue glasses/);
    const result = await generateImage(prepared); results.push(result.filename);
    const call = JSON.parse(readFileSync(capture, 'utf8').trim().split('\n').at(-1)!);
    assert.match(call.text, /Copper curls/);
    assert.ok(!call.args.includes('-i'));
    const saved = (await listGallery()).find(x => x.filename === result.filename)!;
    assert.deepEqual(saved.subjectDescriptions, [{ slug: drawer.slug, description: 'Copper curls and green glasses.' }]);
    assert.equal(saveDrawerDescription(drawer.slug, ' '), '');
    assert.deepEqual(await listReferences(drawer.slug), [image]);
    saveDrawerDescription(drawer.slug, 'About to be removed with this drawer.');
    await deleteDrawer(drawer.slug);
    assert.equal(getDrawerDescription(drawer.slug), '');
    assert.throws(() => saveDrawerDescription(drawer.slug, 'Not a drawer anymore.'), /Drawer not found/);
  } finally { await deleteDrawer(drawer.slug); }
});

it('original Spellbook look references and lineage coexist with immutable custom Studio receipts', async () => {
  const { spellRenders } = await import('./image-gen.js');
  const defaultStyle = saveStyle({ title: 'Unrelated chat default', prompt: 'UNRELATED-CHAT-STYLE' });
  setDefaultChatStyle(defaultStyle.id);
  try {
    const prepared = prepareStudioGeneration({ prompt: 'a spellbook scene with a selected look', styleRefs: [picture] });
    assert.equal(prepared.styleSnapshot, undefined);
    assert.doesNotMatch(prepared.prompt, /UNRELATED-CHAT-STYLE/);
    const result = await generateImage(prepared); results.push(result.filename);
    const call = JSON.parse(readFileSync(capture, 'utf8').trim().split('\n').at(-1)!);
    const imageArgs = call.args.flatMap((a: string, i: number) => a === '-i' ? [call.args[i + 1]] : []);
    assert.deepEqual(imageArgs, [picture]);
    assert.match(call.text, /first 1 attached images define HOW to render/);
    const spell = { id: 'spell-restoration-fixture', title: 'The original book', scene: '[Character 1] in a garden', cast: ['user'], look: 'pastel', tags: ['garden'], fitted: true };
    await recordGalleryMeta(result.filename, { spell, createdAt: '2026-11-20T03:00:00Z' });
    const row = (await listGallery()).find(r => r.filename === result.filename)!;
    assert.deepEqual(row.spell, spell);
    assert.equal(row.sourcePrompt, prepared.sourcePrompt);
    assert.deepEqual((await spellRenders()).get(spell.id)?.[0].spell, spell);
  } finally { deleteStyle(defaultStyle.id); }
});

it('a provider refusal is surfaced once, never retried after dropping reference images', async () => {
  const before = readFileSync(capture, 'utf8').trim().split('\n').length;
  writeFileSync(refuse, 'refuse');
  await assert.rejects(generateImage({ prompt: 'a quiet garden', subjects: ['user'], styleId: '' }), /rejected by the safety system/);
  assert.equal(readFileSync(capture, 'utf8').trim().split('\n').length, before + 1);
});

it('rejects more than sixteen references before invoking the renderer', async () => {
  const before = readFileSync(capture, 'utf8');
  await assert.rejects(generateImage({ prompt: 'a garden', styleId: '', extraRefs: Array(17).fill(picture) }), /at most 16/);
  assert.equal(readFileSync(capture, 'utf8'), before);
  assert.ok(assets.every(existsSync));
});

it('routes Sunburst and all five style images through existing OpenRouter, records spend and enforces consent without real network calls', async () => {
  const originalFetch = globalThis.fetch, oldVault = process.env.VIRELLE_VAULT_KEY_FILE;
  const key = join(dir, 'test-vault.key'); writeFileSync(key, randomBytes(32), { mode: 0o600 }); process.env.VIRELLE_VAULT_KEY_FILE = key;
  setSecret('provider_openrouter_api_key', 'test-only-not-a-real-api-key'); setConfig('studio.allow_metered_images', 'true');
  setConfig('image_gen.monthly_budget_usd', '0.10');
  let style = saveStyle({ title: 'API reference fixture', prompt: 'opal paper illustration' });
  for (let i = 0; i < 5; i++) { style = await addStyleReference(style.id, readFileSync(picture), `api-${i}.png`, style.revision); assets.push(styleAssetPath(style.references.at(-1)!.filename)); }
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/images');
    assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer test-token');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'openai/gpt-image-2.5-sunburst'); assert.equal(body.input_references.length, 5);
    assert.ok(body.input_references.every((ref: { type: string; image_url: { url: string } }) => ref.type === 'image_url' && ref.image_url.url === `data:image/png;base64,${readFileSync(picture).toString('base64')}`));
    assert.match(body.prompt, /first 5 attached images are STYLE references/);
    assert.match(body.prompt, /opal paper illustration/);
    return new Response(JSON.stringify({ data: [{ b64_json: readFileSync(picture).toString('base64'), media_type: 'image/png' }], usage: { cost: 0.08 } }), { status: 200 });
  };
  try {
    const input = { usageOrigin: 'studio' as const, prompt: 'a garden', styleId: style.id, imageModelId: 'gpt-image-2.5-sunburst' };
    const image = await generateImage(input); results.push(image.filename);
    assert.equal(image.model, 'openai/gpt-image-2.5-sunburst'); assert.equal(image.backend, 'openrouter'); assert.equal(calls, 1);
    assert.equal(image.costUsd, 0.08); assert.equal(image.costSource, 'actual'); assert.equal(await monthlyImageSpendUsd(), 0.08);
    const second = await generateImage(input); results.push(second.filename);
    assert.equal(await monthlyImageSpendUsd(), 0.16);
    await assert.rejects(generateImage(input), /Monthly image budget reached/); assert.equal(calls, 2);
    const queued = prepareStudioGeneration(input);
    setConfig('studio.allow_metered_images', 'false');
    await assert.rejects(generateImage(queued), /Enable them explicitly/); assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch; setConfig('studio.allow_metered_images', 'false');
    setConfig('image_gen.monthly_budget_usd', '0');
    if (oldVault === undefined) delete process.env.VIRELLE_VAULT_KEY_FILE; else process.env.VIRELLE_VAULT_KEY_FILE = oldVault;
  }
});
