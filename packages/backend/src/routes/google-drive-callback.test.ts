import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const route = readFileSync(new URL('./google-drive.ts', import.meta.url), 'utf8');

test('Google OAuth callback is mounted before the cookie auth boundary', () => {
  const callback = api.indexOf('router.use(googleDriveCallbackRouter)');
  const auth = api.indexOf('router.use(authMiddleware)');
  assert.ok(callback >= 0, 'callback router must be mounted');
  assert.ok(auth >= 0, 'auth boundary must be present');
  assert.ok(callback < auth, 'callback must run before cookie auth');
});

test('only the callback is public; account controls stay on the protected router', () => {
  assert.match(route, /googleDriveCallbackRouter\.get\('\/auth\/google-drive\/callback'/);
  assert.match(route, /router\.post\('\/integrations\/google-drive\/login'/);
  assert.doesNotMatch(route, /googleDriveCallbackRouter\.post\('\/integrations/);
});
