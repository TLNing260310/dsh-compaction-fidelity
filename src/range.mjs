/**
 * Pure retention-range selection over one current surface snapshot.
 *
 * Inputs are deliberately primitive so this can be unit-tested without DSH:
 * - surfaceNodes: SessionSeq[] in model-visible order.
 * - measuredNodes: Array<{ seq, tokens }> aligned with surfaceNodes.
 * - eventTypeAt(seq): session event type, used only to exclude a leading system node.
 * - isBalancedBefore/After(seq): tool-pair balance checks from @deepseek-ai/dsh-compaction.
 */
export function pickRetentionRange({
  surfaceNodes,
  measuredNodes,
  eventTypeAt = () => undefined,
  isBalancedBefore = () => true,
  isBalancedAfter = () => true,
  retainTokens = 0,
} = {}) {
  const surface = Array.isArray(surfaceNodes) ? surfaceNodes : [];
  const measured = Array.isArray(measuredNodes) ? measuredNodes : [];
  if (surface.length < 2 || measured.length !== surface.length) return null;

  const tokensBySeq = new Map();
  for (const node of measured) tokensBySeq.set(node.seq, Number.isFinite(node.tokens) ? node.tokens : 0);

  let startIdx = eventTypeAt(surface[0]) === 'system/message' ? 1 : 0;
  if (startIdx >= surface.length - 1) return null;

  const budget = Math.max(0, Math.floor(retainTokens));
  let accumulated = 0;
  let endIdx = -1;
  for (let index = surface.length - 1; index >= startIdx; index -= 1) {
    accumulated += tokensBySeq.get(surface[index]) ?? 0;
    if (accumulated >= budget) {
      endIdx = index - 1;
      break;
    }
  }
  if (endIdx < startIdx) return null;

  // Never cut through an assistant tool call / tool result pair.
  while (endIdx >= startIdx && !isBalancedAfter(surface[endIdx])) endIdx -= 1;
  if (endIdx < startIdx) return null;

  while (startIdx <= endIdx && !isBalancedBefore(surface[startIdx])) startIdx += 1;
  if (startIdx > endIdx) return null;

  // A leading system/message is never compacted.
  if (startIdx === 0 && eventTypeAt(surface[0]) === 'system/message') startIdx = 1;
  if (startIdx > endIdx) return null;

  return { start: surface[startIdx], end: surface[endIdx], retainedFrom: surface[endIdx + 1] ?? null };
}
