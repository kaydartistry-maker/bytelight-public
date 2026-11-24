// The Ear's background worker: the only part that talks to the house.
//
// The watch page (content.js) hands it heard lines and the video's position;
// it sends them to the house's Ear door (/api/theater-ear) with the Ear's
// token, but only while the house says a computer night is live. It checks
// that about every 10 s while a watch tab is open (the tab says hello), and
// holds lines for a couple of minutes if the house can't be reached.
// Requests go out with no cookies, ever.
//
// It also answers the popup (popup.js): pair, forget, state, and the probe.

importScripts('lib.js');

const lib = self.TheaterEarLib;
const BASE = lib.HOUSE + lib.EAR_PATH;
const STATUS_EVERY_MS = 9000;
const FLUSH_AFTER_MS = 1500;

/** What the house last said: is a computer night on? */
let status = { live: false, night: null, checkedAt: 0, reachable: null, error: null };
const batcher = new lib.Batcher({ max: 50, maxQueue: 300, maxAgeMs: 120000 });
const recent = [];
let pendingClock = null;
let flushTimer = null;
let statusInFlight = null;

async function token() {
  const kept = await chrome.storage.local.get('token');
  return typeof kept.token === 'string' ? kept.token : null;
}

async function remember(values) {
  try {
    await chrome.storage.local.set(values);
  } catch (_) {
    /* only the popup's niceties live here */
  }
}

/** One call to the house's Ear door. Never sends cookies. */
async function house(method, path, body, withToken = true) {
  const headers = { 'content-type': 'application/json' };
  if (withToken) {
    const t = await token();
    if (!t) return { status: 0, json: null, unpaired: true };
    headers.authorization = `Bearer ${t}`;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* not JSON */ }
  if (res.status === 401 && withToken) {
    status = { ...status, live: false, night: null, error: 'unpaired' };
  }
  return { status: res.status, json };
}

async function refreshStatus(force) {
  if (!force && Date.now() - status.checkedAt < STATUS_EVERY_MS) return status;
  if (statusInFlight) return statusInFlight;
  statusInFlight = (async () => {
    try {
      const res = await house('GET', '/status');
      if (res.unpaired) {
        status = { live: false, night: null, checkedAt: Date.now(), reachable: null, error: 'unpaired' };
      } else if (res.status === 200 && res.json) {
        const before = status.night ? status.night.id : null;
        status = { live: Boolean(res.json.live), night: res.json.night || null, checkedAt: Date.now(), reachable: true, error: null };
        const now = status.night ? status.night.id : null;
        // A new night: lines from the last one don't belong to it.
        if (before && now !== before) { batcher.clear(); recent.length = 0; }
        if (!status.live) { batcher.clear(); pendingClock = null; }
      } else {
        status = { ...status, checkedAt: Date.now(), reachable: res.status !== 401, error: res.status === 401 ? 'unpaired' : `house answered ${res.status}` };
      }
    } catch (_) {
      // Offline or the house is away: keep what we knew, try again soon.
      status = { ...status, checkedAt: Date.now(), reachable: false, error: 'unreachable' };
    } finally {
      statusInFlight = null;
    }
    return status;
  })();
  return statusInFlight;
}

function scheduleFlush(delay) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, delay);
}

async function flush() {
  if (!status.live || !status.night) {
    if (batcher.size === 0 && !pendingClock) return;
    // Held while the house was away: look again, and keep trying while it is.
    await refreshStatus(true);
    if (!status.live || !status.night) {
      if (status.reachable === false) scheduleFlush(5000);
      return;
    }
  }
  const nightId = status.night.id;
  if (pendingClock) {
    const clock = pendingClock;
    pendingClock = null;
    try {
      const res = await house('POST', '/clock', { nightId, ...clock });
      if (res.status === 409) { await refreshStatus(true); return; }
      if (res.status >= 500 || res.status === 429) pendingClock = pendingClock || clock;
    } catch (_) {
      pendingClock = pendingClock || clock;
    }
  }
  while (batcher.size > 0) {
    const batch = batcher.take(Date.now());
    try {
      const res = await house('POST', '/lines', { nightId, lines: batch });
      if (res.status === 200) {
        await remember({ lastLine: batch[batch.length - 1].text, lastLineAt: Date.now() });
        continue;
      }
      if (res.status === 409) { await refreshStatus(true); return; }
      if (res.status >= 500 || res.status === 429) { batcher.putBack(batch, Date.now()); break; }
      // 400/401/413: the house won't take these; let them go.
    } catch (_) {
      batcher.putBack(batch, Date.now());
      break;
    }
  }
  if (batcher.size > 0 || pendingClock) scheduleFlush(5000);
}

