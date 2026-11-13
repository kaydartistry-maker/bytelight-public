import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeHealthView, codexEngineView, expiresIn, manualCodeError, type ClaudeHealth } from './engine-status';

test('codex: which login the house stands on', () => {
  assert.deepEqual(codexEngineView(null), { ok: false, login: 'Not signed in', expiresAt: null });
  assert.deepEqual(codexEngineView({ loggedIn: false, source: null }), { ok: false, login: 'Not signed in', expiresAt: null });
  assert.deepEqual(codexEngineView({ loggedIn: true, source: 'house', expiresAt: 5 }), { ok: true, login: 'House login', expiresAt: 5 });
  assert.deepEqual(codexEngineView({ loggedIn: true, source: 'cli', expiresAt: null }), { ok: true, login: 'Borrowed from codex login', expiresAt: null });
});

test('manual code: 409 tells her to press Log in first', () => {
  assert.match(manualCodeError(409, { error: 'No active Codex login is waiting for a manual code' }), /Press Log in first/);
  assert.equal(manualCodeError(400, { error: 'Field `code` is required' }), 'Field `code` is required');
  assert.match(manualCodeError(500, null), /did not go through/);
});

const base: ClaudeHealth = {
  activeRuntimeVersion: '2.1.296',
  installedRuntimeVersion: '2.1.296',
  systemCcVersion: '2.1.322',
  minRequired: { version: '2.1.251', reason: 'claude-opus-5-5 (interactive)' },
  restartRequired: false,
  cliLaneEnabled: true,
};

test('claude: SDK read and healthy is green', () => {
  const v = claudeHealthView({ ...base, cliLaneEnabled: false });
  assert.equal(v.headline, 'green');
  assert.equal(v.label, 'OK');
});

test('claude: unreadable SDK with the CLI lane answering is not Unknown', () => {
  const v = claudeHealthView({ ...base, activeRuntimeVersion: null, installedRuntimeVersion: null });
  assert.equal(v.headline, 'green');
  assert.equal(v.cliAnswering, true);
  assert.equal(v.label, 'OK · Claude Code 2.1.322 is answering');
});

test('claude: unreadable SDK and no CLI lane stays Unknown', () => {
  const v = claudeHealthView({ ...base, activeRuntimeVersion: null, cliLaneEnabled: false });
  assert.equal(v.headline, 'yellow');
  assert.equal(v.label, 'Unknown');
  const noCli = claudeHealthView({ ...base, activeRuntimeVersion: null, systemCcVersion: null });
  assert.equal(noCli.label, 'Unknown');
});

test('claude: outdated beats restart beats ok', () => {
  assert.equal(claudeHealthView({ ...base, activeRuntimeVersion: '2.1.200', restartRequired: true }).label, 'Outdated');
  assert.equal(claudeHealthView({ ...base, restartRequired: true }).label, 'Restart required');
});

test('expiry in plain words', () => {
  const now = 1_000_000_000_000;
  assert.equal(expiresIn(null, now), null);
  assert.match(expiresIn(now - 1, now)!, /due now/);
  assert.equal(expiresIn(now + 10 * 60_000, now), 'in under an hour');
  assert.equal(expiresIn(now + 5 * 3_600_000, now), 'in 5 hours');
  assert.equal(expiresIn(now + 4 * 86_400_000, now), 'in 4 days');
});
