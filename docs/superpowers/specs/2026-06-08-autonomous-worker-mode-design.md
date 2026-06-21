# Autonomous Worker Mode — Design

**Date:** 2026-06-08
**Status:** Approved (brainstorming) → ready for implementation plan
**Repo:** `deepconsole` (renderer-side feature; no Overmind or backend changes)

## Problem

DeepConsole can run as multiple instances coordinated by the Overmind. The blackboard
lets any instance *post* work and any idle instance *claim* it (pull, not push) — but
claiming is purely a coordination flag today. Nothing turns a claimed item into actual
agent work. The user wants to launch auxiliary instances, flip them into an **autonomous
mode** where they pull open items off the blackboard, complete the work with their full
AI agent, and report the result back somewhere everyone can see.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| What does "complete the work" mean? | **Full agent** — a normal `abuddi-deepseek` session with every tool (file edits/auto-commit, browser, `run_command`, memory, delegation). |
| Where does the result go? | **Mark the board item Done with a result summary.** Everyone sees it flip to ✓ live; the Ghost distills a learning into the shared Knowledge Base. No new surface. |
| How does the worker pick up jobs? | **One at a time, event-driven.** Idle worker watches the live board feed, atomically claims ONE open item, runs it to completion, marks Done, then looks for the next. Never two jobs at once. |
| Where does the job run? | **In the instance's visible chat panel**, reusing the existing session/`sendMessage`/`done` chat path — so the operator can watch the agent work. (Not a hidden headless session.) |
| On failure? | **Release** the item back to `open` so another worker can retry; go idle. |

## Architecture

### Control: a toggle in the Overmind tab

A checkbox/toggle **"Autonomous mode"** (off by default) in the Overmind view, plus a
status line:

- `Autonomous: off`
- `Autonomous: on · idle — watching board`
- `Autonomous: on · working — "<item title>"`

Toggling **off** while a job is running lets the current job finish (and mark Done), then
stops claiming. No hard mid-job abort in v1.

### Worker state machine (renderer module)

A small, self-contained module — `renderer/autonomous.js` — holding the loop, kept
separate from chat UI code so it is unit-testable. States:

```
        ┌────────── enabled & open item seen ──────────┐
        ▼                                               │
   ┌─────────┐  claim 200   ┌──────────┐  done   ┌────────────┐
   │  IDLE   │ ───────────► │ RUNNING  │ ──────► │  REPORTING │
   │(watching)│  claim 409   │ (in chat)│  error  │(done/release)│
   └─────────┘ ◄─ skip ──┐   └──────────┘ ──────► └────────────┘
        ▲                │                              │
        └──── next ──────┴──────────────────────────────┘
```

Invariants:
- **Single in-flight guard:** at most one claim held / one job running at a time. New
  board events are ignored while `RUNNING`/`REPORTING`.
- The machine never calls the LLM or Overmind directly — it is driven through two injected
  collaborators (below) so it can be tested with fakes.

### Collaborators (injected interfaces)

The state machine depends only on these two small interfaces:

1. **`board`** — Overmind operations it already has via `window.deepconsole.overmind`:
   `claim(id) → {item} | {error}` (409 surfaces as an error/`null`), `done(id, result)`,
   `release(id)`, `setStatus({status, focus})`, and the live `onEvent` board feed.
2. **`runTask(text) → Promise<string>`** — runs the task to completion in the visible chat
   and resolves with the agent's final answer. Implemented as `await sendMessage(text)`
   (see below) — which already awaits the stream to completion and now returns the final
   text. Rejects if the chat errors so the machine can release the item.

### Driving the visible chat

`sendMessage()` currently reads `messageInput.value` and returns nothing. Refactor it to:
(a) accept an optional explicit `text` argument (default: read the input box) so the worker
can call `sendMessage(taskText)` without touching the DOM input; and (b) **return the final
response text** (the value it already captures in `lastAIMessage` on the `done` event) once
`await llm.chat(...)` resolves at stream end, and let it reject/throw on the `error` event.
The existing `isStreaming` guard already prevents overlapping sends. With that, `runTask`
is exactly `sendMessage(text)`. (This refactor is backward-compatible: the manual send
button calls `sendMessage()` with no args and ignores the return value.)

### Data flow (one job)

