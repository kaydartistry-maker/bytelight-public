import webpush from 'web-push';
import { listPushSubscriptions, removePushSubscription, touchPushSubscription } from './db.js';
import { registry } from './registry.js';
import { getSecret } from './secrets.js';

export interface PushPayload {
  title: string;
  body: string;
  threadId?: string;
  tag?: string;
  url?: string;
}

export class PushService {
  private configured = false;

  constructor(vapidPublic?: string, vapidPrivate?: string, vapidContact?: string) {
    if (vapidPublic && vapidPrivate && vapidContact) {
      // web-push throws synchronously when the contact isn't a valid URL
      // (a bare email instead of mailto:…) — unguarded, that takes the whole
      // backend down at boot. A bad VAPID config just disables push.
      try {
        webpush.setVapidDetails(vapidContact, vapidPublic, vapidPrivate);
        this.configured = true;
        console.log('PushService: VAPID configured');
      } catch (err) {
        this.configured = false;
        console.error('PushService: invalid VAPID config — push disabled', err);
      }
    } else {
      console.log('PushService: VAPID keys not set — push disabled');
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getVapidPublicKey(): string | null {
    return this.configured ? getSecret('vapid_public_key') || null : null;
  }

  /** Send push to all web_push subscriptions */
  async sendPush(payload: PushPayload): Promise<void> {
    if (!this.configured) return;

    const subscriptions = listPushSubscriptions();
    if (subscriptions.length === 0) return;

    const jsonPayload = JSON.stringify(payload);

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        if (!sub.endpoint || !sub.keys_p256dh || !sub.keys_auth) return;

        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.keys_p256dh,
                auth: sub.keys_auth,
              },
            },
            jsonPayload
          );
          touchPushSubscription(sub.endpoint);
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 410 || statusCode === 404) {
            // Subscription expired or invalid — remove it
            console.log(`PushService: removing expired subscription ${sub.endpoint.slice(0, 50)}...`);
            removePushSubscription(sub.endpoint);
          } else {
            console.error(`PushService: failed to send to ${sub.endpoint.slice(0, 50)}...`, err);
          }
        }
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    console.log(`PushService: sent ${sent}/${subscriptions.length} push notifications`);
  }

  /** Send push only when user has no active WebSocket connections */
  async sendIfOffline(payload: PushPayload): Promise<void> {
    if (!registry.isUserConnected()) {
      await this.sendPush(payload);
    }
  }

  /** Always send push regardless of connection state (for time-critical items) */
  async sendAlways(payload: PushPayload): Promise<void> {
    await this.sendPush(payload);
  }
}

// Module-level handle so code that isn't holding an Express request or the
// agent instance (the Discord gateway's mention notifications, for one) can
// still reach the live service. (Aerie.)
let activePushService: PushService | null = null;

export function setPushService(service: PushService): void {
  activePushService = service;
}

export function getPushService(): PushService | null {
  return activePushService;
}
