package com.bytelight.phone;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;

/**
 * The expanded half of Android's Bubble call dock. The collapsed Bubble is
 * intentionally the always-available outside-Bytelight handle; this screen is a
 * compact status and control card, not a second WebView trying to own the mic.
 */
public class PocketVoiceBubbleActivity extends Activity {
    private TextView detailView;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!MainActivity.isPocketVoiceActive()) {
            finish();
            return;
        }

        int pad = dp(18);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.rgb(22, 13, 11));

        ImageView crest = new ImageView(this);
        crest.setImageResource(R.mipmap.ic_launcher_round);
        root.addView(crest, new LinearLayout.LayoutParams(dp(48), dp(48)));

        TextView title = new TextView(this);
        title.setText(PocketVoiceService.who);
        title.setTextColor(Color.WHITE);
        title.setTextSize(19);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        titleParams.topMargin = dp(10);
        root.addView(title, titleParams);

        detailView = new TextView(this);
        detailView.setTextColor(Color.rgb(227, 208, 198));
        detailView.setTextSize(14);
        detailView.setGravity(Gravity.CENTER);
        detailView.setText(resolveDetail(getIntent()));
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        detailParams.topMargin = dp(6);
        root.addView(detailView, detailParams);

        Button returnToBytelight = button("Return to Bytelight", Color.rgb(232, 93, 4), Color.WHITE);
        returnToBytelight.setOnClickListener(view -> {
            Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(open);
        });
        LinearLayout.LayoutParams returnParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(46)
        );
        returnParams.topMargin = dp(16);
        root.addView(returnToBytelight, returnParams);

        Button end = button("End call", Color.rgb(69, 35, 28), Color.rgb(255, 219, 210));
        end.setOnClickListener(view -> {
            PocketVoiceService.stop(this);
            MainActivity.setPocketVoiceActive(false);
            PocketVoicePlugin.publishState(false);
            finishAndRemoveTask();
        });
        LinearLayout.LayoutParams endParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(42)
        );
        endParams.topMargin = dp(8);
        root.addView(end, endParams);

        setContentView(root);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (detailView != null) detailView.setText(resolveDetail(intent));
    }

    private Button button(String label, int color, int textColor) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextColor(textColor);
        button.setTextSize(14);
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(22));
        button.setBackground(background);
        return button;
    }

    private String resolveDetail(Intent intent) {
        String detail = intent != null ? intent.getStringExtra(PocketVoiceService.EXTRA_DETAIL) : null;
        return detail == null || detail.trim().isEmpty() ? "Voice call active" : detail;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
