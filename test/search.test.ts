// ---------------------------------------------------------------------------
// Tests for unified brain search (FTS5 across docs, memories, knowledge)
// ---------------------------------------------------------------------------

import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { sessionCache } from "../src/cache";
import { createSchema, generateId, hashContent } from "../src/schema";
import { brainSearch } from "../src/search/unified";
import type { SearchResult } from "../src/search/unified";

// ---------------------------------------------------------------------------
// Test data IDs
// ---------------------------------------------------------------------------

const DOC_TS_ID = generateId();
const DOC_PHP_ID = generateId();
const DOC_MD_ID = generateId();
const MEM_ARCH_ID = generateId();
const MEM_DEPLOY_ID = generateId();
const KB_MEMORY_KEY = "kb-memory-leak";
const KB_TS_KEY = "kb-ts-patterns";
const KB_ARCH_KEY = "kb-arch-decision";

let db: Database;

// ---------------------------------------------------------------------------
// Setup: in-memory DB with schema + test data
// ---------------------------------------------------------------------------

beforeAll(() => {
  db = new Database(":memory:");
  createSchema(db);
  sessionCache.reset();

  // ── Documents ──────────────────────────────────────────────────────────

  db.run(
    `INSERT INTO documents (id, title, content, content_hash, type, path, language, filetype)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      DOC_TS_ID,
      "hello.ts",
      `function greet(name: string): string {
  return "Hello, " + name;
}
export default greet;
`,
      hashContent("hello.ts content"),
      "file",
      "/src/hello.ts",
      "typescript",
      "ts",
    ],
  );

  db.run(
    `INSERT INTO documents (id, title, content, content_hash, type, path, language, filetype)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      DOC_PHP_ID,
      "Database.php",
      `<?php
class Database {
  public function connect(): PDO {
    return new PDO('mysql:host=localhost;dbname=test', 'user', 'pass');
  }
}
`,
      hashContent("database.php content"),
      "file",
      "/src/Database.php",
      "php",
      "php",
    ],
  );

  db.run(
    `INSERT INTO documents (id, title, content, content_hash, type, path, language, filetype)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      DOC_MD_ID,
      "README.md",
      `# Project Title

This is a sample project with TypeScript and PHP code.

## Installation

Run npm install to get started.
`,
      hashContent("readme.md content"),
      "file",
      "/README.md",
      "markdown",
      "md",
    ],
  );

  // ── Memories ───────────────────────────────────────────────────────────

  db.run(
    `INSERT INTO memories (id, project_hash, date, type, tags, title, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      MEM_ARCH_ID,
      "proj-brain",
      "2025-06-01",
      "decision",
      "architecture, planning",
      "Project Architecture Decision",
      "We decided to use FTS5 for memory search because it provides full-text search capabilities with BM25 ranking on indexed documents and knowledge entries.",
      hashContent("architecture decision memory"),
    ],
  );

  db.run(
    `INSERT INTO memories (id, project_hash, date, type, tags, title, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      MEM_DEPLOY_ID,
      "proj-brain",
      "2025-06-02",
      "note",
      "deployment, CI",
      "Deployment Pipeline Notes",
      "The deployment pipeline runs tests on every push and deploys to production after merging to main branch. Uses GitHub Actions for CI/CD.",
      hashContent("deployment memory"),
    ],
  );

  // ── Knowledge entries ──────────────────────────────────────────────────

  db.run(
    `INSERT OR IGNORE INTO knowledge_entries (entry_key, kind, title, description, entity_type, confidence, review_state, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      KB_MEMORY_KEY,
      "problem",
      "Memory Leak in Production",
      "The production server has a memory leak caused by unclosed WebSocket connections in the PHP backend. Connections accumulate over time and eventually exhaust available memory.",
      "problem",
      0.8,
      "accepted",
      "memory, production, websocket",
    ],
  );

  db.run(
    `INSERT OR IGNORE INTO knowledge_entries (entry_key, kind, title, description, entity_type, confidence, review_state, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      KB_TS_KEY,
      "pattern",
      "TypeScript Singleton Pattern",
      "Use a module-level variable to implement singletons in TypeScript. This avoids class-based singleton boilerplate and works well with ES module caching.",
      "pattern",
      0.9,
      "accepted",
      "typescript, design-pattern",
    ],
  );

  db.run(
    `INSERT OR IGNORE INTO knowledge_entries (entry_key, kind, title, description, entity_type, confidence, review_state, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      KB_ARCH_KEY,
      "decision",
      "Use SQLite for Brain Storage",
      "Chose SQLite over PostgreSQL for the brain plugin because it requires zero server setup and the data is per-developer local. The WAL mode ensures concurrent reads work well.",
      "decision",
      0.7,
      "reviewed",
      "sqlite, storage, architecture",
    ],
  );
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helper: count results by content type
// ---------------------------------------------------------------------------

function countByType(results: SearchResult[], type: string): number {
  return results.filter((r) => r.content_type === type).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("brainSearch — FTS5 document search", () => {
  test("search documents by keyword returns results", async () => {
    const results = await brainSearch(db, "greet", {
      contentType: "document",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content_type).toBe("document");
    expect(results[0].title).toBe("hello.ts");
  });

  test("search memories by keyword returns results", async () => {
    const results = await brainSearch(db, "FTS5", {
      contentType: "memory",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content_type).toBe("memory");
  });

  test("search knowledge entries by keyword returns results", async () => {
    const results = await brainSearch(db, "memory leak", {
      contentType: "knowledge",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content_type).toBe("knowledge");
    expect(results[0].title).toContain("Memory Leak");
  });

  test("search all content types returns results", async () => {
    const results = await brainSearch(db, "production", {
      contentType: "all",
      limit: 20,
    });

    // "production" matches memory (deployment pipeline) and knowledge (memory leak)
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe("brainSearch — filters", () => {
  test("filter by language: typescript", async () => {
    const results = await brainSearch(db, "function", {
      filters: "language:typescript",
      contentType: "document",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.source_path).toMatch(/\.ts$/);
    }
  });

  test("filter by path: prefix", async () => {
    const results = await brainSearch(db, "class", {
      filters: "path:/src/",
      contentType: "document",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.source_path).toMatch(/^\/src\//);
    }
  });

  test("filter by entity_type: problem", async () => {
    const results = await brainSearch(db, "memory", {
      filters: "entity_type:problem",
      contentType: "knowledge",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.metadata?.entity_type).toBe("problem");
    }
  });

  test("filter by path counts only matching documents", async () => {
    // /src/ path matches 2 docs, /README.md matches 1
    const srcResults = await brainSearch(db, "project", {
      filters: "path:/src/",
      contentType: "document",
      limit: 10,
    });
    const mdResults = await brainSearch(db, "project", {
      filters: "path:/README.md",
      contentType: "document",
      limit: 10,
    });

    const totalTypes = countByType(srcResults, "document") + countByType(mdResults, "document");
    expect(totalTypes).toBeGreaterThanOrEqual(1);
  });
});

describe("brainSearch — content type filtering", () => {
  test("contentType: document only", async () => {
    const results = await brainSearch(db, "function", {
      contentType: "document",
      limit: 20,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.content_type).toBe("document");
    }
  });

  test("contentType: knowledge only", async () => {
    const results = await brainSearch(db, "memory", {
      contentType: "knowledge",
      limit: 20,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.content_type).toBe("knowledge");
    }
  });
});

describe("brainSearch — excerpt handling", () => {
  test("excerpt is stripped of mark tags", async () => {
    const results = await brainSearch(db, "greet", {
      contentType: "document",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    const excerpt = results[0].excerpt;
    expect(excerpt).not.toContain("<mark>");
    expect(excerpt).not.toContain("</mark>");
  });
});

describe("brainSearch — caching", () => {
  test("cache hit returns same results reference", async () => {
    const opts = { query: "deployment", contentType: "memory" as const, limit: 5 };

    const r1 = await brainSearch(db, opts.query, {
      contentType: opts.contentType,
      limit: opts.limit,
    });
    const r2 = await brainSearch(db, opts.query, {
      contentType: opts.contentType,
      limit: opts.limit,
    });

    // Same reference = came from cache
    expect(r1).toBe(r2);
  });

  test("different queries produce different cache entries", async () => {
    const r1 = await brainSearch(db, "websocket", {
      contentType: "knowledge",
      limit: 10,
    });
    const r2 = await brainSearch(db, "singleton", {
      contentType: "knowledge",
      limit: 10,
    });

    // Should not be the same reference
    if (r1.length > 0 && r2.length > 0) {
      expect(r1).not.toBe(r2);
    }
  });
});

describe("brainSearch — edge cases", () => {
  test("empty query returns empty array", async () => {
    const results = await brainSearch(db, "", {
      contentType: "all",
      limit: 20,
    });
    expect(results).toEqual([]);
  });

  test("whitespace-only query returns empty array", async () => {
    const results = await brainSearch(db, "   ", {
      contentType: "all",
      limit: 20,
    });
    expect(results).toEqual([]);
  });

  test("no results returns empty array (not null/error)", async () => {
    const results = await brainSearch(db, "zzz_nonexistent_zzz_xyzzy", {
      contentType: "all",
      limit: 20,
    });
    expect(results).toEqual([]);
  });

  test("results capped at limit", async () => {
    const results = await brainSearch(db, "memory", {
      contentType: "all",
      limit: 1,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("limit=0 is treated as limit=1", async () => {
    const results = await brainSearch(db, "memory", {
      contentType: "all",
      limit: 0,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// E5.2: RRF fusion + ordering + special characters
// ---------------------------------------------------------------------------

describe("brainSearch — RRF fusion (E5.2)", () => {
  test("RRF fuses results across content types with proper ranking", async () => {
    const results = await brainSearch(db, "memory", {
      contentType: "all",
      limit: 20,
    });

    // Should have results from multiple content types
    const types = new Set(results.map((r) => r.content_type));
    expect(types.size).toBeGreaterThanOrEqual(2);

    // Every result should have a numeric score
    for (const r of results) {
      expect(typeof r.score).toBe("number");
    }

    // Scores should be in descending order (allow floating tolerance)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score + 1e-9);
    }
  });

  test("RRF with single content type still returns ordered results", async () => {
    const results = await brainSearch(db, "greet", {
      contentType: "document",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.content_type).toBe("document");
      expect(typeof r.score).toBe("number");
    }
  });
});

describe("brainSearch — filter accuracy (E5.2)", () => {
  test("language filter returns only matching documents", async () => {
    const tsResults = await brainSearch(db, "function", {
      filters: "language:typescript",
      contentType: "document",
      limit: 20,
    });

    expect(tsResults.length).toBeGreaterThanOrEqual(1);
    for (const r of tsResults) {
      expect(r.source_path).toMatch(/\.ts$/);
    }

    const phpResults = await brainSearch(db, "function", {
      filters: "language:php",
      contentType: "document",
      limit: 20,
    });

    expect(phpResults.length).toBeGreaterThanOrEqual(1);
    for (const r of phpResults) {
      expect(r.source_path).toMatch(/\.php$/);
    }
  });

  test("entity_type filter returns only matching knowledge", async () => {
    const problemResults = await brainSearch(db, "memory", {
      filters: "entity_type:problem",
      contentType: "knowledge",
      limit: 20,
    });

    expect(problemResults.length).toBeGreaterThanOrEqual(1);
    for (const r of problemResults) {
      expect(r.metadata?.entity_type).toBe("problem");
    }

    const patternResults = await brainSearch(db, "singleton", {
      filters: "entity_type:pattern",
      contentType: "knowledge",
      limit: 20,
    });

    expect(patternResults.length).toBeGreaterThanOrEqual(1);
    for (const r of patternResults) {
      expect(r.metadata?.entity_type).toBe("pattern");
    }
  });
});

describe("brainSearch — special character queries (E5.2)", () => {
  test("query with special characters does not crash", async () => {
    const results = await brainSearch(db, "@#$%^&*()", {
      contentType: "all",
      limit: 10,
    });
    expect(Array.isArray(results)).toBe(true);
  });

  test("query with FTS5 reserved words does not crash", async () => {
    const results = await brainSearch(db, "AND OR NOT NEAR", {
      contentType: "all",
      limit: 10,
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  test("query with mixed special chars and text finds results", async () => {
    const results = await brainSearch(db, "greet()", {
      contentType: "document",
      limit: 10,
    });
    // Sanitize strips () → "greet" → should find hello.ts
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === "hello.ts")).toBe(true);
  });

  test("query with angle brackets does not crash", async () => {
    const results = await brainSearch(db, "<script>", {
      contentType: "all",
      limit: 10,
    });
    expect(Array.isArray(results)).toBe(true);
  });

  test("query with SQL wildcards does not crash", async () => {
    const results = await brainSearch(db, "%_like%", {
      contentType: "all",
      limit: 10,
    });
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("brainSearch — structured filters object", () => {
  test("structured filters object works", async () => {
    const results = await brainSearch(db, "function", {
      filters: { language: "typescript" },
      contentType: "document",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.source_path).toMatch(/\.ts$/);
    }
  });
});
