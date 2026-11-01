package com.pairfob.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;
import androidx.webkit.WebViewAssetLoader;

/**
 * Wakes the app every fifteen minutes and runs the bundled page offscreen so it
 * can reach its paired computer and raise notices while the user is elsewhere.
 *
 * The page is the same document the app shows, at the same origin, so the
 * local-notification producer runs unchanged: a hidden page that is live posts
 * one notice per agent transition through [NotifyBridge].
 */
public final class NotifySyncJobService extends JobService {
    static final int JOB_ID = 9002;

    private static final String LOG_TAG = "PairfobSync";
    static final long PERIOD_MS = 15 * 60_000;
    /** The system stops a job at ten minutes; stop first and report a clean finish. */
    static final long HOLD_MS = 8 * 60_000;
    /**
     * A job can start while the activity is still stopping, and building a
     * WebView there holds the main thread long enough for a background ANR.
     * Let the app settle first, then recheck that it is really gone.
     */
    static final long OPEN_DELAY_MS = 10_000;

    /** The visible activity already runs its own connection and notices. */
    private static volatile boolean appVisible;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView page;
    private JobParameters running;

    static void setAppVisible(boolean visible) {
        appVisible = visible;
    }

    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        // Scheduling a job with the same id replaces it, which would stop a run
        // in progress. The page and the activity both re-assert the choice.
        if (scheduler.getPendingJob(JOB_ID) != null) return;
        Log.i(LOG_TAG, "schedule");
        JobInfo job = new JobInfo.Builder(
                JOB_ID, new ComponentName(context, NotifySyncJobService.class))
            .setPeriodic(PERIOD_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build();
        scheduler.schedule(job);
    }

    static void cancel(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler != null) scheduler.cancel(JOB_ID);
        Log.i(LOG_TAG, "cancel");
    }

    static boolean isScheduled(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        return scheduler != null && scheduler.getPendingJob(JOB_ID) != null;
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        if (appVisible || !NotifyBridge.backgroundSyncOn(this)) {
            Log.i(LOG_TAG, "skip: " + (appVisible ? "app is visible" : "notifications are off"));
            return false;
        }
        running = params;
        Log.i(LOG_TAG, "start");
        handler.postDelayed(this::open, OPEN_DELAY_MS);
        handler.postDelayed(this::stop, HOLD_MS);
        return true;
    }

    private void open() {
        if (running == null) return;
        if (appVisible || !NotifyBridge.backgroundSyncOn(this)) {
            Log.i(LOG_TAG, "skip at open");
            stop();
            return;
        }
        page = new WebView(getApplicationContext());
        WebView.setWebContentsDebuggingEnabled(debuggable());
        page.getSettings().setJavaScriptEnabled(true);
        page.getSettings().setDomStorageEnabled(true);
        page.setWebViewClient(new WebViewClient(getApplicationContext()));
        new NotifyBridge(this, page).install();
        page.loadUrl(AppOrigin.of(this) + "/");
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Log.i(LOG_TAG, "stop, reschedule");
        stop();
        return true;
    }

    private void stop() {
        handler.removeCallbacksAndMessages(null);
        close();
        JobParameters params = running;
        running = null;
        if (params != null) jobFinished(params, false);
    }

    private void close() {
        if (page == null) return;
        page.destroy();
        page = null;
    }

    private boolean debuggable() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /**
     * A WebView no window shows still reports itself visible, and the producer
     * in the page posts only from a page that reports hidden. This page is
     * hidden in every sense that matters, so it says so.
     */
    private static final String REPORT_HIDDEN =
        "Object.defineProperty(Document.prototype,'visibilityState',"
            + "{configurable:true,get:function(){return 'hidden'}});"
            + "Object.defineProperty(Document.prototype,'hidden',"
            + "{configurable:true,get:function(){return true}});";

    /** The bundled page loads through the asset loader at the app's own origin. */
    private static final class WebViewClient extends android.webkit.WebViewClient {
        private final WebViewAssetLoader loader;

        WebViewClient(Context context) {
            loader = new WebViewAssetLoader.Builder()
                .setDomain("localhost")
                // The loader refuses http unless asked; a release build is https.
                .setHttpAllowed(AppOrigin.of(context).startsWith("http://"))
                .addPathHandler("/", new BundledAssets(context))
                .build();
        }

        @Override
        public android.webkit.WebResourceResponse shouldInterceptRequest(
                WebView view, android.webkit.WebResourceRequest request) {
            return loader.shouldInterceptRequest(request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
            view.evaluateJavascript(REPORT_HIDDEN, null);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            // Earlier documents replace the getters; a late load can start clean.
            view.evaluateJavascript(REPORT_HIDDEN, null);
        }
    }
}
