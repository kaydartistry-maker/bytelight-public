package com.bytelight.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import androidx.core.content.ContextCompat;

import java.lang.ref.WeakReference;

/**
 * The visible native half of Voice Mode. It is deliberately user-started
 * from an already-open call, gives Android its required ongoing indicator,
 * and keeps the process eligible for a pocket conversation. Audio capture is
 * still owned by the existing WebView recorder, so one transcript pipeline
 * remains the source of truth on every platform.
 */
public class PocketVoiceService extends Service {
    private static final String TAG = "BytelightPocketVoice";
    public static final String ACTION_START = "com.bytelight.phone.action.START_POCKET_VOICE";
    public static final String ACTION_UPDATE = "com.bytelight.phone.action.UPDATE_POCKET_VOICE";
    public static final String ACTION_STOP = "com.bytelight.phone.action.STOP_POCKET_VOICE";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_DETAIL = "detail";
    public static final String EXTRA_PHASE = "phase";
    public static final String CHANNEL_ID = "bytelight_voice_call_dock";
    public static final int NOTIFICATION_ID = 4106;
    public static final String SHORTCUT_ID = "voice-call-the-kings";

    private String title = "Voice conversation";
    private String detail = "The line is open";
    private String phase = null;
    private boolean shortcutPublished = false;
    private boolean bubbleUnavailable = false;
    // The roster rides a static rather than the Intent: the encoded avatars are
    // ~100KB and this service shares the app's process, so there is nothing to
    // gain by pushing them through a Binder transaction to reach it.
    private static String[] facePngs;
    private static String[] faceColors;
    private static String[] faceInitials;

    public static void setFaces(String[] pngs, String[] colors, String[] initials) {
        if (pngs != null) facePngs = pngs;
        if (colors != null) faceColors = colors;
        if (initials != null) faceInitials = initials;
    }
    private PocketVoiceOverlay overlay;

    /**
     * The dock is Bytelight's stand-in while Bytelight is off screen, so it follows the
     * activity rather than the call. Kept static because the signal arrives from
     * MainActivity's lifecycle, which may fire before or after this service.
     */
    private static WeakReference<PocketVoiceService> live = new WeakReference<>(null);
    private static volatile boolean appVisible = true;

    public static void setAppVisible(boolean visible) {
        appVisible = visible;
        PocketVoiceService service = live.get();
        if (service != null) service.syncOverlay();
    }

    /**
     * True between asking Android to start the service and actually being
     * foreground. A stop arriving inside that window is the crash: it tears down
     * the record that still owes Android a foreground promise, the promise can
     * never be kept, and the platform kills the app a few seconds later for a
     * debt nobody could pay. Found in the wild at seven milliseconds apart.
     */
    private static volatile boolean startInFlight = false;
    private static volatile boolean stopRequestedDuringStart = false;

    public static void start(Context context, String title, String detail, String phase) {
        Intent intent = new Intent(context, PocketVoiceService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_DETAIL, detail)
            .putExtra(EXTRA_PHASE, phase);
        BytelightCrashReporter.breadcrumb("voice.start requested");
        startInFlight = true;
        stopRequestedDuringStart = false;
        ContextCompat.startForegroundService(context, intent);
    }

