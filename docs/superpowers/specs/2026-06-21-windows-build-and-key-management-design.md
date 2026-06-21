# DeepConsole Windows Build + Built-in Key Management — Design

**Date:** 2026-06-21
**Status:** Approved (design), pending spec review

## Overview

Two coupled deliverables:

1. A real **downloadable Windows installer** for DeepConsole with the `abuddi`
   backend **bundled** (no Python or source required).
2. **Built-in DeepSeek API-key management** for **all** run modes (from-source
   and packaged) — replacing the hand-edited `abuddi/.env` with an in-app screen.

The key feature is universal because there's no reason source users should hand-edit
a dotfile while installer users get a UI. The app owns the key in both cases.

## Goals

- One-click Windows installer (NSIS) that runs with no Python and no source.
- Bundled backend as a single PyInstaller executable.
- In-app key entry/store/change, with the key injected into the backend on spawn
  in both dev and packaged modes.
- Installer built in CI and attached to a GitHub Release (**v1.1.0**).

## Non-Goals (YAGNI)

- macOS / Linux builds.
- Overmind / multi-instance in the packaged build (stays a from-source feature).
- Code signing / notarization — installer is unsigned (SmartScreen "unknown
  publisher" warning accepted for now).
- Auto-update.

## Key management (all modes)

`main.js` owns the key; the renderer only collects and displays it.

- **Storage:** Electron `userData`, encrypted with `safeStorage` when available,
  plaintext-file fallback otherwise.
- **IPC / bridge:** `config:getKeyStatus` (returns `{hasKey, masked}`),
  `config:setKey`, `config:clearKey`; exposed as `window.deepconsole.config.*` via
  `preload.js`.
- **Injection:** when spawning the backend (dev `python -m uvicorn …` **or** the
  packaged exe), `main.js` injects `DEEPSEEK_API_KEY` into the child's env from the
  stored key. The backend already reads it from env — minimal backend change.
- **Precedence (back-compat):** stored in-app key wins; if none is stored, fall
  back to any existing `DEEPSEEK_API_KEY` in the environment / `abuddi/.env`, so
  current source setups keep working without entering a key.
- **First-run gate:** if no key resolves and the backend reports unconfigured, the
  renderer shows an "Enter your DeepSeek API key" screen before chat; saving stores
  the key and re-launches/retries the backend.
- **Settings affordance:** view masked key, replace, or clear it.
- **Invalid key:** a DeepSeek `401` is surfaced as a friendly message routed back to
  the key screen.

## Bundled backend

- New `abuddi/run_backend.py`: a frozen-friendly entrypoint that reads host/port
  from env/argv and calls `uvicorn.run(app, …)` (the `python -m uvicorn server:app`
  form does not work from a frozen exe).
- PyInstaller **one-file** build → `abuddi-backend.exe`, with `--collect-all`/hidden
  imports for `uvicorn`/`fastapi` as needed. Built on Windows in CI.

## `main.js` launch logic

- **Dev** (`!app.isPackaged`): spawn `python -m uvicorn server:app` from `../abuddi`
  (unchanged), now with the injected key env.
- **Packaged:** spawn `abuddi-backend.exe` resolved from `process.resourcesPath`,
  with the injected key env.
- **Overmind:** skipped when packaged.
- The existing port-8000 health-check stays; on timeout show an actionable error
  (point at the key gate / logs) instead of hanging silently.

## Packaging (electron-builder)

Add a `build` block to `package.json`:

- `appId: com.superness.deepconsole`, `productName: DeepConsole`, Windows **NSIS**
  target, app icon at `build/icon.ico` (asset to add).
- `extraResources`: copy `abuddi-backend.exe` into `resources/`.
- `files`: allowlist the shipped app (`main.js`, `preload.js`, `browser-preload.js`,
  `renderer/**`, `grimoire_ipc_block.js`, `package.json`); exclude `docs/`, `site/`,
  `tests/`, `overmind/`, specs.
- Output: `DeepConsole-Setup-<version>.exe`.

## CI build workflow

`.github/workflows/build-windows.yml`, `runs-on: windows-latest`, triggered by a
`v*` tag push and `workflow_dispatch`:

1. Checkout `deepconsole`; checkout `superness/abuddi` into `./abuddi`.
2. `setup-python`; `pip install -r abuddi/requirements.txt pyinstaller`; build
   `abuddi-backend.exe`.
3. `setup-node`; `npm install`; `npx electron-builder --win --publish never`.
4. Upload `DeepConsole-Setup-*.exe` as an asset on the tag's GitHub Release.

## Versioning

Bump `package.json` to `1.1.0`, tag `v1.1.0`, attach the installer to the v1.1.0
release.

## Components (units)

1. `abuddi/run_backend.py` — frozen entrypoint *(abuddi repo)*.
2. PyInstaller build → `abuddi-backend.exe` *(CI)*.
3. Key-store module + IPC handlers in `main.js` (`userData` + `safeStorage`).
4. `preload.js` config bridge.
5. Renderer first-run key gate + Settings affordance.
6. `main.js` backend-launch branch + key env injection + skip Overmind when packaged.
7. `package.json` electron-builder config + `build/icon.ico`.
8. `build-windows.yml` CI workflow.

## Error handling

- No key → friendly first-run gate, never a crash.
- Invalid key → 401 surfaced to the gate.
- Backend exe missing/failed → health-check timeout → error with a log pointer.
- AV false-positive on one-file exe → documented; revisit one-dir if it bites.

## Testing

- Unit-test (DOM-free, `node --test`) the key masking + precedence logic.
- Manual: from-source run with an in-app key and **no** `.env` reaches chat;
  installer on a clean Windows profile runs with no Python, key gate works, chat works.
- CI produces an installer artifact.

## Success criteria

- `DeepConsole-Setup-1.1.0.exe` on the v1.1.0 release installs and runs on a clean
  Windows machine with no Python.
- First run prompts for a DeepSeek key, stores it, and chat works.
- From-source run also uses the in-app key (`abuddi/.env` no longer required).

## Cross-repo note

Touches both `superness/deepconsole` (most of the work) and `superness/abuddi`
(`run_backend.py` + the PyInstaller build). Changes must land together.
