# Live Sub-Agent Delegation Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent `[ABUDDI] Delegating to sub-agents...` gap with a live, inline panel showing each sub-agent's real status, tool calls, token preview, and final result.

**Architecture:** Sub-agent child loops push tagged progress events onto an `asyncio.Queue`; the parent backend generator drains the queue and yields a new `subagent` chunk type while sub-agents run concurrently; `engine.py` passes it through to the existing SSE pipe as an `event: subagent`; `renderer/app.js` handles a new `case 'subagent'` and renders/updates an inline delegation panel built with `createElement` and styled in `style.css`.

**Tech Stack:** Python 3.11+ / asyncio / FastAPI (backend at `C:\github\localllm-abuddi`), Electron renderer (vanilla JS + CSS at `C:\github\deepconsole\renderer`).

**Spec:** `docs/superpowers/specs/2026-06-07-live-subagent-delegation-visual-design.md`

---

## Pre-flight notes for the implementer (read first)

- **Two repos are involved.** Backend files live in the sibling directory `C:\github\localllm-abuddi`. Frontend files live in `C:\github\deepconsole\renderer`. Paths below are absolute — respect which tree each file is in.
- **No automated test framework exists.** Per `CLAUDE.md`, DeepConsole has no test/lint scripts and the backend has no pytest harness wired for live-LLM flows. This plan therefore uses **explicit manual smoke tests** instead of unit tests. Each task's verification step tells you exactly what to run and what to look for. Do not skip them.
- **`C:\github\deepconsole` is not currently a git repository** (verified at planning time). The `git commit` steps below are written as normal checkpoints. If `git status` errors with "not a repository," either run `git init` first or treat each commit step as a manual save-point and move on — do not block on it.
- **Running the stack for verification:** `npm run dev` from `C:\github\deepconsole` launches Electron, which spawns the backend on port 8000 and the browser API on 9100. The app pings `http://127.0.0.1:8000/health` until ready. A delegating prompt is one that ABUDDI scores ≥20 — e.g. *"Build a complete multi-file authentication system with login UI, session storage, password hashing, and an admin dashboard."*

---

## Task 1: Backend — orchestrator emits per-sub-agent progress events

Thread an optional `progress_queue` through the dispatch chain and emit tagged events from each child loop.

**Files:**
- Modify: `C:\github\localllm-abuddi\agent_orchestrator.py` (`dispatch_subtasks` ~line 266, `_create_sub_agent_session` ~line 349, `_run_child` ~line 389)

- [ ] **Step 1: Add `progress_queue` + `depth` params to `dispatch_subtasks`**

Change the signature (currently ends at `max_parallel: int = 3,`) to add two params, and forward them into `_create_sub_agent_session`. Replace the signature block:

```python
    async def dispatch_subtasks(
        self,
        parent_session_id: str,
        subtasks: list[dict],
        parent_owner: str = "local",
        max_parallel: int = 3,
        progress_queue=None,
        depth: int = 0,
    ) -> list[dict]:
```

Then in the chunk loop, update the `_create_sub_agent_session` call (currently passes `parent_session_id`, `subtask`, `owner`, `dispatch_id`) to also pass the queue and depth:

```python
                    for subtask in chunk:
                        task_info = await self._create_sub_agent_session(
                            parent_session_id=parent_session_id,
                            subtask=subtask,
                            owner=parent_owner,
                            dispatch_id=dispatch_id,
                            progress_queue=progress_queue,
                            depth=depth,
                        )
                        chunk_tasks.append(task_info)
```

- [ ] **Step 2: Add `progress_queue` + `depth` params to `_create_sub_agent_session` and a safe emit helper**

Change the signature (currently `parent_session_id, subtask, owner, dispatch_id`) to:

```python
    async def _create_sub_agent_session(
        self,
        parent_session_id: str,
        subtask: dict,
        owner: str,
        dispatch_id: str,
        progress_queue=None,
        depth: int = 0,
    ) -> dict:
```

Immediately after the line `hat_id = subtask.get("hat", "sub-ic")` (near the top of the method body), add a local emit helper:

```python
        def _emit(phase: str, **extra):
            if progress_queue is None:
                return
            try:
                progress_queue.put_nowait({
                    "phase": phase,
                    "name": subtask.get("name", "Unnamed Task"),
                    "hat": hat_id,
                    "depth": depth,
                    **extra,
                })
            except Exception:
                pass  # never let UI plumbing break the actual dispatch
```

