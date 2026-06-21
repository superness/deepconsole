# Autonomous Worker Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an auxiliary DeepConsole instance run in "Autonomous mode" where it claims open blackboard items one at a time, runs them to completion in its visible chat with the full agent, and marks each Done with a result summary (Ghost → Knowledge Base) — releasing on failure.

**Architecture:** A pure, DOM-free worker **state machine** (`renderer/autonomous.js`) holds the claim→run→report loop and is unit-tested with Node's built-in `node --test`. It depends only on two injected collaborators — a `board` (the Overmind claim/done/release/setStatus bridge) and `runTask(text)` (the existing chat path, via a refactored `sendMessage`). The renderer wires the real collaborators, a toggle, and the live board feed into the machine. No Overmind or backend changes.

**Tech Stack:** Vanilla JS (Electron renderer, loaded via `<script>` tags using globals), Node 24 built-in test runner (`node:test` + `node:assert`).

**Repo:** `deepconsole`, branch `feat/autonomous-worker-mode` (already checked out). Commit with `git -C C:/github/deepconsole`. There is an untracked `localllm-abuddi.log` in this repo — never `git add -A`; stage named files only.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `renderer/autonomous.js` | Worker state machine (`createWorker`) — pure logic, no DOM/Electron | Create |
| `tests/autonomous.test.js` | Unit tests for the state machine (`node --test`) | Create |
| `package.json` | Add `"test": "node --test"` script | Modify |
| `renderer/app.js` | Refactor `sendMessage(text?)` → returns final response / throws; instantiate the worker; feed board events; toggle handler; status line | Modify |
| `renderer/index.html` | Autonomous toggle + status line in the Overmind view; include `autonomous.js` before `app.js` | Modify |
| `CLAUDE.md` | Document autonomous worker mode | Modify |

---

## Task 1: Worker state machine + unit tests

**Files:**
- Create: `C:/github/deepconsole/renderer/autonomous.js`
- Create: `C:/github/deepconsole/tests/autonomous.test.js`
- Modify: `C:/github/deepconsole/package.json`

- [ ] **Step 1: Add the test script to package.json**

In `C:/github/deepconsole/package.json`, inside the `"scripts"` object, add a `test` entry. For example, if scripts currently looks like:

```json
  "scripts": {
    "start": "electron .",
    "dev": "electron . --dev"
  },
```

make it:

```json
  "scripts": {
    "start": "electron .",
    "dev": "electron . --dev",
    "test": "node --test"
  },
```

(Keep whatever existing script entries are there; only ADD the `test` line, and ensure the preceding line has a trailing comma. Do not remove existing scripts.)

- [ ] **Step 2: Write the failing tests**

