# SuiviMed

Suivi des prises de médicaments et de l'observance (matin / midi / soir), avec
posologie variable dans le temps (régimes à plages de dates) et analyse IA.
Sous-application du pack XYVEL Medical (projet indépendant, dépôt git propre).

## Stack
- Vite + React 18 (entrée : `index.html` → `src/main.jsx` → `src/app.jsx`)
- Capacitor 7 pour Android, Electron 28 pour desktop
- Sync Google Drive : `gdrive.js` (desktop) / `src/gdrive-mobile.js` (mobile)
- Analyse IA : Ollama local (modèle `llama3.2`) sur desktop uniquement (privé,
  rien ne quitte la machine). Le prompt est construit dans `src/app.jsx`
  (`buildPrompt`), le system prompt + l'appel sont dans `electron.js`.

## Lancer
```bash
npm install
npm run dev            # web → http://localhost:5173
npm run electron:dev   # desktop
npm run electron:build # build desktop → out/
```
Android : `npx cap add android` (1re fois) puis `npx cap sync android`.

## Modèle de données (fichiers JSON, préfixe `suivimed_`)
- `suivimed_settings.json` : `{ profile, meds: [{ name, note, regimens: [{ start, end, matin, midi, soir }] }] }`.
  Un *régime* = posologie prescrite sur une plage de dates ISO (`end: null` = en cours).
- `suivimed_YYYY_MM.json` : prises réelles. `{ "d<jour>": { "med_<i>": { matin, midi, soir } } }`.
  Valeur = nombre de prises réellement effectuées à ce moment.
- L'observance compare, jour par jour et moment par moment, la dose **prévue**
  (régime actif à cette date) à la dose **réelle** (cochée). Voir `computeAdherence`.

## Identité
- appId : `com.xyvel.suivimed`
- Dépôt : https://github.com/Gladia92/suivimed
- Web (GitHub Pages) : https://gladia92.github.io/suivimed/
- CI : GitHub Actions — `build.yml` publie une Release (EXE signé + APK + AAB),
  `pages.yml` déploie la version web sur Pages, `play-store.yml` publie sur
  Play Console (manuel, nécessite le secret `GOOGLE_PLAY_SERVICE_ACCOUNT`).
- OAuth Google Drive : **client partagé pour tout le pack XYVEL Medical**
  (même `CLIENT_ID`/secret que MigraineLog — projet en cours de renommage en
  « XYVEL Medical » côté Google Cloud Console pour un écran de consentement
  cohérent vu par les utilisateurs : « XYVEL Medical souhaite accéder à votre
  Google Drive »). Chaque sous-app range ses données sous son propre nom de
  fichier dans l'`appDataFolder` (`suivimed.json` ici, `migrainelog.json` pour
  MigraineLog) → aucune collision malgré le client partagé.
  `google-secret.txt` (desktop) n'est pas versionné (copié depuis MigraineLog) ;
  la sync mobile (PKCE) n'a pas besoin de secret.
  Si une isolation totale par app est nécessaire un jour (ex. app suspendue
  indépendamment), créer un projet OAuth dédié — voir le pack `README.md`.

## Signature / secrets (matériel PARTAGÉ avec le pack XYVEL)
- Certificat Windows : `cert.pfx` (privé, non commité, CN=XYVEL Medical, copié
  depuis `xyvel-medical/`) / `XyvelMedical.cer` (public, suivi, importé par
  `installer.nsh` dans le magasin utilisateur à l'installation).
- Keystore Android : `xyvel-medical-release.keystore` (alias `xyvel`) — **non
  commité**, partagé avec le hub. `android/keystore.properties` (non commité)
  pointe dessus pour les builds locaux signés.
- Secrets GitHub requis : `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
  `CSC_LINK`, `CSC_KEY_PASSWORD`, `GOOGLE_CLIENT_SECRET`
  (+ `GOOGLE_PLAY_SERVICE_ACCOUNT` pour play-store.yml).
  Valeurs récapitulées dans `SIGNING-SECRETS.txt` (local, non commité).

## Notes pour Claude Code
- Composant principal : `src/app.jsx`. Import sensible à la casse : `./app.jsx`.
- L'onglet « Analyse IA » n'apparaît que sur desktop (Electron), comme MigraineLog.
- Indexation des prises par position (`med_<i>`) : supprimer un médicament au milieu
  décale les indices des données historiques (limitation héritée de MigraineLog).
