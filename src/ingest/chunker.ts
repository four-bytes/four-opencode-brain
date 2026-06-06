// ---------------------------------------------------------------------------
// Hybrid content chunker for brain ingestion
//
// Granularities:
//   - document  — whole file if ≤ 1024 tokens
//   - symbol    — one chunk per extracted symbol (class/function/method/etc.)
//   - window    — 512-token sliding windows with 77-token overlap
//   - heading   — markdown files split by headings
//
// Token estimation uses a rough 4 chars per token approximation.
// ---------------------------------------------------------------------------

import { hashContent } from "../schema";
import { sessionCache } from "../cache";
import { extractSymbols, type ExtractedSymbol } from "./symbolExtractor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS_PER_CHUNK = 1024;
const TOKEN_WINDOW = 512;
const TOKEN_OVERLAP = 77; // ~15 %

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token count estimator: 4 chars ≈ 1 token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChunkInput {
  documentId: string;
  fileId: string;
  content: string;
  filePath: string;
  language: string | null;
  totalLines: number;
}

export interface Chunk {
  id: string;
  documentId: string;
  fileId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  /** Qualified symbol path (e.g. "ClassName.methodName") or null */
  symbol: string | null;
  kind: string | null;
  startLine: number | null;
  endLine: number | null;
  chunkType: "document" | "symbol" | "window" | "heading";
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// LineIndex: O(log n) line-at-offset lookups
// ---------------------------------------------------------------------------

class LineIndex {
  private readonly lineStarts: number[];

  constructor(private readonly text: string) {
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /** Returns the 1-based line number at the given byte offset. */
  lineAt(offset: number): number {
    const pos = Math.min(offset, this.text.length);
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-indexed
  }
}

// ---------------------------------------------------------------------------
// Hash with session cache
// ---------------------------------------------------------------------------

function hashContentCached(content: string): string {
  const cached = sessionCache.hashes.get(content);
  if (cached) return cached;
  const h = hashContent(content);
  sessionCache.hashes.set(content, h);
  return h;
}

// ---------------------------------------------------------------------------
// Markdown heading chunking
// ---------------------------------------------------------------------------

/**
 * Split markdown content by headings (## or ###).
 * Returns sections with heading as first line.
 */
function chunkByHeadings(
  content: string,
  documentId: string,
  fileId: string,
): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let currentStart = 0;
  let headingLine = 1; // 1-indexed

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect markdown headings: ## or ###
    if (i > 0 && /^#{2,3}\s/.test(line)) {
      // Emit previous section
      const sectionContent = lines.slice(currentStart, i).join("\n").trim();
      if (sectionContent.length > 0) {
        const h = hashContentCached(sectionContent);
        chunks.push({
          id: crypto.randomUUID(),
          documentId,
          fileId,
          chunkIndex: chunks.length,
          content: sectionContent,
          contentHash: h,
          symbol: null,
          kind: null,
          startLine: headingLine,
          endLine: i,
          chunkType: "heading",
          tokenCount: estimateTokens(sectionContent),
        });
      }
      currentStart = i;
      headingLine = i + 1;
    }
  }

