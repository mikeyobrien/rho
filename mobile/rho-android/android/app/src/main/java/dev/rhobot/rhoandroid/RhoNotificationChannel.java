package dev.rhobot.rhoandroid;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * Registers notification channels required by rho-android.
 * Call createChannels() once on app startup (MainActivity.onCreate or Application.onCreate).
 */
public class RhoNotificationChannel {

    /** Channel ID for Live Mode foreground service notifications. */
    public static final String LIVE_MODE_CHANNEL_ID = "rho_live_mode";

    /**
     * Create all required notification channels.
     * Safe to call multiple times; Android ignores duplicates after first creation.
     */
    public static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager nm =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        // Live Mode channel — LOW importance keeps foreground notification unobtrusive
        NotificationChannel liveChannel = new NotificationChannel(
                LIVE_MODE_CHANNEL_ID,
                "Rho Live Mode",
                NotificationManager.IMPORTANCE_LOW
        );
        liveChannel.setDescription(
                "Shown while Rho is keeping your active stream alive in the background."
        );
        liveChannel.setShowBadge(false);
        nm.createNotificationChannel(liveChannel);

    }
}
