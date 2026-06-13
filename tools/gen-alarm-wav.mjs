// Génère le son d'alarme des rappels de prise : un CARILLON façon annonce
// d'aéroport/gare — trois notes « ta-ta-ta » (descendantes, timbre de cloche
// douce) répétées toutes les 3 s. WAV PCM 16 bits mono.
// Sortie : android/app/src/main/res/raw/alarme_prise.wav
//
// Régénérer avec :  node tools/gen-alarm-wav.mjs
//
// ▶ Réglages à ajuster (tout est ici) :
//   - NOTES      : les 3 fréquences (Hz) et leur instant de départ dans le cycle.
//                  Plus haut = plus brillant ; plus bas = plus grave/doux.
//   - CYCLE_S    : période de répétition du carillon (3 s par défaut).
//   - DECAY_S    : durée de décroissance de chaque note (effet « cloche »).
//   - AMPLITUDE  : volume relatif du timbre (le volume réel = celui de l'alarme).
//
// Pourquoi un fichier de 30 s : une lecture joue le son sur toute sa durée → le
// carillon se répète ~10 fois (toutes les 3 s) par déclenchement d'alarme.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 22050;   // Hz
const DURATION_S  = 30;      // durée totale du clip
const CYCLE_S     = 3.0;     // le carillon « ta-ta-ta » se répète toutes les 3 s
const AMPLITUDE   = 0.60;    // marge pour éviter la saturation (notes qui se chevauchent)
const DECAY_S     = 0.52;    // décroissance de chaque note (timbre de cloche)
const ATTACK_S    = 0.006;   // petite attaque pour éviter les clics
const H2_GAIN     = 0.32;    // 2e harmonique (octave) → timbre plus « carillon »

// Carillon descendant sol–mi–do (G6, E6, C6) : { fréquence Hz, départ s }.
const NOTES = [
  [1567.98, 0.00],
  [1318.51, 0.30],
  [1046.50, 0.60],
];
const NOTE_WINDOW = 1.7; // durée pendant laquelle on calcule la queue d'une note

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../android/app/src/main/res/raw/alarme_prise.wav");

const totalSamples = Math.floor(SAMPLE_RATE * DURATION_S);
const samples = new Int16Array(totalSamples);
const TWO_PI = 2 * Math.PI;

for (let n = 0; n < totalSamples; n++) {
  const t = n / SAMPLE_RATE;
  const ct = t % CYCLE_S;           // position dans le cycle de 3 s

  let s = 0;
  for (const [f, start] of NOTES) {
    const dt = ct - start;
    if (dt < 0 || dt > NOTE_WINDOW) continue;
    const env = Math.exp(-dt / DECAY_S);          // décroissance « cloche »
    const atk = Math.min(1, dt / ATTACK_S);       // attaque douce
    const ph = TWO_PI * f * dt;
    s += atk * env * (Math.sin(ph) + H2_GAIN * Math.sin(2 * ph));
  }
  s = s / (1 + H2_GAIN);

  let v = Math.round(s * AMPLITUDE * 32767);
  if (v > 32767) v = 32767; else if (v < -32768) v = -32768; // clamp (chevauchements)
  samples[n] = v;
}

// En-tête WAV (RIFF / PCM 16 bits mono)
const dataBytes = samples.length * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);             // PCM
buf.writeUInt16LE(1, 22);             // mono
buf.writeUInt32LE(SAMPLE_RATE, 24);
buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
console.log(`Écrit ${OUT} (${(buf.length / 1024).toFixed(0)} Ko, ${DURATION_S}s @ ${SAMPLE_RATE}Hz, carillon toutes les ${CYCLE_S}s)`);
