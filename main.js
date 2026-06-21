const { app, BrowserWindow, ipcMain, session, dialog, Menu, clipboard, safeStorage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
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

// ─── File logger ──────────────────────────────────────────────────────────
const LOG_FILE = path.join(require('os').homedir(), 'deepconsole.log');
const _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  _logStream.write(line);
}

// ─── LocallLM Server Manager ──────────────────────────────────────────────
let llmProcess = null;
const LLM_PORT = 8000;
const DEEPCONSOLE_DIR = __dirname;

const OVERMIND_PORT = 9200;
let overmindProcess = null;

// Resolve true if something already answers /health on `port`, else false.
function isServiceUp(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

// Spawn `spawnFn` only if no service is already listening on `port`.
async function ensureSharedService(name, port, spawnFn) {
  if (await isServiceUp(port)) {
    log(`[${name}] Already up on ${port} — attaching.`);
    return null;
  }
  log(`[${name}] Not found on ${port} — spawning.`);
  return spawnFn();
}

function startLLMServer() {
  const serverPath = path.resolve(__dirname, '..', 'abuddi');
  log(`[LLM] Starting from: ${serverPath}`);
  log(`[LLM] PATH: ${process.env.PATH}`);
  try {
    llmProcess = require('child_process').spawn(
      'python', ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(LLM_PORT)],
      { cwd: serverPath, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: true }
    );
    llmProcess.stdout.on('data', (data) => { const text = data.toString().trim(); if (text) log(`[LLM] ${text}`); });
    llmProcess.stderr.on('data', (data) => { const text = data.toString().trim(); if (text) log(`[LLM] ${text}`); });
    llmProcess.on('close', (code) => { log(`[LLM] Process exited with code ${code}`); llmProcess = null; });
    llmProcess.on('error', (err) => { log(`[LLM] Failed to start: ${err.message}`); llmProcess = null; });
  } catch (err) {
    log(`[LLM] Error starting server: ${err.message}`);
  }
}

function stopLLMServer() {
  if (llmProcess) {
    log('[lifecycle] stopLLMServer: THIS arm owns the shared backend - killing it (affects ALL arms)');
    llmProcess.kill('SIGTERM');
    setTimeout(() => { if (llmProcess) { llmProcess.kill('SIGKILL'); llmProcess = null; } }, 3000);
  } else {
    log('[lifecycle] stopLLMServer: no-op (attached arm; shared backend left running) - this arm\'s session is NOT stopped here');
  }
}

function startOvermind() {
  const overmindCwd = __dirname; // overmind package lives in this repo
  overmindProcess = require('child_process').spawn(
    'python', ['-m', 'uvicorn', 'overmind.app:app', '--host', '127.0.0.1', '--port', String(OVERMIND_PORT)],
    { cwd: overmindCwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: true }
  );
  overmindProcess.stdout.on('data', (d) => { const t = d.toString().trim(); if (t) log(`[Overmind] ${t}`); });
  overmindProcess.stderr.on('data', (d) => { const t = d.toString().trim(); if (t) log(`[Overmind] ${t}`); });
  overmindProcess.on('close', (code) => { log(`[Overmind] exited ${code}`); overmindProcess = null; });
  overmindProcess.on('error', (err) => { log(`[Overmind] failed: ${err.message}`); overmindProcess = null; });
}

function stopOvermind() {
  if (overmindProcess) { overmindProcess.kill('SIGTERM'); overmindProcess = null; }
}

// ─── Browser Console Log Buffer ────────────────────────────────────────────
let browserApiPort = 0; // OS-assigned at listen time
const browserConsoleLogs = [];
const MAX_CONSOLE_LOGS = 500;

function pushConsoleLog(entry) {
  browserConsoleLogs.push(entry);
  if (browserConsoleLogs.length > MAX_CONSOLE_LOGS) browserConsoleLogs.splice(0, browserConsoleLogs.length - MAX_CONSOLE_LOGS);
}

// ─── Webview Helpers ───────────────────────────────────────────────────────
function webviewExecuteJS(code) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) return reject(new Error('Main window not available'));
    const id = Date.now() + Math.random();
    const handler = (_event, result) => {
      if (result.id === id) {
        ipcMain.removeListener('webview:executeJSResult', handler);
        if (result.error) reject(new Error(result.error)); else resolve(result.result);
      }
    };
    ipcMain.on('webview:executeJSResult', handler);
    setTimeout(() => { ipcMain.removeListener('webview:executeJSResult', handler); reject(new Error('webview executeJS timeout')); }, 30000);
    mainWindow.webContents.send('webview:executeJS', { id, code });
  });
}

