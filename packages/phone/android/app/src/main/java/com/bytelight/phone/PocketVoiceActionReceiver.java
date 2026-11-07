package com.bytelight.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Notification/Bubble actions that must work even while the WebView is asleep. */
public class PocketVoiceActionReceiver extends BroadcastReceiver {
    public static final String ACTION_END = "com.bytelight.phone.action.END_POCKET_VOICE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_END.equals(intent.getAction())) return;
        PocketVoiceService.stop(context);
        MainActivity.setPocketVoiceActive(false);
        PocketVoicePlugin.publishState(false);
    }
}
