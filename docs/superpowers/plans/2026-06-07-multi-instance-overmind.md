# Multi-Instance DeepConsole + Standalone Overmind — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run N independent DeepConsole instances — each with its own window, sessions, and browser — that see one another through a passive standalone "Overmind" service (presence + self-organizing blackboard + peer-ask + Ghost), built on one shared LLM backend.

**Architecture:** A new standalone FastAPI service on port 9200 (the Overmind) holds live in-memory state with a JSON snapshot. It only *watches and creates space* — it never assigns work. Electron instances stop killing/owning port 8000 (they probe-then-spawn the shared backend and the Overmind), get a dynamic browser port, register an arm identity, heartbeat, and subscribe to a single SSE feed. A new "Overmind" tab surfaces the roster, blackboard, and incoming peer-asks.

**Tech Stack:** Python 3.10+ / FastAPI / uvicorn (Overmind, tested with pytest + `fastapi.testclient`), Electron / Node `http` (instance side, verified manually — the project has no JS test harness).

---

## Test strategy

- **Overmind (Python)** is the bulk of the new logic and is fully TDD'd with pytest, matching the sibling repo's setup (`../localllm-abuddi/pytest.ini`, `asyncio_mode = auto`, `TestClient`). The store layer is pure and unit-tested without HTTP; the FastAPI layer is tested with `TestClient`.
- **Instance side (main.js / preload.js / renderer)** has no existing JS test framework. Per the writing-plans guidance to follow existing patterns, we do **not** introduce one. These tasks use explicit **manual verification** steps (curl against the Overmind, launching two instances, observing the UI). Each such task still ends in a commit.
- **Time is injected**: every store method that depends on "now" takes a `now: float` (epoch seconds) argument so staleness/lease logic is deterministic in tests. The FastAPI layer passes real `time.time()`.

## File structure

```
overmind/                          ← NEW standalone service (lives in deepconsole repo)
  store.py        — OvermindStore: pure in-memory presence + blackboard + snapshot. No HTTP, no asyncio.
  app.py          — FastAPI app: REST routes, SSE broadcast hub, peer-ask correlation, Ghost hook.
  requirements.txt— fastapi, uvicorn (Overmind's declared deps).
  tests/
    __init__.py
    test_store.py — unit tests for OvermindStore (CAS claim, lease, reap, snapshot).
    test_app.py   — TestClient tests for routes + SSE + ask/reply.

main.js            — MODIFY: remove 8000-killer; probe-then-spawn backend + Overmind; dynamic browser
                     port; arm identity; Overmind register/heartbeat/SSE subscribe; Overmind IPC handlers.
preload.js         — MODIFY: expose window.deepconsole.overmind.*
renderer/index.html— MODIFY: add Overmind tab button + view markup.
renderer/app.js    — MODIFY: tab refs, switchTab case, Overmind panel wiring (roster/board/asks).
renderer/style.css — MODIFY: minimal styles for roster/board rows.

../localllm-abuddi/server.py — MODIFY: add POST /knowledge/learning (so the Ghost writes learnings
                                through the single shared backend, not by touching knowledge.json directly).
../localllm-abuddi/tests/test_server.py — MODIFY: test for the new route.
```

**Canonical names (used consistently across all tasks):**

- Store class `OvermindStore` (in `overmind/store.py`). Methods: `register_arm`, `heartbeat`, `roster`, `post_item`, `board`, `claim_item`, `release_item`, `complete_item`, `sweep`, `snapshot`, `load`.
- Arm record keys: `id, name, pid, browser_port, status, focus, last_seen`.
- Board item keys: `id, title, detail, tags, state, claimed_by, claimed_at, result, posted_by`. States: `open | claimed | done`.
- SSE event shapes: `{"type":"presence","roster":[...]}`, `{"type":"board","board":[...]}`, `{"type":"ask","ask_id","to","from","message"}`, `{"type":"ask_reply","ask_id","answer"}`, `{"type":"learning","text"}`.
- IPC channels: `overmind:roster|board|postItem|claim|release|done|ask|reply|setStatus|armId`; main→renderer push: `overmind:event`.
- Preload surface: `window.deepconsole.overmind.{roster,board,postItem,claim,release,done,ask,reply,setStatus,armId,onEvent}`.

---

## Task 0: Initialize git (commits require it)

**Files:**
- Create: `.gitignore`

The `deepconsole` directory is not yet a git repository, but every task below commits. Initialize it once.

- [ ] **Step 1: Initialize the repo**

Run:
```bash
cd C:/github/deepconsole && git init
```
Expected: `Initialized empty Git repository in C:/github/deepconsole/.git/`

- [ ] **Step 2: Create `.gitignore`**

Create `C:/github/deepconsole/.gitignore`:
```
node_modules/
__pycache__/
*.pyc
.pytest_cache/
overmind/overmind_state.json
```

- [ ] **Step 3: Initial commit**

Run:
```bash
git add .gitignore CLAUDE.md README.md package.json main.js preload.js browser-preload.js renderer docs
git commit -m "chore: initialize git repo for multi-instance work"
```
Expected: a commit is created. (Leave the loose `*.py` scratch scripts unstaged.)

---

## Task 1: Overmind store — presence roster

**Files:**
- Create: `overmind/store.py`
- Create: `overmind/tests/__init__.py` (empty)
- Test: `overmind/tests/test_store.py`

- [ ] **Step 1: Write the failing test**

Create `overmind/tests/__init__.py` as an empty file, then create `overmind/tests/test_store.py`:
```python
from overmind.store import OvermindStore


def test_register_arm_appears_in_roster():
    s = OvermindStore()
    s.register_arm("alpha", name="Alpha", pid=111, browser_port=51000, now=1000.0)
    roster = s.roster(now=1000.0)
    assert len(roster) == 1
    assert roster[0]["id"] == "alpha"
    assert roster[0]["name"] == "Alpha"
    assert roster[0]["status"] == "idle"
    assert roster[0]["last_seen"] == 1000.0


def test_heartbeat_updates_status_and_last_seen():
    s = OvermindStore()
    s.register_arm("alpha", name="Alpha", pid=111, browser_port=51000, now=1000.0)
    s.heartbeat("alpha", status="working", focus="scraping X", now=1005.0)
    arm = s.roster(now=1005.0)[0]
    assert arm["status"] == "working"
    assert arm["focus"] == "scraping X"
    assert arm["last_seen"] == 1005.0


def test_stale_arm_marked_offline():
    s = OvermindStore(presence_ttl=10.0)
    s.register_arm("alpha", name="Alpha", pid=111, browser_port=51000, now=1000.0)
    # 20s later, no heartbeat -> stale
    arm = s.roster(now=1020.0)[0]
    assert arm["status"] == "offline"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'overmind.store'`.

