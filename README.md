# dsh-compaction-fidelity

> Project and package name: `dsh-compaction-fidelity`; positioning: DSH context-compaction fidelity layer.

A DSH 0.2.0-rc.2 Profile Bundle combining cross-lingual compaction fidelity fingerprints, persistent Compaction-Fidelity-style project cognition/architecture anchors, and a dynamic compaction line.

## Purpose

Treat a compaction summary as a lossy index rather than a complete transcript.

## Philosophy

Official compaction keeps the session running. This plugin keeps key facts, behavior constraints, and project architecture alive across that boundary.

## Who it is for

DSH Desktop users with long sessions, large or multi-module repositories, Chinese or bilingual workflows, and tool-heavy context growth.

## References and license

See REFERENCES.md for the projects and research that informed this work, SECURITY.md for the security model, and CHANGELOG.md for release notes. Project code is MIT licensed.


## Features

- Dynamic compaction line: `256K` / `350K` / `512K` / `800K (official default)` presets and custom `256 < value < 800 (K)` in the composer next to the model/reasoning selector; Plugin default is `350K`; `800K` is capped to the official 80% window line on a 1M window. 350K is the maintainer personal comfort setting after reviewing DeepSeek V4.1 Flash auto-compaction-line projects; users may override it with a custom valid value. K means 1000 tokens, matching the DSH ContextMeter display.
- Persistent, Git-versioned `.dsh/compaction-fidelity/` project index: module map, architecture-level files, commands, schema/migration anchors.
- Architecture retrieval anchors: after a file is modified, its architecture-level neighbors/docs/tests are written to `.dsh/compaction-fidelity/anchors.md` and injected into the next step.
- Lossless retrieval: anchors are pointers; `compaction-fidelity-brief` and `compaction-fidelity-lookup` retrieve exact project structure after compaction.
- AOCI-inspired architecture refresh gate: `status` / `refresh` commands, persistent scope registry, context-compaction priority collection, Git + content-hash change detection, weighted semantic score, and append-only updates whose latest entry is last; architecture writes use a cross-process lock + CAS + atomic rename.
- One master switch: installing the bundle enables everything; removing it restores the built-in DSH presets; `/compaction-fidelity on|off` switches the whole plugin at runtime.
- A/B fingerprint calibration: raw-summary metrics and post-compensation metrics are compared per language in `.dsh/compaction-fidelity/fidelity-calibration.json`; calibrated levels activate after 8 samples per language while the gate keeps using the raw deterministic level.
- Anchor quality: anchors are deduplicated by canonical identity, scored by relation strength, and capped per kind (tests 2, docs 1, database 2).
- Persistent reminder backoff: architecture refresh reminders back off 0 -> 5 minutes -> 30 minutes, then become status-only; state lives in `.dsh/compaction-fidelity/architecture-reminders.json`.
- Cross-lingual fidelity fingerprint: freezes exact values, CJK bigrams, and structure before compaction, compares the generated summary, emits L0–L3 levels, appends a `fidelity_compensation` block for missing exact values, and writes metrics to `.dsh/compaction-fidelity/fingerprints/`.
- Language policy: default `auto` follows the session language (no double translation); `en` writes model prose in English but preserves verbatim user input and exact values.

## Why it matters

- CJK token fix: 4 chars/token underestimates Chinese; this plugin uses 0.8 token/char.
- Effective budget: subtract output reserve and headroom before comparing the line.
- Fidelity: exact-value ledger + CJK bigrams + L0-L3 + compensation.
- Retrieval: project index + brief/lookup + architecture anchors.
- Safety net: minimal gets official compaction; plugin failure falls back.
- Local and auditable: .dsh/compaction-fidelity text index, no neural embeddings.
- Differentiation: ecosystem has threshold/checkpoint plugins; this focuses on bilingual loss.

## Core ideas

