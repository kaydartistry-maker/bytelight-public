// Codex manifest drift test — 6B-C Slice 1.
//
// The shared `@bytelight/shared` package mirrors pi-ai's openai-codex
// model registry as static catalog truth (see model-manifest.ts). This
// test reads the INSTALLED pi-ai package at test time and fails loudly
// if the static mirror drifts.
//
// Why this test lives in backend, not shared:
//   - The shared package is intentionally dep-free at runtime — no
//     provider SDK weight in the frontend bundle.
//   - The backend already has @earendil-works/pi-ai as a runtime dep.
//   - A drift test only needs to run in CI / dev — it doesn't need to
//     ship with the shared package.
//
// What this test enforces:
//   - Every model pi-ai registers under provider "openai-codex" has a
//     matching MODELS entry in the shared manifest (no missing rows).
//   - Every shared MODELS entry with provider "openai-codex" has a
//     matching pi-ai entry (no fabricated rows).
//   - The vision flag on each shared entry matches whether pi-ai
//     advertises "image" in its `input` array.
//
// Run with:
//   npx tsx --test packages/backend/src/services/runtimes/codex-manifest-drift.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// pi-ai 0.80.6 moved the static catalog read `getModels` off the top-level
// barrel into the `/compat` entrypoint.
import { getModels } from '@earendil-works/pi-ai/compat';
import { MODELS as SHARED_MODELS, RETIRED_CODEX_IDS } from '@bytelight/shared';

const piAiCodexModels = getModels('openai-codex');
const sharedCodexEntries = SHARED_MODELS.filter((m) => m.provider === 'openai-codex');

const piAiCodexIds = new Set(piAiCodexModels.map((m) => m.id));
const sharedCodexIds = new Set(sharedCodexEntries.map((m) => m.id));

describe('codex manifest drift — pi-ai openai-codex registry vs shared MODELS', () => {
  test('pi-ai registers at least one openai-codex model (installation sanity)', () => {
    assert.ok(piAiCodexModels.length > 0,
      'pi-ai getModels("openai-codex") returned []. Either the package is broken or pi-ai dropped Codex entirely.');
  });

  test('every pi-ai openai-codex model has a matching shared MODELS entry', () => {
    const missing: string[] = [];
    for (const piModel of piAiCodexModels) {
      // Retired for ChatGPT-account access: pi-ai still lists them, we do not.
      if (!sharedCodexIds.has(piModel.id) && !RETIRED_CODEX_IDS.includes(piModel.id)) {
        missing.push(piModel.id);
      }
    }
    assert.deepEqual(missing, [],
      `Shared manifest is missing Codex entries that pi-ai registers: ${missing.join(', ')}. ` +
      'Sync packages/shared/src/model-manifest.ts with the installed pi-ai registry.');
  });

  test('every shared Codex entry has a matching pi-ai openai-codex model', () => {
    const fabricated: string[] = [];
    for (const sharedEntry of sharedCodexEntries) {
      if (!piAiCodexIds.has(sharedEntry.id)) {
        fabricated.push(sharedEntry.id);
      }
    }
    assert.deepEqual(fabricated, [],
      `Shared manifest registers Codex entries that pi-ai does NOT recognise: ${fabricated.join(', ')}. ` +
      'Either pi-ai dropped them (remove from MODELS) or they were never valid (mistake).');
  });

  test('shared catalog count matches pi-ai openai-codex count, minus retired ids', () => {
    const liveInPiAi = piAiCodexModels.filter((m) => !RETIRED_CODEX_IDS.includes(m.id));
    assert.equal(sharedCodexEntries.length, liveInPiAi.length,
      `Codex catalog size drift: shared=${sharedCodexEntries.length}, pi-ai live=${liveInPiAi.length}`);
  });

  test('vision flag on each shared entry matches pi-ai input.includes("image")', () => {
    const mismatches: string[] = [];
    for (const sharedEntry of sharedCodexEntries) {
      const piModel = piAiCodexModels.find((m) => m.id === sharedEntry.id);
      if (!piModel) continue; // covered by the fabricated-entries test
      const piHasVision = Array.isArray(piModel.input) && piModel.input.includes('image');
      if (sharedEntry.capabilities.vision !== piHasVision) {
        mismatches.push(
          `${sharedEntry.id}: shared.vision=${sharedEntry.capabilities.vision}, pi-ai.input=${JSON.stringify(piModel.input)}`,
        );
      }
    }
    assert.deepEqual(mismatches, [],
      `Vision capability drift between shared catalog and pi-ai registry:\n  ${mismatches.join('\n  ')}`);
  });

  test('pi-ai does NOT register gpt-5-nano under openai-codex (guards against future pi-ai mistake)', () => {
    const nano = piAiCodexModels.find((m) => m.id === 'gpt-5-nano');
    assert.equal(nano, undefined,
      'pi-ai now registers gpt-5-nano under openai-codex — investigate before mirroring into shared catalog. ' +
      'The byte-light acceptance criterion is that gpt-5-nano must never appear as Codex-selectable.');
  });
});
