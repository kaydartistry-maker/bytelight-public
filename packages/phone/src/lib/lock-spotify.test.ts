// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The lock screen's Spotify card: its switch, when it reads, what it shows, how
// it presses (the Spotify app's own keeper), and where it sits, with the house
// replaced by a fake and the clock by a hand-wound one. Nothing here reaches a
// real house or a real Spotify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpotifyNowView } from '@bytelight/shared';
import { SONG_END_SLACK_MS, createLockSpotify, liftLockCard, lockSpotifyOf, lockSpotifyTrack, songEndsInMs } from './lock-spotify';
import { LockSpotifyCardView } from '../components/LockSpotifyCard';
import type { PressState } from '../components/spotify/SpotifyViews';

const SONG = 'spotify:track:463ahmflVo5cjEewhhbgAJ';
const NEXT = 'spotify:track:5googFqOqpopYdcvV22T3t';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const page = () => new Response('<!doctype html><html><body><div id="root"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const playing = (uri = SONG, extra: Partial<SpotifyNowView> = {}): SpotifyNowView =>
  ({ playing: true, track: { name: 'Beauty', artist: 'Layto', uri, cover: 'https://i.scdn.co/image/beauty', album: null }, ...extra });

/** A fake house: reads answer from the list in turn, presses with `press`; every ask is kept. */
function house(reads: Array<() => Response | Promise<Response>>, press: () => Response = () => json({ ok: true })) {
  const asked: string[] = [];
  let n = 0;
  const fetcher = async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST') return press();
    const answer = reads[Math.min(n, reads.length - 1)];
    n += 1;
    return answer();
  };
  return { asked, fetcher, reads: () => asked.filter((a) => a.startsWith('GET ')).length };
}

/** A hand-wound clock: a wait sits until the test runs it. */
function windup() {
  const timers = new Map<number, { run: () => void; ms: number }>();
  let id = 0;
  let hidden = false;
  return {
    timers,
    waits: () => [...timers.values()].map((t) => t.ms),
    sleep(on: boolean) { hidden = on; },
    fire() { const due = [...timers.values()]; timers.clear(); for (const t of due) t.run(); },
    hands: {
      setTimeout: (run: () => void, ms: number) => { timers.set(++id, { run, ms }); return id; },
      clearTimeout: (handle: unknown) => { timers.delete(handle as number); },
      hidden: () => hidden,
      wait: async () => {},
    },
  };
}

