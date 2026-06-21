"""OvermindStore: pure in-memory presence + blackboard state.

No HTTP, no asyncio — fully unit-testable. Every time-dependent method takes an
explicit `now` (epoch seconds) so staleness/lease logic is deterministic.

The store only holds state; it never assigns or directs work.
"""
from __future__ import annotations

import uuid  # used by the blackboard (next task)
from typing import Optional


class OvermindStore:
    def __init__(self, presence_ttl: float = 15.0, claim_lease: float = 300.0):
        self.presence_ttl = presence_ttl
        self.claim_lease = claim_lease  # used by the blackboard (next task)
        self._arms: dict[str, dict] = {}
        self._items: dict[str, dict] = {}

    # -- Presence --
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
        if arm_id not in self._arms:
            raise KeyError(f"arm {arm_id!r} not registered")
        arm = self._arms[arm_id]
        if status is not None:
            arm["status"] = status
        if focus is not None:
            arm["focus"] = focus
        arm["last_seen"] = now
        return arm

    def roster(self, now: float) -> list[dict]:
        """Return arm views; an arm is 'offline' when strictly MORE than
        presence_ttl seconds have elapsed since last_seen (== ttl is still live)."""
        out = []
        for arm in self._arms.values():
            view = dict(arm)
            if now - arm["last_seen"] > self.presence_ttl:
                view["status"] = "offline"
            out.append(view)
        return out

    # -- Blackboard --
    def post_item(self, title: str, detail: str, tags: list[str],
                  posted_by: str, now: float,
                  depends_on: Optional[list[str]] = None) -> dict:
        deps = list(depends_on or [])
        for dep in deps:
            if dep not in self._items:
                raise KeyError(f"unknown dependency item {dep!r}")
        item_id = uuid.uuid4().hex[:12]
        item = {
            "id": item_id, "title": title, "detail": detail,
            "tags": list(tags or []), "state": "open",
            "claimed_by": None, "claimed_at": None,
            "result": None, "posted_by": posted_by,
            "depends_on": deps,
        }
        self._items[item_id] = item
        return self._view(item)

    def _deps_met(self, item: dict) -> bool:
        # .get for snapshots written before the depends_on upgrade
        return all(
            dep in self._items and self._items[dep]["state"] == "done"
            for dep in item.get("depends_on", [])
        )

    def _view(self, item: dict) -> dict:
        """External view: raw fields plus the computed `blocked` flag.
        Only an open item with unmet deps is blocked — claimed/done items
        already passed (or predate) the gate."""
        view = dict(item)
        view.setdefault("depends_on", [])
        view["blocked"] = item["state"] == "open" and not self._deps_met(item)
        return view

    def board(self) -> list[dict]:
        return [self._view(i) for i in self._items.values()]

    def claim_item(self, item_id: str, arm_id: str, now: float) -> Optional[dict]:
        """Atomic compare-and-set: succeeds only if the item is open AND all
        of its depends_on items are done."""
        item = self._items.get(item_id)
        if item is None or item["state"] != "open" or not self._deps_met(item):
            return None
        item["state"] = "claimed"
        item["claimed_by"] = arm_id
        item["claimed_at"] = now
        return self._view(item)

    def release_item(self, item_id: str) -> dict:
        if item_id not in self._items:
            raise KeyError(f"item {item_id!r} not found")
        item = self._items[item_id]
        item["state"] = "open"
        item["claimed_by"] = None
        item["claimed_at"] = None
        return self._view(item)

    def complete_item(self, item_id: str, result: str) -> dict:
        if item_id not in self._items:
            raise KeyError(f"item {item_id!r} not found")
        item = self._items[item_id]
        item["state"] = "done"
        item["result"] = result
        return self._view(item)

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

    # -- Persistence --
    def snapshot(self) -> dict:
        # Only the board is persisted. Presence is live ephemeral state — arms
        # re-register on launch, so a restarted Overmind starts with an empty roster.
        return {"items": {k: dict(v) for k, v in self._items.items()}}

    def load(self, snap: dict) -> None:
        self._items = {k: dict(v) for k, v in (snap.get("items") or {}).items()}
