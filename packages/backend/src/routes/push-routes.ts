import { Router } from 'express';
import crypto from 'crypto';
import webpush from 'web-push';
import {
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
} from '../services/db.js';
import { addFcmSubscription, listFcmSubscriptions } from '../services/db/push.js';
import { getBytelightConfig } from '../config.js';
import type { PushService } from '../services/push.js';
import { validateVapidPair, validVapidContact } from '../services/push.js';
import { getSecret, setSecretsAtomically } from '../services/secrets.js';
import { readWebPushPreferences, saveWebPushPreferences } from '../services/push-preferences.js';
import { webRestOwner } from '../middleware/owner.js';

export function createPushRoutes(options: { ownerForRequest?: typeof webRestOwner } = {}): Router {
  const router = Router();
  const ownerForRequest = options.ownerForRequest ?? webRestOwner;
  router.use('/push', (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try { ownerForRequest(req); } catch { res.status(403).json({ error: 'owner_session_required' }); return; }
    next();
  });

  // Owner session on every route; same-origin HTTPS additionally on mutations.
  router.get('/push/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const service = req.app.locals.pushService as PushService | undefined;
      const present = ['vapid_public_key', 'vapid_private_key', 'vapid_contact'].map(name => !!getSecret(name));
      const configured = !!service?.getVapidPublicKey();
      res.json({ webPush: {
        configured,
        publicKey: service?.getVapidPublicKey() ?? null,
        setupState: configured ? 'ready' : present.every(v => !v) ? 'empty' : present.every(Boolean) ? 'saved-not-active' : 'partial',
      }, fcmConfigured: service?.isFcmConfigured() ?? false });
    } catch {
      res.status(503).json({ error: 'Could not read push readiness. Check encrypted credential storage.' });
    }
  });

  router.post('/push/setup-web', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!getBytelightConfig().auth.password) return res.status(403).json({ error: 'Owner authentication required to configure push.' });
    const service = req.app.locals.pushService as PushService | undefined;
    if (!service) return res.status(503).json({ error: 'The push service is unavailable.' });
    try {
      const publicKey = getSecret('vapid_public_key');
      const privateKey = getSecret('vapid_private_key');
      const savedContact = getSecret('vapid_contact');
      const requestedContact = typeof req.body?.contact === 'string' ? req.body.contact.trim() : '';
      const contact = requestedContact || savedContact || '';
      if (!validVapidContact(contact)) return res.status(400).json({ error: 'Enter a mailto: email address or an https: contact URL.' });
      const empty = !publicKey && !privateKey && !savedContact;
      if (!empty && (!publicKey || !privateKey)) {
        return res.status(409).json({ error: 'Web push is partially configured. Restore the matching keypair in Secrets. Existing values were preserved; no keys were generated.' });
      }
      const pair = empty ? webpush.generateVAPIDKeys() : { publicKey: publicKey!, privateKey: privateKey! };
      try { validateVapidPair(pair.publicKey, pair.privateKey, contact); }
      catch (err) { return res.status(409).json({ error: (err as Error).message }); }
      if (empty) setSecretsAtomically({ vapid_public_key: pair.publicKey, vapid_private_key: pair.privateKey, vapid_contact: contact });
      else if (requestedContact && requestedContact !== savedContact) setSecretsAtomically({ vapid_contact: contact });
      service.configureWebPush(pair.publicKey, pair.privateKey, contact);
      res.json({ success: true, configured: true, generated: empty, publicKey: pair.publicKey });
    } catch {
      res.status(503).json({ error: 'Could not configure push. Check encrypted credential storage; no server restart is needed after successful setup.' });
    }
  });

  // Read-only per-device check; endpoint stays in a POST body, not URL logs.
  router.post('/push/check-device', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 4096) return res.status(400).json({ error: 'A device endpoint is required.' });
    const registered = listPushSubscriptions().some(sub => sub.endpoint === endpoint);
    res.json({ registered, preferences: registered ? readWebPushPreferences(endpoint) : null });
  });

  router.put('/push/device-preferences', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { endpoint, notifyWhileConnected } = req.body ?? {};
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 4096 || typeof notifyWhileConnected !== 'boolean') {
      return res.status(400).json({ error: 'A registered endpoint and a boolean notifyWhileConnected preference are required.' });
    }
    if (!listPushSubscriptions().some(sub => sub.endpoint === endpoint)) {
      return res.status(404).json({ error: 'This device is not registered. Enable notifications first.' });
    }
    saveWebPushPreferences(endpoint, { notifyWhileConnected });
    res.json({ preferences: readWebPushPreferences(endpoint) });
  });

  // Subscribe to push notifications
  router.post('/push/subscribe', (req, res) => {
    try {
      const { endpoint, keys, deviceLabel, deviceToken } = req.body;
      // The Android app registers an FCM device token, not a web-push endpoint.
      if (typeof deviceToken === 'string' && deviceToken.trim()) {
        const id = crypto.randomUUID();
        addFcmSubscription({ id, deviceToken: deviceToken.trim(), deviceName: deviceLabel });
        res.json({ success: true, id, transport: 'fcm' });
        return;
      }
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        res.status(400).json({ error: 'endpoint and keys (p256dh, auth) required' });
        return;
      }

      const id = crypto.randomUUID();
      // Re-subscribe replaces the prior registration for this endpoint instead
      // of duplicating it (rows are keyed on id, which is fresh every call).
      removePushSubscription(endpoint);
      addPushSubscription({
        id,
        endpoint,
        keysP256dh: keys.p256dh,
        keysAuth: keys.auth,
        deviceName: deviceLabel,
      });

      res.json({ success: true, id });
    } catch (error) {
      console.error('Error subscribing to push:', error);
      res.status(500).json({ error: 'Failed to subscribe' });
    }
  });

  // Unsubscribe from push notifications
  router.post('/push/unsubscribe', (req, res) => {
    try {
      const { endpoint } = req.body;
      if (!endpoint) {
        res.status(400).json({ error: 'endpoint required' });
        return;
      }

      const removed = removePushSubscription(endpoint);
      res.json({ success: true, removed });
    } catch (error) {
      console.error('Error unsubscribing from push:', error);
      res.status(500).json({ error: 'Failed to unsubscribe' });
    }
  });

  // List push subscriptions (truncated endpoints for display)
  router.get('/push/subscriptions', (req, res) => {
    try {
      const subs = [...listPushSubscriptions(), ...listFcmSubscriptions()];
      const display = subs.map(s => ({
        id: s.id,
        deviceName: s.device_name,
        endpoint: s.endpoint ? s.endpoint.slice(0, 60) + '...' : null,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
      }));
      res.json({ subscriptions: display });
    } catch (error) {
      console.error('Error listing push subscriptions:', error);
      res.status(500).json({ error: 'Failed to list subscriptions' });
    }
  });

  // Send test push notification
  router.post('/push/test', async (req, res) => {
    try {
      const pushService = req.app.locals.pushService as PushService | undefined;
      if (!pushService?.isConfigured()) {
        res.status(503).json({ error: 'Push notifications not configured — set the VAPID keys (browser) or the Firebase service account (Android app) in Secrets' });
        return;
      }

      const endpoint = req.body?.endpoint;
      if (endpoint !== undefined && (typeof endpoint !== 'string' || !endpoint.trim())) {
        res.status(400).json({ error: 'A valid registered endpoint is required.' });
        return;
      }
      if (endpoint && !pushService.getVapidPublicKey()) {
        res.status(503).json({ error: 'Browser push is not configured.' });
        return;
      }

      const config = getBytelightConfig();
      const delivery = await pushService.sendPushWithReport({
        title: config.identity.companion_name,
        body: 'Push notifications are working!',
        tag: 'test',
        url: '/chat',
      }, endpoint);

      if (!delivery.attempted) return res.status(409).json({ error: 'No registered devices matched this test. Enable notifications on this device first.', delivery });
      if (!delivery.accepted) return res.status(502).json({ error: 'The push provider did not accept the test notification. Re-enable notifications on this device and try again.', delivery });
      res.json({ success: true, delivery, message: 'Accepted by the push provider. Check your device; receipt is not confirmed.' });
    } catch (error) {
      console.error('Error sending test push:', error);
      res.status(500).json({ error: 'Failed to send test push' });
    }
  });

  return router;
}
