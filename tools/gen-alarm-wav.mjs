// Génère le son d'alarme des rappels de prise : un motif de bips forts et
// répétés (effet « réveil ») d'environ 30 s, écrit en WAV PCM 16 bits mono.
// Sortie : android/app/src/main/res/raw/alarme_prise.wav
//
// Régénérer avec :  node tools/gen-alarm-wav.mjs
//
// Pourquoi un fichier de 30 s : une notification joue le son du canal une seule
// fois, sur toute sa durée. Un clip de 30 s = 30 s de sonnerie par rappel, ce
// qui donne un vrai effet d'alarme (et non un « ding » d'une seconde).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 16000;        // Hz (suffisant pour une alarme, fichier compact)
const DURATION_S  = 30;           // durée totale du clip
const AMPLITUDE   = 0.92;         // proche du max, alarme volontairement forte

// Motif : deux bips rapprochés aigus puis une courte pause — répété (type sonnerie d'alerte).
// Séquence (secondes) : [fréquence Hz, durée]. freq 0 = silence.
const PATTERN = [
  [1318, 0.20], [0, 0.08],
  [1318, 0.20], [0, 0.08],
  [988,  0.24], [0, 0.45],
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../android/app/src/main/res/raw/alarme_prise.wav");

const totalSamples = Math.floor(SAMPLE_RATE * DURATION_S);
const samples = new Int16Array(totalSamples);

let idx = 0;
let phase = 0;
while (idx < totalSamples) {
  for (const [freq, dur] of PATTERN) {
    const n = Math.floor(SAMPLE_RATE * dur);
    for (let i = 0; i < n && idx < totalSamples; i++, idx++) {
      if (freq === 0) { samples[idx] = 0; continue; }
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      // Petite enveloppe d'attaque/relâche pour éviter les clics secs en début/fin de bip.
      const env = Math.min(1, i / 80, (n - i) / 80);
      samples[idx] = Math.round(Math.sin(phase) * AMPLITUDE * env * 32767);
    }
    if (idx >= totalSamples) break;
  }
}

// En-tête WAV (RIFF / PCM 16 bits mono)
const dataBytes = samples.length * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);            // taille du sous-bloc fmt
buf.writeUInt16LE(1, 20);             // PCM
buf.writeUInt16LE(1, 22);             // mono
buf.writeUInt32LE(SAMPLE_RATE, 24);
buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
buf.writeUInt16LE(2, 32);             // block align
buf.writeUInt16LE(16, 34);            // bits/échantillon
buf.write("data", 36);
buf.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
console.log(`Écrit ${OUT} (${(buf.length / 1024).toFixed(0)} Ko, ${DURATION_S}s @ ${SAMPLE_RATE}Hz)`);
