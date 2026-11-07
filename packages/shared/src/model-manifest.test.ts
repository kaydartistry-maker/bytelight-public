// Tests for the shared model manifest — Slice 1 of 6B-C.
//
// Scope: static assertions about the catalog shape. These tests do NOT
// reach into pi-ai or any provider package; they verify the manifest's
// own invariants and the BYOK separation contract.
//
// The pi-ai drift test lives in
// `packages/backend/src/services/runtimes/codex-manifest-drift.test.ts`
// because the backend package already has pi-ai as a runtime dep — the
// shared package is intentionally kept free of provider SDK deps.
//
// Run with:
//   npx tsx --test packages/shared/src/model-manifest.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS,
  OPENAI_FEATURED_MODELS,
  providerToRuntime,
  parseModelRef,
  unwrapModelRefForClaudeSdk,
  type ModelEntry,
  type ProviderId,
} from './model-manifest.js';

// Canonical Codex catalog — kept in sync with the manifest. Any drift
// here vs. the manifest entries themselves fails the presence tests.
// Drift vs. the installed pi-ai package is enforced by the backend
// drift test, not this file.
const EXPECTED_CODEX_IDS = [
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const;

const codexModels = MODELS.filter((m): m is ModelEntry =>
  m.provider === 'openai-codex',
);

describe('model-manifest — Codex (ChatGPT OAuth) catalog presence', () => {
  test('all expected Codex model ids are registered', () => {
    const registered = new Set(codexModels.map((m) => m.id));
    for (const id of EXPECTED_CODEX_IDS) {
      assert.ok(registered.has(id), `expected Codex model "${id}" to be registered in MODELS`);
    }
  });

  test('catalog contains exactly the expected Codex model count', () => {
    assert.equal(codexModels.length, EXPECTED_CODEX_IDS.length,
      `Codex catalog size drift: expected ${EXPECTED_CODEX_IDS.length}, got ${codexModels.length}`);
  });

  test('every Codex entry has provider "openai-codex"', () => {
    for (const m of codexModels) {
      assert.equal(m.provider, 'openai-codex',
        `Codex entry "${m.id}" should have provider "openai-codex", got "${m.provider}"`);
    }
  });

  test('every Codex entry has runtime "codex"', () => {
    for (const m of codexModels) {
      assert.equal(m.runtime, 'codex',
        `Codex entry "${m.id}" should have runtime "codex", got "${m.runtime}"`);
    }
  });

  test('every Codex entry has auth type "codex-oauth"', () => {
    for (const m of codexModels) {
      assert.equal(m.auth.type, 'codex-oauth',
        `Codex entry "${m.id}" should have auth type "codex-oauth", got "${m.auth.type}"`);
    }
  });

  test('every Codex entry has canonical ref "openai-codex/<id>"', () => {
    for (const m of codexModels) {
      assert.equal(m.ref, `openai-codex/${m.id}`,
        `Codex entry "${m.id}" has malformed ref "${m.ref}"`);
    }
  });

  test('gpt-5.3-codex-spark is text-only (vision: false)', () => {
    const spark = codexModels.find((m) => m.id === 'gpt-5.3-codex-spark');
    assert.ok(spark, 'gpt-5.3-codex-spark not registered');
    assert.equal(spark.capabilities.vision, false,
      'gpt-5.3-codex-spark must be text-only — pi-ai registers it with input: ["text"] only');
  });

  test('all other Codex entries are vision-capable', () => {
    const visionExpected = codexModels.filter((m) => m.id !== 'gpt-5.3-codex-spark');
    for (const m of visionExpected) {
      assert.equal(m.capabilities.vision, true,
        `Codex entry "${m.id}" should be vision-capable per pi-ai registry`);
    }
  });

  test('Codex entries are not MCP-native (only claude-sdk is)', () => {
    for (const m of codexModels) {
      assert.equal(m.capabilities.mcp, false,
        `Codex entry "${m.id}" must not advertise mcp: true — only claude-sdk supports native MCP today`);
    }
  });

  test('Codex entries are not file-checkpointing (only claude-sdk is)', () => {
    for (const m of codexModels) {
      assert.equal(m.capabilities.fileCheckpointing, false,
        `Codex entry "${m.id}" must not advertise fileCheckpointing: true — only claude-sdk supports it today`);
    }
  });

  test('Codex entries advertise tools + reasoning + sessionResume', () => {
    for (const m of codexModels) {
      assert.equal(m.capabilities.tools, true, `${m.id} must support tools`);
      assert.equal(m.capabilities.reasoning, true, `${m.id} must support reasoning`);
      assert.equal(m.capabilities.sessionResume, true, `${m.id} must support sessionResume`);
    }
  });

  test('Codex entries do not set minClaudeCodeVersion (claude-sdk only field)', () => {
    for (const m of codexModels) {
      assert.equal(m.minClaudeCodeVersion, undefined,
        `Codex entry "${m.id}" must not set minClaudeCodeVersion — only meaningful for claude-sdk runtime`);
    }
  });
});

describe('model-manifest — gpt-5-nano is never Codex-selectable', () => {
  test('gpt-5-nano is not registered in MODELS as a Codex entry', () => {
    const matches = MODELS.filter(
      (m) => m.id === 'gpt-5-nano' && m.provider === 'openai-codex',
    );
    assert.equal(matches.length, 0,
      'gpt-5-nano must never appear as a Codex-selectable model in MODELS');
  });

  test('gpt-5-nano remains in OPENAI_FEATURED_MODELS (BYOK lane, separate from Codex)', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(OPENAI_FEATURED_MODELS, 'gpt-5-nano'),
      'gpt-5-nano should remain in OPENAI_FEATURED_MODELS — that lane is OpenAI BYOK, not Codex',
    );
  });

  test('no *-codex id appears in OPENAI_FEATURED_MODELS', () => {
    const offenders = Object.keys(OPENAI_FEATURED_MODELS).filter(
      (id) => id.endsWith('-codex') || id.includes('-codex-'),
    );
    assert.deepEqual(offenders, [],
      `OPENAI_FEATURED_MODELS must not feature *-codex ids — those belong to the Codex OAuth lane: ${offenders.join(', ')}`);
  });
});

