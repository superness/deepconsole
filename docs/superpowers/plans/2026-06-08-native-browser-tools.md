# Native Browser Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the in-app DeepSeek agent native `browser_*` tools so it controls the integrated browser directly instead of shelling curl through PowerShell (which caused port-discovery, JSON-quoting, and table-truncation failures).

**Architecture:** Six thin tool functions in `localllm-abuddi/tools.py` call the instance's Browser API over `urllib` (clean JSON, results capped at 20k chars). The per-instance browser port travels with each chat request: `main.js` → `ChatRequest.browser_port` (`server.py`) → `chat_session` (`engine.py`) → `safe_dispatch` (`safety.py`), which injects `_browser_port` into args for `browser_*` tools only. The LLM never sees `_browser_port`.

**Tech Stack:** Python 3.12, FastAPI, pytest 8.2 (backend in `C:/github/localllm-abuddi`); Node/Electron (`main.js` in `C:/github/deepconsole`).

**Repo note:** Tasks 1–5 run in `C:/github/localllm-abuddi` (its own git). Task 6 runs in `C:/github/deepconsole`. Each repo gets its own commits. The in-app agent auto-commits file edits in `localllm-abuddi`; do this work while it is idle and check `git log` for foreign interleaved commits before each commit.

---

## File Structure

- `localllm-abuddi/tools.py` — add `_browser_request` helper, `_cap`, six `browser_*` functions, registry entries, schemas. (Modify)
- `localllm-abuddi/safety.py` — `safe_dispatch` injects `_browser_port`. (Modify ~line 48)
- `localllm-abuddi/engine.py` — `chat_session` accepts/threads `browser_port`. (Modify ~line 348, ~507)
- `localllm-abuddi/server.py` — `ChatRequest.browser_port`; pass to `chat_session`. (Modify ~line 86, ~180)
- `localllm-abuddi/tests/test_browser_tools.py` — new test file with stub-server fixture. (Create)
- `localllm-abuddi/tests/test_safety.py` — add injection test. (Modify)
- `deepconsole/main.js` — include `browser_port` in chat POST body. (Modify line 351)

---

## Task 1: `_browser_request` helper + stub-server test fixture

**Files:**
- Modify: `C:/github/localllm-abuddi/tools.py` (add imports + helpers after line 9 imports / before Tool Registry)
- Test: `C:/github/localllm-abuddi/tests/test_browser_tools.py` (create)

- [ ] **Step 1: Write the failing test (fixture + helper happy path + errors)**

Create `tests/test_browser_tools.py`:

```python
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from tools import _browser_request, _cap, BROWSER_RESULT_CAP


class _StubHandler(BaseHTTPRequestHandler):
    def _respond(self):
        length = int(self.headers.get("Content-Length", 0))
        if length:
            self.rfile.read(length)
        status, payload = self.server.routes.get(self.path, (404, {"error": "not found"}))
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _respond
    do_POST = _respond

    def log_message(self, *args):
        pass


@pytest.fixture
def stub():
    server = HTTPServer(("127.0.0.1", 0), _StubHandler)
    server.routes = {}
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield server, server.server_address[1]
    finally:
        server.shutdown()


def test_browser_request_ok(stub):
    server, port = stub
    server.routes["/browser/url"] = (200, {"url": "https://x.com"})
    ok, data, err = _browser_request(port, "GET", "/browser/url")
    assert ok is True and err is None
    assert data["url"] == "https://x.com"


def test_browser_request_missing_port():
    ok, data, err = _browser_request(0, "GET", "/browser/url")
    assert ok is False
    assert "no integrated browser" in err


def test_browser_request_http_error(stub):
    server, port = stub
    server.routes["/browser/navigate"] = (500, {"error": "boom"})
    ok, data, err = _browser_request(port, "POST", "/browser/navigate", {"url": "x"})
    assert ok is False
    assert "500" in err


def test_browser_request_connection_refused():
    # Port 1 has nothing listening.
    ok, data, err = _browser_request(1, "GET", "/browser/url")
    assert ok is False
    assert "connection refused" in err.lower()


def test_browser_request_surfaces_js_error(stub):
    server, port = stub
    server.routes["/browser/execute"] = (200, {"error": "ReferenceError: foo"})
    ok, data, err = _browser_request(port, "POST", "/browser/execute", {"code": "foo"})
    assert ok is False
    assert "ReferenceError" in err


def test_cap_under_limit():
    assert _cap("short") == "short"


def test_cap_over_limit():
    big = "a" * (BROWSER_RESULT_CAP + 500)
    out = _cap(big)
    assert out.startswith("a" * BROWSER_RESULT_CAP)
    assert "truncated" in out
    assert "+500" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_browser_tools.py -v`
