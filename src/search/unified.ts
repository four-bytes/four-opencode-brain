// ---------------------------------------------------------------------------
// Unified brain search — FTS5 across documents, memories, and knowledge
// with optional vec0 vector search and RRF fusion.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { sessionCache } from "../cache";
import { loadVec0 } from "../embed/extensionLoader";
import { generateEmbedding, float32ToBlob } from "../ingest/embed";
import { EmbeddingService } from "../embed/embeddingService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Inline filter string (e.g. "language:ts path:src/") or structured object */
  filters?: string | Record<string, string>;
  /** Max results (default 20) */
  limit?: number;
  /** Content-type filter */
  contentType?: "document" | "memory" | "knowledge" | "chunk" | "all";
}

export interface SearchResult {
  id: string;
  title: string;
  /** FTS5 snippet with <mark> tags stripped */
  excerpt: string;
  /** RRF score (0-1) or 0 when vec0 not available */
  score: number;
  content_type: "document" | "memory" | "knowledge" | "chunk";
  source_path?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parsed inline filters
// ---------------------------------------------------------------------------

interface ParsedFilters {
  language?: string;
  path?: string;
  symbol?: string;
  kind?: string;
  entity_type?: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// Parse inline filter syntax: "language:ts path:src/ kind:function"
// ---------------------------------------------------------------------------

function parseFilters(raw?: string | Record<string, string>): ParsedFilters {
  const filters: ParsedFilters = {};
  if (!raw) return filters;

  if (typeof raw === "string") {
    for (const token of raw.split(/\s+/).filter(Boolean)) {
      const idx = token.indexOf(":");
      if (idx > 0) {
        const key = token.slice(0, idx);
        const val = token.slice(idx + 1);
        if (key && val) {
          (filters as Record<string, string>)[key] = val;
        }
      }
    }
  } else {
    Object.assign(filters, raw);
  }

  return filters;
}

// ---------------------------------------------------------------------------
// Strip <mark> tags from excerpt
// ---------------------------------------------------------------------------

function stripMarkTags(text: string): string {
  return text.replace(/<\/?mark>/g, "");
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

function makeCacheKey(query: string, options?: SearchOptions): string {
  const filters =
    typeof options?.filters === "string"
      ? options.filters
      : JSON.stringify(options?.filters ?? {});
  return `search:${query}:${filters}:${options?.limit ?? 20}:${options?.contentType ?? "all"}`;
}

// ---------------------------------------------------------------------------
// FTS5 search: documents
// ---------------------------------------------------------------------------

function ftsSearchDocuments(
  db: Database,
  query: string,
  filters: ParsedFilters,
  maxResults: number,
): SearchResult[] {
  let sql = `
    SELECT d.id, d.title,
           snippet(documents_fts, 1, '<mark>', '</mark>', '...', 40) AS excerpt,
           'document' AS content_type,
           d.path AS source_path
    FROM documents_fts f
    JOIN documents d ON d.rowid = f.rowid
    WHERE documents_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (filters.language) {
    sql += " AND d.language = ?";
    params.push(filters.language);
  }
  if (filters.path) {
    sql += " AND d.path LIKE ?";
    params.push(`${filters.path}%`);
  }
  if (filters.type) {
    sql += " AND d.type = ?";
    params.push(filters.type);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(maxResults);

  try {
    const rows = db.query(sql).all(...params) as Array<{
      id: string;
      title: string;
      excerpt: string;
      content_type: "document";
      source_path: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: stripMarkTags(r.excerpt),
      score: 0,
      content_type: "document" as const,
      source_path: r.source_path ?? undefined,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// FTS5 search: memories
// ---------------------------------------------------------------------------

function ftsSearchMemories(
  db: Database,
  query: string,
  filters: ParsedFilters,
  maxResults: number,
): SearchResult[] {
  let sql = `
    SELECT m.id, m.title,
           snippet(memories_fts, 1, '<mark>', '</mark>', '...', 40) AS excerpt,
           'memory' AS content_type
    FROM memories_fts f
    JOIN memories m ON m.rowid = f.rowid
    WHERE memories_fts MATCH ?
  `;
  const params: unknown[] = [query];

  sql += " ORDER BY rank LIMIT ?";
  params.push(maxResults);

  try {
    const rows = db.query(sql).all(...params) as Array<{
      id: string;
      title: string;
      excerpt: string;
      content_type: "memory";
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: stripMarkTags(r.excerpt),
      score: 0,
      content_type: "memory" as const,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// FTS5 search: knowledge entries
// ---------------------------------------------------------------------------

function ftsSearchKnowledge(
  db: Database,
  query: string,
  filters: ParsedFilters,
  maxResults: number,
): SearchResult[] {
  let sql = `
    SELECT k.entry_key || ':' || k.kind AS id,
           k.title,
           snippet(entries_fts, 1, '<mark>', '</mark>', '...', 40) AS excerpt,
           'knowledge' AS content_type,
           k.entity_type
    FROM entries_fts f
    JOIN knowledge_entries k ON k.rowid = f.rowid
    WHERE entries_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (filters.entity_type) {
    sql += " AND k.entity_type = ?";
    params.push(filters.entity_type);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(maxResults);

  try {
    const rows = db.query(sql).all(...params) as Array<{
      id: string;
      title: string;
      excerpt: string;
      content_type: "knowledge";
      entity_type: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: stripMarkTags(r.excerpt),
      score: 0,
      content_type: "knowledge" as const,
      metadata: { entity_type: r.entity_type ?? undefined },
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Vec0 vector search — KNN via sqlite-vec extension
// ---------------------------------------------------------------------------

function hasVec0Table(db: Database): boolean {
  try {
    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'",
      )
      .get();
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * Vec0 KNN search using either real embeddings (via EmbeddingService)
 * or hash-based pseudo-embeddings as fallback.
 */
async function searchVec0(
  db: Database,
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  // Ensure vec0 extension is loaded
  if (!loadVec0(db)) return [];

  try {
    const embService = EmbeddingService.getInstance();
    let queryVec: Float32Array;

    if (embService.isAvailable()) {
      queryVec = await embService.embed(query);
    } else {
      queryVec = generateEmbedding(query);
    }

    const queryBlob = float32ToBlob(queryVec);

    const rows = db
      .query<{ chunk_id: string; distance: number }, [Uint8Array, number]>(
        `SELECT chunk_id, distance
         FROM chunks_vec
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(queryBlob, maxResults);

    return rows.map((row) => ({
      id: row.chunk_id,
      title: `vec0:${row.chunk_id.slice(0, 8)}`,
      excerpt: `[vec0 chunk] distance=${row.distance.toFixed(4)}`,
      score: Math.max(0, 1 - row.distance),
      content_type: "chunk" as const,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Chunk SQL fallback — direct LIKE search on chunks table
// Used when vec0 vector search is unavailable (no extension loaded).
// ---------------------------------------------------------------------------

function searchChunksFallback(
  db: Database,
  query: string,
  maxResults: number,
  filters: ParsedFilters,
): SearchResult[] {
  try {
    let sql = `
      SELECT c.id, c.chunk_index, c.content, c.symbol, c.kind,
             c.chunk_type, c.start_line, c.end_line,
             d.path AS source_path, d.title AS doc_title
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.content LIKE ?
    `;
    const params: unknown[] = [`%${query}%`];

    if (filters.language) {
      sql += " AND d.language = ?";
      params.push(filters.language);
    }
    if (filters.path) {
      sql += " AND d.path LIKE ?";
      params.push(`${filters.path}%`);
    }
    if (filters.kind) {
      sql += " AND c.kind = ?";
      params.push(filters.kind);
    }

    sql += " ORDER BY c.chunk_index LIMIT ?";
    params.push(maxResults);

    const rows = db.query(sql).all(...params) as Array<{
      id: string;
      chunk_index: number;
      content: string;
      symbol: string | null;
      kind: string | null;
      chunk_type: string;
      start_line: number | null;
      end_line: number | null;
      source_path: string;
      doc_title: string;
    }>;

    return rows.map((r) => {
      const excerpt = r.content.length > 80
        ? r.content.slice(0, 80) + "..."
        : r.content;
      return {
        id: r.id,
        title: r.symbol ?? `${r.doc_title}:${r.chunk_type}#${r.chunk_index}`,
        excerpt,
        score: 0,
        content_type: "chunk" as const,
        source_path: r.source_path ?? undefined,
        metadata: {
          kind: r.kind ?? undefined,
          chunk_type: r.chunk_type,
          start_line: r.start_line ?? undefined,
          end_line: r.end_line ?? undefined,
        },
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// RRF Fusion (Reciprocal Rank Fusion)
// ---------------------------------------------------------------------------

function rrfFusion(lists: SearchResult[][], k: number = 60): SearchResult[] {
  const map = new Map<string, SearchResult & { rrfScore: number }>();

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const key = `${item.content_type}:${item.id}`;
      const contribution = 1 / (k + i + 1); // rank = i + 1

      const existing = map.get(key);
      if (existing) {
        existing.rrfScore += contribution;
      } else {
        map.set(key, { ...item, rrfScore: contribution });
      }
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ rrfScore, ...rest }) => ({ ...rest, score: rrfScore }));
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Unified FTS5 + vec0 search across documents, memories, and knowledge entries.
 *
 * - Runs FTS5 MATCH queries on all three content types
 * - Applies inline filters (language:, path:, entity_type:, etc.)
 * - Runs vec0 vector search (real embeddings via EmbeddingService when available,
 *   hash-based pseudo-embeddings as fallback) if chunks_vec table exists
 * - Combines results via RRF fusion when vec0 results are available
 * - Strips `<mark>` tags from excerpts
 * - Results are cached per session via LRU cache
 *
 * @param db    Open brain database handle
 * @param query FTS5 search query
 * @param options SearchOptions
 * @returns     Array of SearchResult (never null, empty array if no results)
 */
export async function brainSearch(
  db: Database,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  // Empty query guard
  if (!query || query.trim().length === 0) {
    return [];
  }

  // Cache check
  const key = makeCacheKey(query, options);
  const cached = sessionCache.search.get(key);
  if (cached) return cached as SearchResult[];

  const filters = parseFilters(options?.filters);
  const limit = Math.max(1, options?.limit ?? 20);
  const ct = options?.contentType ?? "all";
  const ftsLists: SearchResult[][] = [];

  // Run FTS5 searches based on content type filter
  if (ct === "all" || ct === "document") {
    ftsLists.push(ftsSearchDocuments(db, query, filters, limit));
  }
  if (ct === "all" || ct === "memory") {
    ftsLists.push(ftsSearchMemories(db, query, filters, limit));
  }
  if (ct === "all" || ct === "knowledge") {
    ftsLists.push(ftsSearchKnowledge(db, query, filters, limit));
  }

  // Vec0 chunk search (async — uses real embeddings when available)
  let chunkResults: SearchResult[] = [];
  if (ct === "all" || ct === "chunk") {
    if (hasVec0Table(db) && loadVec0(db)) {
      chunkResults = await searchVec0(db, query, limit);
    } else {
      chunkResults = searchChunksFallback(db, query, limit, filters);
    }
  }

  let results: SearchResult[];
  if (chunkResults.length > 0) {
    // RRF fusion with chunk results
    ftsLists.push(chunkResults);
    results = rrfFusion(ftsLists, 60);
  } else {
    // Without chunk results, concatenate FTS5 lists in source order
    results = ftsLists.flat().slice(0, limit);
  }

  // Cap at limit
  results = results.slice(0, limit);

  // Store in cache
  sessionCache.search.set(key, results);

  return results;
}
