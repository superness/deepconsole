# Session Summary (streaming) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw session-id label in the startup picker with a one-line summary: an instant heuristic (first user message), upgraded once to a flash-generated title, with old sessions' titles streamed in live.

**Architecture:** A new isolated `session_title.py` holds the pure title logic plus one best-effort `deepseek-v4-flash` call. `engine.py` surfaces a `summary` on `list_sessions`, generates+persists a title eagerly after a session's first exchange, and exposes an async generator that backfills missing titles with bounded concurrency. A new SSE endpoint streams those backfilled titles; `main.js` bridges the SSE to the renderer, which upgrades each picker row live.

**Tech Stack:** Python 3.12, FastAPI, openai SDK (DeepSeek), pytest 8.2 (`C:/github/localllm-abuddi`); Node/Electron (`main.js`, `preload.js`, `renderer/` in `C:/github/deepconsole`).

**Repo note:** Tasks 1–7 run in `C:/github/localllm-abuddi` (branch `abuddi`). Tasks 8–9 run in `C:/github/deepconsole` (branch `master`). Commit to the current branch in each repo. In `localllm-abuddi` the working tree has pre-existing uncommitted `knowledge.json` and `localllm-abuddi.log` — never stage those; only stage the files each task names. The repo also has ~21 PRE-EXISTING failing tests (stale rot in `test_engine.py`, `test_tools.py`, `test_safety.py`, `test_server.py`); do not count them — only your new tests must pass and you must not ADD failures.

---

## File Structure

- `localllm-abuddi/session_title.py` *(new)* — pure title helpers + best-effort flash call. One responsibility: turn a conversation into a short title.
- `localllm-abuddi/engine.py` *(modify)* — `list_sessions` summary fields; `_generate_and_store_title`; `stream_session_summaries`; eager call in `chat_session`.
- `localllm-abuddi/server.py` *(modify)* — `GET /sessions/summaries/stream` SSE endpoint.
- `localllm-abuddi/tests/test_session_title.py` *(new)*, `tests/test_engine.py` *(extend)*, `tests/test_server.py` *(extend)*.
- `deepconsole/main.js` *(modify)* — `llm:streamSummaries` IPC→SSE bridge.
- `deepconsole/preload.js` *(modify)* — expose `streamSummaries` + `onSummary`.
- `deepconsole/renderer/app.js` *(modify)* — picker renders summary, shimmer, live upgrade.
- `deepconsole/renderer/style.css` *(modify)* — pending shimmer style.

---

## Task 1: `session_title.py` — pure helpers

**Files:**
- Create: `C:/github/localllm-abuddi/session_title.py`
- Test: `C:/github/localllm-abuddi/tests/test_session_title.py`

- [ ] **Step 1: Write the failing test** — create `tests/test_session_title.py`:

```python
from session_title import (
    clean_title, heuristic_summary, first_user_text,
    first_assistant_text, _needs_title,
)


def test_clean_title_strips_quotes_and_caps_words():
    assert clean_title('"Hello there world"') == "Hello there world"
    long = "one two three four five six seven eight nine ten"
    assert clean_title(long) == "one two three four five six seven eight"


def test_clean_title_collapses_whitespace_and_trailing_punct():
    assert clean_title("  Foo   bar.  ") == "Foo bar"


def test_clean_title_empty():
    assert clean_title("") == ""


def test_heuristic_summary_first_user_message():
    h = [{"role": "system", "content": "sys"},
         {"role": "user", "content": "Open the browser and list APIs"},
         {"role": "assistant", "content": "ok"}]
    assert heuristic_summary(h) == "Open the browser and list APIs"


def test_heuristic_summary_truncates():
    h = [{"role": "user", "content": "x" * 200}]
    out = heuristic_summary(h)
    assert out.endswith("…") and len(out) <= 71


def test_heuristic_summary_none_when_no_user():
    assert heuristic_summary([{"role": "assistant", "content": "hi"}]) is None


def test_first_user_and_assistant_text():
    h = [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
    assert first_user_text(h) == "q"
    assert first_assistant_text(h) == "a"


def test_needs_title_true_for_fresh_exchange():
    assert _needs_title({"history": [
        {"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}) is True


def test_needs_title_false_when_summary_set():
    assert _needs_title({"summary": "Has one", "history": [
        {"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}) is False


def test_needs_title_false_without_assistant():
    assert _needs_title({"history": [{"role": "user", "content": "q"}]}) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_session_title.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'session_title'`

