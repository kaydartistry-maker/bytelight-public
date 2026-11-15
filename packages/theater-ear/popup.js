// The Ear's popup: pair with a code, see whether a night is on and the last
// line heard, send a "What do you hear?" probe, or disconnect. Every move
// goes through the background worker (background.js), which does the talking.

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  function ask(message) {
    return chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: String(err && err.message || err) }));
  }

  function showError(text) {
    $('error').textContent = text || '';
    $('error').hidden = !text;
  }

  async function draw() {
    const s = await ask({ type: 'popup-state' });
    if (!s || s.ok === false) { showError((s && s.error) || 'The Ear could not be read.'); return; }
    $('pair').hidden = s.connected;
    $('connected').hidden = !s.connected;
    const pill = $('state');
    pill.textContent = s.connected ? 'Connected' : 'Not connected';
    pill.classList.toggle('on', Boolean(s.connected));
    if (!s.connected) return;
    $('night').textContent = s.live
      ? `A night is on: ${s.title || 'the Theater'}. Listening.`
      : s.reachable === false
        ? 'The house can\'t be reached right now.'
        : 'No computer night is on. Start one in the Theater.';
    $('last').textContent = s.lastLine ? `Last line heard: “${s.lastLine.replace(/\n/g, ' / ')}”` : 'No lines heard yet.';
  }

  $('pair-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const code = TheaterEarLib.pairingCode($('code').value);
    if (!code) { showError('A pairing code is 8 letters and numbers, like ABCD-EFGH.'); return; }
    $('connect').disabled = true;
    const res = await ask({ type: 'connect', code });
    $('connect').disabled = false;
    if (!res || !res.ok) { showError((res && res.error) || 'That didn\'t work.'); return; }
    $('code').value = '';
    await draw();
  });

  $('disconnect').addEventListener('click', async () => {
    showError('');
    await ask({ type: 'disconnect' });
    await draw();
  });

  $('probe').addEventListener('click', async () => {
    showError('');
    $('probe').disabled = true;
    $('probe-note').textContent = 'Listening…';
    const res = await ask({ type: 'probe' });
    $('probe').disabled = false;
    if (!res || !res.ok) {
      $('probe-note').textContent = '';
      showError((res && res.error) || 'That didn\'t go through.');
      return;
    }
    $('probe-note').textContent = 'Sent';
  });

  void draw();
  setInterval(draw, 5000);
})();
