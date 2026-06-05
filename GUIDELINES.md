# Coding Guidelines

## Tech Stack
- **Runtime:** Bun (≥1.x)
- **Language:** TypeScript strict mode
- **Module:** ESM only (`"type": "module"`)
- **Source:** `src/four-opencode-brain.ts` (NOT `src/index.ts`)
- **npm name:** `@four-bytes/four-opencode-brain`

## Code Style
- No `any` unless absolutely necessary
- Prefer `const` over `let`
- Use `async`/`await` — no raw promises
- Error handling: typed catch blocks, meaningful messages
- JSON output: compact (`JSON.stringify(x)`, no space arg)

## Token Budget (HARD)
- Total tool descriptions + system prompt ≤400 tokens
- All JSON responses compact (no pretty-print)
- No redundant tool aliases — one tool, one purpose

## Build Discipline (MANDATORY)
- EVERY code change ends with: version bump in `package.json` + `bun run build`
- No merge without current `dist/`
- `dist/` is gitignored, freshly built before `npm publish`

## File Conventions
- LF line endings
- UTF-8 encoding (support umlauts: ä ö ü ß)
- `.local.md` files are gitignored — use for personal dev config
- No personal paths in committed code (no `/home/`, `~/.personal-config/`)

## Plugin Structure
```
src/
├── four-opencode-brain.ts   # Plugin entry
├── ingest/                  # File walker, hash dedup, chunker
├── search/                  # FTS5 + vec0 hybrid search
├── memory/                  # Session/project-scoped SQLite notes
├── knowledge/               # Confidence-gated problem entries
├── embed/                   # Vec0 extension loader
├── hooks/                   # System prompt + auto-capture
├── cache.ts                 # Per-session LRU cache
├── logger.ts                # Throttled JSON logger
└── commands/                # /brain slash commands
```

## License Header
All new source files must include:
```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes
```
