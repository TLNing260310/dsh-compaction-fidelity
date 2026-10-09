# Architecture registry lifecycle

The managed-scope registry lives at `<workspace>/<indexDir>/architecture-scopes.json`
(`indexDir` defaults to `.dsh/compaction-fidelity`). It is the single read
policy for folder-scoped architecture documents: every read, index write,
cache hit, anchor injection, and creation prompt goes through it.

A registry only ever *narrows* what may be read. It can never widen access.

## Lifecycle rules

- A **missing** registry file means "unmanaged workspace". Unregistered scopes
  keep the default document name (`ARCHITECTURE.md`, or the configured
  `architectureDocName`), and no scope is registered.
- `manage` only reports rule state. It never creates the file.
- Explicit rule changes (`include`, `exclude`, `unmanage`) and the
  scope-registration path may create the file.
- Ordinary reads never create or rewrite the registry.
- A file that exists but cannot be parsed, whose schema cannot be honored, or
  that is blank is **corrupt**, not missing. Corrupt is fail-closed: every
  architecture read, index write, cache hit, and injection target is refused,
  and the file is never silently overwritten or rebuilt. Repair it by hand.
- Retrieval artifacts (index, brief, anchors) record the read-policy
  fingerprint they were built under, so a rule change or a corrupt registry
  invalidates them instead of serving content the current rules no longer allow.
- The document disappears with `exclude`; it is not deleted from disk.

## Refusal reasons

| Reason | Layer | Meaning | `target` |
|---|---|---|---|
| `invalid-scope` | outcome | scope is not a safe workspace-relative path (absolute, drive letter, NUL, `..` segment, empty) | `null` |
| `denied-scope` | outcome | this scope's own rule excludes the document | `null` |
| `denied-ancestor` | outcome | a rule registered above this scope excludes the document | `null` |
| `corrupt-registry` | outcome | the registry exists but cannot be honored | `null` |
| `missing` | filesystem | policy allowed the scope, but the document does not exist | source pointer |
| `unsafe-path` | filesystem | the resolved path escapes the workspace or is otherwise unsafe | source pointer |
| `symlink` | filesystem | the target, or an ancestor directory, is a symlink | source pointer |
| `too-large` | filesystem | the document exceeds `MAX_ARCHITECTURE_DOC_BYTES` (1 MiB) | source pointer |
| `unreadable` | filesystem | the document exists but cannot be read | source pointer |

`managedDocOutcomeFor` produces only outcome-layer refusals. Filesystem
failures are produced by `readManagedArchitectureDoc` and are only reachable
after the policy allowed the document. A filesystem failure keeps a source
pointer for diagnostics, but that pointer is not an operable target: no
mutation may use it. A refusal always wins over a missing document, so a
denied scope with no document on disk reports the refusal, never `missing`.

## Rule-management flow

`manage`, `include`, `exclude`, and `unmanage` are processed before any
document resolution:

1. Parse the action and scope. An invalid scope is refused immediately.
2. `manage` reads the registry state and returns the rule summary; it never
   resolves or reads the document.
3. `include`/`exclude`/`unmanage` write through the existing file lock,
   atomic replace, and CAS helper.
4. On success, the registry is re-read; the in-memory result is never reused.
5. Access is re-evaluated. Only an allowed scope is registered, and only an
   allowed scope whose document already exists is refreshed. A refusal
   refreshes nothing, registers nothing, and writes no baseline; the response
   reports the rule result and the refused document access as two separate
   facts.
6. A write failure changes nothing and is reported with a distinct reason:
   `registry-write-failed`, `registry-cas-conflict`, `registry-locked`, or
   `corrupt-registry`.

`create`, `refresh`, `update`, and baseline writes re-check the policy
immediately before mutating, and never reuse a target resolved under an older
registry. A document mutation that succeeds while the baseline write fails is
reported as a partial completion (`mutationApplied: true`,
`baselineWritten: false`) with a diagnostic log entry; it is not reported as a
full success or as a failure, and this round does not promise an automatic
retry.

## Concurrency limits (not solved by this design)

- Registry reads and writes are not protected by a cross-process lock:
  concurrent writers in separate processes are undefined.
- The registry, the document, and the baseline are not covered by a joint
  transaction. This round reuses the existing lock/atomic-replace/CAS helpers
  and does not promise cross-file atomicity.
- There is no `registry-changed` secondary validation between the policy
  decision and the read, so a concurrent rule change inside that window is not
  detected. A post-read check could only suppress a result; it cannot undo a
  read that already happened.
- Prompt state (`architectureAsked`) remains in-memory and is not persisted.
- Change detection is not gated on Git tracking; this round does not claim that
  untracked files escape hash detection.