function webviewNavigate(url) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) return reject(new Error('Main window not available'));
    const id = Date.now() + Math.random();
    const handler = (_event, result) => {
      if (result.id === id) {
        ipcMain.removeListener('webview:navigateResult', handler);
        if (result.error) reject(new Error(result.error)); else resolve(result.result);
      }
    };
    ipcMain.on('webview:navigateResult', handler);
    setTimeout(() => { ipcMain.removeListener('webview:navigateResult', handler); reject(new Error('webview navigate timeout')); }, 30000);
    mainWindow.webContents.send('webview:navigate', { id, url });
  });
}

function webviewGetURL() {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) return reject(new Error('Main window not available'));
    const id = Date.now() + Math.random();
    const handler = (_event, result) => {
      if (result.id === id) {
        ipcMain.removeListener('webview:getURLResult', handler);
        if (result.error) reject(new Error(result.error)); else resolve(result.url);
      }
    };
    ipcMain.on('webview:getURLResult', handler);
    setTimeout(() => { ipcMain.removeListener('webview:getURLResult', handler); reject(new Error('webview getURL timeout')); }, 10000);
    mainWindow.webContents.send('webview:getURL', { id });
  });
}

function webviewCapture(savePath) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) return reject(new Error('Main window not available'));
    const id = Date.now() + Math.random();
    const handler = (_event, result) => {
      if (result.id !== id) return;
      ipcMain.removeListener('webview:captureResult', handler);
      if (result.error) return reject(new Error(result.error));
      try {
        const b64 = String(result.dataURL || '').replace(/^data:image\/png;base64,/, '');
        if (!b64) return reject(new Error('empty capture'));
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, Buffer.from(b64, 'base64'));
        resolve(savePath);
      } catch (e) { reject(e); }
    };
    ipcMain.on('webview:captureResult', handler);
    setTimeout(() => { ipcMain.removeListener('webview:captureResult', handler); reject(new Error('webview capture timeout')); }, 30000);
    mainWindow.webContents.send('webview:capture', { id });
  });
}

// ─── Browser API HTTP Server ──────────────────────────────────────────────
function startBrowserApiServer() {
  const srv = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const url = req.url.split('?')[0];
        const qs = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
        if (req.method === 'POST' && url === '/browser/open') {
          try { await webviewNavigate(data.url || 'https://google.com'); res.end(JSON.stringify({ ok: true })); }
          catch (err) { res.end(JSON.stringify({ error: err.message })); }
        } else if (req.method === 'POST' && url === '/browser/navigate') {
          try { await webviewNavigate(data.url); res.end(JSON.stringify({ ok: true })); }
          catch (err) { res.end(JSON.stringify({ error: err.message })); }
        } else if (req.method === 'POST' && url === '/browser/execute') {
          try {
            const result = await webviewExecuteJS(data.code);
            let serialized;
            try { serialized = JSON.parse(JSON.stringify(result)); } catch (_) { serialized = String(result); }
            res.end(JSON.stringify({ ok: true, result: serialized }));
          } catch (err) { res.end(JSON.stringify({ ok: false, error: err.message })); }
        } else if (req.method === 'GET' && url === '/browser/url') {
          try { const currentUrl = await webviewGetURL(); res.end(JSON.stringify({ url: currentUrl })); }
          catch (err) { res.end(JSON.stringify({ url: 'about:blank' })); }
        } else if (req.method === 'GET' && url === '/browser/logs') {
          const limit = parseInt(qs.get('limit') || '100', 10);
          res.end(JSON.stringify({ logs: browserConsoleLogs.slice(-limit) }));
        } else if (req.method === 'POST' && url === '/browser/logs/clear') {
          browserConsoleLogs.length = 0;
          res.end(JSON.stringify({ ok: true }));
        } else if (req.method === 'POST' && url === '/browser/screenshot') {
          try {
            const savePath = data.path || path.join(app.getPath('temp'), `shot-${Date.now()}.png`);
            const saved = await webviewCapture(savePath);
            res.end(JSON.stringify({ ok: true, path: saved }));
          } catch (err) { res.end(JSON.stringify({ ok: false, error: err.message })); }
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (err) { res.statusCode = 500; res.end(JSON.stringify({ error: err.message })); }
    });
  });
  srv.listen(0, '127.0.0.1', () => {
    browserApiPort = srv.address().port;
    log(`[DeepConsole] Browser API server listening on port ${browserApiPort}`);
  });
  srv.on('error', (err) => { console.error(`[DeepConsole] Browser API server error: ${err.message}`); });
}

