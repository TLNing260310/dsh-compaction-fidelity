/**
 * Attribution for durable messages this plugin injects.
 *
 * Session format v4 admits only producer-owned source kinds. The released v3
 * wrapper — kind 'plugin' plus a `plugin` field — is refused at admission:
 * @deepseek-ai/dsh-session-persistence-jsonl throws
 * "format v4 message requires a producer-owned source kind" for it, both when a
 * new message is adopted and when a stored row is re-read ("retired source
 * syntax"). A plugin still writing that wrapper therefore fails the whole step
 * that tries to inject, which is what happened to the ARCHITECTURE.md prompt
 * and the retrieval-anchor injection here.
 *
 * `plugin:<name>` is the kind DSH's own v3 -> v4 migration derives for this
 * plugin: `producerKind()` in @deepseek-ai/dsh-session-format-v3-to-v4 maps an
 * unrenamed released plugin string to `plugin:<string>`, and
 * `rewritePluginSource()` drops the `plugin` field. Injecting
 * `plugin:compaction-fidelity` therefore gives messages written after the
 * upgrade the same attribution as the ones migrated from before it, instead of
 * splitting one producer into two.
 */
export const PLUGIN_NAME = 'compaction-fidelity'

/** Frozen producer-owned source for every message this plugin injects. */
export const PRODUCER_SOURCE = Object.freeze({ kind: 'plugin:' + PLUGIN_NAME })

/**
 * Mirror of the v4 admission rule for a message source, so tests can assert the
 * contract without importing the DSH worker: an object source whose `kind` is a
 * non-empty string and is not the retired `'plugin'`.
 */
export function isProducerOwnedSource(source) {
  return source !== null
    && typeof source === 'object'
    && !Array.isArray(source)
    && typeof source.kind === 'string'
    && source.kind.length > 0
    && source.kind !== 'plugin'
}
