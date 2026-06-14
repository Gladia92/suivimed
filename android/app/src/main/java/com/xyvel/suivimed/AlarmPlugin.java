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

    // Récupère (et vide) les prises notées via le bouton « J'ai pris » de l'écran
    // d'alarme, pour que le JS coche réellement la prise dans ses données.
    @PluginMethod
    public void consumePendingTaken(PluginCall call) {
        String json = AlarmScheduler.consumePendingTaken(getContext());
        JSObject ret = new JSObject();
        try { ret.put("taken", new JSONArray(json)); }
        catch (Exception e) { ret.put("taken", new JSONArray()); }
        call.resolve(ret);
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

    // Mène DIRECTEMENT à l'écran « Notifications plein écran » de l'app (Android 14+).
    // Repli : page « Infos de l'application » si cet écran exact n'est pas disponible.
    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                i.setData(Uri.parse("package:" + ctx.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                call.resolve();
                return;
            } catch (Exception ignored) { /* écran indisponible → repli ci-dessous */ }
        }
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) {}
        call.resolve();
    }

    // « Afficher par-dessus les autres applications » (SYSTEM_ALERT_WINDOW) : donne
    // le droit de lancer l'écran d'alarme PAR-DESSUS l'app de devant (exemption BAL).
    @PluginMethod
    public void canDrawOverlays(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
            || Settings.canDrawOverlays(getContext());
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        Context ctx = getContext();
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
            return;
        } catch (Exception ignored) {}
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) {}
        call.resolve();
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

    // Ouvre l'écran « démarrage auto / arrière-plan » du constructeur (best-effort),
    // sinon retombe sur la page « Infos de l'application » d'Android (toujours présente).
    @PluginMethod
    public void openBackgroundSettings(PluginCall call) {
        Context ctx = getContext();
        String mf = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        for (String[] c : autostartCandidates(mf)) {
            try {
                Intent i = new Intent();
                i.setClassName(c[0], c[1]);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                call.resolve();
                return;
            } catch (Exception ignored) { /* écran absent/renommé → on tente le suivant */ }
        }
        // Repli universel : page « Infos de l'application » (Batterie, Notifications…).
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
            return;
        } catch (Exception ignored) {}
        try {
            ctx.startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {}
        call.resolve();
    }

    // Écrans « démarrage auto / arrière-plan » propriétaires, par constructeur.
    // ▶ UNIQUE endroit à mettre à jour si un OEM renomme son écran. Chaque entrée :
    //   { package, classe }, essayées dans l'ordre ; échec → repli (cf. ci-dessus).
    // Samsung / Android stock (Pixel, Motorola…) : pas d'autostart → liste vide,
    // on va directement sur « Infos de l'application ».
    private static String[][] autostartCandidates(String mf) {
        if (mf.contains("xiaomi") || mf.contains("redmi") || mf.contains("poco"))
            return new String[][]{
                { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" } };
        if (mf.contains("huawei") || mf.contains("honor"))
            return new String[][]{
                { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
                { "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity" } };
        if (mf.contains("oppo") || mf.contains("realme"))
            return new String[][]{
                { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
                { "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity" },
                { "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity" } };
        if (mf.contains("vivo"))
            return new String[][]{
                { "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity" },
                { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" } };
        return new String[][]{};
    }
}
