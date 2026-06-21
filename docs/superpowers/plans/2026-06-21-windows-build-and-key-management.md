# Windows Build + Built-in Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a downloadable Windows installer for DeepConsole with the `abuddi` backend bundled (no Python needed), and make DeepSeek API-key management a built-in app feature for both from-source and packaged runs.

**Architecture:** A small dependency-injected `keystore.js` module owns the key (encrypted in Electron `userData` via `safeStorage`); `main.js` resolves it (stored key > env) and injects `DEEPSEEK_API_KEY` into the backend child process for both the dev (`python -m uvicorn`) and packaged (bundled exe) launch paths. The backend gets a frozen-friendly `run_backend.py` entrypoint compiled to `abuddi-backend.exe` by PyInstaller; electron-builder bundles it as an extraResource; a Windows CI workflow produces the installer and attaches it to the GitHub Release.

**Tech Stack:** Electron, Node `node:test`, Python/FastAPI/uvicorn, PyInstaller, electron-builder, GitHub Actions (`windows-latest`).

## Global Constraints

- **Working trees (local):** deepconsole public repo = `C:\github\_deepconsole-public-staging` (origin → `superness/deepconsole`); abuddi public repo = `C:\github\_abuddi-public-staging` (origin → `superness/abuddi`).
- **Windows only.** No macOS/Linux targets.
- **No Overmind in the packaged build** — skip its spawn when `app.isPackaged`.
- **Unsigned installer** — no code signing/notarization.
- **Key precedence:** in-app stored key wins; else fall back to `DEEPSEEK_API_KEY` in the environment / `abuddi/.env` (back-compat).
- **Commit author:** `DeepConsole Dev <super.hero.excuse@gmail.com>`.
- **Node tests** run via `npm test` (`node --test`); match the existing DOM-free style in `tests/autonomous.test.js`.
- Target version for the first installer release: **v1.1.0**.

---

### Task 1: Key-store module (`keystore.js`)

A pure, dependency-injected module so it is unit-testable without Electron.

**Files:**
- Create: `keystore.js`
- Test: `tests/keystore.test.js`

**Interfaces:**
- Produces: `makeKeyStore({ configPath, encrypt, decrypt, isEncryptionAvailable, env }) → { setKey(key), getStoredKey(), clearKey(), resolveKey(), maskKey(key), getKeyStatus() }`
  - `getKeyStatus()` → `{ hasKey: boolean, source: 'stored'|'env'|'none', masked: string|null }`
  - `resolveKey()` → `string|null` (stored key, else `env.DEEPSEEK_API_KEY`, else null)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/keystore.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeKeyStore } = require('../keystore');

function tmpConfig() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ks-')), 'config.json');
}
// Plaintext store (encryption unavailable)
function plainStore(env = {}) {
  return makeKeyStore({
    configPath: tmpConfig(),
    encrypt: (s) => Buffer.from(s),
    decrypt: (b) => b.toString(),
    isEncryptionAvailable: () => false,
    env,
  });
}
// Encrypted store (reversible fake cipher)
function encStore(env = {}) {
  const rot = (s) => Buffer.from(s.split('').reverse().join(''));
  return makeKeyStore({
    configPath: tmpConfig(),
    encrypt: rot,
    decrypt: (b) => b.toString().split('').reverse().join(''),
    isEncryptionAvailable: () => true,
    env,
  });
}

test('set then get round-trips the key (plaintext)', () => {
  const ks = plainStore();
  ks.setKey('sk-abcdef123456');
  assert.strictEqual(ks.getStoredKey(), 'sk-abcdef123456');
});

test('set then get round-trips the key (encrypted)', () => {
  const ks = encStore();
  ks.setKey('sk-abcdef123456');
  assert.strictEqual(ks.getStoredKey(), 'sk-abcdef123456');
});

