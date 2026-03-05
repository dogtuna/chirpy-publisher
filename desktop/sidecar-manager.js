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
    this.state = {
      ipfs: { available: false, running: false, source: 'none', error: '', binaryPath: '' },
      ollama: { available: false, running: false, source: 'none', error: '', binaryPath: '', modelReady: false }
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
      await this.ensureOllamaModel(null);
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

      await this.waitFor(async () => this.ollamaResponding(), 20000, 500);
      this.state.ollama = { ...this.state.ollama, available: true, running: true, source: 'bundled', error: '' };
      await this.ensureOllamaModel(ollamaBin);
    } catch (error) {
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

  async ensureOllamaModel(ollamaBin) {
    const modelName = 'nomic-embed-text';
    const tags = await this.fetchOllamaTags();
    const exists = tags.some((tag) => String(tag.name || '').startsWith(`${modelName}:`) || tag.name === modelName);
    if (exists) {
      this.state.ollama.modelReady = true;
      return;
    }

    this.state.ollama.modelReady = false;
    if (!ollamaBin) return;

    spawn(ollamaBin, ['pull', modelName], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env },
      detached: false
    }).on('exit', async () => {
      const next = await this.fetchOllamaTags();
      const ready = next.some((tag) => String(tag.name || '').startsWith(`${modelName}:`) || tag.name === modelName);
      this.state.ollama.modelReady = ready;
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
  }

  async shutdown() {
    await this.stopChild(this.ipfsProcess);
    await this.stopChild(this.ollamaProcess);
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
}

module.exports = { SidecarManager };