Create `C:/github/deepconsole/tests/autonomous.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { createWorker } = require("../renderer/autonomous.js");

// A fake Overmind board collaborator that records calls.
function fakeBoard(overrides) {
  const calls = { claim: [], done: [], release: [], setStatus: [] };
  const base = {
    calls,
    claim: async (id) => { calls.claim.push(id); return { item: { id, title: "T-" + id, detail: "" } }; },
    done: async (id, result) => { calls.done.push({ id, result }); },
    release: async (id) => { calls.release.push(id); },
    setStatus: async (status, focus) => { calls.setStatus.push({ status, focus }); },
  };
  return Object.assign(base, overrides || {});
}

const item = (id, state) => ({ id, title: "T-" + id, detail: "", state });

test("claims an open item, runs it, marks Done; status goes working then idle", async () => {
  const board = fakeBoard();
  let ran = null;
  const worker = createWorker({ board, runTask: async (t) => { ran = t; return "the answer"; } });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);

  assert.deepStrictEqual(board.calls.claim, ["a"]);
  assert.strictEqual(ran, "T-a");
  assert.deepStrictEqual(board.calls.done, [{ id: "a", result: "the answer" }]);
  assert.deepStrictEqual(board.calls.setStatus, [
    { status: "working", focus: "T-a" },
    { status: "idle", focus: "" },
  ]);
});

test("summarizes a long result to <= ~1500 chars", async () => {
  const board = fakeBoard();
  const big = "x".repeat(2000);
  const worker = createWorker({ board, runTask: async () => big });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);

  const result = board.calls.done[0].result;
  assert.ok(result.length < big.length);
  assert.ok(result.startsWith("x".repeat(1500)));
  assert.ok(result.includes("truncated"));
});

test("lost claim race (no item returned) does not run or mark Done", async () => {
  const board = fakeBoard({ claim: async () => ({ error: "not open" }) });
  let ran = false;
  const worker = createWorker({ board, runTask: async () => { ran = true; return "x"; } });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);

  assert.strictEqual(ran, false);
  assert.deepStrictEqual(board.calls.done, []);
  assert.strictEqual(worker.isBusy(), false);
});

test("single in-flight: a board event during a running job never starts a concurrent claim", async () => {
  const board = fakeBoard();
  let runs = 0;
  const worker = createWorker({
    board,
    runTask: async () => {
      runs++;
      if (runs === 1) {
        // a fresh board event arrives mid-job; must be ignored until the job finishes
        worker.onBoard([item("a", "open"), item("b", "open")]);
      }
      return "ok";
    },
  });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);

  // 'a' then 'b', sequentially — never two claims before the first job completed
  assert.deepStrictEqual(board.calls.claim, ["a", "b"]);
  assert.strictEqual(runs, 2);
});

test("runTask failure releases the item and does not mark Done", async () => {
  const board = fakeBoard();
  const worker = createWorker({ board, runTask: async () => { throw new Error("boom"); } });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);

  assert.deepStrictEqual(board.calls.release, ["a"]);
  assert.deepStrictEqual(board.calls.done, []);
  assert.deepStrictEqual(board.calls.setStatus, [
    { status: "working", focus: "T-a" },
    { status: "idle", focus: "" },
  ]);
});

test("disabling mid-job finishes the current job, then stops claiming", async () => {
  const board = fakeBoard();
  const worker = createWorker({
    board,
    runTask: async () => { worker.setEnabled(false); return "done-ish"; },
  });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);
  assert.deepStrictEqual(board.calls.done.map((d) => d.id), ["a"]); // current job completed

  await worker.onBoard([item("b", "open")]); // now disabled
  assert.deepStrictEqual(board.calls.claim, ["a"]); // 'b' never claimed
});

test("does nothing while disabled", async () => {
  const board = fakeBoard();
  const worker = createWorker({ board, runTask: async () => "x" });
  await worker.onBoard([item("a", "open")]); // never enabled
  assert.deepStrictEqual(board.calls.claim, []);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/autonomous.test.js`
(from `C:/github/deepconsole`)
Expected: FAIL — `Cannot find module '../renderer/autonomous.js'`.

- [ ] **Step 4: Implement the state machine**

Create `C:/github/deepconsole/renderer/autonomous.js`:

```js
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

  function markLocal(id, state) {
    for (let i = 0; i < latestBoard.length; i++) {
      if (latestBoard[i].id === id) { latestBoard[i].state = state; break; }
    }
  }

  function firstOpen() {
    for (let i = 0; i < latestBoard.length; i++) {
      if (latestBoard[i].state === "open") return latestBoard[i];
    }
    return null;
  }

  async function runOne(it) {
    current = it.title;
    notify();
    await board.setStatus("working", it.title);
    let ok = false;
    try {
      const result = await runTask(taskText(it));
      await board.done(it.id, summarize(result));
      markLocal(it.id, "done");
      ok = true;
    } catch (e) {
      await board.release(it.id);
      markLocal(it.id, "claimed"); // locally treat as not-open so we don't tight-loop on it
      log("task failed, released " + it.id + ": " + (e && e.message));
    } finally {
      current = null;
      await board.setStatus("idle", "");
      notify();
    }
    return ok;
  }

  async function maybeClaim() {
    if (!enabled || busy) return;
    const it = firstOpen();
    if (!it) return;

    busy = true;
    notify();
    let didWork = false;
    try {
      const res = await board.claim(it.id);
      if (res && res.item) {
        didWork = await runOne(res.item);
      } else {
        markLocal(it.id, "claimed"); // lost the race; wait for a fresh board event before retrying
      }
    } catch (e) {
      log("claim error " + it.id + ": " + (e && e.message));
    } finally {
      busy = false;
      notify();
    }
    if (didWork) await maybeClaim(); // drain backlog after a real job
  }

  function setEnabled(value) {
    enabled = !!value;
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/autonomous.test.js`
Expected: PASS — 7 tests passing.

