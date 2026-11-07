import type { ClientMessage } from '@bytelight/shared';
import { upsertPending, type PendingMessage } from '../../message-outbox';
import { clearStaleStreamWatchdog, handleMessage } from './protocol';
import { persistPendingMessages, rt, seenSequence, store } from './store.svelte';

// How long a single connect attempt may sit in CONNECTING before we abort it.
const OPEN_TIMEOUT_MS = 10000;

function getWebSocketUrl(): string {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV ? 'localhost:3002' : window.location.host;
  return `${protocol}//${host}/ws`;
}

function getReconnectDelay(): number {
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 30000];
  const baseDelay = delays[Math.min(store.reconnectAttempt, delays.length - 1)];
  // Add jitter: +/- 20% to avoid reconnect stampedes
  const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

function clearTimers() {
  if (rt.reconnectTimeout) { clearTimeout(rt.reconnectTimeout); rt.reconnectTimeout = null; }
  if (rt.openTimeout) { clearTimeout(rt.openTimeout); rt.openTimeout = null; }
  if (rt.heartbeatInterval) { clearInterval(rt.heartbeatInterval); rt.heartbeatInterval = null; }
  if (rt.heartbeatTimeout) { clearTimeout(rt.heartbeatTimeout); rt.heartbeatTimeout = null; }
  clearStaleStreamWatchdog();
}

// Heartbeat policy:
// - Foreground (visible): ping every 30s, timeout 5s
// - Background (hidden): ping every 60s, timeout 90s (relaxed to tolerate mobile sleep)
function startHeartbeat() {
  scheduleNextHeartbeat();
}

function scheduleNextHeartbeat() {
  if (rt.heartbeatInterval) { clearInterval(rt.heartbeatInterval); rt.heartbeatInterval = null; }

  const intervalMs = store.tabVisible ? 30000 : 60000;

  rt.heartbeatInterval = setInterval(() => {
    if (store.wsInstance?.readyState === WebSocket.OPEN) {
      store.wsInstance.send(JSON.stringify({ type: 'ping' }));
      // Foreground gets 12s (not 5s): the backend event loop can stall briefly
      // while generating, and a too-tight window kills healthy connections mid-stream.
      const timeoutMs = store.tabVisible ? 12000 : 90000;
      if (rt.heartbeatTimeout) clearTimeout(rt.heartbeatTimeout);
      rt.heartbeatTimeout = setTimeout(() => {
        console.warn(`[ws:lifecycle] Heartbeat timeout (${timeoutMs}ms, visible=${store.tabVisible}) — no pong received`);
        store.closeReason = 'heartbeat_timeout';
        store.wsInstance?.close();
      }, timeoutMs);
    }
  }, intervalMs);
}

// Health probe: check if socket is alive before triggering reconnect on visibility change
function sendHealthProbe(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!store.wsInstance || store.wsInstance.readyState !== WebSocket.OPEN) {
      resolve(false);
      return;
    }

    // If we received a pong recently (within 12s), socket is healthy.
    // Matches the foreground heartbeat tolerance so "is it alive?" is judged
    // consistently everywhere; if it's older we still actively probe below.
    if (Date.now() - store.lastPongTime < 12000) {
      resolve(true);
      return;
    }

    const originalPong = rt.handlePong;

    // Unified cleanup: restore handler and resolve
    const finish = (healthy: boolean) => {
      clearTimeout(probeTimeout);
      rt.handlePong = originalPong;
      resolve(healthy);
    };

    // Send probe ping and wait for pong
    const probeTimeout = setTimeout(() => {
      console.log('[ws:lifecycle] Health probe timeout — socket unresponsive');
      finish(false);
    }, 3000);

    rt.handlePong = () => {
      originalPong(); // Update lastPongTime + clear heartbeat timeout
      finish(true);
    };

    store.wsInstance.send(JSON.stringify({ type: 'ping' }));
  });
}

