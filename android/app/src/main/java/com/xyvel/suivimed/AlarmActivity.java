package com.xyvel.suivimed;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.NotificationManagerCompat;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

// Écran d'alarme plein écran (lancé par le full-screen intent d'AlarmReceiver) :
// réveille/allume l'écran même verrouillé, passe par-dessus les autres apps, joue
// le son (flux ALARME) et vibre. Deux actions DISTINCTES :
//   • Glisser le curseur  → ARRÊTE l'alarme seulement (ne coche PAS la prise).
//   • Bouton « J'ai pris » → coche réellement la prise (déposée pour le JS) ET arrête.
public class AlarmActivity extends Activity {

    private static final long MAX_MS = 30_000; // arrêt auto après 30 s

    private MediaPlayer player;
    private Vibrator vibrator;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int notifId = 1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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
        if (title == null) title = "Prise de médicament";
        title = title.replace("💊", "").trim();

        setContentView(buildUi(title));
        startAlarm();
        handler.postDelayed(this::stopAndFinish, MAX_MS);
    }

    private View buildUi(String title) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        GradientDrawable bg = new GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            new int[]{ Color.parseColor("#0E7490"), Color.parseColor("#06222B") });
        root.setBackground(bg);
        int pad = dp(28);
        root.setPadding(pad, dp(56), pad, dp(40));

        // Heure courante, en grand
        TextView clock = new TextView(this);
        clock.setText(new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date()));
        clock.setTextColor(Color.WHITE);
        clock.setTextSize(64);
        clock.setGravity(Gravity.CENTER);

        TextView emoji = new TextView(this);
        emoji.setText("💊");
        emoji.setTextSize(52);
        emoji.setGravity(Gravity.CENTER);
        addTop(root, clock, 0);
        addTop(root, emoji, dp(18));

        TextView tv = new TextView(this);
        tv.setText(title);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(27);
        tv.setGravity(Gravity.CENTER);
        addTop(root, tv, dp(8));

        TextView sub = new TextView(this);
        sub.setText("C'est l'heure de votre traitement");
        sub.setTextColor(Color.parseColor("#BEE9F2"));
        sub.setTextSize(15);
        sub.setGravity(Gravity.CENTER);
        addTop(root, sub, dp(10));

        // Espace flexible
        View spacer = new View(this);
        LinearLayout.LayoutParams spLp = new LinearLayout.LayoutParams(1, 0, 1f);
        spacer.setLayoutParams(spLp);
        root.addView(spacer);

        // ── Curseur « glisser pour arrêter » (n'incrémente PAS la prise) ──────────
        FrameLayout track = new FrameLayout(this);
        GradientDrawable trackBg = new GradientDrawable();
        trackBg.setColor(Color.parseColor("#2EFFFFFF")); // blanc ~18%
        trackBg.setCornerRadius(dp(34));
        track.setBackground(trackBg);
        LinearLayout.LayoutParams trackLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(68));
        track.setLayoutParams(trackLp);

        final TextView instr = new TextView(this);
        instr.setText("Glissez pour arrêter  →");
        instr.setTextColor(Color.WHITE);
        instr.setTextSize(16);
        instr.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams instrLp = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
        instr.setLayoutParams(instrLp);
        track.addView(instr);

        final TextView thumb = new TextView(this);
        thumb.setText("→");
        thumb.setTextColor(Color.parseColor("#0E7490"));
        thumb.setTextSize(24);
        thumb.setGravity(Gravity.CENTER);
        GradientDrawable thumbBg = new GradientDrawable();
        thumbBg.setColor(Color.WHITE);
        thumbBg.setShape(GradientDrawable.OVAL);
        thumb.setBackground(thumbBg);
        FrameLayout.LayoutParams thumbLp = new FrameLayout.LayoutParams(dp(58), dp(58));
        thumbLp.gravity = Gravity.START | Gravity.CENTER_VERTICAL;
        thumbLp.leftMargin = dp(5);
        thumb.setLayoutParams(thumbLp);
        track.addView(thumb);

        thumb.setOnTouchListener(new View.OnTouchListener() {
            float downX;
            @Override public boolean onTouch(View v, MotionEvent e) {
                float max = track.getWidth() - thumb.getWidth() - dp(10);
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX() - thumb.getTranslationX();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float tx = Math.max(0, Math.min(e.getRawX() - downX, max));
                        thumb.setTranslationX(tx);
                        instr.setAlpha(max > 0 ? 1f - tx / max : 1f);
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (max > 0 && thumb.getTranslationX() >= max * 0.7f) {
                            thumb.setTranslationX(max);
                            stopAndFinish(); // arrêt seul, sans cocher la prise
                        } else {
                            thumb.animate().translationX(0).setDuration(160).start();
                            instr.animate().alpha(1f).setDuration(160).start();
                        }
                        return true;
                }
                return false;
            }
        });
        addTop(root, track, dp(8));

        // ── Bouton secondaire, plus petit : « J'ai pris » (coche la prise) ────────
        TextView taken = new TextView(this);
        taken.setText("✓  J'ai pris mon traitement");
        taken.setTextColor(Color.WHITE);
        taken.setTextSize(14);
        taken.setGravity(Gravity.CENTER);
        taken.setPadding(dp(18), dp(12), dp(18), dp(12));
        GradientDrawable takenBg = new GradientDrawable();
        takenBg.setColor(Color.TRANSPARENT);
        takenBg.setStroke(dp(1), Color.parseColor("#66FFFFFF"));
        takenBg.setCornerRadius(dp(24));
        taken.setBackground(takenBg);
        taken.setOnClickListener(v -> markTakenAndFinish());
        addTop(root, taken, dp(16));

        return root;
    }

    private void addTop(LinearLayout root, View v, int topMargin) {
        LinearLayout.LayoutParams lp = (v.getLayoutParams() instanceof LinearLayout.LayoutParams)
            ? (LinearLayout.LayoutParams) v.getLayoutParams()
            : new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = topMargin;
        v.setLayoutParams(lp);
        root.addView(v);
    }

    // « J'ai pris » : dépose {moment, date} pour que le JS coche la prise, ouvre
    // l'app pour appliquer immédiatement, puis arrête l'alarme.
    private void markTakenAndFinish() {
        int moment = getIntent().getIntExtra(AlarmScheduler.EXTRA_MOMENT, -1);
        String date = getIntent().getStringExtra(AlarmScheduler.EXTRA_DATE);
        if (moment >= 0 && date != null && !date.isEmpty()) {
            AlarmScheduler.addPendingTaken(this, moment, date);
        }
        try {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        } catch (Exception ignored) {}
        stopAndFinish();
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
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception ignored) {}

        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
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