- [ ] **Step 6: Commit**

```bash
git -C C:/github/deepconsole add renderer/autonomous.js tests/autonomous.test.js package.json
git -C C:/github/deepconsole commit -m "feat(autonomous): worker state machine + unit tests"
```

---

## Task 2: Refactor `sendMessage` to be drivable + return the result

**Files:**
- Modify: `C:/github/deepconsole/renderer/app.js` (`sendMessage`, starts at line 537; the `error`/`done` cases inside its `onEvent`; the trailing `return`)

No unit test (DOM/Electron). Verified by `node --check` and the Task 4 smoke test.

- [ ] **Step 1: Make the signature accept optional text and guard correctly**

In `C:/github/deepconsole/renderer/app.js`, replace the opening of `sendMessage` (lines 537–541):

```js
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !currentSessionId || isStreaming) return;

  messageInput.value = '';
  addMessage('user', text);
```

with:

```js
async function sendMessage(textArg) {
  const fromInput = typeof textArg !== 'string';
  const text = (fromInput ? messageInput.value : textArg).trim();
  if (!text || !currentSessionId) return '';
  // If a stream is already running, a programmatic (autonomous) caller must know
  // it couldn't run, so it can release the item; a manual caller just no-ops.
  if (isStreaming) {
    if (!fromInput) throw new Error('chat busy');
    return '';
  }

  if (fromInput) messageInput.value = '';
  addMessage('user', text);
```

- [ ] **Step 2: Capture stream errors so the function can reject**

In the same function, the `onEvent` handler has an `error` case (around line 603) that currently reads:

```js
        case 'error':
          collapseDelegationPanel();
          finishStreaming();
          showErrorWithDoctor(data.message);
          setStatus('online', 'Error');
          break;
```

Add a captured-error variable. First, immediately BEFORE the `try {` that wraps the `onEvent` subscription (the `try` at line ~558, right after `if (eventCleanup) eventCleanup();`), add:

```js
  let streamError = null;
```

Then change the `error` case to record it:

```js
        case 'error':
          collapseDelegationPanel();
          finishStreaming();
          streamError = data.message || 'stream error';
          showErrorWithDoctor(data.message);
          setStatus('online', 'Error');
          break;
```

- [ ] **Step 2b: Record the error in the catch too**

The function has a `catch (err)` block (around line 613) that currently reads:

```js
  } catch (err) {
    finishStreaming();
    showErrorWithDoctor(err.message);
    console.error('Chat error:', err);
  }
```

Change it to also record the error:

```js
  } catch (err) {
    finishStreaming();
    streamError = err.message;
    showErrorWithDoctor(err.message);
    console.error('Chat error:', err);
  }
```

- [ ] **Step 3: Return the final response / throw on error**

At the END of `sendMessage`, the function currently finishes with (lines ~619–623):

```js
  isStreaming = false;
  sendBtn.style.display = '';
  stopBtn.style.display = 'none';
  messageInput.focus();
}
```

Replace that with:

```js
  isStreaming = false;
  sendBtn.style.display = '';
  stopBtn.style.display = 'none';
  if (fromInput) messageInput.focus();

  if (streamError) throw new Error(streamError);
  return lastAIMessage;
}
```

(`lastAIMessage` is the module-level variable declared at line 20 and set to the final response in the `done` case at line 591. `streamError` is the variable added in Step 2.)

- [ ] **Step 4: Syntax-check**

Run: `node --check C:/github/deepconsole/renderer/app.js`
Expected: no output (valid).

- [ ] **Step 5: Confirm the manual send button still works unchanged**

The send button calls `sendMessage()` with no arguments. Grep to confirm no caller passes an event object as the first arg (which would be mistaken for `textArg`):

Run: `grep -n "sendMessage(" C:/github/deepconsole/renderer/app.js`
Expected: calls are `sendMessage()` (no args) — e.g. the send-button click handler and Enter-key handler. If any call passes an argument (such as an event), change that call site to `sendMessage()` so the no-arg/manual path is preserved. Report what you found.

- [ ] **Step 6: Commit**

```bash
git -C C:/github/deepconsole add renderer/app.js
git -C C:/github/deepconsole commit -m "refactor(chat): sendMessage accepts text + returns final response"
```

