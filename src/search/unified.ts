// ---------------------------------------------------------------------------
// Unified brain search — FTS5 across documents, memories, and knowledge
// with optional vec0 vector search and RRF fusion.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { sessionCache } from "../cache";
import { hashContent } from "../schema";
import { loadVec0 } from "../embed/extensionLoader";
import { generateEmbedding, float32ToBlob } from "../ingest/embed";
import { EmbeddingService } from "../embed/embeddingService";
import { sanitizeFtsQuery } from "./ftsSanitizer";
import {
  parseQuery,
  validateFilters,
  type ParsedFilters,
} from "./queryParser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Inline filter string (e.g. "language:ts path:src/") or structured object */
  filters?: string | Record<string, string>;
  /** Max results (default 20) */
  limit?: number;
  /** Content-type filter */
  contentType?: "document" | "memory" | "knowledge" | "chunk" | "symbol" | "all";
  /** Project name or hash to scope search */
  project?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  /** FTS5 snippet with <mark> tags stripped */
  excerpt: string;
  /** RRF score (0-1) or 0 when vec0 not available */
  score: number;
  content_type: "document" | "memory" | "knowledge" | "chunk" | "symbol";
  source_path?: string;
  project_hash?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RRF weight configuration
// ---------------------------------------------------------------------------

/**
 * Determine RRF weights per engine type.
 *
 * - When vec0 uses **real embeddings** (EmbeddingService available):
 *   vec0 gets 1.0x, FTS5 gets 0.8x (semantic search more reliable)
 * - When vec0 uses hash-based **pseudo-embeddings** (fallback):
 *   FTS5 gets 1.0x, vec0 gets 0.8x (keyword search more reliable)
 */
