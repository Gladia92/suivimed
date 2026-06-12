const { app, BrowserWindow, ipcMain, dialog, net, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const os = require("os");
const gdrive = require("./gdrive");

// ── Ollama
const OLLAMA_DIR  = path.join(app.getPath("userData"), "ollama");
const OLLAMA_BIN  = path.join(OLLAMA_DIR, "ollama.exe");
const OLLAMA_URL  = "https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip";
const OLLAMA_ZIP  = path.join(OLLAMA_DIR, "ollama.zip");
const OLLAMA_MODELS_DIR = path.join(OLLAMA_DIR, "models");
const MODEL_NAME  = "llama3.2"; // bon suivi d'instructions en FR
let ollamaProcess = null;

function ensureOllamaDir() {
  if (!fs.existsSync(OLLAMA_DIR)) fs.mkdirSync(OLLAMA_DIR, { recursive: true });
}

function ollamaBinValid() {
  try { return fs.statSync(OLLAMA_BIN).size > 10 * 1024 * 1024; } catch { return false; }
}

// ── Téléchargement via electron net (contourne les restrictions CSP)
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      const request = net.request(u);
      request.on("response", (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          follow(response.headers.location);
          return;
        }
        const total = parseInt(response.headers["content-length"] || "0");
        let received = 0;
        const file = fs.createWriteStream(dest);
        response.on("data", (chunk) => {
          received += chunk.length;
          file.write(chunk);
          if (total) onProgress(Math.round(received / total * 100));
        });
        response.on("end", () => { file.end(); resolve(); });
        response.on("error", (err) => { file.destroy(); reject(err); });
      });
      request.on("error", reject);
      request.end();
    };
    follow(url);
  });
}

// Extrait un .zip via le tar intégré de Windows (bsdtar, présent depuis Win10 1803).
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const tarExe = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe");
    let p;
    try {
      p = spawn(tarExe, ["-xf", zipPath, "-C", destDir], { windowsHide: true });
    } catch (e) {
      reject(new Error("Extraction (tar) — lancement impossible: " + e.message));
      return;
    }
    let err = "";
    p.stderr.on("data", d => { err += d.toString(); });
    p.on("close", code => code === 0 ? resolve() : reject(new Error("Extraction (tar) échouée code " + code + ": " + err)));
    p.on("error", e => reject(new Error("Extraction (tar): " + e.message)));
  });
}

function startOllama() {
  return new Promise((resolve, reject) => {
    try {
      ollamaProcess = spawn(OLLAMA_BIN, ["serve"], {
        env: { ...process.env, OLLAMA_MODELS: OLLAMA_MODELS_DIR },
        detached: false, stdio: "ignore", windowsHide: true
      });
    } catch (e) {
      reject(new Error("Démarrage du moteur (ollama serve) — lancement impossible: " + e.message));
      return;
    }
    ollamaProcess.on("error", e => reject(new Error("Démarrage du moteur (ollama serve): " + e.message)));
    setTimeout(resolve, 2000);
  });
}

