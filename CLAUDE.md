# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run the app
npm start

# Run in development mode (opens DevTools)
npm run dev
```

There are no tests or lint scripts. No build step is required — Electron loads files directly.

## Architecture

DeepConsole is an **Electron desktop app** that provides a chat UI to DeepSeek (via a local FastAPI server) with an integrated browser the AI can automate.

### Process model

- **Main process** (`main.js`): Manages windows, IPC handlers, and two internal HTTP servers:
  - Spawns `../abuddi/server.py` via uvicorn on port `8000` (the LLM backend)
  - Runs a **Browser API HTTP server** on port `9100` that the LLM backend calls to control the Electron browser window (open, navigate, execute JS, read console logs)
- **Renderer process** (`renderer/app.js` + `renderer/index.html` + `renderer/style.css`): All UI logic — chat, session management, streaming SSE events, tabs (Browser, Console, JS Runner, Agents, Memory)
- **Preloads**:
  - `preload.js`: Context bridge for the main window — exposes `window.deepconsole.*` API covering `llm`, `agents`, `abuddi`, `maestro`, `memory`, `browser`, `saveFile`
  - `browser-preload.js`: Context bridge for the AI-controlled browser window — intercepts `console.log/error/warn` and forwards entries via IPC to the main process buffer

### Data flow for chat

1. Renderer calls `window.deepconsole.llm.chat(sessionId, message)` via IPC
2. Main process streams SSE from `http://127.0.0.1:8000/sessions/{id}/chat`
3. SSE events (`token`, `tool_call`, `tool_result`, `ask`, `done`, `error`) are forwarded to the renderer via `event.sender.send('llm:event', ...)`
4. Renderer handles each event type in `sendMessage()` in `app.js`

### Shared Working Memory System

DeepConsole has a **unified 3-tier shared working memory** system backed by JSON files in `../abuddi/memory_store/`.

| Tier | Namespace pattern | Scope | Persistence |
|------|------------------|-------|-------------|
| **Session** | `session_{id}` | Single conversation | Ephemeral (deleted with session) |
| **Agent** | `agent_{hat}` | Per agent hat across all sessions | Persistent |
| **Meta** | `deepconsole` | Global — all sessions & agents | Persistent |

**How it works:**

1. **FastAPI server** (`server.py`) exposes REST endpoints at `/memory/{tier}/{namespace}/...` — GET, SET, APPEND, DELETE, CLEAR, SEARCH, STATS
2. **IPC bridge** (`main.js`) proxies renderer calls to the FastAPI server at these endpoints
3. **AI tools** (`tools.py`) give the AI direct `memory_get`, `memory_set`, `memory_append`, `memory_search`, `memory_delete`, `memory_clear`, `memory_stats` tools
4. **Prompt injection** (`engine.py`): Before every AI turn, the current session memory + meta memory are injected into the system prompt as "Shared Working Memory (Live)"
5. **Knowledge Base** (`knowledge.py` / `knowledge.json`): Separate file-based store for facts, learnings, and questions that the AI curates via `knowledge_*` tools. Also injected into every system prompt.

The AI sees both systems in its system prompt. Knowledge Base = long-term agent memory. Working Memory = shared 3-tier state machine.

### Code Layout

```
../abuddi/
  memory.py          — JSON file-based 3-tier memory store (CRUD ops)
  server.py          — FastAPI: sessions, agents, ABUDDI, MAESTRO, MEMORY routes
  engine.py          — Session management, chat streaming, system prompt building with memory injection
  tools.py           — AI tool registry + schemas (file, knowledge, memory tools)
  knowledge.py       — knowledge.json management (facts/learnings/questions)
  memory_store/      — On-disk JSON files organized by tier then namespace
    session/
    agent/
    meta/
```

### Agent / Maestro system

- `agents:list` / `agents:get` fetches agent definitions from the LLM server (`/agents`)
- `maestro:dispatch` creates a new session with a specific agent hat and returns a `sessionId` the renderer then uses for streaming chat
- Each agent hat gets its own `agent_{hat}` memory namespace for cross-session persistent state

### Key ports

| Port | Service |
|------|---------|
| 8000 | LocalLLM (abuddi-deepseek) FastAPI server — **shared** across all instances |
| 9200 | Overmind — standalone cross-instance coordinator (presence, blackboard, peer-ask, Ghost) |
| dynamic | Browser API HTTP server (Electron → LLM); OS-assigned per instance, registered with the Overmind |

### Multi-instance & the Overmind

DeepConsole can run as **multiple independent instances** (separate Electron processes, each with its own window, sessions, and AI-controlled browser) that are aware of one another through the **Overmind**, a standalone passive coordinator on port `9200` (`overmind/app.py`, a FastAPI service; pure state layer in `overmind/store.py`, tested under `overmind/tests/`).