- [ ] **Step 3: Emit `spawned` right after the child session is registered**

After the existing block that appends `child_info` to `dispatch_state["children"]` (the `if dispatch_state: dispatch_state["children"].append(child_info)` lines), add:

```python
        _emit("spawned", session_id=child_session_id)
```

- [ ] **Step 4: Instrument `_run_child` to emit thinking / token / tool / done / failed**

Replace the entire `async def _run_child():` body (currently lines ~389-422, from `result_text = ""` through the final `else:` return) with this instrumented version:

```python
        async def _run_child():
            result_text = ""
            first_token = True
            try:
                async for event in self._engine.chat_session(
                    child_session_id, subtask.get("context", ""), owner=owner
                ):
                    ev = event["event"]
                    if ev == "token":
                        if first_token:
                            first_token = False
                            _emit("thinking", session_id=child_session_id)
                        text = event["data"]["text"]
                        result_text += text
                        _emit("token", session_id=child_session_id, text=text)
                    elif ev == "tool_call":
                        _emit("tool", session_id=child_session_id,
                              tool=event["data"].get("name", "tool"))
                    elif ev == "done":
                        result_text += event["data"].get("full_response", "")

                parsed = parse_delegation_markers(result_text)

                # If child also delegates, recurse (pass the queue + deeper depth down)
                if parsed["decision"] == "DELEGATE" and parsed["subtasks"]:
                    sub_results = await self.dispatch_subtasks(
                        child_session_id,
                        parsed["subtasks"],
                        owner=owner,
                        progress_queue=progress_queue,
                        depth=depth + 1,
                    )
                    _emit("done", session_id=child_session_id,
                          result=f"delegated {len(parsed['subtasks'])} subtasks")
                    return {
                        "name": child_info["name"],
                        "status": "completed",
                        "delegation": parsed,
                        "sub_results": sub_results,
                        "session_id": child_session_id,
                    }
                else:
                    summary = parsed.get("result")
                    if isinstance(summary, dict):
                        summary = summary.get("message") or summary.get("status") or str(summary)
                    summary = (str(summary)[:120] if summary else parsed.get("decision", "completed"))
                    _emit("done", session_id=child_session_id, result=summary)
                    return {
                        "name": child_info["name"],
                        "status": "completed",
                        "decision": parsed["decision"],
                        "result": parsed["result"],
                        "session_id": child_session_id,
                    }
            except Exception as e:
                _emit("failed", session_id=child_session_id, error=str(e))
                raise
```

- [ ] **Step 5: Verify Python parses**

Run from `C:\github\localllm-abuddi`:

```bash
python -c "import ast; ast.parse(open('agent_orchestrator.py', encoding='utf-8').read()); print('OK')"
```

Expected: prints `OK` with no SyntaxError.

- [ ] **Step 6: Commit**

```bash
git add agent_orchestrator.py
git commit -m "feat(orchestrator): emit per-sub-agent progress events via optional queue"
```

(If not a git repo, skip — see pre-flight notes.)

---

## Task 2: Backend — stream the queue from the abuddi-deepseek backend

Replace the blocking `await orchestrator.dispatch_subtasks(...)` with a queue-drain loop that yields `subagent` chunks live.

**Files:**
- Modify: `C:\github\localllm-abuddi\backends\abuddi_deepseek.py` (delegation block ~lines 136-160; imports at top)

- [ ] **Step 1: Ensure `asyncio` is imported**

Confirm the top of `abuddi_deepseek.py` imports asyncio. Run:

```bash
python -c "import re; s=open(r'C:\github\localllm-abuddi\backends\abuddi_deepseek.py',encoding='utf-8').read(); print('asyncio' in re.findall(r'^import (\w+)', s, re.M))"
```

If it prints `False`, add `import asyncio` to the import block at the top of the file. If `True`, do nothing.

- [ ] **Step 2: Replace the delegation body with the queue-drain loop**

In the `else:` branch (the one whose comment is `# Delegate to sub-agents`), replace everything from the line:

```python
                yield {"type": "token", "text": "\n\n[ABUDDI] Delegating to sub-agents...\n"}
```

down through the end of its `try:` block (the lines that do `orchestrator = get_orchestrator(engine)`, `results = await orchestrator.dispatch_subtasks(...)`, build `synthesis`, and yield the `response`) with:

