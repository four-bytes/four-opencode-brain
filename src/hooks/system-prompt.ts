// ---------------------------------------------------------------------------
// Unified brain system prompt — appended to opencode system prompt
// Token budget: ≤80 tokens
// ---------------------------------------------------------------------------

export function brainSystemPrompt(): string {
  return `brain_search: FTS5+vec search. Use before grep. English only. Output results, no reasoning.
brain_memory: add|search|list|forget|diary|get. Auto-captures.
brain_kb_*: add|get|record|review|search|stats. Confidence-gated. Output results, no reasoning.`;
}
