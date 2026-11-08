import { createSign } from 'crypto';
import webpush from 'web-push';
import { listPushSubscriptions, removePushSubscription, touchPushSubscription } from './db.js';
import { listFcmSubscriptions, removePushSubscriptionByToken, touchPushSubscriptionById } from './db/push.js';
import { registry } from './registry.js';
import { getSecret } from './secrets.js';

export interface PushPayload {
  title: string;
  body: string;
  threadId?: string;
  tag?: string;
  url?: string;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Two transports side by side: web push (VAPID) for the browser, and FCM HTTP
 * v1 for the Android app, which registers its device token through
 * /api/push/subscribe. Every notification goes out on both. The FCM half is
 * ported from Aerie (which dropped web push; this house keeps it). Its
 * credentials are the whole service-account JSON in the secrets store under
 * `fcm_service_account`, never a repo file.
 */
export class PushService {
  private configured = false;
  private account: ServiceAccount | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

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
      console.log('PushService: VAPID keys not set — web push disabled');
    }
    this.refreshFcm();
  }

  /** Re-read the Firebase service account — at boot and when the secret is saved. */
  refreshFcm(): void {
    this.account = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    const raw = getSecret('fcm_service_account');
    if (!raw) {
      console.log('PushService: fcm_service_account not set — Android app push disabled');
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
      if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
        console.warn('PushService: fcm_service_account is missing project_id / client_email / private_key');
        return;
      }
      this.account = parsed as ServiceAccount;
      console.log(`PushService: FCM configured for project ${this.account.project_id}`);
    } catch {
      console.warn('PushService: fcm_service_account is not valid JSON — Android app push disabled');
    }
  }

  isConfigured(): boolean {
    return this.configured || this.account !== null;
  }

  isFcmConfigured(): boolean {
    return this.account !== null;
  }

  getVapidPublicKey(): string | null {
    return this.configured ? getSecret('vapid_public_key') || null : null;
  }

  /** Send a notification to every browser and every Android app device. */
  async sendPush(payload: PushPayload): Promise<void> {
    await Promise.all([this.sendWebPush(payload), this.sendFcm(payload)]);
  }

  private async sendWebPush(payload: PushPayload): Promise<void> {
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

  /** Sign a service-account JWT and trade it for a short-lived access token,
   *  cached until a minute before it expires so a burst of pushes signs once. */
  private async getFcmAccessToken(): Promise<string | null> {
    if (!this.account) return null;
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;

    const nowSec = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({
      iss: this.account.client_email,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }));
    let assertion: string;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      signer.end();
      assertion = `${header}.${claims}.${base64url(signer.sign(this.account.private_key))}`;
    } catch (err) {
      console.error('PushService: failed to sign the service-account JWT:', err);
      return null;
    }

    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      });
      if (!res.ok) {
        console.error(`PushService: token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const json = await res.json() as { access_token?: string; expires_in?: number };
      if (!json.access_token) return null;
      this.accessToken = json.access_token;
      this.tokenExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
      return this.accessToken;
    } catch (err) {
      console.error('PushService: token exchange error:', err);
      return null;
    }
  }

  /** One FCM message per registered Android app device. */
  private async sendFcm(payload: PushPayload): Promise<void> {
    if (!this.account) return;
    const subs = listFcmSubscriptions();
    if (subs.length === 0) return;
    const accessToken = await this.getFcmAccessToken();
    if (!accessToken) return;

    const endpoint = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    await Promise.all(subs.map(async (sub) => {
      const message = {
        token: sub.device_token,
        notification: { title: payload.title, body: payload.body },
        // Data travels alongside so a tap can open the right room.
        data: {
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
          ...(payload.url ? { url: payload.url } : {}),
        },
        android: {
          priority: 'HIGH',
          notification: {
            // The same tag replaces rather than stacks: a chunked reply is one
            // notification that updates, not four buzzes.
            ...(payload.tag ? { tag: payload.tag } : {}),
            default_sound: true,
          },
        },
      };
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        if (res.ok) {
          touchPushSubscriptionById(sub.id);
          return;
        }
        const text = await res.text();
        // An uninstalled app's or replaced token is gone for good.
        if (res.status === 404 || (res.status === 400 && text.includes('UNREGISTERED'))) {
          removePushSubscriptionByToken(sub.device_token!);
          console.log(`PushService: dropped dead Android device token ${sub.id}`);
          return;
        }
        console.error(`PushService: FCM send failed (${res.status}): ${text.slice(0, 200)}`);
      } catch (err) {
        console.error('PushService: FCM send error:', err);
      }
    }));
  }

  /**
   * A data-only FCM message to every registered Android app device: no
   * notification block, so nothing is drawn by the system and the app's own
   * messaging service gets it in onMessageReceived even when the app is
   * closed. High priority so a dozing phone wakes for it; a short time-to-live
   * because a message that lands an hour late is the wrong moment. Every value
   * must be a string (FCM's rule). Answers how many devices there were and how
   * many FCM accepted; it never throws. (The Needle, Nov 2026.)
   */
  async sendFcmData(data: Record<string, string>, ttlSeconds = 120): Promise<{ devices: number; sent: number }> {
    if (!this.account) return { devices: 0, sent: 0 };
    const subs = listFcmSubscriptions();
    if (subs.length === 0) return { devices: 0, sent: 0 };
    const accessToken = await this.getFcmAccessToken();
    if (!accessToken) return { devices: subs.length, sent: 0 };

    const endpoint = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    const results = await Promise.all(subs.map(async (sub): Promise<boolean> => {
      const message = {
        token: sub.device_token,
        data,
        android: { priority: 'HIGH', ttl: `${Math.max(0, Math.floor(ttlSeconds))}s` },
      };
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        if (res.ok) {
          touchPushSubscriptionById(sub.id);
          return true;
        }
        const text = await res.text();
        if (res.status === 404 || (res.status === 400 && text.includes('UNREGISTERED'))) {
          removePushSubscriptionByToken(sub.device_token!);
          console.log(`PushService: dropped dead Android device token ${sub.id}`);
          return false;
        }
        console.error(`PushService: FCM data send failed (${res.status}): ${text.slice(0, 200)}`);
        return false;
      } catch (err) {
        console.error('PushService: FCM data send error:', err);
        return false;
      }
    }));
    return { devices: subs.length, sent: results.filter(Boolean).length };
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
