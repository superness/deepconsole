const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deepconsole', {
  // Launch flags forwarded from main via webPreferences.additionalArguments.
  launchAutonomous: process.argv.includes('--autonomous'),
  // LLM API
  llm: {
    createSession: () => ipcRenderer.invoke('llm:createSession'),
    listSessions: () => ipcRenderer.invoke('llm:listSessions'),
    getHistory: (sessionId) => ipcRenderer.invoke('llm:getHistory', sessionId),
    chat: (sessionId, message) => ipcRenderer.invoke('llm:chat', { sessionId, message }),
    stop: () => ipcRenderer.invoke('llm:stop'),
    respond: (sessionId, answer) => ipcRenderer.invoke('llm:respond', { sessionId, answer }),
    onEvent: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('llm:event', handler);
      return () => ipcRenderer.removeListener('llm:event', handler);
    },
    streamSummaries: () => ipcRenderer.invoke('llm:streamSummaries'),
    onSummary: (callback) => {
      const handler = (_e, data) => callback(data);
      ipcRenderer.on('summaries:event', handler);
      return () => ipcRenderer.removeListener('summaries:event', handler);
    },
    onReady: (callback) => {
      ipcRenderer.on('llm:ready', callback);
    },
  },

  // Agent Command Center API
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    get: (agentId) => ipcRenderer.invoke('agents:get', agentId),
    reload: () => ipcRenderer.invoke('agents:reload'),
  },

  // ABUDDI Complexity Scoring
  abuddi: {
    score: (task) => ipcRenderer.invoke('abuddi:score', { task }),
  },

  // Maestro Dispatch
  maestro: {
    dispatch: (message, hat, workingDirectory) =>
      ipcRenderer.invoke('maestro:dispatch', { message, hat, workingDirectory }),
  },

  // ─── Working Memory API ──────────────────────────────────────────────
  memory: {
    get: (tier, namespace, key) => ipcRenderer.invoke('memory:get', { tier, namespace, key }),
    set: (tier, namespace, key, value) => ipcRenderer.invoke('memory:set', { tier, namespace, key, value }),
    append: (tier, namespace, key, value) => ipcRenderer.invoke('memory:append', { tier, namespace, key, value }),
    search: (tier, namespace, query) => ipcRenderer.invoke('memory:search', { tier, namespace, query }),
    delete: (tier, namespace, key) => ipcRenderer.invoke('memory:delete', { tier, namespace, key }),
    clear: (tier, namespace) => ipcRenderer.invoke('memory:clear', { tier, namespace }),
    stats: () => ipcRenderer.invoke('memory:stats'),
    namespaces: (tier) => ipcRenderer.invoke('memory:namespaces', { tier }),
    session: (sessionId, key) => ipcRenderer.invoke('memory:session', { sessionId, key }),
    agent: (agentId, key) => ipcRenderer.invoke('memory:agent', { agentId, key }),
    meta: (key) => ipcRenderer.invoke('memory:meta', { key }),
  },

  // ─── Overmind (cross-instance awareness) ─────────────────────────────
  overmind: {
    log: (msg) => ipcRenderer.invoke('overmind:log', { msg }),
    armId: () => ipcRenderer.invoke('overmind:armId'),
    roster: () => ipcRenderer.invoke('overmind:roster'),
    board: () => ipcRenderer.invoke('overmind:board'),
    postItem: (item) => ipcRenderer.invoke('overmind:postItem', item),
    claim: (itemId) => ipcRenderer.invoke('overmind:claim', { itemId }),
    release: (itemId) => ipcRenderer.invoke('overmind:release', { itemId }),
    done: (itemId, result) => ipcRenderer.invoke('overmind:done', { itemId, result }),
    ask: (toArmId, message) => ipcRenderer.invoke('overmind:ask', { toArmId, message }),
    reply: (askId, answer) => ipcRenderer.invoke('overmind:reply', { askId, answer }),
    setStatus: (status, focus) => ipcRenderer.invoke('overmind:setStatus', { status, focus }),
    onEvent: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('overmind:event', handler);
      return () => ipcRenderer.removeListener('overmind:event', handler);
    },
  },

  // ─── Grimoire System API ────────────────────────────────────────────
  // Matches the backend FastAPI schema: grimoire_id, title, chapters
  grimoires: {
    create: (grimoire_id, title, chapters) =>
      ipcRenderer.invoke('grimoires:create', { grimoire_id, title, chapters }),
    list: () => ipcRenderer.invoke('grimoires:list'),
    get: (id) => ipcRenderer.invoke('grimoires:get', id),
    update: (id, title, chapters) =>
      ipcRenderer.invoke('grimoires:update', { id, title, chapters }),
    delete: (id) => ipcRenderer.invoke('grimoires:delete', id),
    search: (query) => ipcRenderer.invoke('grimoires:search', query),
    endow: (id) => ipcRenderer.invoke('grimoires:endow', id),
    unequip: (id) => ipcRenderer.invoke('grimoires:unequip', id),
    endowed: () => ipcRenderer.invoke('grimoires:endowed'),
  },

  // ─── Brain Worms API ────────────────────────────────────────────────
  brainworms: {
    sightings: (limit, worm) => ipcRenderer.invoke('brainworms:sightings', { limit, worm }),
    status: () => ipcRenderer.invoke('brainworms:status'),
    burrow: (worm) => ipcRenderer.invoke('brainworms:burrow', { worm }),
    configure: (worm, enabled, interval) => ipcRenderer.invoke('brainworms:configure', { worm, enabled, interval }),
    clear: () => ipcRenderer.invoke('brainworms:clear'),
    onSighting: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('brainworms:sighting', handler);
      return () => ipcRenderer.removeListener('brainworms:sighting', handler);
    },
  },

  // ─── Git Workflow API (branch → commit → Claude review → merge) ────
  gitWorkflow: {
    start: (task) => ipcRenderer.invoke('workflow:start', { task }),
    submit: (files, message) => ipcRenderer.invoke('workflow:submit', { files, message }),
    status: () => ipcRenderer.invoke('workflow:status'),
    merge: () => ipcRenderer.invoke('workflow:merge'),
    abort: () => ipcRenderer.invoke('workflow:abort'),
  },

  // Browser control
  browser: {
    open: (url) => ipcRenderer.invoke('browser:open', url),
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    executeJS: (code) => ipcRenderer.invoke('browser:executeJS', code),
    getURL: () => ipcRenderer.invoke('browser:getURL'),
    close: () => ipcRenderer.invoke('browser:close'),
  },

  // Console
  onConsoleEntry: (callback) => {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on('browser:consoleEntry', handler);
    return () => ipcRenderer.removeListener('browser:consoleEntry', handler);
  },

  // Save dialog
  saveFile: (defaultName, content) => ipcRenderer.invoke('dialog:saveFile', { defaultName, content }),

  // Dr. Claude diagnosis
  claude: {
    diagnose: (errorMsg, lastAIMessage, recentTools, workingDir, sessionId) =>
      ipcRenderer.invoke('claude:diagnose', { errorMsg, lastAIMessage, recentTools, workingDir, sessionId }),
    onStreaming: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('claude:streaming', handler);
      return () => ipcRenderer.removeListener('claude:streaming', handler);
    },
  },

  // ─── Key Store Config API ────────────────────────────────────────────
  config: {
    getKeyStatus: () => ipcRenderer.invoke('config:getKeyStatus'),
    setKey: (key) => ipcRenderer.invoke('config:setKey', key),
    clearKey: () => ipcRenderer.invoke('config:clearKey'),
  },

  // ─── Webview Control (internal) ──
  _webview: {
    onExecuteJS: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('webview:executeJS', handler);
      return () => ipcRenderer.removeListener('webview:executeJS', handler);
    },
    onNavigate: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('webview:navigate', handler);
      return () => ipcRenderer.removeListener('webview:navigate', handler);
    },
    onGetURL: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('webview:getURL', handler);
      return () => ipcRenderer.removeListener('webview:getURL', handler);
    },
    onCapture: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('webview:capture', handler);
      return () => ipcRenderer.removeListener('webview:capture', handler);
    },
    sendResult: (channel, data) => ipcRenderer.send(channel, data),
  },
});
