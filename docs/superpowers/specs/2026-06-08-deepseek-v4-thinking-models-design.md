# DeepSeek V4 (flash/pro) + Computed Thinking — Design

**Date:** 2026-06-08
**Status:** Approved (brainstorming) → ready for implementation plan
**Repos touched:** `localllm-abuddi` (backend, most work) and `deepconsole` (small UI model picker)

## Problem

DeepConsole's LLM backend hardcodes `model="deepseek-chat"` in both DeepSeek backends with
`max_tokens=8192` and no reasoning support. DeepSeek has moved to V4:

- `deepseek-v4-flash` — fast/cheap baseline. 1M context, 384K max output.
- `deepseek-v4-pro` — stronger, ~3× flash output cost. 1M context, 384K max output.
- Both support a **thinking mode** (chain-of-thought before the answer), default enabled, with
  `reasoning_effort` of `high`/`max`.
- `deepseek-chat` / `deepseek-reasoner` deprecate **2026-07-24** (they map to flash
  non-thinking / flash thinking respectively), so no hard rush, but we adopt explicit V4 names now.

We want, at the user's direction:

1. **Flash as the baseline** model everywhere (replacing `deepseek-chat`).
2. **Pro selected explicitly** by the user for code work (not auto-routed).
3. **Thinking mode computed** — enabled automatically for complex tasks, off for routine ones,
   on a **Balanced** cost posture (thinking/pro only when genuinely warranted).

## Key constraint: thinking mode + tool calls require `reasoning_content` threading

Per DeepSeek docs: in thinking mode, once an assistant turn performs a **tool call**, that turn's
`reasoning_content` **must be passed back to the API in all subsequent requests**, or the API
returns **HTTP 400**. The `abuddi-deepseek` backend is tool-heavy (it edits files), so enabling
thinking there is incorrect unless `reasoning_content` is captured and threaded through the
conversation history. This is mandatory work, not optional.

## Key decision: triage is the single scoring authority

Thinking mode is a **pre-request** parameter, but ABUDDI's `complexity_score` is currently emitted
*inside* the model's main response (parsed post-hoc to decide DELEGATE vs IMPLEMENT). You cannot use
a post-response score to gate thinking on the same call.

**Resolution (user-chosen):** make ABUDDI scoring an explicit **triage pass** run in cheap
`flash` **non-thinking** mode. Its `complexity_score` becomes the single authority that drives both
the delegation decision and the thinking decision for the subsequent work pass. Today's inline
self-scoring in the work response is removed in favor of this dedicated pass.

## Architecture

### Backend request config interface

The engine passes a small per-request config into the backend carrying the **user-selected model**:

```python
# config object handed to backend.stream(messages, tools, config)
{
  "model": "deepseek-v4-flash" | "deepseek-v4-pro",  # session's stored selection
  "thinking": True | False,            # default False; honored by the raw deepseek backend
  "reasoning_effort": "high" | "max" | None,
}
```

- `engine` builds this from the session's stored `model` (default flash) and passes it to
  `backend.stream()`. The engine does **not** compute the thinking decision — that is ABUDDI's job.
- **The `abuddi-deepseek` backend owns its thinking decision:** it runs its own triage pass and
  derives `thinking`/`reasoning_effort` internally from the resulting `complexity_score`, applying
  them to the work pass. It uses `config["model"]` for the work pass only.
- **The raw `deepseek` backend** simply honors whatever `config` says (default flash,
  thinking off) — no triage, no scoring.
- Backends that don't understand it (e.g. `ollama`) ignore the extra argument. Signature becomes
  `stream(self, messages, tools, config=None)`.

### `abuddi-deepseek` two-phase flow

```
                 ┌─────────────────────────────────────────────┐
 user turn ─────►│ PHASE 1 — TRIAGE                            │
                 │  model = deepseek-v4-flash                  │
                 │  thinking = disabled                       │
                 │  tools = none, max_tokens ≈ 512            │
                 │  prompt = ABUDDI scoring prompt            │
                 │  → complexity_score, decision              │
                 └───────────────┬─────────────────────────────┘
                                 │
              score ≥ 20         │         score < 20
        ┌────────────────────────┴────────────────────────┐
        ▼                                                  ▼
 PHASE 2a — DELEGATE                            PHASE 2b — WORK
 existing sub-agent dispatch                    model = session-selected (flash|pro)
 path, unchanged                                thinking = enabled if score ≥ THINKING_THRESHOLD
                                                  effort = "high", → "max" if score ≥ MAX_EFFORT_THRESHOLD
                                                tools = full, max_tokens = 16384, streamed
                                                reasoning_content captured + threaded
```

Thresholds (tunable constants, Balanced defaults):

| Constant | Default | Meaning |
|---|---|---|
| `THINKING_THRESHOLD` | 12 | score ≥ → enable thinking on the work pass |
| `MAX_EFFORT_THRESHOLD` | 30 | score ≥ → `reasoning_effort="max"` (else `"high"`) |
| `DELEGATE_THRESHOLD` | 20 | existing — score ≥ → delegate to sub-agents |

