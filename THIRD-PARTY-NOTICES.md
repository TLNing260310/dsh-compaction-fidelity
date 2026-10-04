# Third-party notices

## AOCI-CODE

This plugin re-implements concepts from the AOCI-CODE project (`github.com/aoci-spec/aoci-code`): persistent project cognition artifacts, architecture-level indexing, baseline/verify-style freshness governance, and in-repo textual index formats. No Go source code is copied. The original project is licensed under FSL-1.1-MIT; a copy of its license is included at `licenses/AOCI-FSL-1.1-MIT.txt`.

If you later copy AOCI source code into this plugin, FSL-1.1-MIT obligations (including its Competing Use restriction for the first two years) apply to that copied code. The independent Node implementation in this package is licensed under MIT.

## DeepSeek Harness preset rows

`cordis.patch.yml` is generated from the built-in DSH 0.2.0-rc.2 agent preset definitions shipped by `@deepseek-ai/dsh-web-app` (MIT). The generated file retains the upstream plugin rows and only replaces the compaction/pruner entries. See `scripts/generate-preset-patch.mjs` for the exact transformation.

## DeepSeek Harness packages

This package depends on peer packages published by DeepSeek under the MIT license, including `@deepseek-ai/cordis`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-compaction`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-util-values`, and `@deepseek-ai/schemastery`.


## Referenced projects and research

The following projects and research informed design decisions. No source code was copied from them.
See REFERENCES.md for the integration status of each item.

- dsh-compaction-pro
- dsh-context-checkpoint
- dsh-context-truth
- dsh-compaction-threshold
- headroomlabs fidelity gate
- compaction-guard
- Governance Decay
- Lost in Compaction
- What Does Context Compression Cost an Agent?
- Calibration-Density Law
- openclaw keepRecentRatio
- dsh-infinite-context
- dsh-asc
- dsh-compaction-policy
