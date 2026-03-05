const fs = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');

class SidecarManager {
  constructor({ userDataPath, resourcesPath, isPackaged }) {
    this.userDataPath = userDataPath;
    this.resourcesPath = resourcesPath;
    this.isPackaged = Boolean(isPackaged);
    this.ipfsProcess = null;
    this.ollamaProcess = null;
    this.ollamaPulls = new Map();
    this.ollamaPullProgress = new Map();
    this.state = {
      ipfs: { available: false, running: false, source: 'none', error: '', binaryPath: '' },
      ollama: {
        available: false,
        running: false,
        source: 'none',
        error: '',
        binaryPath: '',
        modelReady: false,
        modelPhase: 'checking',
        modelDetail: '',
        modelProgress: 0
      }
    };
  }

  getStatus() {
    return {
      ipfs: { ...this.state.ipfs },
      ollama: { ...this.state.ollama }
    };
  }

  async ensureStarted() {
    await fs.mkdir(this.userDataPath, { recursive: true });
    await this.ensureIpfs();
    await this.ensureOllama();
  }

  async ensureIpfs() {
    const ipfsBin = this.resolveBinary('ipfs');
    this.state.ipfs.binaryPath = ipfsBin || '';
    const ipfsPath = this.getIpfsPath();
    await fs.mkdir(ipfsPath, { recursive: true });

    if (await this.ipfsResponding(ipfsBin)) {
      this.state.ipfs = { ...this.state.ipfs, available: true, running: true, source: 'external', error: '' };
      return;
    }

    if (!ipfsBin) {
      this.state.ipfs = {
        ...this.state.ipfs,
        available: false,
        running: false,
        source: 'none',
        error: 'bundled ipfs binary missing'
      };
      return;
    }

    try {
      await this.ensureExecutable(ipfsBin);
      await this.ensureIpfsInitialized(ipfsBin, ipfsPath);
      this.ipfsProcess = spawn(ipfsBin, ['daemon', '--migrate=true'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          IPFS_PATH: ipfsPath
        }
      });
      this.ipfsProcess.stderr.on('data', () => null);
      this.ipfsProcess.on('exit', () => {
        this.state.ipfs.running = false;
      });

      await this.waitFor(async () => this.ipfsResponding(ipfsBin), 20000, 500);
      this.state.ipfs = { ...this.state.ipfs, available: true, running: true, source: 'bundled', error: '' };
    } catch (error) {
      this.state.ipfs = {
        ...this.state.ipfs,
        available: true,
        running: false,
        source: 'bundled',
        error: error.message || 'ipfs startup failed'
      };
    }
  }

  async ensureOllama() {
    const ollamaBin = this.resolveBinary('ollama');
    this.state.ollama.binaryPath = ollamaBin || '';

    if (await this.ollamaResponding()) {
      this.state.ollama = { ...this.state.ollama, available: true, running: true, source: 'external', error: '' };
      await this.ensureOllamaModels(ollamaBin || 'ollama');
      return;
    }

    if (!ollamaBin) {
      this.state.ollama = {
        ...this.state.ollama,
        available: false,
        running: false,
        source: 'none',
        error: 'bundled ollama binary missing'
      };
      return;
    }

    const modelsPath = path.join(this.userDataPath, 'ollama-models');
    await fs.mkdir(modelsPath, { recursive: true });
    try {
      await this.ensureExecutable(ollamaBin);
      this.ollamaProcess = spawn(ollamaBin, ['serve'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          OLLAMA_MODELS: modelsPath,
          OLLAMA_HOST: '127.0.0.1:11434'
        }
      });
      this.ollamaProcess.stderr.on('data', () => null);
      this.ollamaProcess.on('exit', () => {
        this.state.ollama.running = false;
      });

      await this.waitFor(async () => this.ollamaResponding(), 60000, 500);
      this.state.ollama = { ...this.state.ollama, available: true, running: true, source: 'bundled', error: '' };
      await this.ensureOllamaModels(ollamaBin);
    } catch (error) {
      const fallbackOk = await this.tryStartExternalOllama();
      if (fallbackOk) {
        this.state.ollama = { ...this.state.ollama, available: true, running: true, source: 'external', error: '' };
        await this.ensureOllamaModels('ollama');
        return;
      }
      this.state.ollama = {
        ...this.state.ollama,
        available: true,
        running: false,
        source: 'bundled',
        error: error.message || 'ollama startup failed',
        modelReady: false
      };
    }
  }

  async tryStartExternalOllama() {
    try {
      this.ollamaProcess = spawn('ollama', ['serve'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' }
      });
      this.ollamaProcess.stderr.on('data', () => null);
      this.ollamaProcess.on('exit', () => {
        this.state.ollama.running = false;
      });
      await this.waitFor(async () => this.ollamaResponding(), 60000, 500);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async ensureOllamaModels(ollamaBin) {
    const requiredModels = Array.from(
      new Set([
        String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim(),
        String(process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim()
      ].filter(Boolean))
    );

    const tags = await this.fetchOllamaTags();
    const missing = requiredModels.filter((modelName) => !this.ollamaModelExists(tags, modelName));
    if (!missing.length) {
      this.state.ollama.modelReady = true;
      this.state.ollama.modelPhase = 'ready';
      this.state.ollama.modelDetail = '';
      this.state.ollama.modelProgress = 100;
      return;
    }

    this.state.ollama.modelReady = false;
    if (!ollamaBin) return;
    this.state.ollama.modelPhase = 'downloading';
    this.state.ollama.modelDetail = `pulling ${missing.join(', ')}`;
    this.state.ollama.modelProgress = this.computeAggregateModelProgress(requiredModels, tags);
    this.state.ollama.error = `pulling models: ${missing.join(', ')}`;

    for (const modelName of missing) {
      if (!this.ollamaPulls.has(modelName)) this.pullOllamaModel(ollamaBin, modelName);
    }
  }

  pullOllamaModel(ollamaBin, modelName) {
    this.pullOllamaModelViaApi(ollamaBin, modelName);
  }

  async pullOllamaModelViaApi(ollamaBin, modelName) {
    if (this.ollamaPulls.has(modelName)) return;
    const controller = new AbortController();
    this.ollamaPulls.set(modelName, controller);
    this.ollamaPullProgress.set(modelName, 0);
    try {
      const response = await fetch('http://127.0.0.1:11434/api/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`api pull failed (${response.status})`);
      }

      await this.consumeNdjsonStream(response.body, (evt) => {
        const pct = this.progressPercentFromEvent(evt);
        if (Number.isFinite(pct)) {
          this.ollamaPullProgress.set(modelName, pct);
        }
        const requiredModels = Array.from(
          new Set([
            String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim(),
            String(process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim()
          ].filter(Boolean))
        );
        this.state.ollama.modelPhase = 'downloading';
        this.state.ollama.modelDetail = String(evt?.status || `pulling ${modelName}`);
        this.state.ollama.modelProgress = this.computeAggregateModelProgress(requiredModels);
      });

      this.ollamaPulls.delete(modelName);
      await this.refreshOllamaModelReadyState();
    } catch (error) {
      this.ollamaPulls.delete(modelName);
      if (error?.name === 'AbortError') return;
      this.pullOllamaModelViaCli(ollamaBin, modelName);
    }
  }

  pullOllamaModelViaCli(ollamaBin, modelName) {
    const child = spawn(ollamaBin, ['pull', modelName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: false
    });
    this.ollamaPulls.set(modelName, child);
    this.ollamaPullProgress.set(modelName, 0);
    const handleData = (chunk) => {
      const text = String(chunk || '').trim();
      if (!text) return;
      const pct = this.extractProgressPercent(text);
      if (Number.isFinite(pct)) {
        this.ollamaPullProgress.set(modelName, pct);
        const requiredModels = Array.from(
          new Set([
            String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim(),
            String(process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim()
          ].filter(Boolean))
        );
        this.state.ollama.modelPhase = 'downloading';
        this.state.ollama.modelDetail = `pulling ${modelName}`;
        this.state.ollama.modelProgress = this.computeAggregateModelProgress(requiredModels);
      }
    };
    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);
    child.on('error', () => {
      this.state.ollama.error = `failed to pull model ${modelName}`;
      this.state.ollama.modelReady = false;
      this.state.ollama.modelPhase = 'error';
      this.state.ollama.modelDetail = `failed to pull ${modelName}`;
      this.ollamaPulls.delete(modelName);
    });
    child.on('exit', async (code, signal) => {
      this.ollamaPulls.delete(modelName);
      if (code && code !== 0) {
        this.state.ollama.modelReady = false;
        this.state.ollama.modelPhase = 'error';
        this.state.ollama.modelDetail = `pull failed: ${modelName}`;
        this.state.ollama.error = `model pull failed (${modelName}) code ${code}${signal ? ` signal ${signal}` : ''}`;
        return;
      }
      const requiredModels = Array.from(
        new Set([
          String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim(),
          String(process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim()
        ].filter(Boolean))
      );
      const next = await this.fetchOllamaTags();
      const ready = requiredModels.every((required) => this.ollamaModelExists(next, required));
      this.state.ollama.modelReady = ready;
      if (ready) {
        this.state.ollama.modelPhase = 'ready';
        this.state.ollama.modelDetail = '';
        this.state.ollama.modelProgress = 100;
        this.state.ollama.error = '';
      } else {
        this.state.ollama.modelPhase = 'downloading';
        this.state.ollama.modelDetail = `waiting for ${requiredModels.join(', ')}`;
        this.state.ollama.modelProgress = this.computeAggregateModelProgress(requiredModels, next);
        this.state.ollama.error = `waiting for models: ${requiredModels.join(', ')}`;
      }
    });
  }

  progressPercentFromEvent(evt) {
    const completed = Number(evt?.completed);
    const total = Number(evt?.total);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
      return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
    }
    const status = String(evt?.status || '').toLowerCase();
    if (status.includes('success')) return 100;
    return NaN;
  }

  async consumeNdjsonStream(stream, onEvent) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            onEvent(parsed);
          } catch (_error) {
            // ignore malformed line
          }
        }
        index = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (!tail) return;
    try {
      const parsed = JSON.parse(tail);
      onEvent(parsed);
    } catch (_error) {
      // ignore malformed tail
    }
  }

  async refreshOllamaModelReadyState() {
    const requiredModels = Array.from(
      new Set([
        String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim(),
        String(process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim()
      ].filter(Boolean))
    );
    const tags = await this.fetchOllamaTags();
    const ready = requiredModels.every((required) => this.ollamaModelExists(tags, required));
    this.state.ollama.modelReady = ready;
    if (ready) {
      this.state.ollama.modelPhase = 'ready';
      this.state.ollama.modelDetail = '';
      this.state.ollama.modelProgress = 100;
      this.state.ollama.error = '';
      return;
    }
    this.state.ollama.modelPhase = 'downloading';
    this.state.ollama.modelDetail = `waiting for ${requiredModels.join(', ')}`;
    this.state.ollama.modelProgress = this.computeAggregateModelProgress(requiredModels, tags);
    this.state.ollama.error = `waiting for models: ${requiredModels.join(', ')}`;
  }

  extractProgressPercent(text) {
    const value = String(text || '');
    const percentMatches = value.match(/(\d{1,3})\s*%/g);
    if (!percentMatches || !percentMatches.length) return NaN;
    let maxSeen = NaN;
    for (const match of percentMatches) {
      const m = String(match).match(/(\d{1,3})/);
      const n = Number(m?.[1]);
      if (!Number.isFinite(n)) continue;
      const bounded = Math.max(0, Math.min(100, n));
      if (!Number.isFinite(maxSeen) || bounded > maxSeen) maxSeen = bounded;
    }
    return maxSeen;
  }

  computeAggregateModelProgress(requiredModels, knownTags) {
    const required = Array.isArray(requiredModels) ? requiredModels.filter(Boolean) : [];
    if (!required.length) return 0;
    const tags = Array.isArray(knownTags) ? knownTags : [];
    let total = 0;
    for (const modelName of required) {
      if (this.ollamaModelExists(tags, modelName)) {
        total += 100;
        continue;
      }
      total += Number(this.ollamaPullProgress.get(modelName) || 0);
    }
    return Math.round(total / required.length);
  }

  ollamaModelExists(tags, modelName) {
    const clean = String(modelName || '').trim();
    if (!clean) return false;
    return tags.some((tag) => {
      const name = String(tag?.name || '').trim();
      return name === clean || name.startsWith(`${clean}:`) || clean.startsWith(`${name}:`);
    });
  }

  async ipfsResponding(ipfsBin) {
    try {
      const apiResp = await fetch('http://127.0.0.1:5001/api/v0/id', { method: 'POST' });
      if (apiResp.ok) return true;
    } catch (_error) {
      // continue with cli probe
    }

    const cli = ipfsBin || 'ipfs';
    try {
      const ipfsPath = this.getIpfsPath();
      await this.execFileSafe(cli, ['id', '-f=<id>'], 4000, { IPFS_PATH: ipfsPath });
      return true;
    } catch (_error) {
      return false;
    }
  }

  async ollamaResponding() {
    try {
      const resp = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
      return resp.ok;
    } catch (_error) {
      return false;
    }
  }

  async fetchOllamaTags() {
    try {
      const resp = await fetch('http://127.0.0.1:11434/api/tags');
      if (!resp.ok) return [];
      const data = await resp.json();
      return Array.isArray(data.models) ? data.models : [];
    } catch (_error) {
      return [];
    }
  }

  async ensureIpfsInitialized(ipfsBin, ipfsPath) {
    const configPath = path.join(ipfsPath, 'config');
    try {
      await fs.stat(configPath);
    } catch (_error) {
      await this.execFileSafe(ipfsBin, ['init', '--profile=server'], 25000, { IPFS_PATH: ipfsPath });
    }

    try {
      await this.execFileSafe(ipfsBin, ['config', '--bool', 'Pubsub.Enabled', 'true'], 5000, { IPFS_PATH: ipfsPath });
    } catch (_error) {
      // tolerate version-specific config differences
    }

    try {
      await this.execFileSafe(ipfsBin, ['config', '--bool', 'Discovery.MDNS.Enabled', 'true'], 5000, { IPFS_PATH: ipfsPath });
    } catch (_error) {
      // tolerate version-specific config differences
    }
  }

  async shutdown() {
    await this.stopChild(this.ipfsProcess);
    await this.stopChild(this.ollamaProcess);
    for (const entry of this.ollamaPulls.values()) {
      if (entry && typeof entry.abort === 'function') entry.abort();
      else await this.stopChild(entry);
    }
    this.ollamaPulls.clear();
    this.ollamaPullProgress.clear();
    this.ipfsProcess = null;
    this.ollamaProcess = null;
  }

  async stopChild(child) {
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (!child.killed) child.kill('SIGKILL');
  }

  getIpfsPath() {
    return path.join(this.userDataPath, 'ipfs-data');
  }

  resolveBinary(name) {
    const platform = process.platform;
    const arch = process.arch;
    const suffix = platform === 'win32' ? '.exe' : '';
    const platformKey = `${platform}-${arch}`;
    const root = this.isPackaged
      ? path.join(this.resourcesPath, 'bin')
      : path.join(__dirname, '..', 'resources', 'bin');
    const direct = path.join(root, platformKey, `${name}${suffix}`);
    const fallback = path.join(root, `${name}${suffix}`);
    return this.firstExisting([direct, fallback]);
  }

  firstExisting(candidates) {
    for (const candidate of candidates) {
      try {
        require('fs').accessSync(candidate);
        return candidate;
      } catch (_error) {
        // continue
      }
    }
    return '';
  }

  async execFileSafe(cmd, args, timeoutMs, envExtra = {}) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, ...envExtra } }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message || '').trim();
          reject(new Error(detail || `${cmd} failed`));
          return;
        }
        resolve(String(stdout || '').trim());
      });
    });
  }

  async waitFor(checkFn, timeoutMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await checkFn();
      if (ok) return true;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('timeout waiting for sidecar');
  }

  async ensureExecutable(filePath) {
    if (!filePath || process.platform === 'win32') return;
    try {
      await fs.chmod(filePath, 0o755);
    } catch (_error) {
      // keep going; spawn will surface real failure
    }
  }
}

module.exports = { SidecarManager };
