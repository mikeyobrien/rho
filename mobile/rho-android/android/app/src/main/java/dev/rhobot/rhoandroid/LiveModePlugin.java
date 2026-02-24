package dev.rhobot.rhoandroid;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.util.Log;
import android.Manifest;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;

/**
 * LiveModePlugin — Capacitor bridge for the native Live Mode foreground service.
 *
 * Registered by name "LiveMode" in MainActivity via registerPlugin().
 * The TypeScript side uses registerPlugin<LiveModePlugin>('LiveMode') from @capacitor/core.
 *
 * Methods (called from TS/JS):
 *  - startLiveMode()        → starts LiveModeService, returns { state }
 *  - stopLiveMode()         → stops LiveModeService, returns { state }
 *  - getLiveModeStatus()    → returns current { state }
 *  - setLiveContext()       → persists lease context (baseUrl + rpcSessionId + ttlMs)
 *  - clearLiveContext()     → clears persisted lease context
 *
 * Events emitted to TS:
 *  - liveModeStatusChanged  → { state: LiveModeState, reason?: string }
 */
@CapacitorPlugin(
    name = "LiveMode",
    permissions = {
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class LiveModePlugin extends Plugin {

    private static final String TAG = "LiveModePlugin";

    private static final String KEY_BASE_URL = "baseUrl";
    private static final String KEY_RPC_SESSION_ID = "rpcSessionId";
    private static final String KEY_TTL_MS = "ttlMs";

    /** Mirrors LiveModeState in TypeScript. */
    private String currentState = "idle";

    private BroadcastReceiver stateReceiver;

    @Override
    public void load() {
        registerStateReceiver();
    }

    @Override
    protected void handleOnDestroy() {
        unregisterStateReceiver();
    }

    // -------------------------------------------------------------------------
    // Plugin methods
    // -------------------------------------------------------------------------

    @PluginMethod
    public void startLiveMode(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getPermissionState("notifications") != PermissionState.GRANTED) {
                requestPermissionForAlias("notifications", call, "notificationsPermsCallback");
                return;
            }
        }
        doStartLiveMode(call);
    }

    @PermissionCallback
    private void notificationsPermsCallback(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            doStartLiveMode(call);
        } else {
            currentState = "idle";
            call.reject("Permission denied: POST_NOTIFICATIONS is required for Live Mode");
        }
    }

    private void doStartLiveMode(PluginCall call) {
        currentState = "starting";
        try {
            Intent intent = new Intent(getContext(), LiveModeService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            Log.d(TAG, "startLiveMode: service start requested");

            JSObject result = new JSObject();
            result.put("state", "starting");
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "startLiveMode failed", e);
            currentState = "idle";
            call.reject("Failed to start Live Mode: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopLiveMode(PluginCall call) {
        currentState = "stopping";
        try {
            Intent stopIntent = new Intent(getContext(), LiveModeService.class);
            stopIntent.setAction(LiveModeService.ACTION_STOP);
            // Use startService for stop intents. Starting a foreground service only
            // to immediately stop can trigger API-26+ foreground start requirements.
            getContext().startService(stopIntent);

            Log.d(TAG, "stopLiveMode: stop intent sent");
            JSObject result = new JSObject();
            result.put("state", "stopping");
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "stopLiveMode failed", e);
            currentState = "idle";
            call.reject("Failed to stop Live Mode: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getLiveModeStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("state", currentState);
        call.resolve(result);
    }

    @PluginMethod
    public void setLiveContext(PluginCall call) {
        String baseUrl = call.getString(KEY_BASE_URL, "");
        String rpcSessionId = call.getString(KEY_RPC_SESSION_ID, "");
        Long ttlMs = call.getLong(KEY_TTL_MS, LiveModeContextStore.DEFAULT_TTL_MS);

        if (baseUrl == null || baseUrl.trim().isEmpty()) {
            call.reject("baseUrl is required");
            return;
        }
        if (rpcSessionId == null || rpcSessionId.trim().isEmpty()) {
            call.reject("rpcSessionId is required");
            return;
        }

        long ttl = ttlMs != null ? ttlMs : LiveModeContextStore.DEFAULT_TTL_MS;
        LiveModeContextStore.save(getContext(), baseUrl, rpcSessionId, ttl);

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("state", currentState);
        call.resolve(result);
    }

    @PluginMethod
    public void clearLiveContext(PluginCall call) {
        LiveModeContextStore.clear(getContext());
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("state", currentState);
        call.resolve(result);
    }

    // -------------------------------------------------------------------------
    // Broadcast receiver for service state updates
    // -------------------------------------------------------------------------

    private void registerStateReceiver() {
        stateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!LiveModeService.ACTION_STATE_CHANGED.equals(intent.getAction())) return;
                String state = intent.getStringExtra(LiveModeService.EXTRA_STATE);
                if (state == null) return;

                Log.d(TAG, "State broadcast received: " + state);
                currentState = state;

                JSObject event = new JSObject();
                event.put("state", state);
                notifyListeners("liveModeStatusChanged", event);
            }
        };

        IntentFilter filter = new IntentFilter(LiveModeService.ACTION_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(stateReceiver, filter);
        }
    }

    private void unregisterStateReceiver() {
        if (stateReceiver != null) {
            try {
                getContext().unregisterReceiver(stateReceiver);
            } catch (IllegalArgumentException e) {
                // Already unregistered
            }
            stateReceiver = null;
        }
    }
}