function ollamaRunning() {
  return new Promise((resolve) => {
    const req = require("http").get("http://127.0.0.1:11434", () => resolve(true));
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

app.on("before-quit", () => { if (ollamaProcess) ollamaProcess.kill(); });

const isDev = !app.isPackaged;
const DATA_DIR = path.join(os.homedir(), "Documents", "SuiviMed");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function createWindow() {
  const work = screen.getPrimaryDisplay().workAreaSize;
  const CALENDAR_WIDTH = 1390;
  const win = new BrowserWindow({
    width: Math.min(CALENDAR_WIDTH, work.width),
    height: Math.min(900, work.height),
    minWidth: 800,
    minHeight: 600,
    useContentSize: true,
    title: "SuiviMed",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.center();
  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "dist", "index.html"));
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── IPC : lire un fichier de données
ipcMain.handle("read-data", (_e, filename) => {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, "utf8");
});

// ── IPC : écrire un fichier de données
ipcMain.handle("write-data", (_e, filename, content) => {
  fs.writeFileSync(path.join(DATA_DIR, filename), content, "utf8");
  return true;
});

// ── IPC : lister les fichiers de données
ipcMain.handle("list-data", () => {
  return fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
});

// ── IPC : obtenir le dossier de données actuel
ipcMain.handle("get-data-dir", () => DATA_DIR);

// ── IPC : choisir un autre dossier de sauvegarde
ipcMain.handle("choose-data-dir", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(win, {
    title: "Choisir le dossier de sauvegarde SuiviMed",
    defaultPath: DATA_DIR,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// ── IPC : exporter tout en JSON
ipcMain.handle("export-json", async (e, content) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showSaveDialog(win, {
    title: "Exporter les données SuiviMed",
    defaultPath: path.join(os.homedir(), "Downloads", `suivimed_export_${Date.now()}.json`),
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, content, "utf8");
  return true;
});

// ── IPC : importer depuis un fichier JSON
ipcMain.handle("import-json", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(win, {
    title: "Importer des données SuiviMed",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled) return null;
  return fs.readFileSync(result.filePaths[0], "utf8");
});

// ── Synchronisation Google Drive
ipcMain.handle("gdrive-signin",  async () => gdrive.signIn());
ipcMain.handle("gdrive-signout", async () => gdrive.signOut());
ipcMain.handle("gdrive-status",  async () => gdrive.getStatus());

ipcMain.handle("gdrive-remote-time", async () => {
  return { remoteModifiedTime: await gdrive.getRemoteTime() };
});

ipcMain.handle("gdrive-pull", async () => {
  const blob = await gdrive.pull();
  if (!blob || !blob.files) return { ok: false, empty: true };
  for (const [name, content] of Object.entries(blob.files)) {
    if (!name.startsWith("suivimed_") || !name.endsWith(".json")) continue;
    fs.writeFileSync(path.join(DATA_DIR, name), typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  }
  return { ok: true, count: Object.keys(blob.files).length, updatedAt: blob.updatedAt || null, remoteModifiedTime: blob._remoteModifiedTime || null };
});

ipcMain.handle("gdrive-push", async () => {
  const files = {};
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.startsWith("suivimed_") && f.endsWith(".json")) files[f] = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
  }
  const res = await gdrive.push({ updatedAt: Date.now(), files });
  return { ok: true, count: Object.keys(files).length, remoteModifiedTime: res?.modifiedTime || null };
});

// ── IPC : statut Ollama
ipcMain.handle("ollama-status", async () => {
  const running = await ollamaRunning();
  let modelExists = false;
  if (running) {
    try {
      const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const j = await r.json();
        modelExists = (j.models || []).some(m => (m.name || "").startsWith(MODEL_NAME));
      }
    } catch { /* ignore */ }
  }
  if (!modelExists) {
    const modelPath = path.join(OLLAMA_MODELS_DIR, "manifests", "registry.ollama.ai", "library", MODEL_NAME);
    modelExists = fs.existsSync(modelPath);
  }
  const binExists = ollamaBinValid() || running;
  return { binExists, modelExists, running };
});

// ── IPC : setup Ollama (téléchargement moteur + modèle)
ipcMain.handle("ollama-setup", async (e) => {
  const win  = BrowserWindow.fromWebContents(e.sender);
  const send = (step, progress) => win.webContents.send("ollama-progress", { step, progress });

  try {
    ensureOllamaDir();

    if (!ollamaBinValid()) {
      try { if (fs.existsSync(OLLAMA_BIN)) fs.unlinkSync(OLLAMA_BIN); } catch {}
      const haveZip = fs.existsSync(OLLAMA_ZIP) && fs.statSync(OLLAMA_ZIP).size > 1000000;
      if (!haveZip) {
        send("download-ollama", 0);
        await downloadFile(OLLAMA_URL, OLLAMA_ZIP, p => send("download-ollama", p));
      }
      const zsize = fs.existsSync(OLLAMA_ZIP) ? fs.statSync(OLLAMA_ZIP).size : 0;
      if (zsize < 1000000) throw new Error(`Téléchargement du moteur incomplet (${zsize} octets) — URL ou réseau ?`);
      send("extract-ollama", 0);
      await extractZip(OLLAMA_ZIP, OLLAMA_DIR);
      if (!ollamaBinValid()) throw new Error("ollama.exe invalide après extraction");
      try { fs.unlinkSync(OLLAMA_ZIP); } catch {}
    }

    if (!(await ollamaRunning())) {
      send("starting", 0);
      await startOllama();
    }

    const modelPath = path.join(OLLAMA_DIR, "models", "manifests", "registry.ollama.ai", "library", MODEL_NAME);
    if (!fs.existsSync(modelPath)) {
      send("download-model", 0);
      await new Promise((resolve, reject) => {
        const pull = spawn(OLLAMA_BIN, ["pull", MODEL_NAME], {
          env: { ...process.env, OLLAMA_MODELS: OLLAMA_MODELS_DIR },
          windowsHide: true
        });
        pull.stdout.on("data", d => {
          const m = d.toString().match(/(\d+)%/);
          if (m) send("download-model", parseInt(m[1]));
        });
        pull.stderr.on("data", d => {
          const m = d.toString().match(/(\d+)\s*%/);
          if (m) send("download-model", parseInt(m[1]));
        });
        pull.on("close", resolve);
        pull.on("error", e => reject(new Error("Téléchargement du modèle (ollama pull): " + e.message)));
      });
    }

    send("ready", 100);
    return true;
  } catch (err) {
    console.error("ollama-setup error:", err);
    throw err;
  }
});

// ── IPC : démarrer Ollama
ipcMain.handle("ollama-start", async () => {
  if (!(await ollamaRunning())) await startOllama();
  return true;
});

// ── IPC : analyser avec Ollama (API chat = bien meilleur suivi des consignes)
ipcMain.handle("ollama-analyze", async (_e, prompt) => {
  const resp = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_NAME,
      stream: false,
      messages: [
        { role: "system", content: "Tu es un pharmacien clinicien et médecin expérimenté. Tu analyses un journal d'observance médicamenteuse pour aider le médecin traitant. Réponds UNIQUEMENT en français, structuré (titres en MAJUSCULES + tirets). Commence toujours par le titre exact « COMPTE RENDU OBSERVANCE POUR LE MÉDECIN TRAITANT » (même casse, sans le reformuler).\n\nMéthode d'analyse :\n1) Identifie d'abord LES POINTS LES PLUS IMPORTANTS pour CE patient précis (utilise la section SIGNAUX et les chiffres par moment matin/midi/soir) et commence par eux.\n2) Chaque affirmation doit s'appuyer sur un chiffre du journal (taux d'observance, nombre d'oublis, moment ou médicament concerné). Interdiction des généralités creuses.\n3) Sois CIBLÉ et CONCIS : pas de remplissage. Si une rubrique n'a rien de notable, écris « RAS ».\n4) Raisonne sur les MOLÉCULES réelles citées : cohérence de la posologie pour le profil (âge, poids, antécédents), surdosage/sous-dosage, interactions plausibles avec le traitement de fond.\n5) Tu peux SUGGÉRER des pistes d'ajustement ou des alternatives thérapeutiques À DISCUTER avec le médecin, toujours en rappelant explicitement que ce sont des suggestions et JAMAIS une prescription.\n\nN'invente aucune donnée, ne recopie pas la consigne, reste prudent et signale l'insuffisance de données le cas échéant." },
        { role: "user", content: prompt }
      ],
      options: { temperature: 0.3, num_ctx: 8192, num_predict: 1400 }
    })
  });
  if (!resp.ok) throw new Error("Ollama HTTP " + resp.status);
  const json = await resp.json();
  return json.message?.content || "";
});
