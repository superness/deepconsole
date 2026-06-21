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


def test_register_arm_preserves_status_on_reregister():
    s = OvermindStore()
    s.register_arm("alpha", name="Alpha", pid=111, browser_port=51000, now=1000.0)
    s.heartbeat("alpha", status="working", focus="task", now=1001.0)
    # re-register (e.g. reconnect) must NOT reset status/focus
    s.register_arm("alpha", name="Alpha", pid=222, browser_port=51001, now=1002.0)
    arm = s.roster(now=1002.0)[0]
    assert arm["status"] == "working"
    assert arm["focus"] == "task"
    assert arm["pid"] == 222  # but identity fields DO update


def test_heartbeat_unknown_arm_raises_keyerror():
    import pytest
    s = OvermindStore()
    with pytest.raises(KeyError):
        s.heartbeat("ghost", status="working", now=1000.0)


def test_arm_live_exactly_at_ttl_boundary():
    s = OvermindStore(presence_ttl=10.0)
    s.register_arm("alpha", name="Alpha", pid=1, browser_port=51000, now=1000.0)
    # exactly ttl elapsed -> still live (boundary is strict >)
    assert s.roster(now=1010.0)[0]["status"] == "idle"
    # just past ttl -> offline
    assert s.roster(now=1010.001)[0]["status"] == "offline"


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


def test_sweep_returns_released_ids():
    s = OvermindStore(claim_lease=60.0)
    item = s.post_item(title="t", detail="", tags=[], posted_by="alpha", now=1000.0)
    s.claim_item(item["id"], "alpha", now=1000.0)
    released = s.sweep(now=1120.0)
    assert item["id"] in released


def test_sweep_leaves_non_expired_claim():
    s = OvermindStore(claim_lease=60.0)
    item = s.post_item(title="t", detail="", tags=[], posted_by="alpha", now=1000.0)
    s.claim_item(item["id"], "alpha", now=1000.0)
    # exactly at lease boundary -> NOT released (strict >)
    released = s.sweep(now=1060.0)
    assert released == []
    assert s.board()[0]["state"] == "claimed"


def test_cannot_claim_done_item():
    s = OvermindStore()
    item = s.post_item(title="t", detail="", tags=[], posted_by="alpha", now=1000.0)
    s.claim_item(item["id"], "alpha", now=1001.0)
    s.complete_item(item["id"], result="x")
    assert s.claim_item(item["id"], "bravo", now=1005.0) is None


def test_release_unknown_item_raises_keyerror():
    import pytest
    s = OvermindStore()
    with pytest.raises(KeyError):
        s.release_item("ghost")


def test_post_item_with_unknown_dep_raises_keyerror():
    import pytest
    s = OvermindStore()
    with pytest.raises(KeyError):
        s.post_item(title="b", detail="", tags=[], posted_by="alpha",
                    now=1000.0, depends_on=["ghost"])


def test_open_item_with_unmet_deps_is_blocked_and_unclaimable():
    s = OvermindStore()
    a = s.post_item(title="a", detail="", tags=[], posted_by="alpha", now=1000.0)
    b = s.post_item(title="b", detail="", tags=[], posted_by="alpha",
                    now=1000.0, depends_on=[a["id"]])
    views = {i["title"]: i for i in s.board()}
    assert views["a"]["blocked"] is False
    assert views["b"]["blocked"] is True
    assert views["b"]["depends_on"] == [a["id"]]
    # claim of a blocked item fails like any CAS failure
    assert s.claim_item(b["id"], "bravo", now=1001.0) is None
    assert s.board()[1]["state"] == "open"  # untouched


def test_item_unblocks_when_all_deps_done():
    s = OvermindStore()
    a = s.post_item(title="a", detail="", tags=[], posted_by="alpha", now=1000.0)
    c = s.post_item(title="c", detail="", tags=[], posted_by="alpha", now=1000.0)
    b = s.post_item(title="b", detail="", tags=[], posted_by="alpha",
                    now=1000.0, depends_on=[a["id"], c["id"]])
    s.claim_item(a["id"], "alpha", now=1001.0)
    s.complete_item(a["id"], result="ok")
    # one of two deps done -> still blocked
    assert {i["title"]: i for i in s.board()}["b"]["blocked"] is True
    assert s.claim_item(b["id"], "bravo", now=1002.0) is None
    s.claim_item(c["id"], "alpha", now=1003.0)
    s.complete_item(c["id"], result="ok")
    assert {i["title"]: i for i in s.board()}["b"]["blocked"] is False
    claimed = s.claim_item(b["id"], "bravo", now=1004.0)
    assert claimed is not None and claimed["claimed_by"] == "bravo"


def test_done_and_claimed_items_never_report_blocked():
    s = OvermindStore()
    a = s.post_item(title="a", detail="", tags=[], posted_by="alpha", now=1000.0)
    s.claim_item(a["id"], "alpha", now=1001.0)
    assert s.board()[0]["blocked"] is False
    s.complete_item(a["id"], result="ok")
    assert s.board()[0]["blocked"] is False


def test_snapshot_roundtrip_preserves_depends_on():
    s = OvermindStore()
    a = s.post_item(title="a", detail="", tags=[], posted_by="alpha", now=1000.0)
    s.post_item(title="b", detail="", tags=[], posted_by="alpha",
                now=1000.0, depends_on=[a["id"]])
    s2 = OvermindStore()
    s2.load(s.snapshot())
    views = {i["title"]: i for i in s2.board()}
    assert views["b"]["depends_on"] == [a["id"]]
    assert views["b"]["blocked"] is True


def test_load_legacy_snapshot_without_depends_on():
    # snapshots written before the depends_on upgrade must load and be claimable
    s = OvermindStore()
    s.load({"items": {"old1": {
        "id": "old1", "title": "legacy", "detail": "", "tags": [],
        "state": "open", "claimed_by": None, "claimed_at": None,
        "result": None, "posted_by": "alpha"}}})
    view = s.board()[0]
    assert view["blocked"] is False
    assert view["depends_on"] == []
    assert s.claim_item("old1", "alpha", now=1000.0) is not None


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
