# DeepConsole Onboarding Docs Site + v1.0.0 Release — Design

**Date:** 2026-06-21
**Status:** Approved (design), pending spec review

## Overview

Stand up a GitHub Pages onboarding/documentation site for DeepConsole and cut a
`v1.0.0` source release. The site's job: take someone from "found the repo" to
"app running locally," then document how the system works. The app runs from
source (it needs the sibling `abuddi` backend, Python, and a DeepSeek key), so
the release is a tagged source release with good notes — no binaries.

## Goals

- A polished, multi-page static docs site, themed to match DeepConsole's dark UI.
- Honest, copy-paste onboarding for the real two-repo setup (`deepconsole` + `abuddi`).
- A `v1.0.0` GitHub Release on `superness/deepconsole` with clear notes.

## Non-Goals (YAGNI)

- No installer/binaries, no `electron-builder`.
- No client-side search, blog, analytics, or framework (React/Docusaurus).
- No backend (`abuddi`) docs site — it links back to `deepconsole`.

## Approach

Hand-rolled static HTML/CSS (no build toolchain, no generator). Content is
adapted from the existing public `README.md` and `CLAUDE.md`. Chosen over MkDocs
Material / Jekyll for brand-consistent theming and zero maintenance toolchain.

## Site structure

Lives in a top-level `site/` directory in the `deepconsole` repo. Five pages,
each sharing one stylesheet (`site/assets/style.css`) and an inline header nav.

| Page | File | Content source |
|------|------|----------------|
| Home / Quickstart | `site/index.html` | README pitch + screenshot; prerequisites; copy-paste setup; release link |
| Architecture | `site/architecture.html` | CLAUDE.md "Process model", "Data flow for chat", DeepSeek-V4/ABUDDI, 3-tier memory |
| Browser Automation | `site/browser-automation.html` | CLAUDE.md "Driving the browser" + endpoint table |
| Multi-instance & Overmind | `site/overmind.html` | CLAUDE.md "Multi-instance & the Overmind" + autonomous worker mode |
| Troubleshooting | `site/troubleshooting.html` | New: backend won't start, port conflicts, missing key, Python deps |

Assets: `site/assets/style.css`, `site/assets/screenshot.png` (copied from
`C:\github\screenshot.png` after confirming it shows the app UI).

### Theme

Dark palette echoing `renderer/style.css` (near-black background, accent color,
monospace code blocks). Shared top nav linking the five pages + a GitHub link.
Responsive single-column layout; no JS required.

## Hosting / deploy

GitHub Pages via Actions (`actions/upload-pages-artifact` + `actions/deploy-pages`)
publishing the `site/` directory. Workflow at `.github/workflows/pages.yml`,
triggered on push to `main` touching `site/**`. Keeps the marketing site separate
from `docs/` (which holds internal specs). Result URL: `https://superness.github.io/deepconsole/`.

Relative links between pages (e.g. `architecture.html`) so the project sub-path
in the Pages URL resolves correctly.

## Release plan

Tag `v1.0.0` on `superness/deepconsole` via `gh release create`. Notes cover:
what DeepConsole is, the two-repo model, requirements, quickstart pointer, and a
link to the docs site. Backend `abuddi` tag is optional and deferred (confirm first).

## Success criteria

- `https://superness.github.io/deepconsole/` serves the five-page site, styled, nav working.
- A fresh reader can follow Quickstart to a running app without prior context.
- `gh release view v1.0.0 --repo superness/deepconsole` shows the published release.
- No secrets/private data added (all content derived from already-public README/CLAUDE.md).