async function until(done: () => boolean, what: string) {
  for (let n = 0; n < 200 && !done(); n++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(done(), `waited for: ${what}`);
}

test('the switch: on unless the owner turned it off', () => {
  assert.equal(lockSpotifyOf(undefined), true, 'unset is on');
  assert.equal(lockSpotifyOf(true), true, 'on is on');
  assert.equal(lockSpotifyOf(false), false, 'the owner switch turns it off');
  assert.equal(lockSpotifyOf('off'), true, 'nothing but the owner switch turns it off');
});

test("a card only for a song playing or paused, in the house's own answer", async () => {
  const cases: Array<{ answer: () => Response; card: boolean; what: string }> = [
    { answer: () => json(playing()), card: true, what: 'playing' },
    { answer: () => json({ ...playing(), playing: false }), card: true, what: 'paused' },
    { answer: () => json({ playing: false, track: null }), card: false, what: 'nothing playing' },
    { answer: () => json({ playing: true, track: null }), card: false, what: 'playing, but Spotify did not say what' },
    { answer: page, card: false, what: "an old house's own page" },
    { answer: () => json({ something: 'else' }), card: false, what: 'JSON that is not the answer' },
    { answer: () => json({ error: 'Lapsed.', reason: 'signin' }, 502), card: false, what: 'a lapsed sign-in' },
    { answer: () => { throw new TypeError('Failed to fetch'); }, card: false, what: 'no house at all' },
  ];
  for (const { answer, card, what } of cases) {
    const fake = house([answer]);
    const lock = createLockSpotify(fake.fetcher, windup().hands);
    await lock.start();
    assert.equal(lockSpotifyTrack(lock.keeper.state()) !== null, card, `${what}: ${card ? 'a card' : 'no card'}`);
  }
});

test('it reads when the lock screen shows and when the phone wakes, and nothing else runs', async () => {
  const fake = house([() => json(playing())]);
  const wound = windup();
  const lock = createLockSpotify(fake.fetcher, wound.hands);
  await lock.look();
  assert.equal(fake.reads(), 0, 'nothing reads before the lock screen shows');
  await lock.start();
  assert.equal(fake.reads(), 1, 'one read when it shows');
  assert.equal(wound.timers.size, 0, 'without the song numbers nothing waits');
  await lock.look();
  assert.equal(fake.reads(), 2, 'one more when the phone wakes');
  assert.deepEqual(fake.asked, ['GET /api/spotify/now', 'GET /api/spotify/now'], 'only what is playing is read');
});

test('once more when the song should end, and the wait goes with the lock screen', async () => {
  const fake = house([
    () => json(playing(SONG, { progressMs: 60_000, durationMs: 200_000 })),
    () => json(playing(NEXT, { progressMs: 1_000, durationMs: 180_000 })),
  ]);
  const wound = windup();
  const lock = createLockSpotify(fake.fetcher, wound.hands);
  await lock.start();
  assert.deepEqual(wound.waits(), [140_000 + SONG_END_SLACK_MS], 'one wait, until a moment after the song ends');
  wound.fire();
  await until(() => fake.reads() === 2 && wound.timers.size === 1, 'the read at the song end, and the next song its own wait');
  assert.deepEqual(wound.waits(), [179_000 + SONG_END_SLACK_MS], "the next song's wait, in place of the last");
  lock.stop();
  assert.equal(wound.timers.size, 0, 'the lock screen going away cancels the wait');
});

test('a paused song waits for nothing, an asleep phone leaves it to the wake, and a read landing after the lock screen went sets no wait', async () => {
  const paused = house([() => json({ ...playing(SONG, { progressMs: 1_000, durationMs: 200_000 }), playing: false })]);
  const a = windup();
  await createLockSpotify(paused.fetcher, a.hands).start();
  assert.equal(a.timers.size, 0, 'paused: the song is not going to end');

  const asleep = house([() => json(playing(SONG, { progressMs: 1_000, durationMs: 200_000 }))]);
  const b = windup();
  await createLockSpotify(asleep.fetcher, b.hands).start();
  b.sleep(true);
  b.fire();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asleep.reads(), 1, 'due while the phone sleeps: no read, the wake reads instead');

  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const late = house([async () => { await gate; return json(playing(SONG, { progressMs: 1_000, durationMs: 200_000 })); }]);
  const c = windup();
  const lock = createLockSpotify(late.fetcher, c.hands);
  const reading = lock.start();
  lock.stop();
  release();
  await reading;
  assert.equal(c.timers.size, 0, 'the lock screen went while it read: no wait');
});

test("a press is the Spotify app's press: one at a time, the one look after it, and a sentence only when that look disagrees", async () => {
  const fake = house([() => json(playing()), () => json(playing(NEXT))]);
  const lock = createLockSpotify(fake.fetcher, windup().hands);
  await lock.start();
  const first = lock.keeper.press({ kind: 'next' }, 'now:next');
  assert.equal(lock.keeper.state().pressing, 'now:next', 'every button waits while it is out');
  await lock.keeper.press({ kind: 'previous' }, 'now:previous');
  await first;
  assert.deepEqual(fake.asked, ['GET /api/spotify/now', 'POST /api/spotify/skip', 'GET /api/spotify/now'], 'one press, the look after it, and nothing pressed while it was out');
  assert.equal(lockSpotifyTrack(lock.keeper.state())?.track?.uri, NEXT, 'the look after it is shown');
  assert.equal(lock.keeper.state().notice, null, 'a press that worked says nothing');

  const NOWHERE = 'Open Spotify on your phone first, then try again.';
  const refused = house([() => json(playing())], () => json({ error: NOWHERE, reason: 'device' }, 409));
  const stuck = createLockSpotify(refused.fetcher, windup().hands);
  await stuck.start();
  await stuck.keeper.press({ kind: 'pause' }, 'now:pause');
  assert.deepEqual(stuck.keeper.state().notice, { where: 'now:pause', trouble: { kind: 'problem', message: NOWHERE, device: true } }, 'refused, and still playing: its sentence');
});

