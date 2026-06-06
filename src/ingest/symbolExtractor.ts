// ---------------------------------------------------------------------------
// Tree-sitter symbol extraction for TS/JS/PHP/Rust
//
// Ported from four-opencode-rag/src/ingest/symbolExtractor.ts.
// Extracts function/class/method/struct/trait/enum names with qualified
// dot-notation paths, line ranges, and 10s timeout guard.
// ---------------------------------------------------------------------------

import { Parser, Language, Query, type Node } from "web-tree-sitter";
import { extname, join } from "path";
import { existsSync } from "fs";
import { log } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedSymbol {
  name: string;
  kind: string; // "class" | "function" | "method" | "interface" | "enum" | "trait" | "constant" | "struct"
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  /** Qualified symbol path in dot-notation (e.g. "ClassName.methodName") */
  symbol: string | null;
}

// ---------------------------------------------------------------------------
// Language config
// ---------------------------------------------------------------------------

interface LangConfig {
  wasmFile: string;
  npmPackage: string;
  query: string;
}

const LANG_CONFIGS: Record<string, LangConfig> = {
  typescript: {
    wasmFile: "tree-sitter-typescript.wasm",
    npmPackage: "tree-sitter-typescript",
    query: `
      (class_declaration name: (type_identifier) @class)
      (interface_declaration name: (type_identifier) @interface)
      (function_declaration name: (identifier) @function)
      (method_definition name: (property_identifier) @method)
      (enum_declaration name: (identifier) @enum)
    `,
  },
  tsx: {
    wasmFile: "tree-sitter-tsx.wasm",
    npmPackage: "tree-sitter-typescript",
    query: `
      (class_declaration name: (type_identifier) @class)
      (interface_declaration name: (type_identifier) @interface)
      (function_declaration name: (identifier) @function)
      (method_definition name: (property_identifier) @method)
      (enum_declaration name: (identifier) @enum)
    `,
  },
  javascript: {
    wasmFile: "tree-sitter-javascript.wasm",
    npmPackage: "tree-sitter-javascript",
    query: `
      (class_declaration name: (identifier) @class)
      (function_declaration name: (identifier) @function)
      (method_definition name: (property_identifier) @method)
    `,
  },
  php: {
    wasmFile: "tree-sitter-php.wasm",
    npmPackage: "tree-sitter-php",
    query: `
      (class_declaration name: (name) @class)
      (method_declaration name: (name) @method)
      (function_definition name: (name) @function)
      (const_declaration (const_element (name) @constant))
      (trait_declaration name: (name) @trait)
    `,
  },
  rust: {
    wasmFile: "tree-sitter-rust.wasm",
    npmPackage: "tree-sitter-rust",
    query: `
      (struct_item name: (type_identifier) @struct)
      (function_item name: (identifier) @function)
      (enum_item name: (type_identifier) @enum)
      (trait_item name: (type_identifier) @trait)
      (impl_item) @impl
    `,
  },
};

// ---------------------------------------------------------------------------
// Extension → language mapping
// ---------------------------------------------------------------------------

const EXTENSION_LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".php": "php",
  ".rs": "rust",
};

function getLanguageName(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANG_MAP[ext] ?? null;
}

// ---------------------------------------------------------------------------
// WASM resolution
// ---------------------------------------------------------------------------

function resolveWasmPath(filename: string, npmPackage: string): string {
  // 1. Check next to the built dist file (import.meta.dir)
  const metaDir = import.meta.dir ?? ".";
  const distPath = join(metaDir, filename);
  if (existsSync(distPath)) return distPath;

  // 2. Check node_modules/<pkg>/
  const cwd = process.cwd();
  const nmPath = join(cwd, "node_modules", npmPackage, filename);
  if (existsSync(nmPath)) return nmPath;

  // 3. Check node_modules/web-tree-sitter/ (for web-tree-sitter.wasm)
  const wtPath = join(cwd, "node_modules", "web-tree-sitter", filename);
  if (existsSync(wtPath)) return wtPath;

  throw new Error(
    `Cannot find Tree-sitter WASM file: "${filename}". ` +
      `Searched in "${distPath}" and node_modules/. ` +
      `Ensure the required tree-sitter grammar package is installed.`,
  );
}

