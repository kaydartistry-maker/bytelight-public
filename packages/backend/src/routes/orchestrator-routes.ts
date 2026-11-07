import { Router } from 'express';
import * as cron from 'node-cron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { listTriggers, cancelTrigger, createTrigger } from '../services/db.js';
import type { TriggerCondition } from '../services/db.js';
import type { Orchestrator } from '../services/orchestrator.js';
import { getBytelightConfig, persistOrchestratorEnabled, persistVoiceEnabled } from '../config.js';
import { setConfig } from '../services/db.js';
import type { TelegramService } from '../services/telegram/index.js';
import { upsertWakeSection, removeWakeSection } from '../services/wake-prompts.js';

// Apply a mutation to the wake prompts file, back it up first, then hot-reload
// the running orchestrator so the edit takes effect with no restart. A wake
// left with no prompt registers a timer that fires into nothing, so the file
// is always written and reloaded together.
function editWakePromptsFile(orchestrator: Orchestrator, mutate: (raw: string) => string): void {
  const path = getBytelightConfig().orchestrator.wake_prompts_path;
  const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '# Wake Prompts\n';
  if (existsSync(path)) writeFileSync(path + '.backup', raw, 'utf-8');
  writeFileSync(path, mutate(raw), 'utf-8');
  orchestrator.reloadWakePrompts();
}

const PRESENCE_STATES = ['active', 'idle', 'offline'];
const TIME_RE = /^\d{1,2}:\d{2}$/;

function validateCondition(c: Record<string, unknown>): string | null {
  switch (c.type) {
    case 'presence_state':
      return PRESENCE_STATES.includes(c.state as string) ? null : 'presence_state.state must be active|idle|offline';
    case 'presence_transition':
      if (!PRESENCE_STATES.includes(c.from as string)) return 'presence_transition.from must be active|idle|offline';
      if (!PRESENCE_STATES.includes(c.to as string)) return 'presence_transition.to must be active|idle|offline';
      return null;
    case 'agent_free':
      return null;
    case 'time_window':
      if (typeof c.after !== 'string' || !TIME_RE.test(c.after)) return 'time_window.after must be HH:MM';
      if (c.before !== undefined && (typeof c.before !== 'string' || !TIME_RE.test(c.before))) return 'time_window.before must be HH:MM';
      return null;
    case 'routine_missing':
      if (typeof c.routine !== 'string' || !c.routine.trim()) return 'routine_missing.routine required';
      if (typeof c.after_hour !== 'number' || c.after_hour < 0 || c.after_hour > 23) return 'routine_missing.after_hour must be 0-23';
      return null;
    default:
      return `Unknown condition type: ${String(c.type)}`;
  }
}