test('encrypted store does not persist the key in plaintext on disk', () => {
  const cfgPath = tmpConfig();
  const rot = (s) => Buffer.from(s.split('').reverse().join(''));
  const ks = makeKeyStore({
    configPath: cfgPath, encrypt: rot,
    decrypt: (b) => b.toString().split('').reverse().join(''),
    isEncryptionAvailable: () => true, env: {},
  });
  ks.setKey('sk-secret-value');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(!raw.includes('sk-secret-value'));
});

test('resolveKey prefers stored over env', () => {
  const ks = plainStore({ DEEPSEEK_API_KEY: 'sk-from-env' });
  ks.setKey('sk-from-store');
  assert.strictEqual(ks.resolveKey(), 'sk-from-store');
});

test('resolveKey falls back to env when nothing stored', () => {
  const ks = plainStore({ DEEPSEEK_API_KEY: 'sk-from-env' });
  assert.strictEqual(ks.resolveKey(), 'sk-from-env');
});

test('clearKey removes the stored key, then env is used', () => {
  const ks = plainStore({ DEEPSEEK_API_KEY: 'sk-from-env' });
  ks.setKey('sk-stored');
  ks.clearKey();
  assert.strictEqual(ks.getStoredKey(), null);
  assert.strictEqual(ks.resolveKey(), 'sk-from-env');
});

test('maskKey shows only a prefix and suffix', () => {
  const ks = plainStore();
  assert.strictEqual(ks.maskKey('sk-abcdef123456'), 'sk-ab…3456');
  assert.strictEqual(ks.maskKey('short'), '****');
  assert.strictEqual(ks.maskKey(null), null);
});

test('getKeyStatus reports source and masked value', () => {
  const ks = plainStore({ DEEPSEEK_API_KEY: 'sk-environment-key' });
  assert.deepStrictEqual(ks.getKeyStatus(), { hasKey: true, source: 'env', masked: 'sk-en…-key' });
  ks.setKey('sk-stored-abcd');
  assert.deepStrictEqual(ks.getKeyStatus(), { hasKey: true, source: 'stored', masked: 'sk-st…abcd' });
  ks.clearKey();
  const empty = makeKeyStore({ configPath: tmpConfig(), encrypt: (s)=>Buffer.from(s), decrypt:(b)=>b.toString(), isEncryptionAvailable:()=>false, env:{} });
  assert.deepStrictEqual(empty.getKeyStatus(), { hasKey: false, source: 'none', masked: null });
});

test('missing/corrupt config file is treated as empty', () => {
  const ks = plainStore();
  assert.strictEqual(ks.getStoredKey(), null); // file does not exist yet
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/_deepconsole-public-staging && node --test tests/keystore.test.js`
Expected: FAIL — `Cannot find module '../keystore'`.

- [ ] **Step 3: Write the minimal implementation**

```javascript
// keystore.js
const fs = require('fs');
const path = require('path');

function makeKeyStore({ configPath, encrypt, decrypt, isEncryptionAvailable, env }) {
  function readConfig() {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch { return {}; }
  }
  function writeConfig(obj) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(obj, null, 2));
  }
  function setKey(key) {
    const cfg = readConfig();
    if (isEncryptionAvailable()) {
      cfg.deepseekKeyEnc = Buffer.from(encrypt(key)).toString('base64');
      delete cfg.deepseekKey;
    } else {
      cfg.deepseekKey = key;
      delete cfg.deepseekKeyEnc;
    }
    writeConfig(cfg);
  }
  function getStoredKey() {
    const cfg = readConfig();
    if (cfg.deepseekKeyEnc) {
      try { return decrypt(Buffer.from(cfg.deepseekKeyEnc, 'base64')); }
      catch { return null; }
    }
    return cfg.deepseekKey || null;
  }
  function clearKey() {
    const cfg = readConfig();
    delete cfg.deepseekKey;
    delete cfg.deepseekKeyEnc;
    writeConfig(cfg);
  }
  function resolveKey() {
    return getStoredKey() || (env && env.DEEPSEEK_API_KEY) || null;
  }
  function maskKey(key) {
    if (!key) return null;
    if (key.length <= 8) return '****';
    return key.slice(0, 5) + '…' + key.slice(-4);
  }
  function getKeyStatus() {
    const stored = getStoredKey();
    const resolved = resolveKey();
    return {
      hasKey: !!resolved,
      source: stored ? 'stored' : (resolved ? 'env' : 'none'),
      masked: maskKey(resolved),
    };
  }
  return { setKey, getStoredKey, clearKey, resolveKey, maskKey, getKeyStatus };
}