test('where the card sits: on top of the other cards, climbing past the clock and the weather, out of sight when nothing has room', () => {
  const card = { top: 600, bottom: 670 };
  assert.equal(liftLockCard(card, [{ top: 24, bottom: 120 }], 8), 0, 'a clock at the top leaves it on top of the other cards');
  assert.equal(liftLockCard(card, [{ top: 690, bottom: 750 }], 8), 0, 'a clock under the cards (the dateline face) is theirs to sit on');
  assert.equal(liftLockCard(card, [{ top: 560, bottom: 650 }], 8), 670 - (560 - 12), 'a clock set low: it climbs above it, a gap clear');
  assert.equal(liftLockCard(card, [{ top: 560, bottom: 650 }, { top: 500, bottom: 530 }], 8), 670 - (500 - 12), 'and past the weather above that');
  assert.equal(liftLockCard(card, [{ top: 300, bottom: 595 }], 8), 670 - (300 - 12), 'closer than the gap is touching');
  assert.equal(liftLockCard({ top: 420, bottom: 490 }, [{ top: 56, bottom: 470 }], 8), null, 'a big clock and no room above it: out of sight, never over the clock');
});

test('the song end is read off its progress and length, and only believed when it makes sense', () => {
  assert.equal(songEndsInMs(playing(SONG, { progressMs: 30_000, durationMs: 90_000 })), 60_000 + SONG_END_SLACK_MS, 'the rest of the song, and a moment');
  assert.equal(songEndsInMs(playing(SONG, { progressMs: 95_000, durationMs: 90_000 })), SONG_END_SLACK_MS, 'already past its end: look in a moment');
  assert.equal(songEndsInMs({ ...playing(SONG, { progressMs: 1, durationMs: 90_000 }), playing: false }), null, 'paused');
  assert.equal(songEndsInMs(playing()), null, 'no numbers from the house (none yet)');
  assert.equal(songEndsInMs(playing(SONG, { progressMs: null, durationMs: 90_000 })), null, 'half the numbers');
  assert.equal(songEndsInMs(playing(SONG, { progressMs: Number.NaN, durationMs: 90_000 })), null, 'not a number');
  assert.equal(songEndsInMs(playing(SONG, { progressMs: 0, durationMs: 0 })), null, 'no length');
  assert.equal(songEndsInMs(playing(SONG, { progressMs: 0, durationMs: 5 * 60 * 60 * 1000 })), null, 'longer than any song');
});

const ready: PressState = { pressing: null, notice: null, onPress: () => {} };
const draw = (view: SpotifyNowView, press: PressState = ready, onOpen: (() => void) | undefined = () => {}) =>
  renderToStaticMarkup(createElement(LockSpotifyCardView, { view, press, onOpen }));
const count = (html: string, words: string) => html.split(words).length - 1;

