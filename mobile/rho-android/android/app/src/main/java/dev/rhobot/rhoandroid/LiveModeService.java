package dev.rhobot.rhoandroid;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.core.app.NotificationCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/**
 * LiveModeService — Android Foreground Service for active-stream background continuity.
 *
 * Live Mode replaces WebView timer-based keepalive with a proper OS-visible service
 * so the system does not throttle or kill the rho background context during lock.
 *
 * In addition to the foreground notification, this service sends a server-side
 * lease heartbeat so RPC orphan handling does not abort active sessions while
 * the phone is locked.
 */
public class LiveModeService extends Service {

    private static final String TAG = "LiveModeService";

    public static final String ACTION_STOP = "dev.rhobot.rhoandroid.LIVE_MODE_STOP";
    public static final String ACTION_STATE_CHANGED = "dev.rhobot.rhoandroid.LIVE_MODE_STATE";
    public static final String EXTRA_STATE = "state";

    private static final String LEASE_UPDATE_PATH = "/api/mobile/live-mode/lease";
    private static final String LEASE_CLEAR_PATH = "/api/mobile/live-mode/lease/clear";

    private static final long HEARTBEAT_INTERVAL_MS = 20_000L;
    private static final int CONNECT_TIMEOUT_MS = 8_000;
    private static final int READ_TIMEOUT_MS = 8_000;

    static final int NOTIFICATION_ID = 1001;

    private HandlerThread heartbeatThread;
    private Handler heartbeatHandler;
    private boolean heartbeatRunning = false;

    private final Runnable heartbeatRunnable = new Runnable() {
        @Override
        public void run() {
            if (!heartbeatRunning || heartbeatHandler == null) {
                return;
            }
            sendLeaseHeartbeat();
            heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        RhoNotificationChannel.createChannels(this);
        startHeartbeatThread();
        Log.d(TAG, "LiveModeService created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            Log.d(TAG, "Stop action received — stopping foreground service");
            clearLeaseOnServerAsync();
            LiveModeContextStore.clear(this);
            broadcastState("idle");
            stopHeartbeatLoop();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, buildNotification());
        broadcastState("live");
        startHeartbeatLoop();
        Log.d(TAG, "LiveModeService started in foreground");

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopHeartbeatLoop();
        stopHeartbeatThread();
        broadcastState("idle");
        Log.d(TAG, "LiveModeService destroyed");
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // -------------------------------------------------------------------------
    // Heartbeat loop
    // -------------------------------------------------------------------------

    private void startHeartbeatThread() {
        if (heartbeatThread != null) {
            return;
        }
        heartbeatThread = new HandlerThread("rho-live-mode-heartbeat");
        heartbeatThread.start();
        heartbeatHandler = new Handler(heartbeatThread.getLooper());
    }

    private void stopHeartbeatThread() {
        if (heartbeatThread == null) {
            return;
        }
        heartbeatThread.quitSafely();
        heartbeatThread = null;
        heartbeatHandler = null;
    }

    private void startHeartbeatLoop() {
        if (heartbeatRunning || heartbeatHandler == null) {
            return;
        }
        heartbeatRunning = true;
        heartbeatHandler.post(heartbeatRunnable);
    }

    private void stopHeartbeatLoop() {
        heartbeatRunning = false;
        if (heartbeatHandler != null) {
            heartbeatHandler.removeCallbacks(heartbeatRunnable);
        }
    }

    private void sendLeaseHeartbeat() {
        LiveModeContextStore.Snapshot snapshot = LiveModeContextStore.load(this);
        if (!snapshot.isReady()) {
            return;
        }

        String cookie = CookieManager.getInstance().getCookie(snapshot.baseUrl);
        if (cookie == null || cookie.trim().isEmpty()) {
            Log.d(TAG, "Skipping lease heartbeat: session cookie missing");
            return;
        }

        try {
            JSONObject payload = new JSONObject();
            payload.put("rpcSessionId", snapshot.rpcSessionId);
            payload.put("ttlMs", snapshot.ttlMs);

            int status = postJson(snapshot.baseUrl + LEASE_UPDATE_PATH, payload, cookie);
            if (status == 401 || status == 403) {
                Log.w(TAG, "Lease heartbeat unauthorized (" + status + ") — stopping Live Mode");
                LiveModeContextStore.clear(this);
                stopSelfFailClosed();
                return;
            }
            if (status >= 400) {
                Log.w(TAG, "Lease heartbeat failed with status=" + status);
            }
        } catch (Exception e) {
            Log.w(TAG, "Lease heartbeat error", e);
        }
    }

    private void clearLeaseOnServerAsync() {
        LiveModeContextStore.Snapshot snapshot = LiveModeContextStore.load(this);
        if (!snapshot.isReady()) {
            return;
        }

        Runnable clearTask = () -> clearLeaseOnServer(snapshot);
        if (heartbeatHandler != null) {
            heartbeatHandler.post(clearTask);
            return;
        }

        Thread thread = new Thread(clearTask, "rho-live-clear-lease");
        thread.start();
    }

    private void clearLeaseOnServer(LiveModeContextStore.Snapshot snapshot) {
        String cookie = CookieManager.getInstance().getCookie(snapshot.baseUrl);
        if (cookie == null || cookie.trim().isEmpty()) {
            return;
        }

        try {
            JSONObject payload = new JSONObject();
            payload.put("rpcSessionId", snapshot.rpcSessionId);
            postJson(snapshot.baseUrl + LEASE_CLEAR_PATH, payload, cookie);
        } catch (Exception e) {
            Log.d(TAG, "Failed clearing lease on stop", e);
        }
    }

    private int postJson(String url, JSONObject payload, String cookie) throws Exception {
        HttpURLConnection connection = null;
        try {
            URL parsed = new URL(url);
            connection = (HttpURLConnection) parsed.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Cookie", cookie);

            byte[] bytes = payload.toString().getBytes();
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }

            return connection.getResponseCode();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void stopSelfFailClosed() {
        Handler main = new Handler(getMainLooper());
        main.post(() -> {
            broadcastState("idle");
            stopHeartbeatLoop();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        });
    }

    // -------------------------------------------------------------------------
    // Notification
    // -------------------------------------------------------------------------

    private Notification buildNotification() {
        Intent stopIntent = new Intent(this, LiveModeService.class);
        stopIntent.setAction(ACTION_STOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent stopPi = PendingIntent.getService(this, 0, stopIntent, piFlags);

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent launchPi = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        return new NotificationCompat.Builder(this, RhoNotificationChannel.LIVE_MODE_CHANNEL_ID)
                .setContentTitle("Rho — Live Mode")
                .setContentText("Active stream is running in background")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(launchPi)
                .addAction(android.R.drawable.ic_media_pause, "Stop", stopPi)
                .setOngoing(true)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    // -------------------------------------------------------------------------
    // State broadcast (received by LiveModePlugin)
    // -------------------------------------------------------------------------

    private void broadcastState(String state) {
        Intent intent = new Intent(ACTION_STATE_CHANGED);
        intent.setPackage(getPackageName());
        intent.putExtra(EXTRA_STATE, state);
        sendBroadcast(intent);
    }
}
