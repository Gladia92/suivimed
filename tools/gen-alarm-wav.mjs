// Génère le son d'alarme des rappels de prise : un CARILLON façon annonce de
// hall d'aéroport/gare. Quatre notes montantes au timbre de vibraphone (mailloche
// douce + harmoniques + léger trémolo), baignées dans une RÉVERBÉRATION de grand
// hall (réverb de Schroeder), répétées toutes les 3 s. WAV PCM 16 bits mono.
// Sortie : android/app/src/main/res/raw/alarme_prise.wav
//
// Régénérer avec :  node tools/gen-alarm-wav.mjs
//
// NB : carillon générique (on ne copie aucun jingle déposé type SNCF/NBC).
//
// ▶ Réglages (tout est ici) :
//   - NOTES     : [fréquence Hz, départ s] de chaque note du carillon.
//   - CYCLE_S   : période de répétition (3 s).
//   - REVERB    : MIX (part de réverb) et FEEDBACK (longueur du hall).
//   - TREMOLO   : profondeur/vitesse du vibrato d'amplitude (effet vibraphone).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SR          = 22050;   // Hz
const DURATION_S  = 11.0;    // 2 cycles (le lecteur d'alarme boucle le fichier)
const CYCLE_S     = 5.5;     // carillon court (~1 s) + ~4,5 s de silence
const PEAK        = 0.82;    // niveau crête final après normalisation

// Carillon court, registre médian encore un ton plus bas (do5, mi♭5, fa5, do5).
// [fréquence Hz, départ s, facteur de durée] — la 4e note est un « tac » très sec.
const NOTES = [
  [523.25, 0.00, 0.50],
  [622.25, 0.28, 0.35],   // mi♭5 : c'est elle qui traînait (analyse) → durée réduite
  [698.46, 0.56, 0.28],
  [523.25, 0.84, 0.45],   // « tac » final
];

const REVERB_MIX = 0.15;     // part de réverb (0 = sec, ~0.4 = grand hall)
const REVERB_FB  = 0.50;     // longueur de la queue de réverb
const TREMOLO_DEPTH = 0.12;  // profondeur du trémolo (vibraphone)
const TREMOLO_HZ    = 5.2;

const TWO_PI = 2 * Math.PI;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../android/app/src/main/res/raw/alarme_prise.wav");
const N = Math.floor(SR * DURATION_S);

// ── 1) Signal « sec » : carillon vibraphone, répété chaque cycle.
// Une note = somme de partiels (dont un léger partiel inharmonique « métallique »),
// chacun avec sa propre décroissance ; attaque douce ; trémolo d'amplitude.
// dm = facteur de durée de la note (1 = normale, <1 = plus courte).
function note(f, dt, dm) {
  if (dt < 0) return 0;
  const atk  = Math.min(1, dt / 0.008);
  const trem = 1 + TREMOLO_DEPTH * Math.sin(TWO_PI * TREMOLO_HZ * dt);
  const p1 = 1.00 * Math.sin(TWO_PI * f * dt)       * Math.exp(-dt / (0.40 * dm));
  const p2 = 0.40 * Math.sin(TWO_PI * 2 * f * dt)   * Math.exp(-dt / (0.26 * dm));
  const p3 = 0.18 * Math.sin(TWO_PI * 3 * f * dt)   * Math.exp(-dt / (0.17 * dm));
  const p4 = 0.06 * Math.sin(TWO_PI * 4.2 * f * dt) * Math.exp(-dt / (0.12 * dm)); // léger métallique
  return atk * trem * (p1 + p2 + p3 + p4);
}

const dry = new Float64Array(N);
for (let n = 0; n < N; n++) {
  const ct = (n / SR) % CYCLE_S;
  let s = 0;
  for (const [f, start, dm] of NOTES) s += note(f, ct - start, dm);
  dry[n] = s;
}

// ── 2) Réverbération de Schroeder : 4 filtres en peigne (parallèle, avec
// amortissement des aigus) puis 2 passe-tout (série) → ambiance de hall.
function comb(input, delaySec, fb, damp) {
  const D = Math.max(1, Math.floor(delaySec * SR));
  const buf = new Float64Array(D);
  const out = new Float64Array(input.length);
  let i = 0, store = 0;
  for (let n = 0; n < input.length; n++) {
    const y = buf[i];
    out[n] = y;
    store = y * (1 - damp) + store * damp;          // passe-bas dans la boucle
    buf[i] = input[n] + store * fb;
    i = (i + 1) % D;
  }
  return out;
}
function allpass(input, delaySec, g) {
  const D = Math.max(1, Math.floor(delaySec * SR));
  const buf = new Float64Array(D);
  const out = new Float64Array(input.length);
  let i = 0;
  for (let n = 0; n < input.length; n++) {
    const bo = buf[i];
    const y = -g * input[n] + bo;
    buf[i] = input[n] + g * bo;
    out[n] = y;
    i = (i + 1) % D;
  }
  return out;
}

const combDelays = [0.0253, 0.0269, 0.0289, 0.0307]; // ~25–31 ms
let wet = new Float64Array(N);
for (const d of combDelays) {
  const c = comb(dry, d, REVERB_FB, 0.25);
  for (let n = 0; n < N; n++) wet[n] += c[n];
}
for (let n = 0; n < N; n++) wet[n] /= combDelays.length;
wet = allpass(wet, 0.0050, 0.5);
wet = allpass(wet, 0.0017, 0.5);

// ── 3) Mix sec + réverb, normalisation crête, écriture 16 bits.
const mixed = new Float64Array(N);
let peak = 0;
for (let n = 0; n < N; n++) {
  const v = dry[n] * (1 - REVERB_MIX) + wet[n] * REVERB_MIX;
  mixed[n] = v;
  const a = Math.abs(v);
  if (a > peak) peak = a;
}
const gain = peak > 0 ? PEAK / peak : 1;
const samples = new Int16Array(N);
for (let n = 0; n < N; n++) {
  let v = Math.round(mixed[n] * gain * 32767);
  if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
  samples[n] = v;
}

// En-tête WAV (RIFF / PCM 16 bits mono)
const dataBytes = samples.length * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
console.log(`Écrit ${OUT} (${(buf.length / 1024).toFixed(0)} Ko, ${DURATION_S}s @ ${SR}Hz, carillon réverbéré toutes les ${CYCLE_S}s)`);
