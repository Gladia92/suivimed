package com.xyvel.suivimed;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.NotificationManagerCompat;

// Écran d'alarme plein écran (lancé par le full-screen intent d'AlarmReceiver).
// Réveille et allume l'écran même verrouillé, joue le son d'alarme ~30 s sur le
// flux ALARME (fort, ignore silencieux/Ne pas déranger) et vibre. Un bouton
// « J'ai pris / Arrêter » coupe l'alarme. NB : il ne coche PAS la prise — tant
// qu'elle n'est pas notée dans l'app, la relance de 5 min plus tard sonnera.
public class AlarmActivity extends Activity {

    private static final long MAX_MS = 30_000; // durée max de sonnerie

    private MediaPlayer player;
    private Vibrator vibrator;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int notifId = 1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Afficher par-dessus l'écran de verrouillage + allumer l'écran.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) km.requestDismissKeyguard(this, null);
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        notifId = getIntent().getIntExtra(AlarmScheduler.EXTRA_ID, 1);
        String title = getIntent().getStringExtra(AlarmScheduler.EXTRA_TITLE);
        if (title == null) title = "💊 Prise de médicament";

        setContentView(buildUi(title));
        startAlarm();

        // Arrêt automatique au bout de 30 s.
        handler.postDelayed(this::stopAndFinish, MAX_MS);
    }

    private View buildUi(String title) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#0891B2")); // cyan XYVEL
        int pad = dp(24);
        root.setPadding(pad, pad, pad, pad);

        TextView emoji = new TextView(this);
        emoji.setText("💊");
        emoji.setTextSize(72);
        emoji.setGravity(Gravity.CENTER);

        TextView tv = new TextView(this);
        tv.setText(title);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(26);
        tv.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tvLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        tvLp.topMargin = dp(16);
        tv.setLayoutParams(tvLp);

        TextView sub = new TextView(this);
        sub.setText("N'oublie pas de cocher la prise dans l'app,\nsinon l'alarme resonnera dans 5 minutes.");
        sub.setTextColor(Color.parseColor("#E0F7FA"));
        sub.setTextSize(14);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = dp(12);
        sub.setLayoutParams(subLp);

        Button stop = new Button(this);
        stop.setText("J'ai pris / Arrêter");
        stop.setTextSize(18);
        stop.setOnClickListener(v -> stopAndFinish());
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        btnLp.topMargin = dp(40);
        stop.setLayoutParams(btnLp);

        root.addView(emoji);
        root.addView(tv);
        root.addView(sub);
        root.addView(stop);
        return root;
    }

    private void startAlarm() {
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            AssetFileDescriptor afd = getResources().openRawResourceFd(R.raw.alarme_prise);
            player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            player.setLooping(true); // bouclé : couvre toute la fenêtre de 30 s
            player.prepare();
            player.start();
        } catch (Exception ignored) {}

        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = { 0, 700, 500 };
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception ignored) {}
    }

    private void stopAndFinish() {
        handler.removeCallbacksAndMessages(null);
        try { if (player != null) { player.stop(); player.release(); player = null; } } catch (Exception ignored) {}
        try { if (vibrator != null) vibrator.cancel(); } catch (Exception ignored) {}
        try { NotificationManagerCompat.from(this).cancel(notifId); } catch (Exception ignored) {}
        finish();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopAndFinish();
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }
}
