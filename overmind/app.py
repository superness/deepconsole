"""Overmind: standalone passive coordinator for DeepConsole instances.

It WATCHES (presence, board, asks) and CREATES SPACE (roster, blackboard,
channel). It never assigns, sequences, or prioritizes work — all initiative
lives in the instances.

Run: python -m uvicorn overmind.app:app --host 127.0.0.1 --port 9200
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.request
import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from overmind.store import OvermindStore

app = FastAPI(title="Overmind")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# Claim lease must outlast a real job: autonomous arms run multi-minute code
# tasks in chat, and an expired lease silently reopens an in-progress item
# (double-work with >1 arm). Default 1h; override via OVERMIND_CLAIM_LEASE.
store = OvermindStore(claim_lease=float(os.environ.get("OVERMIND_CLAIM_LEASE", "3600")))

# Persist the blackboard so a crash/restart doesn't lose the DAG. Presence is
# ephemeral (arms re-register on launch); only board items are saved. Atomic write.
DATA_PATH = os.environ.get(
    "OVERMIND_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "board.json"))


def _persist() -> None:
    try:
        tmp = DATA_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(store.snapshot(), f)
        os.replace(tmp, DATA_PATH)
    except Exception:
        pass


def _load() -> None:
    try:
        with open(DATA_PATH) as f:
            store.load(json.load(f))
    except FileNotFoundError:
        pass
    except Exception:
        pass


_load()  # restore the board on boot — survive a crash


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


# pending peer-asks: ask_id -> {"answer": str|None, "to": str, "from": str, "event": asyncio.Event|None}
_pending: dict[str, dict] = {}


def _register_ask(to_arm: str, from_arm: str, message: str, event=None) -> str:
    ask_id = uuid.uuid4().hex[:12]
    _pending[ask_id] = {"answer": None, "to": to_arm, "from": from_arm, "event": event}
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


# -- Request models --
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
    depends_on: list[str] = []


class ClaimReq(BaseModel):
    arm_id: str


class DoneReq(BaseModel):
    result: str = ""
    arm_id: str = ""


# -- Presence --
@app.post("/arms/register")
def register(req: RegisterReq):
    arm = store.register_arm(req.id, name=req.name, pid=req.pid,
                             browser_port=req.browser_port, now=time.time())
    _broadcast_presence()
    return {"arm": arm}


@app.post("/arms/{arm_id}/heartbeat")
def heartbeat(arm_id: str, req: HeartbeatReq):
    now = time.time()
    if store.sweep(now=now):          # lease-expiry may reopen items -> persist
        _persist()
    try:
        arm = store.heartbeat(arm_id, now=now, status=req.status, focus=req.focus)
    except KeyError:
        return JSONResponse(status_code=404, content={"error": f"unknown arm {arm_id}"})
    _broadcast_presence()
    return {"arm": arm}


@app.get("/arms")
def arms():
    return {"roster": store.roster(now=time.time())}


# -- Blackboard --
@app.post("/board")
def post_item(req: PostItemReq):
    try:
        item = store.post_item(title=req.title, detail=req.detail, tags=req.tags,
                               posted_by=req.posted_by, now=time.time(),
                               depends_on=req.depends_on)
    except KeyError as e:
        return JSONResponse(status_code=400, content={"error": str(e).strip("'\"")})
    _persist()
    _broadcast_board()
    return {"item": item}


@app.get("/board")
def board():
    return {"board": store.board()}


@app.post("/board/{item_id}/claim")
def claim(item_id: str, req: ClaimReq):
    # Operator-only lanes: arms cannot claim lanes tagged 'operator' or 'checkpoint'
    # (Stripe dashboard, merging PRs, re-validation). Only arm_id == "operator" may.
    target = next((it for it in store.board() if it.get("id") == item_id), None)
    if target is not None and req.arm_id != "operator":
        tags = target.get("tags") or []
        if "operator" in tags or "checkpoint" in tags:
            return JSONResponse(status_code=403,
                                content={"error": "operator-only lane; arms cannot claim it"})
    item = store.claim_item(item_id, req.arm_id, now=time.time())
    if item is None:
        return JSONResponse(status_code=409, content={"error": "not open"})
    _persist()
    _broadcast_board()
    return {"item": item}


@app.post("/board/{item_id}/release")
def release(item_id: str):
    try:
        item = store.release_item(item_id)
    except KeyError:
        return JSONResponse(status_code=404, content={"error": f"unknown item {item_id}"})
    _persist()
    _broadcast_board()
    return {"item": item}


@app.post("/board/{item_id}/done")
def done(item_id: str, req: DoneReq):
    # Operator-only lanes can only be COMPLETED by the operator, not by arms.
    target = next((it for it in store.board() if it.get("id") == item_id), None)
    if target is not None and req.arm_id != "operator":
        tags = target.get("tags") or []
        if "operator" in tags or "checkpoint" in tags:
            return JSONResponse(status_code=403,
                                content={"error": "operator-only lane; arms cannot complete it"})
    try:
        item = store.complete_item(item_id, result=req.result)
    except KeyError:
        return JSONResponse(status_code=404, content={"error": f"unknown item {item_id}"})
    _persist()
    _broadcast_board()
    learning = f"Done: {item['title']} — {req.result}"
    _ghost_record(learning)
    hub.publish({"type": "learning", "text": learning})
    return {"item": item}


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


@app.post("/arms/{arm_id}/ask")
async def ask(arm_id: str, req: AskReq):
    ev = asyncio.Event()
    ask_id = _register_ask(arm_id, req.from_arm, req.message, event=ev)
    try:
        await asyncio.wait_for(ev.wait(), timeout=120.0)
        return {"ask_id": ask_id, "answer": _pending.get(ask_id, {}).get("answer")}
    except asyncio.TimeoutError:
        return JSONResponse(status_code=504, content={"error": "ask timed out"})
    finally:
        _pending.pop(ask_id, None)


@app.post("/asks/{ask_id}/reply")
def reply(ask_id: str, req: ReplyReq):
    if ask_id not in _pending:
        return JSONResponse(status_code=404, content={"error": "unknown ask"})
    _resolve_ask(ask_id, req.answer)
    hub.publish({"type": "ask_reply", "ask_id": ask_id, "answer": req.answer})
    return {"ok": True}


@app.get("/health")
def health():
    return {"ok": True}
