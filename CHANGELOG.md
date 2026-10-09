# Changelog

## Unreleased

Post-audit hardening on top of 0.3.1. This section implies no version bump, tag, or publication.

### Read policy is fail-closed

- Split the managed-scope registry read into `missing`, `valid`, and `corrupt`. A registry that cannot be honored no longer degrades to "no rules"; it denies every read, index write, cache hit, and injection target instead, and it can no longer be silently rewritten by a rule update.
- Added a workspace-wide filter so a rule registered for one sub-scope also constrains the root index, brief, anchors, and search results.
- Cached retrieval artifacts record the read policy they were built under, so a rule change or a corrupt registry invalidates `index.json`, `PROJECT.md`, and `anchors.json` instead of serving content the current rules no longer allow.
- Routed every retrieval entry point through that policy: brief and lookup tools, `verify`, `anchors`, `brief`, `reindex`, background indexing, anchor injection, and the engine's summary-context lookup.

### Architecture baseline

- The baseline store is written through the shared workspace containment check plus the lock/compare-and-swap helper, so a linked `indexDir` can no longer be written through and two processes refreshing different scopes cannot drop each other's entries.

### Constraints

- Constraints carry provenance (message index, ordinal, timestamp) and are selected newest-first, so the newest rules survive the cap instead of the oldest.
- Withdrawals ("不再需要…", "ignore the previous…", "instead use…") and same-object reversals mark older rules as retracted or superseded. Retired rules are excluded from verdicts, so a rule the user withdrew can no longer be re-pinned as non-negotiable after a compaction.

### Pre-step safety

- A cancelled or rejected step returns the original decision before any architecture work runs, every architecture write re-checks cancellation, and the branch is wrapped in its own error boundary so a helper failure cannot break the agent step.
- Folder mentions no longer authorise writes: selecting a scope and authorising creation are separate states, "不要创建 src，先检查它" is recognised as a refusal, and the decision lives in the host-free `src/step-policy.mjs` with its own tests.

### Purge ownership

- `purgeIndex` refuses to delete a directory that does not carry plugin-managed index markers.

### Diagnostics

- The fidelity gate now fails on probe recall, so a high recall fingerprint can no longer mask a summary that dropped every probed value; `probes` is reported with the other thresholds.
- Raw model output and the delivered summary are evaluated separately, and constraints are re-evaluated after compensation, instead of pairing a raw fingerprint with post-compensation constraints.
- Cancellation is no longer treated as a fallback condition: an aborted pressure compaction rethrows instead of continuing into official compaction.

### Constraint parsing review

The constraint parser is heuristic, so the shapes a bare trigger regex gets wrong were measured
rather than assumed, and are now covered by characterisation tests in
`test/constraint-ledger-heuristics.test.mjs`.

- A question about a rule is no longer pinned: 为什么不要使用 tabs？ is skipped, while a sentence that opens with the imperative itself (不要使用 tabs 可以吗？) is still collected.
- Speech quoted from a third party is no longer pinned as a rule: 用户之前说不要使用 tabs and 文档里写着必须用 pnpm are treated as hearsay. A rule stated directly is unaffected.
- A withdrawal that also says what to keep now retires its own target: 不再需要 tabs 这条，其他都保留 was previously ignored because the trailing clause diluted the coverage ratio. The unrelated rule is left alone, which the test asserts explicitly.
- Demonstrative fillers (这/那/该/此/条/项/个) are stripped from a withdrawal target so the ratio measures the object, not the phrasing.
- Sentence terminators are preserved through segmentation, so a trailing question mark is still visible to the gate.
- Two shapes stay documented gaps rather than fixes: a pure conditional (如果…就…) is dropped instead of pinned, and a withdrawal naming two objects in one clause (不再需要 docker 和 tabs) retires neither.

### Architecture injection

- Summary injection now takes a bounded *current view* of each managed
  ARCHITECTURE.md instead of the head of the file: structure coordinates first,
  then active requirements, then whole update blocks newest-first. An item that
  does not fit is reported with a readable pointer instead of being cut in half.
