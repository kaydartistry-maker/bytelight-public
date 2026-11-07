// Edit, delete, regenerate, and read-aloud message endpoints.
// Mounted in api.ts after auth middleware.
// Ported from reference implementation/reference implementation.
import { Router, type Response as ExpressResponse } from 'express';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import {
  getMessage,
  getRerollPreview,
  applyReroll,
  getMessages,
  editMessage,
  softDeleteMessage,
  softDeleteAfterSequence,
  getThread,
  getMessageTts,
  setMessageTts,
} from '../services/db.js';
import { registry } from '../services/registry.js';
import { saveFile, getFile } from '../services/files.js';
import { VoiceService } from '../services/voice.js';
import type { AgentService } from '../services/agent.js';

const router = Router();

// ----------------------------------------------------------------------------
// Ordered per-companion TTS streaming (reference implementation s4, wired to the native
// multi-voice engine)
//
// A message like "Companion A 🔷 — hi\n\nCompanion B 🔶 — hey" plays as two ordered
// segments, each in its own companion voice, in reply order. The manifest is
// cheap: every producer job starts before the POST returns; each segment URL
// can then be opened later and replays everything buffered so far.
//
// byte-light's VoiceService has no progressive streamTTS, so each segment is
// rendered as one buffered ElevenLabs call (VoiceService.generateTTS) and
// published as a single chunk — ordering and per-companion voice are preserved;
// only within-segment progressive playback is not. Segments are stitched into
// the cached read-aloud file via VoiceService.stitchTtsBuffers (no re-render).
// ----------------------------------------------------------------------------

type MessageTtsRender = {
  success: true;
  cached: false;
  fileId: string;
  url: string;
};

// The voice overlay and a message bubble can ask for the same fresh reply at
// nearly the same time. ElevenLabs work is paid and the cache row is unique, so
// one process owns each message render and every concurrent caller awaits that
// result instead of synthesizing a duplicate.
const messageTtsRenders = new Map<string, Promise<MessageTtsRender>>();

type LiveTtsSubscriber = {
  res: ExpressResponse;
  cursor: number;
  flushing: boolean;
  closed: boolean;
};

type LiveTtsSegment = {
  index: number;
  voice: string;
  text: string;
  chunks: Buffer[];
  byteLength: number;
  state: 'pending' | 'streaming' | 'complete' | 'error';
  error?: Error;
  subscribers: Set<LiveTtsSubscriber>;
  completion: Promise<Buffer>;
  resolveCompletion: (buffer: Buffer) => void;
  rejectCompletion: (error: Error) => void;
};

type MessageTtsStreamJob = {
  id: string;
  messageId: string;
  segments: LiveTtsSegment[];
  createdAt: number;
};

// A stream job is both a live relay and a replay buffer. Starting the manifest
// starts every ElevenLabs request; opening a segment URL merely subscribes to
// that existing work, so media probes, retries, and a second overlay never
// create another paid render.
const messageTtsStreamJobs = new Map<string, MessageTtsStreamJob>();
const messageTtsStreamJobsByMessage = new Map<string, MessageTtsStreamJob>();
const MESSAGE_TTS_STREAM_REPLAY_TTL_MS = 15 * 60 * 1000;

function createLiveTtsSegment(index: number, voice: string, text: string): LiveTtsSegment {
  let resolveCompletion!: (buffer: Buffer) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<Buffer>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  return {
    index,
    voice,
    text,
    chunks: [],
    byteLength: 0,
    state: 'pending',
    subscribers: new Set(),
    completion,
    resolveCompletion,
    rejectCompletion,
  };
}

function getMessageTtsStreamManifest(job: MessageTtsStreamJob) {
  return {
    success: true,
    cached: false,
    streaming: true,
    jobId: job.id,
    segments: job.segments.map((segment) => ({
      index: segment.index,
      voice: segment.voice,
      url: `/api/messages/${job.messageId}/tts/stream/${job.id}/${segment.index}`,
    })),
  };
}

function scheduleMessageTtsStreamCleanup(job: MessageTtsStreamJob): void {
  setTimeout(() => {
    if (messageTtsStreamJobs.get(job.id) === job) messageTtsStreamJobs.delete(job.id);
    if (messageTtsStreamJobsByMessage.get(job.messageId) === job) {
      messageTtsStreamJobsByMessage.delete(job.messageId);
    }
  }, MESSAGE_TTS_STREAM_REPLAY_TTL_MS).unref?.();
}