- [ ] **Step 3: Write minimal implementation**

Create `overmind/store.py`:
```python
"""OvermindStore: pure in-memory presence + blackboard state.

No HTTP, no asyncio — fully unit-testable. Every time-dependent method takes an
explicit `now` (epoch seconds) so staleness/lease logic is deterministic.

The store only holds state; it never assigns or directs work.
"""
from __future__ import annotations

import uuid
from typing import Optional


class OvermindStore:
    def __init__(self, presence_ttl: float = 15.0, claim_lease: float = 300.0):
        self.presence_ttl = presence_ttl
        self.claim_lease = claim_lease
        self._arms: dict[str, dict] = {}
        self._items: dict[str, dict] = {}

    # ── Presence ────────────────────────────────────────────────────────────
    def register_arm(self, arm_id: str, name: str, pid: int,
                     browser_port: int, now: float) -> dict:
        arm = self._arms.get(arm_id, {})
        arm.update({
            "id": arm_id, "name": name, "pid": pid,
            "browser_port": browser_port,
            "status": arm.get("status", "idle"),
            "focus": arm.get("focus", ""),
            "last_seen": now,
        })
        self._arms[arm_id] = arm
        return arm

    def heartbeat(self, arm_id: str, now: float,
                  status: Optional[str] = None, focus: Optional[str] = None) -> dict:
        arm = self._arms[arm_id]
        if status is not None:
            arm["status"] = status
        if focus is not None:
            arm["focus"] = focus
        arm["last_seen"] = now
        return arm

    def roster(self, now: float) -> list[dict]:
        out = []
        for arm in self._arms.values():
            view = dict(arm)
            if now - arm["last_seen"] > self.presence_ttl:
                view["status"] = "offline"
            out.append(view)
        return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_store.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add overmind/store.py overmind/tests/__init__.py overmind/tests/test_store.py
git commit -m "feat(overmind): presence roster with staleness"
```

---

## Task 2: Overmind store — blackboard with atomic claim + lease

**Files:**
- Modify: `overmind/store.py`
- Test: `overmind/tests/test_store.py`

- [ ] **Step 1: Write the failing test**

Append to `overmind/tests/test_store.py`:
```python
def test_post_and_list_item():
    s = OvermindStore()
    item = s.post_item(title="Scrape API list", detail="from rapidapi",
                        tags=["browser"], posted_by="alpha", now=1000.0)
    assert item["state"] == "open"
    assert item["claimed_by"] is None
    board = s.board()
    assert len(board) == 1
    assert board[0]["title"] == "Scrape API list"


def test_claim_is_atomic_cas():
    s = OvermindStore()
    item = s.post_item(title="t", detail="", tags=[], posted_by="alpha", now=1000.0)
    first = s.claim_item(item["id"], "alpha", now=1001.0)
    second = s.claim_item(item["id"], "bravo", now=1002.0)
    assert first is not None and first["claimed_by"] == "alpha"
    assert second is None  # already claimed -> CAS fails, returns None


def test_release_returns_item_to_open():
    s = OvermindStore()
    item = s.post_item(title="t", detail="", tags=[], posted_by="alpha", now=1000.0)
    s.claim_item(item["id"], "alpha", now=1001.0)
    released = s.release_item(item["id"])
    assert released["state"] == "open"
    assert released["claimed_by"] is None


def test_complete_sets_done_and_result():
    s = OvermindStore()
    item = s.post_item(title="t", detail="", tags=[], posted_by="alpha", now=1000.0)
    s.claim_item(item["id"], "alpha", now=1001.0)
    done = s.complete_item(item["id"], result="found 12 apis")
    assert done["state"] == "done"
    assert done["result"] == "found 12 apis"


def test_sweep_releases_expired_claim():
    s = OvermindStore(claim_lease=60.0)
    item = s.post_item(title="t", detail="", tags=[], posted_by="alpha", now=1000.0)
    s.claim_item(item["id"], "alpha", now=1000.0)
    # 120s later with no completion -> lease expired, item back to open
    s.sweep(now=1120.0)
    assert s.board()[0]["state"] == "open"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_store.py -v`
Expected: FAIL — `AttributeError: 'OvermindStore' object has no attribute 'post_item'`.

- [ ] **Step 3: Write minimal implementation**

