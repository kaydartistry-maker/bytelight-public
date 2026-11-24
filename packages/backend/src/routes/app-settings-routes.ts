import { Router } from 'express';
import { getConfig, setConfig } from '../services/db/config.js';
import { ownerDisplayName } from '../services/db/owner-name.js';

// Install-wide phone setup and owner card, stored in SQLite's config table.
export function createAppSettingsRoutes(): Router {
  const router = Router();
  router.get('/app-settings', (_req, res) => {
    const raw = getConfig('phone.app-settings');
    res.json({ settings: raw ? JSON.parse(raw) : null });
  });
  router.put('/app-settings', (req, res) => {
    const settings = req.body?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      res.status(400).json({ error: 'settings must be an object' });
      return;
    }
    for (const key of ['theme', 'contacts', 'appSettings', 'extras']) {
      if (key in settings && settings[key] !== null && (typeof settings[key] !== 'object' || Array.isArray(settings[key]))) {
        res.status(400).json({ error: `${key} must be an object` });
        return;
      }
    }
    setConfig('phone.app-settings', JSON.stringify(settings));
    res.json({ settings });
  });

  const readCard = () => {
    const raw = getConfig('phone.owner-card');
    const stored = raw ? JSON.parse(raw) : {};
    return { bio: stored.bio ?? '', status: stored.status ?? '', ...(typeof stored.name === 'string' ? { name: stored.name } : {}) };
  };
  const response = () => {
    const card = readCard();
    const configuredName = ownerDisplayName();
    return { card, name: card.name || (['the owner', 'User'].includes(configuredName) ? 'User' : configuredName) };
  };
  router.get('/owner-card', (_req, res) => { res.json(response()); });
  router.patch('/owner-card', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Card updates must be an object' });
      return;
    }
    const updates: Record<string, string> = {};
    for (const [key, limit] of Object.entries({ bio: 8000, status: 200, name: 80 })) {
      if (!(key in (req.body ?? {}))) continue;
      const value = req.body[key];
      if (typeof value !== 'string' || value.length > limit || (key === 'name' && !value.trim())) {
        res.status(400).json({ error: `Invalid ${key}` });
        return;
      }
      updates[key] = value.trim();
    }
    if (!Object.keys(updates).length) {
      res.status(400).json({ error: 'No card fields supplied' });
      return;
    }
    setConfig('phone.owner-card', JSON.stringify({ ...readCard(), ...updates }));
    res.json(response());
  });
  return router;
}