export function createOrchestratorRoutes(): Router {
  const router = Router();

  // Get orchestrator task status
  // Integrations switches. Each one takes effect now AND persists where boot
  // reads it, so the switch and the running service never disagree.
  router.post('/orchestrator/toggle', (req, res) => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      // start() does not check whether it is already running; stopping first
      // keeps a second "on" from scheduling every wake twice.
      orchestrator.stop();
      if (enabled) orchestrator.start();
      persistOrchestratorEnabled(enabled === true);
      res.json({ success: true, enabled: enabled === true });
    } catch (err) {
      console.error('Error toggling orchestrator:', err);
      res.status(500).json({ error: 'Failed to toggle orchestrator' });
    }
  });

  router.post('/telegram/toggle', async (req, res) => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      const service = req.app.locals.telegramService as TelegramService | null;
      if (enabled) {
        if (!service) {
          res.status(400).json({ error: 'Telegram service not initialized (set telegram_bot_token and restart once)' });
          return;
        }
        await service.start();
      } else if (service) {
        await service.stop();
      }
      setConfig('telegram.enabled', enabled ? 'true' : 'false');
      res.json({ success: true, enabled: enabled === true });
    } catch (err) {
      console.error('Error toggling Telegram:', err);
      res.status(500).json({ error: 'Failed to toggle Telegram' });
    }
  });

  // voice.enabled is the capability master; each new connection reads it.
  router.post('/voice/toggle', (req, res) => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      persistVoiceEnabled(enabled === true);
      res.json({ success: true, enabled: enabled === true });
    } catch (err) {
      console.error('Error toggling voice:', err);
      res.status(500).json({ error: 'Failed to toggle voice' });
    }
  });

  router.get('/orchestrator/status', async (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      const tasks = await orchestrator.getStatus();
      res.json({ tasks });
    } catch (error) {
      console.error('Error fetching orchestrator status:', error);
      res.status(500).json({ error: 'Failed to fetch orchestrator status' });
    }
  });

  // Enable/disable/reschedule/rename a task, or hand it to a companion
  router.patch('/orchestrator/tasks/:wakeType', async (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }

      const { wakeType } = req.params;
      const { enabled, cronExpr, label, companion, statusWord } = req.body;

      if (cronExpr !== undefined) {
        if (typeof cronExpr !== 'string') {
          res.status(400).json({ error: 'cronExpr must be a string' });
          return;
        }
        const success = orchestrator.rescheduleTask(wakeType, cronExpr);
        if (!success) {
          res.status(400).json({ error: 'Failed to reschedule — invalid cron expression or unknown task' });
          return;
        }
      }

      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') {
          res.status(400).json({ error: 'enabled must be a boolean' });
          return;
        }
        const success = enabled
          ? orchestrator.enableTask(wakeType)
          : orchestrator.disableTask(wakeType);
        if (!success) {
          res.status(404).json({ error: 'Unknown task' });
          return;
        }
      }

      // Rename: what the owner reads on the roster. Empty gives the generated name back.
      if (label !== undefined) {
        if (typeof label !== 'string' || label.length > 120) {
          res.status(400).json({ error: 'label must be a string of at most 120 characters' });
          return;
        }
        if (!orchestrator.setTaskLabel(wakeType, label)) {
          res.status(404).json({ error: 'Unknown task' });
          return;
        }
      }

      // Owner: one slug, several comma-separated (in the order they answer),
      // or null / '' for a shared bell.
      if (companion !== undefined) {
        if (companion !== null && typeof companion !== 'string') {
          res.status(400).json({ error: 'companion must be a slug string or null' });
          return;
        }
        if (!orchestrator.setTaskCompanion(wakeType, companion)) {
          res.status(400).json({ error: 'Unknown task, or no companion by that slug' });
          return;
        }
      }

      // The word the phone shows under the faces while this bell runs
      // (services/bell-status.ts, Aerie). null or '' takes it away.
      if (statusWord !== undefined) {
        if (statusWord !== null && typeof statusWord !== 'string') {
          res.status(400).json({ error: 'statusWord must be a string or null' });
          return;
        }
        if (!orchestrator.setTaskStatusWord(wakeType, statusWord)) {
          res.status(404).json({ error: 'Unknown task' });
          return;
        }
      }

      const tasks = await orchestrator.getStatus();
      res.json({ success: true, tasks });
    } catch (error) {
      console.error('Error updating orchestrator task:', error);
      res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // POST /orchestrator/tasks — the owner makes a bell, live, no restart.
  //
  // Adapted: the bell's prompt is kept in the settings table with the rest of
  // the bell (cron.<wakeType>.*), not written into the wake prompts file — the
  // owner does not edit markdown files, and her bells must come back after a
  // restart on their own.
  router.post('/orchestrator/tasks', async (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      const body = (req.body ?? {}) as { wakeType?: unknown; cronExpr?: unknown; label?: unknown; prompt?: unknown; companion?: unknown };
      const wakeType = typeof body.wakeType === 'string' ? body.wakeType.trim() : '';
      const cronExpr = typeof body.cronExpr === 'string' ? body.cronExpr.trim() : '';
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const label = typeof body.label === 'string' ? body.label : undefined;
      const companion = typeof body.companion === 'string' ? body.companion : null;

      if (!wakeType || !cronExpr) {
        res.status(400).json({ error: 'wakeType and cronExpr are required' });
        return;
      }
      if (!/^\w+$/.test(wakeType)) {
        res.status(400).json({ error: 'Invalid wake type' });
        return;
      }
      if (!cron.validate(cronExpr)) {
        res.status(400).json({ error: `'${cronExpr}' is not a valid cron expression.` });
        return;
      }
      if (!prompt) {
        res.status(400).json({ error: 'A bell needs something to say — write its prompt.' });
        return;
      }

      const result = orchestrator.createCustomWake({ wakeType, cronExpr, label, prompt, companion });
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      const tasks = await orchestrator.getStatus();
      res.json({ success: true, tasks });
    } catch (error) {
      console.error('Error creating custom wake:', error);
      res.status(500).json({ error: 'Failed to create wake' });
    }
  });

  // DELETE /orchestrator/tasks/:wakeType — remove a bell the owner made.
  // Built-ins turn off rather than disappear, so there is always a way back.
  router.delete('/orchestrator/tasks/:wakeType', async (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      const { wakeType } = req.params;
      if (!/^\w+$/.test(wakeType)) {
        res.status(400).json({ error: 'Invalid wake type' });
        return;
      }
      const result = orchestrator.deleteCustomWake(wakeType);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      const tasks = await orchestrator.getStatus();
      res.json({ success: true, tasks });
    } catch (error) {
      console.error('Error deleting custom wake:', error);
      res.status(500).json({ error: 'Failed to delete wake' });
    }
  });

  // Get failsafe config
  router.get('/orchestrator/failsafe', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      res.json(orchestrator.getFailsafeConfig());
    } catch (error) {
      console.error('Error fetching failsafe config:', error);
      res.status(500).json({ error: 'Failed to fetch failsafe config' });
    }
  });

  // Update failsafe config
  router.patch('/orchestrator/failsafe', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }

      const { enabled, gentle, concerned, emergency } = req.body;
      orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
      res.json({ success: true, ...orchestrator.getFailsafeConfig() });
    } catch (error) {
      console.error('Error updating failsafe config:', error);
      res.status(500).json({ error: 'Failed to update failsafe config' });
    }
  });

  // GET /orchestrator/spontaneous — the dice settings plus how many rolled
  // wakes are still waiting today (a count only; the times stay secret).
  router.get('/orchestrator/spontaneous', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      res.json(orchestrator.getSpontaneousConfig());
    } catch (error) {
      console.error('Error fetching spontaneous config:', error);
      res.status(500).json({ error: 'Failed to fetch spontaneous config' });
    }
  });

  // PATCH /orchestrator/spontaneous — any change re-rolls today.
  router.patch('/orchestrator/spontaneous', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      const { enabled, maxPerDay, windowStart, windowEnd } = (req.body ?? {}) as Record<string, unknown>;
      // Adapted: shape-checked here so a malformed value cannot be persisted
      // and quietly re-roll the day into nothing.
      const isInt = (v: unknown, min: number, max: number) =>
        typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      if (maxPerDay !== undefined && !isInt(maxPerDay, 0, 12)) {
        res.status(400).json({ error: 'maxPerDay must be a whole number from 0 to 12' });
        return;
      }
      if (windowStart !== undefined && !isInt(windowStart, 0, 23)) {
        res.status(400).json({ error: 'windowStart must be an hour from 0 to 23' });
        return;
      }
      if (windowEnd !== undefined && !isInt(windowEnd, 1, 48)) {
        res.status(400).json({ error: 'windowEnd must be an hour from 1 to 48 (past 24 = after midnight)' });
        return;
      }
      orchestrator.setSpontaneousConfig({
        enabled: enabled as boolean | undefined,
        maxPerDay: maxPerDay as number | undefined,
        windowStart: windowStart as number | undefined,
        windowEnd: windowEnd as number | undefined,
      });
      res.json({ success: true, ...orchestrator.getSpontaneousConfig() });
    } catch (error) {
      console.error('Error updating spontaneous config:', error);
      res.status(500).json({ error: 'Failed to update spontaneous config' });
    }
  });

  // Get active triggers
  router.get('/orchestrator/triggers', (req, res) => {
    try {
      const kind = req.query.kind as 'impulse' | 'watcher' | undefined;
      const triggers = listTriggers(kind);
      res.json({ triggers });
    } catch (error) {
      console.error('Error fetching triggers:', error);
      res.status(500).json({ error: 'Failed to fetch triggers' });
    }
  });

  // Create a trigger (impulse or watcher) from the UI
  router.post('/orchestrator/triggers', (req, res) => {
    try {
      const { kind, label, conditions, prompt, cooldownMinutes } = req.body;
      if (kind !== 'impulse' && kind !== 'watcher') {
        res.status(400).json({ error: 'kind must be "impulse" or "watcher"' });
        return;
      }
      if (typeof label !== 'string' || !label.trim()) {
        res.status(400).json({ error: 'label is required' });
        return;
      }
      if (!Array.isArray(conditions) || conditions.length === 0) {
        res.status(400).json({ error: 'conditions must be a non-empty array' });
        return;
      }
      for (const c of conditions) {
        const problem = validateCondition(c as Record<string, unknown>);
        if (problem) {
          res.status(400).json({ error: problem });
          return;
        }
      }
      if (prompt !== undefined && typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt must be a string' });
        return;
      }
      if (cooldownMinutes !== undefined && (typeof cooldownMinutes !== 'number' || cooldownMinutes < 1)) {
        res.status(400).json({ error: 'cooldownMinutes must be a positive number' });
        return;
      }

      const trigger = createTrigger({
        id: crypto.randomUUID(),
        kind,
        label: label.trim(),
        conditions: conditions as TriggerCondition[],
        prompt: prompt?.trim() || undefined,
        cooldownMinutes,
        createdAt: new Date().toISOString(),
      });
      res.json({ success: true, trigger });
    } catch (error) {
      console.error('Error creating trigger:', error);
      res.status(500).json({ error: 'Failed to create trigger' });
    }
  });

  // Cancel a trigger
  router.delete('/orchestrator/triggers/:id', (req, res) => {
    try {
      const cancelled = cancelTrigger(req.params.id);
      if (!cancelled) {
        res.status(404).json({ error: 'Trigger not found or already cancelled' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Error cancelling trigger:', error);
      res.status(500).json({ error: 'Failed to cancel trigger' });
    }
  });

  // Get the effective editable prompt for every wake type (file override vs default)
  router.get('/orchestrator/wake-prompts', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      res.json(orchestrator.getWakePromptReport());
    } catch (error) {
      console.error('Error building wake prompt report:', error);
      res.status(500).json({ error: 'Failed to build wake prompt report' });
    }
  });

  // Set a file override for one wake type — takes effect live, no restart
  router.put('/orchestrator/wake-prompts/:wakeType', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      const { content } = req.body as { content?: string };
      if (typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'A bell needs something to say — write its prompt.' });
        return;
      }
      if (!/^\w+$/.test(req.params.wakeType)) {
        res.status(400).json({ error: 'Invalid wake type' });
        return;
      }
      // An owner-made bell keeps its prompt in the settings table; editing it
      // there keeps the prompts file out of it entirely.
      if (orchestrator.isCustomWake(req.params.wakeType)) {
        orchestrator.setCustomWakePrompt(req.params.wakeType, content);
        res.json({ success: true, ...orchestrator.getWakePromptReport() });
        return;
      }
      editWakePromptsFile(orchestrator, (raw) => upsertWakeSection(raw, req.params.wakeType, content));
      res.json({ success: true, ...orchestrator.getWakePromptReport() });
    } catch (error) {
      console.error('Error updating wake prompt:', error);
      res.status(500).json({ error: 'Failed to update wake prompt' });
    }
  });

  // Remove a wake type's file override so the built-in default applies again
  router.delete('/orchestrator/wake-prompts/:wakeType', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      if (!/^\w+$/.test(req.params.wakeType)) {
        res.status(400).json({ error: 'Invalid wake type' });
        return;
      }
      if (orchestrator.isCustomWake(req.params.wakeType)) {
        res.status(400).json({ error: 'A bell you made has no built-in default to go back to — edit its prompt or remove the bell.' });
        return;
      }
      editWakePromptsFile(orchestrator, (raw) => removeWakeSection(raw, req.params.wakeType));
      res.json({ success: true, ...orchestrator.getWakePromptReport() });
    } catch (error) {
      console.error('Error removing wake prompt override:', error);
      res.status(500).json({ error: 'Failed to remove wake prompt override' });
    }
  });

  return router;
}