- [ ] **Step 3: Create `session_title.py`** with the pure helpers:

```python
import os
import re
import logging

import openai

log = logging.getLogger("localllm")

TITLE_SYSTEM_PROMPT = (
    "You write a terse title of at most 8 words capturing a conversation's topic. "
    "Reply with ONLY the title — no quotes, no surrounding punctuation, no preamble."
)


def clean_title(raw: str) -> str:
    if not raw:
        return ""
    t = re.sub(r"\s+", " ", raw.strip().strip('"').strip("'").strip())
    words = t.split(" ")
    if len(words) > 8:
        t = " ".join(words[:8])
    return t.rstrip(" .,:;!-")[:60].rstrip()


def heuristic_summary(history: list) -> str | None:
    for msg in history or []:
        if msg.get("role") == "user":
            c = (msg.get("content") or "").strip()
            if c:
                c = re.sub(r"\s+", " ", c)
                return c[:70].rstrip() + ("…" if len(c) > 70 else "")
    return None


def first_user_text(history: list) -> str | None:
    for msg in history or []:
        if msg.get("role") == "user" and (msg.get("content") or "").strip():
            return msg["content"].strip()
    return None


def first_assistant_text(history: list) -> str | None:
    for msg in history or []:
        if msg.get("role") == "assistant" and (msg.get("content") or "").strip():
            return msg["content"].strip()
    return None


def _needs_title(session: dict) -> bool:
    if (session.get("summary") or "").strip():
        return False
    history = session.get("history") or []
    has_user = any(m.get("role") == "user" for m in history)
    has_asst = any(m.get("role") == "assistant" for m in history)
    return has_user and has_asst
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_session_title.py -v`
Expected: PASS (all pure-helper tests)

- [ ] **Step 5: Commit**

```bash
cd C:/github/localllm-abuddi
git add session_title.py tests/test_session_title.py
git commit -m "feat(session-title): pure title/summary helpers"
```

---

## Task 2: `session_title.generate_title` — best-effort flash call

**Files:**
- Modify: `C:/github/localllm-abuddi/session_title.py`
- Test: `C:/github/localllm-abuddi/tests/test_session_title.py` (extend)

- [ ] **Step 1: Write the failing test** — append to `tests/test_session_title.py`:

```python
import asyncio
import session_title as st


class _FakeMessage:
    def __init__(self, content): self.message = type("M", (), {"content": content})


class _FakeResp:
    def __init__(self, content): self.choices = [_FakeMessage(content)]


class _FakeClient:
    def __init__(self, content=None, raise_exc=None):
        self._content = content
        self._raise = raise_exc
        async def _create(**kwargs):
            if self._raise:
                raise self._raise
            return _FakeResp(self._content)
        self.chat = type("C", (), {"completions": type("X", (), {"create": staticmethod(_create)})})


def test_generate_title_success(monkeypatch):
    monkeypatch.setattr(st, "_make_client", lambda: _FakeClient(content='"My Nice Title"'))
    out = asyncio.run(st.generate_title("first user msg", "assistant reply"))
    assert out == "My Nice Title"


def test_generate_title_none_on_error(monkeypatch):
    monkeypatch.setattr(st, "_make_client", lambda: _FakeClient(raise_exc=RuntimeError("boom")))
    assert asyncio.run(st.generate_title("u", "a")) is None


def test_generate_title_none_without_client(monkeypatch):
    monkeypatch.setattr(st, "_make_client", lambda: None)
    assert asyncio.run(st.generate_title("u", "a")) is None


def test_generate_title_none_on_blank(monkeypatch):
    monkeypatch.setattr(st, "_make_client", lambda: _FakeClient(content="   "))
    assert asyncio.run(st.generate_title("u", "a")) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_session_title.py -k generate_title -v`