> Note the ordering: with `DELEGATE_THRESHOLD=20`, a non-delegated work pass has score < 20, so
> thinking applies in the `[12, 20)` band and below it stays non-thinking. The `max` effort band
> (≥ 30) is therefore only reachable on the **delegated sub-agents' own work passes**, not the
> parent — which is the intended behavior (hard tasks are decomposed; each child may itself be
> complex enough to think hard). Thresholds are constants so this balance can be tuned later.

### Plain `deepseek` backend

Stays a raw passthrough: `model=deepseek-v4-flash`, thinking disabled, no triage. It honors a
`config.model` / `config.thinking` if the engine supplies one (so a future caller could request pro
or thinking), but defaults to flash/non-thinking with no scoring overhead.

### `reasoning_content` threading

1. **Capture:** in each backend's streaming loop, accumulate `delta.reasoning_content` alongside
   `delta.content`. Include it in the yielded `response` chunk:
   `{"type": "response", "content": ..., "reasoning_content": ..., "tool_calls": [...]}`.
2. **Persist:** in `engine`, when recording the assistant turn (currently engine.py:475 for the
   tool-call branch, and the final-answer branch), add `reasoning_content` to the assistant message
   dict when present.
3. **Replay:** because backends receive the full history as `messages`, the stored
   `reasoning_content` field is passed straight back to the OpenAI-format request on subsequent
   rounds (the SDK accepts `reasoning_content` on assistant messages). `safety.sanitize_history`
   must preserve the field.
4. Non-thinking turns simply have no `reasoning_content` — nothing to thread.

### Thinking-mode parameter hygiene

In thinking mode the API ignores `temperature`/`top_p`/`presence_penalty`/`frequency_penalty`. The
current code doesn't set these, so no change needed, but the work pass must pass thinking via the
OpenAI SDK shape:

```python
resp = await client.chat.completions.create(
    model=config["model"],
    messages=messages,
    tools=tools or NOT_GIVEN,
    stream=True,
    max_tokens=16384,
    reasoning_effort=config["reasoning_effort"],      # when thinking
    extra_body={"thinking": {"type": "enabled" if config["thinking"] else "disabled"}},
)
```

### DeepConsole UI: explicit model selection

- Sessions already carry a `model` field (the picker UI renders `backend · model`).
- Add a **Flash / Pro** selector to the new-session flow in `renderer/` (default Flash).
- `main.js` `llm:createSession` passes the chosen `model` to `POST /sessions` (today it sends only
  `backend: 'abuddi-deepseek'` + `working_dir`).
- The engine stores `model` on the session; the abuddi backend's **work pass** uses it. (Triage is
  always flash regardless of selection.)

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `backends/deepseek.py` | Raw flash passthrough; honors `config`; captures `reasoning_content` | openai, safety |
| `backends/abuddi_deepseek.py` | Triage → (delegate \| work); thinking gating; `reasoning_content` | agent_orchestrator, engine, openai |
| triage helper (in abuddi backend or `agent_orchestrator`) | One flash/no-think scoring call → `{score, decision, subtasks}` | openai, agent_orchestrator |
| `engine.py` | Pass session `model` through as `config`; persist + replay `reasoning_content` | backends |
| `server.py` / session schema | Accept + store `model` on session create | — |
| DeepConsole `main.js` + `renderer/` | Flash/Pro picker → `model` on session create | IPC |

## Error handling

- **Triage failure** (network/parse): fall back to score `0` → non-thinking, IMPLEMENT (i.e. behave
  like today's simple path). Never block the work pass on triage.
- **Malformed thinking response:** existing truncated-tool-args logging is retained; `max_tokens`
  raised to 16384 reduces truncation.
- **400 from missing `reasoning_content`:** prevented by the threading design; add a regression test
  that simulates a thinking tool-call round-trip and asserts `reasoning_content` survives in history.
- **Unknown model string:** validate against `{deepseek-v4-flash, deepseek-v4-pro}` at session
  create; reject with a clear error (mirrors existing unknown-backend handling).

## Testing

- **Complexity/triage:** triage runs flash + `thinking disabled`; parses score; failure → score 0.
- **Thinking gating:** score < 12 → thinking off; 12–19 → on/high; (sub-agent) ≥ 30 → max.
- **Model passthrough:** session `model=pro` → work pass calls `deepseek-v4-pro`; triage still flash.
- **`reasoning_content`:** captured from stream; persisted on assistant turn; present in the request
  on the next round of a tool-call loop; absent on non-thinking turns; preserved by
  `sanitize_history`.
- **Back-compat:** update `tests/backends/test_deepseek.py` `MODEL == "deepseek-chat"` →
  `deepseek-v4-flash`; keep registry/ollama tests green.
- **UI:** session created from DeepConsole with Pro selected persists `model=deepseek-v4-pro`.

## Out of scope (YAGNI)

- Auto-routing pro by agent hat or score (user chose explicit selection).
- A pre-flight classify call separate from ABUDDI triage (we reuse ABUDDI scoring).
- Per-message UI thinking toggle / effort slider (computed only, for now).
- Anthropic-format base URL (`/anthropic`) — we stay on the OpenAI format already in use.
- Using the full 384K output window — 16384 is the Balanced cap.

## Rollout note

`deepseek-chat`/`deepseek-reasoner` keep working until 2026-07-24, so this can ship without a flag.
After merge, a live two-session smoke test (one Flash, one Pro on a coding task) confirms thinking
turns on for complex work and tool-call loops don't 400.
