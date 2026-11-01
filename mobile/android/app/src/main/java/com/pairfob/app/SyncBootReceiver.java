package com.pairfob.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * A reboot and an app update both drop persisted jobs. Notifications stay on,
 * so the schedule has to come back without the user reopening the app.
 */
public final class SyncBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!NotifyBridge.backgroundSyncOn(context)) return;
        NotifySyncJobService.schedule(context);
    }
}