// Single-flight reconnect scheduler with backoff and jitter
function scheduleReconnect() {
  if (rt.reconnectInFlight) {
    console.log('[ws:lifecycle] Reconnect already in flight — skipping');
    return;
  }

  store.reconnectAttempt++;
  const delay = getReconnectDelay();
  console.log(`[ws:lifecycle] scheduling reconnect in ${delay}ms (attempt ${store.reconnectAttempt})`);

  store.reconnectScheduled = true;
  rt.reconnectInFlight = new Promise<void>((resolve) => {
    rt.reconnectTimeout = setTimeout(() => {
      store.connectionState = 'reconnecting';
      connect();
      rt.reconnectInFlight = null;
      resolve();
    }, delay);
  });
}

export function connect() {
  if (store.wsInstance?.readyState === WebSocket.OPEN || store.wsInstance?.readyState === WebSocket.CONNECTING) return;

  clearTimers();
  const url = getWebSocketUrl();

  try {
    store.wsInstance = new WebSocket(url);
    store.connectionState = store.reconnectAttempt > 0 ? 'reconnecting' : 'disconnected';

    store.wsInstance.onopen = () => {
      if (rt.openTimeout) { clearTimeout(rt.openTimeout); rt.openTimeout = null; }
      console.log('[ws:lifecycle] connected');
      store.connectionState = 'connected';
      store.reconnectAttempt = 0;
      store.reconnectScheduled = false;
      store.lastError = null;
      store.intentionalClose = false;
      store.closeReason = 'unknown';
      startHeartbeat();

      // Send initial tab visibility state
      store.tabVisible = !document.hidden;
      send({ type: 'visibility', visible: store.tabVisible });

      // Track tab visibility changes (single listener, cleaned up on disconnect)
      if (rt.visibilityHandler) document.removeEventListener('visibilitychange', rt.visibilityHandler);
      rt.visibilityHandler = async () => {
        const wasHidden = !store.tabVisible;
        store.tabVisible = !document.hidden;
        send({ type: 'visibility', visible: store.tabVisible });

        // Adjust heartbeat cadence based on visibility
        if (store.wsInstance?.readyState === WebSocket.OPEN) {
          scheduleNextHeartbeat();
        }

        // When becoming visible after being hidden, probe socket health.
        // The user is actively back, so reconnect WITHOUT backoff delay —
        // reset the attempt counter so any reconnect is immediate, not dawdling.
        if (store.tabVisible && wasHidden) {
          console.log('[ws:lifecycle] Tab visible — checking socket health');
          if (store.wsInstance?.readyState === WebSocket.OPEN) {
            const healthy = await sendHealthProbe();
            if (!healthy) {
              // Socket is open but unresponsive — close it and let onclose reconnect fast
              console.log('[ws:lifecycle] Socket unhealthy after resume — closing');
              store.closeReason = 'heartbeat_timeout';
              store.reconnectAttempt = 0; // skip backoff — user is right here
              store.wsInstance?.close();
            }
          } else if (store.wsInstance?.readyState === WebSocket.CLOSED || !store.wsInstance) {
            // Socket already closed while suspended — reconnect immediately
            console.log('[ws:lifecycle] Socket closed while hidden — reconnecting now');
            if (rt.reconnectTimeout) { clearTimeout(rt.reconnectTimeout); rt.reconnectTimeout = null; }
            rt.reconnectInFlight = null;
            store.reconnectAttempt = 0;
            store.connectionState = 'reconnecting';
            connect();
          }
          // If CONNECTING, do nothing — already in progress
        }
      };
      document.addEventListener('visibilitychange', rt.visibilityHandler);

      // Sync if reconnecting
      const seenSeq = store.activeThreadId ? seenSequence(store.activeThreadId) : 0;
      if (seenSeq > 0 && store.activeThreadId) {
        send({
          type: 'sync',
          lastSeenSequence: seenSeq,
          threadId: store.activeThreadId,
        });
      }

      // Retry every unacknowledged message. Keep it in the outbox until the
      // backend confirms the durable database row.
      if (store.pendingMessages.length > 0) {
        const socket = store.wsInstance;
        if (!socket) return;
        for (const msg of store.pendingMessages) {
          socket.send(JSON.stringify(msg));
        }
      }
    };

    store.wsInstance.onmessage = handleMessage;

    // Capture a local reference to the socket we just created so we can detach
    // its handlers when it dies. Without this, buffered events from the dying
    // socket can race the new connection's reconciliation — the cause of
    // doubled messages and stuck spinners on mobile reconnect.
    const ws = store.wsInstance;

    // A socket that never finishes its handshake fires NEITHER onopen nor onclose:
    // Cloudflare accepts the connection while the origin behind it is restarting and
    // then simply holds it open. Without this watchdog the retry ladder below never
    // runs and the page sits on "Reconnecting" forever, long after the server is
    // healthy again, until the user hard-refreshes. Force the socket closed so the
    // normal onclose path schedules the retry.
    rt.openTimeout = setTimeout(() => {
      rt.openTimeout = null;
      if (ws.readyState === WebSocket.CONNECTING) {
        console.warn('[ws:lifecycle] open timeout — aborting stuck CONNECTING attempt');
        ws.close();
      }
    }, OPEN_TIMEOUT_MS);

    store.wsInstance.onclose = (event: CloseEvent) => {
      // Detach the dying socket's handlers first so its buffered events can't
      // race the next connection's reconciliation.
      ws.onmessage = null;
      ws.onopen = null;
      ws.onerror = null;

      // Ghost close: a newer connect() already superseded this socket (mobile
      // resume can observe readyState CLOSED and reconnect before this close
      // event dispatches). Its close is history, not news — the normal handling
      // below would flip connectionState to 'disconnected', clearTimers() would
      // kill the LIVE socket's open-watchdog and heartbeat, and the scheduled
      // retry would wedge the banner at 'reconnecting' against a healthy socket.
      if (store.wsInstance !== null && store.wsInstance !== ws) {
        console.log('[ws:lifecycle] ignoring close from superseded socket');
        return;
      }

      const reason = store.closeReason;
      console.log(`[ws:lifecycle] closed (intentional=${store.intentionalClose}, reason=${reason}, code=${event.code}, wasClean=${event.wasClean}, serverReason="${event.reason || ''}")`);
      store.connectionState = 'disconnected';
      clearTimers();

      if (store.intentionalClose) {
        store.intentionalClose = false;
        store.closeReason = 'unknown';
        return;
      }

      scheduleReconnect();
    };

    store.wsInstance.onerror = (err) => {
      store.closeReason = 'socket_error';
      console.error('[ws:lifecycle] WebSocket error:', err);
    };
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    store.connectionState = 'disconnected';
    scheduleReconnect();
  }
}

