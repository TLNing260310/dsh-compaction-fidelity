# Changelog

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

