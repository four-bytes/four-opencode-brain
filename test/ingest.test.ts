// ---------------------------------------------------------------------------
// Tests for brain ingest pipeline
// ---------------------------------------------------------------------------

import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { openDatabase, createSchema } from "../src/schema";
import { ingestPath } from "../src/ingest";
import { sessionCache } from "../src/cache";

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
    // File must be >200 lines to trigger symbol chunking (small files get document chunk)
    const lines: string[] = [];
    lines.push("<?php");
    lines.push("");
    lines.push("class UserService {");
    for (let i = 0; i < 50; i++) {
      lines.push(`  public function method${i}(int $id): ?User {`);
      lines.push("    return null;");
      lines.push("  }");
      lines.push("");
    }
    lines.push("}");
    lines.push("");
    lines.push("function helper(): void {");
    lines.push("  // do nothing");
    lines.push("}");
    const content = lines.join("\n");
    const filePath = createTestFile("single", "large.php", content);

    const result = await ingestPath(db, filePath);
    expect(result.filesFound).toBe(1);
    expect(result.filesIndexed).toBe(1);
    expect(result.errors.length).toBe(0);

    // Should have symbol chunks
    const symbolChunks = db
      .query<{ symbol: string; kind: string }, []>(
        "SELECT symbol, kind FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path = ?) AND chunk_type = 'symbol' ORDER BY chunk_index",
      )
      .all(filePath);
    expect(symbolChunks.length).toBeGreaterThanOrEqual(3); // class + 50 methods + function

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
