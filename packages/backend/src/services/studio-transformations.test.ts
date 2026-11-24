import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { getDb, initDb, setConfig } from './db.js';
import { FACE_TRANSPLANT_PROMPT, SMASH_PROMPT, prepareTransformationRequest, transformationReferenceGuidance } from './studio-transformations.js';

const dir = mkdtempSync(join(tmpdir(), 'studio-transformations-'));
initDb(join(dir, 'test.sqlite'));
const tokens = ['1794970000000-abcdef-base.png', '1794970000001-abcdef-face.png', '1794970000002-abcdef-second.png'];
for (const [i, token] of tokens.entries()) writeFileSync(join(dir, token), await sharp({ create: { width: 12, height: i ? 12 : 18, channels: 3, background: '#b9aacc' } }).png().toBuffer());
after(() => { getDb().close(); rmSync(dir, { force: true, recursive: true }); });
const face = (extra: Record<string, unknown> = {}) => ({ kind: 'face-transplant', images: tokens.slice(0, 2), ...extra });
const smash = (extra: Record<string, unknown> = {}) => ({ kind: 'smash', images: tokens.slice(0, 2), ...extra });

it('uses the fixed face prompt, preserves ordered images, and isolates all style and subject fields', async () => {
  setConfig('studio.chat_image_model', 'gpt-image-2.5-sunburst');
  setConfig('studio.my_styles.v1', JSON.stringify({ defaultChatStyleId: 'must-not-load', styles: [] }));
  const input = await prepareTransformationRequest(face({ prompt: 'attacker override', styleId: 'must-not-load', subjects: ['user'], extraRefs: ['/secret'], backend: 'openai' }), dir);
  assert.equal(input.prompt, FACE_TRANSPLANT_PROMPT);
  assert.equal(input.styleId, ''); assert.deepEqual(input.subjects, []); assert.equal(input.extraRefs, undefined);
  assert.deepEqual(input.oneOffRefs, tokens.slice(0, 2)); assert.equal(input.usageOrigin, 'studio');
  assert.equal(input.imageModelId, 'subscription-auto'); assert.equal(input.size, 'portrait');
  assert.deepEqual(input.transformation, { kind: 'face-transplant', imageCount: 2 });
  assert.match(FACE_TRANSPLANT_PROMPT, /^Edit Image 1 to depict/);
  assert.match(FACE_TRANSPLANT_PROMPT, /Change WHO the artist depicted\. Preserve HOW the artist depicted them\.\nProduce one cohesive edited image\.$/);
});

it('appends optional edits independently while preserving every character of the fixed face prompt', async () => {
  const input = await prepareTransformationRequest(face({ additionalEdits: 'Make the background blue.' }), dir);
  assert.ok(input.prompt.startsWith(FACE_TRANSPLANT_PROMPT + '\n\nADDITIONAL REQUESTED EDITS\n'));
  assert.match(input.prompt, /exceptions to the preservation rules/);
  assert.ok(input.prompt.endsWith('Make the background blue.'));
});

it('requires explicit mapping for two distinct identities and preserves that mapping in the role wrapper', async () => {
  await assert.rejects(prepareTransformationRequest(face({ images: tokens }), dir), /Assign Image 2 and Image 3/);
  const input = await prepareTransformationRequest(face({ images: tokens, faceAssignments: 'Image 2 → left woman; Image 3 → right man.' }), dir);
  assert.deepEqual(input.oneOffRefs, tokens);
  const guidance = transformationReferenceGuidance(input.transformation!);
  assert.match(guidance, /Image 3 is a second, different facial identity reference/);
  assert.match(guidance, /independently to each assigned person/);
  assert.match(guidance, /left woman/); assert.match(guidance, /right man/);
  assert.equal(input.prompt, FACE_TRANSPLANT_PROMPT);
});

it('allows a two-image target assignment without inventing a third identity', async () => {
  const input = await prepareTransformationRequest(face({ faceAssignments: 'Replace only the person on the left.' }), dir);
  const guidance = transformationReferenceGuidance(input.transformation!);
  assert.match(guidance, /only the person on the left/); assert.doesNotMatch(guidance, /Image 3/);
});

it('uses the exact Smash prompt and treats both ordered inputs as equal visual references', async () => {
  const input = await prepareTransformationRequest(smash(), dir);
  assert.equal(input.prompt, SMASH_PROMPT); assert.deepEqual(input.oneOffRefs, tokens.slice(0, 2));
  assert.match(transformationReferenceGuidance(input.transformation!), /equal visual parents/);
  assert.equal(input.size, undefined); assert.equal(input.styleId, '');
  assert.match(SMASH_PROMPT, /smooth 50\/50 fusion/); assert.ok(SMASH_PROMPT.endsWith('awkward fusion, hodgepodge.'));
});

it('rejects missing, extra or invalid request images before any renderer is invoked', async () => {
  for (const body of [null, [], {}, face({ images: [] }), face({ images: tokens.concat(tokens) }), smash({ images: tokens }), face({ images: [tokens[0], '../outside.png'] }), face({ images: [tokens[0], '/etc/passwd'] }), face({ images: [tokens[0], '1794970000003-abcdef-missing.png'] })]) {
    await assert.rejects(prepareTransformationRequest(body, dir));
  }
});

it('rejects symlinks and invalid uploaded image bytes', async () => {
  const link = '1794970000004-abcdef-link.png', bad = '1794970000005-abcdef-bad.png';
  symlinkSync(join(dir, tokens[0]), join(dir, link)); writeFileSync(join(dir, bad), 'not an image');
  await assert.rejects(prepareTransformationRequest(face({ images: [tokens[0], link] }), dir), /missing/);
  await assert.rejects(prepareTransformationRequest(face({ images: [tokens[0], bad] }), dir), /could not be read/);
});

it('bounds edits and assignments, and prohibits face-only controls on Smash', async () => {
  for (const body of [face({ additionalEdits: 'x'.repeat(4001) }), face({ faceAssignments: 'x'.repeat(1001) }), face({ additionalEdits: 1 }), face({ faceAssignments: {} }), smash({ additionalEdits: 'x' }), smash({ faceAssignments: 'x' })]) await assert.rejects(prepareTransformationRequest(body, dir));
});

it('requires explicit paid-model consent and rejects unsupported or nontext model IDs', async () => {
  setConfig('studio.allow_metered_images', 'false');
  await assert.rejects(prepareTransformationRequest(face({ imageModelId: 'gpt-image-2.5-sunburst' }), dir), /Enable them explicitly/);
  await assert.rejects(prepareTransformationRequest(face({ imageModelId: 'unknown' }), dir), /not supported/);
  await assert.rejects(prepareTransformationRequest(face({ imageModelId: {} }), dir), /Choose an image model/);
  setConfig('studio.allow_metered_images', 'true');
  const input = await prepareTransformationRequest(smash({ imageModelId: 'gpt-image-2.5-flare' }), dir);
  assert.equal(input.imageModelId, 'gpt-image-2.5-flare');
  setConfig('studio.allow_metered_images', 'false');
});
