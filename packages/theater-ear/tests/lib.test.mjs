// The Ear's pure pieces, and its background worker against a stand-in
// Chrome and a stand-in house (no network). Run: node --test packages/theater-ear/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..');
const source = (name) => readFileSync(join(dir, name), 'utf8');

function loadLib() {
  const context = vm.createContext({ URL });
  vm.runInContext(source('lib.js'), context, { filename: 'lib.js' });
  return context.TheaterEarLib;
}

const lib = loadLib();
/** Values made inside the vm, as plain values here. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test('it listens only on Netflix and Hulu watch pages', () => {
  assert.equal(lib.siteFor('www.netflix.com', '/watch/80192098').id, 'netflix');
  assert.equal(lib.siteFor('www.hulu.com', '/watch/0a1b2c3d-aaaa-bbbb-cccc-0123456789ab').id, 'hulu');
  assert.equal(lib.siteFor('www.netflix.com', '/browse'), null);
  assert.equal(lib.siteFor('www.hulu.com', '/series/some-show'), null);
  assert.equal(lib.siteFor('evil.example', '/watch/1'), null);
  assert.ok(lib.SITES.find((s) => s.id === 'netflix').captions[0].includes('.player-timedtext-text-container'));
});

test('caption words are tidied the way the house keeps them', () => {
  assert.equal(lib.normaliseCaption('  Who left\n\n the   gate open?  '), 'Who left\nthe gate open?');
  assert.equal(lib.normaliseCaption(['- Not me.', '- Me neither. ']), '- Not me.\n- Me neither.');
  assert.equal(lib.normaliseCaption('a\r\nb'), 'a\nb');
  assert.equal(lib.normaliseCaption(''), '');
  assert.equal(lib.normaliseCaption('x'.repeat(2000)).length, 1000);
});

test('a line is finished when its words change or vanish, with its start and end', () => {
  const t = new lib.CaptionTracker({ maxOnScreen: 10 });
  assert.deepEqual(plain(t.see('', 1)), []);
  assert.deepEqual(plain(t.see('Hello.', 2)), []);
  assert.deepEqual(plain(t.see('Hello.', 2.5)), [], 'the same words again are the same line');
  assert.deepEqual(JSON.parse(JSON.stringify(t.see('Goodbye.', 4))), [{ text: 'Hello.', start: 2, end: 4 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(t.see('', 5.25))), [{ text: 'Goodbye.', start: 4, end: 5.25 }]);
  assert.deepEqual(plain(t.see('', 6)), []);
});

test('a long line is sent after ten seconds, once; a rewind drops the line being watched', () => {
  const t = new lib.CaptionTracker({ maxOnScreen: 10 });
  t.see('A very long sign.', 100);
  assert.deepEqual(plain(t.see('A very long sign.', 105)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(t.see('A very long sign.', 110))), [{ text: 'A very long sign.', start: 100, end: 110 }]);
  assert.deepEqual(plain(t.see('A very long sign.', 115)), [], 'never twice');
  assert.deepEqual(plain(t.see('', 116)), [], 'already sent');
  t.see('Before the rewind.', 200);
  assert.deepEqual(plain(t.see('Earlier.', 50)), [], 'time went backwards: no made-up end');
  assert.deepEqual(JSON.parse(JSON.stringify(t.see('', 52))), [{ text: 'Earlier.', start: 50, end: 52 }]);
  assert.deepEqual(plain(t.see('x', Number.NaN)), []);
});

test('repeats within two seconds are dropped; the same words later are kept', () => {
  const recent = [];
  const first = lib.dedupeLines([{ text: 'Not me.', start: 15, end: 16 }, { text: 'Not me.', start: 16.5, end: 17 }], recent, 2);
  assert.equal(first.length, 1);
  assert.equal(lib.dedupeLines([{ text: 'Not me.', start: 14, end: 15 }], recent, 2).length, 0, 'a rewatch after a small rewind');
  assert.equal(lib.dedupeLines([{ text: 'Not me.', start: 300, end: 301 }], recent, 2).length, 1);
  for (let i = 0; i < 150; i++) lib.dedupeLines([{ text: `l${i}`, start: i, end: i }], recent, 2);
  assert.equal(recent.length, 100);
});

test('batches: at most 50 at a time, failed ones go back first, stale ones are let go', () => {
  const b = new lib.Batcher({ max: 50, maxQueue: 300, maxAgeMs: 120000 });
  const lines = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ text: `line ${from + i}`, start: from + i, end: from + i + 1 }));
  b.add(lines(120), 0);
  const one = b.take(1000);
  assert.equal(one.length, 50);
  assert.equal(one[0].text, 'line 0');
  b.putBack(one, 2000);
  assert.equal(b.take(2000)[0].text, 'line 0', 'a failed batch goes out again first');
  assert.equal(b.size, 70);
  b.add(lines(400, 1000), 3000);
  assert.equal(b.size, 300, 'a long time offline keeps only the newest');
  assert.deepEqual(plain(b.take(3000 + 120001)), [], 'two minutes old: let go');
});

test('pairing codes, paths and probe candidates', () => {
  assert.equal(lib.pairingCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(lib.pairingCode(' ABCD EFGH '), 'ABCDEFGH');
  assert.equal(lib.pairingCode('ABCDEFG0'), null, 'no zero in the alphabet');
  assert.equal(lib.pairingCode('ABC'), null);
  assert.equal(lib.pathOnly('https://www.hulu.com/watch/abc?profile=1#x'), '/watch/abc');
  const c = lib.probeCandidate({ tag: 'DIV', className: 'CaptionBox', attributes: ['class', 'style'], text: '  Hi\n there ', changedSecondsAgo: 1.234, matchedSelector: '.CaptionBox' });
  assert.deepEqual(JSON.parse(JSON.stringify(c)), { tag: 'div', className: 'CaptionBox', attributes: ['class', 'style'], text: 'Hi\nthere', changedSecondsAgo: 1.2, matchedSelector: '.CaptionBox' });
});

test('the manifest: MV3, the three hosts, content scripts only on watch pages, no build step', () => {
  const m = JSON.parse(source('manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.host_permissions.sort(), ['https://www.hulu.com/*', 'https://www.netflix.com/*', 'https://your-house.example.com/*']);
  assert.deepEqual(m.content_scripts[0].matches.sort(), ['https://www.hulu.com/watch/*', 'https://www.netflix.com/watch/*']);
  assert.deepEqual(m.content_scripts[0].js, ['lib.js', 'content.js']);
  assert.equal(m.background.service_worker, 'background.js');
  assert.deepEqual(m.permissions.sort(), ['scripting', 'storage']);
  for (const file of ['background.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'README.md']) assert.ok(source(file).length > 0, file);
});

// ── the background worker, with a stand-in Chrome and house ────────────────

function loadBackground(houseAnswer) {
  const calls = [];
  const store = {};
  let onMessage = null;
  const timers = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
        },
        async set(values) { Object.assign(store, values); },
        async remove(keys) { for (const k of keys) delete store[k]; },
      },
    },
    runtime: { onMessage: { addListener(fn) { onMessage = fn; } } },
    tabs: { onUpdated: { addListener() {} }, async query() { return []; }, async sendMessage() { return null; } },
    scripting: { async executeScript() {} },
  };
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status, json } = houseAnswer(url, init);
    return { status, async json() { return json; } };
  };
  const context = vm.createContext({
    URL, console, chrome, fetch, Date,
    setTimeout(fn, ms) { timers.push(fn); return timers.length; },
    clearTimeout() {},
  });
  context.self = context;
  context.importScripts = (name) => vm.runInContext(source(name), context, { filename: name });
  vm.runInContext(source('background.js'), context, { filename: 'background.js' });
  const send = (message, fromPage = true) => new Promise((resolve) => {
    onMessage(message, fromPage ? { tab: { id: 1 } } : {}, resolve);
  });
  const runTimers = async () => {
    while (timers.length) { await timers.shift()(); await new Promise((r) => setTimeout(r, 10)); }
  };
  return { calls, store, send, runTimers };
}

test('the worker pairs, sends only while a computer night is live, with the token and never cookies', async () => {
  let live = false;
  const bg = loadBackground((url, init) => {
    if (url.endsWith('/claim')) return { status: 201, json: { token: 'tok-'.padEnd(43, 'x') } };
    if (url.endsWith('/status')) return { status: 200, json: { live, night: live ? { id: 'n1', title: 'Harbor' } : null } };
    if (url.endsWith('/lines')) return { status: 200, json: { added: JSON.parse(init.body).lines.length } };
    if (url.endsWith('/clock')) return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  // Not paired: nothing goes out.
  await bg.send({ type: 'ear-lines', lines: [{ text: 'Hi.', start: 1, end: 2 }] });
  assert.equal(bg.calls.length, 0);

  assert.equal((await bg.send({ type: 'connect', code: 'nope' }, false)).ok, false);
  const paired = await bg.send({ type: 'connect', code: 'abcd-efgh' }, false);
  assert.equal(paired.ok, true);
  assert.deepEqual(bg.calls[0].body, { code: 'ABCDEFGH' });
  assert.equal(bg.calls[0].init.headers.authorization, undefined, 'the claim carries no token');
  assert.ok(bg.store.token);

  // Paired, but no computer night: lines are dropped, the clock stays home.
  await bg.send({ type: 'ear-lines', lines: [{ text: 'Dropped.', start: 1, end: 2 }] });
  await bg.send({ type: 'ear-clock', position: 5, paused: false });
  await bg.runTimers();
  assert.equal(bg.calls.filter((c) => c.url.endsWith('/lines') || c.url.endsWith('/clock')).length, 0);

  // A night goes live: lines (deduped) and the clock go to it.
  live = true;
  await bg.send({ type: 'connect', code: 'ABCDEFGH' }, false);
  await bg.send({ type: 'ear-lines', lines: [{ text: 'Who left the gate open?', start: 12, end: 14 }, { text: 'Who left the gate open?', start: 12.5, end: 14 }] });
  await bg.send({ type: 'ear-clock', position: 15, paused: false, duration: 2700 });
  await bg.runTimers();
  const lines = bg.calls.filter((c) => c.url.endsWith('/lines'));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].body.lines.map((l) => l.text), ['Who left the gate open?']);
  assert.equal(lines[0].body.nightId, 'n1');
  const clock = bg.calls.find((c) => c.url.endsWith('/clock'));
  assert.deepEqual(clock.body, { nightId: 'n1', position: 15, paused: false, duration: 2700 });
  for (const c of bg.calls) {
    assert.ok(c.url.startsWith('https://your-house.example.com/api/theater-ear/'), c.url);
    assert.equal(c.init.credentials, 'omit', 'never cookies');
    if (!c.url.endsWith('/claim')) assert.match(c.init.headers.authorization, /^Bearer tok-/);
  }
  assert.equal(bg.store.lastLine, 'Who left the gate open?');

  // A message from the popup cannot pose as the page, and the page cannot pair.
  assert.equal(await bg.send({ type: 'connect', code: 'ABCDEFGH' }, true), null);

  const state = await bg.send({ type: 'popup-state' }, false);
  assert.equal(state.connected, true);
  assert.equal(state.live, true);
  assert.equal(state.title, 'Harbor');

  await bg.send({ type: 'disconnect' }, false);
  assert.equal(bg.store.token, undefined);
  assert.equal((await bg.send({ type: 'popup-state' }, false)).connected, false);
});

test('offline: lines are held and go out when the house is back', async () => {
  let up = false;
  const bg = loadBackground((url) => {
    if (url.endsWith('/claim')) return { status: 201, json: { token: 'tok-'.padEnd(43, 'y') } };
    if (!up) throw new TypeError('Failed to fetch');
    if (url.endsWith('/status')) return { status: 200, json: { live: true, night: { id: 'n2', title: 'Harbor' } } };
    return { status: 200, json: { added: 1 } };
  });
  await bg.send({ type: 'connect', code: 'ABCDEFGH' }, false);
  await bg.send({ type: 'ear-lines', lines: [{ text: 'Held.', start: 3, end: 4 }] });
  up = true;
  await bg.runTimers();
  const sent = bg.calls.filter((c) => c.url.endsWith('/lines'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.lines[0].text, 'Held.');
});
