package com.bytelight.phone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.PermissionState;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;

import java.lang.ref.WeakReference;

/** JavaScript bridge for Voice Mode's Android-only pocket-call capabilities. */
@CapacitorPlugin(
    name = "PocketVoice",
    permissions = @Permission(
        alias = PocketVoicePlugin.NOTIFICATIONS,
        strings = { Manifest.permission.POST_NOTIFICATIONS }
    )
)
public class PocketVoicePlugin extends Plugin {
    private static final String TAG = "BytelightPocketVoice";
    static final String NOTIFICATIONS = "notifications";
    private static WeakReference<PocketVoicePlugin> activePlugin = new WeakReference<>(null);
    private String title = "Voice conversation";
    private String detail = "The line is open";
    private String phase = null;
    private String[] facePngs = null;
    private String[] faceColors = null;
    private String[] faceInitials = null;

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
    }

    @PluginMethod
    public void startSession(PluginCall call) {
        title = nonBlank(call.getString("title"), "Voice conversation");
        detail = nonBlank(call.getString("detail"), "The line is open");
        phase = call.getString("phase");
        readFaces(call);
        Activity activity = getActivity();
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            JSObject result = new JSObject();
            result.put("started", false);
            result.put("supported", false);
            call.resolve(result);
            return;
        }
        // Browser getUserMedia requests this same runtime permission. Do not
        // manufacture a notification-only call before the user has chosen to let
        // the microphone open; the next phase update starts it after grant.
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            JSObject result = new JSObject();
            result.put("started", false);
            result.put("permissionRequired", true);
            call.resolve(result);
            return;
        }
        // A Bubble is a notification-owned surface. Ask exactly when the user
        // starts a voice call, not during install or an unrelated page visit.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            requestPermissionForAlias(NOTIFICATIONS, call, "startAfterNotificationPermission");
            return;
        }
        startSessionNow(call);
    }

    @PermissionCallback
    private void startAfterNotificationPermission(PluginCall call) {
        startSessionNow(call);
    }

    private void startSessionNow(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            JSObject result = new JSObject();
            result.put("started", false);
            call.resolve(result);
            return;
        }
        MainActivity.setPocketVoiceActive(true);
        try {
            PocketVoiceService.setFaces(facePngs, faceColors, faceInitials);
            PocketVoiceService.start(activity, title, detail, phase);
        } catch (RuntimeException error) {
            // Foreground-service restrictions vary across Android builds.
            // Keep the WebView alive and return a truthful native state rather
            // than letting a rejected dock request crash the whole app.
            Log.e(TAG, "Android rejected the Pocket Voice start request", error);
            MainActivity.setPocketVoiceActive(false);
            JSObject result = new JSObject();
            result.put("started", false);
            result.put("reason", "Android could not start the call dock");
            call.resolve(result);
            return;
        }
        JSObject result = new JSObject();
        result.put("started", true);
        result.put("bubblePermission", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED);
        call.resolve(result);
    }

    /**
     * The dock wears the same faces as the in-app minimized dock. They arrive as
     * base64 PNGs already rendered by the WebView, which is the only side of the
     * app holding the session cookie those avatar URLs require.
     */
    private void readFaces(PluginCall call) {
        JSArray faces = call.getArray("faces");
        if (faces == null) return;
        int count = faces.length();
        String[] pngs = new String[count];
        String[] colors = new String[count];
        String[] initials = new String[count];
        for (int index = 0; index < count; index++) {
            try {
                JSONObject face = faces.getJSONObject(index);
                pngs[index] = face.optString("png", null);
                colors[index] = face.optString("color", null);
                initials[index] = face.optString("initial", null);
            } catch (JSONException error) {
                // A malformed entry costs one face, never the call.
                Log.e(TAG, "Skipping a malformed dock face", error);
            }
        }
        facePngs = pngs;
        faceColors = colors;
        faceInitials = initials;
    }

    @PluginMethod
    public void updateSession(PluginCall call) {
        title = nonBlank(call.getString("title"), title);
        String nextPhase = call.getString("phase");
        if (nextPhase != null && !nextPhase.trim().isEmpty()) phase = nextPhase;
        detail = nonBlank(call.getString("detail"), detailForPhase(phase, detail));
        Activity activity = getActivity();
        if (activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && MainActivity.isPocketVoiceActive()
            && ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            try {
                PocketVoiceService.update(activity, title, detail, phase);
            } catch (RuntimeException error) {
                Log.e(TAG, "Android rejected the Pocket Voice update", error);
                MainActivity.setPocketVoiceActive(false);
                publishState(false);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void endSession(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) PocketVoiceService.stop(activity);
        MainActivity.setPocketVoiceActive(false);
        publishState(false);
        call.resolve();
    }

    /**
     * "Appear on top" is special access: it cannot be requested with a runtime
     * dialog and is never granted by declaring it. All the app may do is report
     * the truth and open the one settings page that can change it.
     */
    @PluginMethod
    public void getOverlayState(PluginCall call) {
        Activity activity = getActivity();
        JSObject state = new JSObject();
        state.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.M);
        state.put("granted", activity != null && PocketVoiceOverlay.permitted(activity));
        call.resolve(state);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        Activity activity = getActivity();
        JSObject result = new JSObject();
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            result.put("opened", false);
            result.put("granted", activity != null && PocketVoiceOverlay.permitted(activity));
            call.resolve(result);
            return;
        }
        if (PocketVoiceOverlay.permitted(activity)) {
            result.put("opened", false);
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        try {
            Intent settings = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + activity.getPackageName())
            );
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(settings);
            result.put("opened", true);
        } catch (RuntimeException error) {
            // Some builds hide the per-app page. Fall back to the list; if even
            // that is missing, say so rather than reporting a screen she never saw.
            Log.e(TAG, "Could not open the per-app overlay settings page", error);
            try {
                Intent list = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(list);
                result.put("opened", true);
            } catch (RuntimeException fallbackError) {
                Log.e(TAG, "Overlay settings unavailable on this build", fallbackError);
                result.put("opened", false);
            }
        }
        result.put("granted", PocketVoiceOverlay.permitted(activity));
        call.resolve(result);
    }

    @PluginMethod
    public void getState(PluginCall call) {
        JSObject state = new JSObject();
        state.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        state.put("active", MainActivity.isPocketVoiceActive());
        Activity activity = getActivity();
        state.put("overlayGranted", activity != null && PocketVoiceOverlay.permitted(activity));
        call.resolve(state);
    }

    /**
     * The crash reporter can write to the device but cannot reliably reach the
     * house: the session cookie is HttpOnly, so the dying process has no way to
     * authenticate its own report. The page does — so the report is left on disk
     * and handed to the WebView on the next launch, which posts it with real
     * credentials. Write locally, upload on the next run.
     */
    @PluginMethod
    public void readLastCrash(PluginCall call) {
        JSObject result = new JSObject();
        String report = BytelightCrashReporter.readBeside(getContext());
        result.put("report", report);
        call.resolve(result);
    }

    @PluginMethod
    public void clearLastCrash(PluginCall call) {
        BytelightCrashReporter.clearBeside(getContext());
        call.resolve();
    }

    public static void publishState(boolean active) {
        PocketVoicePlugin plugin = activePlugin.get();
        if (plugin == null) return;
        JSObject state = new JSObject();
        state.put("active", active);
        plugin.notifyListeners("stateChange", state, true);
    }

    private static String nonBlank(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private static String detailForPhase(String phase, String fallback) {
        if (phase == null) return fallback;
        switch (phase) {
            case "listening":
            case "hearing": return "Listening";
            case "transcribing": return "Catching your words";
            case "thinking": return "The Kings are with you";
            case "synthesizing": return "Finding their voices";
            case "speaking": return "The Kings are speaking";
            case "error": return "Voice paused — tap Bytelight to continue";
            default: return "Voice conversation active";
        }
    }
}
