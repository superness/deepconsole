# Native browser tools for the in-app agent — Design

**Date:** 2026-06-08
**Status:** Approved (design)

## Motivation

Review of in-app DeepSeek session `0b5b409dacd0` ("Open the browser to
rapidapi.com/provider and tell me the APIs we list") found the agent **never
completed the task** — it burned ~37 tool calls and never extracted the page
text. It hit three environment gaps in sequence, none of them
RapidAPI-specific, so the same failure recurs on *any* browser task:

1. **Port discovery (msgs 2–42, ~20 wasted calls).** The agent assumed the
   Browser API was on the old fixed port `9100`. It is now OS-assigned per
   instance (`main.js` `browserApiPort`, registered with the Overmind roster as
   `browser_port`, commit `ea5e184`). 9100 was dead; the agent hammered it, ran
   `netstat`, read all of `main.js`, and grepped `~/deepconsole.log` to
   reverse-engineer the live port. The port is **never surfaced to the AI**.
2. **curl/PowerShell JSON-quoting (msgs 2–54, ~10 wasted calls).** The agent's
   only path to the browser is shelling `run_command` → curl → the HTTP port.
   `curl` aliases to `Invoke-WebRequest`; `curl.exe -d '{...}'` sent mangled
   JSON the server rejected. It re-derived JSON-over-PowerShell quoting from
   scratch.
3. **`Invoke-RestMethod` table truncation (msgs 58–75, task death).**
   `Invoke-RestMethod` deserializes `{ok, result}` into an object; PowerShell's
   default formatter renders it as a *table* that truncates `result` to the
   column width — so every `innerText` dump returned blank. The agent diagnosed
   "truncated somewhere in the pipeline" but never recovered.

Root cause: the backend (`tools.py`) exposes **zero browser tools**. Giving the
agent native browser tools collapses all three walls into one fix.

## Goal

Add native `browser_*` tools to the backend so the in-app agent controls the
integrated browser directly — no curl, no PowerShell quoting, no port guessing,
no truncation. The browser port is threaded **per chat request** so the shared
`:8000` backend always targets the calling instance's own browser window.

Non-goals: removing `run_command`, changing the existing HTTP endpoints (scratch
scripts keep working), or editing the system prompt (tool descriptions carry the
guidance).

## Components

### 1. `tools.py` — six new tools mirroring the HTTP API

| Tool | Method + path | Returns |
|------|---------------|---------|
| `browser_open()` | POST `/browser/open` | `ok` |
| `browser_navigate(url)` | POST `/browser/navigate` `{url}` | `ok` |
| `browser_execute(code)` | POST `/browser/execute` `{code}` | the JS `result` (capped) |
| `browser_url()` | GET `/browser/url` | current URL string |
| `browser_logs()` | GET `/browser/logs` | console buffer (capped) |
| `browser_logs_clear()` | POST `/browser/logs/clear` | `ok` |

Each function:

- Accepts its own declared args **plus** an injected `_browser_port: int`
  keyword (see threading below). `_browser_port` is NOT in the JSON schema the
  LLM sees — the engine injects it.
- Issues a plain `urllib.request` call to
  `http://127.0.0.1:{_browser_port}/browser/...` with `Content-Type:
  application/json`, parses the JSON response, and returns the meaningful field
  as a string (`result` for execute, `url` for url, the logs payload for logs,
  `"ok"` otherwise).
- Caps any returned text at **20000 chars**; if truncated, appends
  `…[+N chars truncated — refine your selector or read in chunks]`.
- Tool `description` strings state explicitly: "Use this instead of
  run_command/curl to control the integrated browser window."

A small shared helper (`_browser_request(port, method, path, payload=None)`)
holds the urllib + JSON + error logic so the six tools stay thin.

### 2. Per-request port threading

The shared backend on `:8000` serves every instance, so the browser port cannot
be a module constant — it travels with each chat request:

- **`server.py`** — `ChatRequest` gains `browser_port: int | None = None`. The
  `/sessions/{id}/chat` handler passes `body.browser_port` into
  `engine.chat_session(...)`.
- **`engine.py`** — `chat_session(...)` gains a `browser_port: int | None =
  None` parameter and passes it to `safe_dispatch` at the dispatch call
  (currently `engine.py:507`: `safe_dispatch, name, args` →
  `safe_dispatch, name, args, browser_port`).
- **`safety.py`** — `safe_dispatch(tool_name, args, browser_port=None)` injects
  the port for browser tools only:
  ```python
  if tool_name.startswith("browser_"):
      args = {**args, "_browser_port": browser_port}
  ```
  Existing `run_command` guards are unchanged. Injection happens just before
  `TOOLS[tool_name](**args)`.
- **`main.js`** — wherever the renderer's chat call POSTs to
  `/sessions/{id}/chat`, add `browser_port: browserApiPort` to the JSON body.

The `run_in_executor(None, safe_dispatch, name, args)` call passes positional
args; adding `browser_port` as a 4th positional keeps executor compatibility
(no contextvars needed).

### 3. Error handling

`browser_*` tools never raise — they return an `Error:` string the model can
read and act on:

- `_browser_port` missing / `0` / `None` →
  `"Error: no integrated browser is available for this instance."`
- Connection refused (window closed or stale port) →
  `"Error: cannot reach the browser API (connection refused). Try browser_open first."`
- Non-2xx HTTP →
  `"Error: browser API returned {status}: {body[:500]}"`
- The browser API's own `{"error": ...}` body (e.g. a JS exception) → surfaced
  as `"Error: {error}"`.

## Data flow (happy path)

```
renderer chat → main.js POST /sessions/{id}/chat {message, browser_port}
  → server.chat(body) → engine.chat_session(..., browser_port)
    → model emits tool_call browser_navigate{url}
    → safe_dispatch("browser_navigate", {url}, browser_port)
        injects _browser_port → tools.browser_navigate(url, _browser_port)
        → urllib POST 127.0.0.1:{port}/browser/navigate {url} → "ok"
    → result fed back into history → model continues
```

## Testing (TDD)

Python unit tests with a stub `http.server` standing in for the browser API
(bound to an ephemeral port, run in a thread):

- **Per tool:** asserts correct method + path, JSON body shape, and that the
  meaningful field is returned (`result`/`url`/logs/`ok`).
- **Cap:** a stub returning >20k chars yields exactly-capped output with the
  truncation marker.
- **Errors:** missing port → the no-browser error; a closed port → the
  connection-refused error; a 500 → the HTTP-status error; an `{"error": ...}`
  body → the surfaced JS error.
- **`safe_dispatch` injection:** proves `_browser_port` is injected for
  `browser_*` tools and **not** for `run_command`/other tools, and that the
  declared LLM schema for browser tools does not list `_browser_port`.

## Scope / risk notes

- Code spans two repos: `main.js` in `deepconsole`; `tools.py`, `safety.py`,
  `engine.py`, `server.py` in sibling `localllm-abuddi` (its own git, with the
  auto-commit-on-file-tools hazard — make these edits while the in-app agent is
  not concurrently writing those files, and verify no foreign interleaved
  commits land mid-change).
- Backward compatible: `browser_port` is optional everywhere; an instance that
  doesn't send it (or sends `0`) simply gets the no-browser error from the
  tools, and all non-browser behavior is unchanged.
