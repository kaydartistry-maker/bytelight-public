import { send } from './socket.svelte';
import { bumpSeen, store } from './store.svelte';

export async function loadThread(threadId: string) {
  store.activeThreadId = threadId;
  // A normal thread load restores the tail view — leaving any prior
  // around-window mode so pagination behaves normally again.
  store.isViewingAround = false;
  try {
    const response = await fetch(`/api/threads/${threadId}/messages`);
    if (!response.ok) throw new Error('Failed to load messages');
    const data = await response.json();
    store.messages = data.messages || [];
    if (store.messages.length > 0) {
      const last = store.messages[store.messages.length - 1];
      bumpSeen(threadId, last.sequence);
    }
    // Mark as read (best-effort — don't block thread loading if WS is down)
    if (store.messages.length > 0) {
      try { send({ type: 'read', threadId, beforeId: store.messages[store.messages.length - 1].id }); } catch {}
    }
  } catch (err) {
    console.error('Failed to load thread:', err);
    store.messages = [];
  }
}

// Load older messages (pagination — prepend to existing)
// Returns true if there were more messages, false if we've reached the beginning
export async function loadOlderMessages(threadId: string): Promise<boolean> {
  if (store.messages.length === 0) return false;
  const oldestMessage = store.messages[0];
  try {
    const response = await fetch(`/api/threads/${threadId}/messages?before=${oldestMessage.id}&limit=50`);
    if (!response.ok) throw new Error('Failed to load older messages');
    const data = await response.json();
    const older = data.messages || [];
    if (older.length === 0) return false;
    store.messages = [...older, ...store.messages];
    return older.length >= 50; // If we got a full page, there might be more
  } catch (err) {
    console.error('Failed to load older messages:', err);
    return false;
  }
}

// Load a window of messages centered on a specific message id. Used by
// search-result jumps so a hit on a message older than the loaded tail can be
// scrolled to without paging through every batch in between. Switches the
// active thread if needed, replaces `messages` with the window, and sets
// `isViewingAround` so the chat page's pagination doesn't immediately fire and
// clobber the window.
export async function loadThreadAround(threadId: string, messageId: string, windowSize = 50): Promise<void> {
  if (store.activeThreadId !== threadId) store.activeThreadId = threadId;
  try {
    const response = await fetch(`/api/threads/${threadId}/messages?around=${encodeURIComponent(messageId)}&limit=${windowSize}`);
    if (!response.ok) throw new Error('Failed to load thread around message');
    const data = await response.json();
    store.messages = data.messages || [];
    store.isViewingAround = true;
    if (store.messages.length > 0) {
      const last = store.messages[store.messages.length - 1];
      bumpSeen(threadId, last.sequence);
    }
  } catch (err) {
    console.error('Failed to load thread around message:', err);
    store.messages = [];
    store.isViewingAround = false;
  }
}

export async function loadThreads() {
  try {
    // Cap the initial fetch so a transit stall can never pend forever — on
    // timeout this rejects and falls through to the catch below (threads = []).
    const response = await fetch('/api/threads', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Failed to load threads');
    const data = await response.json();
    store.threads = data.threads || [];
  } catch (err) {
    console.error('Failed to load threads:', err);
    store.threads = [];
  }
}