- A later withdrawal in the update log retires the earlier requirement, so a rule
  the user retired stops being presented as non-negotiable while its text stays
  retrievable in the file.
- The reader checks the document size before reading, and an unparsable or
  oversized document is skipped rather than sliced into the prompt.

### Narrative language

- The summary language now follows the *user's* recent messages instead of every
  role's text, so a tool result or an English assistant paragraph can no longer
  outvote the person being summarised.
- A Chinese request is no longer reclassified as bilingual merely because it
  carries English identifiers: content inside code spans and fences is ignored,
  and identifier-shaped tokens are counted separately from prose-shaped words.
- The bilingual rule no longer asks for an English narrative. It asks for the
  dominant language of the recent user messages and falls back to the most recent
  message when the two are even, while exact values stay verbatim.
- The ledger records `languageBasis` (`recent-user`, `all-user`,
  `conversation-fallback`, `empty`) so a language decision can be traced back to
  the window that produced it.

### Verification in this round


- `npm run check` passes. The full suite is 144 tests: 139 pass, 0 fail, 5 environment-dependent skips in a checkout with no peer modules.
- The same suite run against the installed Desktop Harness reports 144 tests: 143 pass, 0 fail, 1 skip.
- The previously always-skipped host tests now run against `@deepseek-ai/dsh@0.2.0-rc.2` and `@deepseek-ai/cordis@4.0.4` linked read-only from the installed Desktop payload into a throwaway copy of the tree, with `DSH_HOME` pointed at a temporary directory. The live profile and the installed payload were not modified.
- That run found a real defect: the engine integration fixture built its cached index without the read policy, so the new policy check correctly refused it. The fixture now builds the index the way the plugin does, and the engine logs when it declines to serve a cache written under a different policy instead of dropping the summary context silently.

- Still open from the audit, and not claimed as fixed: Git-backed change detection still compares against `HEAD` rather than the refresh snapshot and has no explicit `unknown` state; index scanning is still synchronous with incomplete time and directory budgets; `install-desktop.mjs` rollback still covers only the pre-Profile half; configuration is still process-global; calibration import still lacks a field whitelist; and two constraint-parser shapes remain measured gaps (a pure conditional is dropped, and a withdrawal naming two objects in one clause retires neither).

- No real-model paired evaluation, Desktop end-to-end upgrade, npm publication, or "leading among peers" claim is made here.

### Changed

- Architecture document access now fails closed: a denied scope (or a denied
  ancestor scope) no longer falls back to the default document name. Refusals
  carry a structured reason (`denied-scope`, `denied-ancestor`, `corrupt-registry`, `invalid-scope`) and a `null` target, and are propagated
  without side effects: no path resolution, read, create, refresh, scope
  registration, baseline write, or creation prompt.
- A single reader (`readManagedArchitectureDoc`) is now the gate for every architecture read path:
  outcome-layer refusals return no target at all, while filesystem failures
  (`missing`, `unsafe-path`, `symlink`, `too-large`, `unreadable`) keep a source pointer that cannot be
  used for mutation. A refusal always wins over a missing document.
- Rule-management entries (`manage`, `include`, `exclude`, `unmanage`) are processed before
  document resolution. A rule update re-reads the registry instead of reusing
  the in-memory result, and only an allowed scope that already has a document
  is refreshed or registered.
- Registry write failures now have distinct reasons (`registry-write-failed`,
  `registry-cas-conflict`, `registry-locked`, `corrupt-registry`) and never leave a half-written
  registry; a corrupt or blank registry is still never rewritten.
- `architectureAsked` keeps its existing in-memory semantics; the permission check
  is moved before prompt suppression, scope adoption, and creation, so consent
  given before a rule change cannot create a refused document.
