package dev.rhobot.rhoandroid;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

/**
 * Persists Live Mode lease context so the foreground service can continue
 * heartbeat updates without depending on WebView JS timers.
 */
public final class LiveModeContextStore {

    private static final String PREFS = "rho_live_mode";
    private static final String KEY_BASE_URL = "lease_base_url";
    private static final String KEY_RPC_SESSION_ID = "lease_rpc_session_id";
    private static final String KEY_TTL_MS = "lease_ttl_ms";

    public static final long DEFAULT_TTL_MS = 3 * 60_000L;
    public static final long MIN_TTL_MS = 30_000L;
    public static final long MAX_TTL_MS = 30 * 60_000L;

    private LiveModeContextStore() {}

    public static final class Snapshot {
        public final String baseUrl;
        public final String rpcSessionId;
        public final long ttlMs;

        Snapshot(String baseUrl, String rpcSessionId, long ttlMs) {
            this.baseUrl = baseUrl;
            this.rpcSessionId = rpcSessionId;
            this.ttlMs = ttlMs;
        }

        public boolean isReady() {
            return !baseUrl.isEmpty() && !rpcSessionId.isEmpty();
        }
    }

    public static void save(Context context, String rawBaseUrl, String rawRpcSessionId, long rawTtlMs) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String baseUrl = normalizeBaseUrl(rawBaseUrl);
        String rpcSessionId = normalizeRpcSessionId(rawRpcSessionId);
        long ttlMs = normalizeTtlMs(rawTtlMs);

        prefs.edit()
                .putString(KEY_BASE_URL, baseUrl)
                .putString(KEY_RPC_SESSION_ID, rpcSessionId)
                .putLong(KEY_TTL_MS, ttlMs)
                .apply();
    }

    public static Snapshot load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String baseUrl = normalizeBaseUrl(prefs.getString(KEY_BASE_URL, ""));
        String rpcSessionId = normalizeRpcSessionId(prefs.getString(KEY_RPC_SESSION_ID, ""));
        long ttlMs = normalizeTtlMs(prefs.getLong(KEY_TTL_MS, DEFAULT_TTL_MS));
        return new Snapshot(baseUrl, rpcSessionId, ttlMs);
    }

    public static void clear(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
                .remove(KEY_BASE_URL)
                .remove(KEY_RPC_SESSION_ID)
                .remove(KEY_TTL_MS)
                .apply();
    }

    private static String normalizeRpcSessionId(String raw) {
        if (raw == null) return "";
        String value = raw.trim();
        if (value.isEmpty()) return "";
        if (value.length() > 128) {
            value = value.substring(0, 128);
        }
        return value;
    }

    private static long normalizeTtlMs(long raw) {
        if (raw <= 0) return DEFAULT_TTL_MS;
        return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, raw));
    }

    private static String normalizeBaseUrl(String raw) {
        if (raw == null) return "";

        String value = raw.trim();
        if (value.isEmpty()) return "";

        Uri uri;
        try {
            uri = Uri.parse(value);
        } catch (Exception ignored) {
            return "";
        }

        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) {
            return "";
        }

        String normalizedScheme = scheme.toLowerCase();
        if (!"http".equals(normalizedScheme) && !"https".equals(normalizedScheme)) {
            return "";
        }

        String normalizedHost = host.toLowerCase();
        int port = uri.getPort();
        if (port > 0) {
            return normalizedScheme + "://" + normalizedHost + ":" + port;
        }
        return normalizedScheme + "://" + normalizedHost;
    }
}
