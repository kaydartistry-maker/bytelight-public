import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takePairingToken } from './pairing';
import { readFileSync } from 'node:fs';
test('fragment scrub preserves path, never copies token to query; invalid token discarded', () => {
  let replaced = '';
  const history = { replaceState(_a: unknown, _b: string, url: string | URL | null) { replaced = String(url); } };
  const token = 'ab'.repeat(32);
  assert.equal(takePairingToken({ pathname: '/pair', search: '', hash: '#token=' + token }, history), token);
  assert.equal(replaced, '/pair'); assert.ok(!replaced.includes(token));
  assert.equal(takePairingToken({ pathname: '/pair', search: '', hash: '#token=invalid' }, history), null);
  const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
  assert.ok(main.startsWith("import { pairingPage, takeInitialPairingToken }"));
  const view = readFileSync(new URL('../components/PairDevice.tsx', import.meta.url), 'utf8');
  assert.match(view, /Pair This Device/); assert.doesNotMatch(view, /useEffect|localStorage|sessionStorage|console\./);
});