---

## Task 3: Wire the worker into the renderer (toggle, status, board feed)

**Files:**
- Modify: `C:/github/deepconsole/renderer/index.html` (Overmind view header ~line 346–361; script include ~line 472)
- Modify: `C:/github/deepconsole/renderer/app.js` (Overmind section, near the existing `overmind.onEvent` handler ~line 2809)

- [ ] **Step 1: Include the worker module before app.js**

In `C:/github/deepconsole/renderer/index.html`, find:

```html
  <script src="app.js"></script>
```

Replace with (autonomous.js must load first so `window.createWorker` exists when app.js runs):

```html
  <script src="autonomous.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 2: Add the toggle + status line to the Overmind view**

In `C:/github/deepconsole/renderer/index.html`, find the Overmind board container (around line 361):

```html
          <div id="overmind-board" class="overmind-board"></div>
```

Immediately BEFORE that line, insert an autonomous-mode control block:

```html
          <div class="overmind-autonomous">
            <label class="overmind-auto-toggle">
              <input type="checkbox" id="autonomous-toggle" />
              Autonomous mode
            </label>
            <span id="autonomous-status" class="overmind-auto-status">off</span>
          </div>
```

- [ ] **Step 3: Instantiate the worker and wire it in app.js**

In `C:/github/deepconsole/renderer/app.js`, find the existing live-updates handler near line 2809:

```js
// Live updates — the single SSE feed drives every panel. No polling.
window.deepconsole.overmind.onEvent((ev) => {
  if (ev.type === 'presence') renderRoster(ev.roster);
  else if (ev.type === 'board') renderBoard(ev.board);
  else if (ev.type === 'ask' && ev.to === myArmId) addIncomingAsk(ev);
});
```

Replace that whole block with:

```js
// ─── Autonomous worker ────────────────────────────────────────────────────
const autonomousToggle = document.getElementById('autonomous-toggle');
const autonomousStatus = document.getElementById('autonomous-status');

const autonomousWorker = window.createWorker({
  board: {
    claim: (id) => window.deepconsole.overmind.claim(id),
    done: (id, result) => window.deepconsole.overmind.done(id, result),
    release: (id) => window.deepconsole.overmind.release(id),
    setStatus: (status, focus) => window.deepconsole.overmind.setStatus(status, focus),
  },
  runTask: (text) => sendMessage(text),
  log: (m) => console.log('[autonomous]', m),
  onChange: ({ enabled, busy, current }) => {
    if (!autonomousStatus) return;
    autonomousStatus.textContent = !enabled
      ? 'off'
      : (busy ? `working — "${current || '…'}"` : 'on · idle — watching board');
  },
});

if (autonomousToggle) {
  autonomousToggle.addEventListener('change', () => {
    autonomousWorker.setEnabled(autonomousToggle.checked);
  });
}

// Seed the worker with the current board, then keep it fed by the live SSE stream.
window.deepconsole.overmind.board()
  .then(({ board }) => autonomousWorker.onBoard(board || []))
  .catch(() => {});

