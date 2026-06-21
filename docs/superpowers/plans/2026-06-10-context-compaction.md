# Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace blind FIFO history eviction with staged compaction that stubs old tool results, rolls a flash-generated summary, extracts durable facts to the knowledge base, and relies on budget-exempt session memory for task carryover.

**Architecture:** A new async `context_manager.compact_session(session, owner)` runs in the streaming chat path (`engine.py`) where the session dict and async context exist. It applies stages in order, re-checking a char-based budget after each, and stops once under target: Stage A stubs bulky old `tool` results; Stage B flash-summarizes the evicted prefix into `session["compaction_summary"]` (a single marked synthetic system message); Stage C records returned facts via `knowledge.record_learning()`. `safety.prune_history` stays as the pure-sync fallback. A system-prompt directive nudges the agent to keep `task_state` in session memory, which is injected every turn and exempt from the history budget.

**Tech Stack:** Python 3, pytest (`asyncio_mode=auto`), `openai.AsyncOpenAI` against `https://api.deepseek.com` (model `deepseek-v4-flash`).

**Spec:** `docs/superpowers/specs/2026-06-10-context-compaction-design.md`

**Working directory for all paths below:** `C:/github/localllm-abuddi/`

---

## File Structure

- **Create** `context_manager.py` — all compaction logic (constants, pure helpers, `_flash_summarize`, `compact_session`).
- **Create** `tests/test_context_manager.py` — unit tests using an injected fake `summarize` (no model calls).
- **Modify** `engine.py` — import the module; swap the prune call at the streaming path (`engine.py:502`); add the `task_state` directive to `build_system_prompt`.
- `safety.py` — unchanged (`_estimate_tokens` and `MAX_CONTEXT_TOKENS` are imported from it).

---

### Task 1: Module scaffold — constants and pure helpers

**Files:**
- Create: `context_manager.py`
- Test: `tests/test_context_manager.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_context_manager.py`:

```python
import context_manager as cm


def test_render_summary_message_is_marked():
    msg = cm._render_summary_message("did some work")
    assert msg["role"] == "system"
    assert "did some work" in msg["content"]
    assert msg[cm._COMPACT_MARK] is True


def test_stub_old_tool_results_stubs_bulky_old_tool():
    history = [
        {"role": "system", "content": "sys"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "read_file", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "X" * 5000},
        {"role": "user", "content": "next"},
        {"role": "assistant", "content": "ok"},
    ]
    # recency window is 6, so add filler so the bulky tool msg is OUTSIDE it
    history += [{"role": "user", "content": "u"},
                {"role": "assistant", "content": "a"},
                {"role": "user", "content": "u2"},
                {"role": "assistant", "content": "a2"},
                {"role": "user", "content": "u3"},
                {"role": "assistant", "content": "a3"}]
    stubbed = cm._stub_old_tool_results(history)
    assert stubbed == 1
    assert history[2]["content"].startswith("[tool result elided")
    assert history[2]["tool_call_id"] == "c1"  # pairing preserved


def test_stub_skips_small_and_recent_tool_results():
    history = [
        {"role": "system", "content": "sys"},
        {"role": "tool", "tool_call_id": "c1", "content": "tiny"},   # too small
        {"role": "tool", "tool_call_id": "c2", "content": "Y" * 5000},  # in recency
    ]
    stubbed = cm._stub_old_tool_results(history)
    assert stubbed == 0
    assert history[2]["content"] == "Y" * 5000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_context_manager.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'context_manager'`

- [ ] **Step 3: Write minimal implementation**

Create `context_manager.py`:

```python
"""Staged context compaction for session history.

Replaces blind FIFO eviction (safety.prune_history) with a staged reduction
that moves information into DeepConsole's durable stores instead of deleting it:
  Stage A — stub bulky old tool results (lossless for reasoning)
  Stage B — flash-summarize the evicted prefix into a running summary
  Stage C — record durable facts to the knowledge base (Ghost-on-evict)
See docs/superpowers/specs/2026-06-10-context-compaction-design.md
"""
import json as _json
import logging
import os
import re

import openai

import knowledge as _knowledge
from safety import _estimate_tokens, MAX_CONTEXT_TOKENS

log = logging.getLogger("localllm.context")

COMPACT_TARGET_TOKENS = 18000   # compact DOWN to this (hysteresis below MAX)
RECENCY_WINDOW = 6              # last N messages always kept verbatim
TOOL_STUB_THRESHOLD = 200       # only stub tool results larger than this

_COMPACT_MARK = "_compacted"


def _render_summary_message(summary: str) -> dict:
    """The single synthetic system message that holds the running summary."""
    return {
        "role": "system",
        "content": "## Earlier conversation (compacted)\n" + summary,
        _COMPACT_MARK: True,
    }


def _stub_old_tool_results(history: list) -> int:
    """Stage A: replace bulky old tool-result content with a stub, in place.

    Skips history[0], the compaction-summary message, and the recency window.
    Keeps tool_call_id so sanitize_history pairing stays valid.
    Returns the number of messages stubbed.
    """
    n = len(history)
    recency_start = max(1, n - RECENCY_WINDOW)
    stubbed = 0
    for i in range(1, recency_start):
        m = history[i]
        if m.get(_COMPACT_MARK):
            continue
        if m.get("role") == "tool":
            content = str(m.get("content", ""))
            if len(content) > TOOL_STUB_THRESHOLD and not content.startswith(
                "[tool result elided"
            ):
                m["content"] = f"[tool result elided — {len(content)} chars]"
                stubbed += 1
    return stubbed
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_context_manager.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add context_manager.py tests/test_context_manager.py
git commit -m "feat(context): module scaffold + Stage A tool-result stubbing"
```

---

### Task 2: Summary-response parsing + flash summarizer

**Files:**
- Modify: `context_manager.py`
- Test: `tests/test_context_manager.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_context_manager.py`:

```python
def test_parse_summary_plain_json():
    raw = '{"summary": "we fixed the bug", "facts": ["port is 8000", ""]}'
    out = cm._parse_summary_response(raw)
    assert out["summary"] == "we fixed the bug"
    assert out["facts"] == ["port is 8000"]  # blank fact dropped


def test_parse_summary_strips_code_fence():
    raw = '```json\n{"summary": "did work", "facts": []}\n```'
    out = cm._parse_summary_response(raw)
    assert out["summary"] == "did work"
    assert out["facts"] == []


def test_parse_summary_rejects_missing_summary():
    assert cm._parse_summary_response('{"facts": ["x"]}') is None
    assert cm._parse_summary_response("not json") is None
    assert cm._parse_summary_response('{"summary": ""}') is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_context_manager.py -k parse_summary -v`
Expected: FAIL with `AttributeError: module 'context_manager' has no attribute '_parse_summary_response'`

- [ ] **Step 3: Write minimal implementation**

Add to `context_manager.py` (after `_stub_old_tool_results`):

```python
SUMMARIZE_SYSTEM_PROMPT = (
    "You compress part of an AI assistant's conversation history into durable "
    "memory. Reply with ONLY a JSON object of the form "
    '{"summary": "<concise running summary: what happened, decisions made, '
    'files touched, current state>", "facts": ["<durable fact>", ...]}. '
    "The summary must be self-contained prose under 200 words. facts is a list "
    "of 0-8 stable, reusable facts worth remembering across sessions; omit "
    "ephemeral chatter. Output nothing but the JSON."
)


def _parse_summary_response(raw: str) -> dict | None:
    """Parse the flash summarizer's JSON reply. Returns None on any problem."""
    if not raw:
        return None
    cleaned = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    try:
        data = _json.loads(cleaned)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    summary = str(data.get("summary") or "").strip()
    if not summary:
        return None
    facts = [str(f).strip() for f in (data.get("facts") or []) if str(f).strip()]
    return {"summary": summary, "facts": facts}


def _make_client():
    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        return None
    return openai.AsyncOpenAI(api_key=api_key, base_url="https://api.deepseek.com")


async def _flash_summarize(text: str) -> dict | None:
    """One cheap flash summary. Best-effort: returns None on any failure."""
    try:
        client = _make_client()
        if client is None:
            return None
        resp = await client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=[
                {"role": "system", "content": SUMMARIZE_SYSTEM_PROMPT},
                {"role": "user", "content": text[:24000]},
            ],
            max_tokens=600,
            stream=False,
        )
        return _parse_summary_response(resp.choices[0].message.content or "")
    except Exception as e:
        log.warning("_flash_summarize failed: %s", e)
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_context_manager.py -k parse_summary -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add context_manager.py tests/test_context_manager.py
git commit -m "feat(context): flash summarizer + robust JSON parsing"
```