// ---------------------------------------------------------------------------
// Qualified Symbol Path Builder
// ---------------------------------------------------------------------------

/**
 * Walk up the tree-sitter AST to build a qualified symbol path.
 *
 * For TypeScript:   "ClassName.methodName" or standalone "functionName"
 * For JavaScript:   same as TypeScript
 * For PHP:          "Namespace\ClassName.methodName" or "Namespace\functionName"
 * For Rust:         "StructName.methodName" or standalone "functionName"
 * For other langs:  best-effort, returns just the symbol name if no parent scope found.
 *
 * Handles both block-form namespaces (parent in AST) and semicolon-form
 * namespaces (sibling under `program`) for PHP.
 */
function buildQualifiedSymbolPath(node: Node, language: string): string {
  const parts: string[] = [];
  const isTsLike = language === "typescript" || language === "tsx" || language === "javascript";
  const isPhp = language === "php";
  const isRust = language === "rust";
  let foundNamespace = false;

  /**
   * Check whether `candidate` represents the same source position as `node`.
   * Used to avoid self-referencing when the captured name node IS the name
   * child of an enclosing declaration (e.g. "class Foo {}" — the capture IS Foo).
   */
  function isSelfRef(candidate: Node): boolean {
    return (
      candidate.startPosition.row === node.startPosition.row &&
      candidate.startPosition.column === node.startPosition.column &&
      candidate.endPosition.row === node.endPosition.row &&
      candidate.endPosition.column === node.endPosition.column
    );
  }

  // ── Step 1: Walk up to find enclosing scopes ─────────────────────────────
  let current: Node | null = node.parent;
  while (current && current.type !== "program" && current.type !== "source_file") {
    const type = current.type;

    // TS/JS scope containers — no nesting beyond class/interface/enum
    if (isTsLike) {
      if (
        type === "class_declaration" ||
        type === "interface_declaration" ||
        type === "enum_declaration" ||
        type === "module_declaration"
      ) {
        const nameChild = current.childForFieldName("name");
        if (nameChild && !isSelfRef(nameChild)) parts.unshift(nameChild.text.trim());
        break;
      }
    }

    // PHP scope containers — can nest (namespace → class → method)
    if (isPhp) {
      if (
        type === "class_declaration" ||
        type === "trait_declaration" ||
        type === "interface_declaration" ||
        type === "enum_declaration"
      ) {
        const nameChild = current.childForFieldName("name");
        if (nameChild && !isSelfRef(nameChild)) parts.unshift(nameChild.text.trim());
      }
      if (type === "namespace_definition") {
        const nameChild = current.childForFieldName("name");
        if (nameChild) {
          parts.unshift(nameChild.text.trim());
          foundNamespace = true;
        }
      }
    }

    // Rust scope containers — walk up through impl blocks, modules
    if (isRust) {
      if (
        type === "struct_item" ||
        type === "enum_item" ||
        type === "trait_item"
      ) {
        const nameChild = current.childForFieldName("name");
        if (nameChild && !isSelfRef(nameChild)) parts.unshift(nameChild.text.trim());
        break;
      }
      if (type === "impl_item") {
        // impl block: get type being implemented
        const typeChild = current.childForFieldName("type");
        if (typeChild) parts.unshift(typeChild.text.trim());
        break;
      }
      if (type === "mod_item") {
        const nameChild = current.childForFieldName("name");
        if (nameChild) parts.unshift(nameChild.text.trim());
      }
    }

    current = current.parent;
  }

  // ── Step 2 (PHP only): implicit namespace via semicolon form ─────────────
  if (isPhp && !foundNamespace) {
    let root: Node | null = node;
    while (root && root.type !== "program" && root.type !== "source_file") root = root.parent;
    if (root) {
      const captureLine = node.startPosition.row;
      let nsName: string | null = null;
      for (const child of root.children) {
        if (child.type === "namespace_definition" && child.endPosition.row < captureLine) {
          const nameChild = child.childForFieldName("name");
          if (nameChild) nsName = nameChild.text.trim();
        }
      }
      if (nsName) parts.unshift(nsName);
    }
  }

  // ── Step 3: Append the symbol's own name ─────────────────────────────────
  parts.push(node.text.trim());

  return parts.join(".");
}