Expected: FAIL — `AttributeError: module 'session_title' has no attribute '_make_client'`

- [ ] **Step 3: Add `_make_client` and `generate_title`** to `session_title.py` (append at the end):

```python
def _make_client():
    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        return None
    return openai.AsyncOpenAI(api_key=api_key, base_url="https://api.deepseek.com")


async def generate_title(first_user: str, first_assistant: str | None) -> str | None:
    """One cheap flash title. Best-effort: returns None on any failure."""
    try:
        client = _make_client()
        if client is None:
            return None
        blob = (first_user or "")[:1000]
        if first_assistant:
            blob += "\n\nAssistant replied:\n" + first_assistant[:500]
        resp = await client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=[
                {"role": "system", "content": TITLE_SYSTEM_PROMPT},
                {"role": "user", "content": blob},
            ],
            max_tokens=24,
            stream=False,
        )
        return clean_title(resp.choices[0].message.content or "") or None
    except Exception as e:
        log.warning("generate_title failed: %s", e)
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_session_title.py -v`
Expected: PASS (all helper + generate_title tests)

- [ ] **Step 5: Commit**

```bash
cd C:/github/localllm-abuddi
git add session_title.py tests/test_session_title.py
git commit -m "feat(session-title): best-effort flash title generation"
```

---

## Task 3: `engine._generate_and_store_title`

**Files:**
- Modify: `C:/github/localllm-abuddi/engine.py`
- Test: `C:/github/localllm-abuddi/tests/test_engine.py` (extend)

- [ ] **Step 1: Write the failing test** — append to `tests/test_engine.py`:

```python
import session_title as _st_mod


def test_generate_and_store_title_persists(tmp_path, monkeypatch):
    import asyncio
    path = tmp_path / "local_s1.json"
    session = {"id": "s1", "summary": "",
               "history": [{"role": "user", "content": "count the APIs"},
                           {"role": "assistant", "content": "there are 26"}]}
    path.write_text(_json_t.dumps(session), encoding="utf-8")
    monkeypatch.setattr(_st_mod, "generate_title", _make_async_return("API count"))
    out = asyncio.run(_eng_t._generate_and_store_title(session, str(path)))
    assert out == "API count"
    assert session["summary"] == "API count"
    on_disk = _json_t.loads(path.read_text(encoding="utf-8"))
    assert on_disk["summary"] == "API count"


def test_generate_and_store_title_skips_when_summary_exists(tmp_path, monkeypatch):
    import asyncio
    session = {"id": "s2", "summary": "Already",
               "history": [{"role": "user", "content": "q"},
                           {"role": "assistant", "content": "a"}]}
    called = {"n": 0}
    def _boom(*a, **k):
        called["n"] += 1
    monkeypatch.setattr(_st_mod, "generate_title", _make_async_return("X"))
    out = asyncio.run(_eng_t._generate_and_store_title(session, str(tmp_path / "x.json")))
    assert out is None
    assert session["summary"] == "Already"


def _make_async_return(value):
    async def _f(*args, **kwargs):
        return value
    return _f
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -k generate_and_store -v`
Expected: FAIL — `AttributeError: module 'engine' has no attribute '_generate_and_store_title'`

- [ ] **Step 3: Add the helper to `engine.py`** — first ensure the import exists near the other imports (after line 12 `from tools import TOOL_SCHEMAS`):

```python
import session_title as _title
```

Then add the function (place it just above `def list_sessions`):