- Summaries are lossy indexes, not transcripts.
- Preserve exact facts verbatim.
- Deterministic extraction over probabilistic guessing.
- Structures and anchors are cheaper than full copies.
- Keep the official safety net; disable must not mean unprotected.
- Every compaction loses information; early compaction is a trade-off.

## Known boundaries

- A/B fingerprint calibration now records raw-summary vs post-compensation metrics per language, but downstream QA correlation is not measured yet.
- Compensation/anchors may dilute attention; a 2048-token soft cap, category priority, and anchor quality caps are implemented, but the optimum thresholds still need more calibration samples.
- zh/en/bilingual strategy lacks controlled comparison; constraint ledger not covered.
- Do not lower the 256K output reserve by default; provider constraint still holds.
## Install

DSH Desktop 0.2.0-rc.2: install this bundle from the Plugin Manager (local path or npm package `dsh-compaction-fidelity`).

CLI profile:

```powershell
dsh plugin --profile web add <path-to-dsh-compaction-fidelity>
dsh plugin --profile web remove dsh-compaction-fidelity
```

The bundle patch inserts the host plugin row and overrides the built-in `preset-standard`, `preset-cordis`, `preset-ptc`, and `preset-minimal` compaction rows (inserting a group for `minimal`) with `dsh-compaction-fidelity/engine`. New sessions use the patched presets; running sessions keep their composed tree.

### DSH runtime fix

DSH Desktop 0.2.0-rc.2 ships a `minimal` preset without any compaction backend and a token meter that prices all text at 4 chars/token (severe CJK underestimation). Run once after installing, and again after every DSH update:

```powershell
node scripts/patch-dsh-runtime.mjs
node scripts/patch-dsh-runtime.mjs --restore   # optional rollback
```

The script restores a `compaction-basic` safety net in `minimal` and installs a CJK-aware estimator in `@deepseek-ai/dsh-token-meter` (ASCII density unchanged; provider usage anchors still override estimates). Backups are written under `%USERPROFILE%\.dsh\runtime-fixes\backups`.


## Commands

```text
/compaction-fidelity status
/compaction-fidelity on | off
/compaction-fidelity threshold 256k | 350k | 512k | 800k | <tokens>
/compaction-fidelity retain <tokens>
/compaction-fidelity language auto | zh | en | bilingual
/compaction-fidelity init | reindex
/compaction-fidelity verify
/compaction-fidelity brief
/compaction-fidelity anchors <file>
/compaction-fidelity lookup <query>
/compaction-fidelity purge --yes
/compaction-fidelity architecture check | read | create | refresh | status | update [scope] [summary]
```

Tools: `compaction-fidelity-brief`, `compaction-fidelity-lookup`, `compaction-fidelity-architecture`.

## What is kept from Compaction-Fidelity

Persistent Git-versioned artifacts, local-first scanning, module/architecture cognition, schema/migration anchors, baseline/verify freshness, stable text formats (`project.meta.txt`, `project.code.txt`, `project.arch.txt`, `project.database.txt`).

## What is not ported

The 188K-line Go governance engine, the stdio MCP server and its 9 MCP tools, the full FRAS/Attestation/Ledger/Recovery state machine, agent-written semantic Whole-Index, live database introspection, and a full tree-sitter call graph. See `README.zh.md` and `THIRD-PARTY-NOTICES.md` for details.


Explicitly not ported or not planned:

- FRAS semantic authoring, Go governance state machine, stdio MCP server, full Attestation/Ledger/Recovery state machine.
- Managed Scope tri-role `index / observe / exclude`: only `include / exclude` is considered useful for this plugin; `observe` is not planned.
- `phase_transition` inference: only `semantic_threshold`, `context_compaction`, and explicit architecture commands trigger cognition refresh.
- Token-level Whole-Index budget (120K/180K/240K): the plugin keeps per-document (4000 chars) and total (8000 chars) retrieval budgets instead.
- Database credentials/evidence layer: the plugin never reads `.env` or secret files.
## Development

```powershell
node --test test/*.test.mjs
npm run check
node scripts/generate-preset-patch.mjs
```

