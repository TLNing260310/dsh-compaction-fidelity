# Security Policy

## Supported versions

This repository targets the DeepSeek Harness `0.2.0-rc.2` runtime bundled in community DSH Desktop `2.0.17` and uses independent plugin SemVer. Release `0.3.1` keeps Harness compatibility in the exact `@deepseek-ai/dsh@0.2.0-rc.2` peer dependency; historical `0.2.0-rc.2.plugin.*` prereleases remain documented in `CHANGELOG.md`.

## Runtime security model

- The plugin runs locally inside the DSH process.
- It has no independent HTTP client or telemetry. Summary generation uses DSH's configured LLM service, which may send the conversation to the selected remote provider.
- It reads workspace files to build the project index.
- Sensitive files such as .env, .npmrc, .netrc, .pypirc, SSH keys, credentials, and secrets are excluded from indexing and baseline hashes.
- It writes project artifacts under the workspace .dsh/compaction-fidelity directory and control state under the DSH home directory.
- The official compaction engine remains the fallback if the plugin fails or is disabled; the enabled plugin overrides `summarize()`.
- New fingerprint sidecars store aggregate recall and constraint counts, not missing exact strings or constraint text. Older sidecars from releases through `1.25` may contain raw values and should be reviewed before sharing or committing.
- Imported calibration JSON is user-selected local evidence and may contain additional fields. Review and redact it before adding `.dsh/compaction-fidelity` to Git, especially in a public repository.
- Audit known legacy fields with `npm run migrate:fingerprint-privacy` before sharing fingerprint sidecars. It defaults to a read-only audit of `.dsh/compaction-fidelity/fingerprints/*.json`; `npm run migrate:fingerprint-privacy -- --apply` backs up legacy sidecars first, then replaces raw missing values and constraint text with aggregate counts.

## Path and sidecar safety

- Session IDs used in fingerprint sidecar names are sanitized to `[A-Za-z0-9._-]`.
- Architecture document scopes are validated as safe workspace-relative paths.
- Index and anchor writes are constrained to the configured workspace index directory.
- The runtime patch uses fixed executable names and argument arrays, not shell string construction.
- Install and patch scripts only modify the selected local DSH profile or installation and create backups where applicable.

## Optional runtime patch

`scripts/patch-dsh-runtime.mjs` modifies the installed DSH runtime so the minimal preset has an official compaction safety net and the token meter is CJK-aware.
This step is optional and is not required for bundle installation. It changes files in the local DSH installation; a restore mode is provided. Recheck the target DSH version before using it after an update.
The patch script does not copy DSH source code into this repository.

## Reporting

Report security issues through GitHub Security Advisories or a private maintainer channel.
Do not include live tokens, credentials, or private repository contents in public issues.

## Current audit notes

- No eval or independent runtime network client was found in the plugin modules; model calls go through DSH's LLM service.
- The install and patch scripts use child_process for fixed local package-manager and DSH operations.
- Index scanning is bounded by max file count and max file size and runs outside the critical token path.
- The pre-step pressure check and architecture prompt are best-effort and never replace the official overflow recovery.

- Threshold compaction uses a per-session in-flight guard to avoid overlapping pressure transactions.
- Architecture prompts are scoped to the current session and the prompt cache is bounded.

## Out of scope

- Vulnerabilities in DSH Desktop or official DeepSeek packages.
- Model behavior, prompt injection from untrusted repository contents, or malicious workspace files that are readable by the current user.
- Security of third-party plugins installed alongside this bundle.

## Migration backup handling

The migration covers known fingerprint fields, including nested final-fidelity values. It does not sanitize arbitrary metadata or the calibration store. Backups retain the original private text: exclude `fingerprint-privacy-backup/` from shared evidence and review imported samples separately. Custom `--backup-dir` paths resolve relative to the selected workspace and must name a new directory inside it, separate from fingerprints. Linked/junction paths, hard-linked files, oversized/non-object JSON, and damaged sidecars are rejected or skipped. Apply reports skipped files and exits nonzero; inspect the report before treating migration as complete. Stop active compaction while migrating; locked compare-and-swap writes detect ordinary conflicts but do not provide a filesystem sandbox against hostile concurrent path swaps.