Append these methods to the `OvermindStore` class in `overmind/store.py`:
```python
    # ── Blackboard ──────────────────────────────────────────────────────────
    def post_item(self, title: str, detail: str, tags: list[str],
                  posted_by: str, now: float) -> dict:
        item_id = uuid.uuid4().hex[:12]
        item = {
            "id": item_id, "title": title, "detail": detail,
            "tags": list(tags or []), "state": "open",
            "claimed_by": None, "claimed_at": None,
            "result": None, "posted_by": posted_by,
        }
        self._items[item_id] = item
        return item

    def board(self) -> list[dict]:
        return [dict(i) for i in self._items.values()]

    def claim_item(self, item_id: str, arm_id: str, now: float) -> Optional[dict]:
        """Atomic compare-and-set: succeeds only if the item is open."""
        item = self._items.get(item_id)
        if item is None or item["state"] != "open":
            return None
        item["state"] = "claimed"
        item["claimed_by"] = arm_id
        item["claimed_at"] = now
        return dict(item)

    def release_item(self, item_id: str) -> dict:
        item = self._items[item_id]
        item["state"] = "open"
        item["claimed_by"] = None
        item["claimed_at"] = None
        return dict(item)

    def complete_item(self, item_id: str, result: str) -> dict:
        item = self._items[item_id]
        item["state"] = "done"
        item["result"] = result
        return dict(item)

    def sweep(self, now: float) -> list[str]:
        """Release claims whose lease expired (claimer went dark). Returns released ids."""
        released = []
        for item in self._items.values():
            if item["state"] == "claimed" and item["claimed_at"] is not None:
                if now - item["claimed_at"] > self.claim_lease:
                    item["state"] = "open"
                    item["claimed_by"] = None
                    item["claimed_at"] = None
                    released.append(item["id"])
        return released
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_store.py -v`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add overmind/store.py overmind/tests/test_store.py
git commit -m "feat(overmind): blackboard with atomic claim and lease sweep"
```

---

## Task 3: Overmind store — snapshot save/load

**Files:**
- Modify: `overmind/store.py`
- Test: `overmind/tests/test_store.py`

- [ ] **Step 1: Write the failing test**

Append to `overmind/tests/test_store.py`:
```python
def test_snapshot_roundtrip():
    s = OvermindStore()
    s.register_arm("alpha", name="Alpha", pid=1, browser_port=51000, now=1000.0)
    item = s.post_item(title="t", detail="", tags=["x"], posted_by="alpha", now=1000.0)
    s.claim_item(item["id"], "alpha", now=1001.0)

    snap = s.snapshot()

    s2 = OvermindStore()
    s2.load(snap)
    # board survives; presence is intentionally NOT restored (arms must re-register)
    assert len(s2.board()) == 1
    assert s2.board()[0]["claimed_by"] == "alpha"
    assert s2.roster(now=1001.0) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_store.py::test_snapshot_roundtrip -v`
Expected: FAIL — `AttributeError: ... 'snapshot'`.

- [ ] **Step 3: Write minimal implementation**

Append to the `OvermindStore` class in `overmind/store.py`:
```python
    # ── Persistence ─────────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        # Only the board is persisted. Presence is live ephemeral state — arms
        # re-register on launch, so a restarted Overmind starts with an empty roster.
        return {"items": {k: dict(v) for k, v in self._items.items()}}

    def load(self, snap: dict) -> None:
        self._items = {k: dict(v) for k, v in (snap.get("items") or {}).items()}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_store.py -v`
Expected: PASS (9 passed).

- [ ] **Step 5: Commit**

```bash
git add overmind/store.py overmind/tests/test_store.py
git commit -m "feat(overmind): board snapshot save/load"
```

---

## Task 4: Overmind FastAPI app — REST routes

**Files:**
- Create: `overmind/app.py`
- Create: `overmind/requirements.txt`
- Test: `overmind/tests/test_app.py`

- [ ] **Step 1: Write the failing test**

Create `overmind/tests/test_app.py`:
```python
from fastapi.testclient import TestClient
from overmind.app import app, store

client = TestClient(app)


def setup_function():
    # fresh state per test
    store._arms.clear()
    store._items.clear()


def test_register_and_roster():
    r = client.post("/arms/register", json={
        "id": "alpha", "name": "Alpha", "pid": 1, "browser_port": 51000})
    assert r.status_code == 200
    roster = client.get("/arms").json()["roster"]
    assert roster[0]["id"] == "alpha"


def test_heartbeat():
    client.post("/arms/register", json={
        "id": "alpha", "name": "Alpha", "pid": 1, "browser_port": 51000})
    r = client.post("/arms/alpha/heartbeat", json={"status": "working", "focus": "x"})
    assert r.status_code == 200
    roster = client.get("/arms").json()["roster"]
    assert roster[0]["status"] == "working"


def test_post_claim_done_flow():
    client.post("/arms/register", json={
        "id": "alpha", "name": "Alpha", "pid": 1, "browser_port": 51000})
    item = client.post("/board", json={
        "title": "t", "detail": "", "tags": ["x"], "posted_by": "alpha"}).json()["item"]
    claimed = client.post(f"/board/{item['id']}/claim", json={"arm_id": "alpha"})
    assert claimed.status_code == 200 and claimed.json()["item"]["claimed_by"] == "alpha"
    # second claim fails
    again = client.post(f"/board/{item['id']}/claim", json={"arm_id": "bravo"})
    assert again.status_code == 409
    done = client.post(f"/board/{item['id']}/done", json={"result": "ok"})
    assert done.json()["item"]["state"] == "done"


