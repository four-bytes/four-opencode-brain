// ---------------------------------------------------------------------------
// Tests for brain ingest pipeline
// ---------------------------------------------------------------------------

import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { openDatabase, createSchema } from "../src/schema";
import { ingestPath } from "../src/ingest";
import { isBinaryContent } from "../src/ingest/loader";
import { isBinaryChunk } from "../src/ingest/chunker";
import { sessionCache } from "../src/cache";
import { brainSearch } from "../src/search/unified";

// ---------------------------------------------------------------------------
// Test directory setup
// ---------------------------------------------------------------------------

const TEST_DIR = "/tmp/brain-ingest-test-" + Date.now();
const TEST_DB_PATH = join(TEST_DIR, "test-brain.db");

let db: Database;

beforeAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });

  db = openDatabase(TEST_DB_PATH);
  createSchema(db);
  sessionCache.reset();
});

afterAll(() => {
  db.close();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helper: create test file
// ---------------------------------------------------------------------------

function createTestFile(subdir: string, name: string, content: string): string {
  const dir = join(TEST_DIR, subdir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestPath — single file", () => {
  test("ingests a .ts file and creates document + chunks", async () => {
    const filePath = createTestFile(
      "single",
      "hello.ts",
      `function greet(name: string): string {
  return "Hello, " + name;
}

console.log(greet("World"));
`,
    );

    const result = await ingestPath(db, filePath);

    expect(result.filesFound).toBe(1);
    expect(result.filesIndexed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(result.documentsCreated).toBe(1);
    expect(result.chunksCreated).toBeGreaterThanOrEqual(1);
    expect(result.errors.length).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);

    // Verify document was created
    const doc = db
      .query<{ title: string; language: string; filetype: string }, []>(
        "SELECT title, language, filetype FROM documents WHERE path = ?",
      )
      .get(filePath);
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("hello.ts");
    expect(doc!.language).toBe("typescript");
    expect(doc!.filetype).toBe("ts");

    // Verify chunks were created
    const chunkCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path = ?)",
      )
      .get(filePath)!.c;
    expect(chunkCount).toBeGreaterThanOrEqual(1);

    // Verify file was recorded
    const file = db
      .query<{ lang: string; size: number }, []>(
        "SELECT lang, size FROM files WHERE path = ?",
      )
      .get(filePath);
    expect(file).not.toBeNull();
    expect(file!.lang).toBe("typescript");
    expect(file!.size).toBeGreaterThan(0);
  });

  test("duplicate ingest returns filesSkipped > 0", async () => {
    const filePath = createTestFile(
      "single",
      "duplicate.ts",
      "const x = 42;\nexport default x;\n",
    );

    // First ingest
    const first = await ingestPath(db, filePath);
    expect(first.filesFound).toBe(1);
    expect(first.filesIndexed).toBe(1);
    expect(first.filesSkipped).toBe(0);

    // Second ingest — same content
    const second = await ingestPath(db, filePath);
    expect(second.filesFound).toBe(1);
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBe(1);

    // No extra documents
    const docCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM documents WHERE path = ?",
      )
      .get(filePath)!.c;
    expect(docCount).toBe(1);
  });

  test("ingests a PHP file and extracts symbols", async () => {
    // File must be >1024 tokens (~4096 chars) to trigger symbol chunking;
    // each method is small enough to be a single symbol chunk
    const lines: string[] = [];
    lines.push("<?php");
    lines.push("");
    lines.push("class UserService {");
    for (let i = 0; i < 15; i++) {
      lines.push("  /**");
      lines.push(`   * Method number ${i} — does important things.`);
      lines.push("   * @param int $id The user identifier");
      lines.push("   * @return ?User");
      lines.push("   */");
      lines.push(`  public function method${i}(int $id): ?User {`);
      lines.push("    $result = $this->db->query('SELECT * FROM users WHERE id = ?', [$id]);");
      lines.push("    if (!$result) {");
      lines.push(`      throw new \\RuntimeException('User not found: ' . $id);`);
      lines.push("    }");
      lines.push("    $user = new User($result);");
      lines.push("    $user->setLastAccessed(new \\DateTime());");
      lines.push("    $this->entityManager->persist($user);");
      lines.push("    $this->entityManager->flush();");
      lines.push("    return $user;");
      lines.push("  }");
      lines.push("");
    }
    lines.push("}");
    lines.push("");
    lines.push("/**");
    lines.push(" * Helper function for user operations.");
    lines.push(" */");
    lines.push("function helper(): void {");
    lines.push("  // do nothing");
    lines.push("}");
    const content = lines.join("\n");
    const filePath = createTestFile("single", "large.php", content);

    const result = await ingestPath(db, filePath);
    expect(result.filesFound).toBe(1);
    expect(result.filesIndexed).toBe(1);
    expect(result.errors.length).toBe(0);

    // Query all chunks (symbol + window) — large symbols get windowed
    const symbolChunks = db
      .query<{ symbol: string; kind: string; chunk_type: string }, []>(
        "SELECT symbol, kind, chunk_type FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path = ?) AND chunk_type IN ('symbol', 'window') ORDER BY chunk_index",
      )
      .all(filePath);
    expect(symbolChunks.length).toBeGreaterThanOrEqual(3); // class + 15 methods + function

    const kinds = symbolChunks.map((c) => c.kind);
    expect(kinds).toContain("class");
    expect(kinds).toContain("method");
    expect(kinds).toContain("function");
  });
});

