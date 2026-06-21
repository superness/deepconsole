// Autonomous worker state machine for DeepConsole.
//
// Pure logic — no DOM, no Electron — so it runs under `node --test`. It watches
// the Overmind board, claims ONE open item at a time (atomic CAS via board.claim),
// runs it to completion via runTask, marks it Done with a summarized result (or
// releases it on failure), then looks for the next open item.
//
// Collaborators (injected):
//   board.claim(id)            -> Promise<{item}|{error}|null>   (truthy .item == we won)
//   board.done(id, result)     -> Promise
//   board.release(id)          -> Promise
//   board.setStatus(s, focus)  -> Promise
//   runTask(text)              -> Promise<string>   (resolves with the agent's final answer)
//   log(msg)                   -> void              (optional)
//   onChange({enabled,busy,current}) -> void        (optional; UI hook)

function createWorker(deps) {
  const board = deps.board;
  const runTask = deps.runTask;
  const log = deps.log || function () {};
  const onChange = deps.onChange || function () {};

  let enabled = false;
  let busy = false;        // single in-flight guard
  let current = null;      // title of the item being worked, else null
  let latestBoard = [];

  function notify() {
    onChange({ enabled: enabled, busy: busy, current: current });
  }

  function taskText(it) {
    return it.detail ? it.title + "\n\n" + it.detail : it.title;
  }

  function summarize(result) {
    const s = String(result == null ? "" : result);
    return s.length > 1500 ? s.slice(0, 1500) + " …(truncated)" : s;
  }

  // An agent can decline a job it cannot finish (e.g. waiting on operator input)
  // by leading its answer with "BLOCKED:". The worker then RELEASES the item
  // instead of marking it Done — otherwise an explanation of why it couldn't
  // proceed would be recorded as a (false) completion and unblock dependents.
  function isBlockedSignal(result) {
    return /^\s*blocked\b/i.test(String(result == null ? "" : result));
  }

  function markLocal(id, state) {
    for (let i = 0; i < latestBoard.length; i++) {
      if (latestBoard[i].id === id) { latestBoard[i].state = state; break; }
    }
  }

  function firstOpen() {
    for (let i = 0; i < latestBoard.length; i++) {
      const it = latestBoard[i];
      // blocked = open but with unmet depends_on prereqs (computed by the Overmind)
      if (it.state !== "open" || it.blocked) continue;
      // operator/checkpoint lanes are operator-only — the board REJECTS arm claims on them.
      // Skip them here, otherwise firstOpen keeps picking an unclaimable lane and the arm
      // bounces off the server guard forever, starving the claimable lanes behind it.
      const tags = it.tags || [];
      if (tags.indexOf("operator") !== -1 || tags.indexOf("checkpoint") !== -1) continue;
      return it;
    }
    return null;
  }

  async function runOne(it) {
    current = it.title;
    notify();
    await board.setStatus("working", it.title);
    let ok = false;
    try {
      let result;
      try {
        result = await runTask(taskText(it));
      } catch (e) {
        // The agent failed — release the item so another worker can retry.
        await board.release(it.id);
        markLocal(it.id, "claimed"); // locally not-open so we don't tight-loop on it
        log("task failed, released " + it.id + ": " + (e && e.message));
        return false;
      }
      // The agent declined the job (blocked on a precondition). Release it,
      // don't complete it — completing would falsely unblock dependents.
      if (isBlockedSignal(result)) {
        await board.release(it.id);
        markLocal(it.id, "claimed"); // locally not-open so we don't immediately re-claim
        log("task self-reported BLOCKED, released " + it.id);
        return false;
      }
      // The agent finished. Mark Done — but a done() failure must NOT release an
      // item the agent actually completed; just log it and treat as locally done.
      try {
        await board.done(it.id, summarize(result));
      } catch (e) {
        log("done failed for " + it.id + " (work completed): " + (e && e.message));
      }
      markLocal(it.id, "done");
      ok = true;
    } finally {
      current = null;
      await board.setStatus("idle", "");
      notify();
    }
    return ok;
  }

  async function maybeClaim() {
    const openCount = latestBoard.filter(function (x) { return x.state === "open" && !x.blocked; }).length;
    if (!enabled || busy) {
      // The interesting failure: there IS open work but we're not taking it.
      if (openCount > 0) log("tick: NOT claiming — enabled=" + enabled + " busy=" + busy + " open=" + openCount);
      return;
    }
    const it = firstOpen();
    if (!it) {
      log("tick: nothing to claim — board=" + latestBoard.length + " open=" + openCount);
      return;
    }

    log("claiming " + it.id + " \"" + String(it.title).slice(0, 40) + "\"");
    busy = true;
    notify();
    let didWork = false;
    try {
      const res = await board.claim(it.id);
      if (res && res.item) {
        log("WON claim " + it.id + " — running task");
        didWork = await runOne(res.item);
        log("task finished " + it.id + " didWork=" + didWork);
      } else {
        log("LOST claim " + it.id + " — res=" + JSON.stringify(res));
        markLocal(it.id, "claimed"); // lost the race; wait for a fresh board event before retrying
      }
    } catch (e) {
      log("CLAIM ERROR " + it.id + ": " + (e && e.message));
    } finally {
      busy = false;
      notify();
    }
    if (didWork) { log("drain: looking for next open lane"); await maybeClaim(); } // drain backlog after a real job
  }

  function setEnabled(value) {
    enabled = !!value;
    log("setEnabled -> " + enabled);
    notify();
    return enabled ? maybeClaim() : Promise.resolve();
  }

  function onBoard(boardArr) {
    latestBoard = Array.isArray(boardArr) ? boardArr.slice() : [];
    return maybeClaim();
  }

  return {
    setEnabled: setEnabled,
    onBoard: onBoard,
    isEnabled: function () { return enabled; },
    isBusy: function () { return busy; },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createWorker: createWorker };
}
if (typeof window !== "undefined") {
  window.createWorker = createWorker;
}
