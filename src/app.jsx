import { useState, useEffect, useCallback, useRef } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import * as gdriveMobile from "./gdrive-mobile.js";

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
};

// Les 3 moments de prise dans la journée.
const MOMENTS = [
  { key: "matin", label: "Matin", icon: "ti-sunrise" },
  { key: "midi",  label: "Midi",  icon: "ti-sun" },
  { key: "soir",  label: "Soir",  icon: "ti-moon" },
];

const MONTHS       = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const MONTHS_SHORT = ["Jan","Fév","Mar","Avr","Mai","Jui","Jul","Aoû","Sep","Oct","Nov","Déc"];
const today = new Date();

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function fileKey(y, m)     { return `suivimed_${y}_${String(m + 1).padStart(2,"0")}.json`; } // m 0-based -> nom 1-based
function settingsFile()    { return "suivimed_settings.json"; }
function pad(n)            { return String(n).padStart(2, "0"); }
function dateStr(y, m, d)  { return `${y}-${pad(m + 1)}-${pad(d)}`; } // m 0-based -> ISO YYYY-MM-DD
function todayStr()        { return dateStr(today.getFullYear(), today.getMonth(), today.getDate()); }

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

// Observance d'un mois : prévu vs pris, oublis (prévu non pris) et prises en plus.
function computeAdherence(monthData, meds, year, month) {
  const days = daysInMonth(year, month);
  const perMed = meds.map((m, i) => {
    const med = medOf(m);
    let prescribed = 0, taken = 0, missed = 0, extra = 0;
    const takenDays = new Set();
    for (let d = 1; d <= days; d++) {
      const ds = dateStr(year, month, d);
      const dd = monthData[`d${d}`];
      MOMENTS.forEach(mo => {
        const P = prescribedDose(med, ds, mo.key);
        const T = takenDose(dd, i, mo.key);
        prescribed += P;
        taken += T;
        if (P > T) missed += (P - T);
        if (T > P) extra += (T - P);
        if (T > 0) takenDays.add(d);
      });
    }
    const rate = prescribed > 0 ? Math.round((prescribed - missed) / prescribed * 100) : null;
    return { name: med.name, prescribed, taken, missed, extra, days: takenDays.size, rate };
  });
  const sum = (k) => perMed.reduce((s, x) => s + x[k], 0);
  const prescribed = sum("prescribed"), missed = sum("missed");
  const rate = prescribed > 0 ? Math.round((prescribed - missed) / prescribed * 100) : null;
  return { perMed, prescribed, taken: sum("taken"), missed, extra: sum("extra"), rate };
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
    const doses = MOMENTS.map(mo => Number(r[mo.key]) > 0 ? `${mo.label.toLowerCase()} ${r[mo.key]}` : null)
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
          const doses = MOMENTS.map(mo => Number(r[mo.key]) > 0 ? `${mo.label.toLowerCase()} ${r[mo.key]}` : null)
            .filter(Boolean).join(", ") || "aucune prise";
          return `    • ${period} : ${doses}`;
        }).join("\n")
      : "    • posologie non renseignée";
    return `- ${med.name}${med.note ? ` (${med.note})` : ""} :\n${lines}`;
  }).join("\n") : "- aucun médicament renseigné";

  const monthly = monthsData
    .map(({ year: y, month: m, data }) => ({ y, m, adh: computeAdherence(data, settings.meds, y, m) }))
    .filter(x => x.adh.prescribed > 0 || x.adh.taken > 0);

  const recap = monthly.map(({ y, m, adh }) => {
    const tag = (y === year && m === month) ? " [mois courant]" : "";
    const per = adh.perMed.filter(mc => mc.prescribed > 0 || mc.taken > 0)
      .map(mc => `${mc.name}: ${mc.rate !== null ? mc.rate + "%" : "n/a"}${mc.missed ? `, ${mc.missed} oubli(s)` : ""}${mc.extra ? `, ${mc.extra} en plus` : ""}`).join(" ; ");
    return `- ${MONTHS[m]} ${y}${tag} : observance globale ${adh.rate !== null ? adh.rate + "%" : "n/a"} (${adh.prescribed} prises prévues, ${adh.taken} réelles, ${adh.missed} oubli(s), ${adh.extra} en plus)${per ? ` — ${per}` : ""}`;
  }).join("\n");

  const cur = monthly.find(x => x.y === year && x.m === month);
  const detail = cur
    ? cur.adh.perMed.filter(mc => mc.prescribed > 0 || mc.taken > 0).map(mc =>
        `- ${mc.name} : ${mc.prescribed} prise(s) prévue(s), ${mc.taken} réelle(s), ${mc.missed} oubli(s), ${mc.extra} en plus, observance ${mc.rate !== null ? mc.rate + "%" : "n/a"}`
      ).join("\n")
    : "Aucune prise enregistrée ce mois-ci.";

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
---

