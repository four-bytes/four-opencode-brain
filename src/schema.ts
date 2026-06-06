import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { log } from "./logger";
import { loadVec0 } from "./embed/extensionLoader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current schema version for migration tracking. */
export const SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Integrity checks — PRAGMA + orphan chunk auditing
// ---------------------------------------------------------------------------

/**
 * Run database integrity checks on startup.
 * - PRAGMA integrity_check (quick sanity)
 * - PRAGMA foreign_key_check (FK violation detection)
 * - Orphan chunk audit (chunks without matching documents)
 * All checks log warnings on failure but never throw.
 */
export function runIntegrityChecks(db: Database): void {
  try {
    const row = db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    if (row && row.integrity_check !== "ok") {
      log("warn", "integrity", `DB integrity check failed: ${row.integrity_check}`);
    }
  } catch (err) {
    log("error", "integrity", `Integrity check error: ${String(err)}`);
  }

  try {
    const violations = db
      .query("PRAGMA foreign_key_check")
      .all() as Array<Record<string, unknown>>;
    if (violations.length > 0) {
      log("warn", "integrity", `Foreign key violations: ${violations.length}`);
      for (const v of violations) {
        log("debug", "integrity", `FK violation: ${JSON.stringify(v)}`);
      }
    }
  } catch (err) {
    log("error", "integrity", `Foreign key check error: ${String(err)}`);
  }

  try {
    const orphans = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)",
      )
      .get()!;
    if (orphans.c > 0) {
      log("warn", "integrity", `Found ${orphans.c} orphan chunks (no matching document)`);
    }
  } catch (err) {
    log("error", "integrity", `Orphan chunk check error: ${String(err)}`);
  }
}

export interface DbStats {
  totalFiles: number;
  totalDocuments: number;
  totalChunks: number;
  totalMemories: number;
  totalKnowledgeEntries: number;
  totalDiaryEntries: number;
  dbSizeBytes: number;
}

/**
 * Return database statistics: row counts for all major tables and DB file size.
 * Useful for health monitoring and status reporting.
 */
export function dbStats(db: Database, dbPath?: string): DbStats {
  const fileCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM files")
    .get()!;
  const docCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM documents")
    .get()!;
  const chunkCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM chunks")
    .get()!;
  const memCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memories")
    .get()!;
  const kbCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM knowledge_entries")
    .get()!;
  const diaryCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM diary_entries")
    .get()!;

  let dbSizeBytes = 0;
  try {
    const pageCount = db
      .query<{ page_count: number }, []>("PRAGMA page_count")
      .get()!;
    const pageRow = db
      .query<{ page_size: number }, []>("PRAGMA page_size")
      .get()!;
    dbSizeBytes = Number(pageCount.page_count) * Number(pageRow.page_size);
    if (isNaN(dbSizeBytes)) dbSizeBytes = 0;
  } catch {
    // In-memory databases have no file size
  }

  return {
    totalFiles: fileCount.c,
    totalDocuments: docCount.c,
    totalChunks: chunkCount.c,
    totalMemories: memCount.c,
    totalKnowledgeEntries: kbCount.c,
    totalDiaryEntries: diaryCount.c,
    dbSizeBytes,
  };
}

// ---------------------------------------------------------------------------
// UUID7-style ID: 12 hex chars of timestamp + 20 hex chars random
// ---------------------------------------------------------------------------
export function generateId(): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return timestamp + random;
}

// ---------------------------------------------------------------------------
// SHA-256 content hashing via Bun native crypto
// ---------------------------------------------------------------------------
export function hashContent(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex") as string;
}

/** Binary-safe SHA-256 hashing of raw file bytes (Uint8Array). */
export function hashBuffer(buf: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex") as string;
}

// ---------------------------------------------------------------------------
// Open (or create) brain.db at the given path, enable WAL + FK pragmas
// ---------------------------------------------------------------------------
export function openDatabase(dbPath?: string): Database {
  const resolvedPath =
    dbPath ?? join(homedir(), ".local", "share", "four-opencode-brain", "brain.db");

  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA foreign_keys=ON;");
  return db;
}

