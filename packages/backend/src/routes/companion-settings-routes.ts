/**
 * Companion settings thread-override routes.
 *
 * Step 4B: powers the chat-header model pill. Writes thread-scope rows.
 *
 * H (companion-default): the Preferences panel now also writes COMPANION-scope
 * defaults through this same router (PUT /companion-settings/default) — the
 * operator-facing write path for the companion-wide default engine, for BOTH
 * the interactive (chat) and autonomous (wake) tiers. The old
 * agent.model / agent.model_autonomous config (still on /api/preferences) is
 * now SYSTEM-FALLBACK ONLY: a companion-scope row wins over it in the resolver
 * (services/companion-resolver.ts:127-144), so this route is the primary
 * mechanism for choosing the default engine.
 *
 * Shape:
 *   GET    /api/companion-settings/effective?companionId=&tier=&threadId=
 *   PUT    /api/companion-settings/thread     (thread-scope, interactive-only)
 *   DELETE /api/companion-settings/thread
 *   PUT    /api/companion-settings/default    (companion-scope, interactive|autonomous)
 *   DELETE /api/companion-settings/default    (back to the brain's / house default)
 *
 * Auth is inherited from the parent router at packages/backend/src/routes/api.ts
 * (the router.use(authMiddleware) boundary). This module mounts AFTER that
 * boundary, so every handler below is already authenticated. No middleware is
 * added here.
 *
 * Tier policy: the chat-header pill is interactive-only in Step 4B. Both write
 * routes reject `tier !== 'interactive'` with 400 — autonomous/pulse/memory
 * overrides come from the Settings panel, not the pill.
 */

import { Router } from 'express';
import {
  upsertCompanionSetting,
  deleteCompanionSetting,
} from '../services/db/companion-settings.js';
import { resolveCompanionConfig } from '../services/companion-resolver.js';
import type { ProviderId, ThinkingEffort, TierHint } from '@bytelight/shared';

