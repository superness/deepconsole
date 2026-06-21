# One-line session summary (streaming) — Design

**Date:** 2026-06-09
**Status:** Approved (design)

## Motivation

The startup session picker (`showSessionPicker` in `renderer/app.js`) labels
each session with its raw id (`7e8189e48d82`) — meaningless to a human. The
`model` field was just removed from the meta line because new sessions store
`model: null`. Replace that noise with a readable one-line summary, so the
picker reads like *"RapidAPI provider API audit"* instead of a hex id.

## Goal

Give every session a one-line `summary` shown as the picker's headline. Three
layers:

1. **Free heuristic** — first user message, truncated. Always available, shown
   instantly so the picker is never blank or blocked.
2. **Eager LLM title** — a tidy flash-generated title produced once, right after
   a session's first exchange, and stored on the session.
3. **Lazy streaming backfill** — when the picker opens, any listed session that
   still lacks a stored title has one generated in the background and
   **streamed into its row live** (heuristic label upgrades to the LLM title as
   each arrives). One-time cost; cached forever.

Non-goals: regenerating a title as a conversation evolves (generate once);
blocking the picker on generation; changing the streaming backend protocol.

## Components

### 1. `session_title.py` (new module) — pure title logic + one flash call

- `clean_title(raw: str) -> str` — strip surrounding quotes / trailing
  punctuation, collapse whitespace, cap at ~8 words and 60 chars. No I/O.
- `heuristic_summary(history: list) -> str | None` — first non-system message
  with `role == "user"` and non-empty content, whitespace-collapsed, truncated
  to ~70 chars + `…`; `None` if none. No I/O.
- `_needs_title(session: dict) -> bool` — `True` only when `session` has no
  non-empty `summary` AND history has ≥1 `user` and ≥1 `assistant` message.
- `async generate_title(first_user, first_assistant) -> str | None` — one
  `deepseek-v4-flash` completion via its own
  `openai.AsyncOpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")`
  client. System prompt: terse ≤8-word title, reply with only the title;
  `max_tokens ≈ 20`, low temperature; input = first user message + first ~500
  chars of the first assistant answer; result passed through `clean_title`.
  **Wrapped in try/except → returns `None` on any failure** (missing key,
  network, empty reply). Never raises.

### 2. `engine.list_sessions` — surface `summary` + a generated flag

Each returned session gains:
- `summary` = `session.get("summary")` → `heuristic_summary(history)` → `None`.
- `summary_generated: bool` = whether a stored LLM `summary` exists (i.e. the
  label is the real title, not the heuristic). The picker uses this to decide
  which rows still need backfill / should shimmer.

Computed while the file is already open; no extra cost. (Builds on the
just-landed `last_active`/sort logic.)

### 3. `engine.chat_session` — eager generation (after first exchange)

After the final answer for a turn is yielded (off the user's critical path), if
`_needs_title(session)`: `title = await generate_title(...)`; if `title`, set
`session["summary"]`, save, and `yield {"event": "summary", "data": {"text":
title}}`. Guarded so it fires **once per session**. Best-effort: `None` leaves
`summary` unset and the heuristic continues to cover the row.

### 4. `engine.stream_session_summaries(owner)` — lazy backfill generator (new)

`async def stream_session_summaries(owner) -> AsyncIterator[dict]`:
1. Enumerate the owner's sessions; select those with `message_count > 1` (same
   filter the picker uses) that lack a stored `summary`.
2. Generate their titles with **bounded concurrency (≈3)** via an
   `asyncio.Semaphore`; as each finishes, persist `session["summary"]` to the
   session JSON and `yield {"session_id": id, "text": title}`.
3. A session whose `generate_title` returns `None` is skipped (no event); it
   keeps its heuristic label. One failure never aborts the rest.

Yields results **as they complete** (not in batch), so rows fill in
incrementally.

### 5. `server.py` — `GET /sessions/summaries/stream` (new SSE endpoint)

