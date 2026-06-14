package com.xyvel.suivimed;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

// Planification native des alarmes de prise via AlarmManager.setAlarmClock — le
// mode le plus fiable : exact, exécuté même en Doze, et exempté de la permission
// SCHEDULE_EXACT_ALARM (Android le traite comme un réveil).
//
// La liste d'alarmes (créneaux concrets calculés côté JS) est persistée pour être
// replanifiée après un redémarrage (BootReceiver). Chaque alarme porte aussi le
// moment (0=matin,1=midi,2=soir) et la date ISO, pour que le bouton « J'ai pris »
// de l'écran d'alarme puisse cocher la bonne prise.
class AlarmScheduler {
    static final String PREFS = "med_alarms";
    static final String KEY = "alarms";
    static final String KEY_TAKEN = "pending_taken"; // prises notées depuis l'alarme, à consommer par le JS
    static final String ACTION = "com.xyvel.suivimed.MED_ALARM";
    static final String EXTRA_ID = "id";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BODY = "body";
    static final String EXTRA_MOMENT = "moment";
    static final String EXTRA_DATE = "date";

    static void setAll(Context ctx, JSONArray arr) {
        cancelAll(ctx);
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, arr.toString()).apply();
        scheduleSaved(ctx);
    }

    static void scheduleSaved(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        JSONArray arr = load(ctx);
        long now = System.currentTimeMillis();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            int id = o.optInt(EXTRA_ID, -1);
            long at = o.optLong("at", 0L);
            if (id < 0 || at <= now) continue;

            PendingIntent op = buildPI(ctx, id, o.optString(EXTRA_TITLE, "Prise"), o.optString(EXTRA_BODY, ""),
                o.optInt(EXTRA_MOMENT, -1), o.optString(EXTRA_DATE, ""), false);
            Intent show = new Intent(ctx, MainActivity.class);
            int sflags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent showPi = PendingIntent.getActivity(ctx, 90000 + id, show, sflags);
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, showPi), op);
        }
    }

    static void cancelAll(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        JSONArray arr = load(ctx);
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            int id = o.optInt(EXTRA_ID, -1);
            if (id < 0) continue;
            PendingIntent op = buildPI(ctx, id, "", "", -1, "", true);
            if (op != null && am != null) am.cancel(op);
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply();
    }

    private static PendingIntent buildPI(Context ctx, int id, String title, String body, int moment, String date, boolean noCreate) {
        Intent i = new Intent(ctx, AlarmReceiver.class);
        i.setAction(ACTION + "_" + id);
        i.putExtra(EXTRA_ID, id);
        i.putExtra(EXTRA_TITLE, title);
        i.putExtra(EXTRA_BODY, body);
        i.putExtra(EXTRA_MOMENT, moment);
        i.putExtra(EXTRA_DATE, date);
        int flags = (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        flags |= noCreate ? PendingIntent.FLAG_NO_CREATE : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getBroadcast(ctx, id, i, flags);
    }

    // ── Prises notées depuis l'écran d'alarme (« J'ai pris ») ───────────────────
    // L'écran d'alarme ne peut pas écrire le localStorage du WebView ; il dépose
    // donc ici {moment, date} que le JS consomme à la prochaine ouverture.
    static void addPendingTaken(Context ctx, int moment, String date) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray arr;
        try { arr = new JSONArray(p.getString(KEY_TAKEN, "[]")); } catch (Exception e) { arr = new JSONArray(); }
        try {
            JSONObject o = new JSONObject();
            o.put("moment", moment);
            o.put("date", date);
            arr.put(o);
        } catch (Exception ignored) {}
        p.edit().putString(KEY_TAKEN, arr.toString()).apply();
    }

    static String consumePendingTaken(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String s = p.getString(KEY_TAKEN, "[]");
        p.edit().remove(KEY_TAKEN).apply();
        return s;
    }

    private static JSONArray load(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String s = p.getString(KEY, "[]");
        try { return new JSONArray(s); } catch (Exception e) { return new JSONArray(); }
    }
}
