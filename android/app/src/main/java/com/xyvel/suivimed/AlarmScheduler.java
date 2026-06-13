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
// La liste d'alarmes (créneaux concrets calculés côté JS : l'heure de chaque
// moment puis des relances toutes les 5 min, sur quelques jours, en sautant les
// prises déjà notées) est persistée pour pouvoir être replanifiée après un
// redémarrage du téléphone (BootReceiver) — AlarmManager perd ses alarmes au boot.
class AlarmScheduler {
    static final String PREFS = "med_alarms";
    static final String KEY = "alarms";
    static final String ACTION = "com.xyvel.suivimed.MED_ALARM";
    static final String EXTRA_ID = "id";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BODY = "body";

    // Remplace toute la liste d'alarmes par celle fournie (annule d'abord les anciennes).
    static void setAll(Context ctx, JSONArray arr) {
        cancelAll(ctx);
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, arr.toString()).apply();
        scheduleSaved(ctx);
    }

    // (Re)planifie tous les créneaux encore dans le futur d'après la liste persistée.
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

            PendingIntent op = buildPI(ctx, id, o.optString(EXTRA_TITLE, "Prise"), o.optString(EXTRA_BODY, ""), false);
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
            PendingIntent op = buildPI(ctx, id, "", "", true);
            if (op != null && am != null) am.cancel(op);
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply();
    }

    private static PendingIntent buildPI(Context ctx, int id, String title, String body, boolean noCreate) {
        Intent i = new Intent(ctx, AlarmReceiver.class);
        i.setAction(ACTION + "_" + id);
        i.putExtra(EXTRA_ID, id);
        i.putExtra(EXTRA_TITLE, title);
        i.putExtra(EXTRA_BODY, body);
        int flags = (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        flags |= noCreate ? PendingIntent.FLAG_NO_CREATE : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getBroadcast(ctx, id, i, flags);
    }

    private static JSONArray load(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String s = p.getString(KEY, "[]");
        try { return new JSONArray(s); } catch (Exception e) { return new JSONArray(); }
    }
}