---

### Task 3: `compact_session` orchestration (Stages A+B+C, fallback)

**Files:**
- Modify: `context_manager.py`
- Test: `tests/test_context_manager.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_context_manager.py`:

```python
import pytest


def _big_history(n_pairs=40, fill=2000):
    """Build a history well over MAX_CONTEXT_TOKENS with no bulky tool msgs."""
    h = [{"role": "system", "content": "sys"}]
    for i in range(n_pairs):
        h.append({"role": "user", "content": f"u{i} " + "x" * fill})
        h.append({"role": "assistant", "content": f"a{i} " + "y" * fill})
    return h


async def _fake_summarize(text):
    return {"summary": "rolled up earlier turns", "facts": ["fact-one", "fact-two"]}


@pytest.mark.asyncio
async def test_compact_noop_under_budget():
    session = {"history": [{"role": "system", "content": "sys"},
                           {"role": "user", "content": "hi"}]}
    changed = await cm.compact_session(session, "local", summarize=_fake_summarize)
    assert changed is False


@pytest.mark.asyncio
async def test_stage_a_alone_when_one_huge_tool_result():
    from safety import MAX_CONTEXT_TOKENS
    history = [{"role": "system", "content": "sys"},
               {"role": "user", "content": "read it"},
               {"role": "assistant", "content": "", "tool_calls": [
                   {"id": "c1", "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"}}]},
               {"role": "tool", "tool_call_id": "c1",
                "content": "Z" * (MAX_CONTEXT_TOKENS * 4 + 10)}]
    history += [{"role": "user", "content": f"q{i}"} for i in range(6)]  # recency filler
    calls = []

    async def spy(text):
        calls.append(text)
        return {"summary": "s", "facts": []}

    changed = await cm.compact_session({"history": history}, "local", summarize=spy)
    assert changed is True
    assert calls == []  # Stage A was enough; no summary call
    assert history[3]["content"].startswith("[tool result elided")


@pytest.mark.asyncio
async def test_stage_b_folds_prefix_into_marked_message():
    session = {"history": _big_history()}
    changed = await cm.compact_session(session, "local", summarize=_fake_summarize)
    h = session["history"]
    assert changed is True
    assert h[0]["role"] == "system" and not h[0].get(cm._COMPACT_MARK)
    assert h[1].get(cm._COMPACT_MARK) is True
    assert "rolled up earlier turns" in h[1]["content"]
    assert session["compaction_summary"] == "rolled up earlier turns"
    # recency window preserved verbatim at the tail
    assert h[-1]["content"].startswith("a39")


@pytest.mark.asyncio
async def test_refold_replaces_not_duplicates_marked_message():
    session = {"history": _big_history()}
    await cm.compact_session(session, "local", summarize=_fake_summarize)
    # grow it again and recompact
    session["history"] += _big_history()[1:]
    await cm.compact_session(session, "local", summarize=_fake_summarize)
    marked = [m for m in session["history"] if m.get(cm._COMPACT_MARK)]
    assert len(marked) == 1


@pytest.mark.asyncio
async def test_fallback_drops_prefix_when_summary_fails():
    session = {"history": _big_history()}

    async def failing(text):
        return None

    changed = await cm.compact_session(session, "local", summarize=failing)
    assert changed is True
    assert not any(m.get(cm._COMPACT_MARK) for m in session["history"])
    assert "compaction_summary" not in session  # nothing stored on failure
    assert cm._estimate_tokens(session["history"]) < cm.MAX_CONTEXT_TOKENS
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_context_manager.py -k compact or stage or refold or fallback -v`
Expected: FAIL with `AttributeError: module 'context_manager' has no attribute 'compact_session'`

- [ ] **Step 3: Write minimal implementation**