module.exports = { makeKeyStore };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/keystore.test.js`
Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add keystore.js tests/keystore.test.js
git commit -m "feat: dependency-injected DeepSeek key store with safeStorage support"
```

---

### Task 2: Wire the key store into `main.js` + expose via preload

**Files:**
- Modify: `main.js` (add require + instantiation near other requires; add IPC handlers near existing `ipcMain.handle` block)
- Modify: `preload.js` (add `config` to the exposed `deepconsole` API)

**Interfaces:**
- Consumes: `makeKeyStore` from Task 1.
- Produces: a module-scoped `keyStore` in `main.js`; IPC channels `config:getKeyStatus`, `config:setKey`, `config:clearKey`; renderer API `window.deepconsole.config.{getKeyStatus,setKey,clearKey}`.

- [ ] **Step 1: Instantiate the key store in `main.js`**

Add near the top of `main.js`, after the existing `const { app, ... } = require('electron')` and `path` requires:

```javascript
const { safeStorage } = require('electron');
const { makeKeyStore } = require('./keystore');

let keyStore; // initialized in app.whenReady (needs app.getPath)
function initKeyStore() {
  keyStore = makeKeyStore({
    configPath: path.join(app.getPath('userData'), 'deepconsole-config.json'),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    env: process.env,
  });
}
```

Call `initKeyStore();` as the first line inside the existing `app.whenReady().then(...)` callback (before windows/servers are created).

- [ ] **Step 2: Add IPC handlers**

Add alongside the other `ipcMain.handle(...)` registrations in `main.js`:

```javascript
ipcMain.handle('config:getKeyStatus', () => keyStore.getKeyStatus());
ipcMain.handle('config:setKey', (_e, key) => {
  keyStore.setKey(String(key || '').trim());
  return keyStore.getKeyStatus();
});
ipcMain.handle('config:clearKey', () => {
  keyStore.clearKey();
  return keyStore.getKeyStatus();
});
```

- [ ] **Step 3: Expose the API in `preload.js`**

Inside the `contextBridge.exposeInMainWorld('deepconsole', { ... })` object, add a `config` key:

```javascript
config: {
  getKeyStatus: () => ipcRenderer.invoke('config:getKeyStatus'),
  setKey: (key) => ipcRenderer.invoke('config:setKey', key),
  clearKey: () => ipcRenderer.invoke('config:clearKey'),
},
```

- [ ] **Step 4: Verify it loads (smoke)**