// Live updates — the single SSE feed drives every panel. No polling.
window.deepconsole.overmind.onEvent((ev) => {
  if (ev.type === 'presence') renderRoster(ev.roster);
  else if (ev.type === 'board') { renderBoard(ev.board); autonomousWorker.onBoard(ev.board); }
  else if (ev.type === 'ask' && ev.to === myArmId) addIncomingAsk(ev);
});
```

- [ ] **Step 4: Syntax-check**

Run: `node --check C:/github/deepconsole/renderer/app.js`
Expected: no output (valid). (index.html is not JS.)

- [ ] **Step 5: Re-run the unit tests (nothing should have broken)**

Run: `node --test tests/autonomous.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git -C C:/github/deepconsole add renderer/index.html renderer/app.js
git -C C:/github/deepconsole commit -m "feat(autonomous): Overmind-tab toggle + wire worker to board feed"
```

---

## Task 4: Docs + final verification

**Files:**
- Modify: `C:/github/deepconsole/CLAUDE.md` (Multi-instance & the Overmind section)

- [ ] **Step 1: Document autonomous mode in CLAUDE.md**

In `C:/github/deepconsole/CLAUDE.md`, find the end of the "Multi-instance & the Overmind" section — the paragraph that begins "**Renderer:** the **Overmind tab**" and ends with "`overmind:*` IPC handlers (`main.js`)." Immediately AFTER that paragraph, add:

```markdown
- **Autonomous worker mode.** Any instance can be flipped into **Autonomous mode** from the Overmind tab (`#autonomous-toggle`). A DOM-free state machine (`renderer/autonomous.js`, unit-tested via `npm test` / `node --test`) then watches the live board feed and, while idle, atomically **claims one open item at a time**, runs it to completion in the instance's visible chat (the full `abuddi-deepseek` agent, via a refactored `sendMessage(text)` that returns the final answer), marks the item **Done** with a summarized result (so the **Ghost** records a learning), and **releases** it on failure. One job at a time (single in-flight guard); disabling mid-job finishes the current job then stops. This keeps the Overmind's pull-not-push contract: a worker only ever takes work it claims, nothing is assigned to it.
```

- [ ] **Step 2: Full test run**

Run: `npm test --prefix C:/github/deepconsole` (or, from `C:/github/deepconsole`, `node --test`)
Expected: the 7 autonomous worker tests PASS. (There are no other test files in this repo.)

- [ ] **Step 3: Final syntax check of all touched JS**

Run:
```
node --check C:/github/deepconsole/renderer/app.js
node --check C:/github/deepconsole/renderer/autonomous.js
```
Expected: no output (both valid).

- [ ] **Step 4: Commit**

```bash
git -C C:/github/deepconsole add CLAUDE.md
git -C C:/github/deepconsole commit -m "docs: document autonomous worker mode"
```

---

## Manual smoke test (after implementation)

1. Start two instances: `npm start` twice (in `C:/github/deepconsole`).
2. In instance **B**, open the Overmind tab and tick **Autonomous mode** (status → `on · idle — watching board`).
3. In instance **A**, post a task to the blackboard (e.g. "list the files in the current directory").
4. Expect in **B**: roster/status shows `working — "<title>"`, the task runs in B's chat panel, the board item flips to ✓ with a result summary, and a learning lands in the Knowledge Base (`../localllm-abuddi/knowledge.json`).
5. While B is busy, post a second item from A → B picks it up right after the first completes, never concurrently.
6. Untick Autonomous mode → B finishes any current job, then stops claiming.

---

## Self-Review

**Spec coverage:**
- Toggle in Overmind tab → Task 3 (HTML + handler).  ✓
- One-at-a-time, event-driven claim → Task 1 (`maybeClaim` single in-flight + `onBoard` feed) & Task 3 (board SSE → `onBoard`).  ✓
- Full-agent execution in the visible chat → Task 2 (`sendMessage(text)` reuse) + Task 3 (`runTask`).  ✓
- Mark Done with summarized result → Task 1 (`runOne` → `board.done` + `summarize`).  ✓
- Release on failure → Task 1 (`runOne` catch → `board.release`).  ✓
- Presence working/idle → Task 1 (`board.setStatus`).  ✓
- Disabling mid-job finishes then stops → Task 1 (test + `enabled` guard).  ✓
- Backlog drain → Task 1 (`if (didWork) await maybeClaim()`).  ✓
- Testable state machine w/ injected collaborators → Task 1.  ✓
- No Overmind/backend changes → confirmed (only renderer + package.json + docs).  ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. Step 1 of Task 1 shows the package.json edit by example because the exact existing scripts are read at implementation time — the instruction (add a `test` line, keep the rest) is explicit, not a placeholder.

**Type/name consistency:** `createWorker({board, runTask, log, onChange})` defined in Task 1, consumed identically in Task 3. `board` methods (`claim/done/release/setStatus`) match the fakes (Task 1) and the real `window.deepconsole.overmind` bridge (Task 3). `worker.onBoard` / `worker.setEnabled` / `worker.isBusy` consistent across tasks. `sendMessage(text)` returns the final string (Task 2) and is used as `runTask` (Task 3). `lastAIMessage` (app.js:20) and `streamError` (added Task 2) are the result/error channels.

**Known caveat:** the in-app DeepSeek agent auto-commits to the checked-out branch; if it touches `app.js`/`index.html` mid-execution, re-check the exact anchor strings (and for duplicate declarations) before each edit.