Expected: FAIL with `ImportError: cannot import name '_browser_request' from 'tools'`

- [ ] **Step 3: Add imports and helpers to `tools.py`**

Add to the import block (after line 9):

```python
import urllib.request
import urllib.error
```

Add just above the `# ─── Tool Registry ─` comment (around line 509):

```python
# ─── Browser tools ─────────────────────────────────────────────────────────
# The in-app agent controls the instance's integrated browser through these.
# The browser API port is OS-assigned per instance and injected per chat
# request as `_browser_port` — the LLM never supplies it.

BROWSER_RESULT_CAP = 20000


def _cap(text: str) -> str:
    if len(text) <= BROWSER_RESULT_CAP:
        return text
    overflow = len(text) - BROWSER_RESULT_CAP
    return (
        text[:BROWSER_RESULT_CAP]
        + f"\n…[+{overflow} chars truncated — refine your selector or read in chunks]"
    )


def _browser_request(port, method, path, payload=None):
    """Call the instance's Browser API. Returns (ok, data, err)."""
    if not port:
        return False, None, "no integrated browser is available for this instance."
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        return False, None, f"browser API returned {e.code}: {detail[:500]}"
    except urllib.error.URLError as e:
        return False, None, (
            "cannot reach the browser API (connection refused). "
            f"Try browser_open first. ({e.reason})"
        )
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return True, {"raw": body}, None
    if isinstance(parsed, dict) and parsed.get("error"):
        return False, None, str(parsed["error"])
    return True, parsed, None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_browser_tools.py -v`
Expected: PASS (8 passed)

- [ ] **Step 5: Commit**

```bash
cd C:/github/localllm-abuddi
git add tools.py tests/test_browser_tools.py
git commit -m "feat(tools): browser API request helper + result cap"
```

---

## Task 2: The six `browser_*` tool functions + registry + schemas

**Files:**
- Modify: `C:/github/localllm-abuddi/tools.py` (functions after `_browser_request`; registry ~line 511; schemas ~line 556)
- Test: `C:/github/localllm-abuddi/tests/test_browser_tools.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_browser_tools.py`:

```python
from tools import (
    browser_open, browser_navigate, browser_execute,
    browser_url, browser_logs, browser_logs_clear,
    TOOLS, TOOL_SCHEMAS,
)


def test_browser_navigate_returns_ok(stub):
    server, port = stub
    server.routes["/browser/navigate"] = (200, {"ok": True})
    assert browser_navigate("https://x.com", _browser_port=port) == "ok"


def test_browser_open_returns_ok(stub):
    server, port = stub
    server.routes["/browser/open"] = (200, {"ok": True})
    assert browser_open(_browser_port=port) == "ok"


def test_browser_execute_returns_result(stub):
    server, port = stub
    server.routes["/browser/execute"] = (200, {"ok": True, "result": "hello page"})
    assert browser_execute("document.body.innerText", _browser_port=port) == "hello page"


def test_browser_execute_caps_large_result(stub):
    server, port = stub
    server.routes["/browser/execute"] = (200, {"ok": True, "result": "z" * 25000})
    out = browser_execute("x", _browser_port=port)
    assert "truncated" in out and len(out) < 25000


def test_browser_url_returns_url(stub):
    server, port = stub
    server.routes["/browser/url"] = (200, {"url": "https://x.com/p"})
    assert browser_url(_browser_port=port) == "https://x.com/p"


def test_browser_logs_returns_buffer(stub):
    server, port = stub
    server.routes["/browser/logs"] = (200, {"logs": ["a", "b"]})
    assert "a" in browser_logs(_browser_port=port)


def test_browser_logs_clear_returns_ok(stub):
    server, port = stub
    server.routes["/browser/logs/clear"] = (200, {"ok": True})
    assert browser_logs_clear(_browser_port=port) == "ok"


def test_browser_tools_registered():
    for name in ("browser_open", "browser_navigate", "browser_execute",
                 "browser_url", "browser_logs", "browser_logs_clear"):
        assert name in TOOLS


def test_browser_schemas_hide_internal_port():
    names = {s["function"]["name"] for s in TOOL_SCHEMAS}
    assert "browser_navigate" in names
    for s in TOOL_SCHEMAS:
        props = s["function"]["parameters"]["properties"]
        assert "_browser_port" not in props
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_browser_tools.py -v`
Expected: FAIL with `ImportError: cannot import name 'browser_open'`

