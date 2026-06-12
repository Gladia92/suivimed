// Synchronisation Google Drive (flux OAuth "application de bureau", PKCE + loopback).
// Le journal est stocké en UN fichier JSON dans le dossier privé de l'app (appDataFolder).
//
// Client OAuth « XYVEL Medical Desktop » PARTAGÉ par tout le pack XYVEL Medical
// (même CLIENT_ID/secret pour MigraineLog, SuiviMed, …). Pas de collision : chaque
// app range ses données sous un nom de fichier distinct (suivimed.json ici).
// Loopback 127.0.0.1 → aucune collision de redirection entre apps desktop.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { shell, app } = require("electron");

const CLIENT_ID = "644188289084-d05tfel93f2vqg71qr17rhnes7sob9ff.apps.googleusercontent.com";
const SCOPE = "openid email https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "suivimed.json"; // dans appDataFolder

function clientSecret() {
  if (process.env.GOOGLE_CLIENT_SECRET) return process.env.GOOGLE_CLIENT_SECRET;
  try { return fs.readFileSync(path.join(__dirname, "google-secret.txt"), "utf8").trim(); } catch { return ""; }
}
const tokenFile = () => path.join(app.getPath("userData"), "google-tokens.json");

let tokens = null;
function loadTokens() {
  if (tokens) return tokens;
  try { tokens = JSON.parse(fs.readFileSync(tokenFile(), "utf8")); } catch { tokens = null; }
  return tokens;
}
function saveTokens(t) { tokens = t; fs.writeFileSync(tokenFile(), JSON.stringify(t), "utf8"); }
function clearTokens() { tokens = null; try { fs.unlinkSync(tokenFile()); } catch {} }

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Page affichée dans le navigateur après le retour OAuth
function resultPage(ok) {
  const color = ok ? "#2e9e44" : "#d4493f";
  const tint  = ok ? "#e7f4ea" : "#fdecea";
  const icon  = ok
    ? '<path d="M5 12l5 5L20 7"/>'
    : '<path d="M6 6l12 12M18 6L6 18"/>';
  const title = ok ? "Connexion réussie" : "Connexion annulée";
  const sub   = ok
    ? "Tu peux fermer cet onglet et revenir à <strong>SuiviMed</strong>."
    : "Aucun accès accordé. Tu peux fermer cet onglet.";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>SuiviMed</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f6f8;display:flex;min-height:100vh;align-items:center;justify-content:center">
  <div style="background:#fff;border-radius:18px;padding:44px 52px;box-shadow:0 6px 30px rgba(0,0,0,.09);text-align:center;max-width:380px">
    <div style="width:68px;height:68px;border-radius:50%;background:${tint};display:flex;align-items:center;justify-content:center;margin:0 auto 22px">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
    </div>
    <h1 style="margin:0 0 10px;font-size:21px;color:#1a1a1a">${title}</h1>
    <p style="margin:0;color:#666;font-size:14px;line-height:1.55">${sub}</p>
  </div>
</body></html>`;
}

async function exchangeCode(code, verifier, redirectUri) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: clientSecret(), code,
      code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri,
    }),
  });
  if (!r.ok) throw new Error("Échange du code échoué : " + (await r.text()));
  const j = await r.json();
  return { access_token: j.access_token, refresh_token: j.refresh_token, expiry: Date.now() + j.expires_in * 1000 };
}

async function refresh() {
  const t = loadTokens();
  if (!t?.refresh_token) throw new Error("Non connecté");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: clientSecret(),
      refresh_token: t.refresh_token, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error("Rafraîchissement échoué : " + (await r.text()));
  const j = await r.json();
  saveTokens({ ...t, access_token: j.access_token, expiry: Date.now() + j.expires_in * 1000 });
  return tokens.access_token;
}

async function accessToken() {
  const t = loadTokens();
  if (!t) throw new Error("Non connecté");
  if (Date.now() > t.expiry - 60000) return await refresh();
  return t.access_token;
}

async function getEmail() {
  const at = await accessToken();
  const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: "Bearer " + at } });
  if (!r.ok) return "";
  return (await r.json()).email || "";
}

function signIn() {
  return new Promise((resolve, reject) => {
    if (!clientSecret()) { reject(new Error("Secret Google introuvable (google-secret.txt)")); return; }
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      const state = b64url(crypto.randomBytes(16)); // anti-CSRF : doit revenir intact
      const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
        code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent",
        state,
      });
      let handled = false;
      server.on("request", async (req, res) => {
        const u = new URL(req.url, redirectUri);
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        if (!code && !err) { res.writeHead(204); res.end(); return; }
        if (handled) { res.end(); return; }
        handled = true;
        const stateOk = u.searchParams.get("state") === state;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(resultPage(!!code && !err && stateOk));
        setTimeout(() => { try { server.close(); } catch {} }, 200);
        if (!stateOk) { reject(new Error("Réponse OAuth invalide (state)")); return; }
        if (err || !code) { reject(new Error(err || "Connexion annulée")); return; }
        try {
          saveTokens(await exchangeCode(code, verifier, redirectUri));
          resolve({ connected: true, email: await getEmail() });
        } catch (e) { reject(e); }
      });
      shell.openExternal(authUrl.toString());
    });
  });
}

async function getStatus() {
  const t = loadTokens();
  if (!t?.refresh_token) return { connected: false };
  try { return { connected: true, email: await getEmail() }; }
  catch { return { connected: false }; }
}

function signOut() { clearTokens(); return { connected: false }; }

async function findFile() {
  const at = await accessToken();
  const r = await fetch("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({
    spaces: "appDataFolder", q: `name='${FILE_NAME}'`, fields: "files(id,modifiedTime)",
  }), { headers: { Authorization: "Bearer " + at } });
  if (!r.ok) throw new Error("Drive (liste) : " + (await r.text()));
  return (await r.json()).files?.[0] || null;
}

// Date de dernière modification du fichier distant (sans le télécharger), pour
// décider si un pull est nécessaire avant de charger les données locales.
async function getRemoteTime() {
  const f = await findFile();
  return f?.modifiedTime || null;
}

async function pull() {
  const f = await findFile();
  if (!f) return null;
  const at = await accessToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { Authorization: "Bearer " + at } });
  if (!r.ok) throw new Error("Drive (téléchargement) : " + (await r.text()));
  const blob = await r.json();
  return { ...blob, _remoteModifiedTime: f.modifiedTime };
}

async function push(blob) {
  const at = await accessToken();
  const f = await findFile();
  const metadata = { name: FILE_NAME, ...(f ? {} : { parents: ["appDataFolder"] }) };
  const boundary = "smed" + crypto.randomBytes(8).toString("hex");
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(blob)}\r\n` +
    `--${boundary}--`;
  const url = f
    ? `https://www.googleapis.com/upload/drive/v3/files/${f.id}?uploadType=multipart&fields=modifiedTime`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=modifiedTime`;
  const r = await fetch(url, {
    method: f ? "PATCH" : "POST",
    headers: { Authorization: "Bearer " + at, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error("Drive (envoi) : " + (await r.text()));
  return await r.json();
}

module.exports = { signIn, signOut, getStatus, getRemoteTime, pull, push };