def test_health():
    assert client.get("/health").json()["ok"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_app.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'overmind.app'`.

- [ ] **Step 3: Write minimal implementation**

Create `overmind/requirements.txt`:
```
fastapi
uvicorn
```

Create `overmind/app.py`:
```python
"""Overmind: standalone passive coordinator for DeepConsole instances.

It WATCHES (presence, board, asks) and CREATES SPACE (roster, blackboard,
channel). It never assigns, sequences, or prioritizes work — all initiative
lives in the instances.

Run: python -m uvicorn overmind.app:app --host 127.0.0.1 --port 9200
"""
from __future__ import annotations

import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from overmind.store import OvermindStore

app = FastAPI(title="Overmind")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

store = OvermindStore()


# ── Request models ──────────────────────────────────────────────────────────
class RegisterReq(BaseModel):
    id: str
    name: str
    pid: int = 0
    browser_port: int = 0


class HeartbeatReq(BaseModel):
    status: str | None = None
    focus: str | None = None


class PostItemReq(BaseModel):
    title: str
    detail: str = ""
    tags: list[str] = []
    posted_by: str


class ClaimReq(BaseModel):
    arm_id: str


class DoneReq(BaseModel):
    result: str = ""


# ── Presence ──────────────────────────────────────────────────────────────────
@app.post("/arms/register")
def register(req: RegisterReq):
    arm = store.register_arm(req.id, name=req.name, pid=req.pid,
                             browser_port=req.browser_port, now=time.time())
    return {"arm": arm}


@app.post("/arms/{arm_id}/heartbeat")
def heartbeat(arm_id: str, req: HeartbeatReq):
    store.sweep(now=time.time())
    arm = store.heartbeat(arm_id, now=time.time(), status=req.status, focus=req.focus)
    return {"arm": arm}


@app.get("/arms")
def arms():
    return {"roster": store.roster(now=time.time())}


# ── Blackboard ────────────────────────────────────────────────────────────────
@app.post("/board")
def post_item(req: PostItemReq):
    item = store.post_item(title=req.title, detail=req.detail, tags=req.tags,
                           posted_by=req.posted_by, now=time.time())
    return {"item": item}


@app.get("/board")
def board():
    return {"board": store.board()}


@app.post("/board/{item_id}/claim")
def claim(item_id: str, req: ClaimReq):
    item = store.claim_item(item_id, req.arm_id, now=time.time())
    if item is None:
        return JSONResponse(status_code=409, content={"error": "not open"})
    return {"item": item}


@app.post("/board/{item_id}/release")
def release(item_id: str):
    return {"item": store.release_item(item_id)}


@app.post("/board/{item_id}/done")
def done(item_id: str, req: DoneReq):
    return {"item": store.complete_item(item_id, result=req.result)}


@app.get("/health")
def health():
    return {"ok": True}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_app.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add overmind/app.py overmind/requirements.txt overmind/tests/test_app.py
git commit -m "feat(overmind): FastAPI REST routes for presence and board"
```

---

## Task 5: Overmind — SSE broadcast hub + events on every mutation

**Files:**
- Modify: `overmind/app.py`
- Test: `overmind/tests/test_app.py`

This is the "no polling" fix: a single `GET /stream` that fans every state change out to all connected instances.

- [ ] **Step 1: Write the failing test**

Append to `overmind/tests/test_app.py`:
```python
def test_stream_receives_presence_event_on_register():
    # TestClient.stream yields raw SSE bytes; read the first event after a register.
    with client.stream("GET", "/stream") as resp:
        assert resp.status_code == 200
        # Trigger a mutation from a second client call.
        client.post("/arms/register", json={
            "id": "alpha", "name": "Alpha", "pid": 1, "browser_port": 51000})
        chunk = next(resp.iter_lines())
        # first line of an SSE frame is "data: {json}"
        assert chunk.startswith("data:")
        assert "\"type\": \"presence\"" in chunk or "presence" in chunk
```

> Note: if `TestClient.stream` buffering makes this flaky in your environment, assert instead on a unit-level `hub.publish`/`hub.subscribe` pair extracted into a small `Hub` class. The intent is: a register triggers a `presence` broadcast.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_app.py::test_stream_receives_presence_event_on_register -v`
Expected: FAIL — 404 on `/stream`.

- [ ] **Step 3: Write minimal implementation**

In `overmind/app.py`, add the imports and a broadcast hub near the top (after `store = OvermindStore()`):
```python
import asyncio
import json

from fastapi.responses import StreamingResponse


class Hub:
    """Fan-out of state-change events to all connected SSE subscribers."""
    def __init__(self):
        self._subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def publish(self, event: dict) -> None:
        for q in list(self._subs):
            q.put_nowait(event)


hub = Hub()


def _broadcast_presence():
    hub.publish({"type": "presence", "roster": store.roster(now=time.time())})


def _broadcast_board():
    hub.publish({"type": "board", "board": store.board()})
```

Then call the broadcasters at the end of each mutating route (before `return`). For example in `register`:
```python
@app.post("/arms/register")
def register(req: RegisterReq):
    arm = store.register_arm(req.id, name=req.name, pid=req.pid,
                             browser_port=req.browser_port, now=time.time())
    _broadcast_presence()
    return {"arm": arm}
```
Add `_broadcast_presence()` to `heartbeat`, and `_broadcast_board()` to `post_item`, `claim` (only on success), `release`, and `done`.

Finally add the stream route:
```python
@app.get("/stream")
async def stream():
    q = hub.subscribe()

    async def gen():
        try:
            # send an initial snapshot so a fresh subscriber is immediately in sync
            yield f"data: {json.dumps({'type': 'presence', 'roster': store.roster(now=time.time())})}\n\n"
            yield f"data: {json.dumps({'type': 'board', 'board': store.board()})}\n\n"
            while True:
                event = await q.get()
                yield f"data: {json.dumps(event)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            hub.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_app.py -v`
Expected: PASS. (If the streaming test is flaky per the note in Step 1, refactor to the `Hub` unit test and keep it green.)

- [ ] **Step 5: Commit**

```bash
git add overmind/app.py overmind/tests/test_app.py
git commit -m "feat(overmind): SSE broadcast hub with live presence/board events"
```

---

## Task 6: Overmind — peer-ask routing with reply correlation

**Files:**
- Modify: `overmind/app.py`
- Test: `overmind/tests/test_app.py`

`POST /arms/{id}/ask` pushes an `ask` event to the target over SSE and waits (with timeout) for a matching `POST /asks/{ask_id}/reply`.

- [ ] **Step 1: Write the failing test**

Append to `overmind/tests/test_app.py`:
```python
def test_ask_creates_pending_and_reply_resolves(monkeypatch):
    # Unit-level: posting an ask registers a pending future keyed by ask_id;
    # replying resolves it. (Full async round-trip is exercised manually.)
    from overmind import app as appmod
    appmod._pending.clear()
    ask_id = appmod._register_ask("bravo", "alpha", "what's the API count?")
    assert ask_id in appmod._pending
    appmod._resolve_ask(ask_id, "12")
    assert appmod._pending[ask_id]["answer"] == "12"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_app.py::test_ask_creates_pending_and_reply_resolves -v`
Expected: FAIL — `AttributeError: module 'overmind.app' has no attribute '_register_ask'`.

- [ ] **Step 3: Write minimal implementation**

In `overmind/app.py` add (after `hub = Hub()`):
```python
import uuid

# pending peer-asks: ask_id -> {"answer": str|None, "event": asyncio.Event|None}
_pending: dict[str, dict] = {}


def _register_ask(to_arm: str, from_arm: str, message: str) -> str:
    ask_id = uuid.uuid4().hex[:12]
    _pending[ask_id] = {"answer": None, "to": to_arm, "from": from_arm}
    hub.publish({"type": "ask", "ask_id": ask_id, "to": to_arm,
                 "from": from_arm, "message": message})
    return ask_id


def _resolve_ask(ask_id: str, answer: str) -> None:
    if ask_id in _pending:
        _pending[ask_id]["answer"] = answer
        ev = _pending[ask_id].get("event")
        if ev is not None:
            ev.set()


class AskReq(BaseModel):
    from_arm: str
    message: str


class ReplyReq(BaseModel):
    answer: str
```

Add the two routes:
```python
@app.post("/arms/{arm_id}/ask")
async def ask(arm_id: str, req: AskReq):
    ask_id = _register_ask(arm_id, req.from_arm, req.message)
    ev = asyncio.Event()
    _pending[ask_id]["event"] = ev
    try:
        await asyncio.wait_for(ev.wait(), timeout=120.0)
        return {"ask_id": ask_id, "answer": _pending[ask_id]["answer"]}
    except asyncio.TimeoutError:
        return JSONResponse(status_code=504, content={"error": "ask timed out"})
    finally:
        _pending.pop(ask_id, None)


@app.post("/asks/{ask_id}/reply")
def reply(ask_id: str, req: ReplyReq):
    _resolve_ask(ask_id, req.answer)
    hub.publish({"type": "ask_reply", "ask_id": ask_id, "answer": req.answer})
    return {"ok": True}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_app.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add overmind/app.py overmind/tests/test_app.py
git commit -m "feat(overmind): peer-ask routing with reply correlation"
```

---

## Task 7: Ghost — learning on done + shared-backend write route

**Files:**
- Modify: `overmind/app.py`
- Modify: `../localllm-abuddi/server.py`
- Test: `overmind/tests/test_app.py`, `../localllm-abuddi/tests/test_server.py`

The Ghost is **passive**: when a board item reaches `done`, it distills a one-line learning, broadcasts it, and writes it into the shared Knowledge Base **through the single backend** (avoiding the multi-writer risk of touching `knowledge.json` directly). First add the backend route, then the Ghost hook.

- [ ] **Step 1: Write the failing test (backend route)**

Append to `../localllm-abuddi/tests/test_server.py`:
```python
def test_record_learning_route():
    response = client.post("/knowledge/learning", json={"text": "apis live at X"})
    assert response.status_code == 200
    assert response.json()["ok"] is True
```

- [ ] **Step 2: Run it — fails**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_server.py::test_record_learning_route -v`
Expected: FAIL — 404 (route not defined).

- [ ] **Step 3: Add the backend route**

In `../localllm-abuddi/server.py`, near the other `@app.post` routes, add:
```python
class LearningReq(BaseModel):
    text: str


@app.post("/knowledge/learning")
def post_learning(req: LearningReq):
    import knowledge
    knowledge.record_learning(req.text)
    return {"ok": True}
```
(If `BaseModel` is not already imported in `server.py`, add `from pydantic import BaseModel` at the top with the other imports.)

- [ ] **Step 4: Run it — passes**

Run: `cd C:/github/localllm-abuddi && python -m pytest tests/test_server.py::test_record_learning_route -v`
Expected: PASS.

- [ ] **Step 5: Write the failing test (Ghost hook)**

Append to `overmind/tests/test_app.py`:
```python
def test_done_broadcasts_learning_event(monkeypatch):
    from overmind import app as appmod
    sent = []
    monkeypatch.setattr(appmod, "_ghost_record", lambda text: sent.append(text))
    client.post("/arms/register", json={
        "id": "alpha", "name": "Alpha", "pid": 1, "browser_port": 51000})
    item = client.post("/board", json={
        "title": "Scrape", "detail": "", "tags": [], "posted_by": "alpha"}).json()["item"]
    client.post(f"/board/{item['id']}/claim", json={"arm_id": "alpha"})
    client.post(f"/board/{item['id']}/done", json={"result": "found 12 apis"})
    assert len(sent) == 1
    assert "Scrape" in sent[0] and "found 12 apis" in sent[0]
```

- [ ] **Step 6: Run it — fails**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/test_app.py::test_done_broadcasts_learning_event -v`
Expected: FAIL — `_ghost_record` does not exist / not called.

- [ ] **Step 7: Implement the Ghost hook**

In `overmind/app.py` add:
```python
import urllib.request

BACKEND_URL = "http://127.0.0.1:8000"


def _ghost_record(text: str) -> None:
    """Write a distilled learning into the shared Knowledge Base via the backend.
    Best-effort: if the backend is unreachable, drop it (presence/board are the
    source of truth; learnings are a bonus)."""
    try:
        data = json.dumps({"text": text}).encode()
        req = urllib.request.Request(
            f"{BACKEND_URL}/knowledge/learning", data=data,
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass
```

Then update the `done` route to invoke the Ghost and broadcast a `learning` event:
```python
@app.post("/board/{item_id}/done")
def done(item_id: str, req: DoneReq):
    item = store.complete_item(item_id, result=req.result)
    _broadcast_board()
    learning = f"Done: {item['title']} — {req.result}"
    _ghost_record(learning)
    hub.publish({"type": "learning", "text": learning})
    return {"item": item}
```
(Remove the now-duplicated `_broadcast_board()` you added to `done` in Task 5 — it should appear once.)

- [ ] **Step 8: Run all Overmind tests — pass**

Run: `cd C:/github/deepconsole && python -m pytest overmind/tests/ -v`
Expected: PASS (all).

- [ ] **Step 9: Commit**

```bash
cd C:/github/localllm-abuddi && git add server.py tests/test_server.py && git commit -m "feat(backend): POST /knowledge/learning for Overmind Ghost"
cd C:/github/deepconsole && git add overmind/app.py overmind/tests/test_app.py && git commit -m "feat(overmind): Ghost records learnings via shared backend on done"
```

---

## Task 8: main.js — probe-then-spawn shared services (remove the 8000-killer)

**Files:**
- Modify: `main.js:22-93` (replace `freeLlmPort` + `startLLMServer`), `main.js:808-814` (lifecycle)

Two instances must coexist: the first spawns the shared backend (8000) and the Overmind (9200); the rest attach. **Verification is manual** (no JS test harness).

- [ ] **Step 1: Replace the killer with a probe-then-spawn helper**

In `main.js`, delete the entire `freeLlmPort()` function (lines ~22–54). Replace `startLLMServer()`'s body so it no longer calls `freeLlmPort()`, and add a generic probe helper + an Overmind spawner. Insert near the top (after `const LLM_PORT = 8000;`):
```js
const OVERMIND_PORT = 9200;
let overmindProcess = null;

// Resolve true if something already answers /health on `port`, else false.
function isServiceUp(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

// Spawn `spawnFn` only if no service is already listening on `port`.
async function ensureSharedService(name, port, spawnFn) {
  if (await isServiceUp(port)) {
    log(`[${name}] Already up on ${port} — attaching.`);
    return null;
  }
  log(`[${name}] Not found on ${port} — spawning.`);
  return spawnFn();
}
```

- [ ] **Step 2: Update `startLLMServer` to not kill the port**

In `startLLMServer()`, delete the line `freeLlmPort();` and its comment. Leave the rest of the spawn logic. (A second instance that loses the bind race will see uvicorn fail with Errno 10048; that's acceptable — the first instance owns 8000, and this instance still reaches it over HTTP.)

- [ ] **Step 3: Add an Overmind spawner**

Add near `startLLMServer`:
```js
function startOvermind() {
  const overmindCwd = __dirname; // overmind package lives in this repo
  overmindProcess = require('child_process').spawn(
    'python', ['-m', 'uvicorn', 'overmind.app:app', '--host', '127.0.0.1', '--port', String(OVERMIND_PORT)],
    { cwd: overmindCwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: true }
  );
  overmindProcess.stdout.on('data', (d) => { const t = d.toString().trim(); if (t) log(`[Overmind] ${t}`); });
  overmindProcess.stderr.on('data', (d) => { const t = d.toString().trim(); if (t) log(`[Overmind] ${t}`); });
  overmindProcess.on('close', (code) => { log(`[Overmind] exited ${code}`); overmindProcess = null; });
  overmindProcess.on('error', (err) => { log(`[Overmind] failed: ${err.message}`); overmindProcess = null; });
}
```

- [ ] **Step 4: Wire into lifecycle**

In `app.whenReady().then(() => { ... })` (around line 810), replace `startLLMServer();` with:
```js
  ensureSharedService('LLM', LLM_PORT, startLLMServer);
  ensureSharedService('Overmind', OVERMIND_PORT, startOvermind);
```
Leave `startBrowserApiServer();` and `createMainWindow();` as-is for now (browser port handled in Task 9).

Also update `stopLLMServer()`/`before-quit` so an instance only tears down services **it** spawned: guard `stopLLMServer` with `if (llmProcess)` (already present) and add a `stopOvermind()` that checks `if (overmindProcess)`. Call `stopOvermind()` from the `window-all-closed` and `before-quit` handlers alongside `stopLLMServer()`.
```js
function stopOvermind() {
  if (overmindProcess) { overmindProcess.kill('SIGTERM'); overmindProcess = null; }
}
```

- [ ] **Step 5: Manual verification**

Run (terminal 1): `cd C:/github/deepconsole && npm start`
Then (terminal 2): `cd C:/github/deepconsole && npm start`
Verify:
```bash
curl -s http://127.0.0.1:8000/health   # {"status":"ok"...} or similar
curl -s http://127.0.0.1:9200/health   # {"ok":true}
```
Expected: both instances open; only ONE python uvicorn for 8000 and one for 9200 (check `~/deepconsole.log` for "Already up ... attaching" in the second instance). Closing the second instance must NOT kill 8000/9200; closing the owner does.

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(instance): probe-then-spawn shared backend + Overmind; stop killing 8000"
```

---

## Task 9: main.js — dynamic browser API port

**Files:**
- Modify: `main.js:106` (const), `main.js:191-264` (`startBrowserApiServer`)

- [ ] **Step 1: Make the port dynamic**

In `main.js`, change `const BROWSER_API_PORT = 9100;` to `let browserApiPort = 0; // OS-assigned at listen time`.

In `startBrowserApiServer()`, change the listen call to bind port 0 and capture the assigned port:
```js
  srv.listen(0, '127.0.0.1', () => {
    browserApiPort = srv.address().port;
    log(`[DeepConsole] Browser API server listening on port ${browserApiPort}`);
  });
```
Replace any remaining reference to `BROWSER_API_PORT` in the file with `browserApiPort`.

- [ ] **Step 2: Manual verification**

Run two instances (`npm start` twice). In `~/deepconsole.log`, confirm each logs a **different** "Browser API server listening on port NNNNN" (two distinct ephemeral ports, neither 9100-fixed-collision).

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(instance): dynamic browser API port so instances don't collide"
```

---

## Task 10: main.js — arm identity + Overmind register/heartbeat/SSE subscribe

**Files:**
- Modify: `main.js` (add identity + Overmind client block; wire into lifecycle)

- [ ] **Step 1: Add identity persistence + Overmind client**

Add a new section in `main.js` (after the `httpRequest` helper, ~line 340):
```js
// ─── Overmind client (this instance's link to the coordinator) ──────────────
const crypto = require('crypto');
let armIdentity = null; // { id, name }

function loadArmIdentity() {
  const file = path.join(app.getPath('userData'), 'arm.json');
  try {
    armIdentity = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_) {
    const id = crypto.randomUUID();
    armIdentity = { id, name: `arm-${id.slice(0, 4)}` };
    try { fs.writeFileSync(file, JSON.stringify(armIdentity)); } catch (e) { log(`[Overmind] could not persist identity: ${e.message}`); }
  }
  return armIdentity;
}

function overmindRequest(method, p, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: OVERMIND_PORT, path: p, method,
        headers: { 'Content-Type': 'application/json' } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    if (body) { const s = JSON.stringify(body); req.setHeader('Content-Length', Buffer.byteLength(s)); req.write(s); }
    req.end();
  });
}