- [ ] **Step 3: Add the six functions** (in `tools.py`, after `_browser_request`)

```python
def browser_open(_browser_port=0):
    ok, _data, err = _browser_request(_browser_port, "POST", "/browser/open", {})
    return "ok" if ok else f"Error: {err}"


def browser_navigate(url, _browser_port=0):
    ok, _data, err = _browser_request(_browser_port, "POST", "/browser/navigate", {"url": url})
    return "ok" if ok else f"Error: {err}"


def browser_execute(code, _browser_port=0):
    ok, data, err = _browser_request(_browser_port, "POST", "/browser/execute", {"code": code})
    if not ok:
        return f"Error: {err}"
    result = data.get("result") if isinstance(data, dict) else data
    return _cap("" if result is None else str(result))


def browser_url(_browser_port=0):
    ok, data, err = _browser_request(_browser_port, "GET", "/browser/url")
    if not ok:
        return f"Error: {err}"
    return str(data.get("url", data) if isinstance(data, dict) else data)


def browser_logs(_browser_port=0):
    ok, data, err = _browser_request(_browser_port, "GET", "/browser/logs")
    if not ok:
        return f"Error: {err}"
    return _cap(data if isinstance(data, str) else json.dumps(data))


def browser_logs_clear(_browser_port=0):
    ok, _data, err = _browser_request(_browser_port, "POST", "/browser/logs/clear", {})
    return "ok" if ok else f"Error: {err}"
```

- [ ] **Step 4: Register the tools** — add to the `TOOLS = {` dict (after the `list_directory` line, ~line 517):

```python
    # Integrated browser (per-instance window)
    "browser_open": browser_open,
    "browser_navigate": browser_navigate,
    "browser_execute": browser_execute,
    "browser_url": browser_url,
    "browser_logs": browser_logs,
    "browser_logs_clear": browser_logs_clear,
```

- [ ] **Step 5: Add the schemas** — add to the `TOOL_SCHEMAS = [` list (anywhere before the closing `]` at ~line 1091). Note: `_browser_port` is deliberately absent from every schema.

```python
    {"type": "function", "function": {
        "name": "browser_open",
        "description": "Open the integrated browser window. Use this and the other browser_* tools to control the browser INSTEAD of run_command/curl.",
        "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {
        "name": "browser_navigate",
        "description": "Navigate the integrated browser to a URL. Use instead of run_command/curl.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "URL to navigate to"}}, "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "browser_execute",
        "description": "Run JavaScript in the integrated browser page and return its result (e.g. 'document.body.innerText'). Use instead of run_command/curl. Large results are truncated at 20k chars.",
        "parameters": {"type": "object", "properties": {
            "code": {"type": "string", "description": "JavaScript to evaluate in the page"}}, "required": ["code"]}}},
    {"type": "function", "function": {
        "name": "browser_url",
        "description": "Return the integrated browser's current URL.",
        "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {
        "name": "browser_logs",
        "description": "Return the integrated browser's captured console log buffer (truncated at 20k chars).",
        "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {
        "name": "browser_logs_clear",
        "description": "Clear the integrated browser's console log buffer.",
        "parameters": {"type": "object", "properties": {}, "required": []}}},
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_browser_tools.py -v`
Expected: PASS (all browser tool + registry + schema tests pass)

- [ ] **Step 7: Commit**

```bash
cd C:/github/localllm-abuddi
git add tools.py tests/test_browser_tools.py
git commit -m "feat(tools): native browser_* tools (open/navigate/execute/url/logs)"
```

---

## Task 3: `safe_dispatch` injects `_browser_port` for browser tools only