1. Board SSE event arrives → if `enabled && state == IDLE`, pick the **oldest `open`**
   item and call `board.claim(item.id)`.
2. Claim **409 / error** → another worker won; stay IDLE, wait for the next event.
3. Claim **200** → `state = RUNNING`; `board.setStatus({status:'working', focus:item.title})`;
   `result = await runTask(item.title + (item.detail ? "\n\n" + item.detail : ""))`.
4. `runTask` resolves → `state = REPORTING`; `board.done(item.id, summarize(result))`.
   The Overmind broadcasts the ✓ and records the Ghost learning.
5. `board.setStatus({status:'idle', focus:''})`; `state = IDLE`; re-scan the current board
   for any other open item (so a backlog drains without waiting for a new event).

`summarize(result)` = the final answer trimmed to a sane length (e.g. first ~1500 chars)
so the board result stays readable; the full work is visible in the chat panel.

### Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `renderer/autonomous.js` | Worker state machine (enable/disable, claim→run→report, single-in-flight) | injected `board` + `runTask` only |
| `renderer/app.js` (wiring) | Build `board`/`runTask` from real APIs; refactor `sendMessage(text?)`; toggle + status line; feed `overmind.onEvent` board events to the machine | autonomous.js, existing chat + overmind bridges |
| `renderer/index.html` | Autonomous toggle + status line in the Overmind view | — |
| Overmind / backend | **No changes** — `claim`/`done`/`release`/`setStatus` and the chat path already exist | — |

## Error handling

- **Claim race (409):** skip, stay IDLE. Expected and benign with multiple workers.
- **`runTask` rejects / agent error / timeout:** `board.release(item.id)` → IDLE, log it.
  The item returns to `open` for another worker (or a later retry by the same one).
- **Toggle off mid-job:** finish the current job (mark Done), then stop claiming.
- **Backlog:** after each job, re-scan the latest board snapshot so queued items drain
  without needing a fresh SSE event.
- **Never** hold more than one claim — the in-flight guard rejects new work while busy.

## Safety

Full-agent autonomy means an unattended worker can edit files (auto-commit), run commands,
and browse. The net is the backend's existing `safe_dispatch` guardrails (blocked
destructive commands; no read↔write self-pipe). This design does **not** add a sandbox.
Practical mitigation, documented for the operator: run auxiliary workers in a dedicated
working directory, and be deliberate about what gets posted to a board that autonomous
workers are watching. (A per-item scope/allowlist is a possible future extension — out of
scope here.)

## Testing

Unit-test `renderer/autonomous.js` against a **fake `board`** and a **fake `runTask`**
(no Electron, no network):

- **Happy path:** open-item event → claims → runs → marks Done with the summarized result;
  status goes working→idle.
- **Claim race:** `claim` returns an error/409 → stays IDLE, no `runTask` call.
- **Single in-flight:** a second board event during RUNNING does not start a second job.
- **Release on error:** `runTask` rejects → `board.release` called, returns to IDLE.
- **Toggle off after current:** disabling mid-job still completes + marks Done, then no
  further claims on the next event.
- **Backlog drain:** two open items → after finishing the first, it claims the second
  without a new event.

The Overmind claim CAS itself is already covered by `overmind/tests`. The thin
`renderer/app.js` wiring (DOM toggle, building the real collaborators) is verified by the
manual smoke test, not unit tests.

## Out of scope (YAGNI)

- Concurrent/greedy multi-job workers (chose one-at-a-time).
- Hidden/headless background sessions (chose the visible chat panel).
- A dedicated "results" feed or peer-ask reporting (chose board Done + Ghost).
- Per-item execution-scope tags / sandboxing.
- Hard mid-job abort (toggle-off finishes the current job).
- Retry caps / backoff bookkeeping — release-and-requeue is enough for v1; a poison item
  just gets re-claimed and re-released, which is visible on the board.

## Smoke test (manual, post-implementation)

Launch two instances. In instance B, flip **Autonomous mode** on. From instance A, post a
task to the blackboard. Expect: B claims it (roster shows B `working · "<title>"`), the
task runs in B's chat panel, the board item flips to ✓ with a result summary, and a
learning appears in the Knowledge Base. Post a second item while B is busy → it's picked up
right after the first completes, never concurrently.
