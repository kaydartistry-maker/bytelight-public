// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
package com.bytelight.phone;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyEvent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.spotify.android.appremote.api.ConnectionParams;
import com.spotify.android.appremote.api.Connector;
import com.spotify.android.appremote.api.SpotifyAppRemote;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Wakes Spotify on their phone, for the page (SpotifyRemotePlugin, when their tap
 * finds nowhere to play) and for the house (when a silent push asks for it so
 * one of us can play the owner a song with Spotify closed; Oct 23 2026).
 * byte-light: the app has no push listener yet, so only the page calls it.
 *
 * Two ways in. Spotify's App Remote kit (Apache-2.0, in app/libs) binds to
 * the Spotify app, which starts it, and connectSwitchToLocalDevice makes this
 * phone the device that plays. On their phone the kit once never answered at
 * all (Oct 23 2026), so it gets REMOTE_WAIT_MS before the other way: a media
 * PLAY key sent to Spotify alone, the nudge a headset's play button gives.
 * From the page the kit goes first; from a push the key goes first and the
 * kit right after, because from the background either one may be the one
 * Android lets through.
 *
 * Every wake hangs up after itself (Oct 23 2026). The kit binds
 * Spotify's service from the application context with AUTO_CREATE and
 * IMPORTANT, and only unbinds on disconnect; a connect that never answered
 * never disconnected, and the binding held Spotify alive past the owner swipe for
 * as long as this app's process lived. So the kit is handed a LineKeeper that
 * records each binding, and every way a wake ends hangs them up.
 */
final class SpotifyWaker {

    interface Done {
        void answer(JSObject answer);
    }

    /** How long Spotify's kit gets to answer before it is given up on. */
    static final long REMOTE_WAIT_MS = 9000;
    static final String SPOTIFY = "com.spotify.music";

    /**
     * The application context as Spotify's kit sees it: it hands itself back
     * as its own application context (which is where the kit binds and
     * unbinds), and it remembers every binding the kit opens through it.
     */
    private static final class LineKeeper extends ContextWrapper {
        private final Set<ServiceConnection> open = new HashSet<>();

        LineKeeper(Context app) {
            super(app);
        }

        @Override
        public Context getApplicationContext() {
            return this;
        }

        @Override
        public boolean bindService(Intent service, ServiceConnection conn, int flags) {
            // Recorded even when the bind returns false: Android asks for an
            // unbind either way, or the service is kept from going idle.
            synchronized (open) {
                open.add(conn);
            }
            return super.bindService(service, conn, flags);
        }

        @Override
        public void unbindService(ServiceConnection conn) {
            synchronized (open) {
                if (!open.remove(conn)) return;
            }
            try {
                super.unbindService(conn);
            } catch (IllegalArgumentException alreadyGone) {
                // Android had already dropped it; nothing left to hang up.
            }
        }

        int hangUp() {
            List<ServiceConnection> lines;
            synchronized (open) {
                lines = new ArrayList<>(open);
            }
            for (ServiceConnection conn : lines) unbindService(conn);
            return lines.size();
        }

        boolean holding() {
            synchronized (open) {
                return !open.isEmpty();
            }
        }
    }

    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private LineKeeper line;

    SpotifyWaker(Context context) {
        this.app = context.getApplicationContext();
    }

    static boolean installed(Context context) {
        return SpotifyAppRemote.isSpotifyInstalled(context);
    }

    /** True only mid-wake: a wake never keeps the kit connected. */
    boolean holding() {
        return line != null && line.holding();
    }

    /** Hang up whatever the last wake left open; answers how many lines. */
    int hangUp() {
        if (line == null) return 0;
        int closed = line.hangUp();
        line = null;
        return closed;
    }

    /** Wake Spotify. `done` is always answered exactly once, on the main thread. */
    void wake(String clientId, String redirectUri, boolean keyFirst, Done done) {
        main.post(() -> start(clientId == null ? "" : clientId, redirectUri == null ? "" : redirectUri, keyFirst, done));
    }