Définitions : « prévue » = dose prescrite par le régime posologique actif ce jour-là ; « réelle » = dose réellement prise et cochée ; « oubli » = dose prévue non prise ; « en plus » = dose prise au-delà du prescrit (signal possible de surconsommation).

Commence ta réponse par le titre exact, seul sur la première ligne, sans le modifier : COMPTE RENDU OBSERVANCE POUR LE MÉDECIN TRAITANT

Puis produis une analyse structurée et factuelle (titres en MAJUSCULES) :

1. RÉSUMÉ — médicaments suivis, période couverte, observance globale.
2. OBSERVANCE PAR MÉDICAMENT — taux de prise, oublis récurrents (un moment précis ? un médicament précis ?), régularité.
3. POSOLOGIE & SÉCURITÉ — la posologie prescrite paraît-elle cohérente ? Signes de SURCONSOMMATION/surdosage (prises « en plus » répétées, dose max possiblement dépassée) ou de SOUS-DOSAGE. Signale toute dose qui te semble inhabituelle.
4. INTERACTIONS & PROFIL — interactions médicamenteuses possibles entre les médicaments listés et avec le traitement de fond ; points de vigilance selon l'âge, le sexe, le poids et les antécédents.
5. SUGGESTIONS POUR LE MÉDECIN — pistes d'ajustement de posologie et, le cas échéant, alternatives thérapeutiques à DISCUTER. Précise EXPLICITEMENT qu'il s'agit de suggestions destinées au médecin et JAMAIS d'une prescription.
6. CONSEILS D'OBSERVANCE POUR LE PATIENT — rappels concrets pour ne pas oublier ses prises.

