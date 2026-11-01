package com.pairfob.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/** Agent notifications belong only to the bundled app's main frame. */
final class NotifyBridge {
    static final String EXTRA_URL = "pairfob.notify.url";
    static final String CHANNEL_CONNECTION = "pairfob-connection";

    static final String CHANNEL_AGENTS = "pairfob-agents";
    private static final String LOG_TAG = "PairfobNotify";
    private static final String PREFS = "pairfob.notify";
    private static final String PREF_ASKED = "asked";
    private static final int NOTIFICATION_ID = 0;
    private static final long PERMISSION_TIMEOUT_MS = 60_000;

    private final Activity activity;
    private final WebView view;
    private final ActivityResultLauncher<String> permissionLauncher;
    private final boolean debug;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private JavaScriptReplyProxy proxy;
    private String pendingTap;
    private PendingPermission pendingPermission;

    NotifyBridge(Activity activity, WebView view, ActivityResultLauncher<String> permissionLauncher) {
        this.activity = activity;
        this.view = view;
        this.permissionLauncher = permissionLauncher;
        debug = (activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    void install() {
        // Fail closed on old WebViews; never fall back to an all-frame interface.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        Set<String> origins = new HashSet<>();
        origins.add("https://localhost");
        if (debug) origins.add("http://localhost");
        WebViewCompat.addWebMessageListener(view, "PairfobNotify", origins,
            (webView, message, sourceOrigin, isMainFrame, reply) -> {
                if (!isMainFrame || !origins.contains(sourceOrigin.toString())) return;
                handle(message, reply);
            });
    }

    private void handle(WebMessageCompat message, JavaScriptReplyProxy reply) {
        String id = "";
        try {
            String data = message.getData();
            if (data == null || data.length() > 4096) return;
            JSONObject request = new JSONObject(data);
            id = request.getString("id");
            if (!id.matches("[0-9]{1,16}")) return;
            switch (request.getString("method")) {
                case "status":
                    status(reply, id);
                    break;
                case "requestPermission":
                    requestPermission(reply, id);
                    break;
                case "post":
                    ensureChannels(activity);
                    if (!canPost()) {
                        android.util.Log.w(LOG_TAG, "Notification rejected: not granted");
                        respond(reply, id, false, "notifications are disabled");
                        return;
                    }
                    post(request, reply, id);
                    break;
                case "cancel":
                    cancel(request, reply, id);
                    break;
                case "cancelAll":
                    NotificationManagerCompat.from(activity).cancelAll();
                    if (KeepAliveService.isRunning()) KeepAliveService.refreshNotification(activity);
                    respond(reply, id, true, new JSONObject());
                    break;
                case "setKeepAlive":
                    setKeepAlive(request, reply, id);
                    break;
                case "ready":
                    ready(reply, id);
                    break;
                default:
                    android.util.Log.w(LOG_TAG, "Request rejected: unknown method");
                    respond(reply, id, false, "unknown method");
                    break;
            }
        } catch (Exception error) {
            android.util.Log.w(LOG_TAG, "Request rejected: " + error.getClass().getSimpleName());
            respond(reply, id, false, "notification request failed");
        }
    }

    private void status(JavaScriptReplyProxy reply, String id) throws Exception {
        ensureChannels(activity);
        respond(reply, id, true, new JSONObject()
            .put("permission", permissionState())
            .put("keepAlive", KeepAliveService.isRunning()));
    }

    private void requestPermission(JavaScriptReplyProxy reply, String id) {
        if (Build.VERSION.SDK_INT < 33) {
            // Only the system settings screen can change this; never claim a prompt.
            respond(reply, id, true, permissionValue(permissionState()));
            return;
        }
        String state = permissionState();
        if ("granted".equals(state) || pendingPermission != null) {
            respond(reply, id, true, permissionValue(state));
            return;
        }
        if (permissionLauncher == null) {
            respond(reply, id, false, "permission prompt unavailable");
            return;
        }
        markAsked();
        PendingPermission request = new PendingPermission(reply, id);
        request.timeout = () -> {
            if (pendingPermission != request) return;
            pendingPermission = null;
            // The page must not hang when the dialog is dismissed without an answer.
            respond(request.reply, request.id, true, permissionValue(permissionState()));
        };
        pendingPermission = request;
        handler.postDelayed(request.timeout, PERMISSION_TIMEOUT_MS);
        try {
            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
        } catch (Exception error) {
            pendingPermission = null;
            handler.removeCallbacks(request.timeout);
            android.util.Log.w(LOG_TAG, "Permission prompt rejected: " + error.getClass().getSimpleName());
            respond(reply, id, false, "permission prompt unavailable");
        }
    }

    void onPermissionResult(boolean granted) {
        PendingPermission request = pendingPermission;
        if (request == null) return;
        pendingPermission = null;
        handler.removeCallbacks(request.timeout);
        respond(request.reply, request.id, true,
            permissionValue(granted ? "granted" : permissionState()));
    }

    private void post(JSONObject request, JavaScriptReplyProxy reply, String id) throws Exception {
        String title = text(request, "title", 200);
        String body = text(request, "body", 500);
        String tag = text(request, "tag", 120);
        String url = tapUrl(request.get("url"));
        Intent tap = new Intent(activity, MainActivity.class)
            .setAction("pairfob.notify." + tag)
            .putExtra(EXTRA_URL, url)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // One request code per tag; a shared code would let the newest extras
        // replace every queued tap, since PendingIntents compare without extras.
        PendingIntent content = PendingIntent.getActivity(activity, tag.hashCode(), tap,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(activity, CHANNEL_AGENTS)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(content)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_VIBRATE)
            .setCategory(NotificationCompat.CATEGORY_STATUS);
        NotificationManagerCompat.from(activity).notify(tag, NOTIFICATION_ID, notification.build());
        respond(reply, id, true, new JSONObject().put("posted", true));
    }

    private void cancel(JSONObject request, JavaScriptReplyProxy reply, String id) throws Exception {
        String tag = text(request, "tag", 120);
        NotificationManagerCompat.from(activity).cancel(tag, NOTIFICATION_ID);
        respond(reply, id, true, new JSONObject().put("cancelled", true));
    }

    private void setKeepAlive(JSONObject request, JavaScriptReplyProxy reply, String id) throws Exception {
        boolean on = request.getBoolean("on");
        if (on) {
            try {
                ContextCompat.startForegroundService(activity, new Intent(activity, KeepAliveService.class));
                KeepAliveService.setRunning(true);
            } catch (Exception error) {
                android.util.Log.w(LOG_TAG, "Keep-alive start rejected: " + error.getClass().getSimpleName());
                respond(reply, id, false, "foreground service is not allowed in the background");
                return;
            }
        } else {
            activity.stopService(new Intent(activity, KeepAliveService.class));
            KeepAliveService.setRunning(false);
        }
        respond(reply, id, true, new JSONObject().put("keepAlive", KeepAliveService.isRunning()));
    }

    private void ready(JavaScriptReplyProxy reply, String id) throws Exception {
        proxy = reply;
        JSONObject value = new JSONObject().put("tap", JSONObject.NULL);
        if (pendingTap != null) {
            value.put("tap", new JSONObject().put("url", pendingTap));
            pendingTap = null;
        }
        respond(reply, id, true, value);
    }

    void onTap(String url) {
        if (!isTapUrl(url)) {
            // A dropped tap leaves no other trace.
            if (debug) android.util.Log.w(LOG_TAG, "tap dropped: not a pane link");
            return;
        }
        JavaScriptReplyProxy target = proxy;
        if (debug) android.util.Log.i(LOG_TAG, "tap arrived, page " + (target == null ? "absent" : "ready"));
        if (target == null) {
            pendingTap = url;
            return;
        }
        try {
            target.postMessage(new JSONObject().put("event", "tap").put("url", url).toString());
        } catch (Exception error) {
            android.util.Log.w(LOG_TAG, "Tap delivery failed: " + error.getClass().getSimpleName());
            pendingTap = url;
        }
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel agents = new NotificationChannel(CHANNEL_AGENTS,
            context.getString(R.string.notify_channel_agents), NotificationManager.IMPORTANCE_HIGH);
        agents.enableVibration(true);
        NotificationChannel connection = new NotificationChannel(CHANNEL_CONNECTION,
            context.getString(R.string.notify_channel_connection), NotificationManager.IMPORTANCE_LOW);
        connection.setSound(null, null);
        connection.enableVibration(false);
        manager.createNotificationChannel(agents);
        manager.createNotificationChannel(connection);
    }

    private String permissionState() {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
            return asked() ? "denied" : "prompt";
        }
        // Below API 33, and after a grant, the app-wide switch still wins.
        return NotificationManagerCompat.from(activity).areNotificationsEnabled() ? "granted" : "denied";
    }

    private boolean canPost() {
        return "granted".equals(permissionState());
    }

    private boolean asked() {
        return activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(PREF_ASKED, false);
    }

    private void markAsked() {
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(PREF_ASKED, true).apply();
    }

    private static JSONObject permissionValue(String state) {
        try {
            return new JSONObject().put("permission", state);
        } catch (org.json.JSONException error) {
            throw new IllegalStateException(error);
        }
    }

    private static String text(JSONObject request, String key, int max) throws Exception {
        Object value = request.get(key);
        if (!(value instanceof String)) throw new IllegalArgumentException();
        String text = (String) value;
        if (text.isEmpty() || text.length() > max) throw new IllegalArgumentException();
        return text;
    }

    private static String tapUrl(Object value) {
        if (!(value instanceof String)) throw new IllegalArgumentException();
        String url = (String) value;
        if (!isTapUrl(url)) throw new IllegalArgumentException();
        return url;
    }

    private static boolean isTapUrl(String url) {
        return url != null && url.length() <= 512 && url.startsWith("/pair#");
    }

    private void respond(JavaScriptReplyProxy reply, String id, boolean ok, Object value) {
        try {
            // Reply to the initiating frame, never evaluate code in a later page.
            JSONObject message = new JSONObject().put("id", id).put("ok", ok);
            if (ok) {
                message.put("value", value);
            } else {
                message.put("error", value);
            }
            reply.postMessage(message.toString());
        } catch (Exception ignored) {
            // The initiating document may have gone away.
        }
    }

    private static final class PendingPermission {
        final JavaScriptReplyProxy reply;
        final String id;
        Runnable timeout;

        PendingPermission(JavaScriptReplyProxy reply, String id) {
            this.reply = reply;
            this.id = id;
        }
    }
}