let overmindHeartbeatTimer = null;
let overmindStatus = 'idle';
let overmindFocus = '';

async function overmindRegisterAndHeartbeat() {
  loadArmIdentity();
  try {
    await overmindRequest('POST', '/arms/register', {
      id: armIdentity.id, name: armIdentity.name, pid: process.pid, browser_port: browserApiPort });
  } catch (e) { log(`[Overmind] register failed: ${e.message}`); }
  overmindHeartbeatTimer = setInterval(() => {
    overmindRequest('POST', `/arms/${armIdentity.id}/heartbeat`,
      { status: overmindStatus, focus: overmindFocus }).catch(() => {});
  }, 5000);
}

// Subscribe to the single SSE feed and forward every event to the renderer.
function overmindSubscribe() {
  const req = http.get(`http://127.0.0.1:${OVERMIND_PORT}/stream`, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (mainWindowWebContents && !mainWindowWebContents.isDestroyed()) {
            mainWindowWebContents.send('overmind:event', event);
          }
        } catch (_) {}
      }
    });
    res.on('end', () => setTimeout(overmindSubscribe, 2000));   // reconnect
  });
  req.on('error', () => setTimeout(overmindSubscribe, 2000));   // retry until Overmind is up
}
```

- [ ] **Step 2: Wire into lifecycle**

In `app.whenReady()`, after `createMainWindow();` and after the browser API server is listening, start the Overmind link. Since registration needs `browserApiPort`, start it on a short delay alongside the existing `pingServer`:
```js
  setTimeout(() => {
    overmindRegisterAndHeartbeat();
    overmindSubscribe();
  }, 2500);
