import { send } from './socket.svelte';
import { store } from './store.svelte';

export function sendCanvasCreate(title: string, contentType: 'markdown' | 'code' | 'text' | 'html', language?: string, threadId?: string, tags?: string[]) {
  send({ type: 'canvas_create', title, contentType, language, threadId, tags });
}
export function sendCanvasUpdate(canvasId: string, content: string) {
  send({ type: 'canvas_update', canvasId, content });
  // Optimistically update local store (server broadcasts to others via broadcastExcept)
  store.canvases = store.canvases.map(c =>
    c.id === canvasId
      ? { ...c, content, updated_at: new Date().toISOString() }
      : c
  );
}
export function sendCanvasUpdateTitle(canvasId: string, title: string) {
  send({ type: 'canvas_update_title', canvasId, title });
}
export function sendCanvasUpdateTags(canvasId: string, tags: string[]) {
  send({ type: 'canvas_update_tags', canvasId, tags });
  store.canvases = store.canvases.map(c =>
    c.id === canvasId
      ? { ...c, tags, updated_at: new Date().toISOString() }
      : c
  );
}
export function sendCanvasDelete(canvasId: string) {
  send({ type: 'canvas_delete', canvasId });
}

// Stop generation
export function sendStopGeneration() {
  // Clear local state immediately so UI recovers even if websocket is dead
  store.streamingMessageId = null;
  store.streamingThreadId = null;
  store.streamingTokens = '';
  // Attempt to tell backend (may fail if disconnected, but that's okay now)
  send({ type: 'stop_generation' });
}

// MCP control
export function sendMcpReconnect(serverName: string) {
  send({ type: 'mcp_reconnect', serverName });
}
export function sendMcpToggle(serverName: string, enabled: boolean) {
  send({ type: 'mcp_toggle', serverName, enabled });
}

// File rewind
export function sendRewindFiles(userMessageId: string, dryRun?: boolean) {
  send({ type: 'rewind_files', userMessageId, dryRun });
}
export function sendCommand(name: string, args?: string, threadId?: string) {
  send({ type: 'command', name, args, threadId });
}
