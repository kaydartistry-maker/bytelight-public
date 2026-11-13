import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HTTPServer } from 'http';
import type { Socket } from 'net';
import { parse as parseCookie } from 'cookie';
import crypto from 'crypto';
import { readFileSync, statSync } from 'fs';
import { isLocalhost } from '../middleware/localhost.js';
import type {
  ClientMessage,
  ServerMessage,
  Canvas,
  Thread,
  ThreadSummary,
} from '@bytelight/shared';
import { registry, type ExtendedWebSocket } from './registry.js';
import {
  getDb,
  getWebSession,
  createMessage,
  getMessageByClientId,
  getMessages,
  markMessagesRead,
  listThreads,
  getThread,
  createThread,
  updateThreadActivity,
  getTodayThread,
  getRoutingThreadId,
  resolveRoutingThread,
  createCanvas,
  getCanvas,
  listCanvases,
  updateCanvasContent,
  updateCanvasTitle,
  updateCanvasTags,
  deleteCanvas,
  addReaction,
  removeReaction,
  pinThread,
  unpinThread,
} from './db.js';
import { AgentService, QUEUE_TIMEOUT_MESSAGE } from './agent.js';
import { getThreadRoster, type Companion } from './db/rooms.js';
import { dispatchRemoteTurn, remoteDisplayName } from './living-room-relay.js';
import { Orchestrator } from './orchestrator.js';
import { getFile } from './files.js';
import { capImageBlocks, MAX_IMAGES_PER_TURN, type ImageBlock } from './visual-blocks.js';
import { prepareVisionImage, type PreparedVisionImage } from './vision-image-preprocessor.js';
import type { NormalizedImage } from './runtimes/types.js';
import { VoiceService } from './voice.js';
import { detectWhisperHallucination } from './voice-transcript-guard.js';
import {
  MAX_AUDIO_CHUNKS_PER_RECORDING,
  MAX_AUDIO_BUFFER_SIZE,
  matchesActiveRecording,
  safeAudioMimeType,
} from './voice-recording.js';
import type { DiscordService } from './discord/index.js';
import type { TelegramService } from './telegram/index.js';
import { getBytelightConfig, persistVoiceReadAloud } from '../config.js';
import { cutOffPrompt, leaseTurn, releaseTurn, takeCutOffTurns } from './db/turn-leases.js';
import { buildCommandRegistry, handleCommand } from './commands.js';
import { getActiveStreamSnapshots } from './active-streams.js';
import { errMessage } from '../util/errors.js';
import { bellStatus } from './bell-status.js';

function getAllowedOrigins(): string[] {
  const config = getBytelightConfig();
  const port = config.server.port;
  const origins = new Set<string>([
    'http://localhost:5173',
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'capacitor://localhost',
    'tauri://localhost',
  ]);
  for (const o of config.cors.origins) {
    origins.add(o);
  }
  return Array.from(origins);
}

const MAX_TEXT_MESSAGE_SIZE = 128 * 1024; // 128KB for text messages
const MAX_VOICE_MESSAGE_SIZE = 512 * 1024; // 512KB for voice audio chunks
const INLINE_TEXT_ATTACHMENT_MAX_SIZE = 256 * 1024; // 256KB max to inline text attachments into agent prompt
const INLINE_TEXT_ATTACHMENT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.log']);

function getExtension(filename?: string): string {
  const name = filename || '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function buildInlineTextAttachmentContext(args: {
  filename?: string;
  mimeType?: string;
  size?: number;
  diskPath?: string;
}): string {
  const { filename, mimeType, size, diskPath } = args;
  if (!diskPath) return '';

  const ext = getExtension(filename);
  const mime = (mimeType || '').toLowerCase();
  const looksLikeText =
    INLINE_TEXT_ATTACHMENT_EXTENSIONS.has(ext) ||
    mime.startsWith('text/') ||
    mime === 'application/json';

  if (!looksLikeText) return '';

  try {
    const stat = statSync(diskPath);
    const actualSize = size || stat.size;

    if (actualSize > INLINE_TEXT_ATTACHMENT_MAX_SIZE) {
      return `\n\n[Text attachment not inlined: file is ${Math.round(actualSize / 1024)}KB, over the ${Math.round(INLINE_TEXT_ATTACHMENT_MAX_SIZE / 1024)}KB inline limit. Use the file path if needed.]`;
    }

    const body = readFileSync(diskPath, 'utf8');

    return `\n\n--- Begin attached text: ${filename || 'attachment'} ---\n${body}\n--- End attached text: ${filename || 'attachment'} ---`;
  } catch (err) {
    const message = errMessage(err);
    return `\n\n[Could not inline text attachment: ${message}]`;
  }
}

const COOKIE_NAME = 'bytelight_session';

// Re-export registry and ExtendedWebSocket from registry.ts for backward compatibility
export { registry, type ExtendedWebSocket } from './registry.js';

function parseDeviceType(ua: string): 'mobile' | 'desktop' | 'unknown' {
  if (!ua) return 'unknown';
  if (/iPhone|iPad|iPod|Android|Mobile|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua)) {
    return 'mobile';
  }
  if (/Mozilla|Chrome|Safari|Firefox|Edge|Opera/i.test(ua)) {
    return 'desktop';
  }
  return 'unknown';
}

function getLastMessagePreview(threadId: string): string | null {
  const msgs = getMessages({ threadId, limit: 1 });
  if (!msgs.length) return null;
  const content = msgs[msgs.length - 1].content ?? '';
  return content.substring(0, 100).replace(/\n/g, ' ').trim() || null;
}

function threadsToSummaries(threads: Thread[]): ThreadSummary[] {
  return threads.map(t => ({
    id: t.id,
    name: t.name,
    type: t.type,
    unread_count: t.unread_count,
    last_activity_at: t.last_activity_at,
    last_message_preview: getLastMessagePreview(t.id),
    pinned_at: t.pinned_at ?? null,
  }));
}

/**
 * The owner's message waited out the whole queue window without a turn. It
 * must never vanish silently — return the notice to show her, or null when
 * the response is an ordinary reply (or an empty side-note hand-off).
 */
export function queueTimeoutNotice(response: string | undefined): string | null {
  if (typeof response !== 'string' || response.trim() !== QUEUE_TIMEOUT_MESSAGE) return null;
  return 'Your message waited too long behind another turn and was not answered. It is saved — send it again, or nudge the companions.';
}

function sendError(ws: WebSocket, code: string, message: string): void {
  const msg: ServerMessage = { type: 'error', code, message };
  ws.send(JSON.stringify(msg));
}

let voiceServiceInstance: VoiceService | null = null;

export function setVoiceService(vs: VoiceService): void {
  voiceServiceInstance = vs;
}

export interface GatewayServices {
  discord?: DiscordService | null;
  telegram?: TelegramService | null;
}

let gatewayServices: GatewayServices = {};

export function setGatewayServices(services: GatewayServices): void {
  gatewayServices = services;
}