function getRrfWeights(): { ftsWeight: number; vecWeight: number } {
  const embService = EmbeddingService.getInstance();
  const hasRealEmbeddings = embService.isAvailable();
  return hasRealEmbeddings
    ? { ftsWeight: 0.8, vecWeight: 1.0 }
    : { ftsWeight: 1.0, vecWeight: 0.8 };
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
// Parse options.filters (old-style) into ParsedFilters
// ---------------------------------------------------------------------------

function parseOptionsFilters(raw?: string | Record<string, string>): ParsedFilters {
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
           d.path AS source_path,
           d.project_hash
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
  if (filters.project) {
    sql += " AND d.project_hash = ?";
    params.push(hashContent(filters.project));
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
      project_hash: (r as any).project_hash ?? undefined,
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
           'memory' AS content_type,
           1.0 / (julianday('now') - julianday(m.date) + 1.0) *
           CASE WHEN m.type = 'decision' THEN 2.0 ELSE 1.0 END AS sort_score
    FROM memories_fts f
    JOIN memories m ON m.rowid = f.rowid
    WHERE memories_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (filters.project) {
    sql += " AND m.project_hash = ?";
    params.push(hashContent(filters.project));
  }

  sql += " ORDER BY sort_score DESC, rank LIMIT ?";
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
  if (filters.project) {
    // Knowledge entries don't have project_hash, skip filter
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
    if (filters.symbol) {
      sql += " AND c.symbol LIKE ?";
      params.push(`%${filters.symbol}%`);
    }
    if (filters.project) {
      sql += " AND d.project_hash = ?";
      params.push(hashContent(filters.project));
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
// Weighted RRF Fusion (Reciprocal Rank Fusion)
// ---------------------------------------------------------------------------

interface WeightedList {
  items: SearchResult[];
  weight: number;
}

/**
 * Weighted Reciprocal Rank Fusion.
 *
 * Each list contributes `weight / (k + rank)` per item, where rank is 1-based.
 * Items are deduplicated across lists using a `<content_type>:<id>` composite key.
 *
 * @param lists  Weighted lists of search results
 * @param k      Smoothing constant (default 60, min 1)
 * @returns      Fused list sorted descending by weighted RRF score
 */
function rrfFusion(lists: WeightedList[], k: number = 60): SearchResult[] {
  const safeK = Math.max(k, 1);
  const map = new Map<string, SearchResult & { rrfScore: number }>();

  for (const { items, weight } of lists) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = `${item.content_type}:${item.id}`;
      const contribution = weight / (safeK + i + 1); // rank = i + 1

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
// FTS5 search: symbols (global symbol store)
// ---------------------------------------------------------------------------

function ftsSearchSymbols(
  db: Database,
  query: string,
  filters: ParsedFilters,
  maxResults: number,
): SearchResult[] {
  let sql = `
    SELECT s.id, s.name AS title,
           coalesce(s.qualified_name, s.name) AS excerpt,
           'symbol' AS content_type,
           s.file_path AS source_path,
           s.project_hash,
           s.kind
    FROM symbols_fts f
    JOIN symbols s ON s.rowid = f.rowid
    WHERE symbols_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (filters.project) {
    sql += " AND s.project_hash = ?";
    params.push(hashContent(filters.project));
  }
  if (filters.kind) {
    sql += " AND s.kind = ?";
    params.push(filters.kind);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(maxResults);

  try {
    const rows = db.query(sql).all(...params) as Array<{
      id: string;
      title: string;
      excerpt: string;
      content_type: "symbol";
      source_path: string | null;
      project_hash: string | null;
      kind: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: r.excerpt,
      score: 0,
      content_type: "symbol" as const,
      source_path: r.source_path ?? undefined,
      project_hash: r.project_hash ?? undefined,
      metadata: { kind: r.kind ?? undefined },
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Unified FTS5 + vec0 search across documents, memories, and knowledge entries.
 *
 * - Parses structured filters from the query string itself (e.g. `language:ts path:src/`)
 * - Supports query-level filters AND options-level filters (merged, options override query)
 * - Sanitizes the query before passing to FTS5 MATCH (strips special chars, reserved words)
 * - Validates filter keys and values (rejects unknown keys, unsupported languages, path traversal)
 * - Runs FTS5 MATCH queries on all three content types
 * - Applies inline filters (language:, path:, entity_type:, etc.)
 * - Runs vec0 vector search (real embeddings via EmbeddingService when available,
 *   hash-based pseudo-embeddings as fallback) if chunks_vec table exists
 * - Combines results via weighted RRF fusion:
 *   - FTS5 1.0x / vec0 0.8x when using hash-based pseudo-embeddings
 *   - vec0 1.0x / FTS5 0.8x when real embedding model is available
 * - Strips `<mark>` tags from excerpts
 * - Results are cached per session via LRU cache
 *
 * @param db    Open brain database handle
 * @param query FTS5 search query (may contain field:value filter tokens)
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

  // ── Parse structured filters from the query string ────────────────────
  // e.g. "language:ts path:src/ kind:function hello world"
  //       → filters: { language: "ts", path: "src/", kind: "function" }
  //       → remaining text query: "hello world"
  const parsed = parseQuery(query);
  const mergedFilters = parsed.filters;

  // ── Merge with options-level filters (options override query filters) ─
  const optFilters = parseOptionsFilters(options?.filters);
  for (const [key, value] of Object.entries(optFilters)) {
    if (value !== undefined) {
      (mergedFilters as Record<string, string>)[key] = value;
    }
  }

  // ── Validate merged filters ───────────────────────────────────────────
  const validation = validateFilters(mergedFilters);
  if (!validation.valid) {
    throw new Error(`Invalid search filters: ${validation.error}`);
  }

  // ── Sanitize the text query for FTS5 MATCH ────────────────────────────
  const sanitized = sanitizeFtsQuery(parsed.query);
  if (sanitized.length === 0) {
    return [];
  }

  // Cache check (use original query + options for cache key stability)
  const key = makeCacheKey(query, options);
  const cached = sessionCache.search.get(key);
  if (cached) return cached as SearchResult[];

  const limit = Math.max(1, options?.limit ?? 20);
  const ct = options?.contentType ?? "all";
  const ftsLists: WeightedList[] = [];

  // Determine RRF weights based on embedding availability
  const { ftsWeight, vecWeight } = getRrfWeights();

  // Run FTS5 searches based on content type filter
  if (ct === "all" || ct === "document") {
    ftsLists.push({
      items: ftsSearchDocuments(db, sanitized, mergedFilters, limit),
      weight: ftsWeight,
    });
  }
  if (ct === "all" || ct === "memory") {
    ftsLists.push({
      items: ftsSearchMemories(db, sanitized, mergedFilters, limit),
      weight: ftsWeight,
    });
  }
  if (ct === "all" || ct === "knowledge") {
    ftsLists.push({
      items: ftsSearchKnowledge(db, sanitized, mergedFilters, limit),
      weight: ftsWeight,
    });
  }
  if (ct === "all" || ct === "symbol") {
    ftsLists.push({
      items: ftsSearchSymbols(db, sanitized, mergedFilters, limit),
      weight: ftsWeight,
    });
  }

  // Vec0 chunk search (async — uses real embeddings when available)
  let chunkResults: SearchResult[] = [];
  if (ct === "all" || ct === "chunk") {
    if (hasVec0Table(db) && loadVec0(db)) {
      chunkResults = await searchVec0(db, sanitized, limit);
    } else {
      chunkResults = searchChunksFallback(db, sanitized, limit, mergedFilters);
    }
  }

  let results: SearchResult[];
  if (chunkResults.length > 0) {
    // Weighted RRF fusion with chunk results
    ftsLists.push({ items: chunkResults, weight: vecWeight });
    results = rrfFusion(ftsLists, 60);
  } else {
    // Without chunk results, concatenate FTS5 lists in source order
    // (still apply FTS weight to scored items)
    if (ftsWeight !== 1.0) {
      // Normalize scores when weight != 1.0
      results = ftsLists.flatMap((l) =>
        l.items.map((item) => ({
          ...item,
          score: item.score * l.weight,
        })),
      );
    } else {
      results = ftsLists.flatMap((l) => l.items);
    }
  }

  // Cap at limit
  results = results.slice(0, limit);

  // Store in cache
  sessionCache.search.set(key, results);

  return results;
}