// ─── Main Window ──────────────────────────────────────────────────────────
let mainWindow;
let mainWindowWebContents = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 700,
    title: 'DeepConsole', backgroundColor: '#1a1b2e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true,
      // Forward launch flags (e.g. --autonomous from the fleet manager) into the renderer's process.argv.
      additionalArguments: process.argv.includes('--autonomous') ? ['--autonomous'] : [] },
  });
  mainWindow.loadFile('renderer/index.html');
  mainWindowWebContents = mainWindow.webContents;
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', enabled: params.selectionText.length > 0, click: () => clipboard.writeText(params.selectionText) },
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => mainWindow.webContents.selectAll() },
      { type: 'separator' },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', enabled: params.isEditable, click: () => mainWindow.webContents.paste() },
    ]);
    menu.popup();
  });
  mainWindow.on('closed', () => { mainWindow = null; mainWindowWebContents = null; });
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────
function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port: LLM_PORT, path, method, headers: { 'Content-Type': 'application/json' } };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
    });
    req.on('error', (err) => reject(err));
    if (body) { const bodyStr = JSON.stringify(body); req.setHeader('Content-Length', Buffer.byteLength(bodyStr)); req.write(bodyStr); }
    req.end();
  });
}

// --- Overmind client (this instance's link to the coordinator) ---
const crypto = require('crypto');
let armIdentity = null; // { id, name }
let armLockPath = null; // exclusive slot lock held while this instance runs

// A lock is stale if the pid that wrote it is no longer alive.
function armLockIsStale(lockPath) {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
    if (!pid) return true;
    try { process.kill(pid, 0); return false; } // alive (or EPERM below)
    catch (e) { return e.code === 'ESRCH'; }     // ESRCH = dead → stale; EPERM = alive
  } catch { return true; } // unreadable → treat as stale
}

// userData is shared across every instance of the app, so a single arm.json
// would hand every instance the same identity. Instead each instance claims the
// first free arm-<n> slot via an exclusive (O_EXCL) lock file, reclaiming slots
// whose owning pid has died. The slot's arm-<n>.json persists the identity so a
// restart that reclaims the same slot keeps the same id/name.
function loadArmIdentity() {
  if (armIdentity) return armIdentity; // idempotent — never claim a second slot
  const dir = app.getPath('userData');
  // Per-profile launch (launch-arms.ps1): userData = ...\.arms\<slot>\profile.
  // Each arm owns its profile, so the slot IS the identity — no shared-counter race.
  const m = dir.replace(/\//g, '\\').match(/\.arms\\([^\\]+)\\profile\\?$/i);
  if (m) {
    const slot = m[1];
    const file = path.join(dir, 'arm.json');
    try { armIdentity = JSON.parse(fs.readFileSync(file, 'utf-8')); }
    catch (_) {
      armIdentity = { id: crypto.randomUUID(), name: slot };
      try { fs.writeFileSync(file, JSON.stringify(armIdentity)); } catch {}
    }
    return armIdentity;
  }
  for (let n = 0; n < 256; n++) {
    const lockPath = path.join(dir, `arm-${n}.lock`);
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx'); // atomic create-or-fail
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (armLockIsStale(lockPath)) { try { fs.unlinkSync(lockPath); n--; } catch {} continue; }
      continue; // held by a live instance — try the next slot
    }
    try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    armLockPath = lockPath;
    const file = path.join(dir, `arm-${n}.json`);
    try {
      armIdentity = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (_) {
      const id = crypto.randomUUID();
      armIdentity = { id, name: `arm-${n}` };
      try { fs.writeFileSync(file, JSON.stringify(armIdentity)); } catch (e) { log(`[Overmind] could not persist identity: ${e.message}`); }
    }
    return armIdentity;
  }
  // All slots exhausted (shouldn't happen) — fall back to an ephemeral identity.
  const id = crypto.randomUUID();
  armIdentity = { id, name: `arm-${id.slice(0, 4)}` };
  return armIdentity;
}

// Each arm's isolated git workspace — its own clones live here, never the shared
// repo dirs. run_command's cwd is bound to this server-side (see safety.safe_dispatch).
function armWorkspace() {
  const id = armIdentity || loadArmIdentity();
  const ws = path.join('C:\\github\\.arms', id.name, 'work');
  try { fs.mkdirSync(ws, { recursive: true }); } catch {}
  return ws;
}

function releaseArmIdentity() {
  if (armLockPath) { try { fs.unlinkSync(armLockPath); } catch {} armLockPath = null; }
}

function overmindRequest(method, p, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: OVERMIND_PORT, path: p, method,
        headers: { 'Content-Type': 'application/json' } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    if (body) { const s = JSON.stringify(body); req.setHeader('Content-Length', Buffer.byteLength(s)); req.write(s); }
    req.end();
  });
}

