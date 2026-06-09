# 12: Implementation Plan and Task Tracker

**Format follows `docs/architecture/collab-plan.md`. Status legend: ☐ pending · ◐ in progress · ☑ done · ⚠ blocked.**
Feature flag: `layers.enabled`. Every phase lands on `main` only with green exit criteria. Changesets for every published-package touch; MPL headers; ~400 LOC file cap; no `as any`; tests per feature.

---

## Phase L0: Spec + tombstones (2 weeks)

- ☑ `docs/architecture/layer-prs/` (this set) merged; tracking issue opened referencing collab-plan §2/§12.4
- ☑ Tombstone opinions in `packages/ifcx/src/composition.ts` (`ifclite::deleted`, shadow + resurrect semantics, child-path shadowing) + tests against hello-wall fixture
- ☑ Deletions in `packages/collab/src/snapshot/minimal-layer.ts` (close the documented deferral)
- ☑ `bake` composer mode (tombstone-free materialization)
- ☐ Strawman to Thomas (deletion overlays + derived-tier merge rule as geometry-tiers use cases); panel work-item proposal to Evandro

**Exit:** stack with tombstones composes correctly in viewer + CLI; round-trip test layer→compose→bake→reparse green; at least one substantive panel response.

## Phase L1: Canonical form + publish (2 weeks)

- ☑ Canonical serialization + blake3 ids (`packages/ifcx`: `canonical.ts`; rule set 02 §2.4) with cross-adapter byte-identity tests
- ☑ Provenance manifest types + validation (`packages/ifcx`: `provenance.ts`, manifest SemVer v1)
- ☑ `publishLayer(session, {intent, scope_claim})` in `packages/collab/src/snapshot/` (freeze, canonicalize, hash, manifest, run declared checks via `@ifc-lite/ids`)
- ☑ expressId→GlobalId bridge: `packages/mutations/src/change-set-to-ops.ts` (+ identity fallback per 04 §4.1(3))
- ☑ Ref file format + `ifc ref` basics (local mode)

**Exit:** end-to-end: open model → CRDT edits → `publishLayer` → immutable layer with valid manifest, checks attached; hash stable across browser/node/CLI adapters.

## Phase L2: Three-way merge (3 weeks)

- ☑ Per-componentKey sub-hash mode in `packages/diff/src/fingerprint.ts` (opt-in; existing whole-blob tests untouched)
- ☑ `packages/merge`: three-way engine on `EntityFingerprint`, decision matrix 05 §5.3, relation triples, MergePlan + conflict records (taxonomy from `collab/conflicts`)
- ☑ Merge-layer emission (resolution ops + `manifest.merge`); rebase = re-run plan
- ◐ Golden-file suite: the conflict table as fixtures via `pnpm fixtures` infra; fuzz: random op partitions over a real model must never lose ops
- ☑ CLI: `ifc layer create|status|publish|diff|merge --preview|log|revert|rebase` with stable exit codes
- ☐ Benchmarks: three-way plan < 1s on 1M-entity fixture; publish to perf docs

**Exit:** two divergent layers over a real model merge with correct auto/conflict split in CI; demo recording of CLI flow.

## Phase L3: Agent write path (2 weeks)

- ☑ MCP tool family 06 §6.3 in `packages/mcp` (draft lifecycle, dry_run_merge via `extensions/dryrun` pattern, review feedback loop)
- ◐ Write-time scope enforcement wiring (`extensions/capability/match.ts` at op level); publish-time claim-vs-ops verification; audit events into `extensions/audit`
- ☐ **Launch demo:** agent reclassifies fire-safety Psets on a BFH model → publishes scoped layer → `fire-zones.ids` required check green → human merges via CLI. Recorded, benchmarked, posted
- ☐ GitHub Action `ifc-layer-action` (09 §9.2), zero-registry mode

**Exit:** the demo runs unattended from a single prompt; scope-violation and check-failure paths demonstrably block; LinkedIn/bSI assets shipped.

## Phase L4: Review UI (5-6 weeks, scheduled post-Grobkonzept)

- ☐ Viewer diff mode promoted from compare example into `packages/viewer` (ghosting, diff-state lens via `@ifc-lite/lens`, author-kind lens)
- ☐ Conflict queue + per-entity/bulk resolution; component panel on shared diff JSON
- ☐ Checks panel with IDS deep links; waiver flow
- ☐ Provenance panel; BCF topics as review comments (`@ifc-lite/bcf`)
- ☐ BCF Time Machine on the layer DAG (scrub, branch nodes, open-historical-state)

**Exit:** full agent-proposes / human-reviews / merge loop entirely in the browser; usability session with one BFH cohort.

## Phase L5: Registry (ongoing)

- ☐ Push/pull by id + ref DB + PR objects on `collab-server`/`apps/server`; webhooks
- ☐ Ref policies (required checks, reviewers, author-kind, risk-tier, auto-merge) enforced server-side
- ☐ Registry attestation; optional ed25519 signing; provenance/audit search
- ☐ Team tier pricing alongside Tauri track; public reference registry for teaching
- ☐ Nightly model-gardener agent on auto-merge policy (first fully autonomous loop)

**Exit:** one external design partner (Motif candidate) running a protected ref with an agent principal in production.

## Cross-cutting

- ☐ One diff/MergePlan JSON schema consumed identically by CLI, MCP, UI (contract tests)
- ☐ Perf budgets in CI (02 §2.5, 05 §5.7)
- ☐ Spec-set versioning: manifest SemVer; composition behavior behind `layers.enabled`
- ⚠ Open problems parked deliberately: heuristic identity (04 §4.5), cross-schema identity, deletion-overlay upstream standardization (tracked with panel)

## Dependency graph

L0 → L1 → L2 → {L3, L4} → L5. L3 before L4 on purpose: the agent demo needs only the CLI, and it is the narrative asset; the UI amplifies an already-proven loop.
