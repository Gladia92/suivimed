// Génère le son d'alarme des rappels de prise : un son DOUX et GRAVE, fait de
// lentes montées/descentes (« swells ») plutôt que de bips secs. Écrit en WAV
// PCM 16 bits mono. Sortie : android/app/src/main/res/raw/alarme_prise.wav
//
// Régénérer avec :  node tools/gen-alarm-wav.mjs
//
// ▶ Réglages à ajuster (tout est ici) :
//   - F0           : hauteur du son (Hz). Plus bas = plus grave. ~120–200 Hz =
//                    grave et doux. ⚠️ trop bas (< ~120 Hz) devient faible sur
//                    les petits haut-parleurs de téléphone.
//   - AMPLITUDE    : volume relatif du timbre (0–1). Bas = plus doux.
//   - SWELL/GAP    : durées de la montée-descente et du silence entre deux.
//
// Pourquoi un fichier de 30 s : une lecture joue le son sur toute sa durée → ~30 s
// de sonnerie par rappel. Le son est volontairement bouclé proprement.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 22050;   // Hz (un peu plus haut = grave plus propre)
const DURATION_S  = 30;      // durée totale du clip
const F0          = 300;     // fréquence fondamentale (Hz) — grave mais audible sur petit haut-parleur
const AMPLITUDE   = 0.55;    // < 0.92 de l'ancienne version : plus doux, plus de marge

// Un cycle = une lente montée/descente (SWELL) suivie d'un silence (GAP).
const SWELL_S = 2.6;         // durée de la note (montée + tenue + descente)
const GAP_S   = 1.2;         // silence entre deux notes
const FADE_S  = 0.8;         // durée des fondus d'entrée/sortie (douceur, pas de clic)

// Un peu d'harmonique d'octave, à faible niveau, pour que le grave reste audible
// sur les petits haut-parleurs sans durcir le timbre.
const H2_GAIN = 0.30;        // niveau de l'octave (2·F0)
const H3_GAIN = 0.08;        // niveau de la quinte au-dessus (3·F0), très discret

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../android/app/src/main/res/raw/alarme_prise.wav");

const totalSamples = Math.floor(SAMPLE_RATE * DURATION_S);
const samples = new Int16Array(totalSamples);

const cycleS = SWELL_S + GAP_S;
const TWO_PI = 2 * Math.PI;

for (let n = 0; n < totalSamples; n++) {
  const t = n / SAMPLE_RATE;          // temps absolu
  const ct = t % cycleS;              // position dans le cycle courant

  let env = 0;                        // enveloppe d'amplitude (0 pendant le silence)
  if (ct < SWELL_S) {
    if (ct < FADE_S) {
      // Fondu d'entrée en cosinus surélevé (très doux, aucun clic).
      env = 0.5 * (1 - Math.cos(Math.PI * (ct / FADE_S)));
    } else if (ct > SWELL_S - FADE_S) {
      // Fondu de sortie symétrique.
      env = 0.5 * (1 - Math.cos(Math.PI * ((SWELL_S - ct) / FADE_S)));
    } else {
      env = 1; // tenue
    }
  }

  if (env <= 0) { samples[n] = 0; continue; }

  const ph = TWO_PI * F0 * t;
  let s = Math.sin(ph)
        + H2_GAIN * Math.sin(2 * ph)
        + H3_GAIN * Math.sin(3 * ph);
  s = s / (1 + H2_GAIN + H3_GAIN);     // normalise pour rester dans [-1, 1]

  samples[n] = Math.round(s * env * AMPLITUDE * 32767);
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
console.log(`Écrit ${OUT} (${(buf.length / 1024).toFixed(0)} Ko, ${DURATION_S}s @ ${SAMPLE_RATE}Hz, F0=${F0}Hz)`);
