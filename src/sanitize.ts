/**
 * Strips common sub-agent XML/JSON artifacts from layer content.
 * Preserves actual code content (XML in PHP, JSON in configs).
 *
 * Artifacts are short standalone closing tags that typically appear
 * at content boundaries between sub-agent handoffs.
 */
export function sanitizeLayerContent(content: string): string {
  // Lines that are ONLY a closing XML tag = artifact
  const artifactPatterns = [
    /^\s*<\/function_call>\s*$/,
    /^\s*<\/function_calls>\s*$/,
    /^\s*<\/function_call_stack>\s*$/,
    /^\s*<\/response>\s*$/,
    /^\s*<\/content>\s*$/,
  ];

  const lines = content.split("\n");
  const cleaned: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip standalone artifact lines
    if (artifactPatterns.some(p => p.test(trimmed))) {
      continue;
    }

    // Skip lines that are only a closing JSON/function brace artifact
    // Pattern: "}" preceded by no meaningful content on the same line
    if (trimmed === "}" && cleaned.length > 0) {
      const prev = cleaned[cleaned.length - 1].trim();
      // If previous line was also cleaned (artifact), this lone "}" likely is too
      if (prev === "" || prev.startsWith("//") || prev === "{") {
        continue;
      }
    }

    cleaned.push(line);
  }

  return cleaned.join("\n");
}