async function onLines(lines) {
  await refreshStatus(false);
  // Known not live: nobody is listening. Unknown (offline): hold them briefly.
  if (status.reachable === true && !status.live) return;
  if (status.error === 'unpaired') return;
  const fresh = lib.dedupeLines(lines.filter((l) => l && typeof l.text === 'string'), recent, 2);
  if (fresh.length === 0) return;
  batcher.add(fresh, Date.now());
  scheduleFlush(FLUSH_AFTER_MS);
}

async function onClock(message) {
  await refreshStatus(false);
  if (!status.live) return;
  const clock = { position: message.position, paused: Boolean(message.paused) };
  if (typeof message.duration === 'number' && Number.isFinite(message.duration)) clock.duration = message.duration;
  pendingClock = clock;
  // Play, pause and seeks go at once; lines follow in their batch.
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flush();
}

async function popupState() {
  const t = await token();
  if (t) await refreshStatus(false);
  const kept = await chrome.storage.local.get(['lastLine', 'lastLineAt', 'probeSentAt']);
  return {
    connected: Boolean(t) && status.error !== 'unpaired',
    live: Boolean(t) && status.live,
    title: status.night ? status.night.title : null,
    reachable: status.reachable,
    lastLine: kept.lastLine || null,
    lastLineAt: kept.lastLineAt || null,
  };
}

async function connect(rawCode) {
  const code = lib.pairingCode(rawCode);
  if (!code) return { ok: false, error: 'That doesn\'t look like a pairing code. It\'s 8 letters and numbers, from the Theater.' };
  let res;
  try {
    res = await house('POST', '/claim', { code }, false);
  } catch (_) {
    return { ok: false, error: 'The house couldn\'t be reached. Check the internet and try again.' };
  }
  if (res.status === 201 && res.json && typeof res.json.token === 'string') {
    await chrome.storage.local.set({ token: res.json.token });
    status = { live: false, night: null, checkedAt: 0, reachable: null, error: null };
    await refreshStatus(true);
    return { ok: true };
  }
  return { ok: false, error: (res.json && res.json.error) || 'That code didn\'t work. Make a new one in the Theater.' };
}

async function disconnect() {
  await chrome.storage.local.remove(['token', 'lastLine', 'lastLineAt']);
  status = { live: false, night: null, checkedAt: 0, reachable: null, error: 'unpaired' };
  batcher.clear();
  pendingClock = null;
  return { ok: true };
}

async function sendProbe() {
  if (!(await token())) return { ok: false, error: 'Connect the Ear first.' };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url ? new URL(tab.url) : null;
  if (!tab || !url || !lib.siteFor(url.hostname, url.pathname)) {
    return { ok: false, error: 'Open the show on Netflix or Hulu in this tab, with subtitles on, then try again.' };
  }
  let answer;
  try {
    answer = await chrome.tabs.sendMessage(tab.id, { type: 'ear-probe' });
  } catch (_) {
    return { ok: false, error: 'The Ear isn\'t in that page yet. Reload the show\'s page and try again.' };
  }
  if (!answer || !answer.ok) return { ok: false, error: 'The page didn\'t answer. Reload it and try again.' };
  try {
    const res = await house('POST', '/probe', answer.probe);
    if (res.status === 201) {
      await remember({ probeSentAt: Date.now() });
      return { ok: true, found: answer.probe.candidates.length, video: answer.probe.video };
    }
    return { ok: false, error: (res.json && res.json.error) || `The house answered ${res.status}.` };
  } catch (_) {
    return { ok: false, error: 'The house couldn\'t be reached.' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const type = message && message.type;
  const fromPage = Boolean(sender && sender.tab);
  const run = async () => {
    switch (type) {
      case 'ear-hello': {
        if (!fromPage) return null;
        const now = await refreshStatus(false);
        if (batcher.size > 0 || pendingClock) scheduleFlush(0);
        return { live: now.live };
      }
      case 'ear-lines': if (fromPage && Array.isArray(message.lines)) await onLines(message.lines.slice(0, 50)); return { ok: true };
      case 'ear-clock': if (fromPage) await onClock(message); return { ok: true };
      case 'popup-state': return fromPage ? null : popupState();
      case 'connect': return fromPage ? null : connect(message.code);
      case 'disconnect': return fromPage ? null : disconnect();
      case 'probe': return fromPage ? null : sendProbe();
      default: return null;
    }
  };
  run().then(reply, (err) => reply({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

// Netflix and Hulu move to a watch page without reloading; the manifest's
// content script only lands on a fresh load, so follow the move and put the
// Ear in (content.js starts once per page however often it is injected).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  let url;
  try { url = new URL(info.url); } catch (_) { return; }
  if (!lib.siteFor(url.hostname, url.pathname)) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ['lib.js', 'content.js'] }).catch(() => {});
});
