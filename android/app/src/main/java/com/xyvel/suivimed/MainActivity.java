package com.xyvel.suivimed;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Canal des rappels de prise. Créé NATIVEMENT (et non via l'API JS du plugin)
    // pour pouvoir utiliser USAGE_ALARM : le son passe alors par le flux « alarme »
    // d'Android — volume d'alarme (fort), et surtout il sonne même en mode
    // silencieux / vibreur / Ne pas déranger, contrairement au flux notification.
    // L'API JS LocalNotifications.createChannel force USAGE_NOTIFICATION et ne
    // permet donc pas ce comportement d'alarme.
    //
    // ID versionné : un canal est IMMUABLE une fois créé. Pour changer le son ou
    // les attributs audio, il faut un nouvel ID (l'ancien canal silencieux reste
    // sinon en place sur les installations existantes).
    public static final String ALARM_CHANNEL_ID = "rappels_alarme_v1";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createAlarmChannel();
    }

    private void createAlarmChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel channel = new NotificationChannel(
            ALARM_CHANNEL_ID,
            "Alarme de prise",
            NotificationManager.IMPORTANCE_HIGH // bandeau + son
        );
        channel.setDescription("Sonnerie d'alarme pour ne pas oublier la prise des médicaments");

        // Flux ALARME : volume d'alarme, ignore le mode silencieux et passe outre
        // « Ne pas déranger » (les alarmes sont autorisées par défaut en DND).
        AudioAttributes audioAttributes = new AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .setUsage(AudioAttributes.USAGE_ALARM)
            .build();

        Uri soundUri = Uri.parse(
            ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + getPackageName() + "/raw/alarme_prise"
        );
        channel.setSound(soundUri, audioAttributes);

        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{ 0, 600, 300, 600, 300, 600 });
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        channel.enableLights(true);

        nm.createNotificationChannel(channel);
    }
}
