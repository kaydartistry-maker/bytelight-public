// Saving a picture from chat asks the house for the file with ?download=1.
// A WebView, and a browser link with no download attribute, decide what to do
// from the response, so without Content-Disposition: attachment the picture is
// shown in place and nothing is saved. These pin the house half of that.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

const { saveFile, deleteFile } = await import('../services/files.js');
const { createFilesRoutes } = await import('./files-routes.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000050001', 'hex');

async function withServer(fn: (base: string, fileId: string) => Promise<void>): Promise<void> {
  const { fileId } = saveFile(PNG, 'pic.png', 'image/png');
  const app = express();
  app.use(createFilesRoutes());
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, fileId);
  } finally {
    server.close();
    deleteFile(fileId);
  }
}

test('a plain request still shows the file in place', async () => {
  await withServer(async (base, id) => {
    const res = await fetch(`${base}/files/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-disposition'), null);
  });
});

test('?download=1 hands the file back as an attachment', async () => {
  await withServer(async (base, id) => {
    const res = await fetch(`${base}/files/${id}?download=1`);
    assert.equal(res.status, 200);
    const cd = res.headers.get('content-disposition') ?? '';
    assert.match(cd, /^attachment;/);
    assert.match(cd, new RegExp(`filename="${id}\\.png"`));
  });
});

test('a requested name is used, and cannot break out of the header', async () => {
  await withServer(async (base, id) => {
    const res = await fetch(`${base}/files/${id}?download=1&name=${encodeURIComponent('../"evil"\\\r\nX-Bad: 1.png')}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-bad'), null);
    const cd = res.headers.get('content-disposition') ?? '';
    assert.match(cd, /^attachment; filename="[^"\\/]*"; filename\*=UTF-8''/);
  });
});
