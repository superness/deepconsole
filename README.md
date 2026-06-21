# DeepConsole 🌀

**DeepConsole** is an Electron desktop app that provides a local chat interface to **DeepSeek** (running through the abuddi server) with a fully integrated browser that the AI can automate.

## Features

- 💬 **Chat with DeepSeek** — Streaming responses with markdown rendering
- 🌐 **Integrated Browser** — Webview that the AI can open, navigate, and inspect
- 🔍 **Browser Automation** — AI can open URLs, execute JavaScript, read page content
- 📋 **Console Log Viewer** — Real-time console logs from the browser
- 💻 **JS Runner** — Execute JavaScript directly in the browser and see results
- 🛠 **Tool Calls** — See every tool the AI uses (browser, file ops, etc.)
- ❓ **Interactive Questions** — AI can ask you questions mid-conversation

## Requirements

- Node.js 18+ (tested with v24)
- Python 3.10+
- A DeepSeek API key set in `../abuddi/.env` as `DEEPSEEK_API_KEY`

## Getting Started

```bash
# Install dependencies
npm install

# Start the app (launches LLM server + Electron UI)
npm start

# Development mode (with DevTools)
npm run dev
```

## Architecture

```
deepconsole/
├── main.js              # Electron main process
├── preload.js           # Main window preload (context bridge)
├── browser-preload.js   # Browser window preload (console capture)
├── package.json
├── renderer/
│   ├── index.html       # Main UI layout
│   ├── style.css        # Dark theme styling
│   └── app.js           # Chat, browser, console, JS runner logic
└── README.md
```

The app starts a FastAPI server (`abuddi/server.py`) in the background and communicates with it via HTTP for chat streaming (SSE).

## How the AI Controls the Browser

The AI has access to tools that let it:

1. **Open a browser** — Opens a separate Electron window
2. **Navigate to URLs** — Loads any URL in the browser
3. **Execute JavaScript** — Runs arbitrary JS in the browser page context
4. **Read console logs** — Retrieves console output
5. **Save files** — Dialog-based file saving

The built-in webview tab shows a browser directly inside the app, while the separate browser window is used for AI-driven automation (no visual clutter).

## License

MIT