```
In `window-all-closed`/`before-quit`, clear the timer: `if (overmindHeartbeatTimer) clearInterval(overmindHeartbeatTimer);`

- [ ] **Step 3: Manual verification**

Run two instances. Then:
```bash
curl -s http://127.0.0.1:9200/arms
```
Expected: a roster with **two** arms, distinct `id`/`name`, each with a `browser_port`, `status:"idle"`. Wait 20s without interacting; a closed instance's arm flips to `offline` in the roster.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(instance): arm identity, Overmind register/heartbeat, SSE subscribe"
```

---

## Task 11: main.js — Overmind IPC handlers

**Files:**
- Modify: `main.js` (IPC handlers section, near the other `ipcMain.handle` blocks)

- [ ] **Step 1: Add handlers**

Add to the IPC section of `main.js`:
```js
// ─── Overmind IPC ───────────────────────────────────────────────────────────
ipcMain.handle('overmind:armId', async () => armIdentity || loadArmIdentity());
ipcMain.handle('overmind:roster', async () => overmindRequest('GET', '/arms'));
ipcMain.handle('overmind:board', async () => overmindRequest('GET', '/board'));
ipcMain.handle('overmind:postItem', async (_e, { title, detail, tags }) =>
  overmindRequest('POST', '/board', { title, detail, tags: tags || [], posted_by: armIdentity.id }));
ipcMain.handle('overmind:claim', async (_e, { itemId }) =>
  overmindRequest('POST', `/board/${itemId}/claim`, { arm_id: armIdentity.id }));
ipcMain.handle('overmind:release', async (_e, { itemId }) =>
  overmindRequest('POST', `/board/${itemId}/release`, {}));
ipcMain.handle('overmind:done', async (_e, { itemId, result }) =>
  overmindRequest('POST', `/board/${itemId}/done`, { result: result || '' }));
ipcMain.handle('overmind:ask', async (_e, { toArmId, message }) =>
  overmindRequest('POST', `/arms/${toArmId}/ask`, { from_arm: armIdentity.id, message }));
ipcMain.handle('overmind:reply', async (_e, { askId, answer }) =>
  overmindRequest('POST', `/asks/${askId}/reply`, { answer }));
ipcMain.handle('overmind:setStatus', async (_e, { status, focus }) => {
  if (status !== undefined) overmindStatus = status;
  if (focus !== undefined) overmindFocus = focus;
  return overmindRequest('POST', `/arms/${armIdentity.id}/heartbeat`, { status: overmindStatus, focus: overmindFocus });
});
```