Mirrors the chat SSE handler: wraps `engine.stream_session_summaries(owner)`,
emitting `event: summary\ndata: {"session_id":..., "text":...}` per result, then
closing. `media_type="text/event-stream"`.

### 6. `main.js` — IPC→SSE bridge (new handler)

A new `ipcMain.handle('llm:streamSummaries', …)` that opens an HTTP GET to
`/sessions/summaries/stream`, parses SSE lines exactly like the `llm:chat`
handler (`event:` / `data:`), and forwards each as
`event.sender.send('summaries:event', { session_id, text })`. Resolves when the
stream ends.

### 7. `preload.js` — expose the bridge

Add to `window.deepconsole.llm`: `streamSummaries()` (invokes
`llm:streamSummaries`) and `onSummary(cb)` (subscribes to `summaries:event`),
following the existing context-bridge pattern.

### 8. `renderer/app.js` `showSessionPicker` — instant render + live upgrade

- Render each row immediately, keyed by `data-session-id`. Headline =
  `s.summary` (heuristic or stored) else the id; raw id moves to the meta line
  (`${s.backend} · ${id8} · ${when}`).
- Rows where `s.summary_generated === false` get a subtle shimmer / trailing `…`
  to signal an upgrade is coming.
- After building the list, call `streamSummaries()` and subscribe via
  `onSummary(({session_id, text}) => …)`: find the row by `data-session-id`,
  replace its headline with `text`, and clear the shimmer.
- On stream end, clear any remaining shimmers (sessions whose generation failed
  keep their heuristic label).

### 9. `renderer/style.css` — pending shimmer

A small class (e.g. `.picker-item.pending .picker-item-id`) with a faint
pulsing/opacity animation; removed when the title arrives.

## Data flow

```
Startup:
  list_sessions → rows {summary (heuristic|stored), summary_generated} 
    → picker renders instantly; heuristic rows shimmer
    → streamSummaries() opens SSE → engine.stream_session_summaries
        generates (≤3 concurrent) → persists session["summary"]
        → emits {session_id, text} per completion
    → main.js forwards 'summaries:event' → renderer swaps row label, stops shimmer
Chat:
  chat_session (first exchange, no summary) → generate_title
    → persist summary → yield {event:"summary"} on the chat stream
```

## Error handling

- `generate_title` never raises → `None`.
- Missing `DEEPSEEK_API_KEY` → `None` everywhere (heuristic covers all rows).
- A per-session failure in `stream_session_summaries` is skipped; the generator
  continues. The renderer clears that row's shimmer on stream end.
- `list_sessions` already skips unreadable session files.
- The picker is fully usable before/without any stream events.

## Testing

- `clean_title`: quotes stripped, whitespace collapsed, capped ≤8 words/≤60
  chars, already-clean unchanged.
- `heuristic_summary`: first user message truncated; skips system/assistant;
  `None` when no user message.
- `_needs_title`: `False` when summary set; `False` when no assistant yet;
  `True` for a fresh first exchange.
- `list_sessions`: returns stored summary with `summary_generated=True`; else
  heuristic with `summary_generated=False`; else `None`.
- `stream_session_summaries` (stub `generate_title`): yields one event per
  un-titled `message_count>1` session, persists `summary` to each JSON, skips
  sessions that already have a title, and a `None` return for one session does
  not abort the others.
- `generate_title` returns `None` when the client call raises.
- Renderer: `node --check` + manual (no DOM test harness).

## Scope / risk notes

- New file `session_title.py`; edits to `engine.py` (list_sessions,
  chat_session, stream_session_summaries), `server.py` (endpoint), `main.js`
  (IPC SSE bridge), `preload.js` (expose), `renderer/app.js` (picker),
  `renderer/style.css` (shimmer).
- Backend edits load only on restart (the established shared-backend caveat).
- Backward compatible: sessions without `summary` fall back to the heuristic,
  which works for both old and new schemas.
- Cost: one cheap flash call per session lifetime, bounded to ≤3 concurrent
  during backfill, then cached.
