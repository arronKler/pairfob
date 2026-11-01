package com.pairfob.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Keeps the paired-computer socket alive while background notifications are on. */
public final class KeepAliveService extends Service {
    private static final int NOTIFICATION_ID = 1;
    private static volatile boolean running;

    static boolean isRunning() {
        return running;
    }

    static void setRunning(boolean value) {
        running = value;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotifyBridge.ensureChannels(this);
        Notification notification = buildNotification(this);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        running = true;
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    static void refreshNotification(Context context) {
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, buildNotification(context));
    }

    static Notification buildNotification(Context context) {
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(context, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(context, NotifyBridge.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(context.getString(R.string.keepalive_title))
            .setContentText(context.getString(R.string.keepalive_text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(content)
            .build();
    }
}
