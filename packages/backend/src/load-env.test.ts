import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envFilesToLoad } from './load-env.js';

test('npm start from the backend workspace still reads the root .env', () => {
  const files = envFilesToLoad('/house/packages/backend', '/house', (p) => p === '/house/.env');
  assert.deepEqual(files, ['/house/.env']);
});

test('a workspace .env is read first, then the root one', () => {
  const files = envFilesToLoad('/house/packages/backend', '/house', () => true);
  assert.deepEqual(files, ['/house/packages/backend/.env', '/house/.env']);
});

test('started from the root (pm2), the root .env is read once', () => {
  const files = envFilesToLoad('/house', '/house', () => true);
  assert.deepEqual(files, ['/house/.env']);
});
