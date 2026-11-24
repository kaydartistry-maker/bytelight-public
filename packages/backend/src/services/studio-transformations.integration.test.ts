import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { getDb, initDb, setConfig } from './db.js';
import { setSecret } from './secrets.js';
import { FACE_TRANSPLANT_PROMPT, SMASH_PROMPT, prepareTransformationRequest } from './studio-transformations.js';

const dir = mkdtempSync(join(homedir(), '.studio-transform-render-'));
initDb(join(dir, 'test.sqlite'));
const { generateImage, deleteGalleryItem, monthlyImageSpendUsd, saveOneOffReference, STUDIO_UPLOADS_DIR } = await import('./image-gen.js');
const picture = join(dir, 'result.png'), cli = join(dir, 'fake-codex.mjs'), capture = join(dir, 'captured.json');
const buffers = await Promise.all(['#dd99cc', '#88bb99', '#99aadd'].map(background => sharp({ create: { width: 12, height: 18, channels: 3, background } }).png().toBuffer()));
writeFileSync(picture, buffers[0]);
writeFileSync(cli, `#!/usr/bin/env node
import fs from 'node:fs';let text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),text}));console.log('RESULT_PATH='+${JSON.stringify(picture)})});`, { mode: 0o700 });
setConfig('image_gen.enabled', 'true'); setConfig('image_gen.codex_bin', cli); setConfig('image_gen.codex_home', dir);
const tokens = await Promise.all(buffers.map((buffer, i) => saveOneOffReference(`transform-integration-${i}.png`, buffer)));
const results: string[] = [];
after(async () => { for (const f of results) await deleteGalleryItem(f); for (const t of tokens) rmSync(join(STUDIO_UPLOADS_DIR, t), { force: true }); getDb().close(); rmSync(dir, { recursive: true, force: true }); });

it('actual Codex wrapper sends only the ordered base and identities, with fixed prompt, mapping and edits', async () => {
  // A completely unreadable library must not affect these isolated tools.
  setConfig('studio.my_styles.v1', 'unrelated-style-library-must-not-be-read');
  const input = await prepareTransformationRequest({ kind: 'face-transplant', images: tokens, faceAssignments: 'Image 2 to left, Image 3 to right.', additionalEdits: 'Change the background to blue.' }, STUDIO_UPLOADS_DIR);
  const result = await generateImage(input); results.push(result.filename);
  const call = JSON.parse(readFileSync(capture, 'utf8'));
  const paths = call.args.flatMap((arg: string, i: number) => arg === '-i' ? [call.args[i + 1]] : []);
  assert.deepEqual(paths, tokens.map(t => join(STUDIO_UPLOADS_DIR, t)));
  assert.ok(call.text.includes(FACE_TRANSPLANT_PROMPT));
  assert.match(call.text, /Image 1 is the base artwork to edit/);
  assert.match(call.text, /Image 3 is a second, different facial identity/);
  assert.match(call.text, /Image 2 to left, Image 3 to right/);
  assert.match(call.text, /Change the background to blue/);
  assert.doesNotMatch(call.text, /AI-generated illustrations of FICTIONAL characters|first \d+ attached images define HOW/);
  assert.equal(result.backend, 'codex');
});

it('actual OpenRouter wrapper preserves two equal Smash images and records Studio spend without a real network call', async () => {
  const oldFetch = globalThis.fetch, oldVault = process.env.VIRELLE_VAULT_KEY_FILE;
  const key = join(dir, 'test-vault.key'); writeFileSync(key, randomBytes(32), { mode: 0o600 }); process.env.VIRELLE_VAULT_KEY_FILE = key;
  setSecret('provider_openrouter_api_key', 'test-only-credential'); setConfig('studio.allow_metered_images', 'true');
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/images');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'openai/gpt-image-2.5-sunburst');
    assert.equal(body.input_references.length, 2);
    assert.deepEqual(body.input_references.map((r: { image_url: { url: string } }) => r.image_url.url), buffers.slice(0, 2).map(b => `data:image/png;base64,${b.toString('base64')}`));
    assert.ok(body.prompt.includes(SMASH_PROMPT)); assert.match(body.prompt, /equal visual parents/);
    assert.doesNotMatch(body.prompt, /STYLE references|subject appearance/);
    return new Response(JSON.stringify({ data: [{ b64_json: buffers[0].toString('base64') }], usage: { cost: 0.08 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const input = await prepareTransformationRequest({ kind: 'smash', images: tokens.slice(0, 2), imageModelId: 'gpt-image-2.5-sunburst' }, STUDIO_UPLOADS_DIR);
    const result = await generateImage(input); results.push(result.filename);
    assert.equal(calls, 1); assert.equal(result.backend, 'openrouter'); assert.equal(await monthlyImageSpendUsd(), 0.08);
    setConfig('studio.allow_metered_images', 'false');
    await assert.rejects(generateImage(input), /Enable them explicitly/); assert.equal(calls, 1);
  } finally { globalThis.fetch = oldFetch; setConfig('studio.allow_metered_images', 'false'); if (oldVault === undefined) delete process.env.VIRELLE_VAULT_KEY_FILE; else process.env.VIRELLE_VAULT_KEY_FILE = oldVault; }
});
