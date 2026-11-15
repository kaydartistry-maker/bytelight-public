// The Ear, in the watch page: reads the captions the site draws over the
// video and where the video is, and hands both to the background worker
// (background.js), which talks to the house. It sends nothing but caption
// text with times, the video's position, and (when asked) the probe.
//
// Runs on Netflix and Hulu watch pages. It may be injected more than once
// (on load, and again when the site moves to a watch page without a reload),
// so it starts only once per page.

(function () {
  'use strict';
  if (window.__theaterEarStarted) return;
  window.__theaterEarStarted = true;

  const lib = globalThis.TheaterEarLib;
  if (!lib) return;

  const READ_EVERY_MS = 500;
  const CLOCK_EVERY_MS = 5000;
  const HELLO_EVERY_MS = 10000;
  const PROBE_WINDOW_MS = 10000;

  const tracker = new lib.CaptionTracker({ maxOnScreen: 10 });
  let video = null;
  let alive = true;
  let lastClockAt = 0;
  let readQueued = false;

  /** Elements whose content changed lately, for "What do you hear?". */
  const changed = new Map();

  function site() {
    return lib.siteFor(location.hostname, location.pathname);
  }

  function send(message) {
    if (!alive) return;
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (_) {
      // The extension was reloaded or removed: this copy goes quiet.
      alive = false;
    }
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  }

  /** The biggest playing-sized video on the page. */
  function findVideo() {
    let best = null;
    let area = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area) { best = v; area = a; }
    }
    return best;
  }

  function overVideo(el) {
    if (!video) return true;
    const v = video.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return cx >= v.left && cx <= v.right && cy >= v.top && cy <= v.bottom;
  }

  /** What the captions say right now ('' when none are showing). */
  function readCaption(s) {
    for (const selector of s.captions) {
      let found;
      try {
        found = Array.from(document.querySelectorAll(selector));
      } catch (_) {
        continue;
      }
      found = found.filter((el) => visible(el) && overVideo(el));
      // Nested matches: keep the outermost, so words aren't read twice.
      found = found.filter((el) => !found.some((other) => other !== el && other.contains(el)));
      found = found.filter((el) => (el.innerText || el.textContent || '').length <= 500);
      if (found.length === 0) continue;
      return lib.normaliseCaption(found.map((el) => el.innerText || el.textContent || ''));
    }
    return '';
  }

  function sendClock(force) {
    if (!video) return;
    const now = Date.now();
    if (!force && now - lastClockAt < CLOCK_EVERY_MS - 250) return;
    lastClockAt = now;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
    send({ type: 'ear-clock', position: video.currentTime, paused: video.paused, duration });
  }

  function onVideoEvent(event) {
    if (event.type === 'seeked' || event.type === 'seeking') tracker.reset();
    sendClock(true);
  }

  function attachVideo(v) {
    if (v === video) return;
    if (video) {
      for (const name of ['play', 'pause', 'seeked', 'ratechange', 'ended']) video.removeEventListener(name, onVideoEvent);
    }
    video = v;
    tracker.reset();
    if (!video) return;
    for (const name of ['play', 'pause', 'seeked', 'ratechange', 'ended']) video.addEventListener(name, onVideoEvent);
    sendClock(true);
  }

  function read() {
    readQueued = false;
    if (!alive) return;
    const s = site();
    if (!s) return;
    attachVideo(findVideo());
    if (!video) return;
    const lines = tracker.see(readCaption(s), video.currentTime);
    if (lines.length > 0) send({ type: 'ear-lines', lines });
    if (!video.paused) sendClock(false);
  }

  function queueRead() {
    if (readQueued) return;
    readQueued = true;
    setTimeout(read, 120);
  }

  const observer = new MutationObserver((records) => {
    const now = Date.now();
    for (const rec of records) {
      const el = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
      if (el) changed.set(el, now);
    }
    if (changed.size > 800) {
      for (const [el, at] of changed) if (now - at > PROBE_WINDOW_MS) changed.delete(el);
    }
    if (site()) queueRead();
  });
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });

  setInterval(read, READ_EVERY_MS);
  setInterval(() => {
    if (site()) send({ type: 'ear-hello' });
    const now = Date.now();
    for (const [el, at] of changed) if (now - at > PROBE_WINDOW_MS || !el.isConnected) changed.delete(el);
  }, HELLO_EVERY_MS);
  if (site()) send({ type: 'ear-hello' });

  /**
   * "What do you hear?": what's on this page near the bottom of the player
   * that changed in the last ~10 s, so the selector table can be fixed.
   * Tags, class names, attribute NAMES and a short sample of text only.
   */
  function probe() {
    const s = site();
    const v = findVideo();
    const now = Date.now();
    const vr = v ? v.getBoundingClientRect() : null;
    const bottomFrom = vr ? vr.top + vr.height * 0.45 : window.innerHeight * 0.45;
    const candidates = [];
    for (const [el, at] of changed) {
      if (now - at > PROBE_WINDOW_MS || !el.isConnected) continue;
      const text = el.innerText || el.textContent || '';
      if (!text.trim() || text.length > 400) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.top + r.height / 2 < bottomFrom) continue;
      if (vr && (r.left > vr.right || r.right < vr.left)) continue;
      const matchedSelector = s ? s.captions.find((sel) => { try { return el.matches(sel); } catch (_) { return false; } }) : null;
      candidates.push(lib.probeCandidate({
        tag: el.tagName,
        className: typeof el.className === 'string' ? el.className : el.getAttribute('class'),
        attributes: Array.from(el.attributes).map((a) => a.name),
        text,
        changedSecondsAgo: (now - at) / 1000,
        matchedSelector,
      }));
      if (candidates.length >= 40) break;
    }
    return {
      site: s ? s.id : null,
      path: location.pathname,
      video: Boolean(v),
      videoPaused: v ? v.paused : null,
      videoTime: v ? Math.round(v.currentTime) : null,
      currentCaption: s ? readCaption(s) : '',
      selectors: s ? s.captions : [],
      candidates,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      extensionVersion: chrome.runtime.getManifest().version,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message && message.type === 'ear-probe') {
      try {
        reply({ ok: true, probe: probe() });
      } catch (err) {
        reply({ ok: false, error: String(err && err.message || err) });
      }
    }
    return false;
  });
})();
