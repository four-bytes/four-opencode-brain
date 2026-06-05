// ---------------------------------------------------------------------------
// Hybrid content chunker for brain ingestion
//
// Granularities:
//   - document  — whole file if <200 lines
//   - symbol    — one chunk per extracted symbol (class/function/method)
//   - window    — 50-line sliding windows with 25-line overlap for large files
//   - heading   — markdown files split by headings
// ---------------------------------------------------------------------------

import { hashContent } from "../schema";
import { sessionCache } from "../cache";
import { extractSymbols, type ExtractedSymbol } from "./symbolExtractor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCUMENT_LINE_LIMIT = 200;
const WINDOW_SIZE = 50;
const WINDOW_OVERLAP = 25;

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
  symbol: string | null;
  kind: string | null;
  startLine: number | null;
  endLine: number | null;
  chunkType: "document" | "symbol" | "window" | "heading";
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
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Window chunking
// ---------------------------------------------------------------------------

function chunkByWindows(
  content: string,
  documentId: string,
  fileId: string,
): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  const step = WINDOW_SIZE - WINDOW_OVERLAP;

  if (lines.length === 0) return [];

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + WINDOW_SIZE, lines.length);
    const chunkText = lines.slice(start, end).join("\n");
    const h = hashContentCached(chunkText);

    chunks.push({
      id: crypto.randomUUID(),
      documentId,
      fileId,
      chunkIndex: chunks.length,
      content: chunkText,
      contentHash: h,
      symbol: null,
      kind: null,
      startLine: start + 1, // 1-indexed
      endLine: end,
      chunkType: "window",
    });

    if (end >= lines.length) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Symbol chunking
// ---------------------------------------------------------------------------

function chunkBySymbols(
  content: string,
  symbols: ExtractedSymbol[],
  documentId: string,
  fileId: string,
): Chunk[] {
  const sorted = [...symbols].sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  );

  const chunks: Chunk[] = [];
  const lines = content.split("\n");

  for (const sym of sorted) {
    const symContent = lines.slice(sym.startLine - 1, sym.endLine).join("\n");
    const h = hashContentCached(symContent);

    chunks.push({
      id: crypto.randomUUID(),
      documentId,
      fileId,
      chunkIndex: chunks.length,
      content: symContent,
      contentHash: h,
      symbol: sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      chunkType: "symbol",
    });
  }

  return chunks;
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
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Chunk content into searchable pieces.
 *
 * Strategy:
 * - **Markdown**: split by headings (##/###), fallback to windows
 * - **Code files with symbols**: one chunk per symbol
 * - **Small files (<200 lines)**: single document chunk
 * - **Large files without symbols**: 50-line sliding windows, 25-line overlap
 */
export async function chunkContent(input: ChunkInput): Promise<Chunk[]> {
  if (!input.content || input.content.length === 0) return [];

  const { content, documentId, fileId, filePath, language, totalLines } = input;

  // Markdown: heading-based chunking
  if (language === "markdown" || language === "text") {
    const headingChunks = chunkByHeadings(content, documentId, fileId);
    if (headingChunks.length > 1) return headingChunks;
    // Single heading = whole doc, fall through to document/window logic
  }

  // Small files: single document chunk
  if (totalLines <= DOCUMENT_LINE_LIMIT) {
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
      },
    ];
  }

  // Code files: try symbol extraction
  if (language === "typescript" || language === "javascript" || language === "php") {
    try {
      const symbols = await extractSymbols(content, filePath);
      if (symbols.length > 0) {
        return chunkBySymbols(content, symbols, documentId, fileId);
      }
    } catch {
      // Fall through to window chunking
    }
  }

  // Large files without symbols: sliding windows
  return chunkByWindows(content, documentId, fileId);
}