```python
async def _generate_and_store_title(session: dict, session_path: str) -> str | None:
    """Generate a one-line title for a session and persist it. Returns the
    title, or None if not needed / generation failed. Best-effort."""
    if not _title._needs_title(session):
        return None
    history = session.get("history") or []
    first_user = _title.first_user_text(history)
    if not first_user:
        return None
    title = await _title.generate_title(first_user, _title.first_assistant_text(history))
    if not title:
        return None
    session["summary"] = title
    try:
        with open(session_path, "w", encoding="utf-8") as f:
            _json.dump(session, f, indent=2)
    except OSError:
        pass
    return title
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -k generate_and_store -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd C:/github/localllm-abuddi
git add engine.py tests/test_engine.py
git commit -m "feat(engine): generate + persist a session title (best-effort)"
```

---

## Task 4: `engine.list_sessions` — `summary` + `summary_generated`

**Files:**
- Modify: `C:/github/localllm-abuddi/engine.py` (`list_sessions`)
- Test: `C:/github/localllm-abuddi/tests/test_engine.py` (extend)

- [ ] **Step 1: Write the failing test** — append to `tests/test_engine.py`:

```python
def test_list_sessions_summary_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(_eng_t, "SESSIONS_DIR", str(tmp_path))
    # stored summary -> summary_generated True
    (tmp_path / "local_a.json").write_text(_json_t.dumps({
        "id": "a", "created_at": "2026-06-09T10:00:00+00:00", "summary": "Stored Title",
        "history": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}],
    }), encoding="utf-8")
    # no summary -> heuristic, summary_generated False
    (tmp_path / "local_b.json").write_text(_json_t.dumps({
        "id": "b", "created_at": "2026-06-09T11:00:00+00:00",
        "history": [{"role": "user", "content": "list the APIs please"},
                    {"role": "assistant", "content": "ok"}],
    }), encoding="utf-8")
    out = {s["id"]: s for s in _eng_t.list_sessions(owner="local")}
    assert out["a"]["summary"] == "Stored Title"
    assert out["a"]["summary_generated"] is True
    assert out["b"]["summary"] == "list the APIs please"
    assert out["b"]["summary_generated"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -k list_sessions_summary_fields -v`
Expected: FAIL — `KeyError: 'summary'`

- [ ] **Step 3: Add the fields** — in `engine.py` `list_sessions`, the appended dict currently is:

```python
                sessions.append({
                    "id": data["id"],
                    "backend": data.get("backend"),
                    "model": data.get("model"),
                    "created_at": data.get("created_at", ""),
                    "last_active": _session_last_active(data, path),
                    "message_count": len(data.get("history", [])),
                })
```

Change it to:

```python
                sessions.append({
                    "id": data["id"],
                    "backend": data.get("backend"),
                    "model": data.get("model"),
                    "created_at": data.get("created_at", ""),
                    "last_active": _session_last_active(data, path),
                    "summary": (data.get("summary")
                                or _title.heuristic_summary(data.get("history") or [])
                                or None),
                    "summary_generated": bool((data.get("summary") or "").strip()),
                    "message_count": len(data.get("history", [])),
                })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -k "list_sessions" -v`
Expected: PASS (the new test and the existing `list_sessions_sorted_by_activity` test)

- [ ] **Step 5: Commit**

```bash
cd C:/github/localllm-abuddi
git add engine.py tests/test_engine.py
git commit -m "feat(engine): surface summary + summary_generated on list_sessions"
```

---

## Task 5: `engine.stream_session_summaries` — bounded-concurrency backfill

**Files:**
- Modify: `C:/github/localllm-abuddi/engine.py`
- Test: `C:/github/localllm-abuddi/tests/test_engine.py` (extend)

- [ ] **Step 1: Write the failing test** — append to `tests/test_engine.py`:

