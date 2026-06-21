# Live Sub-Agent Delegation Visual

**Date:** 2026-06-07
**Status:** Approved design — ready for implementation plan
**Topic:** Realtime visual for ABUDDI sub-agent delegation

## Problem

When the abuddi-deepseek backend decides to `MAESTRO_DECISION: DELEGATE`, it yields a single
token `"\n\n[ABUDDI] Delegating to sub-agents...\n"` and then **blocks** on
`await orchestrator.dispatch_subtasks(...)` while all sub-agents run to completion. During that
entire window the renderer receives no events, so the user sees a frozen "Delegating..." line with
no indication of what the sub-agents are doing or whether anything is happening.

We want a **fun and informative** inline visual that shows each sub-agent's real, live progress.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Data fidelity | **Real streamed progress** — wire genuine per-subagent events through the SSE pipe |
| Placement | **Inline in the chat stream** — a live card where the "Delegating..." text would be |
| Style | **Hybrid** — themed header/framing, clean information-dense cards per agent |
| Detail depth | **All four:** status transitions, tool calls, live token preview, final result summary |

## Architecture — the event path

The fix threads real per-child events through the existing SSE pipe via an `asyncio.Queue`, so the
parent generator can keep streaming while sub-agents run concurrently.

```
sub-agent child loop ──put──▶ asyncio.Queue ──drain──▶ parent generator
 (_run_child in            (progress events)      (abuddi_deepseek.stream)
  agent_orchestrator.py)                                  │
                                                          ▼
                                    engine.chat_session passes through
                                                          │
                                          SSE event "subagent" ──▶ app.js
```

The SSE event types are already extensible (`token`, `tool_call`, `tool_result`, `ask`, `done`,
`warning`, `error`). We add one new type: **`subagent`**.

## Backend changes

### 1. `../localllm-abuddi/agent_orchestrator.py`

- `dispatch_subtasks(...)` gains an optional `progress_queue: asyncio.Queue | None = None` param.
- `_create_sub_agent_session(...)` / `_run_child` already iterate
  `async for event in self._engine.chat_session(...)`. For each child event, push a tagged
  progress event onto the queue:

  ```python
  {
    "name": child_info["name"],
    "hat": child_info["hat"],
    "session_id": child_session_id,
    "phase": "spawned" | "thinking" | "tool" | "token" | "done" | "failed",
    "tool":   <tool name, when phase == "tool">,
    "text":   <token text, when phase == "token">,
    "result": <one-line result/status, when phase == "done">,
    "error":  <error string, when phase == "failed">,
    "depth":  <recursion depth, default 0>,
  }
  ```

- Emit `spawned` immediately when the child session is created; `thinking` on first token;
  `tool` per `tool_call` event; `token` per token (throttling happens client-side); `done` /
  `failed` at the end.
- For recursive child-of-child delegations, pass the same queue down and tag events with an
  incremented `depth` so the UI can indent them under the parent card.

### 2. `../localllm-abuddi/backends/abuddi_deepseek.py` (around line 138)

Replace the blocking `await orchestrator.dispatch_subtasks(...)` with a queue-drain loop:

1. Create `queue = asyncio.Queue()`.
2. Up front, yield `{"type": "subagent", "data": {"phase": "start", "subtasks": [...]}}` so the UI
   knows the full roster (names + hats) before any child reports.
3. Launch `task = asyncio.create_task(orchestrator.dispatch_subtasks(..., progress_queue=queue))`.
4. Drain loop: while the task is not done OR the queue is non-empty, `await queue.get()` (with a
   short timeout so we re-check task completion) and `yield {"type": "subagent", "data": event}`.
5. After the task completes, `results = task.result()`, then yield synthesis + final `response`
   exactly as today.
6. The existing `try/except` around delegation stays — on failure the `[ABUDDI ERROR]` fallback
   still fires and the UI marks outstanding cards as failed.

### 3. `../localllm-abuddi/engine.py` (the `async for chunk in backend.stream(...)` loop, ~line 362)

Add a passthrough branch:

```python
elif chunk["type"] == "subagent":
    yield {"event": "subagent", "data": chunk["data"]}
```

### 4. `../localllm-abuddi/server.py`

No change needed — `_sse(...)` serializes any event dict generically.

## Frontend changes

### 5. `renderer/app.js` — new `case 'subagent':` in the SSE handler (around line 448)

Maintain a `Map` of cards keyed by `session_id`, and render **one inline delegation panel** in the
chat at the delegation point. Phase handling:

- `start` → build the panel with a card per subtask (spawned/empty bars), header
  `N agents deployed`.
- `spawned` / `thinking` → update status badge, start the wiggle/shimmer animation.
- `tool` → append a `🔧 tool(args)` activity line, bump the progress bar.
- `token` → update a truncated live-text ticker (latest ~80 chars), **throttled to ≤5 updates/sec**.
- `done` / `failed` → settle the card, show ✓/✗ + one-line result, fill the bar.
- On chat `done` → collapse the panel to a compact summary (e.g. `3 agents · 3 ✓`).
- `depth > 0` events render as an indented mini-row under the parent card.

### 6. `renderer/index.html`

Markup/`<template>` for the delegation panel container and the per-agent card.

### 7. `renderer/style.css`

Hybrid styling: panel header, per-agent cards (hat icon, name, progress bar, activity line,
token ticker), a subtle CSS `@keyframes` wiggle/shimmer while active that settles on done. Reuse
existing hat icons already defined in `app.js`:
`{ 'product-maestro': '👑', 'feature-owner': '⭐', 'sub-ic': '🔧', 'synthesizer': '🧩',
'browser_commander': '🌐', 'code_implementer': '💻' }`.

## Design decisions worth flagging

- **Progress bar is heuristic, not true %.** LLM agents have no real completion percentage. The bar
  is phase-driven: `spawned` ≈ 10%, an indeterminate shimmer while `thinking`, small bumps per tool
  call, `done` = 100%. It should read as "alive," not imply precise progress.
- **Token ticker is throttled** (≤5×/sec, last line only) so it stays lively, not noisy.
- **Failure-safe:** if the queue/dispatch throws, the existing `[ABUDDI ERROR]` fallback still
  fires; cards mark `✗ failed`. The visual must never block or break the actual delegation.
- **Recursion:** child-of-child delegations surface as nested/indented rows under the parent card,
  one panel per top-level delegation.

## Out of scope (YAGNI)

No new tab, no polling, no floating overlay, no persistence of past delegations, no config/settings.
One inline panel, real events, themed.

## Testing notes

- This is an Electron app with no automated test/lint scripts. Verification is manual via
  `npm run dev` against a real delegating prompt (a high-complexity task that scores ≥20 so ABUDDI
  delegates).
- Backend changes can be smoke-tested by confirming `subagent` SSE events appear in the stream
  before the synthesis block.
- Key risk to verify: the queue-drain loop must terminate cleanly (task done + queue empty) and must
  not swallow or reorder the final `response` chunk.