// Mirrors VALID_EFFORT in preferences-routes.ts:17-19. Kept in-file to avoid
// cross-route coupling; the union itself is the source of truth in @bytelight/shared.
const VALID_EFFORT: readonly ThinkingEffort[] = [
  'auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const;

// Provider allow-list. Matches the ProviderId union in model-manifest.ts.
// If/when the union grows, extend this list rather than relaxing the check —
// the resolver and dispatcher rely on these exact strings.
// H (companion-default): 'groq' + 'xai' added — their openai-compat lanes
// went live in the picker (H3b-1) but were missing here, so a direct pick of
// either provider 400'd on the thread route. Both are now valid everywhere.
const VALID_PROVIDERS: readonly ProviderId[] = [
  'claude', 'claude-cli', 'codex-cli', 'openai', 'openai-codex', 'openrouter', 'groq', 'xai', 'ollama',
] as const;

// Tier allow-list for the resolver path. Writes are interactive-only; the
// GET handler accepts any valid tier so future autonomous-pill reuse works
// without a route change.
const VALID_TIERS: readonly TierHint[] = [
  'interactive', 'autonomous', 'pulse', 'memory',
] as const;

export function createCompanionSettingsRoutes(): Router {
  const router = Router();

  /**
   * GET /api/companion-settings/effective
   *
   * Returns the resolver's effective config for (companionId, tier, threadId?).
   * The chat-header pill calls this with all three params; the response
   * includes them verbatim plus the resolved provider/model/effort/source.
   *
   * `source` is the key signal for the UI: 'thread' means an override exists;
   * 'companion'/'system' means the pill is showing inherited config.
   */
  router.get('/companion-settings/effective', (req, res) => {
    try {
      const companionId = typeof req.query.companionId === 'string' ? req.query.companionId : '';
      const tier = typeof req.query.tier === 'string' ? req.query.tier : '';
      const threadId = typeof req.query.threadId === 'string' && req.query.threadId.length > 0
        ? req.query.threadId
        : undefined;

      if (!companionId) {
        res.status(400).json({ error: 'companionId required' });
        return;
      }
      if (!tier || !(VALID_TIERS as readonly string[]).includes(tier)) {
        res.status(400).json({ error: 'tier must be one of: ' + VALID_TIERS.join(', ') });
        return;
      }

      const resolved = resolveCompanionConfig(companionId, tier as TierHint, threadId);
      res.json({
        companionId,
        tier,
        threadId: threadId ?? null,
        provider: resolved.provider,
        model: resolved.model,
        thinkingEffort: resolved.effort,
        source: resolved.source,
        // Whose row answered — a companion ('companion-a') may be following the
        // brain it shares ('companion-a-b'). null on the bare config fallback.
        matchedCompanionId: resolved.matchedCompanionId ?? null,
      });
    } catch (err) {
      console.error('Failed to resolve companion settings:', err);
      res.status(500).json({ error: 'Failed to resolve companion settings' });
    }
  });

  /**
   * PUT /api/companion-settings/thread
   *
   * Writes a thread-scope row. Interactive tier only — the pill cannot
   * change autonomous from the chat header. Service layer enforces
   * `scope='thread' requires threadId` as a secondary belt.
   */
  router.put('/companion-settings/thread', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companionId = body.companionId;
      const tier = body.tier;
      const threadId = body.threadId;
      const providerId = body.providerId;
      const modelId = body.modelId;
      const thinkingEffort = body.thinkingEffort ?? 'auto';

      if (typeof companionId !== 'string' || companionId.trim().length === 0) {
        res.status(400).json({ error: 'companionId required' });
        return;
      }
      if (tier !== 'interactive') {
        res.status(400).json({ error: "tier must be 'interactive' (chat-header pill is interactive-only)" });
        return;
      }
      if (typeof threadId !== 'string' || threadId.trim().length === 0) {
        res.status(400).json({ error: 'threadId required for thread-scope write' });
        return;
      }
      if (typeof providerId !== 'string' || !(VALID_PROVIDERS as readonly string[]).includes(providerId)) {
        res.status(400).json({ error: 'providerId must be one of: ' + VALID_PROVIDERS.join(', ') });
        return;
      }
      if (typeof modelId !== 'string' || modelId.trim().length === 0) {
        res.status(400).json({ error: 'modelId required (non-empty string)' });
        return;
      }
      if (typeof thinkingEffort !== 'string' || !(VALID_EFFORT as readonly string[]).includes(thinkingEffort)) {
        res.status(400).json({ error: 'thinkingEffort invalid (must be one of: ' + VALID_EFFORT.join(', ') + ')' });
        return;
      }

      const row = upsertCompanionSetting({
        companionId,
        tier: 'interactive',
        scope: 'thread',
        threadId,
        providerId: providerId as ProviderId,
        modelId,
        thinkingEffort: thinkingEffort as ThinkingEffort,
      });

      res.json({ ok: true, row });
    } catch (err) {
      console.error('Failed to upsert thread override:', err);
      res.status(500).json({ error: 'Failed to upsert thread override' });
    }
  });

  /**
   * DELETE /api/companion-settings/thread
   *
   * Removes a single thread-scope row. Interactive tier only. The service
   * key {companionId, tier, scope:'thread', threadId} is exact — no
   * companion or system row can be touched by this handler.
   */
  router.delete('/companion-settings/thread', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companionId = body.companionId;
      const tier = body.tier;
      const threadId = body.threadId;

      if (typeof companionId !== 'string' || companionId.trim().length === 0) {
        res.status(400).json({ error: 'companionId required' });
        return;
      }
      if (tier !== 'interactive') {
        res.status(400).json({ error: "tier must be 'interactive' (chat-header pill is interactive-only)" });
        return;
      }
      if (typeof threadId !== 'string' || threadId.trim().length === 0) {
        res.status(400).json({ error: 'threadId required for thread-scope delete' });
        return;
      }

      const removed = deleteCompanionSetting({
        companionId,
        tier: 'interactive',
        scope: 'thread',
        threadId,
      });

      res.json({ ok: true, removed });
    } catch (err) {
      console.error('Failed to delete thread override:', err);
      res.status(500).json({ error: 'Failed to delete thread override' });
    }
  });

  /**
   * PUT /api/companion-settings/default
   *
   * Writes a COMPANION-scope default row (scope='companion', threadId=null).
   * This is the operator-facing write path for the companion-wide default
   * engine, exposed by the Preferences panel. Unlike the thread route it
   * accepts BOTH tiers:
   *   - 'interactive' drives chat turns (companion default, below any
   *     per-thread override).
   *   - 'autonomous'  drives wakes/watchers/scribe/impulses — the resolver
   *     forces threadId=null for autonomous and reads at companion scope
   *     (model-resolution.ts), so a companion-scope autonomous row IS what
   *     autonomous turns resolve to.
   *
   * A companion-scope row wins over the legacy agent.model /
   * agent.model_autonomous config (now systemFallback only) in the resolver.
   * companion_id is validated non-empty here, but note the live resolver keys
   * on 'companion-a-b' (model-resolution.ts:59) — the panel sends that id.
   */
  router.put('/companion-settings/default', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companionId = body.companionId;
      const tier = body.tier;
      const providerId = body.providerId;
      const modelId = body.modelId;
      const thinkingEffort = body.thinkingEffort ?? 'auto';

      if (typeof companionId !== 'string' || companionId.trim().length === 0) {
        res.status(400).json({ error: 'companionId required' });
        return;
      }
      // Companion defaults cover the two tiers the panel controls. pulse/memory
      // inherit interactive via the resolver's systemFallback and have no
      // panel control, so they are rejected here.
      if (tier !== 'interactive' && tier !== 'autonomous') {
        res.status(400).json({ error: "tier must be 'interactive' or 'autonomous'" });
        return;
      }
      if (typeof providerId !== 'string' || !(VALID_PROVIDERS as readonly string[]).includes(providerId)) {
        res.status(400).json({ error: 'providerId must be one of: ' + VALID_PROVIDERS.join(', ') });
        return;
      }
      if (typeof modelId !== 'string' || modelId.trim().length === 0) {
        res.status(400).json({ error: 'modelId required (non-empty string)' });
        return;
      }
      if (typeof thinkingEffort !== 'string' || !(VALID_EFFORT as readonly string[]).includes(thinkingEffort)) {
        res.status(400).json({ error: 'thinkingEffort invalid (must be one of: ' + VALID_EFFORT.join(', ') + ')' });
        return;
      }

      const row = upsertCompanionSetting({
        companionId,
        tier: tier as TierHint,
        scope: 'companion',
        // scope='companion' → no threadId; the service layer rejects a
        // threadId on non-thread scopes as a secondary belt.
        providerId: providerId as ProviderId,
        modelId,
        thinkingEffort: thinkingEffort as ThinkingEffort,
        isDefault: true,
      });

      res.json({ ok: true, row });
    } catch (err) {
      console.error('Failed to upsert companion default:', err);
      res.status(500).json({ error: 'Failed to upsert companion default' });
    }
  });

  /**
   * DELETE /api/companion-settings/default
   *
   * Removes one COMPANION-scope row, so that companion falls back to what is
   * below it (its brain's default, then the system fallback). Exact key —
   * no thread or system row can be touched by this handler.
   */
  router.delete('/companion-settings/default', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companionId = body.companionId;
      const tier = body.tier;
      if (typeof companionId !== 'string' || companionId.trim().length === 0) {
        res.status(400).json({ error: 'companionId required' });
        return;
      }
      if (tier !== 'interactive' && tier !== 'autonomous') {
        res.status(400).json({ error: "tier must be 'interactive' or 'autonomous'" });
        return;
      }
      const removed = deleteCompanionSetting({ companionId, tier, scope: 'companion' });
      res.json({ ok: true, removed });
    } catch (err) {
      console.error('Failed to delete companion default:', err);
      res.status(500).json({ error: 'Failed to delete companion default' });
    }
  });

  return router;
}
