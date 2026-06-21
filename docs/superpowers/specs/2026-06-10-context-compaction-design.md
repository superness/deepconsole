# Context Compaction — Design

**Date:** 2026-06-10
**Status:** Approved (brainstorming)
**Component:** `../localllm-abuddi/` backend (engine + new `context_manager.py`)

## Problem

The session history pruner (`safety.prune_history`) handles context-window
pressure by popping the **oldest non-system messages one at a time** until a
char-based estimate (`len(content)//4`) drops under `MAX_CONTEXT_TOKENS = 28000`.

This is lossy and dumb:

- It discards exactly the early context that matters most — the original task,
  decisions made, files touched — while keeping recent noise.
- It treats `history` as the only memory, ignoring the three systems DeepConsole
  already has for durable state: the 3-tier working memory store, the knowledge
  base, and the Ghost synthesizer.
- The estimate counts only `content` strings; the always-injected dynamic
  context block and `tool_calls` payloads are uncounted. (Estimator rework is
  **out of scope** here — see Non-Goals.)

## Goals

Replace blind FIFO eviction with **staged compaction** that moves information
into DeepConsole's durable stores instead of deleting it. Four strategies,
applied in the streaming chat path where the session dict and async context are
available:

1. **Rolling summary (#1)** — fold the evicted prefix into a running summary.
2. **Knowledge synthesis / Ghost-on-evict (#2)** — extract durable facts to the
   knowledge base during summarization.
3. **Task-state carryover (#3)** — keep the task spine in budget-exempt
   session-tier memory so it survives any compaction.
4. **Tiered eviction (#4)** — stub bulky old tool results before dropping any
   conversation turns.

## Non-Goals

- Token-estimator rewrite / real tokenizer (#6). Keep `len//4`. Stage A targets
  the tool `content` the estimator already counts, so they stay consistent.
- Retrieval/RAG over evicted history (#5).
- Changing the sync `_sanitize_chat` pre-step (keeps plain `prune_history`).

## Architecture

### New module: `context_manager.py`

Single async entry point:

```python
async def compact_session(session, owner, *, summarize=_flash_summarize) -> bool
```

- Operates on the in-memory `session` dict (mutates `session["history"]` and
  `session["compaction_summary"]`); the caller persists the session.
- `summarize` is injectable (defaults to the flash implementation) so unit
  tests run with a deterministic fake and **no model calls**.
- Returns `True` if any compaction occurred.

`safety.prune_history` stays as the pure-sync fallback, still used by
`_sanitize_chat`.

### Budget constants (hysteresis)

- `MAX_CONTEXT_TOKENS = 28000` — **trigger**. Below this, `compact_session`
  returns `False` immediately.
- `COMPACT_TARGET_TOKENS = 18000` — compact **down to** this, so we don't
  re-summarize on every subsequent turn.
- `RECENCY_WINDOW = 6` — the last N messages are always kept verbatim.
- `history[0]` (the system message) is always preserved.

### Stages (re-check budget after each; stop once under target)

**Stage A — stub old tool results (#4).**
Walk history oldest→newest, skipping `history[0]`, the compaction-summary
message, and the recency window. For each `role:"tool"` message whose `content`
exceeds `TOOL_STUB_THRESHOLD = 200` chars (stubbing a tiny result reclaims
nothing), replace its `content` with `"[tool result elided — N chars]"`, keeping
`tool_call_id` intact so `sanitize_history` pairing stays valid. Lossless for
reasoning; reclaims the biggest hog first. Often sufficient alone.

**Stage B — summarize + fold prefix (#1).**
If still over target: take the evictable prefix (everything except `history[0]`,
the existing compaction-summary message, and the recency window). One flash call
summarizes it. The result merges into `session["compaction_summary"]`, which is
re-rendered as a single **marked** synthetic system message
(`{"role":"system","content": ..., "_compacted": true}`) inserted immediately
after `history[0]`. The marked message is replaced (not duplicated) on each pass,
so re-folding is idempotent. The evicted prefix messages are removed.

**Failure mode (flash-only, per decision):** if the flash call raises or returns
nothing, fall back to plain FIFO drop of the prefix (current behavior). No
heuristic summary is produced.

**Stage C — Ghost-on-evict (#2).**
The Stage-B flash call returns JSON `{"summary": str, "facts": [str, ...]}`. Each
fact is recorded via `knowledge.record_learning()` so durable facts persist in
the always-injected knowledge base. Best-effort: a failure here never blocks
compaction.

### Strategy #3 — task-state carryover (no prune logic)

Session-tier memory (`session_{id}`) is rebuilt from disk and injected into the
system prompt every turn (`_build_session_context` / `inject_session_memory`),
and is **exempt from the 28k history budget**. So it already survives any chop.
The only change: a short directive in the system-prompt builder instructing the
agent to maintain a `task_state` entry (goal / done / next / decisions) in
session memory via `memory_set`. That entry is the spine that outlives
compaction.

### Flash summarizer

`_flash_summarize(text) -> dict` reuses the `session_title.py` pattern:
`openai.AsyncOpenAI(base_url="https://api.deepseek.com")`, model
`deepseek-v4-flash`, best-effort. Prompts for a compact running summary plus a
short list of durable facts, returning the JSON contract above. Returns `None`
on any failure (missing key, network, parse error) so the caller can apply the
FIFO fallback.

## Data flow

```
engine.chat() streaming path (engine.py:~502)
  history = sanitize_history(history)
  await context_manager.compact_session(session, owner)   # was: prune_history(...)
    ├─ under 28k?  → return False
    ├─ Stage A: stub old tool results          (cheap, local)
    ├─ Stage B: flash-summarize evicted prefix → fold into compaction_summary
    │            (on failure → FIFO drop)
    └─ Stage C: record returned facts → knowledge.record_learning()
  persist session
  build prompt (system + compaction-summary msg + session/agent/meta memory + KB)
```

## Testing

`tests/test_context_manager.py` (pytest, `asyncio_mode=auto`), injecting a fake
`summarize`:

- under budget → no-op, returns `False`
- Stage A alone brings it under target → tool content stubbed, no summary call,
  conversation turns intact
- Stage B path → prefix folded into a single marked synthetic system message;
  `history[0]` and recency window preserved; `tool_call_id` pairing valid
- idempotent re-fold → second compaction replaces (not duplicates) the marked
  message
- model-failure → FIFO fallback drop, no marked message added
- Stage C → recorded facts forwarded to a patched `knowledge.record_learning`

Run: `python -m pytest tests/test_context_manager.py`

## Files touched

- **new** `../localllm-abuddi/context_manager.py`
- **new** `../localllm-abuddi/tests/test_context_manager.py`
- `../localllm-abuddi/engine.py` — swap prune call in the streaming path;
  add `task_state` directive to the system-prompt builder
- `../localllm-abuddi/safety.py` — add `COMPACT_TARGET_TOKENS` constant
  (or co-locate budget constants in `context_manager.py`)
