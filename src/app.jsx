import { useState, useEffect, useCallback, useRef } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import * as gdriveMobile from "./gdrive-mobile.js";
import { setAlarms, cancelAlarms, canUseFullScreen, openFullScreenSettings } from "./native-alarm.js";

// ── Electron bridge (falls back to localStorage in browser dev)
const isElectron = !!window.electronAPI;
const isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const syncAvailable = isElectron || isCapacitor;

// Sync Drive : même API côté PC (Electron) et mobile (Capacitor)
const sync = {
  signIn:  () => isElectron ? window.electronAPI.gdriveSignIn()  : gdriveMobile.signIn(),
  signOut: () => isElectron ? window.electronAPI.gdriveSignOut() : gdriveMobile.signOut(),
  status:  () => isElectron ? window.electronAPI.gdriveStatus()  : gdriveMobile.getStatus(),
  pull:    () => isElectron ? window.electronAPI.gdrivePull()    : gdriveMobile.pull(),
  push:    () => isElectron ? window.electronAPI.gdrivePush()    : gdriveMobile.push(),
  remoteTime: () => isElectron ? window.electronAPI.gdriveRemoteTime() : gdriveMobile.getRemoteTime(),
};

// Fenêtre de planification des rappels : nombre de jours couverts, et nombre de
// rappels supplémentaires toutes les 5 min après l'heure prévue par moment.
const REMINDER_WINDOW_DAYS = 3;
const REMINDER_REPEATS = 12; // 12 rappels de 5 min = jusqu'à 1h après l'heure prévue
// Canal du mode « push uniquement » (notification classique). Le canal d'alarme,
// lui, est créé nativement (USAGE_ALARM + full-screen) dans MainActivity.
const PUSH_CHANNEL = "rappels_push_v1";

// Construit la liste des créneaux de rappel pour un moment donné : l'heure prévue
// (r=0) puis des relances toutes les 5 min (r=1..REPEATS), sur la fenêtre de jours,
// en sautant aujourd'hui si la prise est déjà notée. Renvoie [{ day, r, at }].
function reminderSlots(reminders, meds, base, now, mo, todayData){
  const t = reminders[mo.key]; if (!t) return [];
  const [h, mi] = String(t).split(":").map(Number);
  if (isNaN(h) || isNaN(mi)) return [];
  const slots = [];
  for (let day = 0; day < REMINDER_WINDOW_DAYS; day++) {
    const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day);
    const ds = dateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const prescribedIdx = [];
    meds.forEach((med, i) => { if (prescribedDose(med, ds, mo.key) > 0) prescribedIdx.push(i); });
    if (!prescribedIdx.length) continue;
    // Aujourd'hui : si tout est déjà pris pour ce moment, on ne programme rien.
    if (day === 0 && prescribedIdx.every(i => takenDose(todayData, i, mo.key) > 0)) continue;
    for (let r = 0; r <= REMINDER_REPEATS; r++) {
      const at = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), h, mi + r * 5, 0, 0);
      if (at <= now) continue;
      slots.push({ day, r, at });
    }
  }
  return slots;
}

// Rappels de prise (mobile). Deux modes (réglage `reminders.mode`) :
//  - "alarm" (défaut) : vraie alarme plein écran qui RÉVEILLE L'ÉCRAN même verrouillé,
//    son fort ~30 s sur le flux alarme + bouton d'arrêt (plugin natif Alarm).
//  - "push" : notification classique (plugin @capacitor/local-notifications).
// Dans les deux cas : l'heure prévue puis des relances toutes les 5 min tant que la
// prise n'est pas cochée. Cocher la prise replanifie et annule les relances restantes.
// Retourne un statut UI : "ok" | "ok-alarm" | "inexact" | "no-permission"
//                       | "no-fullscreen" | "disabled" | "unavailable".
async function scheduleReminders(settings){
  if (!isCapacitor) return "unavailable";
  let LN;
  try { ({ LocalNotifications: LN } = await import("@capacitor/local-notifications")); }
  catch { return "unavailable"; }

  // Date recalculée à CHAQUE appel : le process Android peut vivre plusieurs jours,
  // la constante de module `today` serait périmée — la fenêtre entière tomberait
  // dans le passé et le cancel ci-dessous supprimerait les rappels sans remplaçants.
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Tous les ids possibles (mode push) pour l'annulation côté plugin.
  const pushIds = [];
  for (let day = 0; day < REMINDER_WINDOW_DAYS; day++)
    for (let mi = 0; mi < MOMENTS.length; mi++)
      for (let r = 0; r <= REMINDER_REPEATS; r++)
        pushIds.push(day * 100 + mi * 20 + r);

  try {
    // On annule TOUJOURS les deux systèmes (indispensable au changement de mode).
    await LN.cancel({ notifications: pushIds.map(id => ({ id })) }).catch(()=>{});
    await cancelAlarms();

    const reminders = settings?.reminders;
    if (!reminders?.enabled) return "disabled";
    const perm = await LN.requestPermissions();
    if (perm.display !== "granted") return "no-permission";

    const mode = reminders.mode === "push" ? "push" : "alarm";
    const meds = (settings.meds || []).map(medOf);
    const todayData = (await loadMonth(base.getFullYear(), base.getMonth()))[`d${base.getDate()}`];

    if (mode === "alarm") {
      // Liste de créneaux concrets poussée au plugin natif (planification AlarmManager).
      const alarms = [];
      MOMENTS.forEach((mo, mIdx) => {
        for (const { day, r, at } of reminderSlots(reminders, meds, base, now, mo, todayData)) {
          alarms.push({
            id: day * 100 + mIdx * 20 + r,
            at: at.getTime(),
            title: "💊 Prise du " + mo.label.toLowerCase(),
            body: r === 0 ? "C'est l'heure de ta prise." : "Rappel : prise pas encore notée.",
          });
        }
      });
      await setAlarms(alarms);
      // Android 14+ : sans l'autorisation « plein écran », l'écran peut ne pas
      // s'allumer quand l'appareil est déverrouillé.
      if (!(await canUseFullScreen())) return "no-fullscreen";
      return "ok-alarm";
    }

    // Mode "push" : notifications classiques via le plugin, sur le canal notification.
    const items = [];
    MOMENTS.forEach((mo, mIdx) => {
      for (const { day, r, at } of reminderSlots(reminders, meds, base, now, mo, todayData)) {
        items.push({
          id: day * 100 + mIdx * 20 + r,
          title: "💊 Prise du " + mo.label.toLowerCase(),
          body: r === 0 ? "N'oublie pas ta prise de médicament." : "Rappel : prise pas encore notée.",
          schedule: { at, allowWhileIdle: true },
          channelId: PUSH_CHANNEL,
        });
      }
    });
    if (items.length) await LN.schedule({ notifications: items });

    // Android 14+ : les alarmes exactes sont refusées par défaut ; sans elles les
    // notifications partent en retard (mode Doze). On remonte l'info à l'UI.
    try {
      const ex = await LN.checkExactNotificationSetting();
      if (ex?.exact_alarm && ex.exact_alarm !== "granted") return "inexact";
    } catch {}
    return "ok";
  } catch { return "unavailable"; }
}

// Les 3 moments de prise dans la journée.
const MOMENTS = [
  { key: "matin", label: "Matin", icon: "ti-sunrise" },
  { key: "midi",  label: "Midi",  icon: "ti-sun" },
  { key: "soir",  label: "Soir",  icon: "ti-moon" },
];

const MONTHS       = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const MONTHS_SHORT = ["Jan","Fév","Mar","Avr","Mai","Jui","Jul","Aoû","Sep","Oct","Nov","Déc"];
const WEEKDAYS      = ["dimanche","lundi","mardi","mercredi","jeudi","vendredi","samedi"];
const WEEKDAYS_MINI = ["D","L","M","M","J","V","S"];
const today = new Date();

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function fileKey(y, m)     { return `suivimed_${y}_${String(m + 1).padStart(2,"0")}.json`; } // m 0-based -> nom 1-based
function settingsFile()    { return "suivimed_settings.json"; }
function pad(n)            { return String(n).padStart(2, "0"); }
function dateStr(y, m, d)  { return `${y}-${pad(m + 1)}-${pad(d)}`; } // m 0-based -> ISO YYYY-MM-DD
function todayStr()        { return dateStr(today.getFullYear(), today.getMonth(), today.getDate()); }
// Une date ISO est-elle dans le passé (strictement avant aujourd'hui) ?
// Un moment prévu n'est un « oubli » que s'il est passé et non pris.
function isPast(ds)        { return ds < todayStr(); }

// Un médicament : { name, note, regimens: [{ start, end, matin, midi, soir }] }.
// Rétro-compatible avec l'ancien format chaîne (juste un nom).
function medOf(m) {
  if (typeof m === "string") return { name: m, note: "", regimens: [] };
  return {
    name: m?.name || "",
    note: m?.note || "",
    regimens: Array.isArray(m?.regimens) ? m.regimens : [],
  };
}

// Régime posologique actif à une date donnée (ISO). Si plusieurs se chevauchent,
// on retient celui dont la date de début est la plus récente (le plus pertinent).
function activeRegimen(med, ds) {
  let best = null;
  for (const r of med.regimens) {
    if (!r.start) continue;
    if (r.start <= ds && (!r.end || ds <= r.end)) {
      if (!best || r.start > best.start) best = r;
    }
  }
  return best;
}
function prescribedDose(med, ds, momentKey) {
  const r = activeRegimen(med, ds);
  return r ? (Number(r[momentKey]) || 0) : 0;
}
function takenDose(dayData, i, momentKey) {
  const v = dayData?.[`med_${i}`]?.[momentKey];
  return Number(v) || 0;
}

// Affichage d'une dose PRESCRITE en fraction lisible (0.5 → « ½ », 1.5 → « 1½ »).
// Ne concerne que la posologie : la grille, elle, n'enregistre que « pris / pas pris ».
function fmtDose(n){
  n = Number(n) || 0;
  const whole = Math.floor(n);
  const f = n - whole;
  const g = f===0.25?"¼":f===0.5?"½":f===0.75?"¾":"";
  if (!g && f!==0) return String(n);
  if (whole===0) return g || "0";
  return g ? `${whole}${g}` : String(whole);
}
// Saisie d'une dose tolérante : « 1/2 », « 0,5 », « .5 », entiers… → nombre.
function parseDose(s){
  if (s==null) return 0;
  s = String(s).trim().replace(",", ".");
  if (s==="") return 0;
  const fr = s.match(/^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/);
  if (fr){ const d=parseFloat(fr[2]); return d ? Math.max(0, parseFloat(fr[1])/d) : 0; }
  const n = parseFloat(s);
  return isNaN(n)||n<0 ? 0 : n;
}
// Représentation éditable d'une dose (virgule décimale, FR-friendly).
function doseStr(n){ n = Number(n)||0; return n ? String(n).replace(".", ",") : "0"; }

// ── Storage abstraction
async function loadFile(filename) {
  if (isElectron) {
    const raw = await window.electronAPI.readData(filename);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  } else {
    try { return JSON.parse(localStorage.getItem(filename)); } catch { return null; }
  }
}

async function saveFile(filename, data) {
  const str = JSON.stringify(data, null, 2);
  if (isElectron) {
    await window.electronAPI.writeData(filename, str);
  } else {
    localStorage.setItem(filename, str);
  }
}

// Fichier purement local (jamais synchronisé : pas de préfixe "suivimed_") qui
// retient la date du dernier alignement avec le Drive, pour savoir au démarrage
// si le Drive a été modifié par un autre appareil depuis (→ pull nécessaire)
// ou si c'est à nous de pousser nos changements locaux.
const SYNC_META_FILE = "sync_meta.json";
async function loadSyncMeta() { return (await loadFile(SYNC_META_FILE)) || {}; }
async function markSynced(remoteModifiedTime) {
  const at = remoteModifiedTime ? new Date(remoteModifiedTime).getTime() : Date.now();
  await saveFile(SYNC_META_FILE, { lastSyncAt: at });
}

