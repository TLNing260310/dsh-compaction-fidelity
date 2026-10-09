# dsh-compaction-fidelity

> Project and package name: `dsh-compaction-fidelity`; positioning: bilingual DSH compaction backend with fidelity diagnostics.

A Profile Bundle for the `0.2.0-rc.2` DeepSeek Harness runtime bundled by community DSH Desktop `2.0.17`. It combines a bilingual compaction engine, deterministic fidelity fingerprints and compensation, project architecture retrieval anchors, and a dynamic compaction line. See [the 0.3.1 release status](docs/release-status-0.3.1.md) and [the paired evaluation protocol](docs/paired-evaluation-protocol.zh.md) for verified version, distribution, validation, and evaluation-design status.

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
- Persistent, optionally Git-versioned `.dsh/compaction-fidelity/` project index: module map, architecture-level files, commands, schema/migration anchors.
- Architecture retrieval anchors: after a file is modified, its architecture-level neighbors/docs/tests are written to `.dsh/compaction-fidelity/anchors.md` and injected into the next step.
- Project retrieval: anchors are pointers to currently indexed files; `compaction-fidelity-brief` and `compaction-fidelity-lookup` retrieve exact project structure after compaction.
- AOCI-inspired architecture refresh gate: `status` / `refresh` commands, persistent scope registry, context-compaction priority collection, Git + content-hash change detection, weighted semantic score, and append-only updates whose latest entry is last; architecture writes use a cross-process lock + CAS + atomic rename.
- One master switch: installing the bundle enables everything; removing it restores the built-in DSH presets; `/compaction-fidelity on|off` switches the whole plugin at runtime.
- Managed scope rules: `architecture include <scope> <glob>` and `architecture exclude <scope> <glob>` store include/exclude filters in `.dsh/compaction-fidelity/architecture-scopes.json`; filtered scopes drive generated docs, baselines, change detection, and anchor injection.
- Architecture attestation: every ARCHITECTURE.md carries revision + structureHash + updateLogHash + entryCount; `architecture status` and `architecture verify` report mismatches.
- Attestation hashing normalizes CRLF, trailing whitespace, and repeated blank lines, so formatting-only refresh does not create false inconsistency.
- Re-include semantics: changes made while a scope pattern is excluded are not tracked; re-include starts from a fresh baseline of the current state.
- Explicit alignment check: `architecture check <scope>` reports aligned/stale/unknown, semantic score, detection method, attestation revision, and consistency. `aligned` means the semantic score is below the refresh threshold, not that the source files are byte-identical to the snapshot.
- Anchor quality: anchors are deduplicated by canonical identity, scored by relation strength, and capped per kind (tests 2, docs 1, database 2).
- Security hardening: scopes and glob patterns are validated, symlink escapes are rejected, and registry / reminder / calibration stores use locked compare-and-swap writes.
- Scheduling hardening: pre-step semantic checks are throttled per workspace/scope, session caches are capped, and fingerprint files are pruned to the newest 500.
- Privacy migration: legacy fingerprint sidecars can be audited or rewritten with `npm run migrate:fingerprint-privacy` (dry run by default; add `-- --apply` to back up first).
- Persistent reminder backoff: architecture refresh reminders back off 0 -> 5 minutes -> 30 minutes, then become status-only; state lives in `.dsh/compaction-fidelity/architecture-reminders.json`.
- Global injection budget: the summary instruction, compensation block, and pinned constraints share one CJK-aware token budget (`injectionMaxTokens`, default 16000). Low-priority project briefs, anchors, architecture docs, and refresh hints are dropped or shortened first; when truncation happens, the prompt records `<compaction_fidelity_injection_budget>` and the engine logs the affected blocks.
- Cross-lingual fidelity fingerprint: freezes exact values, lexical CJK bigrams, and structure before compaction, compares the generated summary, emits L0-L3 levels, appends a `fidelity_compensation` block for missing exact values, and writes metrics to `.dsh/compaction-fidelity/fingerprints/`.
- Language policy: default `auto` follows the session language (no double translation); `en` writes model prose in English but preserves verbatim user input and exact values.
- Before/after-compensation fingerprint calibration: raw-summary metrics and post-compensation metrics are compared per language group in `.dsh/compaction-fidelity/fidelity-calibration.json`; each sample records `dominantLanguage`, `mixedRatio`, `cjkRatio`, and `latinRatio`. Mixed sessions use a `mixed:<dominant>` group. Calibrated levels appear after 8 samples for a group; the diagnostic gate uses raw recall metrics and final probe/constraint checks, independently of historical percentiles.

