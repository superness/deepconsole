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


def test_heartbeat_unknown_arm_returns_404():
    r = client.post("/arms/ghost/heartbeat", json={"status": "working"})
    assert r.status_code == 404


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


def test_depends_on_blocks_claim_until_prereq_done():
    a = client.post("/board", json={
        "title": "a", "detail": "", "tags": [], "posted_by": "alpha"}).json()["item"]
    b = client.post("/board", json={
        "title": "b", "detail": "", "tags": [], "posted_by": "alpha",
        "depends_on": [a["id"]]}).json()["item"]
    assert b["depends_on"] == [a["id"]]
    # blocked -> claim refused
    r = client.post(f"/board/{b['id']}/claim", json={"arm_id": "bravo"})
    assert r.status_code == 409
    # board exposes the computed blocked flag
    board = client.get("/board").json()["board"]
    assert {i["title"]: i["blocked"] for i in board} == {"a": False, "b": True}
    # complete the prereq -> claimable
    client.post(f"/board/{a['id']}/claim", json={"arm_id": "alpha"})
    client.post(f"/board/{a['id']}/done", json={"result": "ok"})
    r = client.post(f"/board/{b['id']}/claim", json={"arm_id": "bravo"})
    assert r.status_code == 200
    assert r.json()["item"]["claimed_by"] == "bravo"


def test_post_item_with_unknown_dep_returns_400():
    r = client.post("/board", json={
        "title": "b", "detail": "", "tags": [], "posted_by": "alpha",
        "depends_on": ["ghost"]})
    assert r.status_code == 400
    assert "ghost" in r.json()["error"]


def test_health():
    assert client.get("/health").json()["ok"] is True


def test_release_unknown_item_returns_404():
    r = client.post("/board/ghost/release")
    assert r.status_code == 404


def test_done_unknown_item_returns_404():
    r = client.post("/board/ghost/done", json={"result": "x"})
    assert r.status_code == 404


def test_hub_publishes_to_all_subscribers():
    from overmind.app import Hub
    h = Hub()
    q1 = h.subscribe()
    q2 = h.subscribe()
    h.publish({"type": "x"})
    assert q1.get_nowait() == {"type": "x"}
    assert q2.get_nowait() == {"type": "x"}
    h.unsubscribe(q1)
    h.publish({"type": "y"})
    assert q2.get_nowait() == {"type": "y"}
    assert q1.empty()


def test_register_broadcasts_presence_event():
    from overmind.app import hub
    q = hub.subscribe()
    try:
        client.post("/arms/register", json={
            "id": "alpha", "name": "Alpha", "pid": 1, "browser_port": 51000})
        event = q.get_nowait()
        assert event["type"] == "presence"
        assert any(a["id"] == "alpha" for a in event["roster"])
    finally:
        hub.unsubscribe(q)


def test_post_item_broadcasts_board_event():
    from overmind.app import hub
    client.post("/arms/register", json={
        "id": "alpha", "name": "Alpha", "pid": 1, "browser_port": 51000})
    q = hub.subscribe()
    try:
        client.post("/board", json={
            "title": "t", "detail": "", "tags": [], "posted_by": "alpha"})
        # drain until we see a board event (register above may have queued presence)
        seen = []
        while not q.empty():
            seen.append(q.get_nowait())
        assert any(e["type"] == "board" for e in seen)
    finally:
        hub.unsubscribe(q)


def test_ask_creates_pending_and_reply_resolves():
    # Unit-level: posting an ask registers a pending future keyed by ask_id;
    # replying resolves it. (Full async round-trip is exercised manually.)
    from overmind import app as appmod
    appmod._pending.clear()
    ask_id = appmod._register_ask("bravo", "alpha", "what's the API count?")
    assert ask_id in appmod._pending
    appmod._resolve_ask(ask_id, "12")
    assert appmod._pending[ask_id]["answer"] == "12"


def test_reply_route_resolves_pending():
    from overmind import app as appmod
    appmod._pending.clear()
    ask_id = appmod._register_ask("bravo", "alpha", "ping?")
    r = client.post(f"/asks/{ask_id}/reply", json={"answer": "pong"})
    assert r.status_code == 200
    assert appmod._pending[ask_id]["answer"] == "pong"


def test_register_ask_publishes_ask_event():
    from overmind.app import hub, _register_ask, _pending
    _pending.clear()
    q = hub.subscribe()
    try:
        ask_id = _register_ask("bravo", "alpha", "hello?")
        event = q.get_nowait()
        assert event["type"] == "ask"
        assert event["ask_id"] == ask_id
        assert event["to"] == "bravo"
        assert event["from"] == "alpha"
        assert event["message"] == "hello?"
    finally:
        hub.unsubscribe(q)


def test_reply_unknown_ask_returns_404():
    from overmind import app as appmod
    appmod._pending.clear()
    r = client.post("/asks/ghost/reply", json={"answer": "x"})
    assert r.status_code == 404


def test_register_ask_with_event_attaches_before_publish():
    from overmind import app as appmod
    import asyncio
    appmod._pending.clear()
    ev = asyncio.Event()
    ask_id = appmod._register_ask("bravo", "alpha", "q?", event=ev)
    # event is attached immediately, so an instant resolve signals it
    assert appmod._pending[ask_id]["event"] is ev
    appmod._resolve_ask(ask_id, "a")
    assert ev.is_set()


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
