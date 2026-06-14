package com.xyvel.suivimed;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

// Reçu à l'heure prévue (via AlarmManager). Poste une notification d'alarme dont
// le full-screen intent lance AlarmActivity : c'est ce qui RÉVEILLE L'ÉCRAN même
// verrouillé. Le son lui-même est joué par AlarmActivity (flux ALARME).
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        int id = intent.getIntExtra(AlarmScheduler.EXTRA_ID, 1);
        String title = intent.getStringExtra(AlarmScheduler.EXTRA_TITLE);
        String body = intent.getStringExtra(AlarmScheduler.EXTRA_BODY);
        int moment = intent.getIntExtra(AlarmScheduler.EXTRA_MOMENT, -1);
        String date = intent.getStringExtra(AlarmScheduler.EXTRA_DATE);
        if (title == null) title = "💊 Prise de médicament";
        if (body == null) body = "C'est l'heure de ta prise.";

        Intent full = new Intent(ctx, AlarmActivity.class);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        full.putExtra(AlarmScheduler.EXTRA_ID, id);
        full.putExtra(AlarmScheduler.EXTRA_TITLE, title);
        full.putExtra(AlarmScheduler.EXTRA_MOMENT, moment);
        full.putExtra(AlarmScheduler.EXTRA_DATE, date);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
            | (android.os.Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent fullPi = PendingIntent.getActivity(ctx, id, full, piFlags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, MainActivity.ALARM_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setOngoing(true)
            .setContentIntent(fullPi)
            .setFullScreenIntent(fullPi, true);

        try {
            NotificationManagerCompat.from(ctx).notify(id, b.build());
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS non accordée : rien à faire ici (l'app le signale dans les réglages).
        }

        // Tentative de lancement direct de l'activité (utile écran éteint sur certains OEM).
        try { ctx.startActivity(full); } catch (Exception ignored) {}
    }
}
