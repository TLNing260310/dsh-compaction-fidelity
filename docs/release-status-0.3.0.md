# Release status: 0.3.0

Date: 2026-10-06
Tag: `v0.3.0`
Commit: `a20eab0`
Plugin version: `0.3.0`
Adapted runtime: community DSH Desktop `2.0.17`, DeepSeek Harness `@deepseek-ai/dsh@0.2.0-rc.2`

This document is the public, committed release-status record for `0.3.0`. The internal compatibility and market audit remains a local working document and is not part of the repository or npm package.

## Distribution status

- GitHub tag and release `v0.3.0` are published and traceable.
- The npm publication target is `dsh-compaction-fidelity@0.3.0`.
- npm publication requires registry authentication; at the time of this record the package was not yet available on the public npm registry.
- DSH Desktop community-market one-click installation requires npm `latest` to resolve to `0.3.0`; that path is not yet verified.

## Implemented in 0.3.0

- Unified runtime and migration privacy projection for fingerprint sidecars: aggregate counts instead of raw missing exact values, gate failure details, or constraint text.
- Dry-run-first legacy fingerprint migration with exclusive backup, symlink/junction/hard-link rejection, and CAS conflict handling.
- Mixed-language calibration isolation and a bounded `calibration summary` / `calibration import` workflow.
- Fixed model-info and calibration cache eviction; official-summary fallback preserves cancellation.
- Exact DSH peer dependency plus repository and engine subpath metadata.
- CJK-aware global injection budget shared by the summary instruction, compensation block, and pinned constraints, with an observable truncation marker.
- Committed three-backend paired evaluation protocol.

## Validation status

- `node --test test/*.test.mjs`: 90 tests, 89 passed, 1 skipped because Windows denies ordinary symlink creation in the current environment.
- `npm run check`: passed.
- `npm run verify:local`: passed with the installed Desktop Harness kernel and a mock LLM.
- `npm pack`: 42 files, about 122 KiB.
- `npm publish --dry-run`: passed; real publication was blocked by missing npm authentication.

## Not yet verified

- Real long-session paired comparison of official `dsh-compaction-basic`, `dsh-compaction-pro`, and this plugin.
- Clean Desktop 2.0.17 Profile installation from npm `latest`.
- Desktop community-market visibility and one-click installation.
- Strict case/punctuation-sensitive downstream acceptance, project-level anchor weights, and an anonymous community calibration package.

See `CHANGELOG.md` and `docs/paired-evaluation-protocol.zh.md` for the release history and the frozen evaluation design.
