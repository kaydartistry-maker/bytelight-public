import { test } from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import secretsRouter, { isRevealableSecret } from './secrets.js';
import { initDb } from '../services/db.js';
import { setSecret, deleteSecret } from '../services/secrets.js';

// GET /api/secrets/:name returns a raw value. It used to return ANY secret to
// any valid session, so a stolen cookie could read every key at once. Only the
// values the browser genuinely uses are revealable now; everything else is
// write-only from a client.

test('the browser-needed secrets are revealable', () => {
  // lovense_developer_token: the phone's toy bridge hands it to Lovense's SDK
  // on the device, so the app file never has to carry it.
  for (const name of ['elevenlabs_api_key', 'giphy_api_key', 'cortex_mcp_url', 'cortex_auth_token', 'lovense_developer_token']) {
    assert.ok(isRevealableSecret(name), `${name} should be revealable`);
  }
  // Per-companion voice ids, whatever the slug.
  assert.ok(isRevealableSecret('elevenlabs_voice_id:companion-a'));
  assert.ok(isRevealableSecret('elevenlabs_voice_id:some-new-slug'));
});

test('tokens and cloud keys are never revealable', () => {
  for (const name of [
    'discord_bot_token',
    'telegram_bot_token',
    'fcm_service_account',
    'github_token',
    'cloudflare_api_token',
    'vapid_private_key',
    'mind_api_key',
    'tavily_api_key',
    'groq_api_key',
    'cortex_auth_token_evil', // near-miss must not pass
    'elevenlabs_api_key_backup', // near-miss must not pass
  ]) {
    assert.equal(isRevealableSecret(name), false, `${name} must not be revealable`);
  }
});

// The route itself, so the gate is held where a client meets it: a write-only
// key answers the same refusal whether or not it is set.
test('the route refuses a write-only key without saying whether it is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-route-'));
  // Values are sealed at rest; keep the key file in the test's own folder.
  process.env.BYTELIGHT_SECRETS_KEY_FILE = join(dir, 'secrets.key');
  initDb(join(dir, 'test.db'));
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.GIPHY_API_KEY;
  const app = express();
  app.use(express.json());
  app.use('/api', secretsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    deleteSecret('discord_bot_token');
    const unset = await fetch(`${base}/secrets/discord_bot_token`);
    setSecret('discord_bot_token', 'bot-token-value');
    const set = await fetch(`${base}/secrets/discord_bot_token`);
    assert.equal(unset.status, 403);
    assert.equal(set.status, 403);
    assert.deepEqual(await unset.json(), await set.json(), 'set and unset must look the same');

    deleteSecret('giphy_api_key');
    assert.equal((await fetch(`${base}/secrets/giphy_api_key`)).status, 404, 'a revealable key that is unset says so');
    setSecret('giphy_api_key', 'giphy-value');
    const giphy = await fetch(`${base}/secrets/giphy_api_key`);
    assert.equal(giphy.status, 200);
    assert.deepEqual(await giphy.json(), { name: 'giphy_api_key', value: 'giphy-value' });

    const list = await (await fetch(`${base}/secrets`)).json() as { secrets: Array<{ name: string; revealable: boolean }> };
    const row = (n: string) => list.secrets.find((s) => s.name === n);
    assert.equal(row('giphy_api_key')?.revealable, true);
    assert.equal(row('discord_bot_token')?.revealable, false);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
