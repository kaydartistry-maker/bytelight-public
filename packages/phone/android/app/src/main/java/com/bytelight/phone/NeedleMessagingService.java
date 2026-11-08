package com.bytelight.phone;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.getcapacitor.CapConfig;
import com.google.firebase.messaging.RemoteMessage;
import com.spotify.android.appremote.api.ConnectionParams;
import com.spotify.android.appremote.api.Connector;
import com.spotify.android.appremote.api.SpotifyAppRemote;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * The Needle (Nov 2026): the house's data-only push that plays a song Companion A or
 * Companion B dropped, while the app is closed and Spotify isn't running.
 *
 * This is the app's one Firebase messaging service. It stands in for the
 * Capacitor push-notifications plugin's own service (removed from the merged
 * manifest with tools:node="remove") by EXTENDING it: anything that is not a
 * needle goes to super.onMessageReceived, and onNewToken is not overridden at
 * all, so the plugin's JS events (registration, pushNotificationReceived) see
 * exactly what they saw before.
 *
 * A needle carries {kind:'needle', uri, by, dropId} and, when the house could
 * read them, the Spotify app id and redirect (clientId, redirectUri). The work
 * runs on FCM's own background thread, inside its ~20 second window:
 *   1. Spotify App Remote connects (no auth view: nothing can be shown from
 *      here) and plays the uri. Road 'remote'.
 *   2. If that can't connect or Spotify refuses, Spotify is opened on the uri
 *      with ACTION_VIEW, and a tap-to-play notification is left beside it,
 *      because Android 10+ may hold a background activity start back without
 *      saying so. Road 'intent'.
 *   3. The result goes to POST /api/spotify/needle/landed with the WebView's
 *      own session cookie for the server URL in the Capacitor config.
 */
public class NeedleMessagingService extends MessagingService {

    private static final String TAG = "BytelightNeedle";
    private static final String CHANNEL_ID = "needle";
    private static final Pattern URI = Pattern.compile("^spotify:(track|album|playlist):[0-9A-Za-z]{22}$");
    private static final Pattern DROP_ID = Pattern.compile("^[A-Za-z0-9-]{1,64}$");

