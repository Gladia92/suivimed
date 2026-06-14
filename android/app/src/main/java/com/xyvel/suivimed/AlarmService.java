package com.xyvel.suivimed;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;

import androidx.core.app.NotificationCompat;

// Service au premier plan qui JOUE LE SON de l'alarme indépendamment de l'écran.
// Ainsi l'alarme sonne TOUJOURS, même si l'activité plein écran n'arrive pas à
// passer au premier plan (OEM agressif type Samsung). Il poste la notification
// full-screen (qui tente la prise d'écran) et lance aussi directement l'activité
// (fiable quand la permission « superposition » est accordée).
public class AlarmService extends Service {

    public static final String ACTION_STOP = "com.xyvel.suivimed.STOP_ALARM";
    private static final long MAX_MS = 30_000;

    private MediaPlayer player;
    private Vibrator vibrator;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean ringing = false;
    private int notifId = 1;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopEverything();
            return START_NOT_STICKY;
        }

        int id = intent != null ? intent.getIntExtra(AlarmScheduler.EXTRA_ID, 1) : 1;
        String title = intent != null ? intent.getStringExtra(AlarmScheduler.EXTRA_TITLE) : null;
        String body  = intent != null ? intent.getStringExtra(AlarmScheduler.EXTRA_BODY) : null;
        int moment   = intent != null ? intent.getIntExtra(AlarmScheduler.EXTRA_MOMENT, -1) : -1;
        String date  = intent != null ? intent.getStringExtra(AlarmScheduler.EXTRA_DATE) : null;
        if (title == null) title = "💊 Prise de médicament";
        if (body == null) body = "C'est l'heure de ta prise.";
        notifId = id;

        // Intent plein écran vers l'écran d'alarme
        Intent full = new Intent(this, AlarmActivity.class);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        full.putExtra(AlarmScheduler.EXTRA_ID, id);
        full.putExtra(AlarmScheduler.EXTRA_TITLE, title);
        full.putExtra(AlarmScheduler.EXTRA_MOMENT, moment);
        full.putExtra(AlarmScheduler.EXTRA_DATE, date);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent fullPi = PendingIntent.getActivity(this, id, full, piFlags);

        Notification n = new NotificationCompat.Builder(this, MainActivity.ALARM_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setContentIntent(fullPi)
            .setFullScreenIntent(fullPi, true)
            .build();

        startForegroundCompat(n);

        if (!ringing) {
            ringing = true;
            startSound();
            handler.postDelayed(this::stopEverything, MAX_MS);
        }

        // Lancement direct de l'activité (fiable avec la permission « superposition »).
        try { startActivity(full); } catch (Exception ignored) {}

        return START_NOT_STICKY;
    }

    private void startForegroundCompat(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(notifId, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(notifId, n);
            }
        } catch (Exception e) {
            try { startForeground(notifId, n); } catch (Exception ignored) {}
        }
    }

    private void startSound() {
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            AssetFileDescriptor afd = getResources().openRawResourceFd(R.raw.alarme_prise);
            player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception ignored) {}

        try {
            vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = { 0, 700, 1500 };
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception ignored) {}
    }

    private void stopEverything() {
        handler.removeCallbacksAndMessages(null);
        try { if (player != null) { player.stop(); player.release(); player = null; } } catch (Exception ignored) {}
        try { if (vibrator != null) vibrator.cancel(); } catch (Exception ignored) {}
        ringing = false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(Service.STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Exception ignored) {}
        stopSelf();
    }

    // Service court (Android 14+) : si le système nous coupe avant la fin, on arrête proprement.
    @Override
    public void onTimeout(int startId) {
        stopEverything();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopEverything();
    }
}
