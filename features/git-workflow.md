# DeepConsole Git Workflow Feature

## Concept

All code changes in DeepConsole should go through a structured **git branch → pull request → merge** workflow. The AI (DeepSeek) should create feature branches for code changes, have them reviewed by a "Claude session" (via the existing ClaudePlus proxy at port 8081), and only merge after approval.

This mirrors how Dr. Claude currently works for debugging — but generalized to **every meaningful code change**.

## Architecture

### 1. `git_workflow.py` — Backend Module (in localllm-abuddi/)

New module that provides:
- `create_branch(branch_name: str, base: str = "main")` — creates and checks out a new git branch
- `stage_and_commit(message: str, files: list[str])` — stages specific files + commits
- `create_pr(title: str, description: str)` — uses `gh` CLI to create a PR (or falls back to preparing instructions)
- `request_review(branch_name: str)` — sends the diff to ClaudePlus for review
- `merge_branch(branch_name: str)` — merges the PR/branch back to main

### 2. ClaudePlus Review Integration

The review step reuses the existing ClaudePlus proxy at port 8081 (same as Dr. Claude). 
When a review is requested:
1. Get the `git diff main...{branch}` output
2. Package it with the files changed, a summary of what was done
3. POST to ClaudePlus `/api/chat/send` with a review prompt
4. Stream back the review as SSE events
5. The AI agent can then either approve (merge) or request changes

### 3. AI Tool Integration (tools.py)

New AI-callable tools:
- `code_workflow_start(task: str)` — Create a feature branch + ask "what files will change?"
- `code_workflow_submit(files: list[str], description: str)` — Stage, commit, request Claude review
- `code_workflow_review_status()` — Check if Claude has reviewed yet
- `code_workflow_merge()` — Merge the approved branch to main
- `code_workflow_abort()` — Abandon the branch, go back to main

### 4. Auto-Intercept Code Changes

Modify the AI's system prompt (engine.py) so that when the AI calls `write_file`, `edit_file`, or `append_file`, it MUST first:
1. Pause and create a feature branch if one doesn't exist
2. Make the change
3. Commit with a descriptive message
4. Request Claude review
5. Only merge if Claude approves

### 5. FastAPI Endpoints (server.py)

- `POST /workflow/start` — Create branch
- `POST /workflow/submit` — Commit + request review
- `GET /workflow/status` — Get review status
- `POST /workflow/merge` — Merge branch
- `POST /workflow/abort` — Abort workflow

### 6. IPC + UI (Optional)

- A "Git Workflow" tab or status bar showing active branch, pending reviews
- `git_workflow_status` IPC handler to show what's happening

## Implementation Files

| File | Change |
|------|--------|
| `localllm-abuddi/git_workflow.py` | NEW — core module |
| `localllm-abuddi/engine.py` | MODIFY — inject git workflow rules into system prompt |
| `localllm-abuddi/tools.py` | MODIFY — add 5 new tools + schemas |
| `localllm-abuddi/server.py` | MODIFY — add 5 FastAPI endpoints |
| `deepconsole/main.js` | MODIFY — add IPC handlers + Claude proxy for reviews |
| `deepconsole/preload.js` | MODIFY — add bridge functions |
| `deepconsole/renderer/index.html` | MODIFY — optional status bar indicator |
| `deepconsole/renderer/app.js` | MODIFY — optional UI updates |

## ClaudePlus API (reuse existing)

The existing Dr. Claude integration at `main.js:451-539` shows:
- Endpoint: `http://127.0.0.1:8081/api/chat/send`
- Method: POST with `{ message, workingDirectory }`
- Response: `{ requestId }` 
- Stream: GET `http://127.0.0.1:8081/api/chat/stream/{requestId}`
- Stream events: `event: token` (data: {text}), `event: done` (data: {response}), `event: error`

## Example Flow

1. User says: "Add a new brain worm type"
2. AI calls `code_workflow_start("Add data-loss worm that detects stale entries")` → creates branch `feature/data-loss-worm`
3. AI writes code files (brain_worms.py changes, etc.)
4. AI calls `code_workflow_submit(["brain_worms.py", "server.py"], "Add data-loss worm type")` → stages, commits, sends diff to ClaudePlus
5. ClaudePlus reviews the diff and either approves or suggests changes
6. If approved, AI calls `code_workflow_merge()` → merges to main
7. If changes requested, AI fixes and calls `code_workflow_submit()` again