- [ ] **Step 2: Manual verification**

(Deferred to Task 13, where the UI exercises these handlers end-to-end.)

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(instance): Overmind IPC handlers (roster/board/claim/ask/...)"
```

---

## Task 12: preload.js — expose `window.deepconsole.overmind`

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Add the bridge**

In `preload.js`, add a new key inside the `exposeInMainWorld('deepconsole', { ... })` object (after the `memory` block, following the existing pattern):
```js
  // ─── Overmind (cross-instance awareness) ─────────────────────────────
  overmind: {
    armId: () => ipcRenderer.invoke('overmind:armId'),
    roster: () => ipcRenderer.invoke('overmind:roster'),
    board: () => ipcRenderer.invoke('overmind:board'),
    postItem: (item) => ipcRenderer.invoke('overmind:postItem', item),
    claim: (itemId) => ipcRenderer.invoke('overmind:claim', { itemId }),
    release: (itemId) => ipcRenderer.invoke('overmind:release', { itemId }),
    done: (itemId, result) => ipcRenderer.invoke('overmind:done', { itemId, result }),
    ask: (toArmId, message) => ipcRenderer.invoke('overmind:ask', { toArmId, message }),
    reply: (askId, answer) => ipcRenderer.invoke('overmind:reply', { askId, answer }),
    setStatus: (status, focus) => ipcRenderer.invoke('overmind:setStatus', { status, focus }),
    onEvent: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('overmind:event', handler);
      return () => ipcRenderer.removeListener('overmind:event', handler);
    },
  },
```

- [ ] **Step 2: Manual verification**

(Exercised in Task 13.)

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(instance): expose window.deepconsole.overmind bridge"
```

---

## Task 13: renderer — the Overmind tab (roster + blackboard + asks)

**Files:**
- Modify: `renderer/index.html:102-108` (tab buttons) and add a new view after the Memory view
- Modify: `renderer/app.js:62-71` (element refs), `:618-639` (switchTab + listeners), and add panel logic
- Modify: `renderer/style.css` (append minimal styles)

- [ ] **Step 1: Add the tab button + view markup**

In `renderer/index.html`, add a tab button after the Memory tab (line 107):
```html
        <button id="overmind-tab" class="tab">Overmind</button>
```
Then add a new view block after the Memory view (find `id="memory-view"` and add after its closing `</div>`):
```html
      <!-- Overmind View -->
      <div id="overmind-view" class="browser-view">
        <div class="overmind-toolbar">
          <span class="console-title">Overmind</span>
          <span id="overmind-self" class="overmind-self"></span>
        </div>
        <div class="overmind-section">
          <h4>Arms</h4>
          <div id="overmind-roster" class="overmind-roster"></div>
        </div>
        <div class="overmind-section">
          <h4>Blackboard</h4>
          <div class="overmind-post">
            <input id="overmind-item-title" placeholder="Post work to the board..." />
            <button id="overmind-post-btn" class="btn btn-primary btn-sm">Post</button>
          </div>
          <div id="overmind-board" class="overmind-board"></div>
        </div>
        <div class="overmind-section">
          <h4>Incoming asks</h4>
          <div id="overmind-asks" class="overmind-asks"></div>
        </div>
      </div>
```

- [ ] **Step 2: Add element refs + tab wiring in app.js**

In `renderer/app.js`, after the existing tab refs (line 66/71), add:
```js
const tabOvermind = document.getElementById('overmind-tab');
const viewOvermind = document.getElementById('overmind-view');
```
Update `switchTab()` (line 618): add `tabOvermind` to the `tabs` array and `viewOvermind` to the `views` array, and add a branch:
```js
  else if (tab === "overmind") { tabOvermind.classList.add("active"); viewOvermind.classList.add("active"); refreshOvermind(); }
```
Add a listener after the Memory listener (line 639):
```js
tabOvermind.addEventListener('click', () => switchTab('overmind'));
```

- [ ] **Step 3: Add the Overmind panel logic in app.js**