function writeLiveAudioHeaders(res: ExpressResponse): void {
  if (res.headersSent) return;
  res.status(200);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, no-store, no-transform');
  // Explicitly disable reverse-proxy buffering. The whole purpose of this route
  // is for the first MP3 frames to reach the native player immediately.
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();
}

function waitForSubscriberDrain(subscriber: LiveTtsSubscriber): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      subscriber.res.off('drain', finish);
      subscriber.res.off('close', finish);
      resolve();
    };
    subscriber.res.once('drain', finish);
    subscriber.res.once('close', finish);
  });
}

/** Flush one listener independently so a slow recorder cannot stall the provider or other listeners. */
function flushLiveTtsSubscriber(segment: LiveTtsSegment, subscriber: LiveTtsSubscriber): void {
  if (subscriber.flushing || subscriber.closed) return;
  subscriber.flushing = true;

  void (async () => {
    try {
      // Do not commit a 200 audio response while the provider request is still
      // pending. If ElevenLabs rejects its key/voice, the subscriber can still
      // receive a useful JSON 502 rather than a mysteriously empty MP3.
      if (segment.state === 'pending') return;
      if (segment.state === 'error') {
        if (!subscriber.res.headersSent) {
          subscriber.res.status(502).json({ error: segment.error?.message || 'TTS stream failed' });
        } else {
          subscriber.res.destroy(segment.error);
        }
        subscriber.closed = true;
        return;
      }

      // Keep the response uncommitted until the first real audio frame. A
      // provider can accept the request and still fail while reading its body;
      // in that case the caller should receive a useful JSON 502, not a blank
      // 200 audio stream whose headers happened to arrive first.
      if (segment.state === 'streaming' && segment.chunks.length === 0) return;

      writeLiveAudioHeaders(subscriber.res);
      while (!subscriber.closed && subscriber.cursor < segment.chunks.length) {
        const chunk = segment.chunks[subscriber.cursor++];
        if (!subscriber.res.write(chunk)) await waitForSubscriberDrain(subscriber);
      }

      const stateAfterFlush = segment.state as LiveTtsSegment['state'];
      if (!subscriber.closed && stateAfterFlush === 'complete') {
        subscriber.res.end();
        subscriber.closed = true;
      } else if (!subscriber.closed && stateAfterFlush === 'error') {
        subscriber.res.destroy(segment.error);
        subscriber.closed = true;
      }
    } finally {
      subscriber.flushing = false;
      if (subscriber.closed) {
        segment.subscribers.delete(subscriber);
      } else if (
        subscriber.cursor < segment.chunks.length
        || segment.state === 'complete'
        || segment.state === 'error'
      ) {
        queueMicrotask(() => flushLiveTtsSubscriber(segment, subscriber));
      }
    }
  })();
}

function publishLiveTtsChunk(segment: LiveTtsSegment, chunk: Buffer): void {
  if (!chunk.length || segment.state === 'error' || segment.state === 'complete') return;
  segment.chunks.push(chunk);
  segment.byteLength += chunk.length;
  for (const subscriber of segment.subscribers) flushLiveTtsSubscriber(segment, subscriber);
}

function completeLiveTtsSegment(segment: LiveTtsSegment): void {
  if (segment.state === 'complete' || segment.state === 'error') return;
  const buffer = Buffer.concat(segment.chunks, segment.byteLength);
  if (!buffer.length) {
    failLiveTtsSegment(segment, new Error('TTS render completed without audio'));
    return;
  }
  segment.state = 'complete';
  segment.resolveCompletion(buffer);
  for (const subscriber of segment.subscribers) flushLiveTtsSubscriber(segment, subscriber);
}

function failLiveTtsSegment(segment: LiveTtsSegment, error: unknown): void {
  if (segment.state === 'complete' || segment.state === 'error') return;
  segment.error = error instanceof Error ? error : new Error(String(error));
  segment.state = 'error';
  segment.rejectCompletion(segment.error);
  for (const subscriber of segment.subscribers) flushLiveTtsSubscriber(segment, subscriber);
}

