// Usage event + aggregate endpoints.
// Mounted in api.ts after auth middleware.
import { Router } from 'express';
import {
  listUsageEvents,
  getUsageEventByMessageId,
  getUsageAggregate,
  getToolCallAggregate,
} from '../services/db.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getClaudeUsage,
  getCodexUsage,
  listPersistedUsageWindows,
} from '../services/subscription-usage.js';
import {
  getProviderSpend,
  isSpendProvider,
  listProviderSpend,
} from '../services/provider-spend.js';
import type { VoiceService } from '../services/voice.js';

const router = Router();

router.get('/usage/events', authMiddleware, (req, res) => {
  try {
    const rawLimit = Number.parseInt((req.query.limit as string) || '100', 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500);

    const rawOffset = Number.parseInt((req.query.offset as string) || '0', 10);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
    const rows = listUsageEvents({
      limit,
      offset,
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
      threadId: req.query.threadId as string | undefined,
      platform: req.query.platform as string | undefined,
      mode: req.query.mode as 'interactive' | 'autonomous' | undefined,
      model: req.query.model as string | undefined,
    });
    res.json({ events: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/usage/aggregate', authMiddleware, (req, res) => {
  try {
    const rows = getUsageAggregate({
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
      groupBy: req.query.groupBy as any,
    });
    res.json({ buckets: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/usage/tools', authMiddleware, (req, res) => {
  try {
    const rows = getToolCallAggregate({
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
    });
    res.json({ tools: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/usage/message/:messageId', authMiddleware, (req, res) => {
  try {
    const row = getUsageEventByMessageId(String(req.params.messageId));
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ event: row });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PORT ADAPTATION: reference implementation mounts these reads in its monolithic api.ts.
// byte-light already has an authenticated usage concern router, so the URL
// shapes are preserved while wiring them here.
router.get('/usage/claude', authMiddleware, async (_req, res) => {
  try {
    res.json(await getClaudeUsage());
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Claude usage unavailable' });
  }
});

router.get('/usage/codex', authMiddleware, async (_req, res) => {
  try {
    res.json(await getCodexUsage());
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Codex usage unavailable' });
  }
});

router.get('/usage/windows', authMiddleware, (req, res) => {
  try {
    const lane = typeof req.query.lane === 'string' ? req.query.lane : undefined;
    res.json({ windows: listPersistedUsageWindows(lane) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Usage windows unavailable' });
  }
});

// What the call screen asks before it opens the mic: can the house hear her
// (speech-to-text) and answer aloud (companion voices)? Shape matches the
// phone's VoiceDiagnostics.
router.get('/voice/status', authMiddleware, (req, res) => {
  const voiceService = req.app.locals.voiceService as VoiceService | undefined;
  if (!voiceService) {
    res.status(500).json({ error: 'VoiceService not initialized' });
    return;
  }
  res.json({
    canTranscribe: voiceService.canTranscribe,
    canTTS: voiceService.canTTS,
    canAnalyzeProsody: voiceService.canAnalyzeProsody,
  });
});

router.get('/voice/usage', authMiddleware, async (req, res) => {
  const voiceService = req.app.locals.voiceService as VoiceService | undefined;
  if (!voiceService) {
    res.status(500).json({ error: 'VoiceService not initialized' });
    return;
  }
  try {
    res.json(await voiceService.getElevenLabsUsage());
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'ElevenLabs usage unavailable' });
  }
});

router.get('/usage/providers', authMiddleware, (req, res) => {
  try {
    res.json({ providers: listProviderSpend({
      since: typeof req.query.since === 'string' ? req.query.since : undefined,
      until: typeof req.query.until === 'string' ? req.query.until : undefined,
    }) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Provider spend unavailable' });
  }
});

router.get('/usage/providers/:provider', authMiddleware, (req, res) => {
  const provider = String(req.params.provider).toLowerCase();
  if (!isSpendProvider(provider)) {
    res.status(404).json({ error: 'Unsupported spend provider' });
    return;
  }
  try {
    res.json(getProviderSpend(provider, {
      since: typeof req.query.since === 'string' ? req.query.since : undefined,
      until: typeof req.query.until === 'string' ? req.query.until : undefined,
    }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Provider spend unavailable' });
  }
});

export default router;
