# Release status: 0.3.1

Tag: `v0.3.1`
Plugin version: `0.3.1`
Harness peer: `@deepseek-ai/dsh@0.2.0-rc.2`
Runtime reference: community DSH Desktop `2.0.17`

This document is the public, committed release-status record for `0.3.1`. It is a hardening release on top of the published `0.3.0` commit and tag; the `v0.3.0` tag is not moved or rewritten.

## Distribution status

- GitHub tag and release `v0.3.1` are published from this revision.
- The npm publication target is `dsh-compaction-fidelity@0.3.1`.
- DSH Desktop community-market one-click installation requires npm `latest` to resolve to `0.3.1`; the npm publication and marketplace path are not verified until the package is actually published.
- Real three-backend paired evaluation remains pending.

## Hardening in 0.3.1

- Closed workspace-containment gaps: index, anchor, state, purge, and architecture-store writes now reject linked parents that escape the workspace.
- Fixed a pre-step scope-adoption path that could reference a block-local variable, and added a regression test that runs the real pre-step hook.
- Routed architecture-document injection through the versioned managed-scope registry so `include`/`exclude` rules and per-scope document names are honored.
- Restored project-index anchors and runtime anchor configuration propagation so briefs and anchors are available after compaction.
- Made architecture refresh render the document and write the baseline from one fresh index snapshot instead of mixing a stale index with a new baseline.
- Added non-Git deletion detection with an explicit scan-incomplete status; incomplete scans no longer report deletions.
- Added the shared size, sensitive-file, per-file, total-byte, file-count, and scan budgets to semantic hash detection.
- Cancelled queued index timers on plugin disposal and re-checked lifecycle/master-switch state inside the timer callback.
- Bounded session maps and made the Git-repository cache cap reachable.
- Hardened `install-desktop.mjs`: source/target overlap is rejected before deletion, only packaged files are copied, secrets and unrelated workspace files are excluded, the previous package is backed up first, and a failed staged install restores it.
- Counted the outer `<pinned_constraints>` tags in the global injection budget so instruction plus pinned output cannot exceed the configured budget because of wrapper overhead.

## Verification

- `npm run check` passes.
- Full test suite: 104 tests, 103 pass, 1 environment-dependent skip. Optional DSH-peer integration tests pass when the Desktop Harness peers are linked, including real pre-step hook behavior, queued-index cancellation on disposal, same-snapshot architecture refresh, managed-exclusion injection, anchor injection, pinned-budget accounting, and isolated installer overlap/rollback/filter cases.
- The isolated Profile smoke recorded for `0.3.0` remains valid for installation mechanics; it used the local tarball and the Desktop Harness kernel with a mock LLM, and did not execute a real-model compression.

## Not claimed

- No npm publication, npm `latest` verification, or Desktop marketplace one-click verification is claimed until those steps complete.
- No real long-session three-backend (basic / pro / fidelity) A/B result on zh / en / mixed tasks is claimed.
- No same-class fidelity or downstream task-improvement claim is made from the local mechanism tests.
- The running daily DSH Desktop profile must be upgraded only after the application is closed; it remains on the previous prerelease until then.