// ---------------------------------------------------------------------------
// Migration: v2 → v3 — add project_hash to documents, create symbols table
// ---------------------------------------------------------------------------

/**
 * Migrate from v2 to v3:
 * 1. ALTER TABLE documents ADD COLUMN project_hash TEXT NOT NULL DEFAULT 'global'
 * 2. Create symbols and symbols_fts tables (safe: IF NOT EXISTS)
 */
function migrateV2toV3(db: Database): void {
  try {
    // Check if column already exists
    const colInfo = db
      .query<{ name: string }, []>("PRAGMA table_info(documents)")
      .all();
    const hasProjectHash = colInfo.some((c) => c.name === "project_hash");
    if (!hasProjectHash) {
      db.exec("ALTER TABLE documents ADD COLUMN project_hash TEXT NOT NULL DEFAULT 'global'");
    }

    // Create symbols table (IF NOT EXISTS — safe even if already present)
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        qualified_name  TEXT,
        kind            TEXT,
        project_hash    TEXT NOT NULL DEFAULT 'global',
        file_path       TEXT,
        document_id     TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Create symbols_fts (IF NOT EXISTS)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name,
        qualified_name,
        content='symbols',
        content_rowid='rowid'
      )
    `);

    // Create FTS sync triggers (IF NOT EXISTS)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name, qualified_name)
        VALUES (new.rowid, new.name, new.qualified_name);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name)
        VALUES ('delete', old.rowid, old.name, old.qualified_name);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name)
        VALUES ('delete', old.rowid, old.name, old.qualified_name);
        INSERT INTO symbols_fts(rowid, name, qualified_name)
        VALUES (new.rowid, new.name, new.qualified_name);
      END
    `);

    log("info", "schema", "Applied v2→v3 migration: project_hash on documents, symbols table");
  } catch (err) {
    log("error", "schema", `v2→v3 migration failed: ${String(err)}`);
  }
}

/**
 * Open the brain database, load the vec0 extension, create the schema,
 * run pending migrations, and perform integrity checks.
 * This is the single entry point — ensures vec0 is loaded before schema creation.
 */
export function initBrainDatabase(dbPath?: string): Database {
  const db = openDatabase(dbPath);
  loadVec0(db);
  createSchema(db);
  runMigrations(db);
  runIntegrityChecks(db);
  return db;
}

