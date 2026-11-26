import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GET /api/config handed back the whole config table, and the secrets store
// lives in that same table under 'secret:'. The Secrets screen masks them;
// this route did not. It sits behind the login, and nothing in the phone calls
// it, but a signed-in page should never be one request away from every key.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the public view of the config never carries a secret row', async () => {
  const secrets = await import('./secrets.js') as Record<string, unknown>;
  const withoutSecrets = secrets.withoutSecrets as ((c: Record<string, string>) => Record<string, string>) | undefined;
  assert.equal(typeof withoutSecrets, 'function');
  const view = withoutSecrets!({
    'secret:discord_bot_token': 'x',
    'secret:elevenlabs_voice_id:companion-a': 'y',
    'image_gen.fallback_chain': 'antigravity,openart',
    'heartbeat.autocompact_tokens': '800000',
  });
  assert.deepEqual(view, {
    'image_gen.fallback_chain': 'antigravity,openart',
    'heartbeat.autocompact_tokens': '800000',
  });
});

// This house serves /config and /settings from routes/preferences-routes.ts.
test('the config and settings routes answer with the filtered view', () => {
  const src = readFileSync(join(SRC, 'routes', 'preferences-routes.ts'), 'utf-8');
  const handlerOf = (marker: string) => {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `${marker} is still declared here`);
    const rest = src.slice(start + marker.length);
    return rest.slice(0, rest.indexOf('router.'));
  };
  assert.match(handlerOf("router.get('/config'"), /withoutSecrets\(getAllConfig\(\)\)/);
  assert.match(handlerOf("router.get('/settings'"), /settingsForClient\(/);
  assert.match(handlerOf("router.put('/settings'"), /isGuardedSettingKey\(key\)/);
});
