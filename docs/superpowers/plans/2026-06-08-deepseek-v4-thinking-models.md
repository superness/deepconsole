# DeepSeek V4 (flash/pro) + Computed Thinking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move DeepConsole's LLM backend from `deepseek-chat` to DeepSeek V4 — `deepseek-v4-flash` as the baseline, `deepseek-v4-pro` selectable per session for code work — with thinking mode auto-enabled for complex tasks via a cheap flash triage pass.

**Architecture:** The `abuddi-deepseek` backend becomes a two-phase flow. Phase 1 (triage) is a cheap `flash` non-thinking call that runs ABUDDI complexity scoring and returns a `complexity_score` + IMPLEMENT/DELEGATE decision. Phase 2 either delegates (existing sub-agent path) or runs a work pass whose model is the user-selected one and whose thinking mode is computed from the score. The engine passes the session's selected model through and persists `reasoning_content` on assistant turns (required so thinking-mode tool-call loops don't HTTP 400).

**Tech Stack:** Python (FastAPI, openai SDK, pytest with `asyncio_mode=auto`), Electron (main.js IPC, vanilla JS renderer).

**Two repos:**
- `C:/github/localllm-abuddi` — backend (Tasks 1–6). Its own git repo. Commit with `git -C C:/github/localllm-abuddi`.
- `C:/github/deepconsole` — UI (Task 7). Commit with `git -C C:/github/deepconsole`. Already on branch `feat/deepseek-v4-thinking`.

**Run tests from the backend repo:** `python -m pytest` with cwd `C:/github/localllm-abuddi` (PowerShell: `pytest` after the repo is the working dir; the executor may run `python -m pytest C:/github/localllm-abuddi/tests/...`).

---

## File Structure

| File | Repo | Responsibility | Change |
|---|---|---|---|
| `agent_orchestrator.py` | localllm-abuddi | Thresholds + `decide_thinking(score)` pure mapping | Modify |
| `backends/__init__.py` | localllm-abuddi | `ALLOWED_MODELS`, `DEFAULT_MODEL` constants | Modify |
| `backends/base.py` | localllm-abuddi | `stream(messages, tools, config=None)` protocol | Modify |
| `backends/deepseek.py` | localllm-abuddi | Raw flash backend: V4 model, config, reasoning_content | Modify |
| `backends/abuddi_deepseek.py` | localllm-abuddi | Two-phase triage→(delegate\|work) flow | Modify |
| `engine.py` | localllm-abuddi | Pass `model` as config; persist reasoning_content; store model | Modify |
| `server.py` | localllm-abuddi | Accept + validate `model` on session create | Modify |
| `tests/backends/test_deepseek.py` | localllm-abuddi | Update MODEL assertion; reasoning_content tests | Modify |
| `tests/test_thinking_decision.py` | localllm-abuddi | `decide_thinking` unit tests | Create |
| `tests/backends/test_abuddi_triage.py` | localllm-abuddi | Triage + work-pass tests | Create |
| `tests/test_engine_reasoning.py` | localllm-abuddi | Engine persists reasoning_content | Create |
| `main.js` | deepconsole | Pass `model` to `/sessions` | Modify |
| `preload.js` | deepconsole | `createSession(model)` bridge | Modify |
| `renderer/index.html` | deepconsole | Flash/Pro `<select>` | Modify |
| `renderer/app.js` | deepconsole | Read picker → pass model | Modify |

---

## Task 1: Thinking-decision function + thresholds

**Files:**
- Modify: `C:/github/localllm-abuddi/agent_orchestrator.py` (after the `ABUDDI_SYSTEM_PROMPT` block, ~line 148)
- Test: `C:/github/localllm-abuddi/tests/test_thinking_decision.py`

- [ ] **Step 1: Write the failing test**

Create `C:/github/localllm-abuddi/tests/test_thinking_decision.py`:

```python
import pytest
from agent_orchestrator import (
    decide_thinking,
    THINKING_THRESHOLD,
    MAX_EFFORT_THRESHOLD,
    DELEGATE_THRESHOLD,
)


def test_thresholds_are_ordered():
    assert THINKING_THRESHOLD < DELEGATE_THRESHOLD < MAX_EFFORT_THRESHOLD


@pytest.mark.parametrize("score,expected", [
    (None, (False, None)),
    (0, (False, None)),
    (11, (False, None)),
    (12, (True, "high")),
    (19, (True, "high")),
    (29, (True, "high")),
    (30, (True, "max")),
    (45, (True, "max")),
])
def test_decide_thinking(score, expected):
    assert decide_thinking(score) == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest C:/github/localllm-abuddi/tests/test_thinking_decision.py -v`
Expected: FAIL with `ImportError: cannot import name 'decide_thinking'`

- [ ] **Step 3: Write minimal implementation**

In `C:/github/localllm-abuddi/agent_orchestrator.py`, immediately after the closing `"""` of `ABUDDI_SYSTEM_PROMPT` (~line 148), add:

```python
# ─── Thinking-mode decision (computed from ABUDDI complexity score) ──────────
# The ABUDDI score ranges 6-60 (six dimensions, 1-10 each). These constants gate
# thinking mode on the work pass. Tunable — Balanced cost posture defaults:
THINKING_THRESHOLD = 12      # score >= -> enable thinking on the work pass
DELEGATE_THRESHOLD = 20      # score >= -> delegate (existing ABUDDI behavior)
MAX_EFFORT_THRESHOLD = 30    # score >= -> reasoning_effort "max" (else "high")
                             # (only reachable on a forced-implement-at-max-depth
                             #  work pass, since score >= 20 normally delegates)


def decide_thinking(score: "int | None") -> "tuple[bool, str | None]":
    """Map an ABUDDI complexity score (6-60, or None) to a thinking decision.

    Returns (thinking_enabled, reasoning_effort). reasoning_effort is None when
    thinking is disabled, else "high" or "max".
    """
    if score is None or score < THINKING_THRESHOLD:
        return (False, None)
    effort = "max" if score >= MAX_EFFORT_THRESHOLD else "high"
    return (True, effort)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest C:/github/localllm-abuddi/tests/test_thinking_decision.py -v`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
