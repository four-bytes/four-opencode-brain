// ---------------------------------------------------------------------------
// Unified brain system prompt — appended to opencode system prompt
// Token budget: ≤70 tokens (~45 actual)
// ---------------------------------------------------------------------------

export function brainSystemPrompt(): string {
  return `brain_search: FTS5+vec search across docs+memories+knowledge. Use before grep. English queries only.
brain_memory: add|search|list|forget|diary|get. Auto-captures decisions.
brain_kb_*: add|get|record|review. Confidence-gated knowledge. New entries draft.`;
}