### Calibration dashboard and cold-start import

`fidelity-calibration.json` is the evidence asset. Inspect current data and import validated samples from a JSON file inside the workspace:

```text
/compaction-fidelity calibration summary
/compaction-fidelity calibration import trusted-samples.json
```

The import requires `samples[]` with ISO timestamps, language/group keys, and `rawScore`/`finalScore` in `[0,1]`; it rejects invalid or oversized files, deduplicates identical samples, records the workspace-relative source, and keeps the latest 500 samples. It will not overwrite a damaged calibration store. A minimal valid source:

```json
{
  "samples": [
    { "at": "2026-10-06T00:00:00.000Z", "language": "zh", "calibrationKey": "zh", "rawScore": 0.68, "finalScore": 0.84 },
    { "at": "2026-10-06T00:01:00.000Z", "language": "en", "calibrationKey": "mixed:en", "mixedRatio": 0.42, "rawScore": 0.61, "finalScore": 0.71 }
  ]
}
```

The dashboard shows group counts and score percentiles. A calibrated level is available after 8 samples in a group; the diagnostic gate uses fixed recall thresholds and probe/constraint checks, independently of historical percentiles. Mixed groups never contribute to pure-language percentiles.

### Relationship to compression backends

This package **does override `summarize()`** in its `BasicCompactionEngine` subclass. It generates a bilingual summary, compares raw and compensated summaries, and records fidelity metrics. It is therefore a compaction backend with an observability layer, not a passive observer. Another backend such as `dsh-compaction-pro` also occupies the compaction service/row; simultaneous backend composition has not been validated and must not be assumed safe.

## Why it matters

- CJK token estimates: the optional local runtime patch uses 0.8 token/Chinese character; the bundle itself does not patch DSH's token meter on install.
- Effective budget: subtract output reserve and headroom before comparing the line.
- Fidelity: exact-value ledger + CJK bigrams + L0-L3 + compensation.
- Retrieval: project index + brief/lookup + architecture anchors.
- Safety net: minimal gets official compaction; plugin failure falls back.
- Local and auditable: .dsh/compaction-fidelity text index, no neural embeddings.
- Differentiation: ecosystem has threshold/checkpoint plugins; this focuses on bilingual loss.

## Why quantitative calibration

Selection- or verbatim-based compaction keeps the text it chooses; it does not tell you how many exact values or CJK bigrams the generated summary failed to retain. This project records per-language retention metrics for each compaction (raw summary vs final summary after compensation), stores that record under `.dsh/compaction-fidelity/`, and only after 8 samples per language group uses it to report a calibrated level. The gate remains deterministic while the data accumulates.

## Core ideas

- Summaries are lossy indexes, not transcripts.
- Preserve exact facts verbatim.
- Deterministic extraction over probabilistic guessing.
- Structures and anchors are cheaper than full copies.
- Keep the official safety net; disable must not mean unprotected.
- Every compaction loses information; early compaction is a trade-off.

## Known boundaries

- Before/after-compensation fingerprint calibration now records raw-summary vs post-compensation metrics per language group, but downstream QA correlation is not measured yet.
- Calibration requires 8 samples per language group; mixed zh/en sessions use a `mixed:<dominant>` group so they do not silently pollute pure zh/en statistics.
- Anchor quality weights are still fixed; a project-level weight override is a P1 candidate.
- Compensation/anchors may dilute attention; a 2048-token soft cap, category priority, anchor quality caps, and a CJK-aware 16000-token global injection budget are implemented, but the optimum thresholds still need more calibration samples.
- zh/en/bilingual strategy lacks controlled comparison; constraint ledger not covered.
- The 16000-token global injection budget is a conservative engineering cap, not an experimentally optimized value. When it triggers, the prompt records `<compaction_fidelity_injection_budget>` and the engine logs which blocks were dropped or shortened.
- Completion reserve follows the routed request/model; summaryMaxTokens and headroom default to 65536 each. Check the actual model budget before changing them.

## Install