// ---------------------------------------------------------------------------
// Singleton extractor
// ---------------------------------------------------------------------------

const EXTRACTION_TIMEOUT_MS = 10_000;

class SymbolExtractor {
  private static instance: SymbolExtractor;
  private initialized = false;
  private readonly parsers = new Map<string, Parser>();
  private readonly queries = new Map<string, Query>();

  static getInstance(): SymbolExtractor {
    if (!SymbolExtractor.instance) {
      SymbolExtractor.instance = new SymbolExtractor();
    }
    return SymbolExtractor.instance;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await Parser.init({
      locateFile: (name: string) => {
        const pkg = "web-tree-sitter";
        const cwd = process.cwd();
        const nmPath = join(cwd, "node_modules", pkg, name);
        if (existsSync(nmPath)) return nmPath;
        return join(import.meta.dir ?? ".", name);
      },
    });
    this.initialized = true;
  }

  async extractSymbols(
    content: string,
    filePath: string,
  ): Promise<ExtractedSymbol[]> {
    const langName = getLanguageName(filePath);
    if (!langName) return [];

    const config = LANG_CONFIGS[langName];
    if (!config) return [];

    await this.initialize();

    try {
      const parser = await this.getOrCreateParser(langName, config);
      const tree = parser.parse(content);
      if (!tree) return [];

      const query = this.queries.get(langName);
      if (!query) return [];

      const captures = query.captures(tree.rootNode);

      const symbols: ExtractedSymbol[] = [];
      const seen = new Set<string>();

      for (const capture of captures) {
        // Skip impl_item captures for Rust — those are containers, not symbols
        if (langName === "rust" && capture.name === "impl") continue;

        const name = capture.node.text.trim();
        if (!name || name.length === 0) continue;

        // Walk up to parent declaration for the full range
        const declNode = capture.node.parent ?? capture.node;

        // Dedup by name+startLine (allows same-named symbols in different scopes, e.g. Rust impl blocks)
        const dedupKey = `${name}@${declNode.startPosition.row}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const qualifiedPath = buildQualifiedSymbolPath(capture.node, langName);

        symbols.push({
          name,
          kind: capture.name,
          startLine: declNode.startPosition.row + 1, // 1-indexed
          endLine: declNode.endPosition.row + 1,
          symbol: qualifiedPath,
        });
      }

      return symbols;
    } catch (err) {
      // Silently return empty on parse failure
      return [];
    }
  }

  async extractSymbolsWithTimeout(
    content: string,
    filePath: string,
  ): Promise<ExtractedSymbol[]> {
    try {
      const result = await Promise.race([
        this.extractSymbols(content, filePath),
        new Promise<ExtractedSymbol[]>((_, reject) =>
          setTimeout(
            () => reject(new Error("Tree-sitter symbol extraction timed out")),
            EXTRACTION_TIMEOUT_MS,
          ),
        ),
      ]);
      return result;
    } catch (err) {
      log("warn", "symbol-extractor", `Timeout/error for ${filePath}: ${String(err)}`);
      return [];
    }
  }

  private async getOrCreateParser(
    langName: string,
    config: LangConfig,
  ): Promise<Parser> {
    const existing = this.parsers.get(langName);
    if (existing) return existing;

    const wasmPath = resolveWasmPath(config.wasmFile, config.npmPackage);
    const wasmBuffer = await Bun.file(wasmPath).arrayBuffer();
    const wasmLanguage = await Language.load(new Uint8Array(wasmBuffer));

    const parser = new Parser();
    parser.setLanguage(wasmLanguage);
    this.parsers.set(langName, parser);

    const query = new Query(wasmLanguage, config.query);
    this.queries.set(langName, query);

    return parser;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract symbols from source code content using tree-sitter with a 10s timeout.
 * Returns simplified symbol info (name, kind, start/end lines, qualified path).
 * Gracefully returns empty array on timeout, parse failure, or unsupported language.
 */
export async function extractSymbols(
  content: string,
  filePath: string,
): Promise<ExtractedSymbol[]> {
  return SymbolExtractor.getInstance().extractSymbolsWithTimeout(content, filePath);
}
