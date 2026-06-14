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
- OAuth Google Drive : **clients partagés pour tout le pack XYVEL Medical**, dans
  le projet Google Cloud brandé « XYVEL Medical » (écran de consentement :
  « XYVEL Medical souhaite accéder à votre Google Drive »). Deux clients réutilisés
  tels quels par toutes les apps du pack :
    - `XYVEL Medical Mobile` (type iOS, PKCE sans secret) → mobile/Android.
      Schéma de retour = ID client inversé, commun à tout le pack.
    - `XYVEL Medical Desktop` (type application de bureau, loopback 127.0.0.1) → Electron.
      Secret dans `google-secret.txt` (non versionné, partagé).
  Chaque sous-app range ses données sous son propre nom de fichier dans
  l'`appDataFolder` (`suivimed.json` ici, `migrainelog.json` pour MigraineLog)
  → aucune collision malgré les clients partagés.
  La sync mobile (PKCE) n'a pas besoin de secret.
  Limites connues du partage : le schéma de retour mobile étant commun, si un
  utilisateur installe deux apps du pack sur le même téléphone, Android peut
  demander « ouvrir avec… » au retour OAuth. Le loopback desktop, lui, ne
  collisionne jamais. Pour une isolation totale (ex. app suspendue
  indépendamment), créer des clients dédiés — voir le pack `README.md`.

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

## Alarme de prise (Android natif) — autorisation « plein écran »
L'alarme (mode `reminders.mode === "alarm"`) sonne et **prend l'écran par-dessus
les autres apps** via un *full-screen intent* (`AlarmReceiver` → `AlarmActivity`).
Cela nécessite la permission `USE_FULL_SCREEN_INTENT` :
- **Android ≤ 13** : permission *normale*, **accordée automatiquement à l'installation**.
- **Android 14+ (API 34)** : refusée par défaut pour une app « lambda ». Deux cas :
  - **Install par APK (Releases GitHub)** : doit être activée **manuellement**. L'app
    ouvre directement le bon écran (`Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT`,
    repli sur « Infos de l'app ») — auto à l'activation des rappels + bouton dans Réglages.
  - **Install depuis le Play Store** : peut être **auto-accordée** SI on remplit la
    **déclaration « notifications plein écran » dans la Play Console** (justifier l'usage
    alarme). ⚠️ Étape MANUELLE côté Console — aucun réglage du manifeste ne la déclenche.
    Une fois faite + approuvée, `canUseFullScreenIntent()` renvoie `true` → aucun bouton.
- Le son est joué par `AlarmActivity` (MediaPlayer, flux ALARME). ⚠️ Le `.wav` DOIT
  rester non compressé (`aaptOptions { noCompress 'wav' }`) sinon `openRawResourceFd`
  échoue en silence. Si la prise d'écran échoue malgré la permission (OEM agressif),
  la piste robuste = service au premier plan jouant le son indépendamment de l'activité.

## Notes pour Claude Code
- Composant principal : `src/app.jsx`. Import sensible à la casse : `./app.jsx`.
- L'onglet « Analyse IA » n'apparaît que sur desktop (Electron), comme MigraineLog.
- Indexation des prises par position (`med_<i>`) : supprimer un médicament au milieu
  décale les indices des données historiques (limitation héritée de MigraineLog).