On DSH Desktop `2.0.17` (bundled runtime `0.2.0-rc.2`), install the [v0.3.1 GitHub tag](https://github.com/TLNing260310/dsh-compaction-fidelity/releases/tag/v0.3.1) or a local checkout through the Desktop terminal/plugin manager. `0.3.1` is the current hardening release; the npm publication target is `dsh-compaction-fidelity@0.3.1`, and the Desktop community marketplace one-click path becomes available only after npm `latest` resolves to that stable version. Check `npm view dsh-compaction-fidelity version` before using the marketplace path. This repository is not yet listed in `awesome-dsh-plugin`.

Desktop CLI profile:

```powershell
dsh plugin --profile desktop add 'github:TLNing260310/dsh-compaction-fidelity#v0.3.1'
dsh plugin --profile desktop remove dsh-compaction-fidelity
```

For a separate CLI Web profile, replace `desktop` with `web`. The bundle patch inserts the host plugin row and overrides the built-in `preset-standard`, `preset-cordis`, `preset-ptc`, and `preset-minimal` compaction rows (inserting a group for `minimal`) with `dsh-compaction-fidelity/engine`. New sessions use the patched presets; running sessions keep their composed tree.

### DSH runtime fix

The bundled preset patch already adds a compaction group to `minimal`. Separately, an **optional, manual, host-modifying** script patches the installed DSH token meter for CJK estimates and can restore its backup. It is not run by installation and is not required for the bundle to load. Test it only against the `0.2.0-rc.2` runtime in DSH Desktop `2.0.17`; after any DSH update, re-check compatibility before using it:

```powershell
node scripts/patch-dsh-runtime.mjs
node scripts/patch-dsh-runtime.mjs --restore   # optional rollback
```

The script also edits the installed `minimal` preset and writes backups under `%USERPROFILE%\.dsh\runtime-fixes\backups`. This host modification is outside the marketplace bundle contract; the long-term fix belongs in an upstream token-meter extension or fix.


## Commands

```text
/compaction-fidelity status
/compaction-fidelity on | off
/compaction-fidelity threshold 256k | 350k | 512k | 800k | <tokens>
/compaction-fidelity retain <tokens>
/compaction-fidelity language auto | zh | en | bilingual
/compaction-fidelity calibration summary | import <workspace-relative-file.json>
/compaction-fidelity init | reindex
/compaction-fidelity verify
/compaction-fidelity brief
/compaction-fidelity anchors <file>
/compaction-fidelity lookup <query>
/compaction-fidelity purge --yes
/compaction-fidelity architecture check | read | create | refresh | status | verify | update | include | exclude | manage | unmanage [scope] [summary|pattern]
```

Tools: `compaction-fidelity-brief`, `compaction-fidelity-lookup`, `compaction-fidelity-architecture`.

## What is kept from Compaction-Fidelity

Persistent Git-versioned artifacts, local-first scanning, module/architecture cognition, schema/migration anchors, baseline/verify freshness, stable text formats (`project.meta.txt`, `project.code.txt`, `project.arch.txt`, `project.database.txt`).

## What is not ported

The 188K-line Go governance engine, the stdio MCP server and its 9 MCP tools, the full FRAS/Attestation/Ledger/Recovery state machine, agent-written semantic Whole-Index, live database introspection, and a full tree-sitter call graph. See `README.zh.md` and `THIRD-PARTY-NOTICES.md` for details.


Explicitly not ported or not planned:

- FRAS semantic authoring, Go governance state machine, stdio MCP server, full Attestation/Ledger/Recovery state machine.
- Managed Scope tri-role `index / observe / exclude`: `include / exclude` is implemented; `observe` remains out of scope.
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

Plugin SemVer is independent from the adapted Harness version. Harness compatibility is declared by the exact `@deepseek-ai/dsh` peer dependency.

- Current release: `0.3.1`
- Adapted Harness: `@deepseek-ai/dsh@0.2.0-rc.2` (community DSH Desktop `2.0.17`)
- Historical prereleases used `<harness-version>.plugin.<n>`, for example `0.2.0-rc.2.plugin.1.25`
- On a Harness compatibility change, keep plugin SemVer monotonic, update the peer, and record the mapping in `CHANGELOG.md`; do not encode the Harness version in the plugin version

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

Legacy fingerprint migration defaults to dry-run. Apply creates an exclusive backup inside the workspace; backups retain private text and must not be shared. It detects nested final-fidelity raw values and rejects linked paths, hard links, and reused backup directories. It leaves the calibration store untouched. See [the paired evaluation protocol](docs/paired-evaluation-protocol.zh.md) for the pending basic/pro/fidelity comparison. The current fidelity gate reports diagnostics; it does not block compaction.

