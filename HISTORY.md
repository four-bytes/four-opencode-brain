# Changelog

## v1.0.0 (2026-06-06)

Phase 5: Polish & Release

### E9: Developer Experience

- **CLI Runner** (`src/cli.ts`): Standalone CLI for ingest, search, memory, stats, kb operations. Run with `bun run src/cli.ts <command> [args]`. Uses the same function calls as the plugin.
- **Configuration System** (`src/config.ts`): Structured config from env vars (`BRAIN_HOME`, `BRAIN_AUTO_INGEST`, `BRAIN_DEBUG`, `BRAIN_MAX_FILE_SIZE_MB`, `BRAIN_CHUNK_MAX_TOKENS`) with validation and defaults. Singleton `getConfig()` export.
- **Updated documentation**: HISTORY.md and README.md now accurately reflect all tools and architecture.

### E10: Release

- **Token Budget Audit**: Measured all 10 tool descriptions + system prompt = ~262 tokens (well under 400 budget). No trimming needed.
- **Error Message Quality**: All tool handlers now have catch blocks producing actionable JSON error messages (not raw stack traces). `kbRecord` improved error messages with context.
- **Version 1.0.0**: Final build. All 247 tests passing.

## v0.3.5 (2026-06-06)

Phase 4: Search & Discovery

### E7: Search Enhancement

- **FTS5 Hybrid Search** (`src/search/unified.ts`): Weighted RRF fusion with FTS5 + vec0 vector search. Configurable weights based on embedding availability (real vs. pseudo-embeddings).
- **Query Parser** (`src/search/queryParser.ts`): Structured filter parsing from query strings (`language:ts path:src/`). Validated filter keys and values, rejecting unknown keys.
- **FTS5 Sanitizer** (`src/search/ftsSanitizer.ts`): Safe query sanitization for FTS5 MATCH, stripping reserved words and special characters.
- **Symbol Search** (`src/search/unified.ts`): FTS5 search on global symbol store. Search by name, qualified_name, kind, project.
- **FTS5 content-sync triggers**: All three content types (documents, memories, knowledge entries) auto-sync to FTS5 virtual tables on INSERT/UPDATE/DELETE.

### E8: Knowledge Store

- **Confidence Auto-Bump**: Fixed outcomes auto-bump confidence by +0.1 (capped at 0.9). 5+ fixed outcomes auto-promote to "accepted".
- **Occurrence Tracking** (`knowledge_occurrences` table): Record outcomes (fixed, failed, workaround, observed) with project/repo/issue/commit references.
- **Revision History** (`knowledge_revisions` table): Track all field changes with confidence and review state at time of change.
- **REGATE Lifecycle** (`src/knowledge/store.ts`): Validated state machine for draft→reviewed→accepted→rejected with terminal state enforcement.
- **Separate tool per KB operation**: brain_kb_get, brain_kb_add, brain_kb_record, brain_kb_review, brain_kb_search, brain_kb_stats.

## v0.2.4 (2026-06-06)

- Moved personal dev references to AGENTS.local.md
- Replaced vec0 compilation with prebuilt binary download from GitHub Releases

## v0.2.3 (2026-06-05)

- Auto-capture hooks trigger on session idle
- /brain slash commands (ingest, search, reindex, memory, kb-*)

## v0.2.2 (2026-06-05)

- Knowledge store with confidence gating
- REGATE review lifecycle

## v0.2.1 (2026-06-05)

- Per-session LRU cache (embeddings, search, chunks, hashes)
- Content-hash dedup in ingest pipeline

## v0.2.0 (2026-06-05)

- Unified brain: three engines (search, memory, knowledge)
- FTS5 full-text search integration

## v0.1.0 (2026-06-05)

- Initial plugin skeleton
- SQLite schema and basic engine structure