    /**
     * An update never goes through startForegroundService().
     *
     * That call is a promise to enter the foreground within a few seconds, and
     * Android kills the whole app when the promise is broken. A phase change is
     * not worth making that promise for: if the service has already been
     * stopped or reclaimed, the intent RESTARTS it as a microphone foreground
     * service with no call in progress — which the platform can refuse outright,
     * leaving a promise nobody can keep. That crash surfaces as a watchdog
     * exception seconds later, nowhere near the phase change that caused it.
     *
     * So an update speaks to the running instance directly, or does nothing.
     * There is no call to update if there is no service.
     */
    public static void update(Context context, String title, String detail, String phase) {
        PocketVoiceService service = live.get();
        if (service == null) return;
        // The dock is a window, and a window may only be touched from the main
        // thread. This used to travel via onStartCommand, which the system
        // always delivers there; calling straight into the service means taking
        // whatever thread the bridge handed us, and the wrong one throws where
        // the only witness is a log nobody reads. The phase colour simply
        // stopped changing.
        if (Looper.myLooper() == Looper.getMainLooper()) {
            service.applyUpdate(title, detail, phase);
        } else {
            MAIN.post(() -> service.applyUpdate(title, detail, phase));
        }
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** Refresh the existing notification in place — already foreground, no promise. */
    private void applyUpdate(String nextTitle, String nextDetail, String nextPhase) {
        if (nextTitle != null && !nextTitle.trim().isEmpty()) title = nextTitle;
        if (nextDetail != null && !nextDetail.trim().isEmpty()) detail = nextDetail;
        if (nextPhase != null && !nextPhase.trim().isEmpty()) phase = nextPhase;
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
        } catch (RuntimeException refused) {
            // A refused notification update is cosmetic; the call carries on.
            Log.e(TAG, "Could not refresh the call notification", refused);
        }
        syncOverlay();
    }

