# References and Selective Integration

This document describes the project purpose, philosophy, target audience, and the external projects and research that influenced it.

## Purpose

Make long-running DSH sessions treat a compaction summary as a lossy index rather than a complete transcript.

Key facts must remain verifiable, compensable, and retrievable after compression.

## Philosophy

- The official compaction engine provides the transaction and overflow recovery path for session continuation.
- This plugin measures and compensates for loss of key facts and constraints, and adds project architecture retrieval; it does not guarantee downstream task correctness.
- Exact values such as paths, commands, errors, identifiers, and numbers take priority.
- Project architecture and database anchors must remain retrievable after compression.
- Hard and soft constraints must survive compaction.
- Indexes, fingerprints, and sidecar files stay inside the workspace and can be versioned with Git.
- The official compaction safety net is always preserved; plugin failure falls back instead of blocking the session.

## Who it is for

- DSH Desktop 2.0.17 users running its bundled Harness 0.2.0-rc.2.
- Long sessions in large or multi-module repositories.
- Chinese, English, or bilingual workflows.
- Tool-heavy sessions where context grows and auto-compaction is likely.
- Users who need exact commands, paths, errors, identifiers, and database structure after compaction.
- Users who need architecture-level retrieval instead of rereading the whole repository.

## Directly integrated concepts

- AOCI-CODE: architecture coordinates and long-term retrieval docs.
  It independently implements a folder-scoped ARCHITECTURE.md with Markdown, XML-style tags, and embedded JSON, using append-only updates.
- DeepSeek Harness compaction-basic: the official BasicCompactionEngine remains the safety net.
  This plugin subclasses it, replaces the preset's backend with that subclass, and overrides summarize(); the official compaction transaction and fallback remain in use.
- DeepSeek Harness token-meter: a local runtime patch adds a CJK-aware estimator.
  The patch script modifies the local DSH installation and does not copy DSH source code.
- dsh-compaction-pro: language-following summaries and high-fidelity templates.
  This project independently implements summaryLanguage, the exact-value ledger, and the checkpoint structure.
- dsh-context-checkpoint: summary persistence and post-compaction reinjection.
  This project uses the idea for architecture documents and retrieval anchors; it does not use pure static injection.
- dsh-context-truth: preventing the model's own context-pressure claims from surviving compaction.
  This project implements the rule in its summarization instruction.
- dsh-compaction-threshold: visible compaction-line control.
  This project independently implements the composer control and absolute-threshold policy.
- headroomlabs fidelity gate: compression fidelity regression gates.
  This project independently implements deterministic probes, constraint verdicts, and gate metrics.
- compaction-guard: three-way constraint outcomes (preserved, rewritten, dropped).
  This project independently implements compareConstraintLedger.

## Research and methodology references

Verified version, marketplace and ecosystem links are collected in [the 2026-10-06 audit](docs/DSH-compatibility-and-market-audit-2026-10-06.md). The research names below are historical design notes, not independently reproduced performance evidence.

The following works informed design decisions but no source code was copied from them.

- Governance Decay: constraint decay, Constraint Pinning, and operator-impersonation risk.
- Lost in Compaction: attention dilution, cross-language compression penalty, and the grep-LLM gap.
- What Does Context Compression Cost an Agent?: retrieval tool calls as a primary compression-quality metric.
- Calibration-Density Law: higher-signal density is preferable to larger low-density injection.
- openclaw keepRecentRatio, dsh-infinite-context, dsh-asc, and dsh-compaction-policy: dynamic retention and scheduling comparisons.
- DeepSeek prefix-cache engineering discussions: architecture risk reference for static and semi-static injection.

## License

Project code is licensed under the MIT License.
Third-party attributions are listed in THIRD-PARTY-NOTICES.md and licenses/.
No Go source code from AOCI-CODE is copied; the Node implementation is independent.