git -C C:/github/localllm-abuddi add agent_orchestrator.py tests/test_thinking_decision.py
git -C C:/github/localllm-abuddi commit -m "feat(abuddi): add decide_thinking() + complexity thresholds"
```

---

## Task 2: Model constants

**Files:**
- Modify: `C:/github/localllm-abuddi/backends/__init__.py`
- Test: `C:/github/localllm-abuddi/tests/backends/test_registry.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `C:/github/localllm-abuddi/tests/backends/test_registry.py`:

```python
def test_model_constants():
    from backends import ALLOWED_MODELS, DEFAULT_MODEL
    assert DEFAULT_MODEL == "deepseek-v4-flash"
    assert ALLOWED_MODELS == {"deepseek-v4-flash", "deepseek-v4-pro"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest C:/github/localllm-abuddi/tests/backends/test_registry.py::test_model_constants -v`
Expected: FAIL with `ImportError: cannot import name 'ALLOWED_MODELS'`

- [ ] **Step 3: Write minimal implementation**

In `C:/github/localllm-abuddi/backends/__init__.py`, add after the `BACKENDS` dict (after line 8):

```python
# Allowed DeepSeek V4 model ids for explicit per-session selection.
DEFAULT_MODEL = "deepseek-v4-flash"
ALLOWED_MODELS = {"deepseek-v4-flash", "deepseek-v4-pro"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest C:/github/localllm-abuddi/tests/backends/test_registry.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C C:/github/localllm-abuddi add backends/__init__.py tests/backends/test_registry.py
git -C C:/github/localllm-abuddi commit -m "feat(backends): add ALLOWED_MODELS / DEFAULT_MODEL (V4)"
```

---

## Task 3: Backend protocol signature + raw `deepseek` backend (V4, config, reasoning_content)

**Files:**
- Modify: `C:/github/localllm-abuddi/backends/base.py`
- Modify: `C:/github/localllm-abuddi/backends/deepseek.py`
- Test: `C:/github/localllm-abuddi/tests/backends/test_deepseek.py`

- [ ] **Step 1: Update the test helper + write failing tests**

In `C:/github/localllm-abuddi/tests/backends/test_deepseek.py`, replace the `make_openai_chunk` helper (lines 7–15) so a MagicMock delta doesn't auto-return a truthy `reasoning_content`:

```python
def make_openai_chunk(content=None, tool_call_deltas=None, reasoning_content=None):
    chunk = MagicMock()
    choice = MagicMock()
    delta = MagicMock()
    delta.content = content
    delta.tool_calls = tool_call_deltas
    delta.reasoning_content = reasoning_content
    choice.delta = delta
    chunk.choices = [choice]
    return chunk
```

Replace the model-constant test (lines 96–98) and add new tests at the end of the file:

```python
async def test_deepseek_model_constant():
    from backends.deepseek import DeepSeekBackend
    assert DeepSeekBackend.MODEL == "deepseek-v4-flash"


async def test_deepseek_captures_reasoning_content():
    from backends.deepseek import DeepSeekBackend
    chunks = [
        make_openai_chunk(reasoning_content="thinking..."),
        make_openai_chunk("answer"),
    ]
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=async_iter(chunks))
    with patch("backends.deepseek.openai.AsyncOpenAI", return_value=mock_client):
        backend = DeepSeekBackend()
        events = [e async for e in backend.stream([], [], {"thinking": True})]
    response = events[-1]
    assert response["reasoning_content"] == "thinking..."


async def test_deepseek_no_reasoning_content_is_none():
    from backends.deepseek import DeepSeekBackend
    chunks = [make_openai_chunk("hi")]
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=async_iter(chunks))
    with patch("backends.deepseek.openai.AsyncOpenAI", return_value=mock_client):
        backend = DeepSeekBackend()
        events = [e async for e in backend.stream([], [])]
    assert events[-1]["reasoning_content"] is None


async def test_deepseek_passes_model_and_thinking_from_config():
    from backends.deepseek import DeepSeekBackend
    chunks = [make_openai_chunk("hi")]
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=async_iter(chunks))
    with patch("backends.deepseek.openai.AsyncOpenAI", return_value=mock_client):
        backend = DeepSeekBackend()
        _ = [e async for e in backend.stream(
            [], [], {"model": "deepseek-v4-pro", "thinking": True, "reasoning_effort": "high"})]
    kwargs = mock_client.chat.completions.create.call_args.kwargs
    assert kwargs["model"] == "deepseek-v4-pro"
    assert kwargs["extra_body"] == {"thinking": {"type": "enabled"}}
    assert kwargs["reasoning_effort"] == "high"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest C:/github/localllm-abuddi/tests/backends/test_deepseek.py -v`
Expected: FAIL — `MODEL == "deepseek-chat"` assertion now wrong; new tests error on `stream()` taking a 3rd arg / missing `reasoning_content` key.

- [ ] **Step 3: Update the protocol signature**

Replace `C:/github/localllm-abuddi/backends/base.py` body with:

```python
from typing import AsyncIterator, Protocol


class Backend(Protocol):
    MODEL: str

    def stream(
        self,
        messages: list[dict],
        tools: list[dict],
        config: dict | None = None,
    ) -> AsyncIterator[dict]:
        """
        Async generator yielding per-turn events:
          {"type": "token",    "text": str}
          {"type": "response", "content": str,
                               "reasoning_content": str | None,
                               "tool_calls": list[dict]}

        config (optional): {"model": str, "thinking": bool,
                            "reasoning_effort": "high"|"max"|None}.
        Backends that don't support it ignore the argument.

        tool_calls items: {"name": str, "args": dict, "id": str}
        """
        ...
```

- [ ] **Step 4: Update the raw deepseek backend**

In `C:/github/localllm-abuddi/backends/deepseek.py`:

Change line 10:

```python
    MODEL = "deepseek-v4-flash"
```

Replace the `stream` method signature + the API-call block + the response yield. Replace lines 27–96 with:

```python
    async def stream(self, messages: list[dict], tools: list[dict], config: dict | None = None):
        # Defense in depth: strip any orphaned tool messages (a `tool` message not
        # preceded by an assistant `tool_calls`). Context pruning upstream can drop a
        # leading assistant+tool_calls message and strand its tool response, which
        # DeepSeek rejects with HTTP 400. Guarantee a valid request at the API boundary.
        from safety import sanitize_history
        messages = sanitize_history(messages)

        config = config or {}
        model = config.get("model") or self.MODEL
        thinking = bool(config.get("thinking"))
        effort = config.get("reasoning_effort")

        full_content = ""
        full_reasoning = ""
        tool_calls_map: dict[int, dict] = {}

        create_kwargs = dict(
            model=model,
            messages=messages,
            tools=tools if tools else openai.NOT_GIVEN,
            stream=True,
            # V4 supports a far larger window; 16384 gives headroom for big
            # write_file payloads + reasoning without runaway Balanced-posture cost.
            max_tokens=16384,
            extra_body={"thinking": {"type": "enabled" if thinking else "disabled"}},
        )
        if thinking and effort:
            create_kwargs["reasoning_effort"] = effort

        log.debug("stream calling DeepSeek model=%s thinking=%s msgs=%d tools=%d",
                  model, thinking, len(messages), len(tools) if tools else 0)
        try:
            raw_stream = await self._client.chat.completions.create(**create_kwargs)
        except Exception as e:
            log.error("stream API call failed: %s", e, exc_info=True)
            raise

        async for chunk in raw_stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta

            rc = getattr(delta, "reasoning_content", None)
            if rc:
                full_reasoning += rc

            if delta.content:
                full_content += delta.content
                yield {"type": "token", "text": delta.content}

            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx not in tool_calls_map:
                        tool_calls_map[idx] = {"id": "", "name": "", "args": ""}
                    if tc_delta.id:
                        tool_calls_map[idx]["id"] = tc_delta.id
                    if tc_delta.function.name:
                        tool_calls_map[idx]["name"] = tc_delta.function.name
                    if tc_delta.function.arguments:
                        tool_calls_map[idx]["args"] += tc_delta.function.arguments

        normalized = []
        for tc in tool_calls_map.values():
            raw = tc["args"]
            try:
                args = json.loads(raw) if raw else {}
            except json.JSONDecodeError as e:
                log.warning(
                    "tool_call %r: could not parse arguments JSON (%s) — "
                    "%d chars received, likely truncated by output token limit. "
                    "head=%r tail=%r",
                    tc["name"], e, len(raw), raw[:120], raw[-120:],
                )
                args = {}
            normalized.append({"name": tc["name"], "args": args, "id": tc["id"]})

        yield {"type": "response", "content": full_content,
               "reasoning_content": full_reasoning or None,
               "tool_calls": normalized}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest C:/github/localllm-abuddi/tests/backends/test_deepseek.py -v`
Expected: PASS (all, including the 3 new tests)

- [ ] **Step 6: Commit**

```bash
git -C C:/github/localllm-abuddi add backends/base.py backends/deepseek.py tests/backends/test_deepseek.py
git -C C:/github/localllm-abuddi commit -m "feat(deepseek): V4 flash baseline, config-driven thinking + reasoning_content"
```

---

## Task 4: Engine — pass model config + persist reasoning_content

**Files:**
- Modify: `C:/github/localllm-abuddi/engine.py` (chat_session: ~line 436 backend selection, ~line 455 stream call, ~line 475 and ~line 513 assistant append; create_session ~line 241)
- Test: `C:/github/localllm-abuddi/tests/test_engine_reasoning.py`

- [ ] **Step 1: Write the failing test**

Create `C:/github/localllm-abuddi/tests/test_engine_reasoning.py`:

```python
import json
import os
import pytest
import engine


async def _drain(gen):
    return [e async for e in gen]


async def test_reasoning_content_persisted_on_final_turn(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "SESSIONS_DIR", str(tmp_path))

    class FakeBackend:
        async def stream(self, messages, tools, config=None):
            yield {"type": "token", "text": "ok"}
            yield {"type": "response", "content": "ok",
                   "reasoning_content": "because reasons", "tool_calls": []}

    monkeypatch.setattr(engine, "get_backend", lambda name: FakeBackend())

    sess = engine.create_session(backend="deepseek", owner="local")
    await _drain(engine.chat_session(sess["id"], "hello", owner="local"))

    with open(os.path.join(str(tmp_path), f"local_{sess['id']}.json"), encoding="utf-8") as f:
        saved = json.load(f)
    asst = [m for m in saved["history"] if m["role"] == "assistant"][-1]
    assert asst["reasoning_content"] == "because reasons"


async def test_model_passed_to_backend_as_config(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "SESSIONS_DIR", str(tmp_path))
    seen = {}

    class FakeBackend:
        async def stream(self, messages, tools, config=None):
            seen["config"] = config
            yield {"type": "response", "content": "x",
                   "reasoning_content": None, "tool_calls": []}

    monkeypatch.setattr(engine, "get_backend", lambda name: FakeBackend())

    sess = engine.create_session(backend="deepseek", owner="local", model="deepseek-v4-pro")
    await _drain(engine.chat_session(sess["id"], "hi", owner="local"))
    assert seen["config"]["model"] == "deepseek-v4-pro"
```