```python
def test_stream_session_summaries(tmp_path, monkeypatch):
    import asyncio
    monkeypatch.setattr(_eng_t, "SESSIONS_DIR", str(tmp_path))
    # un-titled, multi-message -> should be backfilled
    (tmp_path / "local_u1.json").write_text(_json_t.dumps({
        "id": "u1", "history": [{"role": "user", "content": "alpha"},
                                {"role": "assistant", "content": "a"}]}), encoding="utf-8")
    (tmp_path / "local_u2.json").write_text(_json_t.dumps({
        "id": "u2", "history": [{"role": "user", "content": "beta"},
                                {"role": "assistant", "content": "b"}]}), encoding="utf-8")
    # already titled -> skipped
    (tmp_path / "local_t.json").write_text(_json_t.dumps({
        "id": "t", "summary": "Done", "history": [{"role": "user", "content": "q"},
                                {"role": "assistant", "content": "a"}]}), encoding="utf-8")
    # single message -> skipped
    (tmp_path / "local_s.json").write_text(_json_t.dumps({
        "id": "s", "history": [{"role": "user", "content": "solo"}]}), encoding="utf-8")

    async def fake_generate(first_user, first_assistant):
        return None if first_user == "beta" else f"Title for {first_user}"
    monkeypatch.setattr(_st_mod, "generate_title", fake_generate)

    async def collect():
        return [ev async for ev in _eng_t.stream_session_summaries(owner="local")]
    events = asyncio.run(collect())

    by_id = {e["session_id"]: e["text"] for e in events}
    assert by_id == {"u1": "Title for alpha"}          # u2 returned None; t and s skipped
    # u1 persisted to disk; u2 left untitled
    assert _json_t.loads((tmp_path / "local_u1.json").read_text(encoding="utf-8"))["summary"] == "Title for alpha"
    assert "summary" not in _json_t.loads((tmp_path / "local_u2.json").read_text(encoding="utf-8"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -k stream_session_summaries -v`
Expected: FAIL — `AttributeError: module 'engine' has no attribute 'stream_session_summaries'`

- [ ] **Step 3: Add the generator to `engine.py`** (place after `_generate_and_store_title`). `asyncio` is already imported (line 1):

```python
async def stream_session_summaries(owner: str = "local"):
    """Backfill missing titles for an owner's sessions, yielding
    {"session_id", "text"} as each completes. Bounded to 3 concurrent flash
    calls. Sessions that already have a summary, have <=1 message, or whose
    generation fails produce no event."""
    owner = _safe_owner(owner)
    targets = []
    try:
        names = os.listdir(SESSIONS_DIR)
    except FileNotFoundError:
        return
    for fn in names:
        if not (fn.endswith(".json") and fn.startswith(owner + "_")):
            continue
        path = os.path.join(SESSIONS_DIR, fn)
        try:
            with open(path, encoding="utf-8") as f:
                data = _json.load(f)
        except Exception:
            continue
        if len(data.get("history", [])) <= 1:
            continue
        if not _title._needs_title(data):
            continue
        targets.append((path, data))

    if not targets:
        return

    sem = asyncio.Semaphore(3)
    queue: asyncio.Queue = asyncio.Queue()

    async def _worker(path, data):
        async with sem:
            title = await _generate_and_store_title(data, path)
            await queue.put((data.get("id"), title))

    tasks = [asyncio.create_task(_worker(p, d)) for p, d in targets]
    try:
        for _ in range(len(tasks)):
            sid, title = await queue.get()
            if title:
                yield {"session_id": sid, "text": title}
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -k stream_session_summaries -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd C:/github/localllm-abuddi
git add engine.py tests/test_engine.py
git commit -m "feat(engine): stream_session_summaries backfill generator"
```

---

## Task 6: `GET /sessions/summaries/stream` SSE endpoint

**Files:**
- Modify: `C:/github/localllm-abuddi/server.py`
- Test: `C:/github/localllm-abuddi/tests/test_server.py` (extend)

- [ ] **Step 1: Write the failing test** — append to `tests/test_server.py`. (The file already constructs a `TestClient`; reuse its import. If it imports the app as `from server import app` and uses `TestClient(app)`, mirror that; the snippet below builds its own client to be self-contained.)