Append to `renderer/app.js`:
```js
// ─── Overmind panel ──────────────────────────────────────────────────────────
const overmindRoster = document.getElementById('overmind-roster');
const overmindBoard = document.getElementById('overmind-board');
const overmindAsks = document.getElementById('overmind-asks');
const overmindSelf = document.getElementById('overmind-self');
let myArmId = null;

async function refreshOvermind() {
  if (!myArmId) {
    const me = await window.deepconsole.overmind.armId();
    myArmId = me.id; overmindSelf.textContent = `you are ${me.name}`;
  }
  const { roster } = await window.deepconsole.overmind.roster();
  renderRoster(roster || []);
  const { board } = await window.deepconsole.overmind.board();
  renderBoard(board || []);
}

function renderRoster(roster) {
  overmindRoster.innerHTML = '';
  roster.forEach((arm) => {
    const row = document.createElement('div');
    row.className = 'overmind-arm';
    const dot = arm.status === 'offline' ? '⚫' : (arm.status === 'working' ? '🟢' : '🟡');
    const askBtn = arm.id === myArmId ? '' : `<button data-ask="${arm.id}" class="btn btn-secondary btn-sm">Ask</button>`;
    row.innerHTML = `<span>${dot} <strong>${arm.name}</strong> — ${arm.status}${arm.focus ? ' · ' + arm.focus : ''}</span>${askBtn}`;
    overmindRoster.appendChild(row);
  });
  overmindRoster.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', async () => {
    const msg = prompt(`Ask ${b.getAttribute('data-ask')}:`);
    if (msg) { const r = await window.deepconsole.overmind.ask(b.getAttribute('data-ask'), msg); alert(`Answer: ${r.answer ?? r.error ?? '(no reply)'}`); }
  }));
}

function renderBoard(board) {
  overmindBoard.innerHTML = '';
  board.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'overmind-item';
    let action = '';
    if (item.state === 'open') action = `<button data-claim="${item.id}" class="btn btn-primary btn-sm">Claim</button>`;
    else if (item.state === 'claimed' && item.claimed_by === myArmId) action = `<button data-done="${item.id}" class="btn btn-primary btn-sm">Done</button> <button data-release="${item.id}" class="btn btn-secondary btn-sm">Release</button>`;
    else if (item.state === 'claimed') action = `<em>claimed by ${item.claimed_by}</em>`;
    else action = `<em>✓ ${item.result || 'done'}</em>`;
    row.innerHTML = `<span>${item.title}</span> ${action}`;
    overmindBoard.appendChild(row);
  });
  overmindBoard.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', () => window.deepconsole.overmind.claim(b.getAttribute('data-claim'))));
  overmindBoard.querySelectorAll('[data-release]').forEach((b) => b.addEventListener('click', () => window.deepconsole.overmind.release(b.getAttribute('data-release'))));
  overmindBoard.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => { const r = prompt('Result?') || 'done'; window.deepconsole.overmind.done(b.getAttribute('data-done'), r); }));
}

document.getElementById('overmind-post-btn').addEventListener('click', async () => {
  const input = document.getElementById('overmind-item-title');
  const title = input.value.trim();
  if (!title) return;
  await window.deepconsole.overmind.postItem({ title, detail: '', tags: [] });
  input.value = '';
});

function addIncomingAsk(ev) {
  const row = document.createElement('div');
  row.className = 'overmind-ask';
  row.innerHTML = `<span><strong>${ev.from}</strong> asks: ${ev.message}</span> <button class="btn btn-primary btn-sm">Reply</button>`;
  row.querySelector('button').addEventListener('click', async () => {
    const answer = prompt('Your reply:'); if (answer == null) return;
    await window.deepconsole.overmind.reply(ev.ask_id, answer); row.remove();
  });
  overmindAsks.appendChild(row);
}

// Live updates — the single SSE feed drives every panel. No polling.
window.deepconsole.overmind.onEvent((ev) => {
  if (ev.type === 'presence') renderRoster(ev.roster);
  else if (ev.type === 'board') renderBoard(ev.board);
  else if (ev.type === 'ask' && ev.to === myArmId) addIncomingAsk(ev);
});
```

- [ ] **Step 4: Add minimal styles**

Append to `renderer/style.css`:
```css
.overmind-toolbar { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; }
.overmind-self { opacity:.7; font-size:12px; }
.overmind-section { padding:8px 12px; }
.overmind-section h4 { margin:6px 0; opacity:.8; }
.overmind-arm, .overmind-item, .overmind-ask { display:flex; justify-content:space-between; align-items:center; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); gap:8px; }
.overmind-post { display:flex; gap:6px; margin-bottom:6px; }
.overmind-post input { flex:1; }
```

- [ ] **Step 5: Manual verification (the end-to-end proof)**

Run two instances (`npm start` twice). In **both**, open the Overmind tab. Verify:
1. **Presence:** each shows two arms; closing one flips the other's view of it to ⚫ offline within ~20s.
2. **Blackboard / self-organizing claim:** in instance A, post "Scrape API list". It appears live in **both** (no refresh). Click **Claim** in A → in B the item instantly shows "claimed by <A>" and B has no Claim button (the CAS won by A). Click **Done** in A with a result → both show ✓ result live.
3. **Peer-ask:** in A, click **Ask** on B's row, type a question. In B, an incoming ask appears under "Incoming asks"; click **Reply**, type an answer → A's alert shows the answer.
4. **Ghost:** after a Done, confirm the backend recorded it: `curl -s http://127.0.0.1:8000/health` is up, and the learning is appended to `../localllm-abuddi/knowledge.json` (grep for the item title).

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/app.js renderer/style.css
git commit -m "feat(instance): Overmind tab — live roster, blackboard, peer-asks"
```

---

## Task 14: Update CLAUDE.md docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the new topology**

Add a section to `CLAUDE.md` under "Key ports" noting: port 9200 = Overmind (standalone coordinator); instances now probe-then-spawn the shared backend + Overmind instead of killing 8000; the browser API port is now dynamic; and the Overmind is passive (watches + creates space, never assigns). Point to `docs/superpowers/specs/2026-06-07-multi-instance-overmind-design.md`.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document multi-instance topology and Overmind"
```

---

## Self-review notes (resolved)

- **Spec coverage:** presence (T1/T4), self-organizing blackboard + atomic claim + lease (T2/T4/T5), peer-ask (T6), Ghost via shared backend (T7), no-polling SSE (T5/T10/T13), shared backend probe-then-spawn (T8), dynamic browser port (T9), arm identity (T10), Overmind tab (T13), "watches and creates space" principle encoded in `app.py` docstring + done-route comment (T5/T7). Backend model "shared, namespaced" needs no code change — sessions already namespace by id and `meta`/`agent` memory is already shared; documented in T14.
- **Type consistency:** store method names, board item keys, SSE event shapes, IPC channel names, and preload methods are fixed in the "Canonical names" block and used identically throughout.
- **Known scoping decision:** session-memory isolation is inherited from the existing backend (per-session namespaces) and needs no new work; the plan does not re-implement it.
