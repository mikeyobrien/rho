package dev.rhobot.rhoandroid;

import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "RhoAndroid";
    private static final String PICKER_URL = "http://localhost/?picker=1";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom native plugins before super.onCreate so Capacitor
        // discovers them during bridge initialization.
        registerPlugin(LiveModePlugin.class);

        super.onCreate(savedInstanceState);

        // Create notification channels early so they are ready before any
        // foreground service notification is shown.
        RhoNotificationChannel.createChannels(this);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        if (this.bridge != null && this.bridge.getWebView() != null) {
            cookieManager.setAcceptThirdPartyCookies(this.bridge.getWebView(), true);
        }

        getOnBackPressedDispatcher().addCallback(
                this,
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        if (handleBackToPicker()) {
                            return;
                        }

                        // Fall through to default behavior.
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                        setEnabled(true);
                    }
                }
        );
    }

    // -------------------------------------------------------------------------
    // Back navigation
    // -------------------------------------------------------------------------

    private boolean handleBackToPicker() {
        if (this.bridge == null || this.bridge.getWebView() == null) {
            return false;
        }

        String currentUrl = this.bridge.getWebView().getUrl();
        Log.d(TAG, "back currentUrl=" + currentUrl);

        if (isRemoteHostUrl(currentUrl)) {
            // Return to local picker mode instead of leaving app.
            openPicker();
            return true;
        }

        return false;
    }

    private void openPicker() {
        if (this.bridge == null || this.bridge.getWebView() == null) {
            return;
        }
        this.bridge.getWebView().loadUrl(PICKER_URL);
    }

    private boolean isRemoteHostUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.isEmpty()) {
            return false;
        }

        Uri uri = Uri.parse(rawUrl);
        String host = uri.getHost();
        if (host == null) {
            return false;
        }

        String normalized = host.toLowerCase();
        return !normalized.equals("localhost") && !normalized.equals("127.0.0.1");
    }
}
