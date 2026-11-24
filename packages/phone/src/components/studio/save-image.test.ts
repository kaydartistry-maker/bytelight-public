import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioFileSaver, downloadStudioFile, type StudioSaveDependencies } from './save-image';

function harness(overrides: Partial<StudioSaveDependencies> = {}) {
  const fetched: Array<{ url: string; init: RequestInit }> = [], shared: ShareData[] = [], downloads: File[] = [];
  const saver = createStudioFileSaver({
    baseUrl: 'https://virelle.test/studio',
    fetchFile: async (url, init) => { fetched.push({ url, init }); return new Response(new Blob(['picture'], { type: 'image/png' })); },
    canShare: () => true,
    share: async data => { shared.push(data); },
    hasActivation: () => true,
    download: file => { downloads.push(file); },
    ...overrides,
  });
  return { saver, fetched, shared, downloads };
}

test('warm file sharing runs during the tap, uses authenticated fetch and shares the actual image', async () => {
  const h = harness();
  await h.saver.prepare('/api/image-gen/gallery/picture.png');
  const saving = h.saver.save('/api/image-gen/gallery/picture.png', 'studio-0001.png');
  assert.equal(h.shared.length, 1, 'share must be called before the first await on a warm cache');
  assert.equal(await saving, 'shared');
  assert.equal(h.fetched.length, 1);
  assert.equal(h.fetched[0].init.credentials, 'include');
  assert.equal(h.shared[0].files?.[0].name, 'studio-0001.png');
  assert.equal(h.shared[0].files?.[0].type, 'image/png');
  assert.equal(h.downloads.length, 0);
  h.saver.clear();
});

test('cold iOS save retains its file and asks for a fresh tap after activation expires', async () => {
  let active = false;
  const h = harness({ hasActivation: () => active });
  assert.equal(await h.saver.save('/image.png', 'studio.png'), 'ready');
  assert.equal(h.shared.length, 0);
  assert.equal(h.downloads.length, 0);
  active = true;
  assert.equal(await h.saver.save('/image.png', 'studio.png'), 'shared');
  assert.equal(h.fetched.length, 1);
  h.saver.clear();
});

test('Safari NotAllowedError preserves the file instead of opening another screen', async () => {
  let attempts = 0;
  const h = harness({ share: async () => { if (++attempts === 1) throw new DOMException('Needs a tap', 'NotAllowedError'); } });
  assert.equal(await h.saver.save('/image.png', 'studio.png'), 'ready');
  assert.equal(await h.saver.save('/image.png', 'studio.png'), 'shared');
  assert.equal(h.fetched.length, 1);
  assert.equal(h.downloads.length, 0);
  h.saver.clear();
});

test('cancelling the share sheet is silent and never falls through into a download', async () => {
  const h = harness({ share: async () => { throw new DOMException('Cancelled', 'AbortError'); } });
  assert.equal(await h.saver.save('/image.png', 'studio.png'), 'cancelled');
  assert.equal(h.downloads.length, 0);
  h.saver.clear();
});

test('a permission denial on a fresh warm-cache tap is reported instead of asking forever', async () => {
  const h = harness({ share: async () => { throw new DOMException('Blocked', 'NotAllowedError'); } });
  await h.saver.prepare('/image.png');
  await assert.rejects(h.saver.save('/image.png', 'studio.png'), /device blocked file sharing/);
  assert.equal(h.downloads.length, 0);
  h.saver.clear();
});

test('unsupported file sharing downloads a blob with the real MIME extension', async () => {
  const h = harness({ canShare: () => false, fetchFile: async () => new Response(new Blob(['jpeg'], { type: 'image/jpeg' })) });
  assert.equal(await h.saver.save('/image.jpg', 'studio-0002.png'), 'downloaded');
  assert.equal(h.downloads[0].name, 'studio-0002.jpg');
  assert.equal(h.downloads[0].type, 'image/jpeg');
  assert.equal(h.shared.length, 0);
  h.saver.clear();
});

