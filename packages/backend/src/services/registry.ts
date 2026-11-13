import { WebSocket } from 'ws';
import type { ServerMessage } from '@bytelight/shared';

export interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  userId: string;
  voiceModeEnabled: boolean;
  audioChunks: Buffer[];
  isRecording: boolean;
  audioMimeType: string;
  // --- Call-mode capture state (reference implementation s3) ---
  // Byte counter and per-recording chunk counter enforce the capture caps.
  audioBytes: number;
  voiceAudioChunkCount: number;
  // 'dictation' keeps the classic one-shot path; 'conversation' is the live
  // call turn. Tone analysis is accepted but degrades silently — byte-light's
  // batch-Hume prosody is vendor-dead (gated behind VOICE_LEGACY_HUME_BATCH).
  voiceCaptureMode: 'dictation' | 'conversation';
  voiceAnalyzeToneRequested: boolean;
  // Correlates start/audio/stop/cancel for one utterance. A fresh voice_start
  // supersedes an older recording so a late result can never land on a newer
  // turn.
  activeRecordingId: string | null;
  // Aborts an in-flight transcription when a new utterance supersedes it.
  transcriptionAbort: AbortController | null;
  deviceType: 'mobile' | 'desktop' | 'unknown';
  userAgent: string;
  tabVisible: boolean;
  messageCount: number;
  messageWindowStart: number;
  prosodyAbort: AbortController | null;
  /** Live Hume tone sidecar for the current conversation-mode utterance, if opted in. */
  realtimeProsody?: import('./hume-realtime-prosody.js').RealtimeProsodySession | null;
  missedPongs: number; // Track consecutive missed pongs for hidden clients
  lastPongAt: number; // Timestamp of last pong received
}

export class ConnectionRegistry {
  private connections = new Map<string, Set<ExtendedWebSocket>>();
  private _lastUserActivity: Date = new Date();
  private _lastUserWebActivity: Date = new Date(0);

  add(userId: string, ws: ExtendedWebSocket): void {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(ws);
    if (userId === 'user') {
      this._lastUserActivity = new Date();
      this._lastUserWebActivity = new Date();
    }
  }

  remove(userId: string, ws: ExtendedWebSocket): void {
    const userConnections = this.connections.get(userId);
    if (userConnections) {
      userConnections.delete(ws);
      if (userConnections.size === 0) {
        this.connections.delete(userId);
      }
    }
  }

  touchUserActivity(): void {
    this._lastUserActivity = new Date();
  }

  touchUserWebActivity(): void {
    this._lastUserWebActivity = new Date();
  }

  minutesSinceLastUserWebActivity(): number {
    return (Date.now() - this._lastUserWebActivity.getTime()) / 60000;
  }

  broadcast(message: ServerMessage): void {
    const messageStr = JSON.stringify(message);
    for (const connections of this.connections.values()) {
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
        }
      }
    }
  }

  broadcastExcept(excludeWs: WebSocket, message: ServerMessage): void {
    const messageStr = JSON.stringify(message);
    for (const connections of this.connections.values()) {
      for (const ws of connections) {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
        }
      }
    }
  }

  getCount(): number {
    let count = 0;
    for (const connections of this.connections.values()) {
      count += connections.size;
    }
    return count;
  }

  hasConnections(): boolean {
    return this.getCount() > 0;
  }

  isUserConnected(): boolean {
    const userConns = this.connections.get('user');
    return !!userConns && userConns.size > 0;
  }

  getLastUserActivity(): Date {
    return this._lastUserActivity;
  }

  minutesSinceLastUserActivity(): number {
    return (Date.now() - this._lastUserActivity.getTime()) / 60000;
  }

  getConnectionsForUser(userId: string): ExtendedWebSocket[] {
    const conns = this.connections.get(userId);
    if (!conns) return [];
    return Array.from(conns).filter(ws => ws.readyState === WebSocket.OPEN);
  }

  getUserDeviceType(): 'mobile' | 'desktop' | 'unknown' {
    const conns = this.getConnectionsForUser('user');
    if (conns.length === 0) return 'unknown';
    // Return device type of most recent connection (last in set)
    return conns[conns.length - 1].deviceType;
  }

  isUserTabVisible(): boolean {
    const conns = this.getConnectionsForUser('user');
    return conns.some(c => c.tabVisible);
  }

  getUserPresenceState(): 'active' | 'idle' | 'offline' {
    if (!this.isUserConnected()) return 'offline';
    if (!this.isUserTabVisible()) return 'idle';
    if (this.minutesSinceLastUserActivity() < 5) return 'active';
    return 'idle';
  }
}

export const registry = new ConnectionRegistry();