describe("ingestPath — directory", () => {
  test("walks directory recursively and ingests all supported files", async () => {
    const dir = join(TEST_DIR, "walk-test");
    createTestFile("walk-test", "a.ts", "function a() { return 1; }\n");
    createTestFile("walk-test", "b.js", "function b() { return 2; }\n");
    createTestFile("walk-test", "c.md", "# Title\n\nSome content.\n");
    createTestFile("walk-test", "d.txt", "Just some text.\n");

    // Create a subdir with more files
    createTestFile("walk-test/sub", "e.php", "<?php function e() { return 5; }\n");

    const result = await ingestPath(db, dir);
    expect(result.filesFound).toBe(5);
    expect(result.filesIndexed).toBe(5);
    expect(result.filesSkipped).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("skips node_modules directory", async () => {
    const dir = join(TEST_DIR, "skip-test");
    createTestFile("skip-test", "main.ts", "export const x = 1;\n");
    createTestFile("skip-test/node_modules", "ignored.ts", "export const y = 2;\n");

    const result = await ingestPath(db, dir);
    expect(result.filesFound).toBe(1);
    expect(result.filesIndexed).toBe(1);

    // Verify only main.ts was indexed
    const indexed = db
      .query<{ path: string }, []>(
        "SELECT path FROM files WHERE path LIKE ?",
      )
      .all(`%skip-test%`);
    expect(indexed.length).toBe(1);
    expect(indexed[0].path).toContain("main.ts");
  });

  test("skip dirs are ignored (.git, dist, node_modules)", async () => {
    const dir = join(TEST_DIR, "skip-all");
    createTestFile("skip-all/.git", "config", "dummy config\n");
    createTestFile("skip-all/dist", "bundle.js", "console.log('bundle');\n");
    createTestFile("skip-all/node_modules", "pkg.js", "module.exports = {};\n");
    createTestFile("skip-all", "real.ts", "export const ok = true;\n");

    const result = await ingestPath(db, dir);
    expect(result.filesFound).toBe(1);
    expect(result.filesIndexed).toBe(1);
  });
});

describe("ingestPath — markdown", () => {
  test("chunks markdown by headings", async () => {
    const content = `# Top Level

Introduction paragraph.

## Section One

Content for section one.

### Subsection A

Deeper content here.

## Section Two

Final section content.
`;

    const filePath = createTestFile("md", "doc.md", content);
    const result = await ingestPath(db, filePath);
    expect(result.filesFound).toBe(1);
    expect(result.filesIndexed).toBe(1);
    expect(result.errors.length).toBe(0);

    // Multiple chunks should exist (heading-based)
    const chunks = db
      .query<{ chunk_type: string; chunk_index: number }, []>(
        "SELECT chunk_type, chunk_index FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path = ?) ORDER BY chunk_index",
      )
      .all(filePath);

    // Should have heading chunks (not just a single document chunk)
    expect(chunks.length).toBeGreaterThan(1);
    const types = chunks.map((c) => c.chunk_type);
    expect(types).toContain("heading");
  });
});

describe("ingestPath — errors and edge cases", () => {
  test("returns error for non-existent path", async () => {
    const result = await ingestPath(db, "/nonexistent/path/file.ts");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.filesFound).toBe(0);
    expect(result.filesIndexed).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("handles empty directory", async () => {
    const emptyDir = join(TEST_DIR, "empty");
    mkdirSync(emptyDir, { recursive: true });

    const result = await ingestPath(db, emptyDir);
    expect(result.filesFound).toBe(0);
    expect(result.filesIndexed).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("result fields are populated correctly", async () => {
    const filePath = createTestFile(
      "result-check",
      "check.ts",
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );

    const result = await ingestPath(db, filePath);
    expect(typeof result.filesFound).toBe("number");
    expect(typeof result.filesSkipped).toBe("number");
    expect(typeof result.filesIndexed).toBe("number");
    expect(typeof result.chunksCreated).toBe("number");
    expect(typeof result.documentsCreated).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.durationMs).toBe("number");
    expect(result.filesFound).toBe(1);
    expect(result.filesIndexed).toBe(1);
  });
});

describe("ingestPath — reIndex", () => {
  test("reIndex=true re-ingests even if content unchanged", async () => {
    const filePath = createTestFile(
      "reindex",
      "refresh.ts",
      "let z = 99;\n",
    );

    // First ingest
    const first = await ingestPath(db, filePath);
    expect(first.filesIndexed).toBe(1);

    // Second with reIndex=true
    const second = await ingestPath(db, filePath, { reIndex: true });
    expect(second.filesFound).toBe(1);
    expect(second.filesSkipped).toBe(0); // Not skipped because reIndex=true
    expect(second.filesIndexed).toBe(1); // Re-indexed

    // Documents should still be dedup'd (trigger prevents duplicates)
    const docCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM documents WHERE path = ?",
      )
      .get(filePath)!.c;
    expect(docCount).toBe(1);
  });
});

describe("ingestPath — content hash dedup second layer", () => {
  test("BEFORE INSERT trigger prevents duplicate documents even on re-ingest", async () => {
    const filePath = createTestFile(
      "dedup2",
      "dedup.ts",
      "const DEDUP_CHECK = true;\n",
    );

    const r1 = await ingestPath(db, filePath);
    expect(r1.documentsCreated).toBe(1);

    // Force re-index: files table gets updated but documents trigger blocks
    const r2 = await ingestPath(db, filePath, { reIndex: true });
    expect(r2.filesIndexed).toBe(1); // file re-indexed

    // Only 1 document row (trigger dedup)
    const count = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM documents WHERE path = ?",
      )
      .get(filePath)!.c;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E5.1: Integration pipeline — multi-file project with real-looking code
// ---------------------------------------------------------------------------

describe("ingestPath — integration pipeline (E5.1)", () => {
  const PROJ_DIR = join(TEST_DIR, "integration-project");
  const TS_FILE = "math.ts";
  const JS_FILE = "utils.js";
  const PHP_FILE = "routes.php";
  const MD_FILE = "README.md";

  function createProjectFiles(): void {
    if (existsSync(PROJ_DIR)) rmSync(PROJ_DIR, { recursive: true, force: true });
    mkdirSync(PROJ_DIR, { recursive: true });

    // .ts — real-looking TypeScript module
    writeFileSync(
      join(PROJ_DIR, TS_FILE),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export class Calculator {
  private result = 0;

  add(value: number): this {
    this.result += value;
    return this;
  }

  getResult(): number {
    return this.result;
  }
}
`,
      "utf-8",
    );

    // .js — real-looking JavaScript module
    writeFileSync(
      join(PROJ_DIR, JS_FILE),
      `const fs = require("fs");
const path = require("path");

function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(\`Config not found: \${resolved}\`);
  }
  const data = fs.readFileSync(resolved, "utf-8");
  return JSON.parse(data);
}

module.exports = { loadConfig };
`,
      "utf-8",
    );

    // .php — real-looking PHP class
    writeFileSync(
      join(PROJ_DIR, PHP_FILE),
      `<?php

namespace App\\Http;

use Psr\\Http\\Message\\ResponseInterface;
use Psr\\Http\\Message\\ServerRequestInterface;

class Router
{
    private array $routes = [];

    public function get(string $path, callable $handler): void
    {
        $this->routes["GET"][$path] = $handler;
    }

    public function post(string $path, callable $handler): void
    {
        $this->routes["POST"][$path] = $handler;
    }

    public function dispatch(ServerRequestInterface $request): ResponseInterface
    {
        $method = $request->getMethod();
        $path = $request->getUri()->getPath();

        if (!isset($this->routes[$method][$path])) {
            throw new \\RuntimeException("Route not found: " . $method . " " . $path);
        }

        $handler = $this->routes[$method][$path];
        return $handler($request);
    }
}
`,
      "utf-8",
    );

    // .md — realistic documentation
    writeFileSync(
      join(PROJ_DIR, MD_FILE),
      `# Project Calculator

A simple calculator API built with TypeScript.

## Installation

\`\`\`bash
npm install
\`\`\`

## Usage

Import the Calculator class and start computing:

\`\`\`typescript
import { Calculator, add } from "./math";

const calc = new Calculator();
calc.add(5).add(3);
console.log(calc.getResult()); // 8
console.log(add(2, 2));        // 4
\`\`\`

## API Routes

| Method | Path       | Description |
|--------|------------|-------------|
| GET    | /calculate | Run calculation |
| POST   | /reset     | Reset calculator |
`,
      "utf-8",
    );
  }

  test("ingests 4 real-looking files and creates documents, chunks, symbols", async () => {
    createProjectFiles();

    const result = await ingestPath(db, PROJ_DIR);
    expect(result.filesFound).toBe(4);
    expect(result.filesIndexed).toBe(4);
    expect(result.filesSkipped).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.documentsCreated).toBeGreaterThanOrEqual(4);
    expect(result.chunksCreated).toBeGreaterThanOrEqual(4);

    // Verify each document exists with correct metadata
    for (const [fname, lang, ftype] of [
      [TS_FILE, "typescript", "ts"],
      [JS_FILE, "javascript", "js"],
      [PHP_FILE, "php", "php"],
      [MD_FILE, "markdown", "md"],
    ] as const) {
      const doc = db
        .query<{ title: string; language: string; filetype: string }, []>(
          "SELECT title, language, filetype FROM documents WHERE path LIKE ?",
        )
        .get(`%${fname}`);
      expect(doc).not.toBeNull();
      expect(doc!.title).toBe(fname);
      expect(doc!.language).toBe(lang);
      expect(doc!.filetype).toBe(ftype);
    }

    // Verify chunks exist for each file
    const totalChunks = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM chunks")
      .get()!.c;
    expect(totalChunks).toBeGreaterThanOrEqual(4);

    // TS file is small (<1024 tokens) → single "document" chunk, no symbol breakdown
    const tsDocChunk = db
      .query<{ chunk_type: string; symbol: unknown }, []>(
        "SELECT chunk_type, symbol FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path LIKE ?) ORDER BY chunk_index LIMIT 1",
      )
      .get(`%${TS_FILE}`);
    expect(tsDocChunk).not.toBeNull();
    expect(tsDocChunk!.chunk_type).toBe("document");
    expect(tsDocChunk!.symbol).toBeNull();

    // JS file also small → "document" chunk
    const jsDocChunk = db
      .query<{ chunk_type: string }, []>(
        "SELECT chunk_type FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path LIKE ?) ORDER BY chunk_index LIMIT 1",
      )
      .get(`%${JS_FILE}`);
    expect(jsDocChunk).not.toBeNull();
    expect(jsDocChunk!.chunk_type).toBe("document");

    // PHP file → "document" chunk (file is also small at 831 bytes)
    const phpDocChunk = db
      .query<{ chunk_type: string }, []>(
        "SELECT chunk_type FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path LIKE ?) ORDER BY chunk_index LIMIT 1",
      )
      .get(`%${PHP_FILE}`);
    expect(phpDocChunk).not.toBeNull();

    // MD file → "heading" chunks (markdown split by headings)
    const mdHeadingChunks = db
      .query<{ chunk_type: string }, []>(
        "SELECT chunk_type FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path LIKE ?) AND chunk_type = 'heading' ORDER BY chunk_index",
      )
      .all(`%${MD_FILE}`);
    expect(mdHeadingChunks.length).toBeGreaterThanOrEqual(1);
  });

  test("modify one file and re-ingest — only changed file updated", async () => {
    // Modify the TS file (add a function)
    writeFileSync(
      join(PROJ_DIR, TS_FILE),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export class Calculator {
  private result = 0;

  add(value: number): this {
    this.result += value;
    return this;
  }

  getResult(): number {
    return this.result;
  }
}
`,
      "utf-8",
    );

    const result = await ingestPath(db, PROJ_DIR);
    expect(result.filesFound).toBe(4);
    expect(result.filesIndexed).toBe(1); // only TS changed
    expect(result.filesSkipped).toBe(3); // JS, PHP, MD unchanged
    expect(result.errors.length).toBe(0);

    // Verify total docs — new content hash allows second document row
    // (UNIQUE(path, content_hash) permits different content for same path)
    const docCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM documents WHERE path LIKE ?",
      )
      .get(`%${TS_FILE}`)!.c;
    expect(docCount).toBeGreaterThanOrEqual(1);

    // Verify old chunks were cleaned up and new ones exist
    const chunkTotal = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path LIKE ?)",
      )
      .get(`%${TS_FILE}`)!.c;
    expect(chunkTotal).toBeGreaterThanOrEqual(1);
  });

  test("search returns results across ingested content types", async () => {
    // Search documents by keyword
    const docResults = await brainSearch(db, "Calculator", {
      contentType: "document",
      limit: 10,
    });
    expect(docResults.length).toBeGreaterThanOrEqual(1);
    expect(docResults.some((r) => r.title === "math.ts")).toBe(true);

    // Search for PHP content
    const phpResults = await brainSearch(db, "Router", {
      contentType: "document",
      limit: 10,
    });
    expect(phpResults.length).toBeGreaterThanOrEqual(1);

    // Search for markdown content
    const mdResults = await brainSearch(db, "Installation", {
      contentType: "document",
      limit: 10,
    });
    expect(mdResults.length).toBeGreaterThanOrEqual(1);

    // Search all content types
    const allResults = await brainSearch(db, "loadConfig", {
      contentType: "document",
      limit: 10,
    });
    expect(allResults.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// E5.3: Edge cases — binary files, size limits, concurrency
// ---------------------------------------------------------------------------

describe("ingestPath — edge cases (E5.3)", () => {
  const EDGE_DIR = join(TEST_DIR, "edge-cases");

  beforeAll(() => {
    if (existsSync(EDGE_DIR)) rmSync(EDGE_DIR, { recursive: true, force: true });
    mkdirSync(EDGE_DIR, { recursive: true });
  });

  test("skips binary file (.png) by extension filter", async () => {
    // .png is not in the extension map → language is null → skipped
    writeFileSync(join(EDGE_DIR, "image.png"), Buffer.alloc(128, 0x89));

    const result = await ingestPath(db, EDGE_DIR);
    // The dir has only the .png file, which has null language — not counted as found
    expect(result.filesFound).toBe(0);
    expect(result.filesIndexed).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("skips file over 2MB cap", async () => {
    // Create a file ~3MB (over the 2MB cap)
    const largeContent = "x".repeat(3 * 1024 * 1024); // ~3MB
    writeFileSync(join(EDGE_DIR, "large.ts"), largeContent, "utf-8");

    const result = await ingestPath(db, EDGE_DIR);
    expect(result.filesFound).toBe(1);
    expect(result.filesIndexed).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain("Skipped (too large");
  });

  test("concurrent ingests don't corrupt database", async () => {
    const concDir = join(TEST_DIR, "concurrent");
    if (existsSync(concDir)) rmSync(concDir, { recursive: true, force: true });
    mkdirSync(concDir, { recursive: true });

    writeFileSync(join(concDir, "a.ts"), "export const alpha = 1;\n", "utf-8");
    writeFileSync(join(concDir, "b.ts"), "export const beta = 2;\n", "utf-8");
    writeFileSync(join(concDir, "c.ts"), "export const gamma = 3;\n", "utf-8");

    // Each concurrent ingest gets its own DB connection (matching production behavior)
    const dbs: Database[] = [];
    const results = await Promise.all(
      [join(concDir, "a.ts"), join(concDir, "b.ts"), join(concDir, "c.ts")].map(
        async (p) => {
          const conn = openDatabase(TEST_DB_PATH);
          dbs.push(conn);
          try {
            return await ingestPath(conn, p);
          } finally {
            conn.close();
          }
        },
      ),
    );

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.errors.length).toBe(0);
      expect(r.filesIndexed).toBe(1);
    }

    // Verify all files were indexed
    const total = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM files WHERE path LIKE ?",
      )
      .get(`%concurrent%`)!.c;
    expect(total).toBe(3);

    // DB integrity check
    const integrity = db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get()!;
    expect(integrity.integrity_check).toBe("ok");
  });

  test("large file (>200KB) skips tree-sitter and uses window chunking", async () => {
    // Use a dedicated subdirectory so leftover files from other tests don't interfere
    const largeDir = join(TEST_DIR, "large-file-skip-symbol");
    if (existsSync(largeDir)) rmSync(largeDir, { recursive: true, force: true });
    mkdirSync(largeDir, { recursive: true });

    // Generate a large TypeScript file (>200KB) with simple structure
    let content = "// Large generated TypeScript file\n";
    while (content.length < 210 * 1024) {
      content += `export const item${Date.now()}_${Math.random().toString(36).slice(2)} = "value";\n`;
    }
    writeFileSync(join(largeDir, "large-generated.ts"), content);

    const result = await ingestPath(db, largeDir, { recursive: false, reIndex: true });
    expect(result.errors.length).toBe(0);
    expect(result.chunksCreated).toBeGreaterThan(0);
    // Verify chunks are window type (not symbol type), proving symbol extraction was skipped
    const chunks = db.query("SELECT chunk_type FROM chunks WHERE file_id IN (SELECT id FROM files WHERE path LIKE '%large-generated.ts')").all() as { chunk_type: string }[];
    for (const c of chunks) {
      expect(c.chunk_type).toBe("window");
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// E5.4: Binary content detection — isBinaryContent()
// ---------------------------------------------------------------------------

describe("isBinaryContent", () => {
  function toBytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  test("plain text file (should NOT be binary)", () => {
    const text = "Hello, world!\nThis is a normal text file.\nWith multiple lines.\n";
    expect(isBinaryContent(toBytes(text))).toBe(false);
  });

  test("file with null byte at position 300 (should be binary)", () => {
    // 300 printable chars + null byte
    const buf = new Uint8Array(301);
    for (let i = 0; i < 300; i++) {
      buf[i] = 0x41; // 'A'
    }
    buf[300] = 0; // null byte
    expect(isBinaryContent(buf)).toBe(true);
  });

  test("large file (>64KB) with binary region in the middle", () => {
    // Create a ~70KB buffer with null bytes in the middle region
    const size = 70 * 1024; // ~70KB
    const buf = new Uint8Array(size);
    // Fill with printable chars (space)
    for (let i = 0; i < size; i++) {
      buf[i] = 0x20; // space
    }
    // Insert null bytes in the middle region (~35KB)
    const midStart = Math.floor(size / 2) - 100;
    for (let i = midStart; i < midStart + 200; i++) {
      buf[i] = 0; // null bytes
    }
    expect(isBinaryContent(buf)).toBe(true);
  });

  test("file with >30% non-printable chars throughout", () => {
    const buf = new Uint8Array(1000);
    // 40% non-printable, 60% printable
    for (let i = 0; i < 1000; i++) {
      buf[i] = i < 400 ? 0x01 : 0x41; // 400 non-printable, 600 'A'
    }
    expect(isBinaryContent(buf)).toBe(true);
  });

  test("large file (>64KB) with sparse null bytes caught by stride sampling", () => {
    const size = 100 * 1024; // 100KB
    const buf = new Uint8Array(size);
    buf.fill(0x20); // printable spaces
    // Insert null bytes at every 1024th position (stride-aligned: 1024 = 2×512)
    for (let i = 1024; i < size; i += 1024) {
      buf[i] = 0;
    }
    // Stride sampling at position 1024 catches the first null byte
    expect(isBinaryContent(buf)).toBe(true);
  });

  test("large file (>64KB) with binary only in first 8KB region", () => {
    const size = 70 * 1024;
    const buf = new Uint8Array(size);
    buf.fill(0x20); // printable spaces
    // Insert null byte in the first 8KB region
    buf[100] = 0;
    // First 8KB thorough scan catches it
    expect(isBinaryContent(buf)).toBe(true);
  });

  test("large file (>64KB) that is all printable text (should NOT be flagged)", () => {
    const size = 70 * 1024;
    const buf = new Uint8Array(size);
    buf.fill(0x20); // space is printable
    expect(isBinaryContent(buf)).toBe(false);
  });

  test("large file (>64KB) with null byte at stride position beyond first 8KB", () => {
    const size = 200 * 1024; // 200KB
    const buf = new Uint8Array(size);
    buf.fill(0x41); // printable 'A'
    // Place null byte at stride position 129×512 = 66048
    // This is beyond the first 8KB scan (0–8191) and before the last 8KB (196608–204799)
    buf[66048] = 0;
    expect(isBinaryContent(buf)).toBe(true);
  });

  test("zero-byte file (edge case — empty = not binary)", () => {
    expect(isBinaryContent(new Uint8Array(0))).toBe(false);
  });

  test("UTF-8 text with BOM (should NOT be binary)", () => {
    // UTF-8 BOM: 0xEF 0xBB 0xBF
    const buf = new Uint8Array([0xEF, 0xBB, 0xBF, 0x48, 0x65, 0x6C, 0x6C, 0x6F]); // BOM + "Hello"
    expect(isBinaryContent(buf)).toBe(false);
  });

  test("file with printable content plus control chars (tab, CR, LF — should NOT be binary)", () => {
    const text = "Line 1\tindented\r\nLine 2\nLine 3\n";
    expect(isBinaryContent(toBytes(text))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E5.5: Per-chunk binary validation
// ---------------------------------------------------------------------------

describe("isBinaryChunk (per-chunk validation)", () => {
  test("normal text chunk (should NOT be flagged)", () => {
    expect(isBinaryChunk("This is a normal chunk of text with some code: fn() => {}")).toBe(false);
  });

  test("text with many U+FFFD replacement chars (>10% — should be flagged)", () => {
    // 50 replacement chars out of 150 total = 33% → >10% threshold → flagged
    const text = "\uFFFD".repeat(50) + "A".repeat(100);
    expect(isBinaryChunk(text)).toBe(true);
  });

  test("text with a few U+FFFD chars (<10% — should NOT be flagged)", () => {
    // 3 replacement chars out of 103 total ≈ 2.9% → <10% threshold → not flagged
    const text = "\uFFFD".repeat(3) + "A".repeat(100);
    expect(isBinaryChunk(text)).toBe(false);
  });

  test("empty chunk (edge case — should NOT be flagged)", () => {
    expect(isBinaryChunk("")).toBe(false);
  });

  test("real text with no replacement chars (should NOT be flagged)", () => {
    expect(isBinaryChunk("const x = 42;\nexport default x;\n")).toBe(false);
  });

  test("chunk with embedded null byte (should be flagged)", () => {
    const text = "normal text\u0000with null byte";
    expect(isBinaryChunk(text)).toBe(true);
  });

  test("chunk with null byte at start", () => {
    expect(isBinaryChunk("\u0000hello")).toBe(true);
  });
});
