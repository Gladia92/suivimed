package com.xyvel.suivimed;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Au redémarrage du téléphone, AlarmManager a perdu ses alarmes : on les
// replanifie depuis la liste persistée par AlarmScheduler.
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (a == null) return;
        if (a.equals(Intent.ACTION_BOOT_COMPLETED)
            || a.equals("android.intent.action.LOCKED_BOOT_COMPLETED")
            || a.equals("android.intent.action.QUICKBOOT_POWERON")) {
            AlarmScheduler.scheduleSaved(ctx);
        }
    }
}