Run: `cd C:/github/_deepconsole-public-staging && node -e "require('./keystore'); console.log('keystore loads')"`
Expected: prints `keystore loads` (confirms no syntax error in the new module path; full IPC is verified manually in Task 4).

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat: expose key store over IPC as window.deepconsole.config"
```

---

### Task 3: Inject the resolved key into the backend spawn (dev path) + centralize spawning

**Files:**
- Modify: `main.js` (`startLLMServer` ~line 45-55)

**Interfaces:**
- Consumes: `keyStore.resolveKey()` from Task 2.
- Produces: `spawnBackend(env)` helper used by `startLLMServer`; backend child env always carries `DEEPSEEK_API_KEY` when a key resolves.

- [ ] **Step 1: Add a `spawnBackend` helper and use it in `startLLMServer`**

Replace the `child_process.spawn('python', ...)` call inside `startLLMServer` so the env includes the resolved key. The current code is:

```javascript
function startLLMServer() {
  const serverPath = path.resolve(__dirname, '..', 'abuddi');
  log(`[LLM] Starting from: ${serverPath}`);
  log(`[LLM] PATH: ${process.env.PATH}`);
  try {
    llmProcess = require('child_process').spawn(
      'python', ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(LLM_PORT)],
      { cwd: serverPath, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: true }
    );
```

Change the `env` to inject the key:

```javascript
function backendEnv() {
  const env = { ...process.env };
  const key = keyStore && keyStore.resolveKey();
  if (key) env.DEEPSEEK_API_KEY = key;
  return env;
}

function startLLMServer() {
  const serverPath = path.resolve(__dirname, '..', 'abuddi');
  log(`[LLM] Starting from: ${serverPath}`);
  try {
    llmProcess = require('child_process').spawn(
      'python', ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(LLM_PORT)],
      { cwd: serverPath, env: backendEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: true }
    );
```

(Leave the rest of `startLLMServer` — stdout/stderr handlers — unchanged.)

- [ ] **Step 2: Verify syntax**

Run: `cd C:/github/_deepconsole-public-staging && node --check main.js`
Expected: no output (exit 0) — `main.js` parses.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat: inject resolved DeepSeek key into the backend process env"
```

---

### Task 4: Renderer first-run key gate + Settings affordance

**Files:**
- Modify: `renderer/index.html` (add a key-gate overlay + a Settings button)
- Modify: `renderer/app.js` (gate logic on load; settings open/save/clear)
- Modify: `renderer/style.css` (overlay styles, reuse existing theme vars)

**Interfaces:**
- Consumes: `window.deepconsole.config.{getKeyStatus,setKey,clearKey}` from Task 2.

- [ ] **Step 1: Add the overlay + settings button markup**

In `renderer/index.html`, just before `</body>`, add:

```html
<div id="key-gate" class="key-gate hidden">
  <div class="key-card">
    <h2>🔑 Connect DeepSeek</h2>
    <p>DeepConsole needs your DeepSeek API key to run. Get one at
       <a href="https://platform.deepseek.com" target="_blank" rel="noopener">platform.deepseek.com</a>.</p>
    <input id="key-input" type="password" placeholder="sk-..." autocomplete="off" />
    <p id="key-error" class="key-error hidden"></p>
    <button id="key-save" class="key-save">Save & Connect</button>
  </div>
</div>
```

Add a small Settings button into the existing header/toolbar (next to the existing controls):

```html
<button id="open-settings" title="Settings" class="icon-btn">⚙️</button>
```

- [ ] **Step 2: Add overlay styles**

Append to `renderer/style.css`:

```css
.key-gate {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(13,14,26,0.92);
  display: flex; align-items: center; justify-content: center;
}
.key-gate.hidden { display: none; }
.key-card {
  background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 28px; width: 420px; max-width: 90vw;
  box-shadow: var(--shadow);
}
.key-card h2 { margin: 0 0 8px; }
.key-card p { color: var(--text-secondary); font-size: 14px; }
.key-card input {
  width: 100%; margin: 12px 0; padding: 10px 12px;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text-primary); font-family: monospace;
}
.key-save {
  width: 100%; padding: 11px; border: none; border-radius: var(--radius);
  background: var(--accent); color: #fff; font-weight: 600; cursor: pointer;
}
.key-save:hover { background: var(--accent-hover); }
.key-error { color: var(--error); font-size: 13px; }
.key-error.hidden { display: none; }
```

- [ ] **Step 3: Add gate + settings logic**

Add to `renderer/app.js` (run on DOMContentLoaded / app init):

```javascript
async function enforceKeyGate() {
  const gate = document.getElementById('key-gate');
  const input = document.getElementById('key-input');
  const err = document.getElementById('key-error');
  const save = document.getElementById('key-save');

  const status = await window.deepconsole.config.getKeyStatus();
  if (!status.hasKey) gate.classList.remove('hidden');

  save.onclick = async () => {
    const val = input.value.trim();
    if (!val.startsWith('sk-')) {
      err.textContent = 'That does not look like a DeepSeek key (expected sk-...).';
      err.classList.remove('hidden');
      return;
    }
    await window.deepconsole.config.setKey(val);
    gate.classList.add('hidden');
    // The backend reads the key at spawn; if it was already up without a key,
    // a full app restart applies it. Inform the user.
    err.classList.add('hidden');
  };

  document.getElementById('open-settings').onclick = async () => {
    const s = await window.deepconsole.config.getKeyStatus();
    const masked = s.masked ? ` (current: ${s.masked}, ${s.source})` : '';
    input.value = '';
    err.textContent = '';
    err.classList.add('hidden');
    document.querySelector('.key-card p').textContent =
      `Update your DeepSeek API key${masked}.`;
    gate.classList.remove('hidden');
  };
}
enforceKeyGate();
```

- [ ] **Step 4: Manual verification (from source, no `.env`)**

Run, with **no** `DEEPSEEK_API_KEY` in env and **no** `abuddi/.env`:
```bash
cd C:/github/_deepconsole-public-staging && npm install && npm start
```
Expected: the key gate appears on launch. Paste a valid `sk-...` key → gate closes; restart the app → chat works (backend got the key via env). Click ⚙️ → gate reopens showing the masked current key.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/app.js renderer/style.css
git commit -m "feat: first-run DeepSeek key gate and settings in the renderer"
```

---

### Task 5: Frozen-friendly backend entrypoint (`abuddi/run_backend.py`)

**Files (in the abuddi repo, `C:\github\_abuddi-public-staging`):**
- Create: `run_backend.py`
- Test: `tests/test_run_backend.py`

**Interfaces:**
- Produces: a runnable module that calls `uvicorn.run(app, host, port)`, reading `--host/--port` from argv or `HOST/PORT` env. Used by PyInstaller in Task 7.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_run_backend.py
import run_backend

def test_parses_host_and_port_from_args():
    args = run_backend.parse_args(["--host", "0.0.0.0", "--port", "9001"])
    assert args.host == "0.0.0.0"
    assert args.port == 9001

def test_defaults_to_localhost_8000(monkeypatch):
    monkeypatch.delenv("HOST", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    args = run_backend.parse_args([])
    assert args.host == "127.0.0.1"
    assert args.port == 8000

def test_env_overrides_defaults(monkeypatch):
    monkeypatch.setenv("HOST", "127.0.0.2")
    monkeypatch.setenv("PORT", "8123")
    args = run_backend.parse_args([])
    assert args.host == "127.0.0.2"
    assert args.port == 8123
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/_abuddi-public-staging && python -m pytest tests/test_run_backend.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'run_backend'`.

- [ ] **Step 3: Write the implementation**

```python
# run_backend.py
"""Frozen-friendly entrypoint for the abuddi backend.

`python -m uvicorn server:app` does not work from a PyInstaller exe, so this
imports the app object and runs uvicorn programmatically.
"""
import argparse
import os


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Run the abuddi backend")
    p.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    import uvicorn
    from server import app
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_run_backend.py -q`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit (abuddi repo)**

```bash
cd C:/github/_abuddi-public-staging
git add run_backend.py tests/test_run_backend.py
git commit -m "feat: frozen-friendly run_backend entrypoint for PyInstaller"
git push origin main
```

---

### Task 6: Packaged-mode backend spawn + skip Overmind when packaged

**Files:**
- Modify: `main.js` (`startLLMServer`, and the Overmind spawn block ~line 70-80)

**Interfaces:**
- Consumes: `backendEnv()` from Task 3.
- Produces: branch on `app.isPackaged` to spawn `process.resourcesPath/abuddi-backend.exe`; Overmind spawn guarded by `!app.isPackaged`.

- [ ] **Step 1: Branch the backend spawn on `app.isPackaged`**

Update `startLLMServer` to choose the command:

```javascript
function startLLMServer() {
  const cp = require('child_process');
  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, 'abuddi-backend.exe');
    log(`[LLM] Starting bundled backend: ${exe}`);
    llmProcess = cp.spawn(
      exe, ['--host', '127.0.0.1', '--port', String(LLM_PORT)],
      { env: backendEnv(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } else {
    const serverPath = path.resolve(__dirname, '..', 'abuddi');
    log(`[LLM] Starting from: ${serverPath}`);
    llmProcess = cp.spawn(
      'python', ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(LLM_PORT)],
      { cwd: serverPath, env: backendEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: true }
    );
  }
  // (existing stdout/stderr handlers below remain unchanged)
```

- [ ] **Step 2: Guard the Overmind spawn**

Find the Overmind spawn (`cp.spawn('python', ['-m','uvicorn','overmind.app:app', ...])`) and wrap its invocation so it is skipped in a packaged app:

```javascript
if (!app.isPackaged) {
  // ...existing ensureSharedService / overmind spawn block...
} else {
  log('[Overmind] Skipped in packaged build (single-instance).');
}
```

- [ ] **Step 3: Verify syntax**

Run: `cd C:/github/_deepconsole-public-staging && node --check main.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat: spawn bundled backend exe when packaged; skip Overmind"
```

---

### Task 7: electron-builder packaging config

**Files:**
- Modify: `package.json` (add `build` block, `dist` script, `electron-builder` devDependency)

**Interfaces:**
- Consumes: a `build/abuddi-backend.exe` produced by PyInstaller (Task 8 / local build).
- Produces: `npm run dist` → `dist/DeepConsole-Setup-<version>.exe`.

- [ ] **Step 1: Add the build config and script**

Edit `package.json`. Set `"version": "1.1.0"`, add the `dist` script, the devDependency, and a `build` block:

```json
{
  "scripts": {
    "start": "electron .",
    "dev": "electron . --dev",
    "test": "node --test",
    "dist": "electron-builder --win"
  },
  "devDependencies": {
    "electron-builder": "^25.1.8"
  },
  "build": {
    "appId": "com.superness.deepconsole",
    "productName": "DeepConsole",
    "directories": { "output": "dist" },
    "files": [
      "main.js", "preload.js", "browser-preload.js",
      "grimoire_ipc_block.js", "keystore.js",
      "renderer/**/*", "package.json"
    ],
    "extraResources": [
      { "from": "build/abuddi-backend.exe", "to": "abuddi-backend.exe" }
    ],
    "win": { "target": "nsis" },
    "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
  }
}
```

(No custom icon in v1 — electron-builder uses the default Electron icon. A branded `build/icon.ico` is a follow-up; add `"icon": "build/icon.ico"` under `win` when one exists.)

- [ ] **Step 2: Verify package.json is valid JSON**

Run: `cd C:/github/_deepconsole-public-staging && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"`
Expected: prints `package.json OK`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: electron-builder Windows config + v1.1.0"
```

---

### Task 8: Windows CI build workflow

**Files:**
- Create: `.github/workflows/build-windows.yml`

**Interfaces:**
- Consumes: `abuddi/run_backend.py` (Task 5), the electron-builder config (Task 7).
- Produces: `DeepConsole-Setup-*.exe` attached to the tag's GitHub Release.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/build-windows.yml
name: Build Windows installer

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    runs-on: windows-latest
    steps:
      - name: Checkout deepconsole
        uses: actions/checkout@v4

      - name: Checkout abuddi backend
        uses: actions/checkout@v4
        with:
          repository: superness/abuddi
          path: abuddi

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Build backend exe (PyInstaller)
        working-directory: abuddi
        run: |
          pip install -r requirements.txt pyinstaller
          pyinstaller --onefile --name abuddi-backend `
            --collect-all uvicorn --collect-all fastapi `
            --distpath ../build run_backend.py

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build installer (electron-builder)
        run: |
          npm install
          npx electron-builder --win --publish never

      - name: Upload installer artifact
        uses: actions/upload-artifact@v4
        with:
          name: DeepConsole-Setup
          path: dist/*.exe

      - name: Attach installer to the release
        if: startsWith(github.ref, 'refs/tags/')
        uses: softprops/action-gh-release@v2
        with:
          files: dist/*.exe
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/build-windows.yml
git commit -m "ci: Windows installer build workflow"
git push origin main
```

- [ ] **Step 3: Dry-run the workflow (no tag yet)**

Run: `gh workflow run build-windows.yml --repo superness/deepconsole`
Then watch: `gh run watch $(gh run list --repo superness/deepconsole --workflow build-windows.yml --limit 1 --json databaseId -q '.[0].databaseId') --repo superness/deepconsole --exit-status`
Expected: the run completes; the `DeepConsole-Setup` artifact is produced. If PyInstaller fails on a hidden import, add `--collect-all <module>` for the named module and re-run.

---

### Task 9: Cut the v1.1.0 release with the installer

**Files:** none (release operation).

- [ ] **Step 1: Tag and release**

```bash
cd C:/github/_deepconsole-public-staging
git tag v1.1.0
git push origin v1.1.0
```

The tag push triggers `build-windows.yml`, which builds and attaches `DeepConsole-Setup-1.1.0.exe` to the release. If the release doesn't yet exist, create it first:

```bash
gh release create v1.1.0 --repo superness/deepconsole --target main \
  --title "DeepConsole v1.1.0" \
  --notes "Adds a downloadable Windows installer (bundled backend, no Python needed) and built-in DeepSeek key management. See https://superness.github.io/deepconsole/"
```

- [ ] **Step 2: Verify the installer is attached**

Run: `gh release view v1.1.0 --repo superness/deepconsole --json assets -q '.assets[].name'`
Expected: includes `DeepConsole-Setup-1.1.0.exe`.

- [ ] **Step 3: Manual install test (clean Windows, no Python)**

Download and run `DeepConsole-Setup-1.1.0.exe` on a machine/profile without Python. Expected: installs, launches, shows the key gate, accepts a DeepSeek key, and chat works.

- [ ] **Step 4: Update onboarding docs**

In `site/index.html`, change the "Download v1.0.0" button to point at `releases/latest` (already does) and add a one-line "Windows installer available" note in the Quickstart intro. Commit and push (the Pages workflow redeploys).

---

## Notes for the implementer

- **Key timing:** the backend reads `DEEPSEEK_API_KEY` at spawn. If the app started without a key and the user enters one in the gate, a full restart guarantees the backend picks it up. A future enhancement could re-spawn the backend immediately on key save; out of scope here.
- **PyInstaller hidden imports:** `--collect-all uvicorn` + `--collect-all fastapi` cover the common cases. If the run fails importing `server`'s transitive deps (e.g. `ddgs`, `openai`), add `--collect-all <name>` for that package.
- **AV false positives:** one-file PyInstaller exes are sometimes flagged. If it becomes a problem, switch to `--onedir` and bundle the folder via `extraResources`.
- **Live 401 handling (deferred):** the spec mentioned routing an invalid-key `401` from DeepSeek back to the gate. Task 4 validates the key *format* (`sk-` prefix) on entry, which catches the common mistake; surfacing a live 401 (key well-formed but rejected) means hooking the renderer's existing chat-error path to re-open the gate. That's left as a small follow-up rather than guessed at here, because it depends on `renderer/app.js`'s current error-event shape — the implementer should wire it once that path is in front of them.