export function disconnect(reason: 'manual' = 'manual') {
  clearTimers();
  if (rt.visibilityHandler) {
    document.removeEventListener('visibilitychange', rt.visibilityHandler);
    rt.visibilityHandler = null;
  }
  if (store.wsInstance) {
    store.intentionalClose = true;
    store.closeReason = reason;
    console.log(`[ws:lifecycle] intentional disconnect (reason=${reason})`);
    store.connectionState = 'disconnecting';
    store.wsInstance.close();
    store.wsInstance = null;
  }
  store.connectionState = 'disconnected';
  store.reconnectAttempt = 0;
  rt.reconnectInFlight = null;
  store.reconnectScheduled = false;
  store.closeReason = 'unknown';
}

export function send(msg: ClientMessage) {
  // Stamp every outgoing user message with a clientId so the backend can
  // dedupe retries (reconnect drains, double-clicks, transient socket
  // hiccups). Reuse caller-provided ids when present (e.g. on drain).
  if (msg.type === 'message' && !msg.clientId) {
    msg.clientId = crypto.randomUUID();
  }
  if (msg.type === 'message') {
    const pending = msg as PendingMessage;
    store.pendingMessages = upsertPending(store.pendingMessages, pending);
    persistPendingMessages();
  }
  if (store.wsInstance?.readyState === WebSocket.OPEN) {
    store.wsInstance.send(JSON.stringify(msg));
  } else if (msg.type === 'message') {
    console.warn('Message queued — will send on reconnect');
  } else {
    console.warn('Cannot send: WebSocket not connected');
  }
}
