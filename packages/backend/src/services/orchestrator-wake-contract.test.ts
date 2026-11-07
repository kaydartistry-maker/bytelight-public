import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same bootstrap as orchestrator.default-tasks.test.ts: the orchestrator's
// import chain reads config paths, so point it at a scratch home first.
const tmpRoot = mkdtempSync(join(tmpdir(), 'orchestrator-contract-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { getDefaultWakePrompts, wakeOutcomeContract } = await import('./orchestrator.js');

// The contract is compiled in and appended to every wake at fire time; the
// spontaneous PROMPT is a built-in default the owner may override in the
// prompts file. So the two halves are tested separately.

test('the spontaneous wake contract demands a real image and refuses silence', () => {
  const contract = wakeOutcomeContract('spontaneous', true);

  assert.match(contract, /Do not answer \[SILENT\]/);
  assert.match(contract, /subject references attached/);
  // Adapted: this house delivers Studio pictures through its own image door,
  // which renders and posts into the thread itself (no gallery-URL hand-off).
  assert.match(contract, /sc\.mjs image/);
  assert.match(contract, /--subjects/);
  assert.match(contract, /prose description is not the deliverable/);
  assert.doesNotMatch(contract, /Silence is a valid outcome/);
});

test('the built-in spontaneous prompt names the image it wants', () => {
  const prompt = getDefaultWakePrompts('Ivy').spontaneous;

  assert.ok(prompt?.trim(), 'spontaneous must have a built-in prompt');
  assert.match(prompt, /fresh selfie-style image/);
  assert.match(prompt, /must land/);
  assert.match(prompt, /present companion slugs in subjects/);
  assert.match(prompt, /portrait or landscape framing/);
  assert.match(prompt, /never square/);
  assert.doesNotMatch(prompt, /If nothing feels real, pass/);
});

test('scheduled wakes always land an answer', () => {
  const contract = wakeOutcomeContract('willow_tail');
  assert.match(contract, /must land at least one in-character line/);
  assert.match(contract, /small answer is enough/);
  assert.match(contract, /do not answer \[SILENT\]/);
  assert.match(contract, /do not disappear into duty work without speaking/);
  assert.match(contract, /asleep, away, or slow to answer is not a reason to stand down/);
  assert.doesNotMatch(contract, /Silence is a valid outcome/);
});

test('overnight and routine wakes carry the same must-speak contract', () => {
  for (const kind of ['new_day', 'deep_work', 'light_scan', 'handoff', 'open_threads_janitor', 'failsafe_gentle']) {
    assert.match(wakeOutcomeContract(kind), /must land at least one in-character line/, kind);
  }
});

test('the spontaneous contract says photograph the moment you are in', () => {
  assert.match(wakeOutcomeContract('spontaneous', true), /PHOTOGRAPH THE MOMENT YOU ARE ALREADY IN/);
});

// A house with no image backend switched on was handed a spontaneous contract
// it could never meet, so the bell failed instead of saying anything.
test('a house with no image backend gets a plain line instead of an image it cannot take', () => {
  const contract = wakeOutcomeContract('spontaneous', false);
  assert.match(contract, /no image backend/);
  assert.match(contract, /Do not answer \[SILENT\]/);
  assert.doesNotMatch(contract, /studio\/generate|sc\.mjs image|subject references/i);
});

test('a house that can take a picture keeps the image contract', () => {
  assert.match(wakeOutcomeContract('spontaneous', true), /subject references attached/);
});