  // Last section
  const remaining = lines.slice(currentStart).join("\n").trim();
  if (remaining.length > 0) {
    const h = hashContentCached(remaining);
    chunks.push({
      id: crypto.randomUUID(),
      documentId,
      fileId,
      chunkIndex: chunks.length,
      content: remaining,
      contentHash: h,
      symbol: null,
      kind: null,
      startLine: headingLine,
      endLine: lines.length,
      chunkType: "heading",
      tokenCount: estimateTokens(remaining),
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Window chunking (token-based)
// ---------------------------------------------------------------------------

/**
 * Split `subContent` into fixed-size overlapping windows using token estimates.
 *
 * @param subContent   The text to split.
 * @param documentId   Owning document ID.
 * @param fileId       Owning file ID.
 * @param startChunkIndex  First chunk index to assign.
 * @param symbolName   Optional symbol name to inherit on every window.
 * @param baseLine     Line offset (1-indexed) within the original file.
 * @param qualifiedSym Optional qualified symbol path to inherit.
 * @param symKind      Optional symbol kind to inherit.
 */
function windowChunks(
  subContent: string,
  documentId: string,
  fileId: string,
  startChunkIndex: number,
  symbolName?: string,
  baseLine = 1,
  qualifiedSym?: string,
  symKind?: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  const windowChars = TOKEN_WINDOW * CHARS_PER_TOKEN;
  const overlapChars = TOKEN_OVERLAP * CHARS_PER_TOKEN;
  const step = windowChars - overlapChars;
  const len = subContent.length;

  if (len === 0) return [];

  const lineIdx = new LineIndex(subContent);

  for (let offset = 0; offset < len; offset += step) {
    const end = Math.min(offset + windowChars, len);
    const chunkText = subContent.slice(offset, end);
    const h = hashContentCached(chunkText);

    chunks.push({
      id: crypto.randomUUID(),
      documentId,
      fileId,
      chunkIndex: startChunkIndex + chunks.length,
      content: chunkText,
      contentHash: h,
      symbol: qualifiedSym ?? symbolName ?? null,
      kind: symKind ?? null,
      startLine: baseLine + lineIdx.lineAt(offset) - 1,
      endLine: baseLine + lineIdx.lineAt(end) - 1,
      chunkType: "window",
      tokenCount: estimateTokens(chunkText),
    });

    if (end >= len) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Symbol chunking
// ---------------------------------------------------------------------------

/**
 * Build chunks from extracted symbols.
 *
 * For each symbol:
 *   - ≤ MAX_TOKENS_PER_CHUNK tokens → single 'symbol' chunk
 *   - > MAX_TOKENS_PER_CHUNK tokens → split into 'window' sub-chunks
 *
 * If the total file ≤ MAX_TOKENS_PER_CHUNK, a full-document chunk is also
 * appended for top-level content (imports, etc.).
 */
function chunkBySymbols(
  content: string,
  symbols: ExtractedSymbol[],
  documentId: string,
  fileId: string,
  totalTokenCount: number,
): Chunk[] {
  const sorted = [...symbols].sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  );

  const chunks: Chunk[] = [];
  const lines = content.split("\n");

  for (const sym of sorted) {
    const symContent = lines.slice(sym.startLine - 1, sym.endLine).join("\n");
    const symTokens = estimateTokens(symContent);
    const h = hashContentCached(symContent);

    if (symTokens <= MAX_TOKENS_PER_CHUNK) {
      chunks.push({
        id: crypto.randomUUID(),
        documentId,
        fileId,
        chunkIndex: chunks.length,
        content: symContent,
        contentHash: h,
        symbol: sym.symbol ?? sym.name,
        kind: sym.kind,
        startLine: sym.startLine,
        endLine: sym.endLine,
        chunkType: "symbol",
        tokenCount: symTokens,
      });
    } else {
      // Large symbol → split into windows
      const windows = windowChunks(
        symContent,
        documentId,
        fileId,
        chunks.length,
        sym.name,
        sym.startLine,
        sym.symbol ?? sym.name,
        sym.kind,
      );
      chunks.push(...windows);
    }
  }

  // Add a catch-all document chunk for small files so top-level content
  // (imports, standalone expressions) is still searchable.
  if (totalTokenCount <= MAX_TOKENS_PER_CHUNK) {
    const h = hashContentCached(content);
    chunks.push({
      id: crypto.randomUUID(),
      documentId,
      fileId,
      chunkIndex: chunks.length,
      content,
      contentHash: h,
      symbol: null,
      kind: null,
      startLine: 1,
      endLine: lines.length,
      chunkType: "document",
      tokenCount: totalTokenCount,
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Fallback chunking (non-code files or when symbol extraction fails)
// ---------------------------------------------------------------------------

function fallbackChunk(
  content: string,
  documentId: string,
  fileId: string,
  totalTokenCount: number,
): Chunk[] {
  // Content shorter than the window → single document chunk
  if (totalTokenCount <= TOKEN_WINDOW) {
    const h = hashContentCached(content);
    return [
      {
        id: crypto.randomUUID(),
        documentId,
        fileId,
        chunkIndex: 0,
        content,
        contentHash: h,
        symbol: null,
        kind: null,
        startLine: 1,
        endLine: content.split("\n").length,
        chunkType: "document",
        tokenCount: totalTokenCount,
      },
    ];
  }

  // Sliding-window fallback
  return windowChunks(content, documentId, fileId, 0);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Chunk content into searchable pieces with token-based sizing.
 *
 * Strategy:
 * - **Markdown**: split by headings (##/###), fallback to windows
 * - **Code files with symbols**: one chunk per symbol (≤1024 tokens) or windowed
 * - **Small files (≤1024 tokens)**: single document chunk
 * - **Large files without symbols**: 512-token sliding windows, 77-token overlap
 */
export async function chunkContent(input: ChunkInput): Promise<Chunk[]> {
  if (!input.content || input.content.length === 0) return [];

  const { content, documentId, fileId, filePath, language, totalLines } = input;
  const totalTokenCount = estimateTokens(content);

  // Markdown: heading-based chunking
  if (language === "markdown" || language === "text") {
    const headingChunks = chunkByHeadings(content, documentId, fileId);
    if (headingChunks.length > 1) return headingChunks;
    // Single heading = whole doc, fall through to document/window logic
  }

  // Small files: single document chunk
  if (totalTokenCount <= MAX_TOKENS_PER_CHUNK) {
    const h = hashContentCached(content);
    return [
      {
        id: crypto.randomUUID(),
        documentId,
        fileId,
        chunkIndex: 0,
        content,
        contentHash: h,
        symbol: null,
        kind: null,
        startLine: 1,
        endLine: totalLines,
        chunkType: "document",
        tokenCount: totalTokenCount,
      },
    ];
  }

  // Code files: try symbol extraction
  if (
    language === "typescript" ||
    language === "javascript" ||
    language === "php" ||
    language === "rust"
  ) {
    try {
      const symbols = await extractSymbols(content, filePath);
      if (symbols.length > 0) {
        return chunkBySymbols(content, symbols, documentId, fileId, totalTokenCount);
      }
    } catch {
      // Fall through to window chunking
    }
  }

  // Large files without symbols: sliding windows
  return fallbackChunk(content, documentId, fileId, totalTokenCount);
}
