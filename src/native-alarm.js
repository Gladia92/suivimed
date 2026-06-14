// Pont vers le plugin natif « Alarm » (Android) : alarme plein écran qui réveille
// l'écran. Sur web/desktop, tout est inopérant (no-op) — seul Capacitor l'expose.
import { registerPlugin, Capacitor } from "@capacitor/core";

const Alarm = registerPlugin("Alarm");

const isNative = () => Capacitor?.isNativePlatform?.() === true;

// alarms : [{ id:number, at:number(ms epoch), title:string, body:string }]
export async function setAlarms(alarms) {
  if (!isNative()) return;
  try { await Alarm.set({ alarms }); } catch {}
}

export async function cancelAlarms() {
  if (!isNative()) return;
  try { await Alarm.cancelAll(); } catch {}
}

// Android 14+ : l'autorisation « notifications plein écran » peut manquer.
export async function canUseFullScreen() {
  if (!isNative()) return true;
  try { const r = await Alarm.canUseFullScreenIntent(); return r?.granted !== false; }
  catch { return true; }
}

export async function openFullScreenSettings() {
  if (!isNative()) return;
  try { await Alarm.openFullScreenIntentSettings(); } catch {}
}

// Exemption d'optimisation batterie (Doze) : sans elle, le système peut différer
// l'alarme quand le téléphone reste posé longtemps.
export async function isBatteryUnrestricted() {
  if (!isNative()) return true;
  try { const r = await Alarm.isIgnoringBatteryOptimizations(); return r?.granted !== false; }
  catch { return true; }
}

export async function requestBatteryUnrestricted() {
  if (!isNative()) return;
  try { await Alarm.requestIgnoreBatteryOptimizations(); } catch {}
}

// « Afficher par-dessus les autres applications » (superposition) : permet à
// l'écran d'alarme de passer au premier plan même quand on est dans une autre app.
export async function canDrawOverlays() {
  if (!isNative()) return true;
  try { const r = await Alarm.canDrawOverlays(); return r?.granted !== false; }
  catch { return true; }
}

export async function requestOverlay() {
  if (!isNative()) return;
  try { await Alarm.requestOverlayPermission(); } catch {}
}

// Récupère (et vide) les prises notées via le bouton « J'ai pris » de l'écran
// d'alarme. Renvoie [{ moment:number, date:"YYYY-MM-DD" }, …].
export async function consumePendingTaken() {
  if (!isNative()) return [];
  try { const r = await Alarm.consumePendingTaken(); return Array.isArray(r?.taken) ? r.taken : []; }
  catch { return []; }
}

// Ouvre l'écran « démarrage auto / arrière-plan » du constructeur (best-effort),
// sinon la page « Infos de l'application ». Utile sur les OEM qui restreignent
// agressivement l'arrière-plan (Xiaomi, Huawei, Oppo, Vivo, veille Samsung…).
export async function openBackgroundSettings() {
  if (!isNative()) return;
  try { await Alarm.openBackgroundSettings(); } catch {}
}