- A successful document mutation whose baseline write fails is reported as a
  partial completion (`mutationApplied: true`, `baselineWritten: false`) with a diagnostic
  log entry instead of being reported as a full success or failure.

- Baseline and change scans now apply the active read policy before reading a
  file, so an excluded file is never pulled into memory even though it was
  already absent from the projected result.
- A queued index build re-reads the registry policy at execution time instead
  of reusing the enqueue-time policy, and a cancelled or rejected step drops
  its queued index build.
- Architecture create and refresh render the document and write the baseline
  from one filtered index snapshot; refresh also applies the file-layer gate
  first, so an oversized, unreadable, symlinked, or unsafe document is refused
  before any mutation.
- Cancellation now terminates the absolute-threshold path instead of entering
  the official fallback; queued index builds carry the abort signal, an
  already-cancelled step schedules nothing, and long scans check the signal
  before reading and between entries.
- Every scan and retrieval entry now shares one workspace-wide read policy, so a
  child scope's exclude also constrains root status and baseline updates; the
  pre-step hook schedules the background index only after the host allows the
  step to continue, so a slow rejection, throw, or cancellation cannot read or
  write behind a refused step.
- Git-backed alignment treats the baseline snapshot as the source of truth:
  untracked files are enumerated individually (`--untracked-files=all`), rename
  pairs are followed, and the recorded file set is re-checked so a
  dirty-at-refresh file restored to `HEAD` is still reported while a file whose
  content still matches the baseline stays at score 0.
- Baseline entries are schema-validated (store version, files object, per-file
  hash and size, Git metadata) and a scan that reaches exactly `maxFiles` or
  exhausts any hash/file/byte budget returns `unknown` instead of `aligned`.
- Refresh now treats the generated sections as an auto region: `constraints`,
  `decisions`, and `notes` entries that only exist in the old document are kept, an
  explicitly marked manual region survives verbatim, and a conflicting manual
  entry refuses the refresh instead of overwriting it.
- Architecture excerpts default to the active requirement projection plus
  history coordinates; update bodies (and any retracted instruction) are only
  emitted when a caller explicitly asks for `includeHistory`.
- Language, corrections, and user quotes ignore producer-owned (`plugin:*`)
  messages; path extraction accepts CJK paths and structured tool-call path
  arguments.
- Architecture alignment is now tri-state: `aligned` (semantic score below the
  refresh threshold), `stale`, or `unknown` for a missing/corrupt baseline, a
  failed or unavailable Git repository, an incomplete scan, or an exhausted
  hash budget. Git mode subtracts worktree changes already present in the
  refresh snapshot instead of comparing only against `HEAD`, and `verifyIndex`
  reports a missing or corrupt baseline instead of treating it as empty.

### Known limitations

- Single-file registry writes use the existing file lock, atomic replace, and
  CAS, but the lock does not cover the registry, document, and baseline as one
  cross-file transaction; concurrent writers in separate processes on that
  joint state remain undefined.
- Registry, document, and baseline are not covered by a joint transaction; this
  round reuses the existing lock/atomic-replace/CAS helpers and does not promise
  cross-file atomicity.
- There is no `registry-changed` secondary validation between the policy decision
  and the read, so a concurrent rule change inside that window is not detected.
- `architecturePrompted` is not introduced; prompt state remains in-memory.
- Change detection is not gated on Git tracking; this round does not claim that
  untracked files escape hash detection.
- `aligned` reflects the semantic score against the refresh threshold; it does
  not mean the source files are byte-identical to the refresh snapshot.


## 0.3.1

Hardening release on top of the published 0.3.0 tag. The `v0.3.0` tag remains unchanged.

### Security and containment

- Rejected linked-parent escapes for project index, anchors, workspace state, purge, and architecture stores; shared one containment helper instead of the previous weak local check.
- Refused source/target overlap before `install-desktop.mjs` deletes anything, copied only packaged files, excluded secrets and unrelated workspace files, backed up the previous package, and restored it when staging validation failed.

### Architecture retrieval

