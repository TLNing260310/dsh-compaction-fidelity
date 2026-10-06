# Changelog

## 0.2.0-rc.2.plugin.1.26-dev.0 (unreleased)

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