Sois prudent. Signale explicitement si les données sont insuffisantes (peu de mois ou peu de prises) et rappelle que seule une consultation médicale permet de décider.`;
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
    if (T > 0) return T >= 2 ? "✓✓" : "✓";
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

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SuiviMed ${MONTHS[month]} ${year}</title><style>@page{size:A4 landscape;margin:10mm;}@media print{.np{display:none!important;}}</style></head><body style="font-family:Arial,sans-serif;padding:20px;color:#222"><div style="display:flex;justify-content:space-between;margin-bottom:18px"><div><h1 style="font-size:24px;margin:0 0 4px">SuiviMed</h1><p style="font-size:15px;color:#555;margin:0">${MONTHS[month]} ${year}</p></div><button class="np" onclick="window.print()" style="padding:8px 16px;font-size:14px;cursor:pointer">Imprimer / PDF</button></div><div style="overflow-x:auto"><table style="border-collapse:collapse"><thead><tr style="background:#f0f4fa"><th style="padding:6px 10px;text-align:left;font-size:13px;border:0.5px solid #ccc;min-width:150px">Médicament / moment</th>${Array.from({length:days},(_,i)=>`<th style="text-align:center;font-size:12px;padding:4px 2px;border:0.5px solid #ccc;min-width:24px">${i+1}</th>`).join("")}</tr></thead><tbody>${tableRows}</tbody></table></div><p style="font-size:11px;color:#777;margin-top:6px">✓ = pris · ○ = prévu non pris (oubli) · ✓✓ = 2 prises</p>${synHtml}${aiHtml}</body></html>`;
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

  // Init
  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      setSettings(s);
      const d = await loadMonth(year, month);
      setData(d);
      if (isElectron) {
        const dir = await window.electronAPI.getDataDir();
        setDataDir(dir);
      }
      if (syncAvailable) sync.status().then(setGsync).catch(()=>{});
    })();
  }, []);

  useEffect(() => {
    loadMonth(year, month).then(setData);
  }, [year, month]);

  // Envoi auto vers le Drive après une modification (débounce), si connecté
  const pushTimer = useRef(null);
  useEffect(() => {
    if (!syncAvailable || !gsync.connected) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => { sync.push().catch(()=>{}); }, 2500);
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

  const persistData = useCallback((y, m, newData) => {
    setSaveStatus("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await saveFile(fileKey(y, m), newData);
        setSaveStatus("saved");
      } catch {
        setSaveStatus("error");
      }
    }, 400);
  }, []);

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
    setSettings(await loadSettings());
    setData(await loadMonth(year, month));
  }, [year, month]);

  const connectGoogle = async () => {
    setSyncBusy(true); setSyncMsg("Connexion à Google…");
    try {
      setGsync(await sync.signIn());
      setSyncMsg("Récupération des données…");
      const pulled = await sync.pull();
      if (pulled.empty) {
        await sync.push();
        setSyncMsg("Données envoyées sur ton Drive.");
      } else {
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
    try { await sync.push(); setSyncMsg("Synchronisé à l'instant."); }
    catch (e) { setSyncMsg("Échec : " + (e?.message || e)); }
    setSyncBusy(false);
  };

  // ── Réglages : profil & médicaments
  const saveSettings = (s) => { setSettings(s); saveFile(settingsFile(), s); };
  const updateProfile = (patch) => saveSettings({ ...settings, profile: { ...(settings.profile||{}), ...patch } });
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
  }, [annualYear, settings.meds]);

  const annualMonths = annualData.filter(m => m.prescribed > 0 || m.taken > 0);
  const annualAvgRate = annualMonths.filter(m=>m.rate!=null).length
    ? Math.round(annualMonths.filter(m=>m.rate!=null).reduce((s,m)=>s+m.rate,0)/annualMonths.filter(m=>m.rate!=null).length)
    : null;
  const annualMissed = annualData.reduce((s,m)=>s+m.missed,0);

  const CELL=34, LABEL_W=190;

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

      {/* Month nav */}
      {(view==="grid"||view==="observance")&&(
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
          <button onClick={prevMonth}><i className="ti ti-arrow-left" aria-hidden="true"></i></button>
          <span style={{fontWeight:500,minWidth:140,textAlign:"center"}}>{MONTHS[month]} {year}</span>
          <button onClick={nextMonth}><i className="ti ti-arrow-right" aria-hidden="true"></i></button>
        </div>
      )}

      {/* GRID */}
      {view==="grid"&&(
        meds.length === 0
          ? <EmptyMeds onGo={()=>setView("settings")} />
          : <>
          <div style={{overflowX:"auto",borderRadius:"var(--border-radius-lg)",border:"0.5px solid var(--color-border-tertiary)",width:"fit-content",maxWidth:"100%",margin:"0 auto"}}>
            <table style={{borderCollapse:"collapse",tableLayout:"fixed",width:LABEL_W+days*CELL+"px"}}>
              <thead>
                <tr style={{background:"var(--color-background-secondary)"}}>
                  <th style={{width:LABEL_W,padding:"6px 10px",textAlign:"left",fontWeight:500,borderRight:"0.5px solid var(--color-border-tertiary)",position:"sticky",left:0,background:"var(--color-background-secondary)",zIndex:2,fontSize:12}}>Médicament / moment</th>
                  {cols.map(d=>(
                    <th key={d} style={{width:CELL,textAlign:"center",fontWeight:isToday(d)?500:400,fontSize:11,padding:"6px 0",color:isToday(d)?"var(--color-text-info)":"var(--color-text-secondary)",borderLeft:"0.5px solid var(--color-border-tertiary)"}}>
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gridRows.map((row)=> row.type==="head" ? (
                  <tr key={row.key} style={{background:"var(--color-background-secondary)"}}>
                    <td style={{padding:"5px 10px",borderRight:"0.5px solid var(--color-border-tertiary)",position:"sticky",left:0,background:"var(--color-background-secondary)",zIndex:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:LABEL_W,fontSize:12,fontWeight:600}}>
                      <i className="ti ti-pill" style={{fontSize:12,marginRight:5,color:"var(--color-text-info)"}} aria-hidden="true"></i>
                      {row.name}{row.note && <span style={{fontWeight:400,color:"var(--color-text-tertiary)"}}> · {row.note}</span>}
                    </td>
                    {cols.map(d=><td key={d} style={{borderLeft:"0.5px solid var(--color-border-tertiary)",background:"var(--color-background-secondary)"}} />)}
                  </tr>
                ) : (
                  <tr key={row.key}>
                    <td style={{padding:"3px 10px 3px 24px",borderRight:"0.5px solid var(--color-border-tertiary)",position:"sticky",left:0,background:"var(--color-background-primary)",zIndex:1,whiteSpace:"nowrap",fontSize:12,color:"var(--color-text-secondary)"}}>
                      <i className={`ti ${row.icon}`} style={{fontSize:12,marginRight:5}} aria-hidden="true"></i>{row.label}
                    </td>
                    {cols.map(d=>{
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
            <strong style={{color:"var(--color-text-success)"}}>✓</strong> = pris · <strong style={{color:"var(--color-text-danger)"}}>○</strong> = prévu non pris (oubli) · <strong style={{color:"var(--color-text-warning)"}}>✓</strong> orange = pris hors prescription / dose différente · clic pour cocher (cycle 0 → 1 → 2). La case grisée indique une prise prévue par la posologie.
          </div>
        </>
      )}

      {/* OBSERVANCE */}
      {view==="observance"&&(
        <div>
          {!hasMonthData
            ?<p style={{color:"var(--color-text-secondary)",textAlign:"center",marginTop:32}}>Aucune prise enregistrée ce mois.</p>
            :<>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
                <MetricCard label="Observance globale" value={adh.rate!=null?adh.rate:"—"} unit={adh.rate!=null?"%":""} icon="ti-circle-check" color={rateColor(adh.rate)}/>
                <MetricCard label="Prises prévues"     value={adh.prescribed} unit="" icon="ti-clipboard-list"/>
                <MetricCard label="Prises réelles"     value={adh.taken}      unit="" icon="ti-pill"/>
                <MetricCard label="Oublis"             value={adh.missed}     unit="" icon="ti-alert-triangle"/>
                <MetricCard label="Prises en plus"     value={adh.extra}      unit="" icon="ti-arrow-up-circle"/>
              </div>
              <p style={{fontWeight:500,marginBottom:10,fontSize:13}}>Par médicament</p>
              <div style={{display:"grid",gap:8}}>
                {adh.perMed.filter(m=>m.prescribed>0||m.taken>0).map((m,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",flexWrap:"wrap"}}>
                    <span style={{fontWeight:500,flex:"1 1 140px"}}>{m.name}</span>
                    <span style={{fontSize:13,fontWeight:600,color:"#222",padding:"2px 10px",borderRadius:999,background:rateColor(m.rate)}}>{m.rate!=null?m.rate+"%":"n/a"}</span>
                    <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>{m.prescribed} prévue(s) · {m.taken} réelle(s) · {m.missed} oubli(s){m.extra?` · ${m.extra} en plus`:""}</span>
                  </div>
                ))}
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
          <div style={{borderTop:"0.5px solid var(--color-border-tertiary)",margin:"16px 0"}}></div>

          <p style={{fontWeight:500,marginBottom:4,fontSize:14}}>Médicaments & posologie</p>
          <p style={{color:"var(--color-text-secondary)",fontSize:11,marginBottom:12,lineHeight:1.6}}>
            Pour chaque médicament, ajoutez un ou plusieurs <strong>régimes</strong> : une plage de dates et la dose à prendre matin / midi / soir. Pour une posologie qui change dans le temps (ex. chaque semaine), créez un régime par période. Le régime sans date de fin est « en cours ».
          </p>
          {settings.meds.map((m,i)=>{ const med = medOf(m); return (
            <div key={i} style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",padding:"12px",marginBottom:12}}>
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
                <input value={med.name} onChange={e=>updateMed(i,{name:e.target.value})} placeholder="Nom du médicament" style={{flex:"1 1 160px",fontWeight:500}}/>
                <input value={med.note} onChange={e=>updateMed(i,{note:e.target.value})} placeholder="note (ex. à jeun)" style={{flex:"1 1 120px",fontSize:12}}/>
                <button onClick={()=>setConfirmDel(i)} title="Supprimer ce médicament" style={{color:"var(--color-text-danger)",padding:"6px 10px"}}>
                  <i className="ti ti-trash" aria-hidden="true"></i>
                </button>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"auto auto repeat(3,minmax(60px,1fr)) auto",gap:6,alignItems:"center",fontSize:11,color:"var(--color-text-secondary)"}}>
                <span style={{fontWeight:500}}>Début</span>
                <span style={{fontWeight:500}}>Fin</span>
                <span style={{fontWeight:500,textAlign:"center"}}>Matin</span>
                <span style={{fontWeight:500,textAlign:"center"}}>Midi</span>
                <span style={{fontWeight:500,textAlign:"center"}}>Soir</span>
                <span></span>
                {med.regimens.map((r,ri)=>(
                  <Regimen key={ri} r={r} onChange={patch=>updateRegimen(i,ri,patch)} onDelete={()=>deleteRegimen(i,ri)} />
                ))}
              </div>
              <button onClick={()=>addRegimen(i)} style={{marginTop:10,display:"flex",alignItems:"center",gap:6,fontSize:12}}>
                <i className="ti ti-plus" aria-hidden="true"></i> Ajouter un régime
              </button>
            </div>
          );})}
          <button onClick={addMed} style={{marginTop:4,display:"flex",alignItems:"center",gap:6}}>
            <i className="ti ti-plus" aria-hidden="true"></i> Ajouter un médicament
          </button>
          {confirmDel!==null&&(
            <div style={{marginTop:16,padding:"12px",background:"var(--color-background-danger)",border:"0.5px solid var(--color-border-danger)",borderRadius:"var(--border-radius-md)"}}>
              <p style={{color:"var(--color-text-danger)",marginBottom:10,fontSize:13}}>Supprimer « {medOf(settings.meds[confirmDel]).name} » et toute sa posologie ?</p>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>deleteMed(confirmDel)} style={{color:"var(--color-text-danger)"}}>Confirmer</button>
                <button onClick={()=>setConfirmDel(null)}>Annuler</button>
              </div>
            </div>
          )}

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

// Cellule d'une prise (médicament × jour × moment). Cycle 0 → 1 → 2 → 0.
function MomentCell({P,T,onChange,cell=34}){
  const next = T>=2 ? 0 : T+1;
  let glyph, col;
  if (T>0) {
    glyph = T>=2 ? "✓✓" : "✓";
    col = P===0 ? "var(--color-text-warning)" : (T===P ? "var(--color-text-success)" : "var(--color-text-warning)");
  } else {
    glyph = P>0 ? "○" : "–";
    col = P>0 ? "var(--color-text-danger)" : "var(--color-text-tertiary)";
  }
  const bg = P>0 ? "rgba(55,138,221,0.07)" : "transparent";
  const title = `Prévu : ${P} · Pris : ${T}` + (T===0&&P>0?" — oubli":"") + (T>P&&P>0?" — dose supérieure au prescrit":"") + (T>0&&P===0?" — pris hors prescription":"");
  return(
    <button onClick={()=>onChange(next)} title={title} aria-label="Prise de médicament"
      style={{width:cell-4,height:26,border:"none",background:bg,borderRadius:4,cursor:"pointer",color:col,fontWeight:700,fontSize:T>=2?11:14,padding:0,lineHeight:1}}>
      {glyph}
    </button>
  );
}

// Une ligne de régime posologique dans l'éditeur (6 colonnes de la grille parente).
function Regimen({r,onChange,onDelete}){
  const numStyle = {width:"100%",textAlign:"center",fontSize:12,padding:"5px 4px"};
  return(
    <>
      <input type="date" value={r.start||""} onChange={e=>onChange({start:e.target.value})} style={{fontSize:12,padding:"5px 6px"}}/>
      <input type="date" value={r.end||""} onChange={e=>onChange({end:e.target.value||null})} style={{fontSize:12,padding:"5px 6px"}}/>
      <input type="number" min="0" step="0.5" value={r.matin ?? 0} onChange={e=>onChange({matin: e.target.value===""?0:Number(e.target.value)})} style={numStyle}/>
      <input type="number" min="0" step="0.5" value={r.midi ?? 0}  onChange={e=>onChange({midi:  e.target.value===""?0:Number(e.target.value)})} style={numStyle}/>
      <input type="number" min="0" step="0.5" value={r.soir ?? 0}  onChange={e=>onChange({soir:  e.target.value===""?0:Number(e.target.value)})} style={numStyle}/>
      <button onClick={onDelete} title="Supprimer ce régime" style={{color:"var(--color-text-danger)",padding:"4px 8px"}}>
        <i className="ti ti-x" aria-hidden="true"></i>
      </button>
    </>
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
