package com.pairfob.app;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import org.json.JSONObject;

/**
 * The WebView origin Capacitor serves the app from. It decides the IndexedDB
 * origin, so the offscreen page has to load exactly this one to see the same
 * credentials, and a dev build over http must not be treated as release https.
 */
final class AppOrigin {
    private static final String CONFIG = "capacitor.config.json";

    private AppOrigin() {}

    static String of(Context context) {
        String scheme = "https";
        try (InputStream raw = context.getAssets().open(CONFIG)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = raw.read(chunk)) > 0) buffer.write(chunk, 0, read);
            JSONObject server = new JSONObject(buffer.toString("UTF-8")).optJSONObject("server");
            if (server != null && "http".equals(server.optString("androidScheme"))) scheme = "http";
        } catch (Exception ignored) {
            // A missing or unreadable config leaves the release origin, which is
            // the forward default rather than a silent downgrade to http.
        }
        return scheme + "://localhost";
    }
}