    private static final long CONNECT_WAIT_MS = 6_000;
    private static final long PLAY_WAIT_MS = 3_000;
    private static final long COOKIE_WAIT_MS = 1_500;
    private static final int REPORT_TIMEOUT_MS = 3_500;
    private static final long DISCONNECT_AFTER_MS = 2_000;

    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if (data == null || !"needle".equals(data.get("kind"))) {
            super.onMessageReceived(remoteMessage);
            return;
        }
        try {
            handleNeedle(data);
        } catch (Throwable t) {
            // A needle must never take the messaging service down with it.
            Log.e(TAG, "needle failed", t);
        }
    }

    private void handleNeedle(Map<String, String> data) {
        String uri = data.get("uri");
        String dropId = data.get("dropId");
        String by = data.get("by");
        String clientId = data.get("clientId");
        String redirectUri = data.get("redirectUri");

        if (uri == null || !URI.matcher(uri).matches()) {
            Log.w(TAG, "needle without a playable uri, ignored");
            return;
        }
        if (dropId != null && !DROP_ID.matcher(dropId).matches()) dropId = null;

        String remoteError;
        if (clientId == null || clientId.isEmpty() || redirectUri == null || redirectUri.isEmpty()) {
            remoteError = "no Spotify app id in the push";
        } else if (!SpotifyAppRemote.isSpotifyInstalled(getApplicationContext())) {
            remoteError = "Spotify is not installed";
        } else {
            remoteError = playByRemote(clientId, redirectUri, uri);
        }

        if (remoteError == null) {
            Log.i(TAG, "played " + uri + " by App Remote");
            report(dropId, true, "remote", null);
            return;
        }
        if (remoteError.startsWith("!")) {
            // Spotify neither confirmed nor refused: the song may well be
            // playing, so no second start on top of it.
            report(dropId, false, "remote", remoteError.substring(1));
            return;
        }

        Log.i(TAG, "App Remote missed (" + remoteError + "), opening Spotify instead");
        String intentError = openSpotify(uri, by, dropId);
        if (intentError == null) {
            report(dropId, true, "intent", remoteError);
        } else {
            report(dropId, false, "intent", remoteError + "; " + intentError);
        }
    }

    /**
     * Connect, play, and let go. Answers null when Spotify said yes, a reason
     * when it could not connect or refused, and a reason starting with "!"
     * when the play went out but Spotify never answered in time.
     */
    private String playByRemote(String clientId, String redirectUri, final String uri) {
        final ConnectionParams params = new ConnectionParams.Builder(clientId)
            .setRedirectUri(redirectUri)
            .showAuthView(false)
            .build();

        final CountDownLatch connected = new CountDownLatch(1);
        final AtomicReference<SpotifyAppRemote> remoteRef = new AtomicReference<>();
        final AtomicReference<String> failure = new AtomicReference<>();
        final AtomicBoolean abandoned = new AtomicBoolean(false);

        main.post(() -> {
            try {
                SpotifyAppRemote.connect(getApplicationContext(), params, new Connector.ConnectionListener() {
                    @Override
                    public void onConnected(SpotifyAppRemote spotifyAppRemote) {
                        remoteRef.set(spotifyAppRemote);
                        if (abandoned.get()) {
                            SpotifyAppRemote late = remoteRef.getAndSet(null);
                            if (late != null) SpotifyAppRemote.disconnect(late);
                        }
                        connected.countDown();
                    }

                    @Override
                    public void onFailure(Throwable throwable) {
                        failure.set("connect failed: " + describe(throwable));
                        connected.countDown();
                    }
                });
            } catch (Throwable t) {
                failure.set("connect threw: " + describe(t));
                connected.countDown();
            }
        });

        boolean answered = await(connected, CONNECT_WAIT_MS);
        if (!answered) {
            abandoned.set(true);
            final SpotifyAppRemote late = remoteRef.getAndSet(null);
            if (late != null) main.post(() -> SpotifyAppRemote.disconnect(late));
            return "connect timed out";
        }
        final SpotifyAppRemote remote = remoteRef.get();
        if (remote == null) {
            String why = failure.get();
            return why != null ? why : "connect failed";
        }

        final CountDownLatch played = new CountDownLatch(1);
        final AtomicBoolean playOk = new AtomicBoolean(false);
        final AtomicReference<String> playError = new AtomicReference<>();
        main.post(() -> {
            try {
                remote.getPlayerApi().play(uri)
                    .setResultCallback(empty -> {
                        playOk.set(true);
                        played.countDown();
                    })
                    .setErrorCallback(throwable -> {
                        playError.set("play refused: " + describe(throwable));
                        played.countDown();
                    });
            } catch (Throwable t) {
                playError.set("play threw: " + describe(t));
                played.countDown();
            }
        });

        boolean playAnswered = await(played, PLAY_WAIT_MS);
        // Spotify keeps playing in its own process; the connection is only ours.
        main.postDelayed(() -> SpotifyAppRemote.disconnect(remote), DISCONNECT_AFTER_MS);

        if (!playAnswered) return "!Spotify did not answer the play in time";
        if (playOk.get()) return null;
        String why = playError.get();
        return why != null ? why : "play refused";
    }

    /**
     * Ask Spotify to open the uri, and leave a tap-to-play notification beside
     * it. Null when either went out; a reason when neither could.
     */
    private String openSpotify(String uri, String by, String dropId) {
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
        view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (view.resolveActivity(getPackageManager()) == null) return "nothing on the phone opens Spotify links";

        boolean started = false;
        String startError = null;
        try {
            startActivity(view);
            started = true;
        } catch (ActivityNotFoundException e) {
            startError = "Spotify could not be opened";
        } catch (Throwable t) {
            startError = "opening Spotify threw: " + describe(t);
        }

        boolean posted = postTapToPlay(view, by, dropId);
        if (started || posted) return null;
        return startError != null ? startError : "notifications are off";
    }

    private boolean postTapToPlay(Intent view, String by, String dropId) {
        try {
            NotificationManagerCompat notifications = NotificationManagerCompat.from(this);
            if (!notifications.areNotificationsEnabled()) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
                    NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID, "Songs from the companions", NotificationManager.IMPORTANCE_HIGH);
                    channel.setDescription("A song Companion A or Companion B put on for you");
                    manager.createNotificationChannel(channel);
                }
            }
            int requestCode = dropId != null ? dropId.hashCode() : (int) System.currentTimeMillis();
            PendingIntent tap = PendingIntent.getActivity(
                this, requestCode, view, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            String who = nameOf(by);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(who + " put a song on for you")
                .setContentText("Tap to play it in Spotify")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
                .setAutoCancel(true)
                .setContentIntent(tap);
            notifications.notify(CHANNEL_ID, requestCode, builder.build());
            return true;
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS not granted (Android 13+).
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "tap-to-play notification failed", t);
            return false;
        }
    }

    /** Tell the house how it went. Best effort: a failed report is only logged. */
    private void report(String dropId, boolean ok, String road, String error) {
        if (dropId == null) return;
        HttpURLConnection connection = null;
        try {
            String server = CapConfig.loadDefault(this).getServerUrl();
            if (server == null || server.isEmpty()) {
                Log.w(TAG, "no server URL in the Capacitor config; report skipped");
                return;
            }
            Uri base = Uri.parse(server);
            if (base.getScheme() == null || base.getAuthority() == null) return;
            String origin = base.getScheme() + "://" + base.getAuthority();
            String cookie = cookieFor(server);

            JSONObject body = new JSONObject();
            body.put("dropId", dropId);
            body.put("ok", ok);
            body.put("road", road);
            if (error != null) body.put("error", error.length() > 300 ? error.substring(0, 300) : error);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);

            connection = (HttpURLConnection) new URL(origin + "/api/spotify/needle/landed").openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(REPORT_TIMEOUT_MS);
            connection.setReadTimeout(REPORT_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) Log.w(TAG, "report answered " + status);
        } catch (Throwable t) {
            Log.w(TAG, "report failed: " + describe(t));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** The WebView's cookies for the server, read on the main thread. */
    private String cookieFor(final String server) {
        final AtomicReference<String> cookie = new AtomicReference<>();
        final CountDownLatch read = new CountDownLatch(1);
        main.post(() -> {
            try {
                cookie.set(CookieManager.getInstance().getCookie(server));
            } catch (Throwable t) {
                Log.w(TAG, "cookie read failed: " + describe(t));
            }
            read.countDown();
        });
        await(read, COOKIE_WAIT_MS);
        return cookie.get();
    }

    private static boolean await(CountDownLatch latch, long ms) {
        try {
            return latch.await(ms, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static String nameOf(String by) {
        if ("companion-a".equals(by)) return "Companion A";
        if ("companion-b".equals(by)) return "Companion B";
        return "The boys";
    }

    private static String describe(Throwable t) {
        if (t == null) return "unknown";
        String message = t.getMessage();
        String kind = t.getClass().getSimpleName();
        return message == null || message.isEmpty() ? kind : kind + ": " + message;
    }
}