**Files:**
- Modify: `C:/github/localllm-abuddi/safety.py` (`safe_dispatch`, line 48)
- Test: `C:/github/localllm-abuddi/tests/test_safety.py` (extend)

- [ ] **Step 1: Write the failing test** — append to `tests/test_safety.py`:

```python
from unittest.mock import patch as _patch


def test_safe_dispatch_injects_browser_port():
    captured = {}

    def fake_navigate(url, _browser_port=0):
        captured["port"] = _browser_port
        return "ok"

    with _patch.dict("safety.TOOLS", {"browser_navigate": fake_navigate}):
        result = safe_dispatch("browser_navigate", {"url": "x"}, browser_port=63847)
    assert result == "ok"
    assert captured["port"] == 63847


def test_safe_dispatch_does_not_inject_for_non_browser(tmp_path):
    # read_file would raise TypeError on an unexpected _browser_port kwarg.
    path = tmp_path / "f.txt"
    path.write_text("hi", encoding="utf-8")
    result = safe_dispatch("read_file", {"path": str(path)}, browser_port=63847)
    assert result == "hi"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_safety.py -k browser_port -v`
Expected: FAIL with `TypeError: safe_dispatch() got an unexpected keyword argument 'browser_port'`

- [ ] **Step 3: Update `safe_dispatch`** in `safety.py` — change the signature and add injection. Replace:

```python
def safe_dispatch(tool_name: str, args: dict) -> str:
    if tool_name not in TOOLS:
        return f"Unknown tool: {tool_name}"
```

with:

```python
def safe_dispatch(tool_name: str, args: dict, browser_port: int | None = None) -> str:
    if tool_name not in TOOLS:
        return f"Unknown tool: {tool_name}"

    if tool_name.startswith("browser_"):
        args = {**args, "_browser_port": browser_port or 0}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_safety.py -v`
Expected: PASS (existing + 2 new tests pass)

- [ ] **Step 5: Commit**

```bash
cd C:/github/localllm-abuddi
git add safety.py tests/test_safety.py
git commit -m "feat(safety): inject _browser_port into browser_* tool dispatch"
```

---

## Task 4: `chat_session` threads `browser_port` to dispatch

**Files:**
- Modify: `C:/github/localllm-abuddi/engine.py` (signature ~line 348; dispatch call ~line 507)
- Test: `C:/github/localllm-abuddi/tests/test_engine.py` (extend) — verify the param exists and defaults safely.

- [ ] **Step 1: Write the failing test** — append to `tests/test_engine.py`:

```python
import inspect
import engine


def test_chat_session_accepts_browser_port():
    sig = inspect.signature(engine.chat_session)
    assert "browser_port" in sig.parameters
    assert sig.parameters["browser_port"].default is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -k browser_port -v`
Expected: FAIL with `AssertionError` (browser_port not in parameters)

- [ ] **Step 3: Add the parameter** — in `engine.py`, change the `chat_session` signature (line 348):

```python
async def chat_session(
    session_id: str,
    user_message: str,
    owner: str = "local",
    browser_port: int | None = None,
) -> AsyncIterator[dict]:
```

- [ ] **Step 4: Thread it into dispatch** — in `engine.py` at the `run_in_executor` call (line ~506-507), change:

```python
                        result = await asyncio.get_running_loop().run_in_executor(
                            None, safe_dispatch, name, args)
```

to:

```python
                        result = await asyncio.get_running_loop().run_in_executor(
                            None, safe_dispatch, name, args, browser_port)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd C:/github/localllm-abuddi
git add engine.py tests/test_engine.py
git commit -m "feat(engine): thread per-request browser_port to tool dispatch"
```

---

## Task 5: `ChatRequest.browser_port` + pass-through in `server.py`

**Files:**
- Modify: `C:/github/localllm-abuddi/server.py` (`ChatRequest` line 86; chat handler `engine.chat_session` call ~line 180)
- Test: `C:/github/localllm-abuddi/tests/test_server.py` (extend) — verify the model field.

- [ ] **Step 1: Write the failing test** — append to `tests/test_server.py`:

