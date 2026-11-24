# ByteLight Book Bridge — BOOX / KOReader physical-test build

This plugin sends short, outbound-only HTTPS page updates to ByteLight. It has
no listener, permanent socket, server login, or remote calls into ReaderUI.
Failed page updates stay in a small local queue and retry on a later page.
HTTPS certificate verification remains enabled with the bundled public ISRG
Root X2 certificate used directly by the ByteLight server's modern ECDSA
Let's Encrypt chain. This avoids relying on older BOOX TLS libraries to build
the longer X2-to-X1 cross-signed compatibility path.

## Install

1. Remove the retired Virelle Book Bridge plugin from KOReader's `plugins` folder.
2. Copy `bytelight-book-bridge.koplugin` into KOReader's `plugins` folder.
   In KOReader's Tools → More tools → Plugin management → User plugins,
   confirm ByteLight Book Bridge is checked.
3. Restart **KOReader only**, open a book, then open KOReader's menu → Tools →
   ByteLight Book Bridge → Pair this BOOX.
4. In ByteLight, open Library → BOOX → Pair my BOOX. Enter its server address
   and one-time code on the BOOX.

The token remains in KOReader's private settings, so normal reading reconnects
automatically. ByteLight's Library must contain the same owned EPUB; the first
page matches it by title and remembers its Library id.

## Modes

ByteLight controls the mode per book:

- **Read Beside Me**: companions can read only through the current bookmark.
- **One Chapter Ahead**: the server opens exactly the next chapter. Notes from
  it remain sealed in ByteLight and on the BOOX until their exact anchor words
  appear on the visible page.

## Physical gate

This is deliberately labelled a physical-test build until it passes on the
owner's BOOX Go 7 and installed KOReader version. TLS fails closed: the server
must be HTTPS and Android's system CA store must validate it. No insecure HTTP
fallback is included.
