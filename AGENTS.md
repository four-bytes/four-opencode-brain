# four-opencode-brain — AGENTS.md

Pointer to central standards: `~/.personal-config/ai-shared/AGENTS.md` and meta-repo `~/four-opencode-plugins/AGENTS.md`.

## Convention
- Source file: `src/four-opencode-brain.ts` (NOT `src/index.ts`)
- npm name: `@four-bytes/four-opencode-brain`
- License: Apache-2.0
- ESM, Bun-targeted, strict TypeScript
- **Token budget enforced: every tool description measured, no redundant alias tools**

## Architecture
"One brain, three internal engines." Modular internally:
- `src/ingest/` — File walker, hash dedup, chunker, embeddings
- `src/search/` — Unified hybrid search (FTS5 + vec0)
- `src/memory/` — Session/project-scoped notes (SQLite-backed)
- `src/knowledge/` — Problem-centric entries (confidence + review gating)
- `src/cache.ts` — Per-session LRU (embeddings, search, chunks, hashes)
- `src/logger.ts` — Throttled, rate-limited, compact JSON
- `src/hooks/` — Unified system prompt + auto-capture triggers

## Embedding Pipeline
- Vec0 extension: v0.1.9, built from `vendor/sqlite-vec/`
- Priority: local build (`dist/extensions/<platform>/vec0.so`) > cache
- Embedding model: placeholder (hash-based pseudo-embedding, 384-dim)
- Real embedding model → follow-up wave

## Token Budget (HARD)
- Total tool descriptions + system prompt ≤400 tokens
- All JSON responses compact (no `null, 2`)
- No redundant tool aliases — one tool, one purpose

## Build Discipline (MANDATORY)
- EVERY code change ends with: version bump in `package.json` + `bun run build`
- No merge without current `dist/`
- `dist/` is gitignored, freshly built on `npm publish`

## Standards
`~/.personal-config/ai-shared/AGENTS.md`

## This Plugin
- Plugin name: brain
- Description: Unified brain plugin — single SQLite DB for RAG search, memory, and knowledge base
- Status: Wave P12a (implementation)

## Workflow
Issues → Branch → PR → Merge (feature workflow)
