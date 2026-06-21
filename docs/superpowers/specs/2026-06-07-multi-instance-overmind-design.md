# Multi-Instance DeepConsole + Standalone Overmind — Design

**Date:** 2026-06-07
**Status:** Approved (pending spec review)

## Problem

Today DeepConsole assumes it is the only instance running:

- `main.js` hardcodes `LLM_PORT = 8000` and `BROWSER_API_PORT = 9100` as module constants.
- On startup `main.js` **actively kills** whatever is listening on port 8000 (lines 22–46), so launching a second instance tears down the first instance's LLM backend.
- Each instance spawns its own `uvicorn server:app`, and that backend reads/writes shared on-disk state in `../localllm-abuddi/` (`memory_store/`, `knowledge.json`, sessions) — so even with separate ports they collide on disk.
- There is no single-instance lock, so multiple Electron processes *can* launch today; they simply fight over ports and files.

We want to run **N independent DeepConsole instances** — each with its own window, its own chat sessions, and its own AI-controlled browser — that are **aware of one another** through a coordination layer.

## What we keep, what we replace

An existing coordination server (`localhost:9000`) has the *right concept* — arms reporting in, a central view, peer-to-peer queries, a Ghost that synthesizes learnings — but the wrong mechanics. Specifically:

- **Keep:** presence/awareness, peer-to-peer `ask`, Ghost synthesis, shared live state.
- **Reject:** the **quests/missions** system — top-down, assigned, *sequential* orchestration of agents.
- **Replace it with:** a **self-organizing blackboard** — work items are posted to a shared board and any idle instance *pulls* what it can do. Pull, not push. Parallel by default. No central assigner, no sequence.

The coordinator is a **new, dedicated, DeepConsole-specific service**, because we want to fix the mechanics rather than inherit them.

## Guiding principle — the Overmind watches and creates space

The Overmind is **passive and facilitative, never directive.** Its whole job is to *watch* (hold live presence, board state, and the flow of asks) and to *create space* (provide the roster, the blackboard, and the channel) in which instances coordinate *themselves*. It never assigns work, never sequences it, never prioritizes it, never tells an instance what to do. All initiative lives in the instances:

- Work appears on the board because someone posts it; it gets done because an idle instance *chooses* to claim it.
- Awareness flows because the Overmind reflects what instances report — not because it commands them to act on it.
- Even the **Ghost only observes and makes learnings available** as shared knowledge; it does not push tasks or issue directives.

If a design decision ever turns the Overmind into a controller (an assigner, a scheduler, a priority engine), that is a smell — push the initiative back down into the instances and keep the Overmind watching.

## Architecture

```
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ DeepConsole  │   │ DeepConsole  │   │ DeepConsole  │   ← N independent
   │  instance A  │   │  instance B  │   │  instance C  │     Electron processes
   │ arm: "alpha" │   │ arm: "bravo" │   │ arm: "cleo"  │     (own window, own
   │ browser:51xx │   │ browser:51yy │   │ browser:51zz │      browser, own sessions)
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          │  SSE (live push) + REST            │
          └──────────────┬────────────────────┘
                         ▼
              ┌────────────────────────┐
              │   OVERMIND (port 9200) │   ← NEW standalone process
              │  • presence roster     │     survives independent of
              │  • blackboard (work)   │     any instance & the LLM backend
              │  • peer-ask routing    │
              │  • Ghost synthesizer   │
              └───────────┬────────────┘
                          │ reads/writes shared learnings
                          ▼
              ┌────────────────────────┐
              │  Shared LLM backend    │   ← ONE uvicorn (8000), spawned once
              │  server:app  :8000     │     sessions namespaced per instance;
              │  memory_store/ (shared │     meta/agent memory = shared substrate
              │   meta+agent tiers)    │
              └────────────────────────┘
```

Three roles, cleanly separated:

1. **Instance (Electron)** — owns a window, a private set of chat sessions, and its own browser window on a dynamically-allocated port. Isolated from peers. Talks to the shared backend for chat, and to the Overmind for awareness.
2. **Shared LLM backend (8000)** — serves all instances' chat/tools. Session memory stays private (namespaced by session id); `meta`/`agent` memory tiers are the shared substrate the blackboard and Ghost build on. The first instance to launch spawns it; the rest attach.
3. **Overmind (9200, new)** — live presence, the self-organizing blackboard, peer-ask routing, and the Ghost. Pushes changes live over SSE so nobody polls. Outlives any single instance.

## Component 1 — The Overmind (standalone, port 9200)

A small service (FastAPI recommended, to match `server.py` idioms). It holds **in-memory live state plus a JSON snapshot on disk** so a restart recovers. Four concerns plus a live-push channel.

### Presence roster

```
arm = {
  id: "alpha",                 # stable per instance (uuid + friendly name)
  pid, browserPort, sessions,  # so peers/operator can address it
  status: "idle|working|blocked",
  focus: "short text — what I'm on right now",
  lastSeen: ts                 # heartbeat every ~5s; stale → "offline"
}
```