```python
                yield {"type": "token", "text": "\n\n[ABUDDI] Delegating to sub-agents...\n"}

                try:
                    # Import engine lazily to avoid circular imports
                    import engine

                    orchestrator = get_orchestrator(engine)
                    queue: asyncio.Queue = asyncio.Queue()

                    # Announce the roster up front so the UI can draw all cards
                    yield {
                        "type": "subagent",
                        "data": {
                            "phase": "start",
                            "subtasks": [
                                {"name": st.get("name", "Unnamed Task"),
                                 "hat": st.get("hat", "sub-ic")}
                                for st in parsed["subtasks"]
                            ],
                        },
                    }

                    dispatch_task = asyncio.create_task(
                        orchestrator.dispatch_subtasks(
                            parent_session_id=self._get_session_id(messages),
                            subtasks=parsed["subtasks"],
                            parent_owner="local",
                            progress_queue=queue,
                        )
                    )

                    # Drain progress events while children run; stop once the
                    # dispatch task is finished AND the queue is fully drained.
                    while True:
                        try:
                            event = await asyncio.wait_for(queue.get(), timeout=0.1)
                            yield {"type": "subagent", "data": event}
                        except asyncio.TimeoutError:
                            if dispatch_task.done():
                                while not queue.empty():
                                    yield {"type": "subagent", "data": queue.get_nowait()}
                                break

                    results = dispatch_task.result()  # re-raises if dispatch failed

                    # Synthesize results
                    synthesis = self._synthesize_results(parsed, results)
                    yield {"type": "token", "text": synthesis}

                    # Yield final response with delegation results
                    yield {
                        "type": "response",
                        "content": full_content + synthesis,
                        "tool_calls": normalized_tool_calls,
                    }
```

> Leave the existing `except Exception as e:` block (the `[ABUDDI ERROR]` fallback) exactly as it is — it now also catches a re-raised dispatch failure from `dispatch_task.result()`.

- [ ] **Step 3: Verify Python parses**

```bash
python -c "import ast; ast.parse(open(r'C:\github\localllm-abuddi\backends\abuddi_deepseek.py', encoding='utf-8').read()); print('OK')"
```

Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add backends/abuddi_deepseek.py
git commit -m "feat(abuddi): stream live sub-agent progress events during delegation"
```

---

## Task 3: Backend — pass the `subagent` chunk through the engine

**Files:**
- Modify: `C:\github\localllm-abuddi\engine.py` (the `async for chunk in backend.stream(...)` loop, ~line 362)

- [ ] **Step 1: Add the passthrough branch**

The loop currently has `if chunk["type"] == "token": ... yield {"event": "token", ...}` followed by `elif chunk["type"] == "response": ...`. Add a new `elif` branch between them (or immediately after the token branch):

```python
                elif chunk["type"] == "subagent":
                    yield {"event": "subagent", "data": chunk["data"]}
```

- [ ] **Step 2: Verify Python parses**

```bash
python -c "import ast; ast.parse(open(r'C:\github\localllm-abuddi\engine.py', encoding='utf-8').read()); print('OK')"
```

Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add engine.py
git commit -m "feat(engine): pass subagent progress chunks through to SSE stream"
```

---

## Task 4: Backend smoke test — confirm `subagent` SSE events stream live

Verify the wire format before touching the UI.

**Files:** none (manual verification)

- [ ] **Step 1: Start the stack**

From `C:\github\deepconsole`: `npm run dev`. Wait until the app shows "Ready" (backend healthy on port 8000).

- [ ] **Step 2: Create a session and send a delegating prompt via curl, watching the raw SSE**

In a separate terminal:

```bash
# Create a session
SID=$(curl -s -X POST http://127.0.0.1:8000/sessions -H "Content-Type: application/json" -d "{}" | python -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "session=$SID"

# Send a high-complexity prompt and stream the SSE; grep for our new event type
curl -sN -X POST "http://127.0.0.1:8000/sessions/$SID/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Build a complete multi-file authentication system with login UI, session storage, password hashing, and an admin dashboard.\"}" \
  | grep --line-buffered -E "event: subagent|\"phase\""
```

