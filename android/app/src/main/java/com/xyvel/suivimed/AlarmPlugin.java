package com.xyvel.suivimed;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

// Pont JS ⇄ natif pour les alarmes plein écran. Le JS calcule les créneaux
// (heures + relances de 5 min, prises non cochées) et les pousse ici ; la
// planification AlarmManager se fait dans AlarmScheduler.
@CapacitorPlugin(name = "Alarm")
public class AlarmPlugin extends Plugin {

    // set({ alarms: [{ id, at, title, body }] }) — remplace toutes les alarmes.
    @PluginMethod
    public void set(PluginCall call) {
        JSArray arr = call.getArray("alarms");
        try {
            JSONArray json = (arr != null) ? new JSONArray(arr.toString()) : new JSONArray();
            AlarmScheduler.setAll(getContext(), json);
            call.resolve();
        } catch (Exception e) {
            call.reject("Échec de planification des alarmes", e);
        }
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        AlarmScheduler.cancelAll(getContext());
        call.resolve();
    }

    // Android 14+ : l'autorisation « notifications plein écran » peut être requise
    // pour réveiller l'écran quand l'appareil est déverrouillé.
    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        boolean granted = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            granted = nm != null && nm.canUseFullScreenIntent();
        }
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Impossible d'ouvrir les réglages", e);
        }
    }

    // L'app est-elle exemptée de l'optimisation batterie (Doze) ? Sans ça, le
    // système peut différer les alarmes quand le téléphone reste posé longtemps.
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        boolean granted = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            granted = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        }
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    // Ouvre la boîte de dialogue système « Autoriser l'activité en arrière-plan /
    // ignorer l'optimisation batterie » pour cette app.
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Impossible d'ouvrir la demande d'exemption batterie", e);
        }
    }
}
