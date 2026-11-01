package com.pairfob.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.webkit.WebResourceResponse;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves the bundled PWA to the offscreen page at the origin the app uses, so
 * the synced page reads the same IndexedDB credentials as the visible one.
 */
final class BundledAssets implements WebViewAssetLoader.PathHandler {
    private static final String ROOT = "public";
    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("js", "application/javascript");
        TYPES.put("mjs", "application/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("html", "text/html");
        TYPES.put("json", "application/json");
        TYPES.put("webmanifest", "application/manifest+json");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("woff", "font/woff");
        TYPES.put("txt", "text/plain");
        TYPES.put("wasm", "application/wasm");
    }

    private final AssetManager assets;

    BundledAssets(Context context) {
        assets = context.getAssets();
    }

    @Override
    public WebResourceResponse handle(String path) {
        String relative = path.startsWith("/") ? path.substring(1) : path;
        if (relative.isEmpty()) relative = "index.html";
        // The app is a single document with hash routes, so a missing file is a
        // missing asset, not a route to hand back to index.html.
        String name = ROOT + "/" + relative;
        String type = TYPES.get(extension(relative));
        if (type == null) return null;
        try {
            InputStream body = assets.open(name);
            return new WebResourceResponse(type, "utf-8", 200, "OK",
                header("Cache-Control", "no-store"), body);
        } catch (IOException missing) {
            return notFound();
        }
    }

    private static Map<String, String> header(String name, String value) {
        Map<String, String> headers = new HashMap<>();
        headers.put(name, value);
        return headers;
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
            header("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }

    private static String extension(String path) {
        int dot = path.lastIndexOf('.');
        int slash = path.lastIndexOf('/');
        if (dot < 0 || dot < slash) return "";
        return path.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
    }
}