- Fixed a pre-step scope-adoption reference that could throw `target is not defined`; added an actual pre-step hook regression test for single-candidate consent, ambiguity, and decline.
- Routed architecture-document injection through the versioned managed-scope registry, including `include`/`exclude` rules and per-scope document names.
- Restored project-index anchors and runtime anchor propagation.
- Made architecture refresh render its document and baseline from one fresh index snapshot, so a refresh cannot pair a stale document with a new baseline; command/tool document paths now resolve registered per-scope document names.

### Change detection and scheduling

- Added non-Git deletion detection while explicitly suppressing deletion reports when the scan is incomplete.
- Added shared sensitive-file filtering plus per-file, total-byte, file-count, and scan budgets to semantic hash detection.
- Cancelled queued index timers on plugin disposal, re-checked lifecycle and master-switch state inside callbacks, bounded session maps, and made the Git-repository cache cap reachable.

### Injection budget

- Counted the outer `<pinned_constraints>` wrapper in the global injection budget.

### Verification

- `npm run check` passes; full suite is 104 tests, 103 pass, 1 environment-dependent skip, with optional DSH-peer integration tests covering the real hook, refresh, injection, scheduling, budget, and installer regressions.
- Local tarball smoke in a temporary `DSH_HOME`: a custom profile created from the shipped web template installed `dsh-compaction-fidelity-0.3.1.tgz`, and `dsh --profile smoke --dump-config` exited 0 with the `compaction-fidelity` engine row present. Desktop preset replacement remains verified only through the app-closed Desktop profile path.
- npm publication and real three-backend paired evaluation remain pending and are not claimed.

- Added a committed public `0.3.0` release-status document and replaced README links that previously pointed at the uncommitted internal audit report.
- Recorded the isolated Profile smoke result: local 0.3.0 install, config composition, installed compression smoke with mock LLM, master-switch disable check, removal, and restart-config check passed; the running daily Desktop profile remains on 1.25 until it is closed.

## 0.3.0

First independent plugin SemVer release. Compatible with community DSH Desktop `2.0.17` / DeepSeek Harness `0.2.0-rc.2` through the exact peer dependency; the Harness version is no longer encoded in the plugin version. Real long-session paired evaluation remains pending, so this release documents mechanisms and measured local evidence rather than a superiority claim.

- Corrected pure/mixed-language calibration isolation and added a bounded calibration summary/import command with validation, deduplication, and provenance.
- Refused to overwrite malformed calibration evidence during recording or import.
- Fixed model-info and token-calibration cache eviction; fingerprint sidecars now retain aggregate metrics rather than exact missing values or constraint text, and prune on successful writes.
- Added a real official-summary fallback for fidelity-summary failures while preserving cancellation, and guarded calibration/fingerprint store paths against linked-parent escapes.
- Added DSH peer and subpath display metadata, corrected GitHub-only distribution and optional runtime-patch instructions, and documented the current marketplace gap.

- Added a shared CJK-aware global injection budget across the summary instruction, compensation block, and pinned constraints; low-priority anchors/briefs/architecture docs are dropped first, and truncation is observable through a prompt marker and engine warning.
- Added a dry-run-first legacy fingerprint privacy migration script: `npm run migrate:fingerprint-privacy` audits legacy sidecars, and `-- --apply` backs them up before replacing raw missing values and constraint text with aggregate counts.
- Unified runtime/migration aggregate projections, removed gate failure details, detected nested legacy values, and added exclusive workspace-contained backups with CAS conflict protection and linked-path rejection.
- Added a frozen three-backend paired evaluation protocol; real long-session results remain pending.

## 0.2.0-rc.2.plugin.1.25

Security and runtime-scheduling audit hardening.

