const fs = require('fs/promises');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { SidecarManager } = require('./sidecar-manager');

const PORT = Number.parseInt(process.env.PORT || '3020', 10);
const HOST = '127.0.0.1';
const SERVER_URL = `http://${HOST}:${PORT}`;

let mainWindow = null;
let serverChild = null;
let sidecars = null;

const desktopProfilePath = () => path.join(app.getPath('userData'), 'chirpy-desktop-profile.json');

app.whenReady().then(async () => {
  sidecars = new SidecarManager({
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged
  });

  await sidecars.ensureStarted();
  await ensureServerRunning();
  installIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await stopServer();
  if (sidecars) await sidecars.shutdown();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadURL(`${SERVER_URL}/chirpspace.html`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

async function ensureServerRunning() {
  if (await serverHealthy()) return;

  const serverEntry = path.join(app.getAppPath(), 'src', 'server.js');
  const sidecarStatus = sidecars ? sidecars.getStatus() : null;
  const ipfsSource = String(sidecarStatus?.ipfs?.source || '').trim();
  const ipfsBinary = String(sidecarStatus?.ipfs?.binaryPath || '').trim();
  const ipfsCmd = ipfsSource === 'external' ? 'ipfs' : (ipfsBinary || 'ipfs');
  serverChild = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT),
      CHIRPY_BIND_HOST: HOST,
      CHIRPY_IPFS_BIN: ipfsCmd,
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      IPFS_PATH: path.join(app.getPath('userData'), 'ipfs-data')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverChild.stdout.on('data', () => null);
  serverChild.stderr.on('data', () => null);
  serverChild.on('exit', () => {
    serverChild = null;
  });

  await waitFor(async () => serverHealthy(), 20000, 350);
}

async function stopServer() {
  if (!serverChild || serverChild.killed) return;
  serverChild.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (!serverChild.killed) serverChild.kill('SIGKILL');
}

async function serverHealthy() {
  try {
    const resp = await fetch(`${SERVER_URL}/health`);
    return resp.ok;
  } catch (_error) {
    return false;
  }
}

function installIpcHandlers() {
  ipcMain.handle('chirpy:desktop-status', async () => {
    return {
      ok: true,
      serverUrl: SERVER_URL,
      serverRunning: await serverHealthy(),
      sidecars: sidecars ? sidecars.getStatus() : null
    };
  });

  ipcMain.handle('chirpy:get-profile', async () => {
    const data = await readJsonFile(desktopProfilePath());
    return { ok: true, profile: data || null };
  });

  ipcMain.handle('chirpy:save-profile', async (_event, payload) => {
    const nickname = normalizeNickname(payload?.nickname);
    const interests = normalizeInterests(payload?.interests);
    if (!nickname) {
      return { ok: false, error: 'Nickname must be 2-40 characters.' };
    }
    if (interests.length < 3) {
      return { ok: false, error: 'Choose at least 3 interests.' };
    }
    const profile = {
      nickname,
      interests,
      updatedAt: new Date().toISOString()
    };
    await writeJsonFile(desktopProfilePath(), profile);
    return { ok: true, profile };
  });

  ipcMain.handle('chirpy:semantic-match', async (_event, payload) => {
    const interests = normalizeInterests(payload?.interests);
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    const matches = await semanticMatch(interests, candidates);
    return { ok: true, matches };
  });
}

async function semanticMatch(interests, candidates) {
  if (!interests.length || !candidates.length) return [];
  const query = interests.join(', ');
  const useEmbeddings = await ollamaEmbeddingAvailable();

  if (useEmbeddings) {
    const queryVec = await getEmbedding(query);
    if (queryVec.length) {
      const out = [];
      for (const candidate of candidates) {
        const text = normalizeCandidateText(candidate);
        if (!text) continue;
        const vec = await getEmbedding(text);
        const score = cosineSimilarity(queryVec, vec);
        if (score > 0.35) {
          out.push({ id: String(candidate.id || ''), score, reason: 'semantic' });
        }
      }
      return out.sort((a, b) => b.score - a.score);
    }
  }

  return candidates
    .map((candidate) => {
      const tags = normalizeInterests(candidate?.tags || []);
      const overlap = tags.filter((tag) => interests.includes(tag)).length;
      const score = interests.length ? overlap / interests.length : 0;
      return { id: String(candidate?.id || ''), score, reason: 'keyword' };
    })
    .filter((x) => x.id && x.score > 0)
    .sort((a, b) => b.score - a.score);
}

async function ollamaEmbeddingAvailable() {
  try {
    const resp = await fetch('http://127.0.0.1:11434/api/tags');
    if (!resp.ok) return false;
    const data = await resp.json();
    const models = Array.isArray(data.models) ? data.models : [];
    return models.some((m) => String(m.name || '').startsWith('nomic-embed-text:') || m.name === 'nomic-embed-text');
  } catch (_error) {
    return false;
  }
}

async function getEmbedding(input) {
  try {
    const resp = await fetch('http://127.0.0.1:11434/api/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: input })
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data.embedding) ? data.embedding : [];
  } catch (_error) {
    return [];
  }
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalizeCandidateText(candidate) {
  const tags = normalizeInterests(candidate?.tags || []);
  const name = String(candidate?.name || '').trim().toLowerCase();
  return [name, ...tags].filter(Boolean).join(', ');
}

function normalizeNickname(value) {
  const out = String(value || '').trim().replace(/\s+/g, ' ');
  if (out.length < 2 || out.length > 40) return '';
  return out;
}

function normalizeInterests(values) {
  const arr = Array.isArray(values)
    ? values
    : String(values || '')
        .split(',')
        .map((x) => x.trim());
  return Array.from(
    new Set(
      arr
        .map((x) => String(x || '').trim().toLowerCase())
        .filter(Boolean)
        .map((x) => x.slice(0, 40))
    )
  );
}

async function waitFor(checkFn, timeoutMs, intervalMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timeout waiting for server');
}

async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (_error) {
    return null;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, 'utf8');
}