Expected: you see a `start` event listing the subtasks, followed by a live stream of `spawned`, `thinking`, `tool`, `token`, and `done` phases **arriving incrementally** (not all at once at the end). If they all dump at the end, the queue-drain loop in Task 2 is wrong — recheck that `dispatch_subtasks` is launched via `asyncio.create_task` and not awaited directly.

- [ ] **Step 3: Confirm graceful degradation**

Confirm the final assistant message still contains the `## ABUDDI Delegation Results` synthesis block (i.e. the new streaming did not eat the final response). If delegation legitimately can't run in your environment, confirm you still get an `[ABUDDI ERROR]` token and the stream ends cleanly rather than hanging.

---

## Task 5: Frontend — delegation panel styles

Add the CSS for the hybrid panel. Build markup in JS (Task 6), so no `index.html` change is needed.

**Files:**
- Modify: `C:\github\deepconsole\renderer\style.css` (append at end of file)

- [ ] **Step 1: Append the panel styles**

Add to the end of `style.css`:

```css
/* ─── ABUDDI Delegation Panel ─────────────────────────────── */
.delegation-panel {
  margin: 10px 0 10px 44px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  overflow: hidden;
}
.delegation-header {
  padding: 8px 12px;
  font-weight: 600;
  color: var(--accent);
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.delegation-cards { padding: 8px; display: flex; flex-direction: column; gap: 8px; }

.agent-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg-primary);
  transition: border-color .25s ease;
}
.agent-card.nested { margin-left: 22px; border-style: dashed; }
.agent-card.active { border-color: var(--accent); animation: agent-wiggle 1.6s ease-in-out infinite; }
.agent-card.done { border-color: var(--success); animation: none; }
.agent-card.failed { border-color: var(--error); animation: none; }

.agent-card-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.agent-card-icon { font-size: 15px; }
.agent-card-name { font-weight: 600; color: var(--text-primary); }
.agent-card-status { margin-left: auto; font-size: 11px; color: var(--text-muted); }
.agent-card.done .agent-card-status { color: var(--success); }
.agent-card.failed .agent-card-status { color: var(--error); }

.agent-bar { height: 5px; border-radius: 3px; background: var(--bg-tertiary); margin: 7px 0; overflow: hidden; }
.agent-bar-fill {
  height: 100%; width: 8%; border-radius: 3px;
  background: var(--accent); transition: width .3s ease;
}
.agent-card.active .agent-bar-fill { background-size: 200% 100%; animation: agent-shimmer 1.2s linear infinite;
  background-image: linear-gradient(90deg, var(--accent), var(--text-secondary), var(--accent)); }
.agent-card.done .agent-bar-fill { background: var(--success); width: 100% !important; }
.agent-card.failed .agent-bar-fill { background: var(--error); width: 100% !important; }

.agent-activity { font-size: 11px; color: var(--text-secondary); font-family: monospace; }
.agent-activity .act-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-ticker { font-size: 11px; color: var(--text-muted); font-style: italic; min-height: 14px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.delegation-panel.collapsed .delegation-cards { display: none; }

@keyframes agent-wiggle {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-1.5px); }
  75% { transform: translateX(1.5px); }
}
@keyframes agent-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

- [ ] **Step 2: Commit**

```bash
git add renderer/style.css
git commit -m "feat(ui): styles for ABUDDI delegation panel"
```

---

## Task 6: Frontend — render and update the delegation panel

Add a module-level hat-icon map, panel state, builder/updater functions, and the `case 'subagent'` handler.

**Files:**
- Modify: `C:\github\deepconsole\renderer\app.js` (add helpers near `addToolCall` ~line 271; add case in SSE switch ~line 448; reuse map at ~line 774)

- [ ] **Step 1: Add a module-level hat-icon map and panel state**

Near the top of `app.js`, after the existing top-level `let` declarations (e.g. near `let currentMessageBubble` / `let recentToolBuffer`), add:

```js
// Reused by both the delegation panel and the agents list (line ~774)
const HAT_ICONS = {
  'product-maestro': '👑', 'feature-owner': '⭐', 'sub-ic': '🔧',
  'synthesizer': '🧩', 'browser_commander': '🌐', 'code_implementer': '💻',
};
function hatIcon(hat) { return HAT_ICONS[hat] || '🤖'; }

