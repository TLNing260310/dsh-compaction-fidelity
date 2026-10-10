# Release status: 0.4.0-rc.1 (test candidate)

Tag: `v0.4.0-rc.1`
Plugin version: `0.4.0-rc.1`
Harness peer: `@deepseek-ai/dsh@0.2.0-rc.2`
Runtime reference: community DSH Desktop `2.0.17`
Channel: GitHub pre-release (test candidate)

This is a **test candidate**, not a stable release. It is published as a GitHub
pre-release so the post-audit hardening can be tried without moving the
`v0.3.1` stable identity. It is not published to npm, is not merged into the
plugin marketplace, and must not be referenced by npm `latest` or by the
Desktop community-market one-click path. The `v0.3.1` tag, release, and npm
target keep their existing status.

## Contents of this candidate

`0.4.0-rc.1` contains the audit closure on top of `0.3.1` (commits
`f97b7b3` through the candidate commit):

- One workspace-wide read policy for every scan and retrieval entry, so a child
  scope's exclude also constrains root status and baseline updates; policy is
  evaluated before any file is read.
- Background indexing is queued only after the host allows the step to
  continue; a slow rejection, a thrown decision, or a cancellation cannot start
  a scan or write an index behind a refused step.
- Change detection uses the baseline snapshot as the source of truth: untracked
  files are enumerated individually, rename pairs are followed, and a
  dirty-at-refresh file restored to `HEAD` is still reported.
- Missing/corrupt baselines, Git failures, incomplete scans, and exhausted
  budgets return an explicit `unknown`; a scan that stops exactly at
  `maxFiles` and a baseline with a broken schema are no longer reported as
  `aligned`.
- Alignment is tri-state (`aligned` / `stale` / `unknown`); `aligned` only
  means the semantic score is below the refresh threshold, not that files are
  byte-identical to the snapshot.
- Refresh keeps human-owned constraints, decisions, notes, an explicit manual
  region, and the update history; a conflicting manual entry refuses the
  refresh instead of overwriting it.
- Summary prompts carry the active requirement projection and history
  coordinates; update bodies are only emitted on explicit `includeHistory`,
  so a retracted instruction cannot re-enter the prompt from the log.
- Language, corrections, and user quotes ignore producer-owned
  (`plugin:*`) messages; path extraction accepts CJK paths and structured
  tool-call path arguments.

## Verification evidence

- Local: `npm test` 241 tests / 210 pass / 0 fail / 31 skipped.
- Real DSH peers snapshot: 241 tests / 238 pass / 0 fail / 3 skipped (two
  platform symlink cases and one no-git-metadata case).
- `npm run check` and `npm run verify:local` (real Harness dependencies plus
  a mock LLM) pass.
- The audit probes for the five blockers were re-run against this source:
  excluded files are read/registered zero times; a slow rejection leaves no
  index; restored-to-`HEAD` and untracked-directory fixtures now report
  changes; the exact `maxFiles` boundary and corrupt schema return
  `unknown`; manual constraints/decisions/notes survive refresh; the
  retracted instruction is absent from the default excerpt; plugin injection
  no longer flips the language; CJK and tool-call paths are extracted.

## Not verified / known gaps

- No real-model smoke run: the verification uses deterministic tests and a
  mock LLM. Efficiency or task-quality claims still require the paired
  evaluation protocol.
- No clean isolated-environment install/upgrade/rollback run. The installer
  transaction covers staging and package replacement; Profile rewrite,
  dependency linking, verification, and enable are not yet inside one recovery
  boundary.
- npm publication, marketplace merge, and Desktop process load are not
  verified for this candidate; the running Desktop may still load a different
  package.
- Indexing, hashing, Git subprocesses, and file locking still run
  synchronously; large workspaces can delay the host event loop. Cancellation
  checks and budgets mitigate but do not remove this limitation.
- Calibration import still stores arbitrary fields (no field whitelist), and
  threshold/language settings are process-global rather than per-session.
- Paired three-backend evaluation and the audit's performance/install
  lifecycle steps are still open.

## Install the candidate (test only)

```
dsh plugin --profile desktop add 'github:TLNing260310/dsh-compaction-fidelity#v0.4.0-rc.1'
```

Use `v0.3.1` for stable installations. To roll back a candidate test, reinstall
the `v0.3.1` tag or restore the previous Profile copy.

## Package

- Package tarball: `dsh-compaction-fidelity-0.4.0-rc.1.tgz` (173931 bytes), SHA256 `02503761d1d4d7126c332061a4293cd9d5d8148b27897985dafbf3eb7489ec32` (attached to the GitHub pre-release).