- `POST /arms/register` on launch.
- `POST /arms/{id}/heartbeat` on a ~5s timer.
- Arms whose `lastSeen` is older than a staleness threshold are reaped (marked offline).

### Blackboard (self-organizing work list — pull, not push)

```
item = {
  id, title, detail,
  tags: ["browser","scrape","rapidapi"],   # capability hints, NOT assignments
  state: "open|claimed|done|abandoned",
  claimedBy: armId|null, claimedAt,
  result: text|null, postedBy
}
```

- `POST /board` — anyone posts work (an instance, the operator, or the Ghost).
- `GET /board` — current board.
- `POST /board/{id}/claim` — **atomic compare-and-set**: succeeds only if `state == open`. Two idle arms race; one wins, the other moves on. This is what makes it self-organizing and collision-free — no central assigner, no sequence.
- `POST /board/{id}/release` — return an item to `open`.
- `POST /board/{id}/done` — mark complete with a `result`.
- **Lease:** a claim auto-releases if the claiming arm stops heartbeating for N minutes, so a dead arm never freezes an item.

### Peer-ask

- `POST /arms/{id}/ask {from, message}` — routed to the target instance over its SSE channel. The instance surfaces it in its UI / injects it for its AI and replies. Synchronous request/response. No shell, no curl.

### Ghost (synthesizer)

- **Event-driven** (on board `done` events, not a fixed timer): reads completed board items plus shared `agent`/`meta` memory, distills learnings, and writes them back into the shared **Knowledge Base** (`knowledge.json`) that every instance already injects into its system prompt. Learning propagates without anyone polling.

### Live push

- `GET /stream` (SSE). Every state change — presence, board, ask — fans out to all connected instances. This is the "no polling" fix. The renderer subscribes once and reacts.

## Component 2 — Instance-side changes

### `main.js`

- **Remove the 8000-killer** (lines 22–46).
- Add `ensureSharedService(port, spawnFn)`: probe `/health`; spawn only if absent. Apply to the backend (8000) and the Overmind (9200). The loser of a spawn race simply attaches — tolerable.
- `BROWSER_API_PORT` → `0` (OS-assigned); capture the real port from the `srv.listen` callback.
- On startup: generate/persist this instance's arm id (in Electron `userData`), `register` with the Overmind, start a heartbeat timer, open the SSE stream, and forward Overmind events to the renderer via `event.sender.send('overmind:event', …)`.
- New IPC handlers: `overmind:register/heartbeat/postItem/claim/done/ask/roster/board`.

### `preload.js`

- Expose `window.deepconsole.overmind.*` — a mirror of the IPC handlers plus an `onEvent` subscription — following the existing `llm`/`memory` context-bridge pattern.

### `renderer/` — new "Overmind" tab

Alongside the existing Browser / Console / JS Runner / Agents / Memory tabs:

- **Roster panel:** live list of arms, status dot, focus text, and an "Ask" button that opens a peer-ask to that arm.
- **Blackboard panel:** open items each with a **Claim** button (greys out the instant someone else wins the CAS), this instance's claimed items with **Done/Release**, and a "Post item" box.
- **Incoming asks:** a small inbox that pops when a peer asks this instance something; reply inline.
- All driven by the single `overmind:event` SSE feed — no polling anywhere.

### Identity

Auto-generated arm id on first run (uuid + friendly name), persisted in Electron `userData`. Friendly name editable in the Overmind tab.

## Decisions (defaults chosen)

- **Ghost cadence:** event-driven on board `done` events (not a fixed timer).
- **Blackboard posting rights:** anyone may post — instances, the operator, or the Ghost (not operator-only).
- **Coordinator home:** standalone process on its own port (9200), independent of the LLM backend lifecycle.
- **Backend model:** one shared uvicorn on 8000; sessions namespaced; session memory private; `meta`/`agent` memory shared as the blackboard/Ghost substrate.

## Out of scope (YAGNI)

- Authentication/authorization between instances (assumed trusted localhost network).
- Cross-machine coordination (Overmind is `127.0.0.1` for now; remote arms are a later concern).
- Migrating or interoperating with the existing server on 9000 — this is a separate, parallel coordinator.
- Persisting full chat transcripts in the Overmind — it tracks presence/board/asks, not conversation history.

## Open risks

- **Spawn race on shared services:** two instances launching simultaneously may both try to bind 8000/9200. The loser's `uvicorn`/service fails to bind and must fall back to attaching. Needs a clean "bind failed → attach" path, or a lightweight lockfile.
- **Disk contention on shared memory_store / knowledge.json:** the shared backend already serializes access through its own process, so routing all writes through the single 8000 backend (rather than instances writing files directly) avoids multi-writer corruption. The Ghost must also write `knowledge.json` via the backend, not directly.
