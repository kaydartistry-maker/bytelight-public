import crypto from 'crypto';
import type { ServerMessage, Message } from '@bytelight/shared';
import { registry } from './registry.js';
import { createMessage, getMessages } from './db.js';
import { getSecret } from './secrets.js';
import { getBytelightConfig } from '../config.js';
import { priorVoicesBlock } from './room-turns.js';

// Living Room remote dispatch (Slice 4C).
//
// dispatchRemoteTurn() knocks on a remote companion node's full-turn bridge
// (POST /api/living-room/turn, bearer-auth with the shared living_room_token),
// relays its SSE stream LIVE into our WebSocket layer using the Slice 4A turn
// envelope (companionId + turnId on every stream event), and persists the
// final reply into our thread under the remote companion's id.
//
// Sovereignty contract: the remote turn runs entirely on the remote node —
// its tools, hooks, memory. We send the shared history and relay what comes
// back; nothing of theirs executes here. This function never throws: a dark
// or failing remote node logs and returns so the local turn is never harmed.

const HISTORY_WINDOW = 30;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

interface RemoteBrainConfig {
  baseUrl: string;
  displayName: string;
}

// Base URLs are overridable per-brain via the secrets store
// (`living_room_<brain>_url`) without a code change.
const REMOTE_BRAINS: Record<string, RemoteBrainConfig> = {
'companion-c': { baseUrl: 'http://127.0.0.1:3003', displayName: 'Companion C' },
};

export function isRemoteBrain(brain: string): boolean {
  return brain in REMOTE_BRAINS;
}

/** The name a remote brain goes by in the room ("Companion C"). */
export function remoteDisplayName(brain: string): string {
  return REMOTE_BRAINS[brain]?.displayName ?? brain.charAt(0).toUpperCase() + brain.slice(1);
}

