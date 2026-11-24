import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushServerSettingsDetailed, serializeSettingsSnapshot, MAX_SETTINGS_PAYLOAD_BYTES, type ServerSettingsBlob } from './settings-sync';

test('settings writes are serialized, snapshot immediately, and recover after a failed predecessor', async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
  const calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (_url, options) => {
    const theme = JSON.parse(String(options?.body)).settings.theme;
    calls.push(`${theme.id}:${theme.mode}`);
    if (calls.length === 1) { await blocked; throw new Error('Simulated network failure'); }
    return new Response('{}');
  };
  try {
    const first = pushServerSettingsDetailed({ theme: { mode: 'dark', id: 'magenta' } });
    const next: ServerSettingsBlob = { theme: { mode: 'dark', id: 'teal' } };
    const second = pushServerSettingsDetailed(next);
    next.theme!.mode = 'light';
    await Promise.resolve();
    assert.deepEqual(calls, ['magenta:dark'], 'newer PUT cannot overtake the old one');
    release();
    assert.equal((await first).ok, false);
    assert.equal((await second).ok, true);
    assert.deepEqual(calls, ['magenta:dark', 'teal:dark'], 'queued snapshots cannot be changed by later draft edits');
    await assert.rejects(async () => serializeSettingsSnapshot({ extras: { oversized: 'x'.repeat(MAX_SETTINGS_PAYLOAD_BYTES) } }), /10 MB/);
  } finally {
    release(); globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
