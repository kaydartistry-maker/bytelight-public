package com.bytelight.phone;

import android.app.DownloadManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.service.notification.StatusBarNotification;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.widget.Toast;

import androidx.annotation.Nullable;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private static volatile boolean pocketVoiceActive = false;

    @Override
    public void onCreate(@Nullable android.os.Bundle savedInstanceState) {
        // BridgeActivity builds the Capacitor plugin registry during
        // super.onCreate(). Register the app-local bridge first or Android
        // will compile it but the WebView will never be able to call it.
        registerPlugin(PocketVoicePlugin.class);
        registerPlugin(SpotifyRemotePlugin.class);
        BytelightCrashReporter.install(this);
        super.onCreate(savedInstanceState);
        guardRenderProcess();
    }

    /**
     * The WebView runs its page in a separate process, and when Android reclaims
     * that process — scrolling back through a long chat full of full-size photos
     * is the reliable way to provoke it — nothing is thrown on this side. The
     * platform simply kills the app unless someone says they have handled it, so
     * the app vanishes with no stack anywhere to explain it.
     *
     * Capacitor already routes the event to its listeners and returns false when
     * nobody claims it. Claiming it and rebuilding the Activity turns a
     * disappearing app into a blink, and posts the one report that would
     * otherwise never exist.
     */
    private void guardRenderProcess() {
        this.bridge.addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(android.webkit.WebView webView, RenderProcessGoneDetail detail) {
                // didCrash() false means the renderer did not fault — the system
                // reclaimed it, which is the memory-pressure shape rather than a bug
                // in the page. That distinction is the whole diagnostic.
                // didCrash() arrived with the callback in API 26; below that this
                // never fires at all, but the check keeps the call honest.
                boolean faulted = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O
                    && detail != null && detail.didCrash();
                String cause = detail == null
                    ? "detail unavailable"
                    : (faulted ? "renderer crashed" : "renderer reclaimed by the system (memory pressure)");
                new Thread(() -> BytelightCrashReporter.reportEvent(
                    MainActivity.this,
                    "webview-render-process-gone",
                    cause + "\npocketVoiceActive: " + pocketVoiceActive + "\n"
                )).start();

                // The dead WebView cannot be reused; rebuilding the Activity is the
                // supported way back and lands her on the same screen.
                webView.post(() -> {
                    if (!isFinishing() && !isDestroyed()) recreate();
                });
                return true;
            }
        });
    }

    @Override
    public void onStart() {
        super.onStart();
        BytelightCrashReporter.breadcrumb("app.visible");
        clearDeliveredNotifications();
        // The floating dock is what stands in for Bytelight while Bytelight is not on
        // screen. With the app in front, the in-app dock is the real one and a
        // second copy over the top is just clutter.
        PocketVoiceService.setAppVisible(true);

        // WebViews drop download links on the floor unless told otherwise
        // (Sidney's warning — voice/downloads need explicit wiring). Route
        // them through DownloadManager, carrying the session cookie so
        // authed routes like /api/files and /api/app/download work.
        this.bridge.getWebView().setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                // Blob/data URLs can't cross into DownloadManager; the web
                // side offers these through in-app viewers already.
                Toast.makeText(this, "Open this one from the app's viewer", Toast.LENGTH_SHORT).show();
                return;
            }
            try {
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) {
                    request.addRequestHeader("Cookie", cookies);
                }
                request.addRequestHeader("User-Agent", userAgent);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                dm.enqueue(request);
                Toast.makeText(this, "Downloading " + fileName, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * A push she has already answered by opening Bytelight is not news any more, but
     * it sat in her status bar until she went and tapped it. Clearing them on
     * the way in is what every messaging app does and what she asked for.
     *
     * Deliberately not cancelAll(): the voice call's notification is the ongoing
     * indicator for a live foreground service, not an unread message, and it has
     * to survive her looking at the app.
     */
    private void clearDeliveredNotifications() {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager == null) return;
            for (StatusBarNotification posted : manager.getActiveNotifications()) {
                if (posted.getId() == PocketVoiceService.NOTIFICATION_ID) continue;
                manager.cancel(posted.getTag(), posted.getId());
            }
        } catch (RuntimeException refused) {  // SecurityException is one of these
            // Some vendor builds guard this. A status bar that stays busy is a
            // nuisance; it is never worth failing a launch over.
            android.util.Log.e("Bytelight", "Could not clear delivered notifications", refused);
        }
    }

    @Override
    public void onStop() {
        BytelightCrashReporter.breadcrumb("app.hidden");
        PocketVoiceService.setAppVisible(false);
        super.onStop();
    }

    public static void setPocketVoiceActive(boolean active) {
        pocketVoiceActive = active;
    }

    public static boolean isPocketVoiceActive() {
        return pocketVoiceActive;
    }

    @Override
    public void onDestroy() {
        // Closing Bytelight itself ends the visible user-started call. A normal
        // hop Home leaves this Activity alive and the Bubble/notification is
        // the durable outside-Bytelight surface.
        if (isFinishing() && !isChangingConfigurations() && pocketVoiceActive) {
            PocketVoiceService.stop(this);
            setPocketVoiceActive(false);
            PocketVoicePlugin.publishState(false);
        }
        super.onDestroy();
    }
}
