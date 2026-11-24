import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('custom Art Studio retains its upgrades alongside original Spellbook, drawing and editing entry points', () => {
  const studio = readFileSync(new URL('../StudioApp.tsx', import.meta.url), 'utf8');
  for (const component of ['MyStylesPanel', 'PromptGamePanel', 'StudioTransformPanel', 'RefsPanel', 'StudioSettingsPanel', 'SpellbookPanel', 'DrawingCanvas', 'EditPanel']) {
    assert.ok(studio.includes(`<${component}`), `${component} remains reachable in Studio`);
  }
  for (const label of ['Face Transplant', 'Smash & Mash', 'Spellbook', 'Drawing canvas', 'Edit result', 'Apply edits']) {
    assert.ok(studio.includes(label), `${label} has a visible entry point`);
  }
  assert.match(studio, /saveDescription=\{state\.saveDescription\}/);
  assert.match(studio, /subjectDescriptions: galleryDescriptions/);
});

test('Questing client remains app-native rather than calling a Cloud conversation', () => {
  const source = readFileSync(new URL('../games/BossBattles.tsx', import.meta.url), 'utf8');
  assert.match(source, /BOSS_BATTLES_PATH/);
  assert.match(source, /apiFetch/);
  assert.doesNotMatch(source, /letta-ai|api\.letta|letta-control/);
});