```python
from server import ChatRequest


def test_chat_request_has_optional_browser_port():
    assert ChatRequest(message="hi").browser_port is None
    assert ChatRequest(message="hi", browser_port=63847).browser_port == 63847
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_server.py -k browser_port -v`
Expected: FAIL with `AttributeError`/validation error (no `browser_port` field)

- [ ] **Step 3: Add the field** — in `server.py`, change `ChatRequest` (line 86):

```python
class ChatRequest(BaseModel):
    message: str
    browser_port: int | None = None
```

- [ ] **Step 4: Pass it through** — in the `/sessions/{id}/chat` handler, find the call inside `sse_stream`:

```python
            async for event in engine.chat_session(session_id, body.message, owner=owner):
```

and change to:

```python
            async for event in engine.chat_session(
                session_id, body.message, owner=owner, browser_port=body.browser_port):
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_server.py -v`
Expected: PASS

- [ ] **Step 6: Run the full backend suite (regression check)**

Run: `cd C:/github/localllm-abuddi && python -m pytest -q`
Expected: PASS (all tests green)

- [ ] **Step 7: Commit**

```bash
cd C:/github/localllm-abuddi
git add server.py tests/test_server.py
git commit -m "feat(server): accept per-request browser_port and pass to chat_session"
```

---

## Task 6: `main.js` sends the instance's browser port

**Files:**
- Modify: `C:/github/deepconsole/main.js` (line 351)

This is a one-line change with no JS test harness for IPC handlers; verify by syntax check + manual run.

- [ ] **Step 1: Make the change** — in `main.js`, the `llm:chat` handler at line 351:

```javascript
    const postData = JSON.stringify({ message });
```

change to:

```javascript
    const postData = JSON.stringify({ message, browser_port: browserApiPort });
```

(`browserApiPort` is the module-level `let` set at line 188 when the Browser API server binds — already in scope here.)

- [ ] **Step 2: Syntax check**

Run: `cd C:/github/deepconsole && node --check main.js`
Expected: no output (exit 0)

- [ ] **Step 3: Guard against the known TDZ/duplicate-const hazard**

Run: `cd C:/github/deepconsole && node -e "require('child_process'); const s=require('fs').readFileSync('main.js','utf8'); const m=s.match(/browserApiPort/g); console.log('browserApiPort refs:', m.length)"`
Expected: `browserApiPort refs: 4` (declaration + assignment + roster register + the new chat-body use). If a number other than 4, inspect for a stray duplicate before committing.

- [ ] **Step 4: Commit**

```bash
cd C:/github/deepconsole
git add main.js
git commit -m "feat(chat): send this instance's browser_port with each chat request"
```

---

## Task 7: End-to-end manual verification

No code changes — confirm the whole chain works in the running app. (Requires `npm start` with the sibling backend.)

- [ ] **Step 1: Restart the app** so the new backend tools and `main.js` change load.

Run: `cd C:/github/deepconsole && npm start` (in a terminal the user controls; suggest the user run `! npm start`).

- [ ] **Step 2: In the app chat, issue the exact task that failed before:**

> Open the browser to rapidapi.com/provider and tell me the APIs we list

- [ ] **Step 3: Confirm in `../localllm-abuddi/localllm-abuddi.log`** that the agent now calls `browser_navigate` / `browser_execute` tools (NOT `run_command` + curl), and that `browser_execute("document.body.innerText")` returns real page text (not a truncated table). The agent should answer the question.

Expected: the task completes; no curl/9100/`Invoke-RestMethod` flailing in the tool calls.

---

## Self-Review

**Spec coverage:**
- 6 tools mirroring HTTP API → Task 2 ✓
- 20k cap + marker → Task 1 (`_cap`) + Task 2 (execute/logs tests) ✓
- Per-request threading main.js→ChatRequest→chat_session→safe_dispatch→inject → Tasks 3,4,5,6 ✓
- `_browser_port` hidden from LLM schema → Task 2 `test_browser_schemas_hide_internal_port` ✓
- Error handling (missing port / refused / HTTP / JS error) → Task 1 tests ✓
- `run_command` + existing endpoints untouched → no task modifies them ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type/name consistency:** `_browser_request`, `_cap`, `BROWSER_RESULT_CAP`, `_browser_port`, `browser_port`, the six `browser_*` names, and `safe_dispatch(..., browser_port=None)` are used identically across Tasks 1–6.