Add to `context_manager.py`:

```python
def _render_prefix_for_summary(prior_summary: str, prefix_msgs: list) -> str:
    parts = []
    if prior_summary:
        parts.append("Summary so far:\n" + prior_summary)
    parts.append("New conversation turns to fold in:")
    for m in prefix_msgs:
        role = m.get("role", "?")
        content = str(m.get("content", ""))
        if m.get("tool_calls"):
            names = ", ".join(
                tc.get("function", {}).get("name", "?") for tc in m["tool_calls"]
            )
            content = (content + f" [called tools: {names}]").strip()
        parts.append(f"{role}: {content}")
    return "\n\n".join(parts)


async def compact_session(session: dict, owner: str | None = None,
                          *, summarize=_flash_summarize) -> bool:
    """Reduce session['history'] below the token budget via staged compaction.

    Mutates session in place (history + compaction_summary). The caller persists
    the session. Returns True if any compaction occurred.
    """
    history = session.get("history") or []
    if _estimate_tokens(history) <= MAX_CONTEXT_TOKENS:
        return False

    changed = False

    # ── Stage A: stub bulky old tool results ──────────────────────────────
    if _stub_old_tool_results(history):
        changed = True
    if _estimate_tokens(history) <= COMPACT_TARGET_TOKENS:
        session["history"] = history
        return changed

    # ── Stage B: summarize + fold the evictable prefix ────────────────────
    n = len(history)
    recency_start = max(1, n - RECENCY_WINDOW)
    prefix_idx = [i for i in range(1, recency_start) if not history[i].get(_COMPACT_MARK)]
    if not prefix_idx:
        session["history"] = history
        return changed

    prefix_msgs = [history[i] for i in prefix_idx]
    prior_summary = (session.get("compaction_summary") or "").strip()
    blob = _render_prefix_for_summary(prior_summary, prefix_msgs)

    result = await summarize(blob)

    prefix_set = set(prefix_idx)
    keep = [history[0]] + [
        m for i, m in enumerate(history)
        if i != 0 and i not in prefix_set and not m.get(_COMPACT_MARK)
    ]

    if result and result.get("summary"):
        session["compaction_summary"] = result["summary"]
        keep.insert(1, _render_summary_message(result["summary"]))
        # ── Stage C: Ghost-on-evict — record durable facts ────────────────
        for fact in result.get("facts", []):
            try:
                _knowledge.record_learning(fact)
            except Exception as e:
                log.warning("record_learning failed: %s", e)
    # else: flash failed → plain FIFO drop of the prefix (no summary stored)

    session["history"] = keep
    return True
```