> Note: if `engine.SESSIONS_DIR` is resolved differently (e.g. a module constant used at call time), the `monkeypatch.setattr` above targets it. Verify the attribute name in `engine.py` and adjust if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest C:/github/localllm-abuddi/tests/test_engine_reasoning.py -v`
Expected: FAIL — `create_session()` has no `model` kwarg; config is `None`; assistant message has no `reasoning_content`.

- [ ] **Step 3: Add `model` to create_session**

In `C:/github/localllm-abuddi/engine.py`, update `create_session` (line 241). Change the signature and the stored dict:

```python
def create_session(
    system_prompt: str | None = None,
    backend: str = "deepseek",
    owner: str = "local",
    working_dir: str | None = None,
    model: str | None = None,
) -> dict:
```

Change the `"model": None,` line (line 259) to:

```python
        "model": model,
```

- [ ] **Step 4: Pass config into stream + persist reasoning_content**

In `chat_session`, add an import at the top of `engine.py` (with the other backend imports near line 10):

```python
from backends import BACKENDS, get_backend, DEFAULT_MODEL
```

After the backend is resolved (~line 442, right after the `try/except` that sets `backend`), add:

```python
    request_config = {"model": session.get("model") or DEFAULT_MODEL}
```

Change the stream call (line 455) from:

```python
            async for chunk in backend.stream(history, TOOLS):
```

to:

```python
            async for chunk in backend.stream(history, TOOLS, request_config):
```

Change the tool-call assistant append (lines 475–485) to attach reasoning_content when present:

```python
                asst_msg = {
                    "role": "assistant",
                    "content": response["content"],
                    "tool_calls": [
                        {"id": tc["id"], "type": "function",
                         "function": {"name": tc["name"],
                                      "arguments": _json.dumps(tc["args"])}}
                        for tc in tool_calls
                    ],
                    "timestamp": _now(),
                }
                if response.get("reasoning_content"):
                    asst_msg["reasoning_content"] = response["reasoning_content"]
                history.append(asst_msg)
```

Change the final-answer assistant append (lines 513–514) to:

```python
                asst_msg = {"role": "assistant", "content": response["content"],
                            "timestamp": _now()}
                if response.get("reasoning_content"):
                    asst_msg["reasoning_content"] = response["reasoning_content"]
                history.append(asst_msg)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest C:/github/localllm-abuddi/tests/test_engine_reasoning.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Run the engine test suite for regressions**

Run: `python -m pytest C:/github/localllm-abuddi/tests/test_engine.py -v`
Expected: PASS (the mock backends in test_engine.py take `stream(self, messages, tools)` — if any now fail because the engine passes a 3rd positional arg, update those mock signatures to `stream(self, messages, tools, config=None)`).

- [ ] **Step 7: Commit**

```bash
git -C C:/github/localllm-abuddi add engine.py tests/test_engine_reasoning.py tests/test_engine.py
git -C C:/github/localllm-abuddi commit -m "feat(engine): pass session model as config; persist reasoning_content"
```

---

## Task 5: Abuddi backend — two-phase triage → (delegate | work)

**Files:**
- Modify: `C:/github/localllm-abuddi/backends/abuddi_deepseek.py`
- Test: `C:/github/localllm-abuddi/tests/backends/test_abuddi_triage.py`

This task restructures `AbuddiDeepSeekBackend.stream` into: a `_triage` pass (flash, no thinking, no tools) that owns scoring/decision, then either the existing delegation path (`_run_delegation`) or a `_work_pass` whose model comes from config and whose thinking is computed from the score. The inline self-scoring on the work pass is removed.

- [ ] **Step 1: Write the failing tests**