test('native shells use file sharing, never browser anchors', async () => {
  const files: File[] = [];
  const h = harness({ nativeShare: async file => { files.push(file); } });
  assert.equal(await h.saver.save('/image.png', 'studio.png'), 'shared');
  assert.equal(files[0].type, 'image/png');
  assert.equal(h.shared.length + h.downloads.length, 0);
  h.saver.clear();
});

test('fetch errors, unsupported login pages and non-cancellation share errors remain visible', async () => {
  for (const fetchFile of [
    async () => new Response('not signed in', { status: 401 }),
    async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('too large', { headers: { 'content-type': 'image/png', 'content-length': String(65 * 1024 * 1024) } }),
  ]) {
    const h = harness({ fetchFile });
    await assert.rejects(h.saver.save('/image.png', 'studio.png'));
    assert.equal(h.shared.length + h.downloads.length, 0);
    h.saver.clear();
  }
  const h = harness({ share: async () => { throw new Error('File sharing failed'); } });
  await assert.rejects(h.saver.save('/image.png', 'studio.png'), /File sharing failed/);
  assert.equal(h.downloads.length, 0);
  h.saver.clear();
});

test('cache holds at most three files and cleanup drops private blobs', async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) await h.saver.prepare(`/image-${i}.png`);
  await h.saver.prepare('/image-0.png');
  assert.equal(h.fetched.length, 5);
  h.saver.clear();
  await h.saver.prepare('/image-0.png');
  assert.equal(h.fetched.length, 6);
  h.saver.clear();
});

test('foreign URLs are rejected without sending credentials or navigating', async () => {
  const h = harness();
  await assert.rejects(h.saver.save('https://external.test/private.png', 'studio.png'), /Only images saved/);
  assert.equal(h.fetched.length + h.shared.length + h.downloads.length, 0);
});

test('unmount cleanup aborts preparation and cannot open a late share sheet', async () => {
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  const h = harness({ fetchFile: async (_url, init) => { signal = init.signal as AbortSignal; return new Promise(resolve => { finish = resolve; }); } });
  const saving = h.saver.save('/image.png', 'studio.png');
  h.saver.clear();
  assert.equal(signal?.aborted, true);
  finish(new Response(new Blob(['picture'], { type: 'image/png' })));
  await assert.rejects(saving, /cancelled/);
  assert.equal(h.shared.length + h.downloads.length, 0);
});

test('prefetch concurrency is bounded and failed requests do not enter the cache', async () => {
  const pending: Array<(response: Response) => void> = [];
  const h = harness({ fetchFile: async () => new Promise(resolve => { pending.push(resolve); }) });
  const reads = [0, 1, 2].map(i => h.saver.prepare(`/image-${i}.png`));
  await assert.rejects(h.saver.prepare('/image-3.png'), /Please wait/);
  assert.equal(pending.length, 3);
  h.saver.clear();
  pending.forEach(resolve => resolve(new Response(new Blob(['picture'], { type: 'image/png' }))));
  const results = await Promise.allSettled(reads);
  assert.ok(results.every(r => r.status === 'rejected'));
});

test('direct download targets only a blob and revokes it after the save starts', () => {
  const actions: string[] = [], callbacks: Array<() => void> = [];
  const anchor = { href: '', download: '', click() { actions.push(`click:${this.href}:${this.download}`); }, remove() { actions.push('remove'); } };
  const documentObject = { createElement: () => anchor, body: { appendChild() { actions.push('append'); } } } as unknown as Document;
  const urls = { createObjectURL: () => 'blob:local-image', revokeObjectURL: (url: string) => { actions.push(`revoke:${url}`); } };
  downloadStudioFile(new File(['image'], 'studio.png', { type: 'image/png' }), documentObject, urls, fn => { callbacks.push(fn); });
  assert.deepEqual(actions, ['append', 'click:blob:local-image:studio.png', 'remove']);
  callbacks[0]();
  assert.equal(actions.at(-1), 'revoke:blob:local-image');
});
