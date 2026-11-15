// The Ear's small, pure pieces: which pages it listens on, how a caption's
// words are tidied, when a caption line is finished, dropping repeats, and
// batching lines for the house. No DOM and no network here, so it runs the
// same in the page (content.js), the background worker (background.js) and
// under node for the tests (tests/lib.test.mjs).
//
// Loaded as a plain script: it hangs itself on globalThis.TheaterEarLib.

(function (root) {
  'use strict';

  /** Where the house lives. */
  // Set this to your own house's public address (and the same in manifest.json).
  const HOUSE = 'https://your-house.example.com';
  const EAR_PATH = '/api/theater-ear';

  /**
   * THE SELECTOR TABLE. Where each site draws its captions, tried in order;
   * the first selector that finds a visible element over the video wins.
   * When a site changes its page, the fix is one line here.
   *   Netflix: known layout (.player-timedtext > .player-timedtext-text-container).
   *   Hulu: UNVERIFIED guesses until a "What do you hear?" probe says otherwise.
   */
  const SITES = [
    {
      id: 'netflix',
      hosts: ['www.netflix.com', 'netflix.com'],
      watch: /^\/watch\//,
      captions: ['.player-timedtext .player-timedtext-text-container', '.player-timedtext'],
    },
    {
      id: 'hulu',
      hosts: ['www.hulu.com', 'hulu.com'],
      watch: /^\/watch\//,
      captions: ['.ClosedCaption', '.CaptionBox', '[class*="caption" i]', '[class*="subtitle" i]'],
    },
  ];

  /** The site this page is a watch page of, or null. */
  function siteFor(hostname, pathname) {
    const host = String(hostname || '').toLowerCase();
    const site = SITES.find((s) => s.hosts.includes(host));
    if (!site || !site.watch.test(String(pathname || ''))) return null;
    return site;
  }

  const MAX_LINE = 1000;

  /**
   * A caption's words, tidied: each line trimmed, runs of space squeezed,
   * blank lines dropped, lines joined with "\n". Takes a string or the
   * texts of several elements (each may hold several lines).
   */
  function normaliseCaption(raw) {
    const parts = Array.isArray(raw) ? raw : [raw];
    const lines = [];
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      for (const line of part.replace(/\r\n?/g, '\n').split('\n')) {
        const clean = line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (clean) lines.push(clean);
      }
    }
    return lines.join('\n').slice(0, MAX_LINE);
  }

  /**
   * Turns "what is on screen now" readings into finished lines.
   * see(text, time) is called whenever the caption might have changed (and
   * now and then anyway), with the video's currentTime in seconds. When the
   * words change or vanish, the old line is finished: { text, start, end }.
   * A line still on screen after `maxOnScreen` seconds is sent then (end =
   * that moment), once. Time jumping backwards (a rewind) drops the line
   * being watched rather than inventing an end for it.
   */
  class CaptionTracker {
    constructor(opts) {
      this.maxOnScreen = (opts && opts.maxOnScreen) || 10;
      this.current = null;
    }

    see(text, time) {
      const out = [];
      if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) return out;
      const words = normaliseCaption(text || '');
      const cur = this.current;
      if (cur && time < cur.start - 1) {
        this.current = words ? { text: words, start: time, sent: false } : null;
        return out;
      }
      if (cur && words === cur.text) {
        if (!cur.sent && time - cur.start >= this.maxOnScreen) {
          out.push({ text: cur.text, start: round(cur.start), end: round(time) });
          cur.sent = true;
        }
        return out;
      }
      if (cur && !cur.sent) out.push({ text: cur.text, start: round(cur.start), end: round(Math.max(cur.start, time)) });
      this.current = words ? { text: words, start: time, sent: false } : null;
      return out;
    }

    /** A seek: forget the line being watched. */
    reset() {
      this.current = null;
    }
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  /**
   * Drop lines already sent: the same words starting within `windowSec`
   * of one kept in `recent` (which this updates, keeping the last 100).
   */
  function dedupeLines(lines, recent, windowSec) {
    const win = typeof windowSec === 'number' ? windowSec : 2;
    const kept = [];
    for (const line of lines) {
      const twin = recent.some((r) => r.text === line.text && Math.abs(r.start - line.start) <= win);
      if (twin) continue;
      recent.push({ text: line.text, start: line.start });
      kept.push(line);
    }
    while (recent.length > 100) recent.shift();
    return kept;
  }

  /**
   * Lines waiting for the house: take() hands out up to `max` at a time,
   * putBack() returns a batch that failed to send (to the front), and
   * anything older than `maxAgeMs` or past `maxQueue` lines is let go, so a
   * long time offline never floods the house with stale lines.
   */
  class Batcher {
    constructor(opts) {
      const o = opts || {};
      this.max = o.max || 50;
      this.maxQueue = o.maxQueue || 300;
      this.maxAgeMs = o.maxAgeMs || 120000;
      this.items = [];
    }

    add(lines, now) {
      for (const line of lines) this.items.push({ line, at: now });
      this.prune(now);
    }

    prune(now) {
      this.items = this.items.filter((i) => now - i.at <= this.maxAgeMs);
      if (this.items.length > this.maxQueue) this.items = this.items.slice(-this.maxQueue);
    }

    take(now) {
      this.prune(now);
      const batch = this.items.splice(0, this.max);
      return batch.map((i) => i.line);
    }

    putBack(lines, now) {
      this.items = lines.map((line) => ({ line, at: now })).concat(this.items);
      this.prune(now);
    }

    clear() {
      this.items = [];
    }

    get size() {
      return this.items.length;
    }
  }

  const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  /** "abcd-efgh" → "ABCDEFGH", or null when it can't be a pairing code. */
  function pairingCode(raw) {
    const code = String(raw || '').toUpperCase().replace(/[\s-]/g, '');
    if (code.length !== 8) return null;
    for (const ch of code) if (!PAIRING_ALPHABET.includes(ch)) return null;
    return code;
  }

  /** A URL's path only: no query, no fragment (they can carry account bits). */
  function pathOnly(url) {
    try {
      return new URL(url).pathname;
    } catch (_) {
      return '';
    }
  }

  /** One probe candidate, trimmed to what the developer needs. */
  function probeCandidate(c) {
    return {
      tag: String(c.tag || '').toLowerCase().slice(0, 20),
      className: String(c.className || '').slice(0, 200),
      attributes: (c.attributes || []).map((a) => String(a).slice(0, 40)).slice(0, 20),
      text: normaliseCaption(String(c.text || '')).slice(0, 160),
      changedSecondsAgo: typeof c.changedSecondsAgo === 'number' ? Math.round(c.changedSecondsAgo * 10) / 10 : null,
      matchedSelector: c.matchedSelector || null,
    };
  }

  const lib = {
    HOUSE,
    EAR_PATH,
    SITES,
    siteFor,
    normaliseCaption,
    CaptionTracker,
    dedupeLines,
    Batcher,
    pairingCode,
    pathOnly,
    probeCandidate,
  };
  root.TheaterEarLib = lib;
})(typeof globalThis !== 'undefined' ? globalThis : self);