// Au démarrage : si le Drive a été modifié par un autre appareil depuis notre
// dernière synchro, récupère ces données avant de charger l'état local — pour
// éviter que l'auto-push n'écrase le Drive avec un cache local périmé.
async function pullIfRemoteNewer() {
  try {
    const { remoteModifiedTime } = await sync.remoteTime();
    if (!remoteModifiedTime) return false;
    const remoteAt = new Date(remoteModifiedTime).getTime();
    const meta = await loadSyncMeta();
    if (meta.lastSyncAt && remoteAt <= meta.lastSyncAt) return false;
    await sync.pull();
    await markSynced(remoteModifiedTime);
    return true;
  } catch { return false; }
}

async function loadSettings() {
  return (await loadFile(settingsFile())) || { meds: [] };
}

async function loadMonth(y, m) {
  return (await loadFile(fileKey(y, m))) || {};
}

async function getAllMonthsData() {
  const result = [];
  if (isElectron) {
    const files = await window.electronAPI.listData();
    for (const f of files) {
      if (!f.startsWith("suivimed_") || f === settingsFile()) continue;
      const raw = await window.electronAPI.readData(f);
      try {
        const parts = f.replace("suivimed_","").replace(".json","").split("_");
        const y = parseInt(parts[0]), mo = parseInt(parts[1]) - 1;
        const data = JSON.parse(raw);
        if (Object.keys(data).length) result.push({ year: y, month: mo, data });
      } catch {}
    }
  } else {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith("suivimed_") || k === settingsFile()) continue;
      try {
        const parts = k.replace("suivimed_","").replace(".json","").split("_");
        const y = parseInt(parts[0]), mo = parseInt(parts[1]) - 1;
        const data = JSON.parse(localStorage.getItem(k));
        if (Object.keys(data).length) result.push({ year: y, month: mo, data });
      } catch {}
    }
  }
  return result.sort((a,b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
}

// Moments à afficher dans la grille pour un médicament : ceux prescrits par au moins
// un régime, plus ceux réellement pris ce mois-ci. À défaut, on montre les 3.
function relevantMoments(med, monthData, i) {
  const set = new Set();
  med.regimens.forEach(r => MOMENTS.forEach(mo => { if (Number(r[mo.key]) > 0) set.add(mo.key); }));
  Object.values(monthData).forEach(dd => {
    const v = dd?.[`med_${i}`];
    if (v) MOMENTS.forEach(mo => { if (Number(v[mo.key]) > 0) set.add(mo.key); });
  });
  if (set.size === 0) MOMENTS.forEach(mo => set.add(mo.key));
  return MOMENTS.filter(mo => set.has(mo.key));
}

// Observance d'un mois. Comptage par MOMENT (binaire : pris / pas pris).
//  - « due »   : moment prescrit ET échu (date passée) OU déjà pris → entre au dénominateur.
//  - « taken » : moment dû et pris.
//  - « missed »: moment prescrit, passé et NON pris (un oubli ne l'est qu'au passé).
//  - « extra » : pris à un moment non prévu par la posologie.
// Les moments prévus aujourd'hui/futur mais pas encore pris ne pénalisent pas l'observance.
function emptyMoments() { return { matin:{due:0,taken:0,missed:0}, midi:{due:0,taken:0,missed:0}, soir:{due:0,taken:0,missed:0} }; }
function computeAdherence(monthData, meds, year, month) {
  const days = daysInMonth(year, month);
  const byMoment = emptyMoments();
  const perMed = meds.map((m, i) => {
    const med = medOf(m);
    let prescribed = 0, taken = 0, missed = 0, extra = 0;
    const takenDays = new Set();
    const medMoment = emptyMoments();
    for (let d = 1; d <= days; d++) {
      const ds = dateStr(year, month, d);
      const past = isPast(ds);
      const dd = monthData[`d${d}`];
      MOMENTS.forEach(mo => {
        const P = prescribedDose(med, ds, mo.key) > 0; // moment prévu ?
        const T = takenDose(dd, i, mo.key) > 0;         // moment pris ?
        const due = P && (past || T);                   // échu ou déjà pris
        if (due)            { prescribed += 1; byMoment[mo.key].due += 1;    medMoment[mo.key].due += 1; }
        if (due && T)       { taken += 1;      byMoment[mo.key].taken += 1;  medMoment[mo.key].taken += 1; }
        if (P && past && !T){ missed += 1;     byMoment[mo.key].missed += 1; medMoment[mo.key].missed += 1; }
        if (!P && T) extra += 1; // pris à un moment non prévu par la posologie
        if (T) takenDays.add(d);
      });
    }
    const rate = prescribed > 0 ? Math.round(taken / prescribed * 100) : null;
    return { name: med.name, prescribed, taken, missed, extra, days: takenDays.size, rate, byMoment: medMoment };
  });
  const sum = (k) => perMed.reduce((s, x) => s + x[k], 0);
  const prescribed = sum("prescribed"), taken = sum("taken"), missed = sum("missed");
  const rate = prescribed > 0 ? Math.round(taken / prescribed * 100) : null;
  return { perMed, prescribed, taken, missed, extra: sum("extra"), rate, byMoment };
}

// Moment (matin/midi/soir) le plus oublié sur un objet byMoment ; null si rien.
function worstMoment(byMoment) {
  let worst = null;
  MOMENTS.forEach(mo => {
    const b = byMoment[mo.key];
    if (!b || b.due === 0 || b.missed === 0) return;
    const rate = b.taken / b.due;
    if (!worst || b.missed > worst.missed || (b.missed === worst.missed && rate < worst.rate))
      worst = { key: mo.key, label: mo.label, missed: b.missed, due: b.due, rate };
  });
  return worst;
}

function rateColor(rate) {
  if (rate == null) return "#f0f0f0";
  if (rate >= 90) return "#c0dd97";
  if (rate >= 75) return "#FAC775";
  if (rate >= 50) return "#F0997B";
  return "#E24B4A";
}

function regimenText(med) {
  const regs = (med.regimens || []).slice().sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  if (!regs.length) return "posologie non renseignée";
  return regs.map(r => {
    const period = `du ${r.start || "?"}${r.end ? ` au ${r.end}` : " (en cours)"}`;
    const doses = MOMENTS.map(mo => Number(r[mo.key]) > 0 ? `${mo.label.toLowerCase()} ${fmtDose(r[mo.key])}` : null)
      .filter(Boolean).join(", ") || "aucune prise";
    return `${period} : ${doses}`;
  }).join(" | ");
}

function buildPrompt(monthsData, settings, year, month) {
  const meds = settings.meds.map(medOf);

  const medsTxt = meds.length ? meds.map(med => {
    const regs = (med.regimens || []).slice().sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    const lines = regs.length
      ? regs.map(r => {
          const period = `du ${r.start || "?"}${r.end ? ` au ${r.end}` : " (en cours)"}`;
          const doses = MOMENTS.map(mo => Number(r[mo.key]) > 0 ? `${mo.label.toLowerCase()} ${fmtDose(r[mo.key])}` : null)
            .filter(Boolean).join(", ") || "aucune prise";
          return `    • ${period} : ${doses}`;
        }).join("\n")
      : "    • posologie non renseignée";
    return `- ${med.name}${med.note ? ` (${med.note})` : ""} :\n${lines}`;
  }).join("\n") : "- aucun médicament renseigné";

  const monthly = monthsData
    .map(({ year: y, month: m, data }) => ({ y, m, adh: computeAdherence(data, settings.meds, y, m) }))
    .filter(x => x.adh.prescribed > 0 || x.adh.taken > 0);

  // Observance par moment de la journée (matin/midi/soir), tous médicaments confondus.
  const momentLine = (byMoment) => MOMENTS.map(mo => {
    const b = byMoment[mo.key];
    if (!b || b.due === 0) return null;
    return `${mo.label.toLowerCase()} ${Math.round(b.taken / b.due * 100)}%${b.missed ? ` (${b.missed} oubli${b.missed > 1 ? "s" : ""})` : ""}`;
  }).filter(Boolean).join(", ");

  const recap = monthly.map(({ y, m, adh }) => {
    const tag = (y === year && m === month) ? " [mois courant]" : "";
    const per = adh.perMed.filter(mc => mc.prescribed > 0 || mc.taken > 0)
      .map(mc => `${mc.name}: ${mc.rate !== null ? mc.rate + "%" : "n/a"}${mc.missed ? `, ${mc.missed} oubli(s)` : ""}${mc.extra ? `, ${mc.extra} hors prescription` : ""}`).join(" ; ");
    const moms = momentLine(adh.byMoment);
    return `- ${MONTHS[m]} ${y}${tag} : observance ${adh.rate !== null ? adh.rate + "%" : "n/a"} (${adh.taken}/${adh.prescribed} prises dues faites, ${adh.missed} oubli(s), ${adh.extra} hors prescription)${moms ? ` — par moment : ${moms}` : ""}${per ? ` — par médicament : ${per}` : ""}`;
  }).join("\n");

  const cur = monthly.find(x => x.y === year && x.m === month);
  const detail = cur
    ? cur.adh.perMed.filter(mc => mc.prescribed > 0 || mc.taken > 0).map(mc => {
        const w = worstMoment(mc.byMoment);
        const wTxt = w ? ` — oublis surtout le ${w.label.toLowerCase()} (${w.missed})` : "";
        return `- ${mc.name} : ${mc.taken}/${mc.prescribed} prises dues faites, ${mc.missed} oubli(s)${mc.extra ? `, ${mc.extra} hors prescription` : ""}, observance ${mc.rate !== null ? mc.rate + "%" : "n/a"}${wTxt}`;
      }).join("\n")
    : "Aucune prise enregistrée ce mois-ci.";

  // Signaux saillants extraits des données (pour guider une analyse ciblée).
  const signals = [];
  if (cur) {
    const w = worstMoment(cur.adh.byMoment);
    if (w) signals.push(`Moment le plus oublié : ${w.label.toLowerCase()} (${w.missed} oubli(s) sur ${w.due} prévus).`);
    const weak = cur.adh.perMed.filter(mc => mc.rate !== null && mc.rate < 80);
    if (weak.length) signals.push(`Médicament(s) sous 80 % d'observance : ${weak.map(mc => `${mc.name} (${mc.rate}%)`).join(", ")}.`);
    const over = cur.adh.perMed.filter(mc => mc.extra > 0);
    if (over.length) signals.push(`Prises hors prescription : ${over.map(mc => `${mc.name} (${mc.extra})`).join(", ")} — vérifier un éventuel surdosage.`);
    if (!signals.length) signals.push("Aucun signal d'alerte évident sur le mois courant.");
  }

  const prof = settings.profile || {};
  const sexLabel = prof.sex === "F" ? "Femme" : prof.sex === "M" ? "Homme" : (prof.sex || "non précisé");
  const age = prof.birthYear ? (today.getFullYear() - Number(prof.birthYear)) : null;
  const patientLines = [
    `- Sexe : ${sexLabel}`,
    age ? `- Âge : ${age} ans` : null,
    prof.weight ? `- Poids : ${prof.weight} kg` : null,
    prof.conditions ? `- Antécédents / maladies chroniques : ${prof.conditions}` : null,
    prof.treatments ? `- Traitement de fond / autres médicaments : ${prof.treatments}` : null,
  ].filter(Boolean).join("\n");

  return `Analyse le journal de prises de médicaments ci-dessous et rédige un compte rendu d'observance pour le médecin traitant.

Profil patient :
${patientLines}

Médicaments suivis et posologie prescrite (peut varier dans le temps) :
${medsTxt}

Période analysée : ${monthly.length} mois enregistré(s).

--- RÉCAP MENSUEL D'OBSERVANCE (du plus ancien au plus récent) ---
${recap || "Aucune donnée."}

--- DÉTAIL DU MOIS COURANT (${MONTHS[month]} ${year}) ---
${detail}

--- SIGNAUX À EXAMINER EN PRIORITÉ ---
${signals.length ? signals.join("\n") : "—"}
---

Définitions : on compte des MOMENTS de prise (matin/midi/soir), pas des quantités. « due » = moment prescrit et déjà échu ; « faite » = moment dû effectivement pris ; « oubli » = moment dû non pris (uniquement dans le passé) ; « hors prescription » = prise à un moment non prévu (signal possible de surconsommation). La quantité par prise (½, 1, 2…) figure dans la posologie ci-dessus.

Commence ta réponse par le titre exact, seul sur la première ligne, sans le modifier : COMPTE RENDU OBSERVANCE POUR LE MÉDECIN TRAITANT

Exigences de rédaction :
- Sois CIBLÉ et CONCIS : appuie chaque affirmation sur un chiffre du journal (taux, nombre d'oublis, moment concerné). Pas de généralités creuses.
- PRIORISE : commence par ce qui compte le plus pour CE patient (les signaux ci-dessus). N'allonge pas pour remplir.
- Si une rubrique n'a rien de notable, écris « RAS » plutôt que de meubler.

Structure (titres en MAJUSCULES) :

1. RÉSUMÉ — médicaments, période, observance globale, et LE point d'attention principal en une phrase.
2. OBSERVANCE — taux global et par médicament ; surtout, à QUEL MOMENT (matin/midi/soir) et pour QUEL médicament les oublis se concentrent, chiffres à l'appui.
3. POSOLOGIE & SÉCURITÉ — la posologie prescrite est-elle cohérente pour ce profil (âge, poids, antécédents) ? Signes de SURDOSAGE (prises hors prescription, dose forte) ou de SOUS-DOSAGE. Signale toute dose inhabituelle.
4. INTERACTIONS — interactions plausibles entre les médicaments listés et avec le traitement de fond ; vigilance selon le profil. Sois spécifique aux molécules citées.
5. SUGGESTIONS POUR LE MÉDECIN — 2 à 4 pistes concrètes d'ajustement ou alternatives à DISCUTER, justifiées par les données. Rappelle EXPLICITEMENT que ce sont des suggestions, JAMAIS une prescription.
6. CONSEILS D'OBSERVANCE — rappels concrets et personnalisés, ciblant le moment le plus oublié.

Sois prudent : signale si les données sont insuffisantes (peu de mois/prises) et rappelle que seule une consultation médicale permet de décider.`;
}

function exportPDF(year, month, data, settings, aiResult) {
  const meds = settings.meds.map(medOf);
  const days = daysInMonth(year, month);
  const adh = computeAdherence(data, settings.meds, year, month);

  // Lignes : pour chaque médicament, ses moments pertinents.
  const rows = [];
  meds.forEach((med, i) => {
    rows.push({ type: "head", label: med.name + (med.note ? ` (${med.note})` : "") });
    relevantMoments(med, data, i).forEach(mo => rows.push({ type: "moment", medIdx: i, momentKey: mo.key, label: mo.label }));
  });

  const cell = (d, row) => {
    const ds = dateStr(year, month, d);
    const med = meds[row.medIdx];
    const P = prescribedDose(med, ds, row.momentKey);
    const T = takenDose(data[`d${d}`], row.medIdx, row.momentKey);
    if (T > 0) return "✓";
    if (P > 0) return "○";
    return "";
  };

  const tableRows = rows.map(row => {
    if (row.type === "head") {
      return `<tr><td colspan="${days + 1}" style="font-size:13px;font-weight:bold;padding:6px 8px;border:0.5px solid #ccc;background:#f0f4fa">${row.label}</td></tr>`;
    }
    const cells = Array.from({ length: days }, (_, i) => i + 1)
      .map(d => `<td style="text-align:center;font-size:12px;padding:4px 2px;border:0.5px solid #ccc;min-width:24px">${cell(d, row)}</td>`).join("");
    return `<tr><td style="font-size:12px;padding:4px 8px 4px 18px;border:0.5px solid #ccc;white-space:nowrap;color:#555">${row.label}</td>${cells}</tr>`;
  }).join("");

  const synRows = adh.perMed.filter(m => m.prescribed > 0 || m.taken > 0).map(m =>
    `<tr><td style="padding:3px 12px 3px 0;color:#555">${m.name}</td><td>${m.rate !== null ? m.rate + "% d'observance" : "n/a"} — ${m.prescribed} prévue(s), ${m.taken} réelle(s), ${m.missed} oubli(s)${m.extra ? `, ${m.extra} en plus` : ""}</td></tr>`).join("");
  const synHtml = (adh.prescribed > 0 || adh.taken > 0)
    ? `<div style="margin-top:24px"><h3 style="font-size:17px;color:#185FA5;margin-bottom:10px">Observance — ${MONTHS[month]} ${year}</h3><table style="font-size:14px;border-collapse:collapse"><tr><td style="padding:3px 12px 3px 0;color:#555">Observance globale</td><td>${adh.rate !== null ? adh.rate + "%" : "n/a"}</td></tr><tr><td style="padding:3px 12px 3px 0;color:#555">Prises prévues / réelles</td><td>${adh.prescribed} / ${adh.taken}</td></tr><tr><td style="padding:3px 12px 3px 0;color:#555">Oublis / en plus</td><td>${adh.missed} / ${adh.extra}</td></tr>${synRows}</table></div>`
    : "";

  const aiHtml = aiResult ? `<div style="margin-top:28px;page-break-before:always"><h3 style="font-size:18px;color:#185FA5;margin-bottom:12px">Analyse (IA locale)</h3><div style="font-size:14px;line-height:1.7;white-space:pre-wrap">${aiResult}</div></div>` : "";

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SuiviMed ${MONTHS[month]} ${year}</title><style>@page{size:A4 landscape;margin:10mm;}@media print{.np{display:none!important;}}</style></head><body style="font-family:Arial,sans-serif;padding:20px;color:#222"><div style="display:flex;justify-content:space-between;margin-bottom:18px"><div><h1 style="font-size:24px;margin:0 0 4px">SuiviMed</h1><p style="font-size:15px;color:#555;margin:0">${MONTHS[month]} ${year}</p></div><button class="np" onclick="window.print()" style="padding:8px 16px;font-size:14px;cursor:pointer">Imprimer / PDF</button></div><div style="overflow-x:auto"><table style="border-collapse:collapse"><thead><tr style="background:#f0f4fa"><th style="padding:6px 10px;text-align:left;font-size:13px;border:0.5px solid #ccc;min-width:150px">Médicament / moment</th>${Array.from({length:days},(_,i)=>`<th style="text-align:center;font-size:12px;padding:4px 2px;border:0.5px solid #ccc;min-width:24px">${i+1}</th>`).join("")}</tr></thead><tbody>${tableRows}</tbody></table></div><p style="font-size:11px;color:#777;margin-top:6px">✓ = pris · ○ = prévu non pris (oubli)</p>${synHtml}${aiHtml}</body></html>`;
  const w = window.open("", "_blank"); w.document.write(html); w.document.close();
}

// ══════════════════════════════════════════
export default function App() {
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [data,  setData]  = useState({});
  const [settings, setSettings] = useState({ meds: [] });
  const [view,  setView]  = useState("grid");
  const [confirmDel, setConfirmDel] = useState(null);
  const [toast, setToast] = useState("");
  const [aiResult,  setAiResult]  = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError,   setAiError]   = useState("");
  const [aiMonths,  setAiMonths]  = useState("all");
  const [annualYear, setAnnualYear] = useState(today.getFullYear());
  const [dataDir, setDataDir] = useState("");
  const [gsync,    setGsync]    = useState({ connected: false, email: "" });
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg,  setSyncMsg]  = useState("");
  const [saveStatus, setSaveStatus] = useState("saved");
  const saveTimer = useRef(null);
  const pendingSave = useRef(null);
  // Modifications locales pas encore envoyées au Drive (édit depuis le dernier push réussi).
  const dirtyRef = useRef(false);
  // Tirer pour rafraîchir (mobile)
  const [pullDist, setPullDist] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Statut de la dernière planification des rappels, pour avertir dans les réglages
  // (permission notifications refusée, alarmes exactes non autorisées sur Android 14+).
  const [reminderStatus, setReminderStatus] = useState("");
  const replanReminders = useCallback((s) => {
    if (!isCapacitor) return;
    scheduleReminders(s).then(st => setReminderStatus(st || "")).catch(() => {});
  }, []);
  // Ouvre l'écran système « Alarmes et rappels » (Android 12+) puis replanifie.
  const openExactAlarmSettings = useCallback(async () => {
    try {
      const { LocalNotifications: LN } = await import("@capacitor/local-notifications");
      await LN.changeExactNotificationSetting();
    } catch {}
    replanReminders(settingsRef.current);
  }, [replanReminders]);
  // Ouvre l'écran « Notifications plein écran » (Android 14+) puis replanifie.
  const openFullScreen = useCallback(async () => {
    await openFullScreenSettings();
    replanReminders(settingsRef.current);
  }, [replanReminders]);
  // Largeur de fenêtre → grille compacte sur petit écran (mobile).
  const [vw, setVw] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Durée d'affichage de la grille : « day » (jour), « week » (semaine), « month » (mois).
  const [period, setPeriod] = useState("day");
  const [selDay, setSelDay] = useState(today.getDate());
  // Garde le jour sélectionné valide quand on change de mois.
  useEffect(() => { setSelDay(s => Math.min(Math.max(1, s), daysInMonth(year, month))); }, [year, month]);

  // Init
  useEffect(() => {
    (async () => {
      if (syncAvailable) {
        const status = await sync.status().catch(() => ({ connected: false }));
        setGsync(status);
        // Si un autre appareil a modifié le Drive depuis notre dernière synchro,
        // on récupère ces données AVANT de charger l'état local, pour que
        // l'auto-push ne reparte pas avec un cache local périmé.
        if (status.connected) await pullIfRemoteNewer();
      }
      const s = await loadSettings();
      setSettings(s);
      replanReminders(s);
      const d = await loadMonth(year, month);
      setData(d);
      if (isElectron) {
        const dir = await window.electronAPI.getDataDir();
        setDataDir(dir);
      }
    })();
  }, []);

  useEffect(() => {
    loadMonth(year, month).then(setData);
  }, [year, month, refreshTick]);

  // Au retour au premier plan (un nouveau jour a pu commencer), on replanifie
  // la fenêtre de rappels avec les réglages courants.
  useEffect(() => {
    if (!isCapacitor) return;
    let handle;
    CapacitorApp.addListener("resume", () => replanReminders(settingsRef.current))
      .then((h) => { handle = h; })
      .catch(() => {});
    return () => { if (handle) handle.remove(); };
  }, []);

  // Envoi auto vers le Drive après une modification (débounce), si connecté
  const pushTimer = useRef(null);
  useEffect(() => {
    if (!syncAvailable || !gsync.connected) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      sync.push().then(res => { dirtyRef.current = false; return markSynced(res?.remoteModifiedTime); }).catch(()=>{});
    }, 2500);
    return () => { if (pushTimer.current) clearTimeout(pushTimer.current); };
  }, [data, settings, gsync.connected]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 2500); };

  // ── Bouton retour Android
  const backHandlerRef = useRef(() => {});
  const lastBackRef = useRef(0);
  backHandlerRef.current = () => {
    if (confirmDel !== null)  { setConfirmDel(null); return; }
    if (view !== "grid")      { setView("grid");    return; }
    const now = Date.now();
    if (now - lastBackRef.current < 2000) {
      CapacitorApp.exitApp();
    } else {
      lastBackRef.current = now;
      showToast("Appuyez de nouveau pour quitter");
    }
  };

  useEffect(() => {
    if (!isCapacitor) return;
    let handle;
    CapacitorApp.addListener("backButton", () => backHandlerRef.current())
      .then((h) => { handle = h; })
      .catch(() => {});
    return () => { if (handle) handle.remove(); };
  }, []);

  // Écrit immédiatement la sauvegarde de prises en attente (si une édition vient
  // d'avoir lieu et que le debounce de 400 ms n'a pas encore eu lieu) — appelé
  // avant un pull pour ne pas perdre une prise tout juste cochée.
  const flushSave = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const pending = pendingSave.current;
    if (!pending) return;
    pendingSave.current = null;
    try {
      await saveFile(fileKey(pending.y, pending.m), pending.data);
      setSaveStatus("saved");
      // Replanifie APRÈS l'écriture : scheduleReminders relit le stockage, le faire
      // avant (depuis setCell) lui ferait voir l'état d'avant la (dé)coche.
      replanReminders(settingsRef.current);
    } catch {
      setSaveStatus("error");
    }
  }, [replanReminders]);

  const persistData = useCallback((y, m, newData) => {
    setSaveStatus("saving");
    dirtyRef.current = true;
    clearTimeout(saveTimer.current);
    pendingSave.current = { y, m, data: newData };
    saveTimer.current = setTimeout(flushSave, 400);
  }, [flushSave]);

  // Met à jour la prise réelle d'un médicament pour un jour et un moment.
  const setCell = useCallback((day, medIdx, momentKey, val) => {
    setData(prev => {
      const next = { ...prev };
      const dk = `d${day}`, mk = `med_${medIdx}`;
      const dayObj = { ...(next[dk] || {}) };
      const medObj = { ...(dayObj[mk] || {}) };
      if (!val) delete medObj[momentKey]; else medObj[momentKey] = val;
      if (Object.keys(medObj).length) dayObj[mk] = medObj; else delete dayObj[mk];
      if (Object.keys(dayObj).length) next[dk] = dayObj; else delete next[dk];
      persistData(year, month, next);
      return next;
    });
    // La replanification des rappels a lieu dans flushSave, une fois la coche
    // réellement écrite (sinon scheduleReminders relirait l'état périmé).
  }, [year, month, persistData]);

  const days = daysInMonth(year, month);
  const cols = Array.from({ length: days }, (_, i) => i + 1);
  const prevMonth = () => { if (month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1); };
  const nextMonth = () => { if (month===11){setYear(y=>y+1);setMonth(0);}else setMonth(m=>m+1); };
  const isToday = (d) => d===today.getDate()&&year===today.getFullYear()&&month===today.getMonth();

  const handleExportJSON = async () => {
    const allData = await getAllMonthsData();
    const out = { [settingsFile()]: settings };
    allData.forEach(({ year:y, month:m, data:d }) => { out[fileKey(y,m)] = d; });
    const str = JSON.stringify(out, null, 2);
    if (isElectron) {
      const ok = await window.electronAPI.exportJSON(str);
      if (ok) showToast("Exporté");
    } else {
      const b = new Blob([str],{type:"application/json"});
      const a = document.createElement("a"); a.href=URL.createObjectURL(b);
      a.download=`suivimed_export.json`; a.click(); showToast("Exporté");
    }
  };

  const handleImportJSON = async (e) => {
    let str = null;
    if (isElectron) {
      str = await window.electronAPI.importJSON();
    } else {
      const file = e?.target?.files?.[0]; if (!file) return;
      str = await new Promise(res => { const r=new FileReader(); r.onload=ev=>res(ev.target.result); r.readAsText(file); });
      e.target.value = "";
    }
    if (!str) return;
    try {
      const obj = JSON.parse(str);
      for (const [k, v] of Object.entries(obj)) await saveFile(k, v);
      if (obj[settingsFile()]) setSettings(obj[settingsFile()]);
      setData(await loadMonth(year, month));
      showToast("Données importées");
    } catch { showToast("Erreur d'import"); }
  };

  const handleChooseDir = async () => {
    const dir = await window.electronAPI.chooseDataDir();
    if (dir) { setDataDir(dir); showToast("Dossier mis à jour"); }
  };

  // ── Synchronisation Google Drive
  const reloadFromDisk = useCallback(async () => {
    const s = await loadSettings();
    setSettings(s);
    setData(await loadMonth(year, month));
    return s;
  }, [year, month]);

  // Tirer pour rafraîchir (mobile) : récupère les dernières données depuis le Drive
  // si connecté (réglages, rappels, prises modifiés sur un autre appareil), puis
  // recharge tout depuis le stockage local et replanifie les rappels.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Sauvegarde immédiate d'une prise tout juste cochée (le debounce de 400 ms
      // n'a peut-être pas encore eu lieu) pour ne pas la perdre avec le pull ci-dessous.
      await flushSave();
      if (syncAvailable && gsync.connected) {
        if (dirtyRef.current) {
          // Des modifications locales n'ont pas encore été envoyées : on les pousse
          // avant de tirer, sinon le pull les écraserait avec une version plus ancienne.
          if (pushTimer.current) clearTimeout(pushTimer.current);
          const res = await sync.push();
          dirtyRef.current = false;
          await markSynced(res?.remoteModifiedTime);
        } else {
          const res = await sync.pull();
          await markSynced(res?.remoteModifiedTime);
        }
      }
      const s = await reloadFromDisk();
      setRefreshTick(t => t + 1);
      replanReminders(s);
      showToast("Données à jour");
    } catch {
      showToast("Échec de l'actualisation");
    }
    setRefreshing(false);
  }, [gsync.connected, reloadFromDisk, flushSave]);

  // Geste « tirer pour rafraîchir » : actif quand on tire vers le bas en haut de l'écran.
  useEffect(() => {
    if (!isCapacitor) return;
    const THRESHOLD = 70;
    let startY = null;
    const onTouchStart = (e) => {
      startY = (window.scrollY <= 0 && !refreshing) ? e.touches[0].clientY : null;
    };
    const onTouchMove = (e) => {
      if (startY === null) return;
      const dist = e.touches[0].clientY - startY;
      if (dist > 0) setPullDist(Math.min(dist, 120));
    };
    const onTouchEnd = () => {
      if (startY === null) return;
      setPullDist(d => { if (d > THRESHOLD) handleRefresh(); return 0; });
      startY = null;
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [refreshing, handleRefresh]);

  const connectGoogle = async () => {
    setSyncBusy(true); setSyncMsg("Connexion à Google…");
    try {
      setGsync(await sync.signIn());
      setSyncMsg("Récupération des données…");
      const pulled = await sync.pull();
      if (pulled.empty) {
        const res = await sync.push();
        dirtyRef.current = false;
        await markSynced(res?.remoteModifiedTime);
        setSyncMsg("Données envoyées sur ton Drive.");
      } else {
        await markSynced(pulled.remoteModifiedTime);
        await reloadFromDisk();
        setSyncMsg(`Données récupérées depuis ton Drive (${pulled.count} fichier(s)).`);
      }
    } catch (e) { setSyncMsg("Échec : " + (e?.message || e)); }
    setSyncBusy(false);
  };

  const disconnectGoogle = async () => {
    setSyncBusy(true);
    try { setGsync(await sync.signOut()); setSyncMsg(""); }
    catch (e) { setSyncMsg("Échec : " + (e?.message || e)); }
    setSyncBusy(false);
  };

  const syncNow = async () => {
    setSyncBusy(true); setSyncMsg("Synchronisation…");
    try {
      await flushSave();
      const res = await sync.push();
      dirtyRef.current = false;
      await markSynced(res?.remoteModifiedTime);
      setSyncMsg("Synchronisé à l'instant.");
    }
    catch (e) { setSyncMsg("Échec : " + (e?.message || e)); }
    setSyncBusy(false);
  };

  // ── Réglages : profil & médicaments
  const saveSettings = (s) => { dirtyRef.current = true; setSettings(s); saveFile(settingsFile(), s); };
  const updateProfile = (patch) => saveSettings({ ...settings, profile: { ...(settings.profile||{}), ...patch } });
  const updateReminders = (patch) => {
    const r = { enabled:false, mode:"alarm", matin:"08:00", midi:"12:00", soir:"20:00", ...(settings.reminders||{}), ...patch };
    const s = { ...settings, reminders: r };
    saveSettings(s);
    replanReminders(s);
  };
  const addMed = () => saveSettings({ ...settings, meds: [...settings.meds, { name: `Médicament ${settings.meds.length+1}`, note: "", regimens: [{ start: todayStr(), end: null, matin: 1, midi: 0, soir: 0 }] }] });
  const updateMed = (i, patch) => saveSettings({ ...settings, meds: settings.meds.map((m,idx)=> idx===i ? { ...medOf(m), ...patch } : m) });
  const deleteMed = (i) => { saveSettings({ ...settings, meds: settings.meds.filter((_,idx)=>idx!==i) }); setConfirmDel(null); };
  const addRegimen = (i) => { const med = medOf(settings.meds[i]); updateMed(i, { regimens: [...med.regimens, { start: todayStr(), end: null, matin: 0, midi: 0, soir: 0 }] }); };
  const updateRegimen = (i, ri, patch) => { const med = medOf(settings.meds[i]); updateMed(i, { regimens: med.regimens.map((r,idx)=> idx===ri ? { ...r, ...patch } : r) }); };
  const deleteRegimen = (i, ri) => { const med = medOf(settings.meds[i]); updateMed(i, { regimens: med.regimens.filter((_,idx)=>idx!==ri) }); };

  const meds = settings.meds.map(medOf);
  const adh = computeAdherence(data, settings.meds, year, month);
  const hasMonthData = adh.prescribed > 0 || adh.taken > 0;

  // Lignes de la grille : en-tête de médicament + une ligne par moment pertinent.
  const gridRows = [];
  meds.forEach((med, i) => {
    gridRows.push({ type: "head", key: `h${i}`, medIdx: i, name: med.name, note: med.note });
    relevantMoments(med, data, i).forEach(mo => gridRows.push({ type: "moment", key: `m${i}_${mo.key}`, medIdx: i, momentKey: mo.key, label: mo.label, icon: mo.icon }));
  });

  // ── Ollama (analyse IA locale, desktop uniquement)
  const [ollamaStatus, setOllamaStatus] = useState({ binExists: false, modelExists: false, running: false });
  const [ollamaSetupRunning, setOllamaSetupRunning] = useState(false);
  const [ollamaProgress, setOllamaProgress] = useState({ step: "", progress: 0 });

  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.ollamaStatus().then(setOllamaStatus);
    window.electronAPI.onOllamaProgress(p => setOllamaProgress(p));
  }, []);

  const handleOllamaSetup = async () => {
    setOllamaSetupRunning(true);
    try {
      await window.electronAPI.ollamaSetup();
      setOllamaStatus(await window.electronAPI.ollamaStatus());
    } catch (e) { setAiError("Erreur lors de l'installation du moteur IA : " + (e?.message || e)); }
    setOllamaSetupRunning(false);
  };

  const ollamaReady = ollamaStatus.binExists && ollamaStatus.modelExists;

  const stepLabel = {
    "download-ollama": "Téléchargement du moteur IA…",
    "extract-ollama":  "Extraction du moteur IA…",
    "starting":        "Démarrage du moteur IA…",
    "download-model":  "Téléchargement du modèle IA (≈2 Go)…",
    "ready":           "Prêt",
  };

  const launchAI = async () => {
    setAiLoading(true); setAiResult(""); setAiError("");
    try {
      if (!ollamaStatus.running) await window.electronAPI.ollamaStart();
      const allData = await getAllMonthsData();
      const curIdx = year * 12 + month;
      const windowData = aiMonths === "all"
        ? allData
        : allData.filter(({ year: y, month: m }) => { const idx = y * 12 + m; return idx <= curIdx && idx > curIdx - aiMonths; });
      const prompt = buildPrompt(windowData, settings, year, month);
      let text = "";
      if (isElectron) {
        text = await window.electronAPI.ollamaAnalyze(prompt);
      } else {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1200, messages:[{role:"user",content:prompt}] })
        });
        const json = await resp.json();
        text = json.content?.map(b=>b.text||"").join("")||"";
      }
      if (!text) throw new Error();
      setAiResult(text);
    } catch { setAiError("Erreur lors de l'analyse."); }
    setAiLoading(false);
  };

  // ── Annuel
  const [annualData, setAnnualData] = useState([]);
  useEffect(() => {
    Promise.all(Array.from({length:12},(_,m)=>loadMonth(annualYear,m))).then(results => {
      setAnnualData(results.map((d,m) => {
        const a = computeAdherence(d, settings.meds, annualYear, m);
        return { month:m, rate:a.rate, prescribed:a.prescribed, taken:a.taken, missed:a.missed, extra:a.extra };
      }));
    });
  }, [annualYear, settings.meds, refreshTick]);

  const annualMonths = annualData.filter(m => m.prescribed > 0 || m.taken > 0);
  const annualAvgRate = annualMonths.filter(m=>m.rate!=null).length
    ? Math.round(annualMonths.filter(m=>m.rate!=null).reduce((s,m)=>s+m.rate,0)/annualMonths.filter(m=>m.rate!=null).length)
    : null;
  const annualMissed = annualData.reduce((s,m)=>s+m.missed,0);

  const compact = vw < 600;            // mobile / petit écran
  const LABEL_W = compact ? 104 : 190;
  const CELL    = period === "week" ? (compact ? 40 : 48) : (compact ? 26 : 34);

  // Plage de jours visible selon la durée d'affichage choisie.
  const maxWeek = Math.max(0, Math.ceil(days / 7) - 1);
  const weekIdx = Math.min(maxWeek, Math.floor((selDay - 1) / 7));
  const visDays =
    period === "day"  ? [Math.min(Math.max(1, selDay), days)]
    : period === "week" ? Array.from({ length: Math.min(7, days - weekIdx * 7) }, (_, k) => weekIdx * 7 + 1 + k)
    : cols;

  const prevPeriod = () => {
    if (period === "month") return prevMonth();
    if (period === "day") {
      if (selDay > 1) return setSelDay(selDay - 1);
      const pm = month === 0 ? 11 : month - 1, py = month === 0 ? year - 1 : year;
      setYear(py); setMonth(pm); setSelDay(daysInMonth(py, pm));
    } else {
      if (weekIdx > 0) return setSelDay((weekIdx - 1) * 7 + 1);
      const pm = month === 0 ? 11 : month - 1, py = month === 0 ? year - 1 : year;
      const pd = daysInMonth(py, pm);
      setYear(py); setMonth(pm); setSelDay((Math.ceil(pd / 7) - 1) * 7 + 1);
    }
  };
  const nextPeriod = () => {
    if (period === "month") return nextMonth();
    if (period === "day") {
      if (selDay < days) return setSelDay(selDay + 1);
      const nm = month === 11 ? 0 : month + 1, ny = month === 11 ? year + 1 : year;
      setYear(ny); setMonth(nm); setSelDay(1);
    } else {
      if (weekIdx < maxWeek) return setSelDay((weekIdx + 1) * 7 + 1);
      const nm = month === 11 ? 0 : month + 1, ny = month === 11 ? year + 1 : year;
      setYear(ny); setMonth(nm); setSelDay(1);
    }
  };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth()); setSelDay(today.getDate()); };
  const rangeLabel =
    period === "day"  ? `${WEEKDAYS[new Date(year, month, visDays[0]).getDay()]} ${visDays[0]} ${MONTHS[month]} ${year}`
    : period === "week" ? `${visDays[0]}–${visDays[visDays.length - 1]} ${MONTHS_SHORT[month]} ${year}`
    : `${MONTHS[month]} ${year}`;

  const tabs = [
    {id:"grid",      icon:"ti-table",          label:"Grille"},
    {id:"observance",icon:"ti-chart-bar",      label:"Observance"},
    {id:"annual",    icon:"ti-calendar-stats", label:"Annuel"},
    ...(isElectron ? [{id:"ai", icon:"ti-brain", label:"Analyse IA"}] : []),
    {id:"settings",  icon:"ti-settings",       label:"Paramètres"},
  ];

  return (
    <div style={{fontSize:13,color:"var(--color-text-primary)"}}>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
        <span style={{fontSize:18,fontWeight:500,flex:1}}>SuiviMed</span>

        <span style={{fontSize:11,color:saveStatus==="error"?"var(--color-text-danger)":"var(--color-text-tertiary)",display:"flex",alignItems:"center",gap:4}}>
          {saveStatus==="saving" && <><i className="ti ti-loader-2" style={{fontSize:12}} aria-hidden="true"></i> Sauvegarde…</>}
          {saveStatus==="saved"  && <><i className="ti ti-check"    style={{fontSize:12}} aria-hidden="true"></i> Sauvegardé</>}
          {saveStatus==="error"  && <><i className="ti ti-alert-circle" style={{fontSize:12}} aria-hidden="true"></i> Erreur</>}
        </span>

        {isElectron
          ? <button onClick={handleImportJSON} style={{display:"flex",alignItems:"center",gap:5,fontSize:12}}><i className="ti ti-upload" aria-hidden="true"></i> Importer</button>
          : <label style={{cursor:"pointer",display:"inline-flex",alignItems:"center",gap:5,border:"0.5px solid var(--color-border-secondary)",borderRadius:"var(--border-radius-md)",padding:"5px 10px",fontSize:12}}>
              <i className="ti ti-upload" aria-hidden="true"></i> Importer
              <input type="file" accept=".json" onChange={handleImportJSON} style={{display:"none"}}/>
            </label>
        }
        <button onClick={handleExportJSON} style={{display:"flex",alignItems:"center",gap:5,fontSize:12}}><i className="ti ti-download" aria-hidden="true"></i> Exporter</button>
        <button onClick={()=>exportPDF(year,month,data,settings,aiResult)} style={{display:"flex",alignItems:"center",gap:5,fontSize:12}}><i className="ti ti-file-type-pdf" aria-hidden="true"></i> PDF</button>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",marginBottom:16,borderBottom:"0.5px solid var(--color-border-tertiary)",overflowX:"auto"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setView(t.id)} style={{
            display:"flex",alignItems:"center",gap:5,padding:"8px 12px",fontSize:12,whiteSpace:"nowrap",
            border:"none",borderBottom:view===t.id?"2px solid var(--color-text-info)":"2px solid transparent",
            borderRadius:0,background:"transparent",
            color:view===t.id?"var(--color-text-info)":"var(--color-text-secondary)",
            fontWeight:view===t.id?500:400,cursor:"pointer"
          }}>
            <i className={`ti ${t.icon}`} aria-hidden="true"></i>{t.label}
          </button>
        ))}
      </div>

      {/* Month nav (observance) */}
      {view==="observance"&&(
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
          <button onClick={prevMonth}><i className="ti ti-arrow-left" aria-hidden="true"></i></button>
          <span style={{fontWeight:500,minWidth:140,textAlign:"center"}}>{MONTHS[month]} {year}</span>
          <button onClick={nextMonth}><i className="ti ti-arrow-right" aria-hidden="true"></i></button>
        </div>
      )}

      {/* GRID */}
      {view==="grid"&&(
        <>
          {/* Durée d'affichage + navigation */}
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
            <div style={{display:"inline-flex",background:"var(--color-background-secondary)",borderRadius:999,padding:3,gap:2}}>
              {[["day","Jour"],["week","Semaine"],["month","Mois"]].map(([p,L])=>(
                <button key={p} onClick={()=>setPeriod(p)} style={{padding:"5px 14px",fontSize:12,borderRadius:999,border:"none",cursor:"pointer",background:period===p?"var(--color-background-primary)":"transparent",color:period===p?"var(--color-text-info)":"var(--color-text-secondary)",fontWeight:period===p?600:400,boxShadow:period===p?"0 1px 2px rgba(0,0,0,0.08)":"none"}}>{L}</button>
              ))}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,flex:1,justifyContent:"center"}}>
              <button onClick={prevPeriod} aria-label="Précédent"><i className="ti ti-chevron-left" aria-hidden="true"></i></button>
              <span style={{fontWeight:500,minWidth:compact?120:170,textAlign:"center",textTransform:"capitalize",fontSize:13}}>{rangeLabel}</span>
              <button onClick={nextPeriod} aria-label="Suivant"><i className="ti ti-chevron-right" aria-hidden="true"></i></button>
            </div>
            <button onClick={goToday} style={{fontSize:12,padding:"5px 10px",display:"flex",alignItems:"center",gap:5}}><i className="ti ti-calendar-event" aria-hidden="true"></i> Aujourd'hui</button>
          </div>

          {meds.length === 0 && (
            <p style={{color:"var(--color-text-secondary)",textAlign:"center",margin:"24px 0"}}>
              Ajoute ton premier médicament ci-dessous pour commencer le suivi.
            </p>
          )}
          {meds.length > 0 && period === "day" && (
            <DayView meds={meds} data={data} year={year} month={month} day={visDays[0]} onToggle={setCell} />
          )}
          {meds.length > 0 && period !== "day" && (<>
          <div style={{overflowX:"auto",borderRadius:"var(--border-radius-lg)",border:"0.5px solid var(--color-border-tertiary)",width:"fit-content",maxWidth:"100%",margin:"0 auto"}}>
            <table style={{borderCollapse:"collapse",tableLayout:"fixed",width:LABEL_W+visDays.length*CELL+"px"}}>
              <thead>
                <tr style={{background:"var(--color-background-secondary)"}}>
                  <th style={{width:LABEL_W,padding:compact?"6px 6px":"6px 10px",textAlign:"left",fontWeight:500,borderRight:"0.5px solid var(--color-border-tertiary)",position:"sticky",left:0,background:"var(--color-background-secondary)",zIndex:2,fontSize:compact?11:12}}>{compact?"Méd. / moment":"Médicament / moment"}</th>
                  {visDays.map(d=>(
                    <th key={d} style={{width:CELL,textAlign:"center",fontWeight:isToday(d)?600:400,fontSize:11,padding:"6px 0",color:isToday(d)?"var(--color-text-info)":"var(--color-text-secondary)",borderLeft:"0.5px solid var(--color-border-tertiary)"}}>
                      {period==="week"
                        ? <><div style={{fontSize:10,opacity:0.7}}>{WEEKDAYS_MINI[new Date(year,month,d).getDay()]}</div><div>{d}</div></>
                        : d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gridRows.map((row)=> row.type==="head" ? (
                  <tr key={row.key} style={{background:"var(--color-background-secondary)"}}>
                    <td style={{padding:compact?"5px 6px":"5px 10px",borderRight:"0.5px solid var(--color-border-tertiary)",position:"sticky",left:0,background:"var(--color-background-secondary)",zIndex:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:LABEL_W,fontSize:compact?11:12,fontWeight:600}}>
                      <i className="ti ti-pill" style={{fontSize:12,marginRight:5,color:"var(--color-text-info)"}} aria-hidden="true"></i>
                      {row.name}{row.note && <span style={{fontWeight:400,color:"var(--color-text-tertiary)"}}> · {row.note}</span>}
                    </td>
                    {visDays.map(d=><td key={d} style={{borderLeft:"0.5px solid var(--color-border-tertiary)",background:"var(--color-background-secondary)"}} />)}
                  </tr>
                ) : (
                  <tr key={row.key}>
                    <td style={{padding:compact?"3px 4px 3px 10px":"3px 10px 3px 24px",borderRight:"0.5px solid var(--color-border-tertiary)",position:"sticky",left:0,background:"var(--color-background-primary)",zIndex:1,whiteSpace:"nowrap",fontSize:compact?11:12,color:"var(--color-text-secondary)"}}>
                      <i className={`ti ${row.icon}`} style={{fontSize:12,marginRight:5}} aria-hidden="true"></i>{row.label}
                    </td>
                    {visDays.map(d=>{
                      const ds = dateStr(year,month,d);
                      const med = meds[row.medIdx];
                      const P = prescribedDose(med, ds, row.momentKey);
                      const T = takenDose(data[`d${d}`], row.medIdx, row.momentKey);
                      return(
                        <td key={d} style={{textAlign:"center",padding:"2px 1px",borderLeft:"0.5px solid var(--color-border-tertiary)"}}>
                          <MomentCell P={P} T={T} onChange={v=>setCell(d,row.medIdx,row.momentKey,v)} cell={CELL}/>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{color:"var(--color-text-secondary)",fontSize:11,marginTop:8}}>
            <strong style={{color:"var(--color-text-success)"}}>✓</strong> = pris · <strong style={{color:"var(--color-text-danger)"}}>○</strong> = prévu non pris (oubli) · <strong style={{color:"var(--color-text-warning)"}}>✓</strong> orange = pris hors prescription · clic pour cocher / décocher. La case bleutée indique une prise prévue par la posologie.
          </div>
          </>)}

          {/* Médicaments & posologie (déplacé sous la grille) */}
          <div style={{borderTop:"0.5px solid var(--color-border-tertiary)",margin:"20px 0 14px"}}></div>
          <MedsPosology
            meds={settings.meds}
            updateMed={updateMed} addMed={addMed} setConfirmDel={setConfirmDel}
            addRegimen={addRegimen} updateRegimen={updateRegimen} deleteRegimen={deleteRegimen}
            confirmDel={confirmDel} deleteMed={deleteMed}
          />
        </>
      )}

      {/* OBSERVANCE */}
      {view==="observance"&&(
        <div>
          {!hasMonthData
            ?<p style={{color:"var(--color-text-secondary)",textAlign:"center",marginTop:32}}>Aucune prise prévue ou enregistrée ce mois.</p>
            :<>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:12,marginBottom:20}}>
                <MetricCard label="Observance" value={adh.rate!=null?adh.rate:"—"} unit={adh.rate!=null?"%":""} icon="ti-circle-check" color={rateColor(adh.rate)}/>
                <MetricCard label="Prises dues"        value={adh.prescribed} unit="" icon="ti-clipboard-list"/>
                <MetricCard label="Faites"             value={adh.taken}      unit="" icon="ti-pill"/>
                <MetricCard label="Oublis"             value={adh.missed}     unit="" icon="ti-alert-triangle"/>
                {adh.extra>0 && <MetricCard label="Hors prescription" value={adh.extra} unit="" icon="ti-arrow-up-circle"/>}
              </div>

              {(() => {
                const moms = MOMENTS.map(mo => ({ mo, b: adh.byMoment[mo.key] })).filter(x => x.b.due > 0);
                if (!moms.length) return null;
                const worst = worstMoment(adh.byMoment);
                return (
                  <>
                    <p style={{fontWeight:500,marginBottom:10,fontSize:13}}>Par moment de la journée</p>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:8,marginBottom:8}}>
                      {moms.map(({mo,b}) => {
                        const r = Math.round(b.taken/b.due*100);
                        const isWorst = worst && worst.key===mo.key;
                        return (
                          <div key={mo.key} style={{padding:"10px 12px",borderRadius:"var(--border-radius-md)",background:"var(--color-background-secondary)",border:isWorst?"1px solid var(--color-border-warning)":"0.5px solid var(--color-border-tertiary)"}}>
                            <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--color-text-secondary)",marginBottom:6}}>
                              <i className={`ti ${mo.icon}`} aria-hidden="true"></i>{mo.label}
                            </div>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <span style={{fontSize:18,fontWeight:600}}>{r}%</span>
                              <span style={{width:11,height:11,borderRadius:3,background:rateColor(r),display:"inline-block"}}></span>
                            </div>
                            <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:4}}>{b.missed} oubli(s) / {b.due} dus</div>
                          </div>
                        );
                      })}
                    </div>
                    {worst && (
                      <p style={{fontSize:12,color:"var(--color-text-warning)",marginBottom:18,display:"flex",alignItems:"center",gap:6}}>
                        <i className="ti ti-alert-triangle" aria-hidden="true"></i>
                        Moment le plus oublié : <strong>&nbsp;{worst.label.toLowerCase()}</strong>&nbsp;({worst.missed} oubli{worst.missed>1?"s":""}).
                      </p>
                    )}
                  </>
                );
              })()}

              <p style={{fontWeight:500,marginBottom:10,fontSize:13}}>Par médicament</p>
              <div style={{display:"grid",gap:8}}>
                {adh.perMed.filter(m=>m.prescribed>0||m.taken>0).map((m,i)=>{
                  const w = worstMoment(m.byMoment);
                  return (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",flexWrap:"wrap"}}>
                      <span style={{fontWeight:500,flex:"1 1 140px"}}>{m.name}</span>
                      <span style={{fontSize:13,fontWeight:600,color:"#222",padding:"2px 10px",borderRadius:999,background:rateColor(m.rate)}}>{m.rate!=null?m.rate+"%":"n/a"}</span>
                      <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>{m.taken}/{m.prescribed} faites · {m.missed} oubli(s){m.extra?` · ${m.extra} hors prescr.`:""}{w?` · surtout le ${w.label.toLowerCase()}`:""}</span>
                    </div>
                  );
                })}
              </div>
            </>
          }
        </div>
      )}

      {/* ANNUAL */}
      {view==="annual"&&(
        <div>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
            <button onClick={()=>setAnnualYear(y=>y-1)}><i className="ti ti-arrow-left" aria-hidden="true"></i></button>
            <span style={{fontWeight:500,minWidth:60,textAlign:"center"}}>{annualYear}</span>
            <button onClick={()=>setAnnualYear(y=>y+1)}><i className="ti ti-arrow-right" aria-hidden="true"></i></button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:24}}>
            <MetricCard label="Observance moy." value={annualAvgRate!=null?annualAvgRate:"—"} unit={annualAvgRate!=null?"%":""} icon="ti-circle-check" color={rateColor(annualAvgRate)}/>
            <MetricCard label="Mois suivis" value={annualMonths.length} unit="/12" icon="ti-calendar"/>
            <MetricCard label="Oublis (année)" value={annualMissed} unit="" icon="ti-alert-triangle"/>
          </div>

          <p style={{fontWeight:500,marginBottom:12,fontSize:13}}>Observance par mois</p>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(90px,1fr))",gap:8,marginBottom:28}}>
            {annualData.map(({month:m,rate,prescribed,taken})=>{
              const isCur=m===month&&annualYear===year;
              const hasData = prescribed>0||taken>0;
              return(
                <button key={m} onClick={()=>{setYear(annualYear);setMonth(m);setView("grid");}} style={{
                  padding:"12px 8px",textAlign:"center",borderRadius:"var(--border-radius-md)",
                  border:isCur?"2px solid var(--color-border-info)":"0.5px solid var(--color-border-tertiary)",
                  background:hasData?rateColor(rate):"var(--color-background-secondary)",cursor:"pointer"
                }}>
                  <div style={{fontSize:11,color:hasData?"#222":"var(--color-text-secondary)",marginBottom:4,fontWeight:500}}>{MONTHS_SHORT[m]}</div>
                  <div style={{fontSize:20,fontWeight:500,color:hasData?"#222":"var(--color-text-tertiary)"}}>{hasData&&rate!=null?rate+"%":"–"}</div>
                </button>
              );
            })}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <span style={{fontSize:11,color:"var(--color-text-secondary)"}}>Observance :</span>
            {[["≥90%","#c0dd97"],["75–89%","#FAC775"],["50–74%","#F0997B"],["<50%","#E24B4A"]].map(([l,c])=>(
              <span key={l} style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--color-text-secondary)"}}>
                <span style={{width:12,height:12,borderRadius:2,background:c,display:"inline-block"}}></span>{l}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* AI */}
      {view==="ai"&&(
        <div>
          {isElectron && !ollamaReady && (
            <div style={{background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem",marginBottom:16}}>
              <p style={{fontWeight:500,marginBottom:4}}>Moteur IA local non installé</p>
              <p style={{color:"var(--color-text-secondary)",fontSize:12,marginBottom:12,lineHeight:1.6}}>
                L'analyse utilise un modèle d'IA qui s'exécute entièrement sur votre machine. Aucune donnée ne quitte votre ordinateur.<br/>
                <strong>Première installation : moteur + modèle (~2 Go) à télécharger.</strong> Cette opération est unique.
              </p>
              {ollamaSetupRunning ? (
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,fontSize:13}}>
                    <i className="ti ti-loader-2" style={{fontSize:16}} aria-hidden="true"></i>
                    {stepLabel[ollamaProgress.step] || "Initialisation…"}
                  </div>
                  {ollamaProgress.progress > 0 && (
                    <div style={{background:"var(--color-border-tertiary)",borderRadius:4,height:6,width:"100%"}}>
                      <div style={{background:"var(--color-text-info)",borderRadius:4,height:6,width:`${ollamaProgress.progress}%`,transition:"width 0.3s"}}/>
                    </div>
                  )}
                </div>
              ) : (
                <button onClick={handleOllamaSetup} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 16px"}}>
                  <i className="ti ti-download" style={{fontSize:16}} aria-hidden="true"></i> Installer le moteur IA
                </button>
              )}
            </div>
          )}

          {(!isElectron || ollamaReady) && (
            <div style={{background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem",marginBottom:16}}>
              <p style={{fontWeight:500,marginBottom:4}}>Analyse observance {isElectron ? "(IA locale)" : "(Claude)"}</p>
              <p style={{color:"var(--color-text-secondary)",fontSize:12,marginBottom:12,lineHeight:1.6}}>
                Compare vos prises réelles à la posologie prescrite : observance, oublis, surconsommation, cohérence de la posologie, interactions, et pistes à discuter avec votre médecin. Destiné à être relu par un professionnel de santé.
              </p>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <label style={{fontSize:12,color:"var(--color-text-secondary)",display:"flex",alignItems:"center",gap:6}}>
                  Historique
                  <select value={aiMonths} onChange={e=>setAiMonths(e.target.value==="all"?"all":Number(e.target.value))} style={{fontSize:12}}>
                    <option value={1}>Mois courant</option>
                    <option value={3}>3 derniers mois</option>
                    <option value={6}>6 derniers mois</option>
                    <option value={12}>12 derniers mois</option>
                    <option value="all">Tout l'historique</option>
                  </select>
                </label>
                <button onClick={launchAI} disabled={aiLoading} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 16px"}}>
                  {aiLoading?<><i className="ti ti-loader-2" style={{fontSize:16}} aria-hidden="true"></i> Analyse en cours…</>:<><i className="ti ti-brain" style={{fontSize:16}} aria-hidden="true"></i> Lancer l'analyse</>}
                </button>
              </div>
            </div>
          )}

          <div style={{background:"var(--color-background-warning)",border:"0.5px solid var(--color-border-warning)",borderRadius:"var(--border-radius-md)",padding:"10px 14px",color:"var(--color-text-warning)",fontSize:12,marginBottom:12,lineHeight:1.6}}>
            <i className="ti ti-alert-triangle" aria-hidden="true"></i> Cette analyse est une aide à la décision destinée à votre médecin ou pharmacien. Ce n'est <strong>pas une prescription</strong> : ne modifiez jamais un traitement sans avis médical.
          </div>

          {aiError&&<div style={{background:"var(--color-background-danger)",border:"0.5px solid var(--color-border-danger)",borderRadius:"var(--border-radius-md)",padding:"12px 16px",color:"var(--color-text-danger)",fontSize:13,marginBottom:12}}>{aiError}</div>}
          {aiResult&&(
            <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,gap:8,flexWrap:"wrap"}}>
                <span style={{fontWeight:500,fontSize:14}}>Résultat</span>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{navigator.clipboard?.writeText(aiResult);showToast("Copié");}} style={{display:"flex",alignItems:"center",gap:6,fontSize:12}}><i className="ti ti-copy" aria-hidden="true"></i> Copier</button>
                  <button onClick={()=>exportPDF(year,month,data,settings,aiResult)} style={{display:"flex",alignItems:"center",gap:6,fontSize:12}}><i className="ti ti-file-type-pdf" aria-hidden="true"></i> PDF</button>
                </div>
              </div>
              <div style={{fontSize:13,lineHeight:1.8,whiteSpace:"pre-wrap",color:"var(--color-text-primary)"}}>{aiResult}</div>
            </div>
          )}
        </div>
      )}

      {/* SETTINGS */}
      {view==="settings"&&(
        <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem"}}>
          {syncAvailable && (
            <>
              <p style={{fontWeight:500,marginBottom:4,fontSize:14}}>Synchronisation</p>
              <p style={{color:"var(--color-text-secondary)",fontSize:11,marginBottom:12,lineHeight:1.6}}>
                Connecte ton compte Google pour retrouver tes données sur tous tes appareils. Elles sont rangées dans <strong>ton</strong> Drive privé — rien n'est hébergé ailleurs.
              </p>
              {gsync.connected ? (
                <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <span style={{fontSize:12,fontWeight:500,display:"flex",alignItems:"center",gap:6,padding:"4px 11px",borderRadius:999,background:"rgba(59,109,17,0.10)",color:"var(--color-text-success)"}}>
                    <span style={{width:7,height:7,borderRadius:"50%",background:"var(--color-text-success)"}}></span>
                    {gsync.email || "Connecté"}
                  </span>
                  <button onClick={syncNow} disabled={syncBusy} style={{fontSize:12,padding:"6px 12px",display:"flex",alignItems:"center",gap:6}}>
                    <i className="ti ti-refresh" aria-hidden="true"></i> Synchroniser
                  </button>
                  <button onClick={disconnectGoogle} disabled={syncBusy} style={{fontSize:12,padding:"6px 12px",color:"var(--color-text-danger)"}}>Se déconnecter</button>
                </div>
              ) : (
                <button onClick={connectGoogle} disabled={syncBusy} style={{fontSize:13,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                  {syncBusy?<><i className="ti ti-loader-2" aria-hidden="true"></i> Connexion…</>:<><i className="ti ti-brand-google" aria-hidden="true"></i> Se connecter avec Google</>}
                </button>
              )}
              {syncMsg && <p style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:8,display:"flex",alignItems:"center",gap:6}}>{syncBusy&&<i className="ti ti-loader-2" aria-hidden="true"></i>}{syncMsg}</p>}
              <div style={{borderTop:"0.5px solid var(--color-border-tertiary)",margin:"16px 0"}}></div>
            </>
          )}

          <p style={{fontWeight:500,marginBottom:4,fontSize:14}}>Profil patient</p>
          <p style={{color:"var(--color-text-secondary)",fontSize:11,marginBottom:12,lineHeight:1.6}}>
            Ces informations affinent l'analyse IA (interactions, adaptation des doses au profil).
          </p>
          <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:10}}>
            <label style={{fontSize:12,color:"var(--color-text-secondary)",display:"flex",flexDirection:"column",gap:4}}>
              Sexe
              <select value={settings.profile?.sex ?? ""} onChange={e=>updateProfile({sex:e.target.value})} style={{fontSize:13}}>
                <option value="">Non précisé</option>
                <option value="F">Femme</option>
                <option value="M">Homme</option>
              </select>
            </label>
            <label style={{fontSize:12,color:"var(--color-text-secondary)",display:"flex",flexDirection:"column",gap:4}}>
              Année de naissance
              <input type="number" min="1900" max={today.getFullYear()} value={settings.profile?.birthYear ?? ""} onChange={e=>updateProfile({birthYear: e.target.value===""?"":Number(e.target.value)})} placeholder="ex. 1985" style={{width:120}}/>
            </label>
            <label style={{fontSize:12,color:"var(--color-text-secondary)",display:"flex",flexDirection:"column",gap:4}}>
              Poids (kg)
              <input type="number" min="0" max="400" value={settings.profile?.weight ?? ""} onChange={e=>updateProfile({weight: e.target.value===""?"":Number(e.target.value)})} placeholder="ex. 70" style={{width:100}}/>
            </label>
          </div>
          <label style={{fontSize:12,color:"var(--color-text-secondary)",display:"block",marginBottom:10}}>
            Antécédents / maladies chroniques
            <textarea value={settings.profile?.conditions ?? ""} onChange={e=>updateProfile({conditions:e.target.value})} placeholder="ex. HTA, diabète, insuffisance rénale, allergie pénicilline…" rows={2} style={{width:"100%",marginTop:4,resize:"vertical"}}/>
          </label>
          <label style={{fontSize:12,color:"var(--color-text-secondary)",display:"block",marginBottom:4}}>
            Traitement de fond / autres médicaments
            <textarea value={settings.profile?.treatments ?? ""} onChange={e=>updateProfile({treatments:e.target.value})} placeholder="ex. anticoagulant, contraception, antidépresseur…" rows={2} style={{width:"100%",marginTop:4,resize:"vertical"}}/>
          </label>
          {isCapacitor && (<>
            <div style={{borderTop:"0.5px solid var(--color-border-tertiary)",margin:"16px 0"}}></div>
            <p style={{fontWeight:500,marginBottom:4,fontSize:14}}>Rappels de prise</p>
            <p style={{color:"var(--color-text-secondary)",fontSize:11,marginBottom:12,lineHeight:1.6}}>
              Déclenche une vraie alarme (son fort de ~30 s + vibration, sur le volume d'alarme — sonne même en mode silencieux ou Ne pas déranger) chaque jour aux heures choisies pour penser à tes prises (mobile uniquement).
            </p>
            <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,marginBottom:10,cursor:"pointer"}}>
              <input type="checkbox" checked={!!settings.reminders?.enabled} onChange={e=>updateReminders({enabled:e.target.checked})}/>
              Activer les rappels quotidiens
            </label>
            {settings.reminders?.enabled && (
              <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
                {[["matin","Matin"],["midi","Midi"],["soir","Soir"]].map(([k,L])=>(
                  <label key={k} style={{fontSize:12,color:"var(--color-text-secondary)",display:"flex",flexDirection:"column",gap:4}}>
                    {L}
                    <input type="time" value={settings.reminders?.[k] || ""} onChange={e=>updateReminders({[k]:e.target.value})} style={{fontSize:13}}/>
                  </label>
                ))}
              </div>
            )}
            {settings.reminders?.enabled && (
              <div style={{marginTop:14}}>
                <p style={{fontWeight:500,fontSize:12,marginBottom:6}}>Type de rappel</p>
                <label style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:12,marginBottom:8,cursor:"pointer"}}>
                  <input type="radio" name="reminderMode" style={{marginTop:2}}
                    checked={(settings.reminders?.mode ?? "alarm") === "alarm"}
                    onChange={()=>updateReminders({mode:"alarm"})}/>
                  <span><strong>Alarme + notification</strong> — réveille l'écran, son fort de 30 s qui resonne toutes les 5 min jusqu'à ce que tu coches la prise (avec bouton d'arrêt).</span>
                </label>
                <label style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:12,cursor:"pointer"}}>
                  <input type="radio" name="reminderMode" style={{marginTop:2}}
                    checked={settings.reminders?.mode === "push"}
                    onChange={()=>updateReminders({mode:"push"})}/>
                  <span><strong>Notification uniquement</strong> — simple notification sonore, sans réveil d'écran.</span>
                </label>
              </div>
            )}
            {settings.reminders?.enabled && reminderStatus === "no-fullscreen" && (
              <div style={{marginTop:10}}>
                <p style={{color:"var(--color-text-danger, #dc2626)",fontSize:12,marginBottom:6,lineHeight:1.5}}>
                  ⚠️ L'alarme ne peut pas réveiller l'écran : Android bloque les notifications plein écran pour cette app.
                </p>
                <button onClick={openFullScreen} style={{fontSize:12}}>
                  Autoriser le plein écran
                </button>
              </div>
            )}
            {settings.reminders?.enabled && reminderStatus === "no-permission" && (
              <p style={{color:"var(--color-text-danger, #dc2626)",fontSize:12,marginTop:10,lineHeight:1.5}}>
                ⚠️ Les notifications sont bloquées par Android : aucun rappel ne peut sonner.
                Autorise-les dans Réglages Android → Applications → SuiviMed → Notifications.
              </p>
            )}
            {settings.reminders?.enabled && reminderStatus === "inexact" && (
              <div style={{marginTop:10}}>
                <p style={{color:"var(--color-text-danger, #dc2626)",fontSize:12,marginBottom:6,lineHeight:1.5}}>
                  ⚠️ Android n'autorise pas les alarmes exactes : les rappels peuvent arriver
                  en retard (voire très en retard quand le téléphone est en veille).
                </p>
                <button onClick={openExactAlarmSettings} style={{fontSize:12}}>
                  Autoriser les alarmes exactes
                </button>
              </div>
            )}
          </>)}

          {isElectron&&(
            <div style={{marginTop:24,paddingTop:16,borderTop:"0.5px solid var(--color-border-tertiary)"}}>
              <p style={{fontWeight:500,marginBottom:8,fontSize:14}}>Dossier de sauvegarde</p>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <code style={{fontSize:11,background:"var(--color-background-secondary)",padding:"4px 8px",borderRadius:"var(--border-radius-md)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{dataDir}</code>
                <button onClick={handleChooseDir} style={{display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap"}}>
                  <i className="ti ti-folder-open" aria-hidden="true"></i> Changer
                </button>
              </div>
              <p style={{color:"var(--color-text-secondary)",fontSize:11,marginTop:8,lineHeight:1.6}}>
                Les données sont sauvegardées automatiquement à chaque saisie dans ce dossier sous forme de fichiers JSON.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Indicateur « tirer pour rafraîchir » (mobile) */}
      {isCapacitor && (pullDist>0 || refreshing) && (
        <div style={{
          position:"fixed",top:0,left:0,right:0,zIndex:999,display:"flex",justifyContent:"center",
          pointerEvents:"none",
          transform:`translateY(${refreshing ? 10 : Math.min(pullDist,70) - 60}px)`,
          transition: refreshing ? "transform 0.2s" : "none"
        }}>
          <div style={{
            display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--color-text-info)",
            background:"var(--color-background-info)",borderRadius:999,padding:"6px 14px",
            boxShadow:"0 2px 6px rgba(0,0,0,0.15)"
          }}>
            <i className={`ti ${refreshing ? "ti-loader-2" : "ti-arrow-down"}`} aria-hidden="true"
               style={{fontSize:14, transform: (!refreshing && pullDist>70) ? "rotate(180deg)" : "none", transition:"transform 0.2s"}}></i>
            {refreshing ? "Actualisation…" : pullDist>70 ? "Relâchez pour actualiser" : "Tirez pour actualiser"}
          </div>
        </div>
      )}

      {toast&&(
        <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:"var(--border-radius-md)",padding:"10px 20px",fontWeight:500,fontSize:13,zIndex:300}}>
          {toast}
        </div>
      )}
    </div>
  );
}

function MetricCard({label,value,unit,icon,color}){
  return(
    <div style={{background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",padding:"12px 14px"}}>
      <div style={{display:"flex",alignItems:"center",gap:6,color:"var(--color-text-secondary)",fontSize:11,marginBottom:6}}>
        <i className={`ti ${icon}`} style={{fontSize:13}} aria-hidden="true"></i>{label}
      </div>
      <div style={{fontSize:20,fontWeight:500,display:"flex",alignItems:"center",gap:8}}>
        <span>{value}<span style={{fontSize:12,fontWeight:400,color:"var(--color-text-secondary)",marginLeft:3}}>{unit}</span></span>
        {color&&value!=="—"&&<span style={{width:12,height:12,borderRadius:3,background:color,display:"inline-block"}}></span>}
      </div>
    </div>
  );
}

// Cellule d'une prise : la grille n'enregistre QUE « pris / pas pris » (binaire).
// Clic = bascule pris ↔ non pris. La quantité (½, 2…) vit dans la posologie, pas ici.
function MomentCell({P,T,onChange,cell=34}){
  const taken = T>0, prevu = P>0;
  let glyph, col;
  if (taken) {
    glyph = "✓";
    col = prevu ? "var(--color-text-success)" : "var(--color-text-warning)"; // pris hors prescription = orange
  } else {
    glyph = prevu ? "○" : "–";
    col = prevu ? "var(--color-text-danger)" : "var(--color-text-tertiary)";
  }
  const bg = prevu ? "rgba(55,138,221,0.07)" : "transparent";
  const title = `${prevu ? `Prévu : ${fmtDose(P)}` : "Non prévu"} · ${taken ? "pris" : "non pris"}`
    + (!taken && prevu ? " — oubli" : "")
    + (taken && !prevu ? " — pris hors prescription" : "");
  return(
    <button onClick={()=>onChange(taken ? 0 : 1)} title={title} aria-label="Prise de médicament"
      style={{width:cell-4,height:26,border:"none",background:bg,borderRadius:4,cursor:"pointer",color:col,fontWeight:700,fontSize:14,padding:0,lineHeight:1}}>
      {glyph}
    </button>
  );
}

// Vue « Jour » : regroupée PAR MOMENT (matin/midi/soir). Chaque section liste les
// médicaments à prendre à ce moment, en cases à cocher pleine largeur (mobile-first).
function DayView({ meds, data, year, month, day, onToggle }){
  const ds = dateStr(year, month, day);
  const past = isPast(ds);
  const dd = data[`d${day}`];
  const sections = MOMENTS.map(mo => {
    const items = meds
      .map((med, i) => ({ med, i, P: prescribedDose(med, ds, mo.key), taken: takenDose(dd, i, mo.key) > 0 }))
      .filter(x => x.P > 0 || x.taken);
    return { mo, items, done: items.filter(x => x.taken).length };
  }).filter(s => s.items.length);

  if (!sections.length) {
    return <p style={{textAlign:"center",color:"var(--color-text-secondary)",margin:"32px 0",fontSize:14}}>Aucune prise prévue ce jour.</p>;
  }
  return (
    <div style={{display:"grid",gap:14}}>
      {sections.map(({mo,items,done})=>(
        <div key={mo.key} style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",overflow:"hidden",background:"var(--color-background-primary)"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"11px 16px",background:"var(--color-background-secondary)"}}>
            <i className={`ti ${mo.icon}`} style={{fontSize:18,color:"var(--color-text-info)"}} aria-hidden="true"></i>
            <span style={{fontWeight:600,fontSize:15,flex:1}}>{mo.label}</span>
            <span style={{fontSize:12,color:done===items.length?"var(--color-text-success)":"var(--color-text-secondary)",fontWeight:500}}>{done}/{items.length} pris</span>
          </div>
          {items.map(({med,i,P,taken})=>(
            <IntakeRow key={i} name={med.name||"(sans nom)"} note={med.note} P={P} taken={taken} past={past} onClick={()=>onToggle(day,i,mo.key, taken?0:1)} />
          ))}
        </div>
      ))}
    </div>
  );
}

// Une ligne « médicament à prendre » dans la vue Jour : pleine largeur, gros
// tap target, coche à gauche, statut à droite.
function IntakeRow({ name, note, P, taken, past, onClick }){
  const prescribed = P > 0;
  let circleIcon, circleColor, status, statusColor;
  if (taken)                   { circleIcon="ti-circle-check-filled"; circleColor="var(--color-text-success)"; status="Pris";      statusColor="var(--color-text-success)"; }
  else if (prescribed && past) { circleIcon="ti-circle";              circleColor="var(--color-text-danger)";  status="Oublié";    statusColor="var(--color-text-danger)"; }
  else if (prescribed)         { circleIcon="ti-circle";              circleColor="var(--color-text-info)";    status="À prendre"; statusColor="var(--color-text-info)"; }
  else                         { circleIcon="ti-circle";              circleColor="var(--color-text-tertiary)";status="—";         statusColor="var(--color-text-tertiary)"; }
  const sub = [prescribed ? `dose ${fmtDose(P)}` : "", note || ""].filter(Boolean).join(" · ");
  return (
    <button onClick={onClick} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"13px 16px",border:"none",borderTop:"0.5px solid var(--color-border-tertiary)",background:"transparent",cursor:"pointer",textAlign:"left",minHeight:56}}>
      <i className={`ti ${circleIcon}`} style={{fontSize:24,color:circleColor,flex:"0 0 auto"}} aria-hidden="true"></i>
      <span style={{flex:1,minWidth:0}}>
        <span style={{display:"block",fontWeight:500,fontSize:14,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</span>
        {sub && <span style={{display:"block",fontSize:12,color:"var(--color-text-tertiary)"}}>{sub}</span>}
      </span>
      <span style={{fontSize:12,fontWeight:600,color:statusColor,flex:"0 0 auto"}}>{status}</span>
    </button>
  );
}

// Un régime posologique : carte compacte (dates en haut, doses matin/midi/soir
// en dessous) pour tenir sans débordement horizontal, y compris sur mobile.
function Regimen({r,onChange,onDelete}){
  const lbl = {fontSize:10,color:"var(--color-text-tertiary)",marginBottom:3,fontWeight:500,textTransform:"uppercase",letterSpacing:0.3};
  const box = {display:"flex",flexDirection:"column",flex:"1 1 0",minWidth:0};
  const doseStyle = {width:"100%",textAlign:"center",fontSize:13,padding:"6px 4px"};
  return(
    <div style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:8,padding:"8px 10px",marginBottom:8,background:"var(--color-background-secondary)"}}>
      <div style={{display:"flex",gap:8,alignItems:"flex-end",marginBottom:8}}>
        <div style={box}><span style={lbl}>Début</span><input type="date" value={r.start||""} onChange={e=>onChange({start:e.target.value})} style={{fontSize:12,padding:"5px 6px",width:"100%"}}/></div>
        <div style={box}><span style={lbl}>Fin</span><input type="date" value={r.end||""} onChange={e=>onChange({end:e.target.value||null})} style={{fontSize:12,padding:"5px 6px",width:"100%"}}/></div>
        <button onClick={onDelete} title="Supprimer ce régime" style={{color:"var(--color-text-danger)",padding:"6px 8px",flex:"0 0 auto"}}>
          <i className="ti ti-x" aria-hidden="true"></i>
        </button>
      </div>
      <div style={{display:"flex",gap:8}}>
        {[["matin","Matin"],["midi","Midi"],["soir","Soir"]].map(([k,L])=>(
          <div key={k} style={box}>
            <span style={lbl}>{L}</span>
            <DoseInput value={r[k]} onCommit={v=>onChange({[k]:v})} style={doseStyle}/>
          </div>
        ))}
      </div>
    </div>
  );
}

// Bloc « Médicaments & posologie » (affiché sous la grille). Reçoit les
// handlers de l'app parent pour rester sans état propre.
function MedsPosology({ meds, updateMed, addMed, setConfirmDel, addRegimen, updateRegimen, deleteRegimen, confirmDel, deleteMed }){
  return(
    <div>
      <p style={{fontWeight:500,marginBottom:4,fontSize:14}}>Médicaments &amp; posologie</p>
      <p style={{color:"var(--color-text-secondary)",fontSize:11,marginBottom:12,lineHeight:1.6}}>
        Pour chaque médicament, ajoutez un ou plusieurs <strong>régimes</strong> : une plage de dates et la dose matin / midi / soir. Une demi-dose est possible — tape <strong>½</strong>, <strong>0,5</strong> ou <strong>1/2</strong>. Pour une posologie qui change (ex. chaque semaine), créez un régime par période ; celui sans date de fin est « en cours ».
      </p>
      {meds.map((m,i)=>{ const med = medOf(m); return (
        <div key={i} style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",padding:"12px",marginBottom:12}}>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
            <input value={med.name} onChange={e=>updateMed(i,{name:e.target.value})} placeholder="Nom du médicament" style={{flex:"1 1 160px",fontWeight:500}}/>
            <input value={med.note} onChange={e=>updateMed(i,{note:e.target.value})} placeholder="note (ex. à jeun)" style={{flex:"1 1 120px",fontSize:12}}/>
            <button onClick={()=>setConfirmDel(i)} title="Supprimer ce médicament" style={{color:"var(--color-text-danger)",padding:"6px 10px"}}>
              <i className="ti ti-trash" aria-hidden="true"></i>
            </button>
          </div>
          {med.regimens.map((r,ri)=>(
            <Regimen key={ri} r={r} onChange={patch=>updateRegimen(i,ri,patch)} onDelete={()=>deleteRegimen(i,ri)} />
          ))}
          <button onClick={()=>addRegimen(i)} style={{marginTop:2,display:"flex",alignItems:"center",gap:6,fontSize:12}}>
            <i className="ti ti-plus" aria-hidden="true"></i> Ajouter un régime
          </button>
        </div>
      );})}
      <button onClick={addMed} style={{marginTop:4,display:"flex",alignItems:"center",gap:6}}>
        <i className="ti ti-plus" aria-hidden="true"></i> Ajouter un médicament
      </button>
      {confirmDel!==null && meds[confirmDel] && (
        <div style={{marginTop:16,padding:"12px",background:"var(--color-background-danger)",border:"0.5px solid var(--color-border-danger)",borderRadius:"var(--border-radius-md)"}}>
          <p style={{color:"var(--color-text-danger)",marginBottom:10,fontSize:13}}>Supprimer « {medOf(meds[confirmDel]).name} » et toute sa posologie ?</p>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>deleteMed(confirmDel)} style={{color:"var(--color-text-danger)"}}>Confirmer</button>
            <button onClick={()=>setConfirmDel(null)}>Annuler</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Saisie d'une dose tolérante aux fractions (½, 0,5, 1/2, 1.5…).
// Affiche en clair (« ½ ») au repos ; édition libre, validation au blur / Entrée.
function DoseInput({value,onCommit,style}){
  const [editing,setEditing] = useState(false);
  const [txt,setTxt] = useState("");
  const commit = () => { const n = parseDose(txt); setEditing(false); onCommit(n); };
  if (!editing){
    return(
      <input type="text" readOnly value={fmtDose(value)} title="Cliquer pour modifier (½, 0,5 ou 1/2 acceptés)"
        onFocus={()=>{ setTxt(doseStr(value)); setEditing(true); }}
        style={{...style,cursor:"pointer"}}/>
    );
  }
  return(
    <input type="text" inputMode="decimal" autoFocus value={txt} title="Ex. 1, ½, 0,5 ou 1/2"
      onChange={e=>setTxt(e.target.value)}
      onBlur={commit}
      onKeyDown={e=>{ if(e.key==="Enter"){ e.preventDefault(); e.currentTarget.blur(); } }}
      style={style}/>
  );
}

function EmptyMeds({onGo}){
  return(
    <div style={{textAlign:"center",padding:"48px 20px",color:"var(--color-text-secondary)"}}>
      <i className="ti ti-pill" style={{fontSize:40,color:"var(--color-text-tertiary)"}} aria-hidden="true"></i>
      <p style={{marginTop:14,marginBottom:16,fontSize:14}}>Aucun médicament pour l'instant.</p>
      <button onClick={onGo} style={{display:"inline-flex",alignItems:"center",gap:8,padding:"8px 16px"}}>
        <i className="ti ti-settings" aria-hidden="true"></i> Ajouter un médicament
      </button>
    </div>
  );
}
