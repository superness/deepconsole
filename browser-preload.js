const { contextBridge, ipcRenderer } = require('electron');

// Store console logs
const consoleLogs = [];
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = function(...args) {
  const entry = { type: 'log', timestamp: new Date().toISOString(), args: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)) };
  consoleLogs.push(entry);
  ipcRenderer.send('browser:consoleEntry', entry);
  originalConsoleLog.apply(console, args);
};

console.error = function(...args) {
  const entry = { type: 'error', timestamp: new Date().toISOString(), args: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)) };
  consoleLogs.push(entry);
  ipcRenderer.send('browser:consoleEntry', entry);
  originalConsoleError.apply(console, args);
};

console.warn = function(...args) {
  const entry = { type: 'warn', timestamp: new Date().toISOString(), args: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)) };
  consoleLogs.push(entry);
  ipcRenderer.send('browser:consoleEntry', entry);
  originalConsoleWarn.apply(console, args);
};

// Capture unhandled errors
window.addEventListener('error', (event) => {
  const entry = { type: 'error', timestamp: new Date().toISOString(), args: [`Uncaught: ${event.message} at ${event.filename}:${event.lineno}`] };
  consoleLogs.push(entry);
  ipcRenderer.send('browser:consoleEntry', entry);
});

// Expose API to the browser context for remote control
contextBridge.exposeInMainWorld('__deepconsole_bridge__', {
  getConsoleLogs: () => consoleLogs,
  clearConsoleLogs: () => { consoleLogs.length = 0; },
  executeJS: (code) => {
    try {
      const result = eval(code);
      return { ok: true, result: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
});