```python
from fastapi.testclient import TestClient
import server as _srv
import engine as _eng


def test_summaries_stream_endpoint(monkeypatch):
    async def fake_stream(owner="local"):
        yield {"session_id": "a", "text": "Title A"}
        yield {"session_id": "b", "text": "Title B"}
    monkeypatch.setattr(_eng, "stream_session_summaries", fake_stream)
    client = TestClient(_srv.app)
    body = client.get("/sessions/summaries/stream").text
    assert "event: summary" in body
    assert '"session_id": "a"' in body and '"text": "Title A"' in body
    assert '"session_id": "b"' in body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_server.py -k summaries_stream -v`
Expected: FAIL — 404 (route not found), so the assertions fail.

- [ ] **Step 3: Add the endpoint to `server.py`** — place it right after the existing `list_sessions` route (after the `@app.get("/sessions")` handler, around line 130). `StreamingResponse`, `engine`, `_sse`, and `get_owner` are already imported/defined:

```python
@app.get("/sessions/summaries/stream")
async def stream_summaries(owner: str = Depends(get_owner)):
    async def gen():
        try:
            async for item in engine.stream_session_summaries(owner=owner):
                yield _sse({"event": "summary", "data": item})
        except Exception as e:
            log.error("summaries stream error: %s", e, exc_info=True)
    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_server.py -k summaries_stream -v`
Expected: PASS

- [ ] **Step 5: Run the full backend suite for a regression snapshot**

Run: `cd C:/github/localllm-abuddi && python -m pytest -q 2>&1 | tail -3`
Expected: your new tests pass; total failures unchanged from the known pre-existing set (record the number; it must not increase).

- [ ] **Step 6: Commit**

```bash
cd C:/github/localllm-abuddi
git add server.py tests/test_server.py
git commit -m "feat(server): SSE endpoint streaming backfilled session titles"
```

---

## Task 7: Eager title generation in `chat_session`

**Files:**
- Modify: `C:/github/localllm-abuddi/engine.py` (`chat_session`, the no-tool-calls branch)

No unit test (full `chat_session` needs a live model); correctness of the generate+persist step is covered by Task 3. Verify by inspection + the manual run in Task 9.

- [ ] **Step 1: Add the eager call.** In `chat_session`, the final-answer branch currently reads (around lines 548–557):

```python
            else:
                asst_msg = {"role": "assistant", "content": response["content"],
                            "timestamp": _now()}
                if response.get("reasoning_content"):
                    asst_msg["reasoning_content"] = response["reasoning_content"]
                history.append(asst_msg)
                _save_session()
                yield {"event": "done", "data": {"response": response["content"]}}
                _broadcast(session_id, "done", {"chars": len(response["content"])})
                break
```

Insert the eager title call AFTER the `done` events and BEFORE `break`:

```python
                yield {"event": "done", "data": {"response": response["content"]}}
                _broadcast(session_id, "done", {"chars": len(response["content"])})
                # Eager, one-time title: after the first real exchange, off the
                # user's critical path. Best-effort; failures are swallowed inside.
                try:
                    _title_text = await _generate_and_store_title(session, session_path)
                    if _title_text:
                        yield {"event": "summary",
                               "data": {"text": _title_text, "session_id": session_id}}
                except Exception as _e:
                    log.warning("eager title generation failed: %s", _e)
                break
```

(`session` is the loaded session dict and `session_path` is defined near the top of `chat_session`; both are in scope here.)

- [ ] **Step 2: Syntax / import check**

Run: `cd C:/github/localllm-abuddi && python -c "import engine; print('engine imports OK')"`
Expected: `engine imports OK`

