# 🧠 four-opencode-brain

**Unified brain plugin for [opencode](https://github.com/sst/opencode)** — single SQLite database for RAG search, memory, and knowledge base.

[![npm](https://img.shields.io/npm/v/@four-bytes/four-opencode-brain)](https://www.npmjs.com/package/@four-bytes/four-opencode-brain)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.5.0-blue)](https://github.com/four-bytes/four-opencode-brain/releases)

## Features

## Installation

```bash
# Clone and install
git clone https://github.com/four-bytes/four-opencode-brain
cd four-opencode-brain
bun install && bun run build

# Register globally (required — TUI slot plugin)
opencode plugin install . -g
```

Or via GitHub dependency in opencode.json:

```json
{
  "plugin": [
    "github:four-bytes/four-opencode-brain"
  ]
}
```

- **Hybrid Search** — FTS5 full-text + vec0 vector search with RRF fusion
- **Memory** — Session-scoped notes, decisions, patterns, errors, diary entries
- **Knowledge Base** — Problem-centric entries with confidence gating and review lifecycle
- **Auto-Ingest** — Indexes project files on startup (git repos only)
- **TUI Status Bar** — Live spinner, progress, and completion indicators
- **Content-Hash Dedup** — Skips unchanged files automatically

## Installation
## Quick Start

After installation, the brain auto-ingests your project on startup (git repos only). You can also:

```bash
# In opencode
/brain ingest .           # Index current directory
/brain search "function"  # Search indexed code
```

## Tools

| Tool | Description |
|------|-------------|
| `brain_search` | Unified FTS5+vec0 hybrid search across docs, memories, knowledge |
| `brain_ingest` | Index files/directories with content-hash dedup |
| `brain_reindex` | Rebuild vec0 vector index from chunks |
| `brain_memory` | CRUD for memories — add, search, list, forget, diary, get |
| `brain_kb_add` | Add/update knowledge entries (draft by default) |
| `brain_kb_get` | Get knowledge entry + occurrences + revisions |
| `brain_kb_record` | Record occurrence outcome (fixed, failed, workaround, observed) |
| `brain_kb_review` | Update review state (draft → reviewed → accepted) |
| `brain_kb_search` | FTS5 search knowledge entries |
| `brain_kb_stats` | Knowledge store statistics |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `BRAIN_AUTO_INGEST` | `true` | Auto-index on startup (git repos only) |
| `BRAIN_DEBUG` | unset | Enable debug logging to stderr |

## Requirements

- **Bun** ≥ 1.0
- **opencode** with plugin support
- **vec0** SQLite extension (bundled for linux-x64, linux-arm64, darwin-x64, darwin-arm64)

## Architecture

```
src/
├── ingest/       File walker, chunker, embed, symbol extraction
├── search/       FTS5 + vec0 hybrid search with RRF fusion
├── memory/       Session/project-scoped notes (SQLite)
├── knowledge/    Problem-centric entries (confidence + review)
├── hooks/        System prompt + auto-capture triggers
├── embed/        Vec0 extension loader + embedding pipeline
├── status.ts     Unified status bar + toast updates
├── tui.tsx       SolidJS status bar component (theme-aware)
└── shared.ts     Shared constants
```

## License

Apache-2.0 © [Four Bytes / Four Flames GmbH & Co. KG](https://fourbytes.de)