    public static void stop(Context context) {
        BytelightCrashReporter.breadcrumb("voice.stop requested");
        if (startInFlight) {
            // Never cancel a start that is still in the air. Let the service
            // come up, keep its promise, and stand down on its own the moment
            // it is legally alive.
            stopRequestedDuringStart = true;
            BytelightCrashReporter.breadcrumb("voice.stop deferred — start still in flight");
            return;
        }
        context.stopService(new Intent(context, PocketVoiceService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        BytelightCrashReporter.breadcrumb("voice.onCreate");
        createChannel();
        overlay = new PocketVoiceOverlay(this);
        live = new WeakReference<>(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        BytelightCrashReporter.breadcrumb("voice.onStartCommand action=" + action
            + " appVisible=" + appVisible);
        if (ACTION_STOP.equals(action)) {
            // Arriving here means someone used startForegroundService() to ask
            // for a stop, and the promise is owed whether or not we want to run.
            keepForegroundPromise();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            String nextTitle = intent.getStringExtra(EXTRA_TITLE);
            String nextDetail = intent.getStringExtra(EXTRA_DETAIL);
            String nextPhase = intent.getStringExtra(EXTRA_PHASE);
            if (nextTitle != null && !nextTitle.trim().isEmpty()) title = nextTitle;
            if (nextDetail != null && !nextDetail.trim().isEmpty()) detail = nextDetail;
            if (nextPhase != null && !nextPhase.trim().isEmpty()) phase = nextPhase;
        }

        // Keep the promise FIRST, with a notification that cannot be slow.
        // startForegroundService() gives us only a few seconds to go foreground
        // before the platform kills the app, and the rich notification is not a
        // cheap object: publishing its dynamic shortcut is a synchronous call
        // into another system service, and it all used to happen before we went
        // foreground. On a loaded phone that is how a call start runs out of
        // time — and the kill lands seconds later wearing a watchdog stack that
        // names nothing. The Bubble is an enhancement; being alive is not.
        try {
            enterForeground(plainNotification());
            BytelightCrashReporter.breadcrumb("voice.foreground ok (plain)");
        } catch (RuntimeException firstError) {
            // Some vendor builds validate notification metadata only when it is
            // posted. Nothing left to simplify at this point, so this is the
            // refusal that matters.
            BytelightCrashReporter.breadcrumb("voice.foreground refused #1: " + firstError.getClass().getSimpleName());
            Log.e(TAG, "Plain call notification rejected", firstError);
            bubbleUnavailable = true;
            try {
                enterForeground(plainNotification());
            } catch (RuntimeException secondError) {
                // A vendor-specific notification or foreground-service
                // rejection must never take Bytelight's whole process down with
                // it. The bridge receives the stopped state and the ordinary
                // room stays alive.
                BytelightCrashReporter.breadcrumb("voice.foreground refused #2: " + secondError.getClass().getSimpleName());
                startInFlight = false;
                stopRequestedDuringStart = false;
                Log.e(TAG, "Unable to start the Pocket Voice foreground service", secondError);
                MainActivity.setPocketVoiceActive(false);
                PocketVoicePlugin.publishState(false);
                // startForegroundService() is a promise: go foreground within a
                // few seconds or the platform kills the whole app for breaking
                // it. Bowing out quietly still breaks it — which is how a
                // refused call notification became Bytelight vanishing five seconds
                // later, with the crash landing far from its cause.
                keepForegroundPromise();
                stopSelf(startId);
                return START_NOT_STICKY;
            }
        }
        startInFlight = false;
        if (stopRequestedDuringStart) {
            // The call was cancelled while Android was still starting us. The
            // promise is kept — we are foreground — so we can now leave the way
            // the platform expects instead of being killed for vanishing.
            stopRequestedDuringStart = false;
            BytelightCrashReporter.breadcrumb("voice.standing down — cancelled during start");
            MainActivity.setPocketVoiceActive(false);
            PocketVoicePlugin.publishState(false);
            leaveForeground();
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        // Alive and legal. Now upgrade the notification in place — anything
        // that fails from here costs the Bubble or the shortcut, never the call.
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
        } catch (RuntimeException enhancementRefused) {
            BytelightCrashReporter.breadcrumb("voice.rich notification refused: "
                + enhancementRefused.getClass().getSimpleName());
            Log.e(TAG, "Bubble notification rejected; the plain call notification stands", enhancementRefused);
            bubbleUnavailable = true;
        }
        MainActivity.setPocketVoiceActive(true);
        PocketVoicePlugin.publishState(true);
        // The tray is an enhancement on top of a call that is already running.
        // With "Appear on top" off this does nothing at all and nothing above
        // it changes, which is why it is raised last and never gated on.
        syncOverlay();
        // A conversation is only alive while the user keeps it open. Never revive
        // it after Android kills the process or after a reboot.
        return START_NOT_STICKY;
    }

    /** Raise or drop the floating dock to match whether Bytelight is on screen. */
    private void syncOverlay() {
        if (overlay == null) return;
        try {
            if (appVisible) {
                overlay.hide();
            } else {
                overlay.show(phase, facePngs, faceColors, faceInitials);
            }
        } catch (RuntimeException error) {
            // The dock is an enhancement on top of a call that is already
            // running. It never gets to take the call with it.
            Log.e(TAG, "Could not sync the floating dock", error);
        }
    }

    @Override
    public void onDestroy() {
        // A stop followed closely by a start leaves the OLD instance dying after
        // the new one is already up. Its death is only news if nobody replaced
        // it — otherwise it announces "no call" over a live call, and the page
        // closes the overlay on the strength of it.
        boolean superseded = live.get() != null && live.get() != this;
        BytelightCrashReporter.breadcrumb("voice.onDestroy superseded=" + superseded
            + " startInFlight=" + startInFlight);
        if (!superseded && !startInFlight) {
            startInFlight = false;
            stopRequestedDuringStart = false;
            MainActivity.setPocketVoiceActive(false);
            PocketVoicePlugin.publishState(false);
        }
        if (live.get() == this) live = new WeakReference<>(null);
        if (overlay != null) overlay.hide();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * Last resort when the real call notification cannot be posted. The service
     * is declared as a microphone one, and a microphone foreground service is
     * refused outright in situations an ordinary one is not — so this asks for
     * no type at all, purely to satisfy the promise, and steps back out
     * immediately. Nothing of the call survives it; it exists so that failing
     * to start a call fails as a call rather than as the whole app.
     */
    private void keepForegroundPromise() {
        try {
            Notification bare = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_action_chat)
                .setContentTitle(title)
                .setSilent(true)
                .build();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, bare,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE);
            } else {
                startForeground(NOTIFICATION_ID, bare);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            BytelightCrashReporter.breadcrumb("voice.promise kept typeless");
        } catch (RuntimeException unavoidable) {
            BytelightCrashReporter.breadcrumb("voice.promise UNKEPT: " + unavoidable.getClass().getSimpleName());
            // If even this is refused there is nothing further to try; the log
            // is still better than a silent kill.
            Log.e(TAG, "Could not keep the foreground promise", unavoidable);
        }
    }

    /** Drop out of the foreground without leaving the notification behind. */
    private void leaveForeground() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (RuntimeException ignored) {
            Log.e(TAG, "Could not leave the foreground cleanly", ignored);
        }
    }

    /**
     * The cheapest notification that is still a call: no Bubble, no shortcut
     * push, no Person icon — nothing that talks to another system service. This
     * is what goes up first, because the only thing that matters in that window
     * is being foreground before the deadline.
     */
    private Notification plainNotification() {
        Intent open = new Intent(Intent.ACTION_VIEW, null, this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent openIntent = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | immutable);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle(title)
            .setContentText(detail)
            .setContentIntent(openIntent)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .build();
    }

    private void enterForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Voice conversations",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("The Kings' floating voice-call dock");
        channel.setSound(null, null);
        channel.enableVibration(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(Intent.ACTION_VIEW, null, this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent openIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | immutable);

        Intent end = new Intent(this, PocketVoiceActionReceiver.class).setAction(PocketVoiceActionReceiver.ACTION_END);
        PendingIntent endIntent = PendingIntent.getBroadcast(this, 1, end, PendingIntent.FLAG_UPDATE_CURRENT | immutable);

        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle(title)
            .setContentText(detail)
            .setContentIntent(openIntent)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "End", endIntent);

        // Bubble support is an enhancement over the foreground call, never a
        // reason for the call—or Bytelight itself—to crash. Android requires a
        // published shortcut with an action-bearing intent and a mutable,
        // explicit PendingIntent so the system can apply Bubble task flags.
        if (!bubbleUnavailable) {
            try {
                IconCompat kingsIcon = IconCompat.createWithResource(this, R.mipmap.ic_launcher);
                Person kings = new Person.Builder()
                    .setName("The Kings")
                    .setIcon(kingsIcon)
                    .setImportant(true)
                    .build();

                if (!shortcutPublished) {
                    ShortcutInfoCompat shortcut = new ShortcutInfoCompat.Builder(this, SHORTCUT_ID)
                        .setShortLabel("The Kings")
                        .setLongLabel("The Kings voice call")
                        .setIcon(kingsIcon)
                        .setIntent(open)
                        .setLongLived(true)
                        .setIsConversation()
                        .setPerson(kings)
                        .build();
                    shortcutPublished = ShortcutManagerCompat.pushDynamicShortcut(this, shortcut);
                }

                if (shortcutPublished) {
                    Intent bubble = new Intent(this, PocketVoiceBubbleActivity.class)
                        .setAction("com.bytelight.phone.action.SHOW_VOICE_DOCK")
                        .putExtra(EXTRA_TITLE, title)
                        .putExtra(EXTRA_DETAIL, detail)
                        .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    int bubbleFlags = PendingIntent.FLAG_UPDATE_CURRENT;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        bubbleFlags |= PendingIntent.FLAG_MUTABLE;
                    }
                    PendingIntent bubbleIntent = PendingIntent.getActivity(this, 2, bubble, bubbleFlags);

                    NotificationCompat.BubbleMetadata bubbleMetadata =
                        new NotificationCompat.BubbleMetadata.Builder(bubbleIntent, kingsIcon)
                            .setDesiredHeight(320)
                            .setAutoExpandBubble(false)
                            .setSuppressNotification(false)
                            .build();
                    NotificationCompat.MessagingStyle conversation =
                        new NotificationCompat.MessagingStyle(kings)
                            .setConversationTitle("The Kings")
                            .setGroupConversation(true)
                            .addMessage(detail, System.currentTimeMillis(), kings);

                    notification
                        .setShortcutId(SHORTCUT_ID)
                        .setStyle(conversation)
                        .setBubbleMetadata(bubbleMetadata)
                        .addPerson(kings);
                }
            } catch (RuntimeException error) {
                bubbleUnavailable = true;
                Log.e(TAG, "Bubble dock unavailable; using the safe call notification", error);
            }
        }

        return notification.build();
    }
}