    private void start(String clientId, String redirectUri, boolean keyFirst, Done done) {
        JSArray steps = new JSArray();
        long started = SystemClock.elapsedRealtime();
        int leftOver = hangUp();
        if (leftOver > 0) steps.put("hung up " + leftOver + " line(s) an earlier wake left open");

        boolean keySent = false;
        if (keyFirst) keySent = mediaKey(steps, started);
        if (clientId.isEmpty() || redirectUri.isEmpty()) {
            steps.put("no client id, skipping the kit");
            if (!keyFirst) keySent = mediaKey(steps, started);
            done.answer(answer(false, false, keySent ? "media-key" : "none", steps));
            return;
        }

        final boolean sentFirst = keySent;
        final boolean[] settled = { false };
        final LineKeeper keeper = new LineKeeper(app);
        line = keeper;
        Runnable giveUp = () -> {
            if (settled[0]) return;
            settled[0] = true;
            int closed = keeper.hangUp();
            if (line == keeper) line = null;
            steps.put("kit gave no answer in " + REMOTE_WAIT_MS + " ms, hung up " + closed + " line(s)");
            boolean sent = sentFirst || mediaKey(steps, started);
            done.answer(answer(false, false, sent ? "media-key" : "none", steps));
        };
        ConnectionParams params = new ConnectionParams.Builder(clientId)
            .setRedirectUri(redirectUri)
            .showAuthView(true)
            .build();
        steps.put("kit connecting");
        main.postDelayed(giveUp, REMOTE_WAIT_MS);
        SpotifyAppRemote.connect(keeper, params, new Connector.ConnectionListener() {
            @Override
            public void onConnected(SpotifyAppRemote connected) {
                if (settled[0]) {
                    // Too late to be the wake; hang it up rather than hold Spotify.
                    SpotifyAppRemote.disconnect(connected);
                    keeper.hangUp();
                    return;
                }
                settled[0] = true;
                main.removeCallbacks(giveUp);
                steps.put("kit connected at " + (SystemClock.elapsedRealtime() - started) + " ms");
                switchHere(connected, keeper, steps, started, done);
            }

            @Override
            public void onFailure(Throwable error) {
                if (settled[0]) return;
                settled[0] = true;
                main.removeCallbacks(giveUp);
                // The kit names the reason by exception class (not logged
                // in, not authorized, app not found, offline).
                String kind = error.getClass().getSimpleName();
                steps.put("kit refused: " + kind + (error.getMessage() == null ? "" : ": " + error.getMessage()));
                keeper.hangUp();
                if (line == keeper) line = null;
                boolean sent = sentFirst || mediaKey(steps, started);
                done.answer(answer(false, false, sent ? "media-key" : "none", steps));
            }
        });
    }

    /**
     * A media PLAY key down and up, sent to Spotify only. Android skips a
     * package that is in the stopped state (fresh install, or Force stop in
     * Settings) for every broadcast unless the sender asks otherwise, so a
     * force-stopped Spotify would never hear the key; the flag asks.
     */
    private boolean mediaKey(JSArray steps, long started) {
        try {
            long now = SystemClock.uptimeMillis();
            for (int action : new int[] { KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP }) {
                Intent key = new Intent(Intent.ACTION_MEDIA_BUTTON);
                key.setPackage(SPOTIFY);
                key.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
                key.putExtra(Intent.EXTRA_KEY_EVENT, new KeyEvent(now, now, action, KeyEvent.KEYCODE_MEDIA_PLAY, 0));
                app.sendBroadcast(key);
            }
            steps.put("media key sent at " + (SystemClock.elapsedRealtime() - started) + " ms");
            return true;
        } catch (Exception error) {
            steps.put("media key failed: " + error.getClass().getSimpleName());
            return false;
        }
    }

    /** Let go of Spotify once the wake has what it came for. */
    private void letGo(SpotifyAppRemote connected, LineKeeper keeper, JSArray steps) {
        SpotifyAppRemote.disconnect(connected);
        int closed = keeper.hangUp();
        if (line == keeper) line = null;
        steps.put("let go" + (closed > 0 ? ", hung up " + closed + " line(s)" : ""));
    }

    private void switchHere(SpotifyAppRemote connected, LineKeeper keeper, JSArray steps, long started, Done done) {
        connected.getConnectApi().connectSwitchToLocalDevice()
            .setResultCallback(empty -> {
                steps.put("switched here at " + (SystemClock.elapsedRealtime() - started) + " ms");
                letGo(connected, keeper, steps);
                done.answer(answer(true, true, "kit", steps));
            })
            .setErrorCallback(error -> {
                // Connected but the switch was refused: Spotify is running now,
                // which is most of the wake, so the caller still tries again.
                steps.put("switch refused: " + error.getMessage());
                letGo(connected, keeper, steps);
                done.answer(answer(true, false, "kit", steps));
            });
    }

    private static JSObject answer(boolean connected, boolean switched, String road, JSArray steps) {
        JSObject answer = new JSObject();
        answer.put("connected", connected);
        answer.put("switched", switched);
        answer.put("road", road);
        answer.put("steps", steps);
        return answer;
    }
}