let delegationPanel = null; // { el, cardsEl, cards: Map<name, cardObj>, header }
```

- [ ] **Step 2: Add the panel builder + card factory + updater**

Add these functions right after `addToolResult` (~line 302):

```js
// ─── ABUDDI Delegation Panel ────────────────────────────────
function makeAgentCard(name, hat, depth) {
  const el = document.createElement('div');
  el.className = 'agent-card' + (depth > 0 ? ' nested' : '');
  el.innerHTML = `
    <div class="agent-card-head">
      <span class="agent-card-icon">${hatIcon(hat)}</span>
      <span class="agent-card-name"></span>
      <span class="agent-card-status">queued</span>
    </div>
    <div class="agent-bar"><div class="agent-bar-fill"></div></div>
    <div class="agent-activity"><div class="act-line"></div></div>
    <div class="agent-ticker"></div>`;
  el.querySelector('.agent-card-name').textContent = name;
  return {
    el,
    statusEl: el.querySelector('.agent-card-status'),
    barEl: el.querySelector('.agent-bar-fill'),
    actEl: el.querySelector('.act-line'),
    tickerEl: el.querySelector('.agent-ticker'),
    pct: 8,
    buf: '',
    lastTick: 0,
  };
}

function startDelegationPanel(subtasks) {
  finishStreaming();
  const el = document.createElement('div');
  el.className = 'delegation-panel';
  el.innerHTML = `<div class="delegation-header">${subtasks.length} agent${subtasks.length === 1 ? '' : 's'} deployed</div>
    <div class="delegation-cards"></div>`;
  const cardsEl = el.querySelector('.delegation-cards');
  const cards = new Map();
  subtasks.forEach((st) => {
    const card = makeAgentCard(st.name, st.hat, 0);
    cardsEl.appendChild(card.el);
    cards.set(st.name, card);
  });
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  delegationPanel = { el, cardsEl, cards, header: el.querySelector('.delegation-header') };
}

function getOrCreateCard(name, hat, depth) {
  if (!delegationPanel) return null;
  let card = delegationPanel.cards.get(name);
  if (!card) {
    card = makeAgentCard(name, hat, depth || 0);
    delegationPanel.cardsEl.appendChild(card.el);
    delegationPanel.cards.set(name, card);
  }
  return card;
}

