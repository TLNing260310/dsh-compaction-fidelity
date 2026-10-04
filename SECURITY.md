# Security Policy

## Supported versions

This repository targets DSH Desktop 0.2.0-rc.2 and follows the package version scheme `0.2.0-rc.2.plugin.*`.

## Runtime security model

- The plugin runs locally inside the DSH process.
- It does not make network requests and does not include telemetry.
- It reads workspace files to build the project index.
- Sensitive files such as .env, .npmrc, .netrc, .pypirc, SSH keys, credentials, and secrets are excluded from indexing and baseline hashes.
- It writes project artifacts under the workspace .dsh/compaction-fidelity directory and control state under the DSH home directory.
- The official compaction engine remains the final fallback if the plugin fails or is disabled.

## Path and sidecar safety

- Session IDs used in fingerprint sidecar names are sanitized to `[A-Za-z0-9._-]`.
- Architecture document scopes are validated as safe workspace-relative paths.
- Index and anchor writes are constrained to the configured workspace index directory.
- The runtime patch uses fixed executable names and argument arrays, not shell string construction.
- Install and patch scripts only modify the selected local DSH profile or installation and create backups where applicable.

## Optional runtime patch

`scripts/patch-dsh-runtime.mjs` modifies the installed DSH runtime so the minimal preset has an official compaction safety net and the token meter is CJK-aware.
This step is optional but recommended. It changes files in the local DSH installation; a restore mode is provided.
The patch script does not copy DSH source code into this repository.

## Reporting

Report security issues through GitHub Security Advisories or a private maintainer channel.
Do not include live tokens, credentials, or private repository contents in public issues.

## Current audit notes

- No eval, no dynamic code generation, and no runtime network calls were found in the plugin runtime.
- The install and patch scripts use child_process for fixed local package-manager and DSH operations.
- Index scanning is bounded by max file count and max file size and runs outside the critical token path.
- The pre-step pressure check and architecture prompt are best-effort and never replace the official overflow recovery.

- Threshold compaction uses a per-session in-flight guard to avoid overlapping pressure transactions.
- Architecture prompts are scoped to the current session and the prompt cache is bounded.

## Out of scope

- Vulnerabilities in DSH Desktop or official DeepSeek packages.
- Model behavior, prompt injection from untrusted repository contents, or malicious workspace files that are readable by the current user.
- Security of third-party plugins installed alongside this bundle.