Create `C:/github/localllm-abuddi/tests/backends/test_abuddi_triage.py`:

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.fixture(autouse=True)
def deepseek_api_key(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")


def make_chunk(content=None, reasoning_content=None, tool_call_deltas=None):
    chunk = MagicMock()
    choice = MagicMock()
    delta = MagicMock()
    delta.content = content
    delta.reasoning_content = reasoning_content
    delta.tool_calls = tool_call_deltas
    choice.delta = delta
    chunk.choices = [choice]
    return chunk


async def async_iter(items):
    for item in items:
        yield item


def _triage_response(text):
    """A non-streaming completion response object whose message.content == text."""
    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = text
    return resp


async def test_triage_returns_score_and_implement():
    from backends.abuddi_deepseek import AbuddiDeepSeekBackend
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(
        return_value=_triage_response("COMPLEXITY_SCORE: 8\nMAESTRO_DECISION: IMPLEMENT"))
    with patch("backends.abuddi_deepseek.openai.AsyncOpenAI", return_value=mock_client):
        backend = AbuddiDeepSeekBackend()
        result = await backend._triage([{"role": "user", "content": "rename a var"}])
    assert result["score"] == 8
    assert result["decision"] == "IMPLEMENT"
    # triage must be flash + non-thinking
    kwargs = mock_client.chat.completions.create.call_args.kwargs
    assert kwargs["model"] == "deepseek-v4-flash"
    assert kwargs["extra_body"] == {"thinking": {"type": "disabled"}}


async def test_triage_failure_defaults_to_zero_implement():
    from backends.abuddi_deepseek import AbuddiDeepSeekBackend
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(side_effect=RuntimeError("boom"))
    with patch("backends.abuddi_deepseek.openai.AsyncOpenAI", return_value=mock_client):
        backend = AbuddiDeepSeekBackend()
        result = await backend._triage([{"role": "user", "content": "x"}])
    assert result["score"] == 0
    assert result["decision"] == "IMPLEMENT"


async def test_work_pass_uses_selected_model_and_computed_thinking():
    from backends.abuddi_deepseek import AbuddiDeepSeekBackend
    backend_client = MagicMock()
    # triage returns a mid-band score (thinking on, no delegate), then work streams.
    backend_client.chat.completions.create = AsyncMock(side_effect=[
        _triage_response("COMPLEXITY_SCORE: 14\nMAESTRO_DECISION: IMPLEMENT"),
        async_iter([make_chunk(reasoning_content="hmm"), make_chunk("done")]),
    ])
    with patch("backends.abuddi_deepseek.openai.AsyncOpenAI", return_value=backend_client):
        backend = AbuddiDeepSeekBackend()
        events = [e async for e in backend.stream(
            [{"role": "system", "content": "Session: s1"},
             {"role": "user", "content": "implement a feature"}],
            [],
            {"model": "deepseek-v4-pro"})]
    response = events[-1]
    assert response["type"] == "response"
    assert response["reasoning_content"] == "hmm"
    # second call is the work pass: pro model, thinking enabled at high
    work_kwargs = backend_client.chat.completions.create.call_args_list[1].kwargs
    assert work_kwargs["model"] == "deepseek-v4-pro"
    assert work_kwargs["extra_body"] == {"thinking": {"type": "enabled"}}
    assert work_kwargs["reasoning_effort"] == "high"


async def test_work_pass_low_score_no_thinking():
    from backends.abuddi_deepseek import AbuddiDeepSeekBackend
    backend_client = MagicMock()
    backend_client.chat.completions.create = AsyncMock(side_effect=[
        _triage_response("COMPLEXITY_SCORE: 5\nMAESTRO_DECISION: IMPLEMENT"),
        async_iter([make_chunk("quick answer")]),
    ])
    with patch("backends.abuddi_deepseek.openai.AsyncOpenAI", return_value=backend_client):
        backend = AbuddiDeepSeekBackend()
        events = [e async for e in backend.stream(
            [{"role": "user", "content": "hi"}], [], {"model": "deepseek-v4-flash"})]
    work_kwargs = backend_client.chat.completions.create.call_args_list[1].kwargs
    assert work_kwargs["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "reasoning_effort" not in work_kwargs
    assert events[-1]["content"] == "quick answer"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest C:/github/localllm-abuddi/tests/backends/test_abuddi_triage.py -v`
Expected: FAIL — `_triage` does not exist; `stream` takes no config; no two-phase behavior.

- [ ] **Step 3: Add the triage prompt + imports**

In `C:/github/localllm-abuddi/backends/abuddi_deepseek.py`, extend the import from `agent_orchestrator` (lines 18–25) to also import the decision helpers:

```python
from agent_orchestrator import (
    get_agent,
    get_agent_system_prompt,
    ABUDDI_SYSTEM_PROMPT,
    parse_delegation_markers,
    get_orchestrator,
    parse_complexity_response,
    decide_thinking,
    DELEGATE_THRESHOLD,
)
```

Add a module-level triage prompt after the imports (after line 27, before the class):

```python
TRIAGE_PROMPT = """You are a task-triage classifier. Score the user's LATEST request
using the ABUDDI complexity framework, then decide IMPLEMENT or DELEGATE. Do NOT do
the work and do NOT call tools.

Score six dimensions (1-10 each): Atomic Scope, Breadth, Uncertainty, Dependencies,
Depth, Impact. Their sum is the complexity score (range 6-60).

Output ONLY these two lines:
COMPLEXITY_SCORE: <integer 6-60>
MAESTRO_DECISION: <IMPLEMENT if score < 20, else DELEGATE>

If and only if DELEGATE, append one or more blocks (one per agent):
[SUBTASK]
{"name": "short name", "hat": "feature-owner", "priority": 1, "context": "everything the agent needs to work independently", "workingDirectory": "C:/github/deepconsole"}
[/SUBTASK]
"""
```

- [ ] **Step 4: Add the `_triage` method**

Add this method to `AbuddiDeepSeekBackend` (place it right before `_inject_abuddi_prompt`, ~line 239):

```python
    async def _triage(self, messages: list[dict]) -> dict:
        """Phase 1: a cheap flash, non-thinking, tool-free scoring pass.

        Returns {"score": int, "decision": "IMPLEMENT"|"DELEGATE", "subtasks": list}.
        On any failure, falls back to score 0 / IMPLEMENT so the work pass still runs.
        """
        from safety import sanitize_history
        convo = sanitize_history([m for m in messages if m.get("role") != "system"])
        triage_messages = [{"role": "system", "content": TRIAGE_PROMPT}] + convo
        try:
            resp = await self._client.chat.completions.create(
                model="deepseek-v4-flash",
                messages=triage_messages,
                stream=False,
                max_tokens=700,
                extra_body={"thinking": {"type": "disabled"}},
            )
            text = resp.choices[0].message.content or ""
        except Exception as e:
            log.warning("triage failed (%s) — defaulting to score 0 / IMPLEMENT", e)
            return {"score": 0, "decision": "IMPLEMENT", "subtasks": []}

        parsed = parse_delegation_markers(text)
        score = parsed.get("complexity_score")
        decision = parsed.get("decision") or "IMPLEMENT"
        return {
            "score": score if score is not None else 0,
            "decision": decision,
            "subtasks": parsed.get("subtasks", []),
        }
```

- [ ] **Step 5: Add `_inject_work_prompt` and `_work_pass`**

Add these two methods to `AbuddiDeepSeekBackend` (after `_triage`):

```python
    def _inject_work_prompt(self, messages: list[dict]) -> list[dict]:
        """For the work pass: apply the agent-hat prompt if this session has one,
        but NOT the ABUDDI scoring/delegation machinery (triage already decided)."""
        modified = list(messages)
        agent_id = self._detect_agent_from_history(modified)
        if agent_id and agent_id != "product-maestro":
            agent_prompt = get_agent_system_prompt(agent_id)
            if agent_prompt:
                for i, msg in enumerate(modified):
                    if msg.get("role") == "system":
                        modified[i] = {**msg, "content": agent_prompt + "\n\n" + msg["content"]}
                        break
        return modified

    async def _work_pass(self, messages, tools, model, thinking, effort):
        """Phase 2b: the real implementation pass. Streams tokens, captures
        reasoning_content, and yields the final response chunk."""
        from safety import sanitize_history
        messages = self._inject_work_prompt(messages)
        messages = sanitize_history(messages)

        full_content = ""
        full_reasoning = ""
        tool_calls_map: dict[int, dict] = {}

        create_kwargs = dict(
            model=model,
            messages=messages,
            tools=tools if tools else openai.NOT_GIVEN,
            stream=True,
            max_tokens=16384,
            extra_body={"thinking": {"type": "enabled" if thinking else "disabled"}},
        )
        if thinking and effort:
            create_kwargs["reasoning_effort"] = effort

        raw_stream = await self._client.chat.completions.create(**create_kwargs)
        async for chunk in raw_stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            rc = getattr(delta, "reasoning_content", None)
            if rc:
                full_reasoning += rc
            if delta.content:
                full_content += delta.content
                yield {"type": "token", "text": delta.content}
            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx not in tool_calls_map:
                        tool_calls_map[idx] = {"id": "", "name": "", "args": ""}
                    if tc_delta.id:
                        tool_calls_map[idx]["id"] = tc_delta.id
                    if tc_delta.function.name:
                        tool_calls_map[idx]["name"] = tc_delta.function.name
                    if tc_delta.function.arguments:
                        tool_calls_map[idx]["args"] += tc_delta.function.arguments

        normalized = []
        for tc in tool_calls_map.values():
            raw = tc["args"]
            try:
                args = json.loads(raw) if raw else {}
            except json.JSONDecodeError as e:
                log.warning(
                    "tool_call %r: could not parse arguments JSON (%s) — "
                    "%d chars received, likely truncated. head=%r tail=%r",
                    tc["name"], e, len(raw), raw[:120], raw[-120:],
                )
                args = {}
            normalized.append({"name": tc["name"], "args": args, "id": tc["id"]})

        yield {"type": "response", "content": full_content,
               "reasoning_content": full_reasoning or None,
               "tool_calls": normalized}
```

- [ ] **Step 6: Replace `stream` with the two-phase orchestration**

Replace the entire existing `stream` method (lines 49–237) with:

```python
    async def stream(self, messages: list[dict], tools: list[dict], config: dict | None = None):
        """Two-phase flow: triage (flash/no-think) → delegate or work pass."""
        config = config or {}
        work_model = config.get("model") or "deepseek-v4-flash"

        # ── Phase 1: triage ──────────────────────────────────────────────────
        triage = await self._triage(messages)
        score = triage["score"]

        # ── Phase 2a: delegate (score >= DELEGATE_THRESHOLD) ─────────────────
        if (triage["decision"] == "DELEGATE" and triage["subtasks"]
                and score >= DELEGATE_THRESHOLD):
            depth = self._count_delegation_depth(messages)
            if depth < self._max_depth:
                async for ev in self._run_delegation(messages, triage["subtasks"]):
                    yield ev
                return
            # Max depth reached — fall through to a forced work pass with a note.
            yield {"type": "token",
                   "text": "\n\n[ABUDDI] Max delegation depth — implementing directly.\n"}

        # ── Phase 2b: work pass (thinking computed from score) ───────────────
        thinking, effort = decide_thinking(score)
        async for ev in self._work_pass(messages, tools, work_model, thinking, effort):
            yield ev
```

- [ ] **Step 7: Extract the delegation body into `_run_delegation`**

Add this method (it reuses the existing dispatch code, now keyed off the triage subtasks). Place it after `_work_pass`:

```python
    async def _run_delegation(self, messages, subtasks):
        """Phase 2a: dispatch sub-agents for the triage-selected subtasks and
        stream their progress + a synthesis. Mirrors the prior inline path."""
        yield {"type": "token", "text": "\n\n[ABUDDI] Delegating to sub-agents...\n"}
        try:
            import engine
            orchestrator = get_orchestrator(engine)
            queue: asyncio.Queue = asyncio.Queue()

            yield {
                "type": "subagent",
                "data": {
                    "phase": "start",
                    "subtasks": [
                        {"name": st.get("name", "Unnamed Task"),
                         "hat": st.get("hat", "sub-ic")}
                        for st in subtasks
                    ],
                },
            }

            dispatch_task = asyncio.create_task(
                orchestrator.dispatch_subtasks(
                    parent_session_id=self._get_session_id(messages),
                    subtasks=subtasks,
                    parent_owner="local",
                    progress_queue=queue,
                )
            )

            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.1)
                    yield {"type": "subagent", "data": event}
                except asyncio.TimeoutError:
                    if dispatch_task.done():
                        while not queue.empty():
                            yield {"type": "subagent", "data": queue.get_nowait()}
                        break

            results = dispatch_task.result()
            synthesis = self._synthesize_results({"subtasks": subtasks}, results)
            yield {"type": "token", "text": synthesis}
            yield {"type": "response", "content": synthesis,
                   "reasoning_content": None, "tool_calls": []}
        except Exception as e:
            error_msg = (
                f"\n\n[ABUDDI ERROR] Delegation failed: {e}\n"
                "Falling back to direct implementation.\n\n"
                f"MAESTRO_DECISION: IMPLEMENT\n\nRESULT: {{\"status\": \"error\", \"message\": \"{e}\"}}"
            )
            yield {"type": "token", "text": error_msg}
            yield {"type": "response", "content": error_msg,
                   "reasoning_content": None, "tool_calls": []}
```

> The now-unused helpers `_inject_abuddi_prompt` and `_llm_parse_decision` may remain in the file (harmless) or be deleted. Leave them for this task to keep the diff focused; a follow-up cleanup can remove them. `_synthesize_results`, `_get_session_id`, `_detect_agent_from_history`, `_count_delegation_depth` are still used.

- [ ] **Step 8: Run the triage tests**

Run: `python -m pytest C:/github/localllm-abuddi/tests/backends/test_abuddi_triage.py -v`
Expected: PASS (4 passed)

- [ ] **Step 9: Run the whole backend suite for regressions**

Run: `python -m pytest C:/github/localllm-abuddi/tests/backends/ -v`
Expected: PASS. (Pre-existing unrelated failures noted in the spec — ollama/chat-SSE — are out of scope; confirm no NEW failures in deepseek/abuddi/registry tests.)

- [ ] **Step 10: Commit**

```bash
git -C C:/github/localllm-abuddi add backends/abuddi_deepseek.py tests/backends/test_abuddi_triage.py
git -C C:/github/localllm-abuddi commit -m "feat(abuddi): two-phase triage->work flow with computed thinking"
```

---

## Task 6: Server — accept + validate `model` on session create

**Files:**
- Modify: `C:/github/localllm-abuddi/server.py` (CreateSessionRequest ~line 61, create_session route ~line 106)
- Test: `C:/github/localllm-abuddi/tests/test_server.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `C:/github/localllm-abuddi/tests/test_server.py` (it already uses `TestClient`; reuse the existing `client` fixture if present, else construct one as the file's other tests do):

```python
def test_create_session_accepts_valid_model(client):
    r = client.post("/sessions", json={"backend": "abuddi-deepseek", "model": "deepseek-v4-pro"})
    assert r.status_code == 200
    assert r.json()["model"] == "deepseek-v4-pro"


def test_create_session_rejects_unknown_model(client):
    r = client.post("/sessions", json={"backend": "abuddi-deepseek", "model": "gpt-4"})
    assert r.status_code == 422
```

> If `test_server.py` does not expose a `client` fixture, mirror the construction used by the existing session tests in that file (e.g. `TestClient(app)`), and adapt the two tests accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest C:/github/localllm-abuddi/tests/test_server.py -k model -v`
Expected: FAIL — `model` is ignored (response `model` is null) and unknown model is accepted (200, not 422).

- [ ] **Step 3: Add the model field + validator**

In `C:/github/localllm-abuddi/server.py`, add the import near the top (with the other `from backends import ...` usage — `BACKENDS` is imported at line 30):

```python
from backends import BACKENDS, ALLOWED_MODELS
```

Extend `CreateSessionRequest` (line 61) with a `model` field + validator:

```python
class CreateSessionRequest(BaseModel):
    system_prompt: str | None = None
    backend: str = "deepseek"
    working_dir: str | None = None
    model: str | None = None

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, v: str) -> str:
        if v not in BACKENDS:
            raise ValueError(
                f"Unknown backend: {v!r}. Available: {sorted(BACKENDS)}"
            )
        return v

    @field_validator("model")
    @classmethod
    def validate_model(cls, v: str | None) -> str | None:
        if v is not None and v not in ALLOWED_MODELS:
            raise ValueError(
                f"Unknown model: {v!r}. Available: {sorted(ALLOWED_MODELS)}"
            )
        return v
```

Pass `model` through in the route (line 108):

```python
@app.post("/sessions")
def create_session(body: CreateSessionRequest = CreateSessionRequest(), owner: str = Depends(get_owner)):
    return engine.create_session(
        system_prompt=body.system_prompt,
        backend=body.backend,
        owner=owner,
        working_dir=body.working_dir,
        model=body.model,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest C:/github/localllm-abuddi/tests/test_server.py -k model -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git -C C:/github/localllm-abuddi add server.py tests/test_server.py
git -C C:/github/localllm-abuddi commit -m "feat(server): accept + validate per-session model"
```

---

## Task 7: DeepConsole UI — Flash/Pro picker

**Files:**
- Modify: `C:/github/deepconsole/preload.js:6`
- Modify: `C:/github/deepconsole/main.js` (`llm:createSession` ~line 346; `maestro:dispatch` create ~line 397)
- Modify: `C:/github/deepconsole/renderer/index.html` (titlebar-actions ~line 19)
- Modify: `C:/github/deepconsole/renderer/app.js` (`initSession` ~line 219)

No automated test (Electron UI). Verified manually in the run step.

- [ ] **Step 1: Bridge a model arg through preload**

In `C:/github/deepconsole/preload.js`, change line 6:

```javascript
    createSession: (model) => ipcRenderer.invoke('llm:createSession', model),
```

- [ ] **Step 2: Accept the model in main.js and forward it**

In `C:/github/deepconsole/main.js`, change the `llm:createSession` handler (line 346):

```javascript
ipcMain.handle('llm:createSession', async (_e, model) => { try { return await httpRequest('POST', '/sessions', { backend: 'abuddi-deepseek', model: model || 'deepseek-v4-flash', working_dir: DEEPCONSOLE_DIR.replace(/\\/g, '/') }); } catch (e) { throw e; } });
```

In the `maestro:dispatch` session create (line 397), add the model field (default flash) so dispatched sessions are explicit too:

```javascript
    const session = await httpRequest('POST', '/sessions', { backend: 'abuddi-deepseek', model: 'deepseek-v4-flash', working_dir: workingDirectory || DEEPCONSOLE_DIR.replace(/\\/g, '/') });
```

- [ ] **Step 3: Add the picker to the titlebar**

In `C:/github/deepconsole/renderer/index.html`, inside `<div class="titlebar-actions">` (after line 19), add before the existing buttons:

```html
        <select id="model-picker" class="model-picker" title="DeepSeek model">
          <option value="deepseek-v4-flash">Flash</option>
          <option value="deepseek-v4-pro">Pro</option>
        </select>
```

- [ ] **Step 4: Read the picker in the renderer and pass it**

In `C:/github/deepconsole/renderer/app.js`, change `initSession` (line 222) to read the picker:

```javascript
    const selectedModel = (document.getElementById('model-picker') || {}).value || 'deepseek-v4-flash';
    const session = await window.deepconsole.llm.createSession(selectedModel);
```

- [ ] **Step 5: Syntax-check the changed JS**

Run: `node --check C:/github/deepconsole/main.js && node --check C:/github/deepconsole/preload.js && node --check C:/github/deepconsole/renderer/app.js`
Expected: no output (all valid).

- [ ] **Step 6: Commit**

```bash
git -C C:/github/deepconsole add preload.js main.js renderer/index.html renderer/app.js
git -C C:/github/deepconsole commit -m "feat(ui): Flash/Pro model picker on new session"
```

---

## Task 8: Docs + full verification

**Files:**
- Modify: `C:/github/deepconsole/CLAUDE.md` (the DeepSeek model note)
- Modify: `C:/github/localllm-abuddi/` docs if a backend README references `deepseek-chat` (grep first)

- [ ] **Step 1: Update CLAUDE.md**

In `C:/github/deepconsole/CLAUDE.md`, under the architecture/external-dependency notes, add a short subsection (place after the "External dependency" section):

```markdown
### DeepSeek models

The backend uses DeepSeek **V4**. `deepseek-v4-flash` is the baseline (and the
triage model); `deepseek-v4-pro` is selectable per session via the Flash/Pro
picker in the titlebar for heavier code work. Thinking mode is **computed**: the
`abuddi-deepseek` backend runs a cheap flash non-thinking *triage* pass that
produces an ABUDDI `complexity_score`, and `decide_thinking(score)` enables
thinking (effort `high`, or `max` ≥30) on the work pass when `score ≥ 12`.
`reasoning_content` is captured and threaded through history so thinking-mode
tool-call loops don't HTTP 400. See
`docs/superpowers/specs/2026-06-08-deepseek-v4-thinking-models-design.md`.
```

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rn "deepseek-chat" C:/github/localllm-abuddi --include=*.py`
Expected: no remaining hardcoded `deepseek-chat` in `backends/` or `server.py` (test fixtures/comments referencing the old name are fine; the `_llm_parse_decision` helper, if left in place, should also be updated to `deepseek-v4-flash` — do so now).

If `_llm_parse_decision` still references `model="deepseek-chat"`, change it to `model="deepseek-v4-flash"`.

- [ ] **Step 3: Full backend test run**

Run: `python -m pytest C:/github/localllm-abuddi/tests -v`
Expected: PASS for all deepseek/abuddi/registry/engine/thinking/server-model tests. Pre-existing unrelated failures (ollama backend, chat-SSE mock — documented in the spec) may remain; confirm no NEW failures introduced by this work.

- [ ] **Step 4: Commit**

```bash
git -C C:/github/localllm-abuddi add -A
git -C C:/github/localllm-abuddi commit -m "chore: drop deepseek-chat stragglers; V4 everywhere"
git -C C:/github/deepconsole add CLAUDE.md
git -C C:/github/deepconsole commit -m "docs: document DeepSeek V4 + computed thinking"
```

---

## Self-Review

**Spec coverage:**
- Flash baseline → Task 2 (constants), Task 3 (`MODEL`).  ✓
- Explicit pro selection → Task 6 (server `model`), Task 7 (UI picker), Task 4 (engine stores + passes).  ✓
- Computed thinking via triage → Task 1 (`decide_thinking`), Task 5 (`_triage` + work pass).  ✓
- Triage = single scoring authority; inline self-scoring removed → Task 5 (`stream` rewrite, `_inject_work_prompt` omits ABUDDI machinery).  ✓
- `reasoning_content` threading → Task 3 (capture in raw), Task 5 (capture in work pass), Task 4 (engine persists; `sanitize_history` already preserves extra keys).  ✓
- `max_tokens` 16384 → Tasks 3 & 5.  ✓
- Thresholds (12/20/30) → Task 1.  ✓
- Error handling: triage failure → score 0/IMPLEMENT (Task 5); unknown model → 422 (Task 6); max-depth forced implement (Task 5 `stream`).  ✓
- Tests for each → Tasks 1,3,4,5,6.  ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The only "leave as-is" notes (unused `_inject_abuddi_prompt`/`_llm_parse_decision`) are explicit and harmless, with the `_llm_parse_decision` model string fixed in Task 8.

**Type/name consistency:** `decide_thinking` returns `(bool, str|None)` — consumed identically in Task 5. Response chunks always carry `reasoning_content` (Tasks 3, 5) and the engine reads `response.get("reasoning_content")` (Task 4). `config` keys (`model`, `thinking`, `reasoning_effort`) match across base.py, deepseek.py, abuddi_deepseek.py, engine.py. `ALLOWED_MODELS`/`DEFAULT_MODEL` defined in Task 2, used in Tasks 4 & 6.

**Known external caveat:** the in-app DeepSeek agent auto-commits file edits to the active branch; if it touches these files mid-execution, re-check for duplicate declarations before each commit.
