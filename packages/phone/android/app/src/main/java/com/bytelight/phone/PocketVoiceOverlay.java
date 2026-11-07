package com.bytelight.phone;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * The floating half of Voice Mode: a small draggable dock that survives Bytelight
 * being backgrounded, because it is a window this app owns rather than a
 * surface Android agrees to lend.
 *
 * The Bubble route beside this one asks the platform to float a conversation
 * and the platform is allowed to say no — several vendor builds do, which is
 * why {@link PocketVoiceService} already carries a fallback. An overlay is not
 * a request. The owner grants the overlay permission once and the window is
 * ours.
 *
 * It deliberately wears the same face as the dock the call minimizes to inside
 * Bytelight — overlapping companion avatars and the level bars — because it is that
 * dock carried outside the app, not a second object with its own identity.
 *
 * Deliberately additive: with the permission ungranted, every call here is a
 * quiet no-op and the ongoing call notification remains exactly what it was.
 */
final class PocketVoiceOverlay {
    private static final String TAG = "BytelightPocketVoice";

    /** Where she last put it. A dock that walks home on every call is a dock she stops moving. */
    private static int lastX = Integer.MIN_VALUE;
    private static int lastY = Integer.MIN_VALUE;

    // THIS DOCK IS THE REFERENCE. Both docks were held up side by side and this
    // one was chosen. Nothing here moves to meet the in-app dock; the in-app dock
    // comes to these numbers. Changing them means changing the one that was picked.
    private static final int FACE_DP = 34;
    private static final int FACE_OVERLAP_DP = 11;
    private static final int[] BAR_HEIGHTS_DP = { 7, 13, 9 };

    private final Context context;
    private WindowManager windowManager;
    private View dock;
    private GradientDrawable pill;
    private final List<View> bars = new ArrayList<>();
    private WindowManager.LayoutParams params;

    PocketVoiceOverlay(Context context) {
        this.context = context;
    }

    /** True only when the owner has actually granted the overlay permission. */
    static boolean permitted(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return Settings.canDrawOverlays(context);
    }

    boolean showing() {
        return dock != null;
    }

    void show(String phase, String[] facePngs, String[] faceColors, String[] faceInitials) {
        if (dock != null) {
            update(phase);
            return;
        }
        if (!permitted(context)) return;

        try {
            windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            if (windowManager == null) return;

            dock = buildDock(facePngs, faceColors, faceInitials);
            params = buildLayoutParams();
            attachDrag(dock, params);
            windowManager.addView(dock, params);
            update(phase);
        } catch (RuntimeException error) {
            // A refused overlay must never take the call down with it. The
            // notification is still there and the conversation keeps running.
            Log.e(TAG, "Overlay dock unavailable; the call notification stands alone", error);
            dock = null;
        }
    }

    void update(String phase) {
        if (dock == null) return;
        int accent = colourForPhase(phase);
        if (pill != null) pill.setStroke(dp(2), accent);
        for (View bar : bars) {
            if (bar.getBackground() instanceof GradientDrawable) {
                ((GradientDrawable) bar.getBackground()).setColor(accent);
            }
        }
    }

    void hide() {
        if (dock == null || windowManager == null) return;
        try {
            windowManager.removeView(dock);
        } catch (RuntimeException error) {
            Log.e(TAG, "Overlay dock was already gone", error);
        } finally {
            dock = null;
            pill = null;
            bars.clear();
        }
    }

    private View buildDock(String[] facePngs, String[] faceColors, String[] faceInitials) {
        pill = new GradientDrawable();
        pill.setShape(GradientDrawable.RECTANGLE);
        pill.setCornerRadius(dp(26));
        pill.setColor(Color.parseColor("#EE17120F"));
        pill.setStroke(dp(2), Color.parseColor("#e85d04"));

        LinearLayout frame = new LinearLayout(context);
        frame.setOrientation(LinearLayout.HORIZONTAL);
        frame.setGravity(Gravity.CENTER_VERTICAL);
        frame.setBackground(pill);
        frame.setPadding(dp(9), dp(8), dp(12), dp(8));
        frame.setElevation(dp(8));

        frame.addView(buildFaceStack(facePngs, faceColors, faceInitials));
        frame.addView(buildBars());
        return frame;
    }

