// ---------------------------------------------------------------------------
// Simplified tree-sitter symbol extraction for TS/JS/PHP
//
// Ported from four-opencode-rag/src/ingest/symbolExtractor.ts.
// Simplified: extracts only function/class/method names + line ranges.
// No qualified symbol paths or dot-notation.
// ---------------------------------------------------------------------------

import { Parser, Language, Query } from "web-tree-sitter";
import { extname, join } from "path";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedSymbol {
  name: string;
  kind: string; // "class" | "function" | "method" | "interface" | "enum" | "trait" | "constant"
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
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
};

// ---------------------------------------------------------------------------
// WASM resolution
// ---------------------------------------------------------------------------

const EXTENSION_LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".php": "php",
};

function getLanguageName(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANG_MAP[ext] ?? null;
}

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
// Singleton extractor
// ---------------------------------------------------------------------------

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
        // web-tree-sitter.wasm is always from web-tree-sitter package
        const pkg = "web-tree-sitter";
        const cwd = process.cwd();
        const nmPath = join(cwd, "node_modules", pkg, name);
        if (existsSync(nmPath)) return nmPath;
        // fallback to import.meta.dir
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
        const name = capture.node.text.trim();
        if (!name || name.length === 0 || seen.has(name)) continue;
        seen.add(name);

        // Walk up to parent declaration for the full range
        const declNode = capture.node.parent ?? capture.node;

        symbols.push({
          name,
          kind: capture.name,
          startLine: declNode.startPosition.row + 1, // 1-indexed
          endLine: declNode.endPosition.row + 1,
        });
      }

      return symbols;
    } catch (err) {
      // Silently return empty on parse failure
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
 * Extract symbols from source code content using tree-sitter.
 * Returns simplified symbol info (name, kind, start/end lines).
 * Gracefully returns empty array on parse failure or unsupported language.
 */
export async function extractSymbols(
  content: string,
  filePath: string,
): Promise<ExtractedSymbol[]> {
  return SymbolExtractor.getInstance().extractSymbols(content, filePath);
}
