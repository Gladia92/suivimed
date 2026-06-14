package com.xyvel.suivimed;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

// Reçu à l'heure prévue (via AlarmManager.setAlarmClock). Démarre AlarmService au
// premier plan : c'est lui qui joue le son (indépendamment de l'écran), poste la
// notification full-screen et tente la prise d'écran. Démarrer un service au
// premier plan depuis ce receiver est autorisé grâce à l'exemption « alarme exacte ».
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        int id = intent.getIntExtra(AlarmScheduler.EXTRA_ID, 1);
        String title = intent.getStringExtra(AlarmScheduler.EXTRA_TITLE);
        String body = intent.getStringExtra(AlarmScheduler.EXTRA_BODY);
        int moment = intent.getIntExtra(AlarmScheduler.EXTRA_MOMENT, -1);
        String date = intent.getStringExtra(AlarmScheduler.EXTRA_DATE);

        Intent svc = new Intent(ctx, AlarmService.class);
        svc.putExtra(AlarmScheduler.EXTRA_ID, id);
        svc.putExtra(AlarmScheduler.EXTRA_TITLE, title);
        svc.putExtra(AlarmScheduler.EXTRA_BODY, body);
        svc.putExtra(AlarmScheduler.EXTRA_MOMENT, moment);
        svc.putExtra(AlarmScheduler.EXTRA_DATE, date);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc);
            else ctx.startService(svc);
        } catch (Exception ignored) {
            // Si le service ne peut pas démarrer, on ne peut rien faire de plus ici.
        }
    }
}