// ---------------------------------------------------------------------------
// Idempotent DDL — creates all tables, FTS5 indices, triggers
// ---------------------------------------------------------------------------
export function createSchema(db: Database): void {
  // ---- base tables --------------------------------------------------------

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'file',
      path          TEXT,
      language      TEXT,
      filetype      TEXT,
      project_hash  TEXT NOT NULL DEFAULT 'global',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(path, content_hash)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id            TEXT PRIMARY KEY,
      document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      file_id       TEXT,
      chunk_index   INTEGER NOT NULL,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      symbol        TEXT,
      kind          TEXT,
      start_line    INTEGER,
      end_line      INTEGER,
      chunk_type    TEXT DEFAULT 'text',
      token_count   INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id            TEXT PRIMARY KEY,
      path          TEXT NOT NULL UNIQUE,
      content_hash  TEXT NOT NULL,
      mtime         INTEGER,
      lang          TEXT,
      size          INTEGER,
      indexed_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      project_hash  TEXT NOT NULL,
      date          TEXT NOT NULL,
      type          TEXT NOT NULL,
      tags          TEXT,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS diary_entries (
      id            TEXT PRIMARY KEY,
      date          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      qualified_name  TEXT,
      kind            TEXT,
      project_hash    TEXT NOT NULL DEFAULT 'global',
      file_path       TEXT,
      document_id     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      entry_key         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      title             TEXT NOT NULL,
      description       TEXT,
      entity_type       TEXT NOT NULL DEFAULT 'problem' CHECK(entity_type IN ('problem','pattern','convention','decision','observation','fix','summary')),
      root_cause        TEXT,
      canonical_solution TEXT,
      tags              TEXT,
      confidence        REAL NOT NULL DEFAULT 0.0,
      review_state      TEXT NOT NULL DEFAULT 'draft',
      superseded_by     TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT,
      PRIMARY KEY (entry_key, kind)
    )
  `);

  // ---- Migration: add entity_type CHECK for existing databases -----------
  migrateEntityTypeCheck(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_occurrences (
      id                TEXT PRIMARY KEY,
      entry_key         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      project_ref       TEXT,
      repo_ref          TEXT,
      issue_ref         TEXT,
      commit_ref        TEXT,
      observed_symptoms TEXT,
      outcome           TEXT NOT NULL,
      occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (entry_key, kind) REFERENCES knowledge_entries(entry_key, kind) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_revisions (
      id                  TEXT PRIMARY KEY,
      entry_key           TEXT NOT NULL,
      kind                TEXT NOT NULL,
      field_name          TEXT NOT NULL,
      old_value           TEXT,
      new_value           TEXT,
      confidence_at_time  REAL,
      review_state_at_time TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (entry_key, kind) REFERENCES knowledge_entries(entry_key, kind) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // ---- FTS5 virtual tables -----------------------------------------------

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title,
      content,
      content='documents',
      content_rowid='rowid'
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title,
      content,
      tags,
      content='memories',
      content_rowid='rowid'
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      title,
      description,
      root_cause,
      canonical_solution,
      tags,
      content='knowledge_entries',
      content_rowid='rowid'
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name,
      qualified_name,
      content='symbols',
      content_rowid='rowid'
    )
  `);

  // ---- vec0 virtual table (skip gracefully if extension not loaded) -------

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_id   TEXT,
        embedding  FLOAT[384]
      )
    `);
  } catch {
    log("debug", "schema", "vec0 extension not available — skipping chunks_vec table");
  }

  // ---- FTS5 content-sync triggers -----------------------------------------

  // documents → documents_fts
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content)
      VALUES (new.rowid, new.title, new.content);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content)
      VALUES ('delete', old.rowid, old.title, old.content);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content)
      VALUES ('delete', old.rowid, old.title, old.content);
      INSERT INTO documents_fts(rowid, title, content)
      VALUES (new.rowid, new.title, new.content);
    END
  `);

  // memories → memories_fts
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END
  `);

  // knowledge_entries → entries_fts
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON knowledge_entries BEGIN
      INSERT INTO entries_fts(rowid, title, description, root_cause, canonical_solution, tags)
      VALUES (new.rowid, new.title, new.description, new.root_cause, new.canonical_solution, new.tags);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON knowledge_entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, description, root_cause, canonical_solution, tags)
      VALUES ('delete', old.rowid, old.title, old.description, old.root_cause, old.canonical_solution, old.tags);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON knowledge_entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, description, root_cause, canonical_solution, tags)
      VALUES ('delete', old.rowid, old.title, old.description, old.root_cause, old.canonical_solution, old.tags);
      INSERT INTO entries_fts(rowid, title, description, root_cause, canonical_solution, tags)
      VALUES (new.rowid, new.title, new.description, new.root_cause, new.canonical_solution, new.tags);
    END
  `);

  // symbols → symbols_fts
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, qualified_name)
      VALUES (new.rowid, new.name, new.qualified_name);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name)
      VALUES ('delete', old.rowid, old.name, old.qualified_name);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name)
      VALUES ('delete', old.rowid, old.name, old.qualified_name);
      INSERT INTO symbols_fts(rowid, name, qualified_name)
      VALUES (new.rowid, new.name, new.qualified_name);
    END
  `);

  // ---- content-hash dedup triggers (BEFORE INSERT, silent skip) -----------

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_dedup_bi BEFORE INSERT ON documents
    BEGIN
      SELECT RAISE(IGNORE) WHERE EXISTS (
        SELECT 1 FROM documents
        WHERE path IS NEW.path AND content_hash IS NEW.content_hash
      );
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_dedup_bi BEFORE INSERT ON chunks
    BEGIN
      SELECT RAISE(IGNORE) WHERE EXISTS (
        SELECT 1 FROM chunks WHERE content_hash IS NEW.content_hash
      );
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_dedup_bi BEFORE INSERT ON memories
    BEGIN
      SELECT RAISE(IGNORE) WHERE EXISTS (
        SELECT 1 FROM memories WHERE content_hash IS NEW.content_hash
      );
    END
  `);
}