- [ ] **Step 3: Confirm no new test failures**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_engine.py -q 2>&1 | tail -3`
Expected: failure count unchanged from Task 6's snapshot.

- [ ] **Step 4: Commit**

```bash
cd C:/github/localllm-abuddi
git add engine.py
git commit -m "feat(engine): eager one-time title after a session's first exchange"
```

---

## Task 8: `main.js` + `preload.js` — IPC→SSE bridge

**Files:**
- Modify: `C:/github/deepconsole/main.js`
- Modify: `C:/github/deepconsole/preload.js`

No JS test harness for IPC; verify with `node --check`.

- [ ] **Step 1: Add the IPC handler to `main.js`.** Right after the `ipcMain.handle('llm:chat', …)` handler (it ends around line 382 with `});`), add:

```javascript
ipcMain.handle('llm:streamSummaries', async (event) => {
  return new Promise((resolve) => {
    const options = { hostname: '127.0.0.1', port: LLM_PORT, path: '/sessions/summaries/stream', method: 'GET', headers: { 'Accept': 'text/event-stream' } };
    const req = http.request(options, (res) => {
      let buffer = '';
      let lastEvent = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (line.startsWith('event: ')) { lastEvent = line.slice(7).trim(); }
          else if (line.startsWith('data: ')) {
            try {
              const d = JSON.parse(line.slice(6));
              if (lastEvent === 'summary' && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('summaries:event', d);
              }
            } catch (e) {}
          }
        }
      });
      res.on('end', () => resolve({ ok: true }));
      res.on('error', () => resolve({ ok: false }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
});
```

- [ ] **Step 2: Expose it in `preload.js`.** In the `llm: { … }` object, after the `onEvent` entry (around line 12–16), add:

```javascript
    streamSummaries: () => ipcRenderer.invoke('llm:streamSummaries'),
    onSummary: (callback) => {
      const handler = (_e, data) => callback(data);
      ipcRenderer.on('summaries:event', handler);
      return () => ipcRenderer.removeListener('summaries:event', handler);
    },
```

- [ ] **Step 3: Syntax check both files**

Run: `cd C:/github/deepconsole && node --check main.js && node --check preload.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
cd C:/github/deepconsole
git add main.js preload.js
git commit -m "feat(ipc): bridge session-summary SSE stream to the renderer"
```

---

## Task 9: `renderer/app.js` + `style.css` — picker shows summary, upgrades live

**Files:**
- Modify: `C:/github/deepconsole/renderer/app.js` (`showSessionPicker`)
- Modify: `C:/github/deepconsole/renderer/style.css`

- [ ] **Step 1: Update `showSessionPicker`.** The current loop body (around lines 140–155) is:

```javascript
  for (const s of sessions) {
    if (s.message_count <= 1) continue;
    hasItems = true;
    const item = document.createElement('div');
    item.className = 'picker-item';
    const _ts = s.last_active || s.created_at;
    const _d = _ts ? new Date(_ts) : null;
    const when = (_d && !isNaN(_d)) ? _d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown';
    item.innerHTML = `
      <div class="picker-item-info">
        <div class="picker-item-id">${s.id}</div>
        <div class="picker-item-meta">${s.backend} · ${when}</div>
      </div>
      <div class="picker-item-msgs">${s.message_count} msgs</div>
    `;
    item.addEventListener('click', () => { picker.style.display = 'none'; onPick(s); });
    list.appendChild(item);
  }
```

Replace it with (headline = summary, id moves to meta, shimmer when not yet generated, `data-session-id` for live updates):

```javascript
  for (const s of sessions) {
    if (s.message_count <= 1) continue;
    hasItems = true;
    const item = document.createElement('div');
    item.className = 'picker-item' + (s.summary && !s.summary_generated ? ' pending' : '');
    item.dataset.sessionId = s.id;
    const _ts = s.last_active || s.created_at;
    const _d = _ts ? new Date(_ts) : null;
    const when = (_d && !isNaN(_d)) ? _d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown';
    const id8 = String(s.id).slice(0, 8);
    const title = s.summary || s.id;
    item.innerHTML = `
      <div class="picker-item-info">
        <div class="picker-item-title">${title}</div>
        <div class="picker-item-meta">${s.backend} · ${id8} · ${when}</div>
      </div>
      <div class="picker-item-msgs">${s.message_count} msgs</div>
    `;
    item.addEventListener('click', () => { picker.style.display = 'none'; onPick(s); });
    list.appendChild(item);
  }

  // Stream in titles for sessions that don't have a generated one yet.
  if (window.deepconsole && window.deepconsole.llm && window.deepconsole.llm.onSummary) {
    const off = window.deepconsole.llm.onSummary(({ session_id, text }) => {
      const row = list.querySelector(`[data-session-id="${session_id}"]`);
      if (row) {
        const t = row.querySelector('.picker-item-title');
        if (t && text) t.textContent = text;
        row.classList.remove('pending');
      }
    });
    window.deepconsole.llm.streamSummaries().finally(() => {
      list.querySelectorAll('.picker-item.pending').forEach(r => r.classList.remove('pending'));
      if (off) off();
    });
  }
```

- [ ] **Step 2: Add shimmer style to `renderer/style.css`** (append at the end):

```css
.picker-item-title { font-weight: 600; }
.picker-item.pending .picker-item-title { opacity: 0.55; animation: picker-shimmer 1.1s ease-in-out infinite; }
@keyframes picker-shimmer { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.8; } }
```

(If a `.picker-item-id` rule already exists in `style.css` and styled the old headline, leave it; the new headline uses `.picker-item-title`. No need to delete the old rule.)

- [ ] **Step 3: Syntax check**

Run: `cd C:/github/deepconsole && node --check renderer/app.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
cd C:/github/deepconsole
git add renderer/app.js renderer/style.css
git commit -m "feat(ui): session picker shows summary, streams titles in live"
```

---

## Task 10: End-to-end manual verification

No code changes. Requires a fresh backend (the edits load only on restart) and the app.

- [ ] **Step 1:** Ensure port 8000 is free (kill any stale backend), then `! npm start` so a fresh backend with these changes spawns.
- [ ] **Step 2:** On startup, the session picker should show **readable labels** instead of hex ids — recent sessions (which got an eager title) immediately; older un-titled sessions show their first-message heuristic with a shimmer, then **upgrade to a generated title live** as the stream fills them in.
- [ ] **Step 3:** Start a brand-new chat, send one message, get a reply. Confirm the session JSON in `../localllm-abuddi/sessions/` gains a `"summary"` field after that first exchange (eager path), and a `summary` SSE event was emitted (visible in the renderer devtools `summaries:event` / `llm:event` if surfaced).
- [ ] **Step 4:** Reopen the picker (relaunch) — every previously-seen session now has a stored title and renders instantly with no shimmer (no stream work needed).

---

## Self-Review

**Spec coverage:**
- `session_title.py` (clean_title, heuristic_summary, _needs_title, generate_title) → Tasks 1–2 ✓
- `list_sessions` summary + summary_generated → Task 4 ✓
- Eager generation after first exchange → Tasks 3 + 7 ✓
- Lazy streaming backfill (≤3 concurrency, persist, yield per completion, skip failures) → Task 5 ✓
- SSE endpoint → Task 6 ✓
- IPC→SSE bridge + preload exposure → Task 8 ✓
- Picker: instant heuristic, shimmer, live upgrade, id secondary → Task 9 ✓
- Shimmer CSS → Task 9 ✓
- Error handling (best-effort title, per-session skip, picker usable without stream) → Tasks 2/3/5/7 ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type/name consistency:** `session_title` imported as `_title` in engine and `_st_mod`/`st` in tests; `_generate_and_store_title`, `stream_session_summaries`, `generate_title`, `heuristic_summary`, `_needs_title`, `summary`, `summary_generated`, the `summary` SSE event, the `summaries:event` IPC channel, `streamSummaries`/`onSummary`, and `.picker-item-title`/`.pending` are used identically across tasks. The `_json_t`, `_eng_t`, `_make_async_return` test helpers are defined in earlier `test_engine.py` tasks and reused.
