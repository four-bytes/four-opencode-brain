# four-opencode-brain — AGENTS.md

For local dev guidance, see `AGENTS.local.md` (gitignored, machine-specific).

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
- Vec0 extension: v0.1.9, downloaded from GitHub Releases, cached in `.cache/`
- Priority: bundled prebuilt binary (`dist/extensions/<platform>/vec0.so`)
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

## This Plugin
- Plugin name: brain
- Description: Unified brain plugin — single SQLite DB for RAG search, memory, and knowledge base
- Status: Wave P12a (implementation)

## Workflow
Issues → Branch → PR → Merge (feature workflow)


## Plugin-Lib Dependency Strategy

`@four-bytes/opencode-plugin-lib` is a shared library used by multiple plugins (brain, tbg, etc.).

**CI:** `package.json` pins to a GitHub tag:
```json
"@four-bytes/opencode-plugin-lib": "github:four-bytes/four-opencode-plugin-lib#v0.8.0"
```
When plugin-lib changes are merged:
1. Bump version in plugin-lib's `package.json`
2. Tag: `git tag v0.8.1 && git push --tags`
3. Update all dependent plugins' `package.json` + `bun.lock` to new tag

**Local dev:** Uses `bun link` to point `node_modules/@four-bytes/opencode-plugin-lib` at the local source `~/four-opencode-plugin-lib`:
```bash
cd ~/four-opencode-plugin-lib && bun link
cd ~/four-opencode-brain && bun link @four-bytes/opencode-plugin-lib
```
This makes local changes immediately available without re-tagging. NEVER commit a lockfile with symlink paths — always regenerate with `bun install` before pushing.

## Bus Architecture
- **Port:** Fixed port 4099 (no port discovery, no port.json)
- **Binary:** `~/.local/bin/four-local-bus` (Go, statically linked)
- **Fallback:** `MemoryBus`/`MemoryBusTui` for same-process only
- **Cross-process:** Requires Go `four-local-bus` binary running
