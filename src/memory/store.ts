// ---------------------------------------------------------------------------
// Brain memory store — SQLite-backed CRUD for memories + diary
// Uses existing memories / diary_entries tables and FTS5 sync triggers
// defined in schema.ts.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { generateId, hashContent } from "../schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryInput {
  type: "decision" | "pattern" | "fact" | "preference" | "error";
  title: string;
  content: string;
  tags?: string;
  project?: string;
}

export interface MemoryEntry {
  id: string;
  project_hash: string;
  date: string;
  type: string;
  tags: string | null;
  title: string;
  content: string;
  created_at: string;
  snippet?: string;
}

export interface SearchOpts {
  query?: string;
  type?: string;
  tags?: string;
  project?: string;
  limit?: number;
}

export interface ListOpts {
  type?: string;
  project?: string;
  limit?: number;
  offset?: number;
}

export interface DiaryInput {
  date?: string;
  title: string;
  content: string;
}

export interface DiaryEntry {
  id: string;
  date: string;
  timestamp: string;
  title: string;
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function buildSnippet(content: string, max = 150): string {
  if (content.length <= max) return content;
  const sliced = content.slice(0, max - 1);
  const wordCut = sliced.replace(/\s+\S*$/, "");
  const base = wordCut.length > 0 ? wordCut : sliced;
  return base + "…";
}

// ---------------------------------------------------------------------------
// memoryAdd — INSERT into memories (FTS5 synced via trigger)
// ---------------------------------------------------------------------------

export function memoryAdd(db: Database, entry: MemoryInput): MemoryEntry {
  const id = generateId();
  const date = today();
  const projectHash = hashContent(entry.project ?? "global");
  const contentHash = hashContent(entry.content);

  db.run(
    `INSERT INTO memories (id, project_hash, date, type, tags, title, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectHash,
      date,
      entry.type,
      entry.tags ?? null,
      entry.title,
      entry.content,
      contentHash,
    ],
  );

  return {
    id,
    project_hash: projectHash,
    date,
    type: entry.type,
    tags: entry.tags ?? null,
    title: entry.title,
    content: entry.content,
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// memorySearch — FTS5 MATCH with optional type/tags/project filters
// ---------------------------------------------------------------------------

export function memorySearch(db: Database, opts: SearchOpts): MemoryEntry[] {
  if (!opts.query) return [];

  let sql = `
    SELECT m.id, m.project_hash, m.date, m.type, m.tags, m.title, m.content, m.created_at
    FROM memories_fts f
    JOIN memories m ON m.rowid = f.rowid
    WHERE memories_fts MATCH ?
  `;
  const params: unknown[] = [opts.query];

  if (opts.type) {
    sql += " AND m.type = ?";
    params.push(opts.type);
  }
  if (opts.tags) {
    sql += " AND m.tags LIKE ?";
    params.push(`%${opts.tags}%`);
  }
  if (opts.project) {
    sql += " AND m.project_hash = ?";
    params.push(hashContent(opts.project));
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(opts.limit ?? 20);

  try {
    const rows = db.query(sql).all(...params) as Array<{
      id: string;
      project_hash: string;
      date: string;
      type: string;
      tags: string | null;
      title: string;
      content: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      ...r,
      snippet: buildSnippet(r.content),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// memoryList — recent memories with optional type/project filter
// ---------------------------------------------------------------------------

export function memoryList(db: Database, opts: ListOpts): MemoryEntry[] {
  let sql =
    "SELECT id, project_hash, date, type, tags, title, content, created_at FROM memories WHERE 1=1";
  const params: unknown[] = [];

  if (opts.type) {
    sql += " AND type = ?";
    params.push(opts.type);
  }
  if (opts.project) {
    sql += " AND project_hash = ?";
    params.push(hashContent(opts.project));
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(opts.limit ?? 20, opts.offset ?? 0);

  const rows = db.query(sql).all(...params) as MemoryEntry[];
  return rows;
}

// ---------------------------------------------------------------------------
// memoryForget — DELETE by id
// ---------------------------------------------------------------------------

export function memoryForget(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM memories WHERE id = ?", [id]);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// memoryGet — SELECT by id
// ---------------------------------------------------------------------------

export function memoryGet(db: Database, id: string): MemoryEntry | null {
  const row = db
    .query<MemoryEntry, string>(
      "SELECT id, project_hash, date, type, tags, title, content, created_at FROM memories WHERE id = ?",
    )
    .get(id);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// diaryGet — SELECT diary_entries by date
// ---------------------------------------------------------------------------

export function diaryGet(db: Database, date: string): DiaryEntry[] {
  const rows = db
    .query<DiaryEntry, string>(
      "SELECT id, date, timestamp, title, content, created_at FROM diary_entries WHERE date = ? ORDER BY timestamp",
    )
    .all(date);
  return rows;
}

// ---------------------------------------------------------------------------
// diaryAdd — INSERT into diary_entries
// ---------------------------------------------------------------------------

export function diaryAdd(db: Database, entry: DiaryInput): void {
  const id = generateId();
  const date = entry.date ?? today();
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO diary_entries (id, date, timestamp, title, content) VALUES (?, ?, ?, ?, ?)",
    [id, date, now, entry.title, entry.content],
  );
}