describe('model-manifest — BYOK / Codex separation', () => {
  test('the GPT-6 shelf is exposed only through the subscription-backed Codex CLI lane', () => {
    const expected = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
    for (const id of expected) {
      const entries = MODELS.filter((m) => m.id === id);
      assert.equal(entries.length, 1, `${id} should have exactly one static manifest entry`);
      assert.equal(entries[0]?.provider, 'codex-cli');
      assert.equal(entries[0]?.runtime, 'codex-cli');
      assert.equal(entries[0]?.ref, `codex-cli/${id}`);
      assert.equal(entries[0]?.auth.type, 'none', 'the daemon owns ChatGPT CLI login');
      assert.ok(entries[0]?.tierHints.includes('interactive'));
      assert.ok(entries[0]?.tierHints.includes('autonomous'));
    }
  });

  test('no MODELS entry has provider "openai" (BYOK is discovery-only)', () => {
    const openaiEntries = MODELS.filter((m) => m.provider === 'openai');
    assert.deepEqual(openaiEntries.map((m) => m.id), [],
      `MODELS must not contain provider:"openai" rows — OpenAI BYOK is discovery-only via /api/models?provider=openai. Found: ${openaiEntries.map((m) => m.id).join(', ')}`);
  });

  test('no MODELS entry has provider "openrouter" or "ollama" (discovery-only)', () => {
    const offenders = MODELS.filter((m) => m.provider === 'openrouter' || m.provider === 'ollama');
    assert.deepEqual(offenders.map((m) => m.id), [],
      `MODELS must not contain OpenRouter/Ollama rows — those are discovery-only. Found: ${offenders.map((m) => m.id).join(', ')}`);
  });

  test('Claude entries remain present and unchanged in provider/runtime shape', () => {
    const claudeEntries = MODELS.filter((m) => m.provider === 'claude');
    assert.ok(claudeEntries.length > 0, 'Claude catalog should still be present');
    for (const m of claudeEntries) {
      assert.equal(m.runtime, 'claude-sdk', `Claude entry "${m.id}" should have runtime "claude-sdk"`);
      assert.equal(m.auth.type, 'claude-sdk', `Claude entry "${m.id}" should have auth type "claude-sdk"`);
      assert.equal(m.ref, `claude/${m.id}`, `Claude entry "${m.id}" has malformed ref "${m.ref}"`);
    }
  });
});

describe('model-manifest — provider/runtime mapping consistency', () => {
  test('providerToRuntime("openai-codex") === "codex"', () => {
    assert.equal(providerToRuntime('openai-codex'), 'codex');
  });

  test('every MODELS entry agrees with providerToRuntime(provider)', () => {
    for (const m of MODELS) {
      assert.equal(m.runtime, providerToRuntime(m.provider),
        `Entry "${m.id}" runtime "${m.runtime}" disagrees with providerToRuntime("${m.provider}")`);
    }
  });

  test('parseModelRef parses canonical Codex refs', () => {
    const parsed = parseModelRef('openai-codex/gpt-5.4-mini');
    assert.ok(parsed, 'expected openai-codex/gpt-5.4-mini to parse');
    assert.equal(parsed.provider, 'openai-codex' satisfies ProviderId);
    assert.equal(parsed.model, 'gpt-5.4-mini');
    assert.equal(parsed.runtime, 'codex');
    assert.equal(parsed.canonical, 'openai-codex/gpt-5.4-mini');
  });
});

describe('model-manifest — safety belt still rejects Codex from Claude SDK boundary', () => {
  test('unwrapModelRefForClaudeSdk throws for a Codex ref', () => {
    const codexRef = parseModelRef('openai-codex/gpt-5.4-mini');
    assert.ok(codexRef);
    assert.throws(
      () => unwrapModelRefForClaudeSdk(codexRef),
      /codex runtime/i,
      'unwrapModelRefForClaudeSdk must throw when handed a Codex ref',
    );
  });

  test('unwrapModelRefForClaudeSdk returns the bare id for a Claude ref', () => {
    const claudeRef = parseModelRef('claude/claude-sonnet-4-6');
    assert.ok(claudeRef);
    assert.equal(unwrapModelRefForClaudeSdk(claudeRef), 'claude-sonnet-4-6');
  });
});