- Rejected unsafe architecture scopes and invalid glob patterns; glob pattern count/length is capped.
- Rejected symlink traversal for architecture documents and managed stores; write targets must remain inside the workspace.
- Added locked CAS writes for managed registry, reminder state, and calibration samples.
- Hardened lock release with per-acquisition tokens and created parent directories for locked stores.
- Throttled pre-step semantic change detection per workspace/scope and capped session/cache maps.
- Capped model-info/calibration caches, git repo cache, recent-file sets, and pruned fingerprint files to the newest 500.
- Added an index wiring regression test and a containment/escape audit test.

## 0.2.0-rc.2.plugin.1.24

Boundary hardening, calibration cold-start guidance, and explicit alignment checks.

- Normalized structureHash / updateLogHash across CRLF, trailing whitespace, and repeated blank lines.
- Fixed attestation revision monotonicity; preserveArchitectureUpdateLog now increments from the maximum of old and fresh revisions.
- architecture check now reports aligned/stale, semantic score, detection method, attestation revision, and consistency.
- Covered exclude -> modify -> re-include semantics: excluded changes are not tracked; re-include rebaselines the current state.
- Added tests for legacy attestation upgrade, revision monotonicity, and whitespace-only formatting stability.
- README documents manual calibration sample import and the observation-layer relationship to compression backends.
- Still not implemented: observe, phase_transition inference, MCP server, and token-level Whole-Index budgets.

## 0.2.0-rc.2.plugin.1.23

Managed scope include/exclude, architecture attestation, and structure/update-log consistency.

- Added architecture-scopes.json v2 with per-scope include/exclude glob rules and legacy array migration.
- Architecture include/exclude now filters generated documents, baselines, semantic change detection, and anchor injection.
- Added architecture include / exclude / manage / unmanage tool actions and commands.
- Added an architecture attestation block with revision, structureHash, updateLogHash, and entryCount.
- Added architecture verify and status consistency reporting; update/refresh keep the attestation current.
- Added architecture-registry.mjs and tests for glob rules, legacy migration, filtered baselines, and buildIndex filtering.
- Explicitly out of scope remains: observe, phase_transition inference, MCP server, and token-level Whole-Index budgets.

## 0.2.0-rc.2.plugin.1.22

Audit corrections for calibration sampling and reminder identity.

- Calibration samples now record dominantLanguage, mixedRatio, cjkRatio, and latinRatio.
- Mixed zh/en sessions calibrate under a mixed:<dominant> group instead of silently entering pure zh/en statistics.
- Calibration groups are isolated: 8 samples in one group do not activate calibrated levels for another group.
- Architecture reminder keys now use workspacePath|scope|mtime instead of sessionId|scope|mtime, so reminder backoff survives DSH restarts and session switches.
- README documents the cold-start requirement and why quantitative calibration is distinct from verbatim-only compaction.
- Anchor quality weights remain fixed; a project-level override remains a P1 candidate.

## 0.2.0-rc.2.plugin.1.21

P1 fidelity calibration, anchor quality, and reminder backoff.

- Added per-language A/B fingerprint calibration: raw-summary and post-compensation metrics are recorded in `.dsh/compaction-fidelity/fidelity-calibration.json`.
- Added calibrated L0-L3 reporting after 8 samples per language; the deterministic gate still uses the raw fingerprint level.
- Anchors are now deduplicated by canonical identity, scored by relation strength, and capped per kind (tests 2, docs 1, database 2).
- Architecture refresh reminders now back off from immediate to 5 minutes to 30 minutes and then become status-only.
- Reminder backoff state is persisted in `.dsh/compaction-fidelity/architecture-reminders.json` and pruned automatically.
- Added `src/fidelity-calibration.mjs` and `src/reminder-state.mjs` with dedicated tests.
- Explicitly out of scope: FRAS/Attestation/Ledger/Recovery, MCP server, Managed Scope observe, phase_transition inference, and token-level Whole-Index budgets.

## 0.2.0-rc.2.plugin.1.20

P0 safety foundation.

