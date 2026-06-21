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
  assert.deepStrictEqual(board.calls.done.map((d) => d.id), ["a"]);

  await worker.onBoard([item("b", "open")]);
  assert.deepStrictEqual(board.calls.claim, ["a"]);
});

test("does nothing while disabled", async () => {
  const board = fakeBoard();
  const worker = createWorker({ board, runTask: async () => "x" });
  await worker.onBoard([item("a", "open")]);
  assert.deepStrictEqual(board.calls.claim, []);
});

test("a board.done failure does NOT release an item the agent completed", async () => {
  const board = fakeBoard({ done: async () => { throw new Error("net"); } });
  const worker = createWorker({ board, runTask: async () => "result" });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);

  assert.deepStrictEqual(board.calls.release, []); // not released despite done() failing
  assert.deepStrictEqual(board.calls.setStatus, [
    { status: "working", focus: "T-a" },
    { status: "idle", focus: "" },
  ]);
});

test("agent answer signalling BLOCKED releases the item, does not mark Done", async () => {
  const board = fakeBoard();
  const worker = createWorker({
    board,
    runTask: async () => "BLOCKED: waiting on operator for the bespoke DeepSeek key and prospect slug.",
  });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);

  assert.deepStrictEqual(board.calls.done, []);            // never completed
  assert.deepStrictEqual(board.calls.release, ["a"]);       // returned to the board
  assert.deepStrictEqual(board.calls.setStatus, [
    { status: "working", focus: "T-a" },
    { status: "idle", focus: "" },
  ]);
});

test("BLOCKED detection ignores leading whitespace and is case-insensitive", async () => {
  const board = fakeBoard();
  const worker = createWorker({ board, runTask: async () => "  \n blocked: nope" });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);
  assert.deepStrictEqual(board.calls.release, ["a"]);
  assert.deepStrictEqual(board.calls.done, []);
});

test("the word blocked elsewhere in a normal answer still marks Done", async () => {
  const board = fakeBoard();
  const worker = createWorker({ board, runTask: async () => "I unblocked the pipeline and it passes." });
  worker.setEnabled(true);
  await worker.onBoard([item("a", "open")]);
  assert.deepStrictEqual(board.calls.done.map((d) => d.id), ["a"]);
  assert.deepStrictEqual(board.calls.release, []);
});

test("skips blocked open items and claims the first unblocked one", async () => {
  const board = fakeBoard();
  const worker = createWorker({ board, runTask: async () => "x" });
  worker.setEnabled(true);
  await worker.onBoard([
    { id: "a", title: "T-a", detail: "", state: "open", blocked: true },
    { id: "b", title: "T-b", detail: "", state: "open", blocked: false },
  ]);

  assert.deepStrictEqual(board.calls.claim, ["b"]);
});

test("all open items blocked: claims nothing", async () => {
  const board = fakeBoard();
  const worker = createWorker({ board, runTask: async () => "x" });
  worker.setEnabled(true);
  await worker.onBoard([
    { id: "a", title: "T-a", detail: "", state: "open", blocked: true },
  ]);

  assert.deepStrictEqual(board.calls.claim, []);
});

test("includes item detail in the task text when present", async () => {
  const fullItem = { id: "a", title: "Title", detail: "Details here", state: "open" };
  const board = fakeBoard({ claim: async (id) => { board.calls.claim.push(id); return { item: fullItem }; } });
  let ran = null;
  const worker = createWorker({ board, runTask: async (t) => { ran = t; return "x"; } });
  worker.setEnabled(true);
  await worker.onBoard([fullItem]);

  assert.strictEqual(ran, "Title\n\nDetails here");
});
