// Synchronisation Google Drive côté MOBILE (Capacitor).
// Flux OAuth PKCE via le navigateur système (client iOS, pas de secret),
// retour par schéma personnalisé. Stockage = localStorage (comme le journal).
//
// NOTE : on réutilise le projet Google de MigraineLog (mêmes identifiants OAuth).
// Les données de SuiviMed sont rangées dans le MÊME appDataFolder privé mais
// sous un nom de fichier distinct (suivimed.json), donc aucune collision.
import { Browser } from "@capacitor/browser";
import { App } from "@capacitor/app";
import { Preferences } from "@capacitor/preferences";

const CLIENT_ID = "644188289084-cpfi4g5pdt2oneccorbd43qso72bckck.apps.googleusercontent.com";
const REDIRECT  = "com.googleusercontent.apps.644188289084-cpfi4g5pdt2oneccorbd43qso72bckck:/oauth2redirect";
const SCOPE     = "openid email https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "suivimed.json";
const TOKEN_KEY = "gdrive_tokens";

async function loadTokens() {
  const { value } = await Preferences.get({ key: TOKEN_KEY });
  return value ? JSON.parse(value) : null;
}
const saveTokens  = (t) => Preferences.set({ key: TOKEN_KEY, value: JSON.stringify(t) });
const clearTokens = () => Preferences.remove({ key: TOKEN_KEY });

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function randomVerifier() { const a = new Uint8Array(32); crypto.getRandomValues(a); return b64url(a.buffer); }
async function challenge(v) { return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))); }

async function exchange(code, verifier) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: REDIRECT }),
  });
  if (!r.ok) throw new Error("Échange du code : " + (await r.text()));
  const j = await r.json();
  return { access_token: j.access_token, refresh_token: j.refresh_token, expiry: Date.now() + j.expires_in * 1000 };
}
async function refresh() {
  const t = await loadTokens();
  if (!t?.refresh_token) throw new Error("Non connecté");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, refresh_token: t.refresh_token, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw new Error("Rafraîchissement : " + (await r.text()));
  const j = await r.json();
  const nt = { ...t, access_token: j.access_token, expiry: Date.now() + j.expires_in * 1000 };
  await saveTokens(nt);
  return nt.access_token;
}
async function accessToken() {
  const t = await loadTokens();
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

export async function signIn() {
  const verifier = randomVerifier();
  const chal = await challenge(verifier);
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE,
    code_challenge: chal, code_challenge_method: "S256", access_type: "offline", prompt: "consent",
  });
  return new Promise((resolve, reject) => {
    let done = false;
    App.addListener("appUrlOpen", async ({ url }) => {
      if (!url || (url.indexOf("code=") === -1 && url.indexOf("error=") === -1)) return;
      if (done) return; done = true;
      await Browser.close().catch(() => {});
      try {
        const u = new URL(url);
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        if (err || !code) { reject(new Error(err || "Connexion annulée")); return; }
        await saveTokens(await exchange(code, verifier));
        resolve({ connected: true, email: await getEmail() });
      } catch (e) { reject(e); }
    }).catch(reject);
    Browser.open({ url: authUrl }).catch(reject);
  });
}

export async function getStatus() {
  const t = await loadTokens();
  if (!t?.refresh_token) return { connected: false };
  try { return { connected: true, email: await getEmail() }; } catch { return { connected: false }; }
}
export async function signOut() { await clearTokens(); return { connected: false }; }

async function findFile() {
  const at = await accessToken();
  const r = await fetch("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({
    spaces: "appDataFolder", q: `name='${FILE_NAME}'`, fields: "files(id)",
  }), { headers: { Authorization: "Bearer " + at } });
  if (!r.ok) throw new Error("Drive (liste) : " + (await r.text()));
  return (await r.json()).files?.[0] || null;
}
async function pullBlob() {
  const f = await findFile();
  if (!f) return null;
  const at = await accessToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { Authorization: "Bearer " + at } });
  if (!r.ok) throw new Error("Drive (téléchargement) : " + (await r.text()));
  return await r.json();
}
async function pushBlob(blob) {
  const at = await accessToken();
  const f = await findFile();
  const metadata = { name: FILE_NAME, ...(f ? {} : { parents: ["appDataFolder"] }) };
  const boundary = "smed" + Math.random().toString(16).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(blob)}\r\n` +
    `--${boundary}--`;
  const url = f
    ? `https://www.googleapis.com/upload/drive/v3/files/${f.id}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const r = await fetch(url, { method: f ? "PATCH" : "POST", headers: { Authorization: "Bearer " + at, "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  if (!r.ok) throw new Error("Drive (envoi) : " + (await r.text()));
  return true;
}

// pull/push opèrent sur localStorage (mêmes clés que le journal)
export async function pull() {
  const blob = await pullBlob();
  if (!blob || !blob.files) return { ok: false, empty: true };
  for (const [name, content] of Object.entries(blob.files)) {
    if (name.startsWith("suivimed_") && name.endsWith(".json")) {
      localStorage.setItem(name, typeof content === "string" ? content : JSON.stringify(content));
    }
  }
  return { ok: true, count: Object.keys(blob.files).length };
}
export async function push() {
  const files = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("suivimed_") && k.endsWith(".json")) files[k] = localStorage.getItem(k);
  }
  await pushBlob({ updatedAt: Date.now(), files });
  return { ok: true, count: Object.keys(files).length };
}
