import { Router } from 'express';
import crypto from 'crypto';
import {
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
} from '../services/db.js';
import { addFcmSubscription, listFcmSubscriptions } from '../services/db/push.js';
import { getBytelightConfig } from '../config.js';
import type { PushService } from '../services/push.js';

export function createPushRoutes(): Router {
  const router = Router();

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

      const config = getBytelightConfig();
      await pushService.sendPush({
        title: config.identity.companion_name,
        body: 'Push notifications are working!',
        tag: 'test',
        url: '/chat',
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error sending test push:', error);
      res.status(500).json({ error: 'Failed to send test push' });
    }
  });

  return router;
}
