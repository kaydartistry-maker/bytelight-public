package com.bytelight.phone;

import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;

import com.getcapacitor.CapConfig;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * A native crash on a sideloaded phone is otherwise invisible from the house:
 * there is no Play Console, no adb, and the owner sees only an app that
 * vanished. This catches the stack on its way out, writes it beside the app
 * and posts it home, so the next report can be a stack trace rather than a
 * description.
 *
 * It never swallows the crash — the platform handler still runs, and the app
 * still dies the way Android intends.
 */
final class BytelightCrashReporter {
    private static final String TAG = "BytelightCrash";
    private static boolean installed = false;

    private BytelightCrashReporter() {}

    /**
     * The watchdog exception that kills this app for a broken foreground promise
     * is thrown by the platform, so its stack can only ever say "this service
     * did not report in time" — never which of our paths got there. Twice now
     * that has meant guessing. These are the app's own footprints, carried into
     * the report so the next one names the route instead of the symptom.
     */
    private static final int TRAIL_LIMIT = 40;
    private static final java.util.ArrayDeque<String> trail = new java.util.ArrayDeque<>();

    static void breadcrumb(String note) {
        synchronized (trail) {
            if (trail.size() >= TRAIL_LIMIT) trail.removeFirst();
            trail.addLast(System.currentTimeMillis() + " " + note);
        }
    }

    private static String trailText() {
        synchronized (trail) {
            if (trail.isEmpty()) return "(no breadcrumbs)";
            StringBuilder text = new StringBuilder();
            long first = 0;
            for (String entry : trail) {
                int gap = entry.indexOf(' ');
                long stamp = Long.parseLong(entry.substring(0, gap));
                if (first == 0) first = stamp;
                // Relative to the first crumb: what matters is the spacing, and
                // a five-second gap before the kill is the whole story.
                text.append('+').append(stamp - first).append("ms ")
                    .append(entry.substring(gap + 1)).append('\n');
            }
            return text.toString();
        }
    }

    static void install(Context context) {
        if (installed) return;
        installed = true;
        Context app = context.getApplicationContext();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();

        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                report(app, thread, error);
            } catch (Throwable reportingFailure) {
                // Never let the reporter be the reason a crash gets worse.
                Log.e(TAG, "Could not record the crash", reportingFailure);
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    private static void report(Context context, Thread thread, Throwable error) {
        StringWriter stack = new StringWriter();
        error.printStackTrace(new PrintWriter(stack));
        String body = describe(thread, stack.toString(), version(context));

        writeBeside(context, body);
        postHome(context, body);
    }

    /**
     * Not every way this app dies arrives as a Java exception. When the WebView's
     * own render process is killed the app process is taken down by the platform
     * with nothing thrown, so the handler above never sees it and the owner is
     * left describing an app that vanished. This is the same pipe for the deaths
     * that have no stack.
     */
    static void reportEvent(Context context, String label, String detail) {
        try {
            Context app = context.getApplicationContext();
            StringBuilder text = new StringBuilder();
            text.append("event: ").append(label).append('\n');
            text.append("device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
                .append(" · Android ").append(Build.VERSION.RELEASE)
                .append(" (sdk ").append(Build.VERSION.SDK_INT).append(")\n");
            text.append("app: ").append(version(app)).append("\n\n");
            text.append("trail:\n").append(trailText()).append('\n');
            text.append(detail == null ? "" : detail);
            String body = text.toString();
            writeBeside(app, body);
            postHome(app, body);
        } catch (Throwable reportingFailure) {
            Log.e(TAG, "Could not record " + label, reportingFailure);
        }
    }

    private static String describe(Thread thread, String stack, String appVersion) {
        StringBuilder text = new StringBuilder();
        text.append("thread: ").append(thread == null ? "?" : thread.getName()).append('\n');
        text.append("device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(" · Android ").append(Build.VERSION.RELEASE)
            .append(" (sdk ").append(Build.VERSION.SDK_INT).append(")\n");
        text.append("app: ").append(appVersion).append("\n\n");
        text.append("trail:\n").append(trailText()).append('\n');
        text.append(stack);
        return text.toString();
    }

    /** Read from the installed package rather than a generated constant. */
    private static String version(Context context) {
        try {
            android.content.pm.PackageInfo info = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
            return info.versionName + " (code " + code + ")";
        } catch (Exception failure) {
            return "unknown";
        }
    }

    /**
     * The on-device copy is the one that survives having no network. It lives
     * in the app's own external files dir so it can be pulled off by hand.
     */
    private static void writeBeside(Context context, String body) {
        try {
            File file = besideFile(context);
            if (file == null) return;
            try (OutputStream out = new FileOutputStream(file, false)) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception failure) {
            Log.e(TAG, "Could not write the crash file", failure);
        }
    }

    /** The on-device copy, for the page to post once it is authenticated again. */
    static String readBeside(Context context) {
        try {
            File file = besideFile(context);
            if (file == null || !file.exists()) return null;
            byte[] bytes = new byte[(int) Math.min(file.length(), 64 * 1024)];
            try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
                int read = in.read(bytes);
                if (read <= 0) return null;
                return new String(bytes, 0, read, StandardCharsets.UTF_8);
            }
        } catch (Exception failure) {
            Log.e(TAG, "Could not read the crash file", failure);
            return null;
        }
    }

    static void clearBeside(Context context) {
        try {
            File file = besideFile(context);
            if (file != null && file.exists() && !file.delete()) {
                Log.e(TAG, "Could not remove the crash file");
            }
        } catch (Exception failure) {
            Log.e(TAG, "Could not remove the crash file", failure);
        }
    }

    private static File besideFile(Context context) {
        File dir = context.getExternalFilesDir(null);
        return dir == null ? null : new File(dir, "last-crash.txt");
    }

    /**
     * Best effort, on the dying process's own time. A crash handler has only a
     * few seconds before the platform kills the process, so this is short,
     * synchronous and gives up quietly.
     */
    private static void postHome(Context context, String body) {
        String origin = serverOrigin(context);
        if (origin == null) return;
        try {
            String endpoint = origin + "/api/app/crash";
            JSONObject payload = new JSONObject();
            payload.put("report", body);

            HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(2500);
            connection.setReadTimeout(2500);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            String cookies = CookieManager.getInstance().getCookie(endpoint);
            if (cookies != null) connection.setRequestProperty("Cookie", cookies);

            try (OutputStream out = connection.getOutputStream()) {
                out.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }
            connection.getResponseCode();
            connection.disconnect();
        } catch (Exception failure) {
            Log.e(TAG, "Could not post the crash home", failure);
        }
    }

    private static String serverOrigin(Context context) {
        try {
            String url = CapConfig.loadDefault(context).getServerUrl();
            if (url == null || url.trim().isEmpty()) return null;
            URL parsed = new URL(url.trim());
            String origin = parsed.getProtocol() + "://" + parsed.getHost();
            if (parsed.getPort() != -1) origin = origin + ":" + parsed.getPort();
            return origin;
        } catch (Exception failure) {
            return null;
        }
    }
}
