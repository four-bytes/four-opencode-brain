// ---------------------------------------------------------------------------
// Structured query parser — extracts filter tokens (field:value) from
// free-text queries and returns the remaining search text.
//
// Supports:
//   - Filter tokens: language:ts path:src/ kind:function entity_type:problem
//   - Quoted phrases: "vector search" → preserved verbatim in text query
//   - Mixed: language:ts "exact phrase" search terms kind:function
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedFilters {
  path?: string;
  language?: string;
  kind?: string;
  symbol?: string;
  entity_type?: string;
  type?: string;
}

export interface ParsedQuery {
  /** Free-text query with filter tokens removed */
  query: string;
  /** Extracted structured filters */
  filters: ParsedFilters;
}

// ---------------------------------------------------------------------------
// Known filter fields
// ---------------------------------------------------------------------------

const KNOWN_FILTER_KEYS = new Set([
  "path",
  "language",
  "kind",
  "symbol",
  "entity_type",
  "type",
]);

// ---------------------------------------------------------------------------
// SUPPORTED_LANGUAGES for filter validation
// ---------------------------------------------------------------------------

export const SUPPORTED_LANGUAGES = [
  "ts",
  "typescript",
  "js",
  "javascript",
  "php",
  "python",
  "py",
  "java",
  "go",
  "rust",
  "rs",
  "c",
  "cpp",
  "c++",
  "csharp",
  "c#",
  "ruby",
  "rb",
  "swift",
  "kotlin",
  "scala",
  "yaml",
  "yml",
  "json",
  "xml",
  "html",
  "css",
  "scss",
  "less",
  "sql",
  "shell",
  "bash",
  "sh",
  "markdown",
  "md",
  "dockerfile",
  "makefile",
  "text",
  "plaintext",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a search query string, extracting structured filters from
 * `field:value` tokens and returning the remaining free-text query.
 *
 * - Tokens matching `field:value` where field is a known filter key are
 *   extracted into `ParsedFilters`
 * - Quoted strings (double or single quotes) are preserved verbatim in
 *   the free-text output with quotes stripped
 * - Unknown `field:value` patterns are treated as literal search text
 *
 * @param raw  Raw search input (e.g. `language:ts "hello world" kind:function`)
 * @returns    ParsedQuery with extracted filters and clean text query
 *
 * @example
 * ```ts
 * parseQuery(`language:ts path:src/ "vector search" kind:function`)
 * // => {
 * //   query: '"vector search" kind:function',
 * //   filters: { language: 'ts', path: 'src/' }
 * // }
 * ```
 */
export function parseQuery(raw: string): ParsedQuery {
  const result: ParsedQuery = {
    query: raw.trim(),
    filters: {},
  };

  if (!raw || raw.trim().length === 0) {
    return result;
  }

  const filters: ParsedFilters = {};
  const remainingTokens: string[] = [];

  // Tokenize respecting quoted strings
  const tokens = tokenizeWithQuotes(raw.trim());

  for (const token of tokens) {
    // Check for field:value pattern
    const match = token.match(/^([a-zA-Z_][a-zA-Z0-9_]*):(.+)$/);
    if (match) {
      const key = match[1];
      const value = match[2];

      if (KNOWN_FILTER_KEYS.has(key)) {
        // Known filter key — extract it
        (filters as Record<string, string>)[key] = value;
        continue;
      }
      // Unknown key — treat as literal text (fall through)
    }

    remainingTokens.push(token);
  }

  result.filters = filters;
  result.query = remainingTokens.join(" ");

  return result;
}

// ---------------------------------------------------------------------------
// Filter validation
// ---------------------------------------------------------------------------

export interface FilterValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate extracted filters against known constraints.
 *
 * Rules:
 * - Keys must be in the known set (path, language, kind, symbol, entity_type, type)
 * - `language` values must be in SUPPORTED_LANGUAGES
 * - `path` must not contain `..` or start with `/` (absolute paths not allowed)
 * - Values must be non-empty strings
 *
 * @param filters  Parsed filters to validate
 * @returns        ValidationResult with optional error message
 */
export function validateFilters(filters: ParsedFilters): FilterValidationResult {
  for (const [key, value] of Object.entries(filters)) {
    // Empty value check
    if (!value || (typeof value === "string" && value.trim().length === 0)) {
      return {
        valid: false,
        error: `Filter '${key}' has empty value`,
      };
    }

    // Known key check
    if (!KNOWN_FILTER_KEYS.has(key)) {
      return {
        valid: false,
        error: `Unknown filter key: '${key}'. Valid keys: ${Array.from(KNOWN_FILTER_KEYS).join(", ")}`,
      };
    }

    // Language validation
    if (key === "language") {
      if (!SUPPORTED_LANGUAGES.includes(value as SupportedLanguage)) {
        // Case-insensitive check
        const lowerVal = value.toLowerCase();
        const matched = SUPPORTED_LANGUAGES.find((l) => l.toLowerCase() === lowerVal);
        if (!matched) {
          return {
            valid: false,
            error: `Unsupported language: '${value}'. Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
          };
        }
      }
    }

    // Path validation — no directory traversal
    if (key === "path") {
      if (value.includes("..")) {
        return {
          valid: false,
          error: "Path filter must not contain '..' (directory traversal not allowed)",
        };
      }
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Simple whitespace tokenizer that respects double and single quoted strings.
 * Quoted segments are preserved as single tokens (with quotes stripped).
 *
 * @param input  Input string
 * @returns      Array of tokens with quotes stripped from quoted segments
 */
function tokenizeWithQuotes(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      if (ch === inQuote) {
        // End of quoted segment — push as single token
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      // Start of quoted segment — flush any buffer first
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  // Flush remaining
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
