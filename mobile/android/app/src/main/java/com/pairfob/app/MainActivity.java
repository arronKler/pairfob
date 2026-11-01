package com.pairfob.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private NotifyBridge notifyBridge;
    private final ActivityResultLauncher<String> notificationPermission =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (notifyBridge != null) notifyBridge.onPermissionResult(granted);
        });

    @Override
    protected void load() {
        // Install before Capacitor navigates, so the first document has the bridges.
        WebView view = findViewById(com.getcapacitor.android.R.id.webview);
        if (view != null) {
            if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                // Debug builds only: lets a developer attach to the page that the
                // notification bridge is talking to.
                WebView.setWebContentsDebuggingEnabled(true);
            }
            new UpdateBridge(this, view).install();
            notifyBridge = new NotifyBridge(this, view, notificationPermission);
            notifyBridge.install();
            deliverLaunchTap();
        }
        super.load();
    }

    /** A tap that cold-starts the app never reaches onNewIntent. */
    private void deliverLaunchTap() {
        Intent intent = getIntent();
        String url = intent == null ? null : intent.getStringExtra(NotifyBridge.EXTRA_URL);
        if (url == null) return;
        intent.removeExtra(NotifyBridge.EXTRA_URL);
        notifyBridge.onTap(url);
    }

    @Override
    public void onNewIntent(Intent intent) {
        String url = intent == null ? null : intent.getStringExtra(NotifyBridge.EXTRA_URL);
        if (url != null) {
            // A recreated activity reuses the launch intent; deliver each tap once.
            intent.removeExtra(NotifyBridge.EXTRA_URL);
            if (notifyBridge != null) notifyBridge.onTap(url);
        }
        super.onNewIntent(intent);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBars();
        // The splash hand-off can reapply the light-bar style after onCreate.
        getWindow().getDecorView().postDelayed(this::applySystemBars, 1500);

        OnBackPressedCallback backNavigation = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView view = getBridge() == null ? null : getBridge().getWebView();
                if (view != null && view.canGoBack()) {
                    view.goBack();
                    return;
                }
                // Let the system finish the activity when there is no in-app history.
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, backNavigation);
    }

    @Override
    public void onResume() {
        super.onResume();
        applySystemBars();
        // The visible page runs its own connection, so the sync job stands aside.
        NotifySyncJobService.setAppVisible(true);
    }

    @Override
    public void onPause() {
        NotifySyncJobService.setAppVisible(false);
        // An update or a system cleanup can drop the persisted job; re-arm it.
        if (NotifyBridge.backgroundSyncOn(this)) NotifySyncJobService.schedule(this);
        super.onPause();
    }

    private void applySystemBars() {
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);
        getWindow().getDecorView().setSystemUiVisibility(
            getWindow().getDecorView().getSystemUiVisibility() & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        getWindow().setStatusBarColor(0xFF0A0C10);
        getWindow().setNavigationBarColor(0xFF0A0C10);
    }
}