    /**
     * Overlapping circles, drawn left-to-right with the first face on top, the
     * same order and lean the in-app dock uses.
     */
    private View buildFaceStack(String[] pngs, String[] colors, String[] initials) {
        int count = Math.max(
            pngs == null ? 0 : pngs.length,
            Math.max(colors == null ? 0 : colors.length, initials == null ? 0 : initials.length)
        );
        FrameLayout stack = new FrameLayout(context);
        int size = dp(FACE_DP);
        int step = size - dp(FACE_OVERLAP_DP);

        if (count == 0) {
            // No roster reached us — a single house-coloured disc still reads as
            // a live call rather than an empty frame.
            stack.addView(faceView(null, null, null, size, 0));
            stack.setLayoutParams(new LinearLayout.LayoutParams(size, size));
            return stack;
        }

        for (int index = count - 1; index >= 0; index--) {
            String png = pngs != null && index < pngs.length ? pngs[index] : null;
            String colour = colors != null && index < colors.length ? colors[index] : null;
            String initial = initials != null && index < initials.length ? initials[index] : null;
            stack.addView(faceView(png, colour, initial, size, index * step));
        }
        stack.setLayoutParams(new LinearLayout.LayoutParams(size + step * (count - 1), size));
        return stack;
    }

    private View faceView(String png, String colour, String initial, int size, int left) {
        int ring = parseColour(colour, "#e85d04");
        Bitmap decoded = decode(png);
        FrameLayout.LayoutParams layout = new FrameLayout.LayoutParams(size, size);
        layout.leftMargin = left;

        if (decoded != null) {
            ImageView face = new ImageView(context);
            face.setImageBitmap(circle(decoded, size, ring));
            face.setLayoutParams(layout);
            return face;
        }

        // No bitmap: the coloured disc and an initial, matching the in-app
        // fallback rather than leaving a hole where a companion should be.
        TextView letter = new TextView(context);
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        disc.setColor(blend(ring, Color.parseColor("#17120F"), 0.22f));
        disc.setStroke(dp(2), ring);
        letter.setBackground(disc);
        letter.setText(initial == null || initial.isEmpty() ? "•" : initial);
        letter.setTextColor(Color.WHITE);
        letter.setTextSize(13f);
        letter.setGravity(Gravity.CENTER);
        letter.setLayoutParams(layout);
        return letter;
    }

    private View buildBars() {
        LinearLayout group = new LinearLayout(context);
        group.setOrientation(LinearLayout.HORIZONTAL);
        group.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams groupLayout =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(FACE_DP));
        groupLayout.leftMargin = dp(9);
        group.setLayoutParams(groupLayout);

