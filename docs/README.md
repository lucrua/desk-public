# Desk docs

Map of this directory. **New here? Read in this order:** root `README.md` → `architecture.md` → `consolidation-and-decisions.md`. The agent keystone is the root `AGENTS.md` (loaded via `CLAUDE.md`).

| Doc | What it is |
|---|---|
| [`../README.md`](../README.md) | What Desk is + the feature surface (the product overview). |
| [`../AGENTS.md`](../AGENTS.md) | Agent keystone — the model in one screen, dev/deploy context, conventions, the access boundary. |
| [`architecture.md`](architecture.md) | **The foundational design + *why*** — one-source/many-doors, truth-vs-projection, the space/share access model, packs, the headless-agent workflow, the Phase‑1/2 build contracts. *(Source of truth for the model.)* |
| [`consolidation-and-decisions.md`](consolidation-and-decisions.md) | The Gen‑1→Gen‑2 **consolidation**: every decision (D1–D9), what was removed/retired (audiences, upload), the current feature inventory, and what's deferred (packs, the agent runner). Web authoring + external collaboration + doc-identity have since **shipped to `main`**; the next queued work is [`specs/convergence-fix-pass.md`](specs/convergence-fix-pass.md). |
| [`account-merge-runbook.md`](account-merge-runbook.md) | Ops runbook — merging user accounts (REST-only; space-scoped). |
| [`cutover-checklist.md`](cutover-checklist.md) | Deploy/cutover checklist (Gen‑2 env, the `/api/git/*` CF bypass, bare-repo backups). |
| [`plans/`](plans/) | Historical build-plan snapshots (dated; not current state). |
| [`screenshots/`](screenshots/) | UI captures. ⚠ Several predate the consolidation (e.g. `17-upload-modal`, `12-docs-member-scoped`) and show the retired Gen‑1 model — regenerate when convenient. |

**Provenance:** `architecture.md` and `consolidation-and-decisions.md` were brought in from the design workspace's `specs/desk/` on 2026-06-23 (formerly `design-document-host.md` + `consolidation-plan.md`). **This repo is now the home for Desk's docs** — keep them current here; the workspace copies are historical. Internal cross-references inside those two docs to other `specs/desk/*` files point to that historical workspace.
