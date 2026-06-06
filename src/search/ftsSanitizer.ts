// ---------------------------------------------------------------------------
// FTS5 query sanitizer — escape special characters and strip unsafe tokens
// before passing user input to FTS5 MATCH.
// ---------------------------------------------------------------------------

/**
 * Characters that have special meaning in FTS5 match syntax.
 * These are stripped from free-text input to prevent syntax errors
 * and injection-like misuse of the FTS5 query language.
 */
const FTS5_SPECIAL = /[*"()^~+`]/g;

/**
 * Reserved FTS5 keywords that act as boolean operators.
 * When these appear bare in user input, they will be dropped so the
 * query is treated as plain text search rather than FTS5 syntax.
 */
const RESERVED = /\b(AND|OR|NOT|NEAR)\b/i;

/**
 * Alphanumeric + underscore + German umlauts — safe for prefix matching.
 */
const SAFE_TOKEN = /^[a-zA-Z0-9_äöüßÄÖÜ]+$/;

/**
 * Empty or malformed queries return this sentinel value.
 */
const EMPTY_QUERY = "";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize a free-text query string for safe use in FTS5 MATCH.
 *
 * - Strips FTS5 special characters: *, ", (, ), ^, ~, +, `
 * - Drops bare reserved keywords (AND, OR, NOT, NEAR)
 * - Returns empty string `""` when no usable tokens remain
 * - Applies prefix-match (`*` suffix) on safe alphanumeric tokens
 * - Drops unsafe tokens (containing special chars or reserved words)
 *
 * @param query  Raw user query string
 * @returns      Sanitized FTS5 query string, or `""` if nothing usable remains
 *
 * @example
 * ```ts
 * sanitizeFtsQuery("hello world")         // => "hello* world*"
 * sanitizeFtsQuery('"quoted" AND OR')     // => "quoted*"
 * sanitizeFtsQuery("")                     // => ""
 * sanitizeFtsQuery("***")                  // => ""
 * ```
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query || typeof query !== "string") {
    return EMPTY_QUERY;
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return EMPTY_QUERY;
  }

  // Tokenize on whitespace
  const rawTokens = trimmed.split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) {
    return EMPTY_QUERY;
  }

  const safeTokens: string[] = [];

  for (const raw of rawTokens) {
    // 1. Strip FTS5 special characters
    let stripped = raw.replace(FTS5_SPECIAL, "");
    // Strip stray colons (filter syntax is handled separately by queryParser)
    stripped = stripped.replace(/:/g, "");

    // 2. Drop empty or punctuation-only tokens
    if (stripped.length === 0) continue;

    // 3. Drop bare reserved keywords
    if (RESERVED.test(stripped)) continue;

    // 4. Only accept safe alphanumeric tokens for prefix matching
    if (SAFE_TOKEN.test(stripped)) {
      safeTokens.push(`${stripped.toLowerCase()}*`);
    }
    // Non-safe tokens are dropped entirely
  }

  if (safeTokens.length === 0) {
    return EMPTY_QUERY;
  }

  // Join with spaces — FTS5 treats space as implicit AND
  return safeTokens.join(" ");
}