export function createWebSocketServer(server: HTTPServer, agentService?: AgentService, orchestrator?: Orchestrator): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const agent = agentService ?? new AgentService();
  const config = getBytelightConfig();
  const appPassword = config.auth.password;

  // Handle upgrade
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const origin = request.headers.origin;
    const allowedOrigins = getAllowedOrigins();

    // Allow localhost connections without origin (CLI tools, internal)
    const remoteAddr = (socket as Socket).remoteAddress || '';
    const isLocal = isLocalhost(remoteAddr);

    console.log(`[WS Upgrade] remote=${remoteAddr} origin=${origin} isLocalhost=${isLocal} hasCookie=${!!request.headers.cookie}`);

    // Validate origin — require valid origin for non-localhost connections
    if (!isLocal) {
      if (!origin || !allowedOrigins.includes(origin)) {
        console.log(`[WS Upgrade] REJECTED: origin not allowed. Got: ${origin}, Allowed: ${allowedOrigins.join(', ')}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    } else if (origin && !allowedOrigins.includes(origin)) {
      console.log(`[WS Upgrade] REJECTED: localhost origin not allowed. Got: ${origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Validate session if password is set
    if (appPassword) {
      const cookieHeader = request.headers.cookie;
      if (!cookieHeader) {
        console.log(`[WS Upgrade] REJECTED: no cookie header`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const cookies = parseCookie(cookieHeader);
      const sessionToken = cookies[COOKIE_NAME];

      if (!sessionToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const session = getWebSession(sessionToken);
      if (!session || new Date(session.expires_at) < new Date()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // Connection handler
  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const extWs = ws as ExtendedWebSocket;
    extWs.isAlive = true;
    extWs.userId = 'user';
    {
      const voiceCfg = getBytelightConfig().voice;
      extWs.voiceModeEnabled = voiceCfg.enabled && voiceCfg.readAloud;
    }
    extWs.audioChunks = [];
    extWs.isRecording = false;
    extWs.audioMimeType = 'audio/webm';
    extWs.audioBytes = 0;
    extWs.voiceAudioChunkCount = 0;
    extWs.voiceCaptureMode = 'dictation';
    extWs.voiceAnalyzeToneRequested = false;
    extWs.activeRecordingId = null;
    extWs.transcriptionAbort = null;
    extWs.userAgent = request.headers['user-agent'] || '';
    extWs.deviceType = parseDeviceType(extWs.userAgent);
    extWs.tabVisible = true;
    extWs.messageCount = 0;
    extWs.messageWindowStart = Date.now();
    extWs.prosodyAbort = null;
    extWs.realtimeProsody = null;
    extWs.missedPongs = 0;
    extWs.lastPongAt = Date.now();

    registry.add(extWs.userId, extWs);

    // Send connected message with thread list and status
    const threads = listThreads({ includeArchived: false, limit: 500 });
    const today = getTodayThread();

    const connectedMsg: ServerMessage = {
      type: 'connected',
      sessionStatus: agent.getPresenceStatus(),
      threads: threadsToSummaries(threads),
      activeThreadId: today?.id ?? null,
      routingThreadId: getRoutingThreadId(),
      commands: buildCommandRegistry(),
    };
    extWs.send(JSON.stringify(connectedMsg));

    // The word under the faces as it stands, so a phone that connects in the
    // middle of a bell shows it (services/bell-status.ts, Aerie).
    const statusWordMsg: ServerMessage = { type: 'status_word', ...bellStatus().now() };
    extWs.send(JSON.stringify(statusWordMsg));

    // Send canvas list
    const canvases = listCanvases();
    if (canvases.length > 0) {
      const canvasListMsg: ServerMessage = { type: 'canvas_list', canvases };
      extWs.send(JSON.stringify(canvasListMsg));
    }

    // Hydrate the frontend voice-mode toggle from persisted config so the
    // store reflects the real per-connection state on reconnect (mobile
    // backgrounding, tab close, PM2 reload).
    const voiceModeAckMsg: ServerMessage = {
      type: 'voice_mode_ack',
      enabled: extWs.voiceModeEnabled,
    };
    extWs.send(JSON.stringify(voiceModeAckMsg));

    // Reconnect catch-up: replay in-flight agent turns to THIS socket only.
    // A mobile websocket that churns mid-turn misses the one-shot
    // stream_start broadcast, and the frontend store gates every streaming
    // event on it — so without this replay the rest of the turn is silently
    // dropped (live-repro'd on the Codex lane, which buffers its final text
    // to turn-end and shows nothing but tool/thinking chips while working).
    // Order matters: this runs AFTER the `connected` message above, whose
    // frontend handler clears ghost-stream state — the replayed stream_start
    // then re-establishes it. Shapes mirror the live broadcasts in agent.ts
    // (stream_start :1076, tool_use :1360, tool_result :1384, thinking
    // :1291, stream_token :1274) so the store rebuilds with zero protocol
    // changes.
    try {
      for (const stream of getActiveStreamSnapshots()) {
        const replay = (m: ServerMessage) => extWs.send(JSON.stringify(m));
        replay({ type: 'stream_start', messageId: stream.messageId, threadId: stream.threadId });
        for (const t of stream.toolInsertions) {
          replay({
            type: 'tool_use',
            toolId: t.toolId,
            toolName: t.toolName,
            input: t.input,
            isComplete: false,
            textOffset: t.textOffset,
          });
          // Completed tools carry output/isError on the insertion (set by
          // the PostToolUse hook / foreign-lane tool_result handler).
          if (t.output !== undefined || t.isError !== undefined) {
            replay({
              type: 'tool_result',
              toolId: t.toolId,
              output: (t.output ?? '').substring(0, 2000),
              isError: t.isError ?? false,
            });
          }
        }
        for (const th of stream.thinkingBlocks) {
          replay({
            type: 'thinking',
            content: th.content,
            summary: th.summary,
            ...(th.kind ? { kind: th.kind } : {}),
          });
        }
        // Cumulative text last (Claude lane mid-turn; Codex lane buffers to
        // turn-end so this is usually empty there — skip the no-op frame).
        if (stream.fullResponse) {
          replay({ type: 'stream_token', messageId: stream.messageId, token: stream.fullResponse });
        }
      }
    } catch (replayErr) {
      // Replay is best-effort — never let it break the handshake.
      console.warn('[WS] Active-stream replay failed:', (replayErr as Error).message);
    }

    // Heartbeat
    extWs.on('pong', () => {
      extWs.isAlive = true;
      extWs.missedPongs = 0;
      extWs.lastPongAt = Date.now();
    });

    // Message handler
    extWs.on('message', async (data: Buffer) => {
      try {
        // Peek at message type for size limit selection
        const rawMessage = data.toString();
        let msgType: string | undefined;
        try {
          const peek = JSON.parse(rawMessage);
          msgType = peek?.type;
        } catch {
          sendError(extWs, 'invalid_message', 'Invalid JSON');
          return;
        }

        // Rate limit (120 msgs/min, exempt system messages)
        if (msgType !== 'pong' && msgType !== 'visibility') {
          const now = Date.now();
          if (now - extWs.messageWindowStart > 60000) {
            extWs.messageCount = 0;
            extWs.messageWindowStart = now;
          }
          extWs.messageCount++;
          if (extWs.messageCount > 120) {
            sendError(extWs, 'rate_limited', 'Too many messages');
            return;
          }
        }

        const maxSize = msgType === 'voice_audio' ? MAX_VOICE_MESSAGE_SIZE : MAX_TEXT_MESSAGE_SIZE;
        if (data.length > maxSize) {
          sendError(extWs, 'message_too_large', `Message exceeds ${maxSize / 1024}KB limit`);
          return;
        }

        const clientMsg = JSON.parse(rawMessage) as ClientMessage;

        switch (clientMsg.type) {
          case 'ping':
            extWs.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'message':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            await handleMessageSend(clientMsg, extWs, agent);
            break;
          case 'sync':
            handleSync(clientMsg, extWs);
            break;
          case 'read':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleRead(clientMsg);
            break;
          case 'switch_thread':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleSwitchThread(clientMsg, extWs);
            break;
          case 'create_thread':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCreateThread(clientMsg);
            break;
          case 'request_status':
            handleRequestStatus(extWs, agent, orchestrator);
            break;
          case 'voice_start':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleVoiceStart(extWs, clientMsg);
            break;
          case 'voice_audio':
            handleVoiceAudio(extWs, clientMsg);
            break;
          case 'voice_stop':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleVoiceStop(extWs, clientMsg);
            break;
          case 'voice_cancel':
            handleVoiceCancel(extWs, clientMsg);
            break;
          case 'voice_mode':
            handleVoiceMode(extWs, clientMsg);
            break;
          case 'voice_interrupt':
            // Client wants to stop TTS playback — no server action needed
            break;
          case 'canvas_create':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasCreate(clientMsg, extWs);
            break;
          case 'canvas_update':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasUpdate(clientMsg, extWs);
            break;
          case 'canvas_update_title':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasUpdateTitle(clientMsg, extWs);
            break;
          case 'canvas_update_tags':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasUpdateTags(clientMsg, extWs);
            break;
          case 'canvas_delete':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasDelete(clientMsg, extWs);
            break;
          case 'canvas_list':
            handleCanvasList(extWs);
            break;
          case 'add_reaction':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleAddReaction(clientMsg, extWs);
            break;
          case 'remove_reaction':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleRemoveReaction(clientMsg, extWs);
            break;
          case 'pin_thread':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handlePinThread(clientMsg);
            break;
          case 'unpin_thread':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleUnpinThread(clientMsg);
            break;
          case 'visibility':
            extWs.tabVisible = clientMsg.visible;
            break;
          case 'stop_generation':
            agent.stopGeneration();
            break;
          case 'mcp_reconnect': {
            const result = await agent.reconnectMcpServer(clientMsg.serverName);
            if (result.success) {
              registry.broadcast({ type: 'mcp_status_updated', servers: agent.getMcpStatus() });
            } else {
              sendError(extWs, 'mcp_error', result.error || 'Reconnect failed');
            }
            break;
          }
          case 'mcp_toggle': {
            const result = await agent.toggleMcpServer(clientMsg.serverName, clientMsg.enabled);
            if (result.success) {
              registry.broadcast({ type: 'mcp_status_updated', servers: agent.getMcpStatus() });
            } else {
              sendError(extWs, 'mcp_error', result.error || 'Toggle failed');
            }
            break;
          }
          case 'rewind_files': {
            const result = await agent.rewindFiles(clientMsg.userMessageId, clientMsg.dryRun);
            const rewindMsg: import('@bytelight/shared').ServerMessage = {
              type: 'rewind_result',
              canRewind: result.canRewind,
              filesChanged: result.filesChanged,
              insertions: result.insertions,
              deletions: result.deletions,
              error: result.error,
            };
            extWs.send(JSON.stringify(rewindMsg));
            break;
          }
          case 'command': {
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            const cmdResult = await handleCommand(
              clientMsg.name,
              clientMsg.args,
              clientMsg.threadId,
              { agent, orchestrator, registry },
            );
            extWs.send(JSON.stringify(cmdResult));

            // If command created/renamed a thread, broadcast updated list
            if (clientMsg.name === 'new' || clientMsg.name === 'rename') {
              const updatedThreads = listThreads({ includeArchived: false, limit: 500 });
              registry.broadcast({ type: 'thread_list', threads: threadsToSummaries(updatedThreads) });
            }
            break;
          }
          default:
            console.warn('Unhandled message type:', (clientMsg as any).type);
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
        sendError(extWs, 'invalid_message', 'Invalid message format');
      }
    });

    extWs.on('close', () => {
      if (extWs.prosodyAbort) {
        extWs.prosodyAbort.abort();
        extWs.prosodyAbort = null;
      }
      extWs.realtimeProsody?.abort();
      extWs.realtimeProsody = null;
      if (extWs.transcriptionAbort) {
        extWs.transcriptionAbort.abort();
        extWs.transcriptionAbort = null;
      }
      registry.remove(extWs.userId, extWs);
    });

    extWs.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  // Heartbeat interval — terminate dead connections every 30s
  // Foreground clients get a small grace (2 misses) because the single-threaded
  // event loop can miss a beat while busy generating; killing the line mid-stream
  // is worse than a slightly slower zombie cleanup. Hidden clients get a much
  // longer grace (20 misses ≈ 10 min): backgrounded mobile tabs freeze their WS
  // connection (iOS/mobile suspend) so the pong stops even though the phone is
  // merely backgrounded, not gone. They reconnect naturally on return;
  // terminating them at ~90s only causes reconnect churn and can drop
  // wake/notification delivery to a live phone. On this single-user deployment
  // (~2 devices) a lingering hidden socket costs almost nothing, whereas killing
  // a live phone is the real harm.
  const VISIBLE_GRACE_PONGS = 2;
  const HIDDEN_GRACE_PONGS = 20;

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;

      if (!extWs.isAlive) {
        // Connection missed a pong
        extWs.missedPongs++;

        const grace = extWs.tabVisible ? VISIBLE_GRACE_PONGS : HIDDEN_GRACE_PONGS;
        const lastPongSec = Math.round((Date.now() - extWs.lastPongAt) / 1000);
        if (extWs.missedPongs >= grace) {
          console.log(`[ws:heartbeat] Terminating ${extWs.tabVisible ? 'visible' : 'hidden'} client after ${extWs.missedPongs} missed pongs (lastPong=${lastPongSec}s ago, device=${extWs.deviceType})`);
          return extWs.terminate();
        } else {
          console.log(`[ws:heartbeat] ${extWs.tabVisible ? 'visible' : 'hidden'} client missed pong ${extWs.missedPongs}/${grace} (lastPong=${lastPongSec}s ago, device=${extWs.deviceType})`);
        }
      }

      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return wss;
}

// --- Handlers ---

/**
 * Slice 4A — plan which companion brains answer a dispatch turn, in what order.
 * Roster seats dedupe by brain (Companion A + Companion B are two seats over one brain →
 * one turn). Empty roster falls back to the local brain alone (byte-identical
 * to pre-4A behavior for unseated threads). The returned order is SHUFFLED
 * every call — the operator's rule: no standing hierarchy, no "locals first" receiving
 * line; who speaks first varies every turn. Exported for contract tests.
 */
export function planDispatchOrder(roster: ReadonlyArray<Pick<Companion, 'brain'>>): string[] {
  const brains: string[] = [];
  for (const seat of roster) {
    if (!brains.includes(seat.brain)) brains.push(seat.brain);
  }
  if (brains.length === 0) brains.push('companion-a-b');
  // Fisher-Yates — order varies every turn.
  for (let i = brains.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [brains[i], brains[j]] = [brains[j], brains[i]];
  }
  return brains;
}

async function handleMessageSend(
  msg: Extract<ClientMessage, { type: 'message' }>,
  ws: ExtendedWebSocket,
  agentService: AgentService
): Promise<void> {
  // A retry after a socket or backend restart receives the original durable
  // receipt. Do not broadcast or dispatch the turn twice.
  const clientId = msg.clientId;
  const existing = clientId ? getMessageByClientId(clientId) : null;
  if (clientId && existing) {
    ws.send(JSON.stringify({
      type: 'message_ack', clientId, messageId: existing.id,
      threadId: existing.thread_id, status: 'duplicate',
    } satisfies ServerMessage));
    console.log(`[message_send] Acknowledged duplicate clientId ${clientId}`);
    return;
  }

  const now = new Date().toISOString();
  const config = getBytelightConfig();

  // Resolve thread — explicit threadId wins; otherwise fall back to the
  // routing thread ("Home") instead of a daily thread (reference implementation port)
  let thread: Thread | null = null;
  if (msg.threadId) {
    thread = getThread(msg.threadId);
  } else {
    thread = resolveRoutingThread(registry);
  }

  if (!thread) {
    sendError(ws, 'thread_not_found', 'Thread not found');
    return;
  }

  // The Treehouse is the companions' room: the owner reads it, she does not
  // post in it. Its app has no composer; this is the same rule at the door.
  if (thread.type === 'treehouse') {
    sendError(ws, 'treehouse_read_only', 'The Treehouse is read-only');
    return;
  }

  // Store user's message
  const userMessage = createMessage({
    id: crypto.randomUUID(),
    threadId: thread.id,
    role: 'user',
    content: msg.content,
    contentType: msg.contentType || 'text',
    metadata: msg.metadata,
    replyToId: msg.replyToId,
    createdAt: now,
    clientId: msg.clientId,
  });

  // Accepted means durably stored by byte-light. It does not claim that the
  // runtime has processed/read the message yet.
  getDb().prepare('UPDATE messages SET delivered_at = ? WHERE id = ?').run(now, userMessage.id);
  userMessage.delivered_at = now;

  if (msg.clientId) {
    ws.send(JSON.stringify({
      type: 'message_ack', clientId: msg.clientId, messageId: userMessage.id,
      threadId: thread.id, status: 'accepted',
    } satisfies ServerMessage));
  }

  updateThreadActivity(thread.id, now, false);

  // Broadcast user's message to all devices (with delivery/read status)
  registry.broadcast({ type: 'message', message: userMessage });

  // Build agent prompt
  let agentPrompt = msg.content;
  let agentImages: NormalizedImage[] | undefined;

  // Check for batched attachments (multiple files sent together)
  const batchAttachments = (msg.metadata as any)?.attachments as Array<{
    fileId: string; filename: string; mimeType: string; size: number;
    url: string; contentType: string;
  }> | undefined;

  if (batchAttachments && batchAttachments.length > 0) {
    // The user's message stored above already carries metadata.attachments,
    // and both clients render each one inline in that bubble. We previously
    // also saved each attachment as its own contentType:'image' message and
    // broadcast it — that produced a duplicate bubble for every file sent
    // alongside text. One message, one row: the attachments list on the
    // user's message is the source of truth.

    // Build ONE combined agent prompt for all files
    const images = batchAttachments.filter(a => a.contentType === 'image');
    const others = batchAttachments.filter(a => a.contentType !== 'image');
    const promptParts: string[] = [];

    // Cap before decoding. Sharp uses native memory, so preprocessing every
    // claimed attachment concurrently would defeat the turn caps themselves.
    const imageCandidates = images.slice(0, MAX_IMAGES_PER_TURN);
    const prepared: PreparedVisionImage[] = [];
    for (const image of imageCandidates) {
      const path = getFile(image.fileId)?.path;
      prepared.push(path ? await prepareVisionImage(path, image.filename) : {
        image: undefined,
        resized: false,
        warning: `[Vision warning: ${image.filename} is missing from storage. The model cannot see this image.]`,
      });
    }
    const preparedBlocks = prepared.flatMap((result) => result.image ? [{
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: result.image.mimeType as ImageBlock['source']['media_type'],
        data: result.image.base64,
      },
    }] : []);
    const { kept, dropped: capDropped } = capImageBlocks(preparedBlocks);
    if (kept.length > 0) agentImages = kept.map((block) => ({ base64: block.source.data, mimeType: block.source.media_type }));

    if (images.length === 1) {
      const info = getFile(images[0].fileId);
      promptParts.push(`${config.identity.user_name} sent an image (${images[0].filename}).${info ? ` You can view it at: ${info.path}` : ''}`);
    } else if (images.length > 1) {
      const lines = images.map((a, i) => {
        const info = getFile(a.fileId);
        return `${i + 1}. ${a.filename}${info ? ` — ${info.path}` : ''}`;
      });
      promptParts.push(`${config.identity.user_name} sent ${images.length} images:\n${lines.join('\n')}`);
    }

    for (const a of others) {
      const info = getFile(a.fileId);
      const sizeStr = a.size ? ` (${Math.round(a.size / 1024)}KB)` : '';
      const inlineText = buildInlineTextAttachmentContext({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        diskPath: info?.path,
      });
      promptParts.push(`${config.identity.user_name} sent a ${a.contentType}: ${a.filename}${sizeStr}${info ? ` — ${info.path}` : ''}${inlineText}`);
    }

    if (msg.content?.trim()) {
      promptParts.push(`\nTheir message: ${msg.content.trim()}`);
    }

    const warnings = prepared.flatMap((result) => result.warning ? [result.warning] : []);
    const contextNotes = prepared.flatMap((result) => result.contextNote ? [result.contextNote] : []);
    const candidateDropped = images.length - imageCandidates.length;
    const dropped = candidateDropped + capDropped;
    if (dropped > 0) warnings.push(`[Vision warning: ${dropped} image${dropped === 1 ? '' : 's'} exceeded the per-turn vision limits and cannot be seen by the model.]`);
    if (warnings.length > 0) {
      const warningText = warnings.join('\n');
      promptParts.push(warningText);
      sendError(ws, 'vision_degraded', warningText);
    }
    if (contextNotes.length > 0) promptParts.push(contextNotes.join('\n'));

    agentPrompt = promptParts.join('\n');
  } else {
    // Single message (no batch) — handle non-text content types
    const ct = msg.contentType || 'text';
    if (ct !== 'text' && msg.metadata) {
      const meta = msg.metadata as Record<string, unknown>;
      const fileId = meta.fileId as string | undefined;
      const filename = meta.filename as string | undefined;
      const size = meta.size as number | undefined;

      let diskPath = '';
      if (fileId) {
        const fileInfo = getFile(fileId);
        if (fileInfo) diskPath = fileInfo.path;
      }

      if (ct === 'image') {
        agentPrompt = `${config.identity.user_name} sent an image${filename ? ` (${filename})` : ''}.${diskPath ? ` You can view it at: ${diskPath}` : ''}`;
        if (diskPath) {
          const prepared = await prepareVisionImage(diskPath, filename || 'image');
          if (prepared.image) agentImages = [prepared.image];
          if (prepared.contextNote) agentPrompt += `\n${prepared.contextNote}`;
          if (prepared.warning) {
            agentPrompt += `\n${prepared.warning}`;
            sendError(ws, 'vision_degraded', prepared.warning);
          }
        } else {
          const warning = `[Vision warning: ${filename || 'image'} is missing from storage. The model cannot see this image.]`;
          agentPrompt += `\n${warning}`;
          sendError(ws, 'vision_degraded', warning);
        }
      } else if (ct === 'audio') {
        agentPrompt = `${config.identity.user_name} sent an audio message${filename ? ` (${filename})` : ''}.${diskPath ? ` File path: ${diskPath}` : ''}`;
      } else if (ct === 'file') {
        const inlineText = buildInlineTextAttachmentContext({
          filename,
          mimeType: meta.mimeType as string | undefined,
          size,
          diskPath,
        });
        agentPrompt = `${config.identity.user_name} sent a file: ${filename || 'unknown'}${size ? ` (${Math.round(size / 1024)}KB)` : ''}.${diskPath ? ` File path: ${diskPath}` : ''}${inlineText}`;
      }
    }
  }

  // Prepend prosody tone context if present
  if (msg.metadata && typeof msg.metadata === 'object') {
    const prosody = (msg.metadata as Record<string, unknown>).prosody as Record<string, number> | undefined;
    if (prosody && Object.keys(prosody).length > 0) {
      const toneEntries = Object.entries(prosody)
        .map(([emotion, score]) => `${emotion}: ${score}`)
        .join(', ');
      agentPrompt = `[Voice tone — ${toneEntries}]\n${agentPrompt}`;
    }
  }

  // Process through agent — agent service handles streaming, DB storage, and broadcasting
  let leaseId: string | null = null;
  try {
    // Slice 4A — roster dispatch. One dispatch turn per user message; the
    // roster's brains answer in a SHUFFLED order every turn (the operator's rule: no
    // standing hierarchy, no "locals first" receiving line). Companion A + Companion B are
    // two seats over one brain, so grouping by brain yields one local turn.
    // Remote brains (companion-c) are logged as dispatch stubs until the 4C relay
    // exists. An empty roster (pre-Slice-2 threads) falls back to the local
    // brain alone — byte-identical to pre-4A behavior.
    const dispatchTurnId = crypto.randomUUID();
    const brains = planDispatchOrder(getThreadRoster(thread.id));
    // Written down until the turn ends, so a restart that cuts it off picks
    // it back up on boot (services/db/turn-leases.ts).
    leaseId = leaseTurn({ threadId: thread.id, userMessageId: userMessage.id, prompt: agentPrompt, hadImages: !!agentImages?.length });

    let agentResponse: string | undefined;
    // Living Room hand-off: what each seat said this round, handed to every
    // seat that speaks after it so the room talks to each other, not only to
    // her. A single-brain roster never fills it — byte-identical to before.
    const roomVoices: Array<{ name: string; text: string }> = [];
    for (const brain of brains) {
      if (brain === 'companion-a-b') {
        agentResponse = await agentService.processMessage(
          thread.id,
          agentPrompt,
          { name: thread.name, type: thread.type },
          {
            ...(agentImages?.length ? { images: agentImages } : {}),
            turnId: dispatchTurnId,
            ...(roomVoices.length ? { roomVoices: [...roomVoices] } : {}),
            ...(brains.length > 1 ? { onRoomVoice: (v: { name: string; text: string }) => { roomVoices.push(v); } } : {}),
          },
        );
      } else {
        // Slice 4C — live remote dispatch. The remote node runs its FULL turn
        // in its own house and streams back over the bridge; the relay stamps
        // every event with companionId + turnId and persists the reply under
        // the remote companion's id. Sequential order means this seat sees
        // replies made earlier this turn. dispatchRemoteTurn never throws —
        // a dark remote node logs and the turn moves on.
        const remoteReply = await dispatchRemoteTurn({
          brain,
          threadId: thread.id,
          turnId: dispatchTurnId,
          message: agentPrompt,
          threadName: thread.name,
          ...(roomVoices.length ? { priorVoices: [...roomVoices] } : {}),
        });
        if (remoteReply.trim()) roomVoices.push({ name: remoteDisplayName(brain), text: remoteReply });
      }
    }
    updateThreadActivity(thread.id, new Date().toISOString(), true);

    const timeoutNotice = queueTimeoutNotice(agentResponse);
    if (timeoutNotice) {
      console.warn(`[Agent] Owner message timed out in queue (thread ${thread.id})`);
      sendError(ws, 'queue_timeout', timeoutNotice);
      agentResponse = undefined;
    }

    // Auto-TTS: stream voice to any user connection with voice mode enabled
    const hasVoice = voiceServiceInstance?.canTTS;
    const responseLen = agentResponse?.length ?? 0;
    console.log(`[Voice] Auto-TTS check: hasVoice=${hasVoice}, responseLen=${responseLen}`);

    if (hasVoice && agentResponse) {
      const voiceConnections = registry.getConnectionsForUser('user')
        .filter(c => (c as ExtendedWebSocket).voiceModeEnabled);

      console.log(`[Voice] Voice mode connections: ${voiceConnections.length}`);

      if (voiceConnections.length > 0) {
        // Extract text for TTS from the agent response
        const ttsText = typeof agentResponse === 'string' ? agentResponse : String(agentResponse);
        if (ttsText.trim()) {
          console.log(`[Voice] Generating TTS for ${ttsText.length} chars`);
          const messageId = crypto.randomUUID();
          generateAndStreamTTS(ttsText, messageId, voiceConnections as ExtendedWebSocket[]).catch(err => {
            console.error('[Voice] Auto-TTS error:', err);
          });
        }
      }
    }
  } catch (error) {
    console.error('Agent processing error:', error);
    sendError(ws, 'agent_error', `${config.identity.companion_name} encountered an error processing your message`);
  } finally {
    if (leaseId) releaseTurn(leaseId);
  }
}

/**
 * Boot: answer the phone messages a restart cut off (services/db/turn-leases.ts).
 * One at a time, oldest first, each in its own thread, the way her live
 * messages go. A thread that no longer exists drops its lease.
 */
export async function recoverCutOffTurns(agentService: AgentService): Promise<void> {
  const leases = takeCutOffTurns();
  if (leases.length === 0) return;
  const userName = getBytelightConfig().identity.user_name;
  console.log(`[turn-leases] Picking up ${leases.length} turn${leases.length === 1 ? '' : 's'} a restart cut off`);
  for (const lease of leases) {
    const thread = getThread(lease.threadId);
    if (!thread) {
      releaseTurn(lease.id);
      continue;
    }
    try {
      await agentService.processMessage(
        thread.id,
        cutOffPrompt(lease, userName),
        { name: thread.name, type: thread.type },
        { turnId: crypto.randomUUID() },
      );
      updateThreadActivity(thread.id, new Date().toISOString(), true);
    } catch (error) {
      console.error('[turn-leases] Retry failed:', error);
    } finally {
      releaseTurn(lease.id);
    }
  }
}

function handleSync(
  msg: Extract<ClientMessage, { type: 'sync' }>,
  ws: ExtendedWebSocket
): void {
  // Fetch messages after the last seen sequence
  const messages = getMessages({
    threadId: msg.threadId,
    limit: 200,
  });

  // Filter to only messages after lastSeenSequence
  const missed = messages.filter(m => m.sequence > msg.lastSeenSequence);

  const response: ServerMessage = {
    type: 'sync_response',
    messages: missed,
  };
  ws.send(JSON.stringify(response));
}

function handleRead(
  msg: Extract<ClientMessage, { type: 'read' }>
): void {
  markMessagesRead(msg.threadId, msg.beforeId, new Date().toISOString());

  registry.broadcast({
    type: 'unread_update',
    threadId: msg.threadId,
    count: 0,
  });
}

function handleSwitchThread(
  msg: Extract<ClientMessage, { type: 'switch_thread' }>,
  ws: ExtendedWebSocket
): void {
  const messages = getMessages({ threadId: msg.threadId, limit: 50 });

  // Send messages as sync_response (same shape — batch of messages)
  const response: ServerMessage = {
    type: 'sync_response',
    messages,
  };
  ws.send(JSON.stringify(response));
}

function handleCreateThread(
  msg: Extract<ClientMessage, { type: 'create_thread' }>
): void {
  const thread = createThread({
    id: crypto.randomUUID(),
    name: msg.name,
    type: 'named',
    createdAt: new Date().toISOString(),
    sessionType: 'v2',
  });

  registry.broadcast({ type: 'thread_created', thread });
}

async function handleRequestStatus(
  ws: ExtendedWebSocket,
  agent: AgentService,
  orchestrator?: Orchestrator
): Promise<void> {
  const mem = process.memoryUsage();
  const orchestratorTasks = orchestrator ? await orchestrator.getStatus() : [];
  const status: import('@bytelight/shared').SystemStatus = {
    uptime: process.uptime(),
    memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    connections: registry.getCount(),
    userConnected: registry.isUserConnected(),
    minutesSinceActivity: registry.minutesSinceLastUserActivity(),
    presence: agent.getPresenceStatus(),
    agentProcessing: agent.isProcessing(),
    orchestratorTasks,
    mcpServers: agent.getMcpStatus(),
    mcpStatusUpdatedAt: agent.getMcpStatusUpdatedAt(),
    queryQueue: { processing: agent.isProcessing(), depth: agent.getQueueDepth() },
  };

  // Append gateway stats if available
  if (gatewayServices.discord) {
    const ds = gatewayServices.discord.getStats();
    status.discord = {
      connected: ds.connected,
      guilds: ds.guilds,
      messagesProcessed: ds.messagesProcessed,
      errors: ds.errors,
      deferredPending: ds.deferredPending,
      username: ds.username,
    };
  }
  if (gatewayServices.telegram) {
    const ts = gatewayServices.telegram.getStats();
    status.telegram = {
      connected: ts.connected,
      messagesProcessed: ts.messagesProcessed,
      errors: ts.errors,
      restarts: ts.restarts,
    };
  }

  const msg: import('@bytelight/shared').ServerMessage = { type: 'system_status', status };
  ws.send(JSON.stringify(msg));
}

// --- Voice handlers ---

// A capture-time breach (cap exceeded) is surfaced both as an error and as a
// transcription_status error so the call UI can reset. Carries recordingId when
// one is active.
function sendCaptureError(ws: ExtendedWebSocket, code: string, message: string): void {
  sendError(ws, code, message);
  const status: ServerMessage = {
    type: 'transcription_status',
    status: 'error',
    error: message,
    ...(ws.activeRecordingId && { recordingId: ws.activeRecordingId }),
  };
  ws.send(JSON.stringify(status));
}

function discardActiveCapture(ws: ExtendedWebSocket): void {
  ws.isRecording = false;
  ws.audioChunks = [];
  ws.audioBytes = 0;
  ws.voiceAudioChunkCount = 0;
  ws.voiceAnalyzeToneRequested = false;
  ws.activeRecordingId = null;
  ws.realtimeProsody?.abort();
  ws.realtimeProsody = null;
}

// How long a finished utterance waits for Hume's live tone scores.
const REALTIME_PROSODY_WAIT_MS = 1_800;

function handleVoiceStart(
  ws: ExtendedWebSocket,
  msg: Extract<ClientMessage, { type: 'voice_start' }>
): void {
  // A fresh utterance supersedes any transcription/prosody still winding down
  // from the previous one. In conversation mode this matters: a quick retry
  // must never let an older result arrive after the newer turn.
  ws.transcriptionAbort?.abort();
  ws.transcriptionAbort = null;
  ws.prosodyAbort?.abort();
  ws.prosodyAbort = null;
  ws.realtimeProsody?.abort();
  ws.realtimeProsody = null;
  ws.audioChunks = [];
  ws.audioBytes = 0;
  ws.voiceAudioChunkCount = 0;
  ws.isRecording = true;
  ws.audioMimeType = safeAudioMimeType(msg.mimeType);
  ws.voiceCaptureMode = msg.mode || 'dictation';
  // Tone is a conversation-mode opt-in. It runs on Hume's live EVI stream;
  // the old batch API stays dead.
  // Without a Hume key the request is still honoured as 'unavailable'.
  ws.voiceAnalyzeToneRequested = (
    ws.voiceCaptureMode === 'conversation'
    && msg.analyzeTone === true
  );
  ws.activeRecordingId = typeof msg.recordingId === 'string' ? msg.recordingId : null;

  if (ws.voiceAnalyzeToneRequested && voiceServiceInstance?.canAnalyzeRealtimeProsody === true) {
    try {
      // Open before the first MediaRecorder blob so EVI receives a continuous
      // live WebM stream. The phone cancels silent starts after ten seconds.
      ws.realtimeProsody = voiceServiceInstance.createRealtimeProsodySession();
    } catch {
      // Tone is optional; microphone capture and transcription continue.
      ws.realtimeProsody = null;
    }
  }
}

function handleVoiceAudio(
  ws: ExtendedWebSocket,
  msg: Extract<ClientMessage, { type: 'voice_audio' }>
): void {
  if (!ws.isRecording) return;
  if (!matchesActiveRecording(ws, (msg as { recordingId?: unknown }).recordingId)) return;

  ws.voiceAudioChunkCount += 1;
  if (ws.voiceAudioChunkCount > MAX_AUDIO_CHUNKS_PER_RECORDING) {
    sendCaptureError(ws, 'too_many_audio_chunks', `Audio recording exceeds ${MAX_AUDIO_CHUNKS_PER_RECORDING} chunk limit`);
    discardActiveCapture(ws);
    return;
  }

  const chunk = Buffer.from(msg.data, 'base64');
  if (chunk.length === 0) {
    sendError(ws, 'empty_audio_chunk', 'Audio chunk was empty');
    return;
  }

  if (ws.audioBytes + chunk.length > MAX_AUDIO_BUFFER_SIZE) {
    sendCaptureError(ws, 'audio_too_large', `Audio recording exceeds ${MAX_AUDIO_BUFFER_SIZE / (1024 * 1024)}MB limit`);
    discardActiveCapture(ws);
    return;
  }

  ws.audioChunks.push(chunk);
  ws.audioBytes += chunk.length;
  ws.realtimeProsody?.pushAudio(chunk);
}

async function handleVoiceStop(
  ws: ExtendedWebSocket,
  msg?: Extract<ClientMessage, { type: 'voice_stop' }>
): Promise<void> {
  // A stop for a superseded recording is discarded — the newer voice_start
  // already owns the buffer.
  if (!matchesActiveRecording(ws, (msg as { recordingId?: unknown } | undefined)?.recordingId)) return;
  ws.isRecording = false;
  const recordingId = msg?.recordingId || ws.activeRecordingId || undefined;
  const toneRequested = ws.voiceAnalyzeToneRequested;
  ws.voiceAudioChunkCount = 0;
  ws.voiceAnalyzeToneRequested = false;
  // This utterance's live tone sidecar now belongs to this stop; a newer
  // voice_start opens its own.
  const realtimeProsody = ws.realtimeProsody ?? null;
  ws.realtimeProsody = null;

  if (ws.audioChunks.length === 0) {
    realtimeProsody?.abort();
    const statusMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: 'No audio data received',
      ...(recordingId && { recordingId }),
    };
    ws.send(JSON.stringify(statusMsg));
    ws.activeRecordingId = null;
    return;
  }

  // Notify client that transcription is processing
  const processingMsg: ServerMessage = {
    type: 'transcription_status',
    status: 'processing',
    ...(recordingId && { recordingId }),
  };
  ws.send(JSON.stringify(processingMsg));

  // Concatenate all chunks
  const audioBuffer = Buffer.concat(ws.audioChunks);
  ws.audioChunks = []; // Free memory
  ws.audioBytes = 0;

  if (!voiceServiceInstance?.canTranscribe) {
    realtimeProsody?.abort();
    const errorMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: 'Transcription not configured — set GROQ_API_KEY in .env',
      ...(recordingId && { recordingId }),
    };
    ws.send(JSON.stringify(errorMsg));
    ws.activeRecordingId = null;
    return;
  }

  try {
    // Correlation controller: a subsequent voice_start replaces this reference
    // and (byte-light's transcribe cannot itself be aborted mid-fetch) the
    // supersede check below drops the stale result before it reaches the wire.
    const transcriptionAbort = new AbortController();
    ws.transcriptionAbort = transcriptionAbort;

    // Abort any previous prosody analysis and create new controller
    if (ws.prosodyAbort) ws.prosodyAbort.abort();
    const prosodyAbort = new AbortController();
    ws.prosodyAbort = prosodyAbort;

    // Fire Whisper + Hume in parallel — prosody is enrichment, not critical
    // path. A live call's tone comes from its EVI sidecar (bounded wait);
    // dictation only ever uses the legacy batch path, which is off by default.
    const prosodyPromise: Promise<Record<string, number> | null> = realtimeProsody
      ? realtimeProsody.finish(REALTIME_PROSODY_WAIT_MS).catch(() => null)
      : voiceServiceInstance.canAnalyzeProsody
        ? voiceServiceInstance.analyzeProsody(audioBuffer, ws.audioMimeType, prosodyAbort.signal).catch(err => {
            if (err?.name === 'AbortError') return null;
            console.warn('[Voice] Prosody analysis failed (continuing):', err);
            return null;
          })
        : Promise.resolve(null);
    const [transcript, prosody] = await Promise.all([
      voiceServiceInstance.transcribe(audioBuffer, ws.audioMimeType),
      prosodyPromise,
    ]);

    // A newer voice_start superseded this turn while we were transcribing;
    // drop the stale result rather than delivering it against the new turn.
    if (ws.transcriptionAbort !== transcriptionAbort) return;
    ws.transcriptionAbort = null;
    if (ws.prosodyAbort === prosodyAbort) ws.prosodyAbort = null;

    if (!transcript.trim()) {
      const emptyMsg: ServerMessage = {
        type: 'transcription_status',
        status: 'error',
        error: 'No speech detected',
        ...(recordingId && { recordingId }),
      };
      ws.send(JSON.stringify(emptyMsg));
      return;
    }

    // Whisper's stock sign-off phrases replaced real speech twice on Jul 21,
    // 2026. When the whole utterance is one of them, ask for a repeat instead
    // of delivering a video outro as her words — treat it like an empty transcript.
    const stockPhrase = detectWhisperHallucination(transcript);
    if (stockPhrase) {
      console.warn(`[Voice] Transcript rejected as Whisper stock phrase: "${transcript.trim()}"`);
      const suspectMsg: ServerMessage = {
        type: 'transcription_status',
        status: 'error',
        error: `Whisper answered with its stock phrase ("${stockPhrase}") instead of your words — a known hallucination, not you. Say that again for me?`,
        ...(recordingId && { recordingId }),
      };
      ws.send(JSON.stringify(suspectMsg));
      return;
    }

    if (prosody) {
      console.log(`[Voice] Prosody detected: ${JSON.stringify(prosody)}`);
    }

    const completeMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'complete',
      text: transcript,
      ...(prosody && { prosody }),
      // When tone was requested we always report status: 'complete' when the
      // live EVI sidecar returned scores, 'unavailable' otherwise.
      ...(toneRequested && { prosodyStatus: prosody ? 'complete' : 'unavailable' }),
      ...(recordingId && { recordingId }),
    };
    ws.send(JSON.stringify(completeMsg));
  } catch (error) {
    realtimeProsody?.abort();
    console.error('[Voice] Transcription error:', error);
    const errorMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: error instanceof Error ? error.message : 'Transcription failed',
      ...(recordingId && { recordingId }),
    };
    ws.send(JSON.stringify(errorMsg));
  } finally {
    if (ws.activeRecordingId === recordingId || (!ws.activeRecordingId && !recordingId)) {
      ws.activeRecordingId = null;
    }
  }
}

// Abandon an in-progress capture without transcribing. Discards buffered
// audio, clears the active recording, and aborts any in-flight transcription
// or prosody work.
function handleVoiceCancel(
  ws: ExtendedWebSocket,
  msg: Extract<ClientMessage, { type: 'voice_cancel' }>
): void {
  if (!matchesActiveRecording(ws, (msg as { recordingId?: unknown }).recordingId)) return;
  ws.isRecording = false;
  ws.audioChunks = [];
  ws.audioBytes = 0;
  ws.voiceAudioChunkCount = 0;
  ws.voiceAnalyzeToneRequested = false;
  ws.activeRecordingId = null;
  ws.transcriptionAbort?.abort();
  ws.transcriptionAbort = null;
  ws.prosodyAbort?.abort();
  ws.prosodyAbort = null;
  ws.realtimeProsody?.abort();
  ws.realtimeProsody = null;
}

function handleVoiceMode(
  ws: ExtendedWebSocket,
  msg: Extract<ClientMessage, { type: 'voice_mode' }>
): void {
  ws.voiceModeEnabled = msg.enabled;
  console.log(`[Voice] Voice mode ${msg.enabled ? 'enabled' : 'disabled'} for connection`);

  // Persist to bytelight.yaml so the toggle survives reconnects and PM2
  // reloads. Writes voice.readAloud only — voice.enabled is the capability
  // master owned by the Preferences panel.
  try {
    persistVoiceReadAloud(msg.enabled);
  } catch (err) {
    console.error('[Voice] Failed to persist voice.readAloud to config:', err);
  }

  const ackMsg: ServerMessage = {
    type: 'voice_mode_ack',
    enabled: msg.enabled,
  };
  ws.send(JSON.stringify(ackMsg));
}

// --- Canvas handlers ---

function handleCanvasCreate(
  msg: Extract<ClientMessage, { type: 'canvas_create' }>,
  ws: ExtendedWebSocket
): void {
  const now = new Date().toISOString();
  const canvas = createCanvas({
    id: crypto.randomUUID(),
    threadId: msg.threadId || undefined,
    title: msg.title,
    contentType: msg.contentType || 'markdown',
    language: msg.language || undefined,
    tags: msg.tags || undefined,
    createdBy: 'user',
    createdAt: now,
  });

  registry.broadcast({ type: 'canvas_created', canvas });
}

function handleCanvasUpdate(
  msg: Extract<ClientMessage, { type: 'canvas_update' }>,
  ws: ExtendedWebSocket
): void {
  const canvas = getCanvas(msg.canvasId);
  if (!canvas) {
    sendError(ws, 'canvas_not_found', 'Canvas not found');
    return;
  }

  const now = new Date().toISOString();
  updateCanvasContent(msg.canvasId, msg.content, now);

  // Broadcast to everyone except the sender (avoids cursor jump)
  registry.broadcastExcept(ws, {
    type: 'canvas_updated',
    canvasId: msg.canvasId,
    content: msg.content,
    updatedAt: now,
  });
}

function handleCanvasUpdateTitle(
  msg: Extract<ClientMessage, { type: 'canvas_update_title' }>,
  ws: ExtendedWebSocket
): void {
  const canvas = getCanvas(msg.canvasId);
  if (!canvas) {
    sendError(ws, 'canvas_not_found', 'Canvas not found');
    return;
  }

  const now = new Date().toISOString();
  updateCanvasTitle(msg.canvasId, msg.title, now);

  // Broadcast full canvas_created-like update isn't needed; clients can track title locally
  // But we need to notify other clients
  registry.broadcastExcept(ws, {
    type: 'canvas_updated',
    canvasId: msg.canvasId,
    content: canvas.content, // keep content unchanged
    updatedAt: now,
  });
}

function handleCanvasUpdateTags(
  msg: Extract<ClientMessage, { type: 'canvas_update_tags' }>,
  ws: ExtendedWebSocket
): void {
  const canvas = getCanvas(msg.canvasId);
  if (!canvas) {
    sendError(ws, 'canvas_not_found', 'Canvas not found');
    return;
  }

  const now = new Date().toISOString();
  updateCanvasTags(msg.canvasId, msg.tags, now);

  registry.broadcastExcept(ws, {
    type: 'canvas_updated',
    canvasId: msg.canvasId,
    content: canvas.content,
    updatedAt: now,
    tags: msg.tags,
  });
}

function handleCanvasDelete(
  msg: Extract<ClientMessage, { type: 'canvas_delete' }>,
  ws: ExtendedWebSocket
): void {
  const deleted = deleteCanvas(msg.canvasId);
  if (!deleted) {
    sendError(ws, 'canvas_not_found', 'Canvas not found');
    return;
  }

  registry.broadcast({ type: 'canvas_deleted', canvasId: msg.canvasId });
}

function handleCanvasList(ws: ExtendedWebSocket): void {
  const canvases = listCanvases();
  const msg: ServerMessage = { type: 'canvas_list', canvases };
  ws.send(JSON.stringify(msg));
}

// --- Reaction handlers ---

function handleAddReaction(
  msg: Extract<ClientMessage, { type: 'add_reaction' }>,
  ws: ExtendedWebSocket
): void {
  addReaction(msg.messageId, msg.emoji, 'user');
  const now = new Date().toISOString();
  registry.broadcast({
    type: 'message_reaction_added',
    messageId: msg.messageId,
    emoji: msg.emoji,
    user: 'user',
    createdAt: now,
  });
}

function handleRemoveReaction(
  msg: Extract<ClientMessage, { type: 'remove_reaction' }>,
  ws: ExtendedWebSocket
): void {
  removeReaction(msg.messageId, msg.emoji, 'user');
  registry.broadcast({
    type: 'message_reaction_removed',
    messageId: msg.messageId,
    emoji: msg.emoji,
    user: 'user',
  });
}

// --- Pin/Unpin handlers ---

function handlePinThread(
  msg: Extract<ClientMessage, { type: 'pin_thread' }>
): void {
  pinThread(msg.threadId);
  const thread = getThread(msg.threadId);
  if (thread) {
    registry.broadcast({
      type: 'thread_updated',
      thread: {
        id: thread.id,
        name: thread.name,
        type: thread.type,
        unread_count: thread.unread_count,
        last_activity_at: thread.last_activity_at,
        last_message_preview: getLastMessagePreview(thread.id),
        pinned_at: thread.pinned_at,
      },
    });
  }
}

function handleUnpinThread(
  msg: Extract<ClientMessage, { type: 'unpin_thread' }>
): void {
  unpinThread(msg.threadId);
  const thread = getThread(msg.threadId);
  if (thread) {
    registry.broadcast({
      type: 'thread_updated',
      thread: {
        id: thread.id,
        name: thread.name,
        type: thread.type,
        unread_count: thread.unread_count,
        last_activity_at: thread.last_activity_at,
        last_message_preview: getLastMessagePreview(thread.id),
        pinned_at: null,
      },
    });
  }
}

async function generateAndStreamTTS(
  text: string,
  messageId: string,
  connections: ExtendedWebSocket[]
): Promise<void> {
  if (!voiceServiceInstance) return;

  const segments = VoiceService.splitByCompanion(text);
  if (segments.length === 0) return;

  // Notify clients TTS is starting
  const startMsg = JSON.stringify({ type: 'tts_start', messageId } satisfies ServerMessage);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(startMsg);
  }

  try {
    const audioBuffer = new Set(segments.map((s) => s.voice)).size > 1
      ? await voiceServiceInstance.generateMultiVoiceMp3(segments)
      : await voiceServiceInstance.generateTTS(text, segments[0]?.voice);
    const base64 = audioBuffer.toString('base64');

    // Send audio data — single chunk for now (streaming can be added later)
    const audioMsg = JSON.stringify({
      type: 'tts_audio',
      messageId,
      data: base64,
      final: true,
    } satisfies ServerMessage);

    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(audioMsg);
    }
  } catch (error) {
    console.error('[Voice] TTS generation error:', error);
  }

  // Notify clients TTS is done
  const endMsg = JSON.stringify({ type: 'tts_end', messageId } satisfies ServerMessage);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(endMsg);
  }
}