Also expose `_estimate_tokens` and `MAX_CONTEXT_TOKENS` as module attributes for the test (they are already imported at module top, so `cm._estimate_tokens` and `cm.MAX_CONTEXT_TOKENS` resolve — no extra code needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_context_manager.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add context_manager.py tests/test_context_manager.py
git commit -m "feat(context): compact_session staged orchestration + tests"
```

---

### Task 4: Stage C forwards facts to the knowledge base (verify wiring)

**Files:**
- Test: `tests/test_context_manager.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_context_manager.py`:

```python
from unittest.mock import patch


@pytest.mark.asyncio
async def test_stage_c_records_facts_as_learnings():
    session = {"history": _big_history()}
    with patch("context_manager._knowledge.record_learning") as rec:
        await cm.compact_session(session, "local", summarize=_fake_summarize)
    recorded = [c.args[0] for c in rec.call_args_list]
    assert recorded == ["fact-one", "fact-two"]


@pytest.mark.asyncio
async def test_stage_c_failure_does_not_break_compaction():
    session = {"history": _big_history()}
    with patch("context_manager._knowledge.record_learning",
               side_effect=RuntimeError("kb down")):
        changed = await cm.compact_session(session, "local", summarize=_fake_summarize)
    assert changed is True
    assert session["compaction_summary"] == "rolled up earlier turns"
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `python -m pytest tests/test_context_manager.py -k stage_c -v`
Expected: PASS (the Task-3 implementation already wires Stage C). If it fails, fix `compact_session` per Task 3 Step 3. This task is a guard confirming the contract.

- [ ] **Step 3: (No new implementation if Step 2 passed.)**

- [ ] **Step 4: Commit**

```bash
git add tests/test_context_manager.py
git commit -m "test(context): Stage C knowledge forwarding contract"
```

---

### Task 5: Wire compaction into the engine streaming path

**Files:**
- Modify: `engine.py:11` (imports), `engine.py:502` (prune call)

- [ ] **Step 1: Add the import**

In `engine.py`, after line 16 (`import grimoire as _grimoire`), add:

```python
import context_manager as _context
```

- [ ] **Step 2: Swap the prune call in the streaming path**

In `engine.py`, locate (around line 501-502):

```python
    session["history"] = sanitize_history(session["history"])
    session["history"], _ = prune_history(session["history"])
```

Replace **only the second line** so it reads:

```python
    session["history"] = sanitize_history(session["history"])
    await _context.compact_session(session, owner)
```

Leave the synchronous `_sanitize_chat` call site (around line 259) using `prune_history` unchanged.

- [ ] **Step 3: Verify the existing engine tests still pass**

Run: `python -m pytest tests/test_engine.py tests/test_engine_reasoning.py -v`
Expected: PASS (no regressions). The compaction is a no-op for small histories, so existing flows are unaffected.

- [ ] **Step 4: Verify nothing imports a now-unused name**

`prune_history` is still imported and used by `_sanitize_chat`, so the `from safety import ...` line stays. Confirm with:

Run: `python -c "import engine"`
Expected: no ImportError.

- [ ] **Step 5: Commit**

```bash
git add engine.py
git commit -m "feat(context): use compact_session in streaming chat path"
```

---

### Task 6: Add the `task_state` carryover directive to the system prompt

**Files:**
- Modify: `engine.py` — the Shared 3-Tier Working Memory section in `build_system_prompt` (around lines 170-177)

- [ ] **Step 1: Add the directive**

In `engine.py`, inside `build_system_prompt`, find the bullet line (around line 170):

```python
        "  - USE session memory for per-conversation progress tracking (e.g. 'current_step', "
        "'files_modified', 'decisions_made').\n"
```

Immediately after it, add:

```python
        "  - MAINTAIN a 'task_state' key in session memory (goal, what's done, "
        "what's next, key decisions) and update it as you work. The conversation "
        "history may be compacted when it grows large, but session memory is "
        "re-injected every turn and survives compaction — it is your durable "
        "task spine. Keep it current.\n"
```

- [ ] **Step 2: Verify the prompt builds**

Run: `python -c "import engine; print('task_state' in engine.build_system_prompt())"`
Expected: `True`

- [ ] **Step 3: Commit**

```bash
git add engine.py
git commit -m "feat(context): instruct agent to keep task_state in session memory"
```

---

### Task 7: Full test sweep

- [ ] **Step 1: Run the whole suite**

Run: `python -m pytest -v`
Expected: PASS (all prior tests plus the new `test_context_manager.py`).

- [ ] **Step 2: Smoke-import the modules together**

Run: `python -c "import engine, context_manager, safety; print('ok')"`
Expected: `ok`

- [ ] **Step 3: Final commit if anything changed**

```bash
git add -A
git commit -m "test(context): full suite green for context compaction" || echo "nothing to commit"
```

---

## Notes for the implementer

- **Char-based budget is intentional.** `_estimate_tokens` (≈ `len(content)//4`) is imported from `safety.py` and reused unchanged; do not swap in a real tokenizer (out of scope).
- **Pairing safety.** Stage A and the FIFO fallback may leave an orphaned `tool` message (its assistant `tool_calls` dropped) or a dangling assistant `tool_calls`. This is fine — `sanitize_history` runs immediately before compaction every turn and removes orphans, so the next request stays valid for DeepSeek.
- **Persistence.** `compact_session` only mutates the in-memory `session` dict. The streaming path saves the session at `engine.py:560` (before streaming) and again after each tool batch, so the compacted history and `compaction_summary` are persisted by the existing save calls.
- **Latency.** The flash summary call only fires on turns that overflow 28k AND aren't resolved by Stage A — a rare, expected cost.