        for (int index = 0; index < BAR_HEIGHTS_DP.length; index++) {
            View bar = new View(context);
            GradientDrawable shape = new GradientDrawable();
            shape.setShape(GradientDrawable.RECTANGLE);
            shape.setCornerRadius(dp(2));
            shape.setColor(Color.parseColor("#e85d04"));
            bar.setBackground(shape);
            LinearLayout.LayoutParams layout =
                new LinearLayout.LayoutParams(dp(3), dp(BAR_HEIGHTS_DP[index]));
            if (index > 0) layout.leftMargin = dp(2);
            bar.setLayoutParams(layout);
            group.addView(bar);
            bars.add(bar);
        }
        return group;
    }

    private Bitmap decode(String png) {
        if (png == null || png.isEmpty()) return null;
        try {
            byte[] bytes = Base64.decode(png, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException | OutOfMemoryError error) {
            Log.e(TAG, "Could not decode a dock avatar; falling back to its initial", error);
            return null;
        }
    }

    /** Circle-crop with a coloured ring, baked into one bitmap so no view needs clipping. */
    private Bitmap circle(Bitmap source, int size, int ring) {
        Bitmap output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);
        float radius = size / 2f;

        Matrix matrix = new Matrix();
        float scale = Math.max((float) size / source.getWidth(), (float) size / source.getHeight());
        matrix.setScale(scale, scale);
        matrix.postTranslate(
            (size - source.getWidth() * scale) / 2f,
            (size - source.getHeight() * scale) / 2f
        );
        BitmapShader shader = new BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        shader.setLocalMatrix(matrix);

        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setShader(shader);
        canvas.drawCircle(radius, radius, radius, fill);

        Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
        border.setStyle(Paint.Style.STROKE);
        border.setStrokeWidth(dp(2));
        border.setColor(ring);
        canvas.drawCircle(radius, radius, radius - dp(2) / 2f, border);
        return output;
    }

    private WindowManager.LayoutParams buildLayoutParams() {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;

        WindowManager.LayoutParams layout = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            // Not focusable so the app underneath keeps every keystroke and tap
            // that is not aimed at the dock itself.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        );
        layout.gravity = Gravity.TOP | Gravity.START;
        layout.x = lastX == Integer.MIN_VALUE ? dp(16) : lastX;
        layout.y = lastY == Integer.MIN_VALUE ? dp(160) : lastY;
        return layout;
    }

    private void attachDrag(View view, WindowManager.LayoutParams layout) {
        int slop = ViewConfiguration.get(context).getScaledTouchSlop();

        view.setOnTouchListener(new View.OnTouchListener() {
            private int startX;
            private int startY;
            private float touchX;
            private float touchY;
            private boolean dragged;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = layout.x;
                        startY = layout.y;
                        touchX = event.getRawX();
                        touchY = event.getRawY();
                        dragged = false;
                        return true;

                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) (event.getRawX() - touchX);
                        int dy = (int) (event.getRawY() - touchY);
                        if (!dragged && Math.abs(dx) < slop && Math.abs(dy) < slop) return true;
                        dragged = true;
                        layout.x = startX + dx;
                        layout.y = startY + dy;
                        try {
                            windowManager.updateViewLayout(view, layout);
                        } catch (RuntimeException ignored) {
                            // The window can go while a finger is still down.
                        }
                        return true;
                    }

                    case MotionEvent.ACTION_UP:
                        if (dragged) {
                            lastX = layout.x;
                            lastY = layout.y;
                        } else {
                            v.performClick();
                            openBytelight();
                        }
                        return true;

                    default:
                        return false;
                }
            }
        });
    }

    private void openBytelight() {
        try {
            Intent open = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(open);
        } catch (RuntimeException error) {
            Log.e(TAG, "Could not open Bytelight from the overlay dock", error);
        }
    }

    private static int parseColour(String value, String fallback) {
        if (value != null && !value.trim().isEmpty()) {
            try {
                return Color.parseColor(value.trim());
            } catch (IllegalArgumentException ignored) {
                // A theme colour we cannot parse is not worth losing a face over.
            }
        }
        return Color.parseColor(fallback);
    }

    private static int blend(int colour, int onto, float amount) {
        return Color.rgb(
            Math.round(Color.red(colour) * amount + Color.red(onto) * (1 - amount)),
            Math.round(Color.green(colour) * amount + Color.green(onto) * (1 - amount)),
            Math.round(Color.blue(colour) * amount + Color.blue(onto) * (1 - amount))
        );
    }

    /** The house's own colours, so a glance at the dock says who has the floor. */
    private static int colourForPhase(String phase) {
        if (phase == null) return Color.parseColor("#e85d04");
        switch (phase) {
            case "listening":
            case "hearing":
                return Color.parseColor("#e85d04");
            case "transcribing":
                return Color.parseColor("#3d6ea8");
            case "thinking":
            case "synthesizing":
                return Color.parseColor("#7c3aed");
            case "speaking":
                return Color.parseColor("#ffa23a");
            case "error":
                return Color.parseColor("#8a3b3b");
            default:
                return Color.parseColor("#e85d04");
        }
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
