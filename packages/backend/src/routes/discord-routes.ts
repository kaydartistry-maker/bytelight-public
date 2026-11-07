import { Router } from 'express';
import { getConfigBool, setConfig } from '../services/db.js';
import { DiscordService } from '../services/discord/index.js';
import type { AgentService } from '../services/agent.js';
import { getDiscordConfig, getAllowedUsers, getAllowedGuilds, getActiveChannels } from '../services/discord/config.js';
import { getRulesData, saveRules } from '../services/discord/rules.js';
import type { ServerRule, ChannelRule, UserRule, RulesData } from '../services/discord/rules.js';
import { registry } from '../services/registry.js';

export function createDiscordRoutes(): Router {
  const router = Router();

  // --- Discord admin endpoints ---

  router.get('/discord/status', (req, res) => {
    try {
      const discordService = req.app.locals.discordService as DiscordService | null;
      const configEnabled = getConfigBool('discord.enabled', false);
      const hasToken = !!process.env.DISCORD_BOT_TOKEN;
      if (!discordService) {
        res.json({ enabled: false, configEnabled, hasToken });
        return;
      }
      res.json({ enabled: true, configEnabled, hasToken, ...discordService.getStats() });
    } catch (error) {
      console.error('Error fetching Discord status:', error);
      res.status(500).json({ error: 'Failed to fetch Discord status' });
    }
  });

  router.post('/discord/toggle', async (req, res) => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      const agentService = req.app.locals.agentService as AgentService;

      if (enabled) {
        // Start Discord gateway
        if (!process.env.DISCORD_BOT_TOKEN) {
          res.status(400).json({ error: 'DISCORD_BOT_TOKEN not set in .env' });
          return;
        }
        if (req.app.locals.discordService) {
          res.json({ success: true, message: 'Already running' });
          return;
        }
        const service = new DiscordService(agentService, registry);
        await service.start();
        req.app.locals.discordService = service;
        setConfig('discord.enabled', 'true');
        console.log('[Discord] Gateway enabled via settings toggle');
        res.json({ success: true, message: 'Discord gateway started' });
      } else {
        // Stop Discord gateway
        const service = req.app.locals.discordService as DiscordService | null;
        if (service) {
          await service.stop();
          req.app.locals.discordService = null;
        }
        setConfig('discord.enabled', 'false');
        console.log('[Discord] Gateway disabled via settings toggle');
        res.json({ success: true, message: 'Discord gateway stopped' });
      }
    } catch (error) {
      console.error('Error toggling Discord:', error);
      res.status(500).json({ error: 'Failed to toggle Discord gateway' });
    }
  });

  router.get('/discord/pairings', (req, res) => {
    try {
      const discordService = req.app.locals.discordService as DiscordService | null;
      if (!discordService) {
        res.json({ pending: [], approved: [] });
        return;
      }
      const pairing = discordService.getPairingService();
      res.json({
        pending: pairing.listPending(),
        approved: pairing.listApproved(),
      });
    } catch (error) {
      console.error('Error fetching pairings:', error);
      res.status(500).json({ error: 'Failed to fetch pairings' });
    }
  });

  router.post('/discord/pairings/:code/approve', (req, res) => {
    try {
      const discordService = req.app.locals.discordService as DiscordService | null;
      if (!discordService) {
        res.status(503).json({ error: 'Discord not enabled' });
        return;
      }
      const pairing = discordService.getPairingService();
      const result = pairing.approve(req.params.code, 'user');
      if (result.success) {
        res.json({ success: true, userId: result.userId });
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (error) {
      console.error('Error approving pairing:', error);
      res.status(500).json({ error: 'Failed to approve pairing' });
    }
  });

  router.delete('/discord/pairings/:userId', (req, res) => {
    try {
      const discordService = req.app.locals.discordService as DiscordService | null;
      if (!discordService) {
        res.status(503).json({ error: 'Discord not enabled' });
        return;
      }
      const pairing = discordService.getPairingService();
      const revoked = pairing.revoke(req.params.userId);
      res.json({ success: revoked });
    } catch (error) {
      console.error('Error revoking pairing:', error);
      res.status(500).json({ error: 'Failed to revoke pairing' });
    }
  });

  // --- Discord settings & rules admin ---

  // GET /discord/settings — all config values
  router.get('/discord/settings', (req, res) => {
    try {
      const config = getDiscordConfig();
      res.json({
        ...config,
        allowedUsers: [...getAllowedUsers()],
        allowedGuilds: [...getAllowedGuilds()],
        activeChannels: [...getActiveChannels()],
      });
    } catch (error) {
      console.error('Error fetching Discord settings:', error);
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // PUT /discord/settings — partial update of config values
  router.put('/discord/settings', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;

      // Map of setting keys to their DB config keys
      const settingsMap: Record<string, string> = {
        ownerUserId: 'discord.ownerUserId',
        requireMentionInGuilds: 'discord.requireMentionInGuilds',
        debounceMs: 'discord.debounceMs',
        pairingExpiryMs: 'discord.pairingExpiryMs',
        ownerActiveThresholdMin: 'discord.ownerActiveThresholdMin',
        deferPollIntervalMs: 'discord.deferPollIntervalMs',
        deferMaxAgeMs: 'discord.deferMaxAgeMs',
        judgeBeatMs: 'discord.judgeBeatMs',
        judgeMaxWaitMs: 'discord.judgeMaxWaitMs',
        ownerMentions: 'discord.owner_mentions',
      };

      // Set-based settings (stored as comma-separated)
      const setSettingsMap: Record<string, string> = {
        allowedUsers: 'discord.allowedUsers',
        allowedGuilds: 'discord.allowedGuilds',
        activeChannels: 'discord.activeChannels',
      };

      let updated = 0;

      for (const [key, dbKey] of Object.entries(settingsMap)) {
        if (key in body) {
          setConfig(dbKey, String(body[key]));
          updated++;
        }
      }

      for (const [key, dbKey] of Object.entries(setSettingsMap)) {
        if (key in body) {
          const val = body[key];
          const str = Array.isArray(val) ? val.join(',') : String(val);
          setConfig(dbKey, str);
          updated++;
        }
      }

      // Return current state after update
      const config = getDiscordConfig();
      res.json({
        success: true,
        updated,
        ...config,
        allowedUsers: [...getAllowedUsers()],
        allowedGuilds: [...getAllowedGuilds()],
        activeChannels: [...getActiveChannels()],
      });
    } catch (error) {
      console.error('Error updating Discord settings:', error);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // GET /discord/rules — full rules blob
  router.get('/discord/rules', (req, res) => {
    try {
      res.json(getRulesData());
    } catch (error) {
      console.error('Error fetching Discord rules:', error);
      res.status(500).json({ error: 'Failed to fetch rules' });
    }
  });

  // PUT /discord/rules — full rules blob replace + reload
  router.put('/discord/rules', (req, res) => {
    try {
      const data = req.body as RulesData;
      if (!data.servers || !data.channels || !data.users) {
        res.status(400).json({ error: 'Rules must have servers, channels, and users' });
        return;
      }
      saveRules(data);
      res.json({ success: true, ...getRulesData() });
    } catch (error) {
      console.error('Error saving Discord rules:', error);
      res.status(500).json({ error: 'Failed to save rules' });
    }
  });

  // POST /discord/rules/server — add/update one server rule
  router.post('/discord/rules/server', (req, res) => {
    try {
      const rule = req.body as ServerRule;
      if (!rule.id || !rule.name) {
        res.status(400).json({ error: 'Server rule requires id and name' });
        return;
      }
      const data = getRulesData();
      data.servers[rule.id] = rule;
      saveRules(data);
      res.json({ success: true, rule });
    } catch (error) {
      console.error('Error saving server rule:', error);
      res.status(500).json({ error: 'Failed to save server rule' });
    }
  });

  // DELETE /discord/rules/server/:id
  router.delete('/discord/rules/server/:id', (req, res) => {
    try {
      const data = getRulesData();
      if (!(req.params.id in data.servers)) {
        res.status(404).json({ error: 'Server rule not found' });
        return;
      }
      delete data.servers[req.params.id];
      saveRules(data);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting server rule:', error);
      res.status(500).json({ error: 'Failed to delete server rule' });
    }
  });

  // POST /discord/rules/channel — add/update one channel rule
  router.post('/discord/rules/channel', (req, res) => {
    try {
      const rule = req.body as ChannelRule;
      if (!rule.id || !rule.name) {
        res.status(400).json({ error: 'Channel rule requires id and name' });
        return;
      }
      const data = getRulesData();
      data.channels[rule.id] = rule;
      saveRules(data);
      res.json({ success: true, rule });
    } catch (error) {
      console.error('Error saving channel rule:', error);
      res.status(500).json({ error: 'Failed to save channel rule' });
    }
  });

  // DELETE /discord/rules/channel/:id
  router.delete('/discord/rules/channel/:id', (req, res) => {
    try {
      const data = getRulesData();
      if (!(req.params.id in data.channels)) {
        res.status(404).json({ error: 'Channel rule not found' });
        return;
      }
      delete data.channels[req.params.id];
      saveRules(data);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting channel rule:', error);
      res.status(500).json({ error: 'Failed to delete channel rule' });
    }
  });

  // POST /discord/rules/user — add/update one user rule
  router.post('/discord/rules/user', (req, res) => {
    try {
      const rule = req.body as UserRule;
      if (!rule.id || !rule.name) {
        res.status(400).json({ error: 'User rule requires id and name' });
        return;
      }
      const data = getRulesData();
      data.users[rule.id] = rule;
      saveRules(data);
      res.json({ success: true, rule });
    } catch (error) {
      console.error('Error saving user rule:', error);
      res.status(500).json({ error: 'Failed to save user rule' });
    }
  });

  // DELETE /discord/rules/user/:id
  router.delete('/discord/rules/user/:id', (req, res) => {
    try {
      const data = getRulesData();
      if (!(req.params.id in data.users)) {
        res.status(404).json({ error: 'User rule not found' });
        return;
      }
      delete data.users[req.params.id];
      saveRules(data);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting user rule:', error);
      res.status(500).json({ error: 'Failed to delete user rule' });
    }
  });

  return router;
}