// ---------------------------------------------------------------------------
// Migration runner — version-aware schema migrations
// ---------------------------------------------------------------------------

/**
 * Run all pending schema migrations based on the stored schema_version.
 * Fresh databases (version 0, no entry) skip all migrations since
 * createSchema() already creates the latest schema.
 *
 * Migration history:
 *   v1 → v2: entity_type CHECK constraint via triggers
 */
export function runMigrations(db: Database): void {
  let currentVersion = 0;
  try {
    const row = db
      .query<{ value: string }, []>("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get();
    if (row) {
      currentVersion = parseInt(row.value, 10) || 0;
    }
  } catch {
    // metadata table may not exist yet on truly first run — skip
  }

  if (currentVersion >= SCHEMA_VERSION) {
    // Already current — ensure metadata entry exists
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)", [
      String(SCHEMA_VERSION),
    ]);
    return;
  }

  log("info", "schema", `Schema migration: ${currentVersion} → ${SCHEMA_VERSION}`);

  // v1 → v2: entity_type CHECK
  if (currentVersion < 2) {
    migrateEntityTypeCheck(db);
  }

  // v2 → v3: add project_hash to documents, create symbols table
  if (currentVersion < 3) {
    migrateV2toV3(db);
  }

  db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)", [
    String(SCHEMA_VERSION),
  ]);
  log("info", "schema", `Schema at version ${SCHEMA_VERSION}`);
}

// ---------------------------------------------------------------------------
// Migration: add entity_type CHECK constraint for existing databases
// ---------------------------------------------------------------------------

/**
 * For existing databases where the `knowledge_entries` table was created
 * without the entity_type CHECK constraint, this migration:
 *
 * 1. Updates any NULL entity_type values to 'problem'
 * 2. Adds BEFORE INSERT and BEFORE UPDATE triggers to enforce the
 *    valid entity_type values (since SQLite does not support
 *    ALTER TABLE ... ADD CHECK)
 */
function migrateEntityTypeCheck(db: Database): void {
  // Check if already applied
  const row = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_entries'",
    )
    .get();

  if (row && row.sql && row.sql.includes("CHECK(entity_type IN")) {
    return;
  }

  // Retry up to 3 times with 1s delay for locked databases
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      db.run(
        "UPDATE knowledge_entries SET entity_type = 'problem' WHERE entity_type IS NULL",
      );

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS knowledge_entries_check_entity_type_bi
        BEFORE INSERT ON knowledge_entries
        BEGIN
          SELECT CASE
            WHEN NEW.entity_type NOT IN ('problem','pattern','convention','decision','observation','fix','summary')
            THEN RAISE(ABORT, 'Invalid entity_type: ' || NEW.entity_type)
          END;
        END
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS knowledge_entries_check_entity_type_bu
        BEFORE UPDATE ON knowledge_entries
        BEGIN
          SELECT CASE
            WHEN NEW.entity_type NOT IN ('problem','pattern','convention','decision','observation','fix','summary')
            THEN RAISE(ABORT, 'Invalid entity_type: ' || NEW.entity_type)
          END;
        END
      `);

      log("info", "schema", "Applied entity_type CHECK migration via triggers");
      return;
    } catch (err) {
      if (attempt < 2) {
        log("warn", "schema", `migration attempt ${attempt + 1} failed (locked), retrying...`);
        // Busy-wait for 1s before retry
        const start = Date.now();
        while (Date.now() - start < 1000) { /* spin */ }
      } else {
        log("error", "schema", `entity_type CHECK migration failed after 3 attempts: ${String(err)}`);
      }
    }
  }
}