- Architecture document writes now use a cross-process lock, compare-and-swap retry, and same-directory atomic rename.
- Change detection now prefers git status/diff, falls back to per-file content hashes, and only uses mtime as a last resort.
- Semantic change detection uses weighted scores plus a single-file large-change force trigger.
- Compaction retrieval now includes referenced docs, registered scopes, and the workspace root doc with a priority budget.
- Added architecture-baseline.json and persisted architecture scope registry.
- Added architecture-io.mjs and architecture-changes.mjs with dedicated tests.
## 0.2.0-rc.2.plugin.1.19

AOCI-inspired cognition refresh gate.

- Fixed architecture update ordering so the newest update is last.
- Added `architecture status` and `architecture refresh` commands and tool actions.
- Added the semantic_threshold refresh prompt with default 30 changed files.
- Added a persistent architecture scope registry for cross-session reuse.
- Added a context_compaction `<cognition_refresh>` block to the summary instruction.
- `refresh` rebuilds structure blocks while preserving the existing update log.
## 0.2.0-rc.2.plugin.1.18

- Changed K and M threshold units to decimal 1000, matching the DSH ContextMeter display.
- Added the /compaction-fidelity architecture command for check, read, create, and update.
- Added consent-driven automatic ARCHITECTURE.md creation after the injected prompt.
- Scoped generated ARCHITECTURE.md content to the target folder.


## 0.2.0-rc.2.plugin.1.17

Session format v4 compatibility for injected messages.

- Injected messages (the ARCHITECTURE.md prompt and the retrieval-anchor injection) now carry the producer-owned source kind `plugin:compaction-fidelity` instead of the retired v3 wrapper (kind `'plugin'` plus a `plugin` field). DSH v4 refuses that wrapper at admission with "format v4 message requires a producer-owned source kind", which failed the step that tried to inject.
- `plugin:compaction-fidelity` is exactly what DSH's own v3 -> v4 migration derives for this plugin, so messages written after the upgrade keep the same attribution as migrated history instead of being split into two producers.
- Added `src/message-source.mjs` as the single definition of that source, with `isProducerOwnedSource()` mirroring the v4 admission rule, and `test/message-source.test.mjs` covering the rule, the frozen constant, and a scan that fails if any `src/*.mjs` site builds a plugin source by hand again.

## 0.2.0-rc.2.plugin.1.16

Release preparation and audit.

- Set 350K as the plugin default compaction line.
- Added the 350K preset to the composer control.
- Changed the 800K label to official default.
- Added one-time migration from the old 800K default for persisted state and client storage.
- Removed the earlier-compaction warning from the composer control.
- Added folder-scoped ARCHITECTURE.md detection, prompt, create, read, and append-only update support.
- Added the compaction-fidelity-architecture tool.
- Included existing ARCHITECTURE.md documents in the compaction summary instruction.
- Added REFERENCES.md, SECURITY.md, and CHANGELOG.md for GitHub release readiness.
- Genericized personal paths in documentation and tests.

- Added a per-session in-flight guard for threshold compaction scheduling.
- Scoped architecture prompts to the current session and bounded the prompt cache.
- Architecture tool creation now validates the parent folder and respects the architectureDoc switch.

### Security and scheduling audit

- No eval, dynamic code generation, or runtime network calls in the plugin runtime.
- Sensitive files are excluded from indexing.
- Session IDs are sanitized before sidecar file names are built.
- Architecture document scopes are validated as safe workspace-relative paths.
- Indexing is bounded and scheduled outside the token-estimation path.
- Pre-step pressure checks and architecture prompts are best-effort and never disable official overflow recovery.
- Optional DSH runtime patching is documented as a local modification with a restore path.

## 0.2.0-rc.2.plugin.1.15

- Added client-side one-time migration from the old 800K stored default.
- Fixed architecture document name validation regex.

## 0.2.0-rc.2.plugin.1.14

- Added architecture-doc module tests.
- Added architecture tool registration and status text.

## 0.2.0-rc.2.plugin.1.13

- Added 350K preset and defaults.
- Added backend migration from persisted 800K.




