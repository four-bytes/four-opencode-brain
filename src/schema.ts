import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { log } from "./logger";

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

// ---------------------------------------------------------------------------
// Open (or create) brain.db at the given path, enable WAL + FK pragmas
// ---------------------------------------------------------------------------
export function openDatabase(dbPath?: string): Database {
  const resolvedPath =
    dbPath ?? join(homedir(), ".local", "share", "four-opencode-brain", "brain.db");

  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
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
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      entry_key         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      title             TEXT NOT NULL,
      description       TEXT,
      entity_type       TEXT,
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