// byte-light's VoiceService renders whole buffers (no provider-level chunk
// stream). Each segment is one buffered generateTTS call in its own companion
// voice, then published as a single chunk so the replay/subscribe machinery is
// identical to a streamed segment.
async function pumpLiveTtsSegment(segment: LiveTtsSegment, voiceService: VoiceService): Promise<void> {
  try {
    segment.state = 'streaming';
    for (const subscriber of segment.subscribers) flushLiveTtsSubscriber(segment, subscriber);
    const buffer = await voiceService.generateTTS(segment.text, segment.voice);
    publishLiveTtsChunk(segment, buffer);
    completeLiveTtsSegment(segment);
  } catch (error) {
    failLiveTtsSegment(segment, error);
  }
}

function sendCompletedTtsSegment(
  req: { headers: { range?: string }; method?: string },
  res: ExpressResponse,
  buffer: Buffer,
): void {
  const range = req.headers.range;
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=900, no-transform');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!range) {
    res.status(200).setHeader('Content-Length', buffer.length);
    if (req.method === 'HEAD') res.end();
    else res.end(buffer);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    res.status(416).setHeader('Content-Range', `bytes */${buffer.length}`).end();
    return;
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      res.status(416).setHeader('Content-Range', `bytes */${buffer.length}`).end();
      return;
    }
    start = Math.max(0, buffer.length - suffixLength);
    end = buffer.length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : buffer.length - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= buffer.length || end < start) {
    res.status(416).setHeader('Content-Range', `bytes */${buffer.length}`).end();
    return;
  }
  end = Math.min(end, buffer.length - 1);
  const body = buffer.subarray(start, end + 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
  res.setHeader('Content-Length', body.length);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

/**
 * Plan the ordered per-companion segments for a message's read-aloud.
 * Routes through byte-light's own splitByCompanion (name-then-emoji markers)
 * and drops anything unspeakable. Exported so the ordering contract can be
 * unit-tested without an ElevenLabs key or a live server.
 */
export function planTtsSegments(content: string): Array<{ index: number; voice: string; text: string }> {
  return VoiceService.splitByCompanion(content)
    .filter((segment) => VoiceService.isSpeakable(segment.text))
    .map((segment, index) => ({ index, voice: segment.voice, text: segment.text }));
}

// PATCH /api/messages/:id
// Body: { content: string, rerun?: boolean }
//
// content-only edit: update text + edited_at, broadcast.
// rerun=true: also soft-delete every message after this one, clear the
// thread's SDK session so the agent doesn't remember the deleted turns,
// then re-prompt with the edited content.
router.patch('/messages/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { content, rerun } = req.body as { content?: string; rerun?: boolean };
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const existing = getMessage(id);
    if (!existing) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (existing.role !== 'user') {
      res.status(400).json({ error: 'Only user messages can be edited' });
      return;
    }
    if (existing.deleted_at) {
      res.status(400).json({ error: 'Cannot edit a deleted message' });
      return;
    }

    const now = new Date().toISOString();
    editMessage(id, content, now);
    registry.broadcast({
      type: 'message_edited',
      messageId: id,
      newContent: content,
      editedAt: now,
    });

    if (rerun) {
      // Drop the tail and re-prompt — but keep the SDK session intact.
      // The agent retains verbatim memory of the deleted turns; that's the
      // intentional design choice (continuity > local cleanliness). The model
      // handles "the previous version is gone" fine; if it ever doesn't,
      // surface it to the operator rather than reaching back for a wipe.
      const deletedIds = softDeleteAfterSequence(existing.thread_id, existing.sequence, now);
      for (const did of deletedIds) {
        registry.broadcast({ type: 'message_deleted', messageId: did });
      }

      const thread = getThread(existing.thread_id);
      const agentService = req.app.locals.agentService as AgentService | undefined;
      if (thread && agentService) {
        // Fire-and-forget — the agent streams its response over WS.
        agentService
          .processMessage(thread.id, content, { name: thread.name, type: thread.type }, {
            platform: 'web',
            withdrawn: `The user edited this message. Earlier wording (quoted data): ${JSON.stringify(existing.content.slice(0, 400))}. Replies after it are off their screen. Answer the current wording; you may still retain the earlier version.`,
          })
          .catch(err => console.error('Edit-and-rerun: agent error:', err));
      }
    }

    res.json({ success: true, message: getMessage(id), rerun: !!rerun });
  } catch (error) {
    console.error('Edit message error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// DELETE /api/messages/:id  — soft-delete, both roles allowed.
router.delete('/messages/:id', (req, res) => {
  try {
    const id = req.params.id;
    const existing = getMessage(id);
    if (!existing) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (existing.deleted_at) {
      res.json({ success: true, alreadyDeleted: true });
      return;
    }
    const now = new Date().toISOString();
    softDeleteMessage(id, now);
    registry.broadcast({ type: 'message_deleted', messageId: id });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Port: 8beeee4e + f1e3727a. Svelte-facing database preview adaptation.
router.get('/messages/:id/regenerate-preview', (req, res) => {
  const preview = getRerollPreview(req.params.id);
  if (!preview) return res.status(400).json({ error: 'No live companion reply with a prior user message found' });
  return res.json({ count: preview.count, revision: preview.revision });
});

router.post('/messages/:id/regenerate', async (req, res) => {
  try {
    const preview = getRerollPreview(req.params.id);
    if (!preview) return res.status(400).json({ error: 'No live companion reply with a prior user message found' });
    const thread = getThread(preview.target.thread_id);
    const agentService = req.app.locals.agentService as AgentService | undefined;
    if (!thread || !agentService) return res.status(503).json({ error: 'Reply service unavailable; nothing removed' });
    if (typeof req.body?.revision !== 'string') {
      return res.status(409).json({ error: 'Preview and confirm the affected messages first' });
    }
    const applied = applyReroll(req.params.id, req.body.revision);
    if (!applied) return res.status(409).json({ error: 'Conversation changed. Review the new count before confirming again.' });
    for (const messageId of applied.deletedIds) registry.broadcast({ type: 'message_deleted', messageId });
    // Preserve every lane's session. Screen withdrawal is not transcript erasure.
    agentService.processMessage(thread.id, applied.priorUser.content,
      { name: thread.name, type: thread.type }, { platform: 'web',
        withdrawn: 'The user has asked for this answered again — your previous reply is no longer on their screen. You may still have it in your session; you are not being asked to pretend otherwise. Answer the selected user message again.'
      }).catch(err => console.error('Regenerate: agent error:', err));
    return res.json({ success: true, regeneratingFrom: applied.priorUser.id });
  } catch (error) {
    console.error('Regenerate message error:', error);
    return res.status(500).json({ error: 'Failed to regenerate message' });
  }
});

// ROUTE ORDER: the tts/stream routes are registered BEFORE '/messages/:id/tts'
// (and every other '/messages/:id/...' route) so the more specific
// '/tts/stream' and '/tts/stream/:jobId/:segmentIndex' paths win and ':id' can
// never swallow the literal 'tts'/'stream' segments.

// POST /api/messages/:id/tts/stream
// Start ordered per-companion TTS streams. The manifest is intentionally cheap:
// all producer jobs begin before this response returns, while each URL can be
// opened later in speaking order and will replay everything buffered so far.
router.post('/messages/:id/tts/stream', async (req, res) => {
  try {
    const id = req.params.id;
    const message = getMessage(id);
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (message.deleted_at) {
      res.status(400).json({ error: 'Cannot read aloud a deleted message' });
      return;
    }
    if (message.content_type !== 'text' || !message.content) {
      res.status(400).json({ error: 'Only text messages can be read aloud' });
      return;
    }

    // Cache hit — expose the finished file as one replayable segment.
    const cached = getMessageTts(id);
    if (cached) {
      const url = `/api/files/${cached.file_id}`;
      res.json({
        success: true,
        cached: true,
        streaming: false,
        fileId: cached.file_id,
        url,
        segments: [{ index: 0, voice: cached.voice_used || 'default', url }],
      });
      return;
    }

    // Already-started stream job for this message — attach to it.
    const activeJob = messageTtsStreamJobsByMessage.get(id);
    if (activeJob) {
      res.json(getMessageTtsStreamManifest(activeJob));
      return;
    }

    const voiceService = req.app.locals.voiceService as VoiceService | undefined;
    if (!voiceService?.canTTS) {
      res.status(503).json({ error: 'voice_unavailable' });
      return;
    }

    // If the classic read-aloud route (POST /tts) won the race, don't start
    // another paid render. Expose its eventual cached file through one
    // replayable segment; this turn loses progressive playback but preserves
    // the stronger no-duplicate invariant.
    const existingRender = messageTtsRenders.get(id);
    if (existingRender) {
      const segment = createLiveTtsSegment(0, 'multi', '');
      const job: MessageTtsStreamJob = {
        id: crypto.randomUUID(),
        messageId: id,
        segments: [segment],
        createdAt: Date.now(),
      };
      messageTtsStreamJobs.set(job.id, job);
      messageTtsStreamJobsByMessage.set(id, job);

      void existingRender.then((rendered) => {
        const file = getFile(rendered.fileId);
        if (!file) throw new Error('Completed TTS cache file is missing');
        segment.state = 'streaming';
        publishLiveTtsChunk(segment, readFileSync(file.path));
        completeLiveTtsSegment(segment);
      }).catch((error) => {
        failLiveTtsSegment(segment, error);
        if (messageTtsStreamJobsByMessage.get(id) === job) {
          messageTtsStreamJobsByMessage.delete(id);
        }
      });
      void segment.completion.then(
        () => scheduleMessageTtsStreamCleanup(job),
        () => scheduleMessageTtsStreamCleanup(job),
      );
      res.json(getMessageTtsStreamManifest(job));
      return;
    }

    // Route segment generation through byte-light's own splitter + per-companion
    // voice selection — both companions speak, each in their own voice, in
    // reply order (the operator's requirement).
    const prepared = planTtsSegments(message.content);
    if (!prepared.length) {
      res.status(400).json({ error: 'Nothing speakable in message (emoji/audio-tag-only)' });
      return;
    }

    const job: MessageTtsStreamJob = {
      id: crypto.randomUUID(),
      messageId: id,
      segments: prepared.map((segment) => createLiveTtsSegment(segment.index, segment.voice, segment.text)),
      createdAt: Date.now(),
    };
    // Publish both indexes synchronously before any producer awaits. A second
    // overlay or bubble request in the same turn now attaches to this job.
    messageTtsStreamJobs.set(job.id, job);
    messageTtsStreamJobsByMessage.set(id, job);

    const voiceUsed = new Set(prepared.map((segment) => segment.voice)).size > 1
      ? 'multi'
      : (prepared[0]?.voice || 'default');

    // Background: once every segment buffer is rendered, stitch them (no
    // re-synthesis) and write the cached read-aloud file so later plays hit the
    // cache like the classic route.
    const render = (async (): Promise<MessageTtsRender> => {
      const buffers = await Promise.all(job.segments.map((segment) => segment.completion));
      const combined = buffers.length > 1
        ? await VoiceService.stitchTtsBuffers(buffers)
        : buffers[0];
      const fileMeta = saveFile(combined, `read-aloud-${id}.mp3`, 'audio/mpeg');
      setMessageTts({
        messageId: id,
        fileId: fileMeta.fileId,
        voiceUsed,
        createdAt: new Date().toISOString(),
      });
      return { success: true, cached: false, fileId: fileMeta.fileId, url: fileMeta.url };
    })();
    messageTtsRenders.set(id, render);

    // Start every segment now, not when its URL is opened.
    for (const segment of job.segments) void pumpLiveTtsSegment(segment, voiceService);

    void render.then(
      () => {
        if (messageTtsRenders.get(id) === render) messageTtsRenders.delete(id);
        scheduleMessageTtsStreamCleanup(job);
      },
      (error) => {
        console.error('[Read-aloud stream] Background cache failed:', error);
        if (messageTtsRenders.get(id) === render) messageTtsRenders.delete(id);
        if (messageTtsStreamJobsByMessage.get(id) === job) {
          messageTtsStreamJobsByMessage.delete(id);
        }
        scheduleMessageTtsStreamCleanup(job);
      },
    );

    res.json(getMessageTtsStreamManifest(job));
  } catch (error) {
    console.error('Read-aloud stream manifest error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'TTS stream failed',
    });
  }
});

// GET /api/messages/:id/tts/stream/:jobId/:segmentIndex
// Subscribe to one already-started segment. Completed jobs support byte ranges
// for HTMLAudioElement probes/retries; live `bytes=0-` requests follow the
// progressive stream, while nonzero seeks wait for a complete MP3.
router.get('/messages/:id/tts/stream/:jobId/:segmentIndex', (req, res) => {
  const job = messageTtsStreamJobs.get(req.params.jobId);
  const index = Number(req.params.segmentIndex);
  if (!job || job.messageId !== req.params.id || !Number.isInteger(index)) {
    res.status(404).json({ error: 'TTS stream not found or expired' });
    return;
  }
  const segment = job.segments[index];
  if (!segment || segment.index !== index) {
    res.status(404).json({ error: 'TTS segment not found' });
    return;
  }

  if (segment.state === 'complete') {
    sendCompletedTtsSegment(req, res, Buffer.concat(segment.chunks, segment.byteLength));
    return;
  }
  if (segment.state === 'error') {
    res.status(502).json({ error: segment.error?.message || 'TTS stream failed' });
    return;
  }
  if (req.method === 'HEAD') {
    res.status(200);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.end();
    return;
  }

  const requestedRange = req.headers.range;
  if (requestedRange && requestedRange.trim() !== 'bytes=0-') {
    let closed = false;
    res.once('close', () => { closed = true; });
    void segment.completion.then(
      (buffer) => {
        if (!closed) sendCompletedTtsSegment(req, res, buffer);
      },
      (error) => {
        if (!closed && !res.headersSent) {
          res.status(502).json({ error: error instanceof Error ? error.message : 'TTS stream failed' });
        }
      },
    );
    return;
  }

  const subscriber: LiveTtsSubscriber = {
    res,
    cursor: 0,
    flushing: false,
    closed: false,
  };
  segment.subscribers.add(subscriber);
  res.once('close', () => {
    subscriber.closed = true;
    segment.subscribers.delete(subscriber);
  });
  flushLiveTtsSubscriber(segment, subscriber);
});

// POST /api/messages/:id/tts
// Render the message text as a voice note and cache it. Subsequent calls
// return the cached file without re-synthesizing. Auto-detects multi-speaker
// markers in the text so each line gets the right voice.
router.post('/messages/:id/tts', async (req, res) => {
  try {
    const id = req.params.id;
    const message = getMessage(id);
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (message.deleted_at) {
      res.status(400).json({ error: 'Cannot read aloud a deleted message' });
      return;
    }
    if (message.content_type !== 'text' || !message.content) {
      res.status(400).json({ error: 'Only text messages can be read aloud' });
      return;
    }

    // Cache hit — return the existing audio without calling ElevenLabs.
    const cached = getMessageTts(id);
    if (cached) {
      res.json({
        success: true,
        cached: true,
        fileId: cached.file_id,
        url: `/api/files/${cached.file_id}`,
      });
      return;
    }

    const voiceService = req.app.locals.voiceService as VoiceService | undefined;
    if (!voiceService?.canTTS) {
      res.status(503).json({ error: 'voice_unavailable' });
      return;
    }

    const segments = VoiceService.splitByCompanion(message.content);
    if (segments.length === 0) {
      res.status(400).json({ error: 'Nothing speakable in message (emoji/audio-tag-only)' });
      return;
    }
    let buffer: Buffer;
    let voiceUsed: string;
    if (new Set(segments.map((s) => s.voice)).size > 1) {
      voiceUsed = 'multi';
      try {
        buffer = await voiceService.generateMultiVoiceMp3(segments);
      } catch (err) {
        console.warn('[Read-aloud] Multi-voice stitch failed, falling back to single:', (err as Error).message);
        voiceUsed = segments[0]?.voice ?? 'default';
        buffer = await voiceService.generateTTS(message.content, segments[0]?.voice);
      }
    } else {
      voiceUsed = segments[0]?.voice ?? 'default';
      buffer = await voiceService.generateTTS(message.content, segments[0]?.voice);
    }

    const fileMeta = saveFile(buffer, `read-aloud-${id}.mp3`, 'audio/mpeg');
    const now = new Date().toISOString();
    setMessageTts({ messageId: id, fileId: fileMeta.fileId, voiceUsed, createdAt: now });

    res.json({
      success: true,
      cached: false,
      fileId: fileMeta.fileId,
      url: fileMeta.url,
    });
  } catch (error) {
    console.error('Read-aloud error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'TTS render failed',
    });
  }
});

export default router;