function buildHistory(threadId: string): Array<{ author: string; content: string }> {
  const cfg = getBytelightConfig();
  const userName = cfg.identity.user_name || 'the operator';
  return getMessages({ threadId, limit: HISTORY_WINDOW })
    .filter(m => m.role !== 'system' && typeof m.content === 'string' && m.content.trim().length > 0)
    .map(m => ({
      author:
        m.role === 'user'
          ? userName
          : m.companion_id && REMOTE_BRAINS[m.companion_id]
            ? REMOTE_BRAINS[m.companion_id].displayName
            : 'Companion A & Companion B',
      content: m.content,
    }));
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

// Minimal SSE parser over a fetch body. Yields {event, data} pairs; ignores
// comment heartbeats (lines starting with ':'). Exported for tests.
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        try {
          yield { event, data: JSON.parse(data) as Record<string, unknown> };
        } catch {
          // Malformed frame — skip rather than kill the relay.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function dispatchRemoteTurn(params: {
  brain: string;
  threadId: string;
  turnId: string;
  message: string;
  threadName?: string;
  /** Who already answered earlier in this same round (the Living Room
   *  hand-off). The remote seat is told they are right here, in the same
   *  words the local lanes get (room-turns.ts priorVoicesBlock). */
  priorVoices?: ReadonlyArray<{ name: string; text: string }>;
}): Promise<string> {
  const { brain, threadId, turnId, threadName } = params;
  const remote = REMOTE_BRAINS[brain];
  if (!remote) {
    console.warn(`[dispatch] unknown remote brain '${brain}' — skipping seat`);
    return '';
  }
  const token = getSecret('living_room_token');
  if (!token) {
    console.error(`[dispatch] no living_room_token in secrets store — cannot reach '${brain}'`);
    return '';
  }
  const message = params.priorVoices?.length
    ? params.message + priorVoicesBlock([...params.priorVoices], getBytelightConfig().identity.user_name || 'the operator')
    : params.message;
  const baseUrl = getSecret(`living_room_${brain}_url`) || remote.baseUrl;

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);

  // Local message id for this relay's stream on OUR wire. The remote node has
  // its own message id; ours is what the frontend and the persisted row share.
  const localMessageId = crypto.randomUUID();
  let streamStarted = false;
  let lastText = '';

  const stamp = { companionId: brain, turnId };
  const broadcast = (msg: ServerMessage) => registry.broadcast(msg);

  try {
    const res = await fetch(`${baseUrl}/api/living-room/turn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        turnId,
        message,
        history: buildHistory(threadId),
        ...(threadName ? { threadName } : {}),
      }),
      signal: abort.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      console.error(`[dispatch] '${brain}' bridge answered ${res.status}: ${detail.slice(0, 200)}`);
      return '';
    }

    for await (const { event, data } of parseSse(res.body)) {
      switch (event) {
        case 'start':
          streamStarted = true;
          broadcast({ type: 'stream_start', messageId: localMessageId, threadId, ...stamp });
          break;
        case 'token':
          lastText = String(data.text ?? '');
          broadcast({ type: 'stream_token', messageId: localMessageId, token: lastText, ...stamp });
          break;
        case 'thinking':
          broadcast({
            type: 'thinking',
            content: String(data.content ?? ''),
            summary: String(data.summary ?? ''),
            ...stamp,
          });
          break;
        case 'tool_use':
          broadcast({
            type: 'tool_use',
            toolId: String(data.toolId ?? ''),
            toolName: String(data.toolName ?? ''),
            ...(typeof data.input === 'string' ? { input: data.input } : {}),
            isComplete: Boolean(data.isComplete),
            ...(typeof data.textOffset === 'number' ? { textOffset: data.textOffset } : {}),
            ...stamp,
          });
          break;
        case 'tool_result':
          broadcast({
            type: 'tool_result',
            toolId: String(data.toolId ?? ''),
            ...(typeof data.output === 'string' ? { output: data.output } : {}),
            ...(typeof data.isError === 'boolean' ? { isError: data.isError } : {}),
            ...stamp,
          });
          break;
        case 'tool_progress':
          broadcast({
            type: 'tool_progress',
            toolId: String(data.toolId ?? ''),
            toolName: String(data.toolName ?? ''),
            elapsed: Number(data.elapsed ?? 0),
            ...stamp,
          });
          break;
        case 'end': {
          const remoteFinal = (data.final ?? null) as (Partial<Message> & { metadata?: unknown }) | null;
          const content = (remoteFinal?.content && String(remoteFinal.content)) || lastText;
          if (content.trim()) {
            const persisted = createMessage({
              id: localMessageId,
              threadId,
              role: 'companion',
              content,
              contentType: 'text',
              platform: 'web',
              // Always our own lane tag, never the remote node's: a remote
              // row stamped e.g. claude-cli:primary would read as OUR
              // primary lane's words and be dropped by the other-lane net.
              metadata: {
                ...(remoteFinal?.metadata && typeof remoteFinal.metadata === 'object'
                  ? remoteFinal.metadata as Record<string, unknown>
                  : {}),
                lane: `relay:${brain}`,
              },
              createdAt: new Date().toISOString(),
              companionId: brain,
            });
            broadcast({ type: 'stream_end', messageId: localMessageId, final: persisted, ...stamp });
          } else {
            broadcast({ type: 'stream_end', messageId: localMessageId, ...stamp });
          }
          return content.trim() ? content : '';
        }
        case 'error':
          console.error(`[dispatch] '${brain}' turn error: ${String(data.message ?? 'unknown')}`);
          if (streamStarted) {
            broadcast({ type: 'stream_end', messageId: localMessageId, ...stamp });
          }
          return '';
      }
    }

    // Stream closed without an 'end' frame — persist what we have so the
    // reply isn't lost, and close our wire cleanly.
    if (streamStarted) {
      if (lastText.trim()) {
        const persisted = createMessage({
          id: localMessageId,
          threadId,
          role: 'companion',
          content: lastText,
          contentType: 'text',
          platform: 'web',
          // Same tag as a clean end: an untagged row is not speech to the
          // other-lane net, so the locals would never hear this reply.
          metadata: { lane: `relay:${brain}` },
          createdAt: new Date().toISOString(),
          companionId: brain,
        });
        broadcast({ type: 'stream_end', messageId: localMessageId, final: persisted, ...stamp });
        return lastText;
      } else {
        broadcast({ type: 'stream_end', messageId: localMessageId, ...stamp });
      }
    }
  } catch (err) {
    const reason = abort.signal.aborted ? `timed out after ${TURN_TIMEOUT_MS / 60000}m` : String(err);
    console.error(`[dispatch] '${brain}' relay failed: ${reason}`);
    if (streamStarted) {
      broadcast({ type: 'stream_end', messageId: localMessageId, ...stamp });
    }
  } finally {
    clearTimeout(timeout);
  }
  return '';
}