test('drawn: the cover, the song and the artist, and previous, pause and next a thumb wide', () => {
  const html = draw(playing());
  assert.match(html, /<img[^>]*src="https:\/\/i\.scdn\.co\/image\/beauty"/, 'the cover');
  assert.match(html, /<img[^>]*referrerpolicy="no-referrer"/i, 'which goes without the owner address');
  assert.match(html, />Beauty</, 'the song');
  assert.match(html, />Layto</, 'the artist');
  for (const label of ['Previous song', 'Pause', 'Next song']) {
    assert.match(html, new RegExp(`<button[^>]*aria-label="${label}"[^>]*class="[^"]*h-11 w-11`), `${label}, a thumb wide`);
  }
  assert.doesNotMatch(html, /aria-label="Play"/, 'playing, the middle one pauses');
  assert.match(html, /aria-label="Pause"[^>]*style="background:var\(--bytelight-selected-fill, var\(--bytelight-accent\)\);color:var\(--bytelight-on-accent\)"/, 'in the selected fill, like the app');
  assert.match(html, /<button[^>]*aria-label="Open Spotify: Beauty, Layto"/, 'the cover and the words are one tap that opens Spotify');
  assert.doesNotMatch(html, /role="status"/, 'and no other words');
  assert.match(draw({ ...playing(), playing: false }), /<button[^>]*aria-label="Play"/, 'paused, the middle one plays');
  assert.doesNotMatch(renderToStaticMarkup(createElement(LockSpotifyCardView, { view: playing(), press: ready })), /aria-label="Open Spotify/, 'with no way to open an app, the tap does nothing');
});

test('drawn while a press is out, and with its sentence', () => {
  const out = draw(playing(), { ...ready, pressing: 'now:next' });
  const buttons = (out.match(/<button\b[^>]*aria-label="(?:Previous song|Pause|Next song)"[^>]*>/g) ?? []);
  assert.equal(buttons.length, 3, `three press buttons: ${buttons.join(' ')}`);
  assert.ok(buttons.every((tag) => /\bdisabled=""/.test(tag)), `every one waits: ${buttons.join(' ')}`);
  assert.equal(count(out, 'animate-spin'), 1, 'only the pressed one turns');
  const said = draw(playing(), { ...ready, notice: { where: 'now:next', trouble: { kind: 'signin', message: 'Lapsed, in a sentence.', authUrl: 'https://example.workers.dev/auth' } } });
  assert.equal(count(said, 'Lapsed, in a sentence.'), 1, 'the one line after a failed press');
  assert.doesNotMatch(said, /sign-in page/, 'and nothing more on the lock screen');
});

test('on their lock screen: wired through the house, under the owner switch, solid and unblurred', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const card = read('../components/LockSpotifyCard.tsx');
  const lock = read('../components/LockScreen.tsx');
  const app = read('../App.tsx');
  assert.doesNotMatch(card, /setInterval/, 'no reading on a fixed interval');
  assert.doesNotMatch(card, /backdrop-blur|backdrop-filter|backdropFilter/, 'nothing blurred');
  assert.doesNotMatch(card, /color-mix\(in srgb|hsla?\(|rgba?\(/, 'no color from outside the theme');
  assert.doesNotMatch(card, /#[0-9a-f]{3,8}\b/i, 'no fixed hex colors');
  assert.match(card, /addEventListener\('visibilitychange', woke\)/, 'a wake reads');
  assert.match(card, /lock\.stop\(\);/, 'the lock screen going away stops it');
  assert.match(lock, /\{spotify && \(\s*<LockSpotifyCard\s+fetcher=\{apiFetch\}\s+base=\{cardBase \+ messagesStep \+ noteStep \+ statusStep\}/, 'drawn only with the owner switch on, through the house, on top of the other cards and status rows');
  assert.match(lock, /data-lock-frame=""/, 'the frame it measures against');
  assert.match(app, /spotify=\{lockSpotifyOf\(theme\.lockSpotify\)\}/, 'the owner switch reaches the lock screen');
  assert.match(app, /spotifyApp=\{APPS\.find\(\(a\) => a\.id === 'spotify'\)\}/, 'and the app its tap opens');
  const settings = read('../components/SettingsDashboard.tsx');
  assert.match(settings, /onClick=\{\(\) => onThemeChange\(\{ lockSpotify: on \}\)\}/, 'Settings has the switch');
  assert.match(settings, /aria-pressed=\{lockSpotifyOf\(theme\.lockSpotify\) === on\}/, 'Settings reads the saved switch');
});
