// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
package com.bytelight.phone;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Wakes Spotify on their phone without the owner leaving the app (Oct 23 2026). Spotify only takes a play for a device where it is
 * already running, so a tap from the house's Spotify app with Spotify closed
 * came back as nowhere to play; the page calls wake, then sends the owner's tap again
 * through the house. The waking itself is SpotifyWaker's, shared with the
 * silent push the house sends when one of us plays the owner a song.
 *
 * The kit needs this app's package name and signing fingerprint on the
 * Spotify app's developer page, the client id and a redirect registered to it
 * (the page hands both in, read off the house), and Spotify installed and
 * signed in. The first connect may show Spotify's own consent screen.
 */
@CapacitorPlugin(name = "SpotifyRemote")
public class SpotifyRemotePlugin extends Plugin {

    private SpotifyWaker waker;

    private SpotifyWaker waker() {
        if (waker == null) waker = new SpotifyWaker(getContext());
        return waker;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("installed", SpotifyWaker.installed(getContext()));
        answer.put("connected", waker != null && waker.holding());
        call.resolve(answer);
    }

    /** Wake Spotify on this phone; the answer carries every step it took. */
    @PluginMethod
    public void wake(PluginCall call) {
        if (!SpotifyWaker.installed(getContext())) {
            call.reject("Spotify isn't installed on this phone.", "NOT_INSTALLED");
            return;
        }
        waker().wake(call.getString("clientId", ""), call.getString("redirectUri", ""), false, call::resolve);
    }

    @Override
    protected void handleOnDestroy() {
        if (waker != null) waker.hangUp();
        super.handleOnDestroy();
    }
}