MIT License. Upstream AOCI-CODE notices live in `THIRD-PARTY-NOTICES.md` and `licenses/AOCI-FSL-1.1-MIT.txt`.


## Versioning

`<latest-adapted-DSH-version>.plugin.<plugin-major>.<plugin-minor>`

- Current: `0.2.0-rc.2.plugin.1.21`
- DSH prefix: exact DSH version range this plugin targets
- Plugin body: `1.0`; increments to `1.1`, `2.0`
- On DSH prefix change, plugin body restarts at `1.0`

## Why the language mechanism differs from the official English-only template

The official DSH 0.2.0 compaction instruction forces English prose for cross-model canonical form, token efficiency around English code/identifiers, and prompt consistency. For Chinese sessions, however, it forces a double translation and lets the summarizer paraphrase user constraints. This plugin keeps an official-compatible fallback but adds `auto` (session-language checkpoint, zero translation), `en` (English prose with verbatim user input and an exact-value ledger), and `bilingual`. Compaction-Fidelity localization supports the same principle: locale changes regenerate natural-language fields but never translate paths, identifiers, APIs, or code facts.

## Compaction-Fidelity audit additions

- `project.txt` Root Manifest with `#Volume:` declarations
- `project.meta.txt` locale/ID/quota/admission conventions
- Canonical `code:<path>` identities and `Compaction-Fidelity-MOD/ARCH/DB-####` IDs
- Deterministic database table extraction (`CREATE TABLE`, Prisma `model`)
- Baseline/verify retained; post-compaction rule requires re-reading `project.txt` / `PROJECT.md` instead of trusting the summary
- FRAS semantic authoring, Go governance state machine, MCP server, and live database introspection intentionally not ported

## Threshold validity and hardening

- Threshold is hard-validated to `(0, 1M]`; `0` and values above `1,048,576` are rejected
- `retainTokens` must be lower than the threshold
- Runtime state uses the in-process global slot fast path
- One measurement per step when enabled; model info cached for 60s
- `queueIndex` auto-builds only when the index is missing; `/compaction-fidelity reindex` forces a rebuild
- Sensitive files are excluded from index/hash; `indexDir` and `baseline.json` paths are validated against traversal and symlinks






---

## References & ideas

> The evaluation report did not include URLs/DOIs; cite latest versions.

### Tokenizer & CJK

- openclaw: chars/4 underestimates CJK 2-4x; ~1 token/char.
- Qwen Code: CJK-heavy content underestimated 39-54%.
- Community data: cl100k_base CJK ~1.0-1.7 token/char; DeepSeek/Qwen native ~0.6-0.8; English ~0.25.
- This plugin uses 0.8 token/char and provider usage anchors.

### Compaction loss, attention & governance

- Lost in Compaction: 5% compression costs about 7pp recall; 50% compressed-region recall 0-7%.
- grep finds 82-93% of keywords, but the model may not use them; untouched-region recall 68% to 39%.
- Temperature-0 variance can reach 14x; the bottleneck is attention capacity.
- Lost in Compression: at 0.33 keep-rate English retains 57-62%, Lithuanian 10-24%, Chinese nearly none.
- Token premium and compression penalty are decoupled; learned compressors show English-supervision bias.
- Governance Decay: compression silently drops runtime policies and standing instructions.
- 1,323 episodes: violation rate 0% to 30% (max 59%); soft-policy decay about 8.3x hard rules.

### DSH ecosystem

- DSH Discussion #5123: report claims full-window scaling; verify against current source (it already uses min(W*ratio, W-O-H)).
- DSH minimal preset: no compaction backend by default.
- dsh-infinite-context; dsh-compaction-threshold; dsh-context-checkpoint.
- dsh-asc (Agentic Surface Compaction); dsh-compaction-policy.

### Upstream

- AOCI-CODE: upstream conceptual reference for project cognition/index/verify.
- Attribution: THIRD-PARTY-NOTICES.md and licenses/AOCI-FSL-1.1-MIT.txt.
