let overmindHeartbeatTimer = null;
let overmindStatus = 'idle';
let overmindFocus = '';

async function overmindRegisterAndHeartbeat() {
  loadArmIdentity();
  try {
    await overmindRequest('POST', '/arms/register', {
      id: armIdentity.id, name: armIdentity.name, pid: process.pid, browser_port: browserApiPort });
  } catch (e) { log(`[Overmind] register failed: ${e.message}`); }
  overmindHeartbeatTimer = setInterval(() => {
    overmindRequest('POST', `/arms/${armIdentity.id}/heartbeat`,
      { status: overmindStatus, focus: overmindFocus }).catch(() => {});
  }, 5000);
}

// Subscribe to the single SSE feed and forward every event to the renderer.
function overmindSubscribe() {
  const req = http.get(`http://127.0.0.1:${OVERMIND_PORT}/stream`, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (mainWindowWebContents && !mainWindowWebContents.isDestroyed()) {
            mainWindowWebContents.send('overmind:event', event);
          }
        } catch (_) {}
      }
    });
    res.on('end', () => setTimeout(overmindSubscribe, 2000));   // reconnect
  });
  req.on('error', () => setTimeout(overmindSubscribe, 2000));   // retry until Overmind is up
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────

// LLM
ipcMain.handle('llm:listSessions', async () => { try { return await httpRequest('GET', '/sessions'); } catch (e) { return []; } });
ipcMain.handle('llm:getHistory', async (event, sessionId) => { try { return await httpRequest('GET', `/sessions/${sessionId}/history`); } catch (e) { return { history: [], error: e.message || String(e) }; } });
const armSessions = new Set();   // session ids this arm created — deleted/hard-stopped on quit
let activeSessionId = null;      // session of the in-flight chat (target of the Stop button)
ipcMain.handle('llm:createSession', async () => { try { const s = await httpRequest('POST', '/sessions', { backend: 'abuddi-deepseek', working_dir: armWorkspace().replace(/\\/g, '/') }); if (s && s.id) armSessions.add(s.id); log('[lifecycle] createSession -> ' + (s && s.id)); return s; } catch (e) { throw e; } });
let activeChatRequest = null;
ipcMain.handle('llm:stop', async () => {
  log('[lifecycle] STOP button: HARD-stopping session ' + activeSessionId);
  if (activeChatRequest) { activeChatRequest.destroy(); activeChatRequest = null; }
  if (activeSessionId) { try { await httpRequest('POST', `/sessions/${activeSessionId}/stop`); } catch (e) { log('[lifecycle] stop call failed: ' + (e && e.message)); } }
  return { ok: true };
});
ipcMain.handle('llm:chat', async (event, { sessionId, message }) => {
  activeSessionId = sessionId;
  if (sessionId) armSessions.add(sessionId);
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ message, browser_port: browserApiPort });
    const options = { hostname: '127.0.0.1', port: LLM_PORT, path: `/sessions/${sessionId}/chat`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Accept': 'text/event-stream' } };
    const req = http.request(options, (res) => {
      let buffer = '';
      let lastEvent = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (line.startsWith('event: ')) { lastEvent = line.slice(7).trim(); }
          else if (line.startsWith('data: ')) {
            try {
              const d = JSON.parse(line.slice(6));
              if (event.sender && !event.sender.isDestroyed()) event.sender.send('llm:event', { event: lastEvent, data: d });
            } catch (e) {}
          }
        }
      });
      res.on('end', () => { activeChatRequest = null; resolve({ ok: true }); });
      res.on('error', (err) => { activeChatRequest = null; reject(err); });
    });
    req.on('error', (err) => {
      activeChatRequest = null;
      const graceful = err.code === 'ECONNRESET' || err.code === 'ECONNABORTED' || err.message === 'aborted' || err.message === 'socket hang up';
      if (graceful) resolve({ ok: true, stopped: true }); else reject(err);
    });
    activeChatRequest = req;
    req.write(postData);
    req.end();
  });
});
ipcMain.handle('llm:streamSummaries', async (event) => {
  return new Promise((resolve) => {
    const options = { hostname: '127.0.0.1', port: LLM_PORT, path: '/sessions/summaries/stream', method: 'GET', headers: { 'Accept': 'text/event-stream' } };
    const req = http.request(options, (res) => {
      let buffer = '';
      let lastEvent = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (line.startsWith('event: ')) { lastEvent = line.slice(7).trim(); }
          else if (line.startsWith('data: ')) {
            try {
              const d = JSON.parse(line.slice(6));
              if (lastEvent === 'summary' && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('summaries:event', d);
              }
            } catch (e) {}
          }
        }
      });
      res.on('end', () => resolve({ ok: true }));
      res.on('error', () => resolve({ ok: false }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
});
ipcMain.handle('llm:respond', async (event, { sessionId, answer }) => { try { return await httpRequest('POST', `/sessions/${sessionId}/respond`, { answer }); } catch (e) { return { ok: true }; } });

// Agents
ipcMain.handle('agents:list', async () => { try { return await httpRequest('GET', '/agents'); } catch (e) { return []; } });
ipcMain.handle('agents:get', async (event, agentId) => { try { return await httpRequest('GET', `/agents/${agentId}`); } catch (e) { return null; } });
ipcMain.handle('agents:reload', async () => { try { return await httpRequest('POST', '/agents/reload'); } catch (e) { return { error: e.message }; } });

// ABUDDI
ipcMain.handle('abuddi:score', async (event, { task }) => { try { return await httpRequest('POST', '/abuddi/score', { message: task }); } catch (e) { return { error: e.message }; } });

// Maestro
ipcMain.handle('maestro:dispatch', async (event, { message, hat, workingDirectory }) => {
  try {
    const session = await httpRequest('POST', '/sessions', { backend: 'abuddi-deepseek', working_dir: workingDirectory || armWorkspace().replace(/\\/g, '/') });
    return { sessionId: session.id, ...session };
  } catch (e) { throw e; }
});

// ─── Memory System IPC ─────────────────────────────────────────────────────
ipcMain.handle('memory:get', async (event, { tier, namespace, key }) => {
  try { const qs = key ? `?key=${encodeURIComponent(key)}` : ''; return await httpRequest('GET', `/memory/${tier}/${namespace}${qs}`); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:set', async (event, { tier, namespace, key, value }) => {
  try { return await httpRequest('POST', `/memory/${tier}/${namespace}/${key}`, { message: value }); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:append', async (event, { tier, namespace, key, value }) => {
  try { return await httpRequest('POST', `/memory/${tier}/${namespace}/${key}/append`, { message: value }); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:search', async (event, { tier, namespace, query }) => {
  try { return await httpRequest('GET', `/memory/${tier}/${namespace}/search?query=${encodeURIComponent(query)}`); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:delete', async (event, { tier, namespace, key }) => {
  try { return await httpRequest('DELETE', `/memory/${tier}/${namespace}/${key}`); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:clear', async (event, { tier, namespace }) => {
  try { return await httpRequest('DELETE', `/memory/${tier}/${namespace}`); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:stats', async () => { try { return await httpRequest('GET', '/memory/stats'); } catch (e) { return { error: e.message }; } });
ipcMain.handle('memory:namespaces', async (event, { tier }) => {
  try { const qs = tier ? `?tier=${encodeURIComponent(tier)}` : ''; return await httpRequest('GET', `/memory/namespaces${qs}`); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:session', async (event, { sessionId, key }) => {
  try { const namespace = `session_${sessionId}`; const qs = key ? `?key=${encodeURIComponent(key)}` : ''; return await httpRequest('GET', `/memory/session/${namespace}${qs}`); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:agent', async (event, { agentId, key }) => {
  try { const namespace = `agent_${agentId}`; const qs = key ? `?key=${encodeURIComponent(key)}` : ''; return await httpRequest('GET', `/memory/agent/${namespace}${qs}`); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('memory:meta', async (event, { key }) => {
  try { const qs = key ? `?key=${encodeURIComponent(key)}` : ''; return await httpRequest('GET', `/memory/meta/deepconsole${qs}`); } catch (e) { return { error: e.message }; }
});

// ─── Grimoire System IPC ──────────────────────────────────────────────────
// Matches FastAPI endpoints in server.py:
// POST /grimoires {grimoire_id, title, chapters}
// GET  /grimoires
// GET  /grimoires/{id}
// PUT  /grimoires/{id} {title?, chapters?}
// DELETE /grimoires/{id}
// GET  /grimoires/search?q=
// POST /grimoires/{id}/endow (no body)
// POST /grimoires/{id}/unequip (no body)
// GET  /grimoires/endowed

ipcMain.handle('grimoires:create', async (event, { grimoire_id, title, chapters }) => {
  try {
    return await httpRequest('POST', '/grimoires', { grimoire_id, title, chapters });
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('grimoires:list', async () => {
  try {
    return await httpRequest('GET', '/grimoires');
  } catch (e) {
    return [];
  }
});

ipcMain.handle('grimoires:get', async (event, id) => {
  try {
    return await httpRequest('GET', `/grimoires/${id}`);
  } catch (e) {
    return null;
  }
});

ipcMain.handle('grimoires:update', async (event, { id, title, chapters }) => {
  try {
    // Backend accepts partial updates — only send provided fields
    const body = {};
    if (title !== undefined) body.title = title;
    if (chapters !== undefined) body.chapters = chapters;
    return await httpRequest('PUT', `/grimoires/${id}`, body);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('grimoires:delete', async (event, id) => {
  try {
    return await httpRequest('DELETE', `/grimoires/${id}`);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('grimoires:search', async (event, query) => {
  try {
    return await httpRequest('GET', `/grimoires/search?q=${encodeURIComponent(query)}`);
  } catch (e) {
    return { error: e.message };
  }
});

// Endowment — backend takes no body, just the path param
ipcMain.handle('grimoires:endow', async (event, id) => {
  try {
    return await httpRequest('POST', `/grimoires/${id}/endow`);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('grimoires:unequip', async (event, id) => {
  try {
    return await httpRequest('POST', `/grimoires/${id}/unequip`);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('grimoires:endowed', async () => {
  try {
    return await httpRequest('GET', '/grimoires/endowed');
  } catch (e) {
    return { error: e.message };
  }
});

// ─── Browser Control IPC ─────────────────────────────────────────────────
ipcMain.handle('browser:open', async (event, url) => { try { await webviewNavigate(url || 'https://google.com'); return { ok: true }; } catch (err) { return { error: err.message }; } });
ipcMain.handle('browser:close', () => { return { ok: true }; });
ipcMain.handle('browser:executeJS', async (event, code) => { try { const result = await webviewExecuteJS(code); return { ok: true, result }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('browser:getURL', async () => { try { return await webviewGetURL(); } catch (err) { return 'about:blank'; } });
ipcMain.handle('browser:navigate', async (event, url) => { try { await webviewNavigate(url); return { ok: true }; } catch (err) { return { error: err.message }; } });

// ─── Brain Worms System IPC ────────────────────────────────────────────────
ipcMain.handle('brainworms:sightings', async (event, { limit, worm }) => {
  try {
    let path = `/brainworms/sightings?limit=${limit || 50}`;
    if (worm) path += `&worm=${encodeURIComponent(worm)}`;
    return await httpRequest('GET', path);
  } catch (e) { return { error: e.message, sightings: [] }; }
});
ipcMain.handle('brainworms:status', async () => {
  try { return await httpRequest('GET', '/brainworms/status'); }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('brainworms:burrow', async (event, { worm }) => {
  try {
    let path = '/brainworms/burrow';
    if (worm) path += `?worm=${encodeURIComponent(worm)}`;
    return await httpRequest('POST', path);
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('brainworms:configure', async (event, { worm, enabled, interval }) => {
  try {
    let path = `/brainworms/config?worm=${encodeURIComponent(worm)}`;
    if (enabled !== undefined) path += `&enabled=${enabled}`;
    if (interval !== undefined) path += `&interval=${interval}`;
    return await httpRequest('POST', path);
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('brainworms:clear', async () => {
  try { return await httpRequest('DELETE', '/brainworms/sightings'); }
  catch (e) { return { error: e.message }; }
});

// ─── Git Workflow IPC ───────────────────────────────────────────────────────
// All code changes go through: branch → commit → ClaudePlus review → merge.

ipcMain.handle('workflow:start', async (event, { task }) => {
  try { return await httpRequest('POST', '/workflow/start', { task }); }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle('workflow:submit', async (event, { files, message }) => {
  try { return await httpRequest('POST', '/workflow/submit', { files, message }); }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle('workflow:status', async () => {
  try { return await httpRequest('GET', '/workflow/status'); }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle('workflow:merge', async () => {
  try { return await httpRequest('POST', '/workflow/merge'); }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle('workflow:abort', async () => {
  try { return await httpRequest('POST', '/workflow/abort'); }
  catch (e) { return { error: e.message }; }
});

// --- Overmind IPC ---
ipcMain.handle('overmind:log', async (_e, { msg }) => {
  const who = (armIdentity && armIdentity.id) ? armIdentity.id.slice(0, 8) : '?';
  log(`[autonomous ${who}]`, String(msg == null ? '' : msg));
});
ipcMain.handle('overmind:armId', async () => armIdentity || loadArmIdentity());
ipcMain.handle('overmind:roster', async () => overmindRequest('GET', '/arms'));
ipcMain.handle('overmind:board', async () => overmindRequest('GET', '/board'));
ipcMain.handle('overmind:postItem', async (_e, { title, detail, tags }) =>
  overmindRequest('POST', '/board', { title, detail, tags: tags || [], posted_by: armIdentity.id }));
ipcMain.handle('overmind:claim', async (_e, { itemId }) =>
  overmindRequest('POST', `/board/${itemId}/claim`, { arm_id: armIdentity.id }));
ipcMain.handle('overmind:release', async (_e, { itemId }) =>
  overmindRequest('POST', `/board/${itemId}/release`, {}));
ipcMain.handle('overmind:done', async (_e, { itemId, result }) =>
  overmindRequest('POST', `/board/${itemId}/done`, { result: result || '' }));
ipcMain.handle('overmind:ask', async (_e, { toArmId, message }) =>
  overmindRequest('POST', `/arms/${toArmId}/ask`, { from_arm: armIdentity.id, message }));
ipcMain.handle('overmind:reply', async (_e, { askId, answer }) =>
  overmindRequest('POST', `/asks/${askId}/reply`, { answer }));
ipcMain.handle('overmind:setStatus', async (_e, { status, focus }) => {
  if (status !== undefined) overmindStatus = status;
  if (focus !== undefined) overmindFocus = focus;
  return overmindRequest('POST', `/arms/${armIdentity.id}/heartbeat`, { status: overmindStatus, focus: overmindFocus });
});

// Config / Key Store
ipcMain.handle('config:getKeyStatus', () => keyStore.getKeyStatus());
ipcMain.handle('config:setKey', (_e, key) => {
  keyStore.setKey(String(key || '').trim());
  return keyStore.getKeyStatus();
});
ipcMain.handle('config:clearKey', () => {
  keyStore.clearKey();
  return keyStore.getKeyStatus();
});

// Dialog
ipcMain.handle('dialog:saveFile', async (event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName || 'output.txt', filters: [{ name: 'All Files', extensions: ['*'] }] });
  if (!result.canceled && result.filePath) { require('fs').writeFileSync(result.filePath, content, 'utf-8'); return { ok: true, path: result.filePath }; }
  return { canceled: true };
});

// ─── Dr. Claude Diagnosis ──────────────────────────────────────────────────
const CLAUDEPLUS_PORT = 8081;

ipcMain.handle('claude:diagnose', async (event, { errorMsg, lastAIMessage, recentTools, workingDir, sessionId }) => {
  let historyBlock = '(no session id provided)';
  if (sessionId) {
    try {
      const hist = await httpRequest('GET', `/sessions/${sessionId}/history`);
      const msgs = Array.isArray(hist) ? hist : (hist.history || []);
      if (msgs.length) {
        const tail = msgs.slice(-12);
        historyBlock = tail.map((m, i) => {
          const idx = msgs.length - tail.length + i;
          const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length ? ` tool_calls=[${m.tool_calls.map(tc => tc.function?.name || tc.name || '?').join(',')}]` : '';
          const toolId = m.tool_call_id ? ` tool_call_id=${m.tool_call_id}` : '';
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return `  [${idx}] role=${m.role}${hasToolCalls}${toolId} :: ${(content || '').slice(0, 160)}`;
        }).join('\n');
      } else { historyBlock = '(history empty)'; }
    } catch (e) { historyBlock = `(failed to fetch history: ${e.message})`; }
  }

  const prompt = `You are Dr. Claude — a debugging specialist for DeepConsole.

DeepConsole is an Electron app where an AI (DeepSeek via a FastAPI server on port 8000) chats with the user and uses tools.

## What just went wrong
**Error:** ${errorMsg}
**Last AI message:** ${lastAIMessage || '(none)'}
**Recent tools:** ${recentTools && recentTools.length ? recentTools.map(t => `  ${t.status === 'call' ? '🛠' : '✅'} ${t.name}${t.args ? '(' + JSON.stringify(t.args).slice(0, 120) + ')' : ''}${t.result ? ' → ' + String(t.result).slice(0, 120) : ''}`).join('\n') : '  (none recorded)'}
**Session ID:** ${sessionId || '(unknown)'}
**History (last 12):** ${historyBlock}
**Working dir:** ${workingDir || 'C:/github/deepconsole'}

Diagnose and fix it. Do not ask for permission.`;

  const claudePost = (p, b) => new Promise((resolve, reject) => {
    const bs = JSON.stringify(b);
    const req = http.request({ hostname: '127.0.0.1', port: CLAUDEPLUS_PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bs) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } }); });
    req.on('error', reject); req.write(bs); req.end();
  });

  try {
    const sendRes = await claudePost('/api/chat/send', { message: prompt, workingDirectory: workingDir || DEEPCONSOLE_DIR });
    log(`[DrClaude] sendRes: ${JSON.stringify(sendRes)}`);
    const requestId = sendRes.requestId;
    if (!requestId) return { error: `ClaudePlus error: ${JSON.stringify(sendRes)}` };
    return await new Promise((resolve) => {
      const req = http.get({ hostname: '127.0.0.1', port: CLAUDEPLUS_PORT, path: `/api/chat/stream/${requestId}` }, (res) => {
        let buf = ''; let finalResponse = ''; let eventName = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const trimmed = line.trimEnd();
            if (trimmed.startsWith('event:')) { eventName = trimmed.slice(6).trim(); }
            else if (trimmed.startsWith('data:')) {
              try {
                const payload = JSON.parse(trimmed.slice(5).trim());
                if (eventName === 'token' && payload.text) { if (event.sender && !event.sender.isDestroyed()) event.sender.send('claude:streaming', { text: payload.text }); }
                else if (eventName === 'done') { finalResponse = payload.response || finalResponse; }
                else if (eventName === 'error') { resolve({ error: payload.error || 'stream error' }); }
              } catch {}
              eventName = '';
            }
          }
        });
        res.on('end', () => { log(`[DrClaude] stream ended, len=${finalResponse.length}`); resolve({ response: finalResponse }); });
        res.on('error', (err) => resolve({ error: err.message }));
      });
      req.setTimeout(120000, () => { req.destroy(); resolve({ error: 'timeout waiting for Dr. Claude' }); });
      req.on('error', (err) => { log(`[DrClaude] req error: ${err.message}`); resolve({ error: `ClaudePlus not reachable: ${err.message}` }); });
      req.end();
    });
  } catch (err) { log(`[DrClaude] error: ${err.message}`); return { error: `ClaudePlus not reachable: ${err.message}` }; }
});

// ─── App Lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  initKeyStore();
  loadArmIdentity(); // populate armIdentity now so Overmind IPC handlers never deref null
  ensureSharedService('LLM', LLM_PORT, startLLMServer);
  ensureSharedService('Overmind', OVERMIND_PORT, startOvermind);
  startBrowserApiServer();
  createMainWindow();
  setTimeout(() => {
    overmindRegisterAndHeartbeat();
    overmindSubscribe();
  }, 2500);
  const pingServer = () => {
    const req = http.get(`http://127.0.0.1:${LLM_PORT}/health`, (res) => {
      console.log('[DeepConsole] LLM server (Abuddi) is ready');
      if (mainWindowWebContents && !mainWindowWebContents.isDestroyed()) mainWindowWebContents.send('llm:ready');
      // Start the brain worm SSE stream a moment after the server is confirmed ready
      setTimeout(startBrainwormStream, 2000);
    });
    req.on('error', () => { console.log('[DeepConsole] Waiting for LLM server...'); setTimeout(pingServer, 2000); });
    req.end();
  };
  setTimeout(pingServer, 2000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
// ─── Brain Worms SSE Stream (push sightings to renderer) ──────────────────
let brainwormStreamReq = null;

function startBrainwormStream() {
  if (brainwormStreamReq) return;
  const req = http.get(`http://127.0.0.1:${LLM_PORT}/brainworms/stream`, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      let lineEnd;
      while ((lineEnd = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('brainworms:sighting', data);
            }
          } catch (e) {
            // ignore parse errors
          }
        }
      }
    });
    res.on('end', () => { brainwormStreamReq = null; setTimeout(startBrainwormStream, 5000); });
    res.on('error', () => { brainwormStreamReq = null; setTimeout(startBrainwormStream, 10000); });
  });
  req.on('error', () => { brainwormStreamReq = null; setTimeout(startBrainwormStream, 10000); });
  brainwormStreamReq = req;
}

let _quitCleaned = false;
async function _cleanupAndQuit() {
  if (_quitCleaned) return;
  // 1) HARD-stop + delete this arm's sessions FIRST so no orphan loop survives on the shared
  //    backend (DELETE cancels the running loop server-side, even if paused at ask_user).
  for (const sid of armSessions) {
    try { await httpRequest('DELETE', `/sessions/${sid}`); log('[lifecycle] deleted session on quit: ' + sid); }
    catch (err) { log('[lifecycle] delete-on-quit failed ' + sid + ': ' + (err && err.message)); }
  }
  _quitCleaned = true;
  // 2) only THEN stop shared services (no-op for attached arms) + release identity
  stopLLMServer(); stopOvermind();
  if (overmindHeartbeatTimer) clearInterval(overmindHeartbeatTimer);
  releaseArmIdentity();
  app.quit();
}
app.on('window-all-closed', () => { log('[lifecycle] window-all-closed fired'); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (e) => {
  log('[lifecycle] before-quit fired');
  if (_quitCleaned) return;   // cleanup done — let the real quit proceed
  e.preventDefault();          // hold the quit until this arm's sessions are stopped + deleted
  _cleanupAndQuit();
});
