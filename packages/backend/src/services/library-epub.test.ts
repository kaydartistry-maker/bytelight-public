import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { parseEpub, xhtmlToText, resolvePath, EpubError } from './library-epub.js';
import { shelveUpload, readShelf, readBook, removeBook, UPLOAD_ID_BASE, coverColor, fillSpineColors } from './library.js';
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';

const long = (s: string) => `${s} `.repeat(40).trim();
const page = (body: string) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title><style>p{}</style></head><body>${body}</body></html>`;
const CONTAINER = '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

function epub3(extra: Record<string, Uint8Array> = {}): Uint8Array {
  const opf = `<?xml version="1.0"?><package><metadata>
    <dc:title>The Salt &amp; the Sea</dc:title><dc:creator>Ana Lima</dc:creator><dc:creator>Rui Costa</dc:creator>
  </metadata><manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="title" href="text/title.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/two%20b.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="text/toc.xhtml" media-type="application/xhtml+xml"/>
  </manifest><spine><itemref idref="title"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="toc"/></spine></package>`;
  const nav = page(`<nav epub:type="toc"><ol><li><a href="text/one.xhtml#start">One: The Harbour</a></li><li><a href="text/two%20b.xhtml">Two: Ashore</a></li><li><a href="text/toc.xhtml">Contents</a></li></ol></nav>`);
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(CONTAINER),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/images/cover.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    'OEBPS/text/title.xhtml': strToU8(page('<h1>The Salt &amp; the Sea</h1><p>a novel</p>')),
    'OEBPS/text/one.xhtml': strToU8(page(`<h2>I</h2><p>${long('The boats came in at dusk.')}</p><p>She said&nbsp;“stay.”<br/>He stayed.</p>`)),
    'OEBPS/text/two b.xhtml': strToU8(page(`<p>${long('Morning, and the gulls.')}</p>`)),
    'OEBPS/text/toc.xhtml': strToU8(page('<p>One: The Harbour</p><p>Two: Ashore</p>')),
    ...extra,
  });
}

describe('library EPUB reader', () => {
  it('reads title, authors, chapters named by the contents, and the cover; front matter rides into chapter one', () => {
    const book = parseEpub(epub3());
    assert.equal(book.title, 'The Salt & the Sea');
    assert.deepEqual(book.authors, ['Ana Lima', 'Rui Costa']);
    assert.deepEqual(book.chapters.map((c) => c.title), ['One: The Harbour', 'Two: Ashore']);
    assert.match(book.chapters[0].text, /^The Salt & the Sea\n\na novel\n\nI\n\nThe boats came in/);
    assert.match(book.chapters[0].text, /She said “stay\.”\nHe stayed\./);
    assert.equal(book.cover?.ext, 'jpg');
    assert.equal(book.cover?.data[0], 0xff);
  });

  it('falls back to the EPUB2 NCX for chapter names, then to headings', () => {
    const opf = `<package><metadata><dc:title>Old Style</dc:title></metadata><manifest>
      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
      <item id="a" href="a.html" media-type="application/xhtml+xml"/>
      <item id="b" href="b.html" media-type="application/xhtml+xml"/>
    </manifest><spine toc="ncx"><itemref idref="a"/><itemref idref="b"/></spine></package>`;
    const ncx = `<ncx><navMap><navPoint id="n1"><navLabel><text>Chapter the First</text></navLabel><content src="a.html"/></navPoint></navMap></ncx>`;
    const book = parseEpub(zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/toc.ncx': strToU8(ncx),
      'OEBPS/a.html': strToU8(page(`<p>${long('First.')}</p>`)),
      'OEBPS/b.html': strToU8(page(`<h1>Second Heading</h1><p>${long('Second.')}</p><p>${long('And on it went.')}</p>`)),
    }));
    assert.deepEqual(book.chapters.map((c) => c.title), ['Chapter the First', 'Second Heading']);
    assert.equal(book.authors.length, 0);
    assert.equal(book.cover, null);
  });

  it('refuses a non-EPUB and a DRM-locked book, but not one with only obfuscated fonts', () => {
    assert.throws(() => parseEpub(new TextEncoder().encode('%PDF-1.7 hello')), EpubError);
    const drm = '<encryption><EncryptedData><CipherData><CipherReference URI="OEBPS/text/one.xhtml"/></CipherData></EncryptedData></encryption>';
    assert.throws(() => parseEpub(epub3({ 'META-INF/encryption.xml': strToU8(drm) })), /DRM/);
    const fonts = '<encryption><EncryptedData><CipherData><CipherReference URI="OEBPS/fonts/a.otf"/></CipherData></EncryptedData></encryption>';
    assert.equal(parseEpub(epub3({ 'META-INF/encryption.xml': strToU8(fonts) })).chapters.length, 2);
  });

  it('turns XHTML into blank-line paragraphs and resolves relative paths', () => {
    assert.deepEqual(xhtmlToText(page('<div><p>a &amp; b</p><p>  c  </p></div><script>x()</script>')), { text: 'a & b\n\nc', heading: null });
    assert.equal(resolvePath('OEBPS/text/one.xhtml', '../images/c%201.jpg#x'), 'OEBPS/images/c 1.jpg');
  });

  it('shelves an upload on To Be Read with its own id range, a served cover, and cleans the cover on removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      const a = shelveUpload(epub3(), root);
      const b = shelveUpload(epub3(), root);
      assert.equal(a.id, UPLOAD_ID_BASE + 1);
      assert.equal(b.id, UPLOAD_ID_BASE + 2);
      assert.equal(a.shelf, 'tbr');
      assert.equal(a.cover, `/api/library/covers/${a.id}.jpg`);
      assert.equal(readBook(a.id, root)?.source, 'upload');
      assert.equal(readShelf(root).length, 2);
      assert.equal(removeBook(a.id, root), true);
      assert.equal(existsSync(join(root, 'covers', `${a.id}.jpg`)), false);
      assert.deepEqual(readdirSync(join(root, 'covers')), [`${b.id}.jpg`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('spine colors from covers', () => {
  it('reads a cover\'s color and colors the spines of shelved books, once', async () => {
    const red = new Uint8Array(await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 200, g: 30, b: 40 } } }).png().toBuffer());
    const color = await coverColor(red);
    assert.match(color ?? '', /^#[0-9a-f]{6}$/);
    assert.ok(parseInt(color!.slice(1, 3), 16) > 150, `red stays red: ${color}`);
    assert.equal(await coverColor(new Uint8Array([1, 2, 3])), null);

    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      const book = shelveUpload(epub3(), root);
      mkdirSync(join(root, 'covers'), { recursive: true });
      writeFileSync(join(root, 'covers', `${book.id}.jpg`), red);
      const noFetch = async () => { throw new Error('no network in tests'); };
      assert.equal(await fillSpineColors(root, noFetch as never), 1);
      assert.match(readShelf(root)[0].spineColor ?? '', /^#[0-9a-f]{6}$/);
      assert.equal(await fillSpineColors(root, noFetch as never), 0, 'a colored book is not read again');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