function handleSubagentEvent(data) {
  if (data.phase === 'start') {
    startDelegationPanel(data.subtasks || []);
    return;
  }
  if (!delegationPanel) startDelegationPanel([]); // robustness if 'start' was missed
  const card = getOrCreateCard(data.name, data.hat, data.depth || 0);
  if (!card) return;

  switch (data.phase) {
    case 'spawned':
      card.statusEl.textContent = 'spawned';
      card.el.classList.add('active');
      card.pct = Math.max(card.pct, 12);
      card.barEl.style.width = card.pct + '%';
      break;
    case 'thinking':
      card.statusEl.textContent = 'thinking';
      card.el.classList.add('active');
      card.pct = Math.max(card.pct, 25);
      card.barEl.style.width = card.pct + '%';
      break;
    case 'tool':
      card.actEl.textContent = `🔧 ${data.tool || 'tool'}`;
      card.pct = Math.min(90, card.pct + 12);
      card.barEl.style.width = card.pct + '%';
      break;
    case 'token': {
      card.buf += data.text || '';
      const now = Date.now();
      if (now - card.lastTick > 200) {        // throttle: <= 5 updates/sec
        card.lastTick = now;
        card.tickerEl.textContent = card.buf.replace(/\s+/g, ' ').slice(-80);
      }
      break;
    }
    case 'done':
      card.el.classList.remove('active');
      card.el.classList.add('done');
      card.statusEl.textContent = '✓ done';
      card.barEl.style.width = '100%';
      if (data.result) card.actEl.textContent = `→ ${String(data.result).slice(0, 100)}`;
      card.tickerEl.textContent = '';
      break;
    case 'failed':
      card.el.classList.remove('active');
      card.el.classList.add('failed');
      card.statusEl.textContent = '✗ failed';
      card.barEl.style.width = '100%';
      if (data.error) card.actEl.textContent = `✗ ${String(data.error).slice(0, 100)}`;
      card.tickerEl.textContent = '';
      break;
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function collapseDelegationPanel() {
  if (!delegationPanel) return;
  let done = 0, failed = 0, total = delegationPanel.cards.size;
  delegationPanel.cards.forEach((c) => {
    if (c.el.classList.contains('done')) done++;
    else if (c.el.classList.contains('failed')) failed++;
  });
  const failTxt = failed ? ` · ${failed} ✗` : '';
  delegationPanel.header.textContent = `${total} agent${total === 1 ? '' : 's'} · ${done} ✓${failTxt}`;
  delegationPanel.el.classList.add('collapsed');
  delegationPanel = null;
}
```

- [ ] **Step 3: Wire the `subagent` case into the SSE switch**

In `sendMessage`'s event switch (~line 448, alongside `case 'warning':`), add:

```js
        case 'subagent':
          handleSubagentEvent(data);
          break;
```

- [ ] **Step 4: Collapse the panel when the turn finishes**

In the same switch, in `case 'done':` (~line 440) and `case 'error':` (~line 452), add `collapseDelegationPanel();` as the first line of each block. For `case 'done':` it becomes:

```js
        case 'done':
          collapseDelegationPanel();
          finishStreaming();
          agentControls.style.display = 'none';
          setStatus('online', 'Ready');
          lastAIMessage = streamBuffer;
          streamBuffer = '';
          break;
```

And add `collapseDelegationPanel();` as the first line inside `case 'error':` as well.

- [ ] **Step 5: De-duplicate the old hat-icon map (reuse the new constant)**

At ~line 774 there is a local `const hatIcons = { ... }`. Delete that local declaration and replace any `hatIcons[...]` usage in that function with `hatIcon(...)` (the new helper). Verify there are no remaining references:

```bash
grep -n "hatIcons" C:\github\deepconsole\renderer\app.js
```

Expected: no output (all references now go through `HAT_ICONS` / `hatIcon`).

- [ ] **Step 6: Commit**

```bash
git add renderer/app.js
git commit -m "feat(ui): live ABUDDI delegation panel — cards, progress, ticker, collapse"
```

---

## Task 7: End-to-end manual verification

**Files:** none (manual)

- [ ] **Step 1: Launch and trigger a delegation**

From `C:\github\deepconsole`: `npm run dev`. When Ready, send the delegating prompt from Task 4 Step 2 in the chat UI.

- [ ] **Step 2: Verify the live visual**

Confirm, in order:
- A `N agents deployed` panel appears inline at the delegation point.
- Each sub-agent card shows status moving `queued → spawned → thinking`, with the bar animating and the card wiggling while active.
- Tool calls appear as `🔧 <tool>` activity lines; the token ticker shows live text that updates smoothly (not jittery — confirms the 200ms throttle).
- Each card settles to `✓ done` (green, bar full) with a `→ result` line; any failure shows `✗ failed` (red).
- When the turn completes, the panel header collapses to `N agents · M ✓` and the cards hide.
- The final assistant message still contains the `## ABUDDI Delegation Results` synthesis.

- [ ] **Step 3: Verify a non-delegating prompt is unaffected**

Send a trivial prompt (e.g. "say hello"). Confirm no delegation panel appears and normal streaming works exactly as before.

- [ ] **Step 4: Final checkpoint commit**

```bash
git add -A
git commit -m "feat: live ABUDDI sub-agent delegation visual"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** Real streamed progress (Tasks 1-3), inline placement (Task 6 `startDelegationPanel` appends to `chatMessages`), hybrid style (Task 5), all four detail depths — status (spawned/thinking/done/failed), tool calls, token ticker, result summary (Tasks 1 + 6). Heuristic progress bar (Task 6 `pct` logic). Token throttle ≤5/sec (Task 6 `case 'token'`). Failure-safe fallback preserved (Task 2 note). Recursion → nested indented cards (Task 1 depth threading + Task 5 `.nested` + Task 6 `getOrCreateCard`). Collapse on done (Task 6 `collapseDelegationPanel`). All spec sections map to a task.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code.
- **Type/name consistency:** Event schema keys (`phase`, `name`, `hat`, `session_id`, `depth`, `tool`, `text`, `result`, `error`) are identical across producer (Task 1 `_emit`), wire (Task 2/3), and consumer (Task 6 `handleSubagentEvent`). `subagent` chunk/event name matches across `abuddi_deepseek.py` → `engine.py` → `app.js`. Helper names (`hatIcon`, `HAT_ICONS`, `startDelegationPanel`, `getOrCreateCard`, `handleSubagentEvent`, `collapseDelegationPanel`, `makeAgentCard`) are defined before use and referenced consistently.
