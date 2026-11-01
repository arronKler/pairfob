package com.pairfob.app;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercise the actual notification boundary, including same-origin child frames. */
@RunWith(AndroidJUnit4.class)
public class NotifyBridgeTest {
    private String evaluate(WebView view, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            view.evaluateJavascript(script, value -> { result.set(value); latch.countDown(); }));
        assertTrue("JavaScript evaluation completed", latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    private void waitFor(WebView view, String condition) throws Exception {
        waitFor(view, condition, 30);
    }

    private void waitFor(WebView view, String condition, long seconds) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (System.nanoTime() < deadline) {
            if ("true".equals(evaluate(view, condition))) return;
            Thread.sleep(50);
        }
        fail("WebView condition timed out: " + condition);
    }

    private void grantNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        InstrumentationRegistry.getInstrumentation().getUiAutomation()
            .grantRuntimePermission(context.getPackageName(), Manifest.permission.POST_NOTIFICATIONS);
    }

    @Test
    public void mainFrameOnlyAndValidatedNotifications() throws Exception {
        grantNotifications();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> holder = new AtomicReference<>();
            scenario.onActivity(activity -> {
                WebView view = activity.getBridge().getWebView();
                view.getSettings().setJavaScriptEnabled(true);
                holder.set(view);
                view.loadDataWithBaseURL("https://localhost/", "<html><body>notify test</body></html>",
                    "text/html", "UTF-8", null);
            });
            WebView view = holder.get();

            waitFor(view, "typeof PairfobNotify === 'object'");
            evaluate(view, "window.replies={};PairfobNotify.onmessage=e=>{const r=JSON.parse(e.data);replies[r.id]=r};"
                + "PairfobNotify.postMessage(JSON.stringify({id:'1',method:'status'}))");
            waitFor(view, "!!window.replies?.['1']");
            assertEquals("true", evaluate(view, "replies['1'].ok"
                + " && ['granted','denied','prompt'].includes(replies['1'].value.permission)"
                + " && typeof replies['1'].value.backgroundSync === 'boolean'"));

            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'2',method:'post',"
                + "title:'Agent needs you',body:'A pane is waiting',tag:'pane-1',url:'/settings#notify=1'}))");
            waitFor(view, "!!replies['2']");
            assertEquals("true", evaluate(view, "!replies['2'].ok && typeof replies['2'].error === 'string'"));

            String tapUrl = "/pair#notify=1&d=d_test&pane=p_test";
            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'3',method:'post',"
                + "title:'Agent needs you',body:'A pane is waiting',tag:'pane-1',url:'" + tapUrl + "'}))");
            waitFor(view, "!!replies['3']");
            assertEquals("true", evaluate(view, "replies['3'].ok && replies['3'].value.posted === true"));

            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'4',method:'ready'}))");
            waitFor(view, "!!replies['4']");
            assertEquals("true", evaluate(view, "replies['4'].ok && replies['4'].value.tap === null"));

            evaluate(view, "window.taps=[];PairfobNotify.onmessage=e=>{const m=JSON.parse(e.data);"
                + "if(m.event==='tap'){taps.push(m.url);}else{replies[m.id]=m;}};"
                + "window.childTap=false;window.childReady=false;"
                + "const f=document.createElement('iframe');"
                + "f.srcdoc='<script>PairfobNotify.onmessage=()=>parent.childTap=true;"
                + "PairfobNotify.postMessage(JSON.stringify({id:\"5\",method:\"ready\"}));"
                + "parent.childReady=true;<\\/script>';"
                + "document.body.appendChild(f)");
            waitFor(view, "window.childReady === true");
            // Round-trip the main frame after the child request to drain native work.
            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'6',method:'status'}))");
            waitFor(view, "!!replies['6']");
            assertEquals("false", evaluate(view, "!!replies['5']"));

            Intent notice = new Intent(Intent.ACTION_VIEW).putExtra(NotifyBridge.EXTRA_URL, tapUrl);
            scenario.onActivity(activity -> activity.onNewIntent(notice));
            waitFor(view, "window.taps.length === 1");
            assertEquals("true", evaluate(view, "taps[0] === '" + tapUrl + "'"));
            assertEquals("false", evaluate(view, "window.childTap"));

            scenario.onActivity(activity -> activity.onNewIntent(notice));
            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'7',method:'status'}))");
            waitFor(view, "!!replies['7']");
            assertEquals("true", evaluate(view, "taps.length === 1"));

            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'8',method:'cancel',tag:'pane-1'}))");
            waitFor(view, "!!replies['8']");
            assertEquals("true", evaluate(view, "replies['8'].ok && replies['8'].value.cancelled === true"));

            InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                view.loadDataWithBaseURL("https://untrusted.example/", "<html><body>foreign</body></html>",
                    "text/html", "UTF-8", null));
            waitFor(view, "document.body?.textContent === 'foreign'");
            assertEquals("\"undefined\"", evaluate(view, "typeof PairfobNotify"));
        }
    }

    @Test
    public void coldStartTapSurvivesUntilThePageAsks() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String tapUrl = "/pair#notify=1&d=d_de5175b654cd9532ae2c&pane=p_cold";
        long startedAt = System.currentTimeMillis();
        Intent launch = new Intent(context, MainActivity.class).putExtra(NotifyBridge.EXTRA_URL, tapUrl);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(launch)) {
            AtomicReference<WebView> holder = new AtomicReference<>();
            scenario.onActivity(activity -> {
                WebView view = activity.getBridge().getWebView();
                view.getSettings().setJavaScriptEnabled(true);
                holder.set(view);
            });
            WebView view = holder.get();

            // The bundled page boots before the test can reach the bridge, so the
            // evidence is the capture it records when the launch tap reaches it.
            waitFor(view, "JSON.parse(sessionStorage.getItem('pairfob.connection-diagnostics.v1') || '[]')"
                + ".some(r => r.event === 'notify_received' && r.reason === 'native_message' && r.at >= " + startedAt + ")", 120);
            scenario.onActivity(activity -> assertNull(activity.getIntent().getStringExtra(NotifyBridge.EXTRA_URL)));
        }
    }

    private StatusBarNotification find(NotificationManager manager, String tag) {
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (tag == null ? active.getTag() == null : tag.equals(active.getTag())) return active;
        }
        return null;
    }

    private void await(NotificationManager manager, String tag, boolean present) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if ((find(manager, tag) != null) == present) return;
            Thread.sleep(100);
        }
        fail((present ? "missing" : "still shown") + " notification: " + tag);
    }

    @Test
    public void theSystemShowsTheNoticeAndItsTapOpensThePane() throws Exception {
        grantNotifications();
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        String tapUrl = "/pair#notify=1&d=d_deliver&pane=p_deliver";
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> holder = new AtomicReference<>();
            scenario.onActivity(activity -> {
                WebView view = activity.getBridge().getWebView();
                view.getSettings().setJavaScriptEnabled(true);
                holder.set(view);
                view.loadDataWithBaseURL("https://localhost/", "<html><body>deliver</body></html>",
                    "text/html", "UTF-8", null);
            });
            WebView view = holder.get();
            waitFor(view, "typeof PairfobNotify === 'object'");
            evaluate(view, "window.replies={};window.taps=[];"
                + "PairfobNotify.onmessage=e=>{const m=JSON.parse(e.data);"
                + "if(m.event==='tap')taps.push(m.url);else replies[m.id]=m};"
                + "PairfobNotify.postMessage(JSON.stringify({id:'1',method:'ready'}))");
            waitFor(view, "!!replies['1']");

            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'2',method:'post',"
                + "title:'Agent needs you',body:'A pane is waiting',tag:'pane-1',url:'" + tapUrl + "'}))");
            waitFor(view, "replies['2']?.ok === true");
            await(manager, "pane-1", true);
            StatusBarNotification shown = find(manager, "pane-1");
            assertEquals("Agent needs you", shown.getNotification().extras.getString(Notification.EXTRA_TITLE));
            assertEquals(NotifyBridge.CHANNEL_AGENTS, shown.getNotification().getChannelId());

            Notification notice = shown.getNotification();
            PendingIntent tap = notice.contentIntent;
            scenario.onActivity(activity -> {
                try {
                    tap.send();
                } catch (PendingIntent.CanceledException error) {
                    fail("tap intent was cancelled");
                }
            });
            waitFor(view, "window.taps.length === 1");
            assertEquals("true", evaluate(view, "taps[0] === '" + tapUrl + "'"));

            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'3',method:'cancel',tag:'pane-1'}))");
            waitFor(view, "replies['3']?.ok === true");
            await(manager, "pane-1", false);

            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'4',method:'setBackgroundSync',on:true}))");
            waitFor(view, "replies['4']?.value?.backgroundSync === true");
            assertTrue("background sync is scheduled", NotifySyncJobService.isScheduled(context));

            evaluate(view, "PairfobNotify.postMessage(JSON.stringify({id:'5',method:'setBackgroundSync',on:false}))");
            waitFor(view, "replies['5']?.value?.backgroundSync === false");
            assertFalse("background sync is cancelled", NotifySyncJobService.isScheduled(context));
        }
    }
}
