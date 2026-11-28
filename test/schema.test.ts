import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

import { openDatabase, createSchema, generateId, hashContent, initBrainDatabase, SCHEMA_VERSION, runMigrations, runIntegrityChecks, dbStats, resolveDatabasePath } from "../src/schema";
import { resetConfig } from "../src/config";

// ---------------------------------------------------------------------------
// Test suite — unified brain.db schema
// ---------------------------------------------------------------------------

const TEST_DIR = "/tmp/brain-test-" + Date.now();
const TEST_DB = join(TEST_DIR, "brain.db");

let db: Database;

function tableExists(name: string): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name);
  return row !== null;
}

function ftsTableExists(name: string): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name);
  return row !== null;
}

beforeAll(() => {
  // Start fresh: remove leftovers from previous runs
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });

  db = openDatabase(TEST_DB);
  createSchema(db);
});

afterAll(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// openDatabase
// ---------------------------------------------------------------------------

describe("openDatabase", () => {
  test("creates brain.db at the given path", () => {
    expect(existsSync(TEST_DB)).toBe(true);
  });

  test("enables WAL journal mode", () => {
    const row = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get()!;
    expect(row.journal_mode.toLowerCase()).toBe("wal");
  });

  test("enables foreign keys", () => {
    const row = db
      .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
      .get()!;
    expect(row.foreign_keys).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BRAIN_HOME
// ---------------------------------------------------------------------------

describe("BRAIN_HOME", () => {
  test("resolveDatabasePath() returns <BRAIN_HOME>/brain.db when BRAIN_HOME is set", () => {
    const prev = process.env.BRAIN_HOME;
    const home = join(TEST_DIR, "brain-home-resolve");
    process.env.BRAIN_HOME = home;
    resetConfig();
    try {
      expect(resolveDatabasePath()).toBe(join(home, "brain.db"));
    } finally {
      if (prev === undefined) delete process.env.BRAIN_HOME;
      else process.env.BRAIN_HOME = prev;
      resetConfig();
    }
  });

  test("resolveDatabasePath(explicit) returns the explicit path even with BRAIN_HOME set", () => {
    const prev = process.env.BRAIN_HOME;
    process.env.BRAIN_HOME = join(TEST_DIR, "brain-home-explicit");
    resetConfig();
    try {
      expect(resolveDatabasePath("/explicit/x.db")).toBe("/explicit/x.db");
    } finally {
      if (prev === undefined) delete process.env.BRAIN_HOME;
      else process.env.BRAIN_HOME = prev;
      resetConfig();
    }
  });

  test("openDatabase() with no argument creates the DB under BRAIN_HOME", () => {
    const prev = process.env.BRAIN_HOME;
    const dir = join(TEST_DIR, "brain-home-open-" + Date.now());
    process.env.BRAIN_HOME = dir;
    resetConfig();
    try {
      const handle = openDatabase();
      handle.close();
      expect(existsSync(join(dir, "brain.db"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BRAIN_HOME;
      else process.env.BRAIN_HOME = prev;
      resetConfig();
    }
  });

  test("initBrainDatabase() with no argument creates the DB and schema under BRAIN_HOME", () => {
    const prev = process.env.BRAIN_HOME;
    const dir = join(TEST_DIR, "brain-home-init-" + Date.now());
    process.env.BRAIN_HOME = dir;
    resetConfig();
    try {
      const handle = initBrainDatabase();
      try {
        expect(existsSync(join(dir, "brain.db"))).toBe(true);
        const row = handle
          .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sqlite_master")
          .get()!;
        expect(row.c).toBeGreaterThan(0);
      } finally {
        handle.close();
      }
    } finally {
      if (prev === undefined) delete process.env.BRAIN_HOME;
      else process.env.BRAIN_HOME = prev;
      resetConfig();
    }
  });
});

// ---------------------------------------------------------------------------
// createSchema — base tables
// ---------------------------------------------------------------------------

describe("createSchema — base tables", () => {
  test("documents table exists", () => {
    expect(tableExists("documents")).toBe(true);
  });

  test("chunks table exists", () => {
    expect(tableExists("chunks")).toBe(true);
  });

  test("files table exists", () => {
    expect(tableExists("files")).toBe(true);
  });

  test("memories table exists", () => {
    expect(tableExists("memories")).toBe(true);
  });

  test("diary_entries table exists", () => {
    expect(tableExists("diary_entries")).toBe(true);
  });

  test("knowledge_entries table exists", () => {
    expect(tableExists("knowledge_entries")).toBe(true);
  });

  test("knowledge_occurrences table exists", () => {
    expect(tableExists("knowledge_occurrences")).toBe(true);
  });

  test("knowledge_revisions table exists", () => {
    expect(tableExists("knowledge_revisions")).toBe(true);
  });

  test("metadata table exists", () => {
    expect(tableExists("metadata")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSchema — FTS5 virtual tables
// ---------------------------------------------------------------------------

describe("createSchema — FTS5 virtual tables", () => {
  test("documents_fts exists", () => {
    expect(ftsTableExists("documents_fts")).toBe(true);
  });

  test("memories_fts exists", () => {
    expect(ftsTableExists("memories_fts")).toBe(true);
  });

  test("entries_fts exists", () => {
    expect(ftsTableExists("entries_fts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSchema — triggers
// ---------------------------------------------------------------------------

describe("createSchema — triggers", () => {
  function triggerExists(name: string): boolean {
    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name=?",
      )
      .get(name);
    return row !== null;
  }

  // FTS5 sync triggers
  test("documents_ai", () => expect(triggerExists("documents_ai")).toBe(true));
  test("documents_ad", () => expect(triggerExists("documents_ad")).toBe(true));
  test("documents_au", () => expect(triggerExists("documents_au")).toBe(true));
  test("memories_ai", () => expect(triggerExists("memories_ai")).toBe(true));
  test("memories_ad", () => expect(triggerExists("memories_ad")).toBe(true));
  test("memories_au", () => expect(triggerExists("memories_au")).toBe(true));
  test("entries_ai", () => expect(triggerExists("entries_ai")).toBe(true));
  test("entries_ad", () => expect(triggerExists("entries_ad")).toBe(true));
  test("entries_au", () => expect(triggerExists("entries_au")).toBe(true));

  // Dedup triggers
  test("documents_dedup_bi", () =>
    expect(triggerExists("documents_dedup_bi")).toBe(true));
  test("chunks_dedup_bi", () =>
    expect(triggerExists("chunks_dedup_bi")).toBe(true));
  test("memories_dedup_bi", () =>
    expect(triggerExists("memories_dedup_bi")).toBe(true));
});

// ---------------------------------------------------------------------------
// Content-hash dedup
// ---------------------------------------------------------------------------

describe("content-hash dedup", () => {
  test("blocks duplicate document insert (same path + hash)", () => {
    const docId1 = generateId();
    const docId2 = generateId();
    const hash = hashContent("dedup test content");

    db.run(
      "INSERT INTO documents (id, title, content, content_hash, path) VALUES (?, ?, ?, ?, ?)",
      [docId1, "Doc 1", "dedup test content", hash, "/dedup/path.md"],
    );
    db.run(
      "INSERT INTO documents (id, title, content, content_hash, path) VALUES (?, ?, ?, ?, ?)",
      [docId2, "Doc 2", "dedup test content", hash, "/dedup/path.md"],
    );

    const count = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM documents WHERE path = ? AND content_hash = ?",
      )
      .get("/dedup/path.md", hash)!.c;
    expect(count).toBe(1);

    // clean up
    db.run("DELETE FROM documents WHERE path = ?", ["/dedup/path.md"]);
  });

  test("allows same hash with different path", () => {
    const id1 = generateId();
    const id2 = generateId();
    const hash = hashContent("same content diff path");

    db.run(
      "INSERT INTO documents (id, title, content, content_hash, path) VALUES (?, ?, ?, ?, ?)",
      [id1, "A", "same content diff path", hash, "/path/a.md"],
    );
    db.run(
      "INSERT INTO documents (id, title, content, content_hash, path) VALUES (?, ?, ?, ?, ?)",
      [id2, "B", "same content diff path", hash, "/path/b.md"],
    );

    const count = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM documents WHERE content_hash = ?",
      )
      .get(hash)!.c;
    expect(count).toBe(2);

    db.run("DELETE FROM documents WHERE content_hash = ?", [hash]);
  });

  test("blocks duplicate chunk insert (same hash)", () => {
    const docId = generateId();
    const docHash = hashContent("parent doc for dedup test");
    db.run(
      "INSERT INTO documents (id, title, content, content_hash, path) VALUES (?, ?, ?, ?, ?)",
      [docId, "Parent", "parent doc for dedup test", docHash, "/dedup/doc.md"],
    );

    const chunkHash = hashContent("chunk content dedup");
    const c1 = generateId();
    const c2 = generateId();

    db.run(
      "INSERT INTO chunks (id, document_id, chunk_index, content, content_hash) VALUES (?, ?, ?, ?, ?)",
      [c1, docId, 0, "chunk content dedup", chunkHash],
    );
    db.run(
      "INSERT INTO chunks (id, document_id, chunk_index, content, content_hash) VALUES (?, ?, ?, ?, ?)",
      [c2, docId, 1, "chunk content dedup", chunkHash],
    );

    const count = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM chunks WHERE content_hash = ?",
      )
      .get(chunkHash)!.c;
    expect(count).toBe(1);

    db.run("DELETE FROM documents WHERE id = ?", [docId]);
  });

  test("blocks duplicate memory insert (same hash)", () => {
    const m1 = generateId();
    const m2 = generateId();
    const hash = hashContent("memory dedup content");

    db.run(
      "INSERT INTO memories (id, project_hash, date, type, title, content, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [m1, "proj1", "2025-01-01", "note", "Mem 1", "memory dedup content", hash],
    );
    db.run(
      "INSERT INTO memories (id, project_hash, date, type, title, content, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [m2, "proj1", "2025-01-01", "note", "Mem 2", "memory dedup content", hash],
    );

    const count = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM memories WHERE content_hash = ?",
      )
      .get(hash)!.c;
    expect(count).toBe(1);

    db.run("DELETE FROM memories WHERE content_hash = ?", [hash]);
  });
});

// ---------------------------------------------------------------------------
// FTS5 content sync
// ---------------------------------------------------------------------------

describe("FTS5 content sync", () => {
  test("documents_fts is populated on INSERT", () => {
    const id = generateId();
    const hash = hashContent("fts5 sync content");
    db.run(
      "INSERT INTO documents (id, title, content, content_hash, path) VALUES (?, ?, ?, ?, ?)",
      [id, "FTS5 Test", "fts5 sync content", hash, "/fts5/test.md"],
    );

    const row = db
      .query<{ title: string }, []>(
        "SELECT title FROM documents_fts WHERE documents_fts MATCH 'fts5'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row!.title).toBe("FTS5 Test");

    db.run("DELETE FROM documents WHERE id = ?", [id]);
  });

  test("memories_fts is populated on INSERT", () => {
    const id = generateId();
    const hash = hashContent("memory fts5 test");
    db.run(
      "INSERT INTO memories (id, project_hash, date, type, tags, title, content, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, "p1", "2025-06-01", "decision", "test", "Memory FTS5", "memory fts5 test", hash],
    );

    const row = db
      .query<{ title: string }, []>(
        "SELECT title FROM memories_fts WHERE memories_fts MATCH 'memory'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Memory FTS5");

    db.run("DELETE FROM memories WHERE id = ?", [id]);
  });

  test("entries_fts is populated on INSERT", () => {
    const key = "fts5-test-key";
    const kind = "bug";
    db.run(
      "INSERT INTO knowledge_entries (entry_key, kind, title, description) VALUES (?, ?, ?, ?)",
      [key, kind, "FTS5 Entry", "searchable description for fts5"],
    );

    const row = db
      .query<{ title: string }, []>(
        "SELECT title FROM entries_fts WHERE entries_fts MATCH 'searchable'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row!.title).toBe("FTS5 Entry");

    db.run(
      "DELETE FROM knowledge_entries WHERE entry_key = ? AND kind = ?",
      [key, kind],
    );
  });
});

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

describe("generateId", () => {
  test("returns a string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
  });

  test("returns 32 hex characters", () => {
    const id = generateId();
    expect(id.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
  });

  test("is timestamp-prefixed (first 12 chars encode Date.now())", () => {
    const id = generateId();
    const prefix = id.slice(0, 12);
    const now = Date.now().toString(16).padStart(12, "0");
    // The prefix should be numerically close to current timestamp hex,
    // allowing 1-2ms drift in either direction
    const prefixNum = parseInt(prefix, 16);
    const nowNum = parseInt(now, 16);
    const diff = Math.abs(prefixNum - nowNum);
    expect(diff).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  test("returns consistent hex string", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world");
    expect(h1).toBe(h2);
    expect(/^[0-9a-f]{64}$/.test(h1)).toBe(true);
  });

  test("different inputs produce different hashes", () => {
    const h1 = hashContent("foo");
    const h2 = hashContent("bar");
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — calling createSchema twice must not error
// ---------------------------------------------------------------------------

describe("createSchema idempotency", () => {
  test("calling createSchema twice does not throw", () => {
    expect(() => createSchema(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// metadata table round-trip
// ---------------------------------------------------------------------------

describe("metadata table", () => {
  test("insert and retrieve a value", () => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
      "schema_version",
      "1",
    ]);
    const row = db
      .query<{ value: string }, []>(
        "SELECT value FROM metadata WHERE key = ?",
      )
      .get("schema_version");
    expect(row).not.toBeNull();
    expect(row!.value).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// E6.1: Schema version + migration
// ---------------------------------------------------------------------------

describe("schema version and migration (E6.1)", () => {
  test("SCHEMA_VERSION is 4", () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  test("runMigrations sets schema_version in metadata", () => {
    // Reset metadata to simulate upgrade from version 0
    db.run("DELETE FROM metadata WHERE key = 'schema_version'");
    runMigrations(db);

    const row = db
      .query<{ value: string }, []>(
        "SELECT value FROM metadata WHERE key = 'schema_version'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(parseInt(row!.value, 10)).toBe(SCHEMA_VERSION);
  });

  test("runMigrations is idempotent", () => {
    runMigrations(db);
    runMigrations(db);

    const row = db
      .query<{ value: string }, []>(
        "SELECT value FROM metadata WHERE key = 'schema_version'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(parseInt(row!.value, 10)).toBe(SCHEMA_VERSION);
  });

  test("initBrainDatabase calls runMigrations automatically", () => {
    const migrateDbPath = join(TEST_DIR, "init-migration-test.db");
    const result = initBrainDatabase(migrateDbPath);
    try {
      const row = result
        .query<{ value: string }, []>(
          "SELECT value FROM metadata WHERE key = 'schema_version'",
        )
        .get();
      expect(row).not.toBeNull();
      expect(parseInt(row!.value, 10)).toBe(SCHEMA_VERSION);
    } finally {
      result.close();
    }
  });
});

// ---------------------------------------------------------------------------
// v3 → v4 migration: dedup / FK lookup indexes (#239)
// ---------------------------------------------------------------------------

describe("v3→v4 dedup indexes (#239)", () => {
  const DEDUP_INDEXES = [
    "idx_chunks_content_hash",
    "idx_documents_path_content_hash",
    "idx_chunks_file_id",
  ] as const;

  function indexExists(handle: Database, name: string): boolean {
    const row = handle
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
      )
      .get(name);
    return row !== null;
  }

  function schemaVersion(handle: Database): number {
    const row = handle
      .query<{ value: string }, []>(
        "SELECT value FROM metadata WHERE key = 'schema_version'",
      )
      .get();
    return row ? parseInt(row.value, 10) : 0;
  }

  test("fresh database contains all dedup indexes after initBrainDatabase()", () => {
    const freshPath = join(TEST_DIR, "v4-fresh.db");
    const handle = initBrainDatabase(freshPath);
    try {
      for (const name of DEDUP_INDEXES) {
        expect(indexExists(handle, name)).toBe(true);
      }
      expect(schemaVersion(handle)).toBe(4);
    } finally {
      handle.close();
    }
  });

  test("upgrading a v3 database creates the indexes, re-run is a no-op", () => {
    const upgradePath = join(TEST_DIR, "v4-upgrade.db");
    const handle = initBrainDatabase(upgradePath);
    try {
      // Simulate an existing v3 database: drop the v4 indexes, mark version 3.
      for (const name of DEDUP_INDEXES) {
        handle.exec(`DROP INDEX IF EXISTS ${name}`);
        expect(indexExists(handle, name)).toBe(false);
      }
      handle.run("UPDATE metadata SET value = '3' WHERE key = 'schema_version'");

      runMigrations(handle);

      for (const name of DEDUP_INDEXES) {
        expect(indexExists(handle, name)).toBe(true);
      }
      expect(schemaVersion(handle)).toBe(4);

      // Re-running the migration must not throw or change the result.
      expect(() => runMigrations(handle)).not.toThrow();
      for (const name of DEDUP_INDEXES) {
        expect(indexExists(handle, name)).toBe(true);
      }
      expect(schemaVersion(handle)).toBe(4);
    } finally {
      handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E6.2: Integrity checks
// ---------------------------------------------------------------------------

describe("integrity checks (E6.2)", () => {
  test("runIntegrityChecks does not throw on clean database", () => {
    expect(() => runIntegrityChecks(db)).not.toThrow();
  });

  test("PRAGMA integrity_check returns ok", () => {
    const row = db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get()!;
    expect(row.integrity_check).toBe("ok");
  });

  test("PRAGMA foreign_key_check returns no violations", () => {
    const violations = db.query("PRAGMA foreign_key_check").all();
    expect(violations.length).toBe(0);
  });

  test("no orphan chunks in clean database", () => {
    const orphans = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)",
      )
      .get()!;
    expect(orphans.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E6.3: DB stats
// ---------------------------------------------------------------------------

describe("dbStats (E6.3)", () => {
  test("returns correct structure and types", () => {
    const stats = dbStats(db);
    expect(typeof stats.totalFiles).toBe("number");
    expect(typeof stats.totalDocuments).toBe("number");
    expect(typeof stats.totalChunks).toBe("number");
    expect(typeof stats.totalMemories).toBe("number");
    expect(typeof stats.totalKnowledgeEntries).toBe("number");
    expect(typeof stats.totalDiaryEntries).toBe("number");
    expect(typeof stats.dbSizeBytes).toBe("number");
  });

  test("all counts are non-negative", () => {
    const stats = dbStats(db);
    expect(stats.totalFiles).toBeGreaterThanOrEqual(0);
    expect(stats.totalDocuments).toBeGreaterThanOrEqual(0);
    expect(stats.totalChunks).toBeGreaterThanOrEqual(0);
    expect(stats.totalMemories).toBeGreaterThanOrEqual(0);
    expect(stats.totalKnowledgeEntries).toBeGreaterThanOrEqual(0);
    expect(stats.totalDiaryEntries).toBeGreaterThanOrEqual(0);
    expect(stats.dbSizeBytes).toBeGreaterThanOrEqual(0);
  });

  test("returns matching counts for known data", () => {
    // Count files directly
    const fileCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM files")
      .get()!;
    expect(dbStats(db).totalFiles).toBe(fileCount.c);
  });
});
