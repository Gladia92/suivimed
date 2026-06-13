package com.xyvel.suivimed;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Canal de l'alarme plein écran. La sonnerie elle-même est jouée par AlarmActivity
    // (MediaPlayer sur le flux ALARME), donc ce canal est SILENCIEUX : il ne sert qu'à
    // porter le full-screen intent qui réveille l'écran. Importance HIGH = requis pour
    // que le full-screen intent se déclenche.
    public static final String ALARM_CHANNEL_ID = "rappels_alarme_v2";

    // Canal du mode « push uniquement » : notification classique (flux notification),
    // son par défaut, sans réveil d'écran.
    public static final String PUSH_CHANNEL_ID = "rappels_push_v1";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin natif d'alarme (planification AlarmManager + activité plein écran),
        // enregistré avant super.onCreate comme l'exige Capacitor.
        registerPlugin(AlarmPlugin.class);
        super.onCreate(savedInstanceState);
        createChannels();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel alarm = new NotificationChannel(
            ALARM_CHANNEL_ID, "Alarme de prise", NotificationManager.IMPORTANCE_HIGH);
        alarm.setDescription("Alarme plein écran pour la prise des médicaments");
        alarm.setSound(null, null); // le son vient d'AlarmActivity (MediaPlayer)
        alarm.enableVibration(true);
        alarm.setVibrationPattern(new long[]{ 0, 600, 300, 600, 300, 600 });
        alarm.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(alarm);

        NotificationChannel push = new NotificationChannel(
            PUSH_CHANNEL_ID, "Rappels (notification)", NotificationManager.IMPORTANCE_HIGH);
        push.setDescription("Notification de rappel pour la prise des médicaments");
        push.enableVibration(true);
        push.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(push);
    }
}