- **Shared backend, not killed.** Instances no longer kill whatever holds port 8000. `main.js` *probe-then-spawns* (`ensureSharedService`): the first instance to launch spawns the shared LLM backend (8000) and the Overmind (9200); the rest detect them via `/health` and attach. Each instance gets its own browser API port (OS-assigned, `browserApiPort`) and a persisted arm identity (`arm.json` in Electron `userData`).
- **The Overmind watches and creates space — it never directs.** It holds a live **presence roster**, a self-organizing **blackboard** (work items any idle instance can atomically *claim* — pull, not push, no assignment/sequencing), routes **peer-asks** between instances, and runs the **Ghost** (on a board item's `done`, it records a learning into the shared Knowledge Base via the backend's `POST /knowledge/learning`). All changes fan out live over `GET /stream` (SSE) — no polling. If a change ever turns the Overmind into an assigner/scheduler, that's a smell; push initiative back into the instances.
- **Renderer:** the **Overmind tab** (`renderer/`) shows the roster, blackboard, and an incoming-asks inbox, all driven by the single `overmind:event` SSE feed bridged through `window.deepconsole.overmind.*` (`preload.js`) ↔ `overmind:*` IPC handlers (`main.js`).
- **Autonomous worker mode.** Any instance can be flipped into **Autonomous mode** from the Overmind tab (`#autonomous-toggle`). A DOM-free state machine (`renderer/autonomous.js`, unit-tested via `npm test` / `node --test`) then watches the live board feed and, while idle, atomically **claims one open item at a time**, runs it to completion in the instance's visible chat (the full `abuddi-deepseek` agent, via a `sendMessage(text)` that returns the final answer), marks the item **Done** with a summarized result (so the **Ghost** records a learning), and **releases** it on failure. One job at a time (single in-flight guard); disabling mid-job finishes the current job then stops. This keeps the Overmind's pull-not-push contract: a worker only ever takes work it claims, nothing is assigned to it.

See the design spec `docs/superpowers/specs/2026-06-07-multi-instance-overmind-design.md` and plan `docs/superpowers/plans/2026-06-07-multi-instance-overmind.md`.

### External dependency

The LLM backend lives at `../abuddi/` (sibling directory). DeepConsole expects that directory and a `DEEPSEEK_API_KEY` in `../abuddi/.env`. The app pings `http://127.0.0.1:8000/health` every 2 seconds on startup until the server responds.

### DeepSeek models

The backend uses DeepSeek **V4**, and the model is **fully computed per turn** —
there is no manual picker. The `abuddi-deepseek` backend runs a cheap flash
non-thinking *triage* pass that classifies each turn and emits an ABUDDI
`complexity_score` plus a `CODE_WORK` flag. The work pass then uses:

- **model:** `deepseek-v4-pro` when the turn is code work, else `deepseek-v4-flash`.
- **thinking:** `decide_thinking(score)` enables thinking (effort `high`, or `max`
  ≥30) when `score ≥ 12`; routine turns stay non-thinking.

`reasoning_content` is captured and threaded through history so thinking-mode
tool-call loops don't HTTP 400. The `/sessions` endpoint still accepts an optional
`model` (validated against `ALLOWED_MODELS`) that the raw `deepseek` backend
honors, but `abuddi-deepseek` ignores it and computes its own model. See
`docs/superpowers/specs/2026-06-08-deepseek-v4-thinking-models-design.md`.

### build_app.py

A one-off Python script used to programmatically patch `renderer/app.js` by inserting code at specific line patterns. It is not part of the normal build pipeline — run it manually if needed to regenerate `app.js` from a prior state.

### Driving the browser directly

The Browser API server is plain HTTP and can be driven by **any** process, not just the LLM backend. The root-level `*.py` scripts (`scan_apis.py`, `try_all.py`, `find_slugs.py`, `inspect_sidebar.py`, etc.) are scratch automation that hit this server directly via `urllib` to script the live Electron browser window — useful for ad-hoc scraping/automation while the app is running. They are exploratory tooling, not part of the app, and assume `npm start` is already running.

> **Note:** the port is now **OS-assigned per instance** (was fixed `9100`) so multiple instances don't collide. The scratch scripts that hardcode `9100` will only work if an instance happened to bind it; to target a specific instance, read its `browser_port` from the Overmind roster (`GET http://127.0.0.1:9200/arms`).

Endpoints (on the instance's `browser_port`):

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/browser/open` | Open the AI browser window |
| POST | `/browser/navigate` | Navigate to `{url}` |
| POST | `/browser/execute` | Run `{code}` JS in page context, returns `result` |
| GET | `/browser/url` | Current URL |
| GET | `/browser/logs` | Captured console log buffer |
| POST | `/browser/logs/clear` | Clear the log buffer |

The console log buffer is populated by `browser-preload.js`, which intercepts `console.*` in the browser window and forwards entries to the main process.
