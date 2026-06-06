<img src="icon.svg" alt="four-opencode-brain" width="96" height="96" align="right">

# @four-bytes/four-opencode-brain

> Unified brain plugin for [opencode](https://github.com/opencode-ai/opencode) — single SQLite database for RAG search, session memory, and knowledge base with hybrid search (FTS5 + vec0 vector extension).

![License](https://img.shields.io/badge/license-Apache%202.0-blue)
[![npm version](https://img.shields.io/npm/v/@four-bytes/four-opencode-brain)](https://www.npmjs.com/package/@four-bytes/four-opencode-brain)

## Status

**v1.0.0** — stable release. See [HISTORY.md](HISTORY.md) for changelog.

## Architecture

"One brain, three internal engines":

```
┌──────────────────────────────────────────────────────┐
│              four-opencode-brain v1.0.0              │
├───────────┬───────────────┬──────────────────────────┤
│  Search   │    Memory     │   Knowledge Base          │
│ FTS5+vec0 │   SQLite DB   │   Confidence-gated       │
│  Hybrid   │   Auto-capture│   Problem Store           │
│  Symbol   │   Diary       │   REGATE lifecycle       │
├───────────┴───────────────┴──────────────────────────┤
│  Cache (LRU) · Logger · Hooks · Config · CLI         │
└──────────────────────────────────────────────────────┘
```

### Embedding Pipeline

```
File → Loader → Chunker (token-based, 512-token windows, 77-token overlap)
  → Content-hash dedup → Documents table → FTS5 index
  → Symbol extraction (tree-sitter: TS, JS, PHP, Rust)
  → vec0 vector index (384-dim embeddings via node-llama-cpp or hash-based fallback)
  → RRF fusion (weighted: FTS5 1.0x / vec0 0.8x fallback, or 0.8x/1.0x real model)
```

## Tools (10 total)

The plugin registers 10 tools:

| Tool | Description |
|------|-------------|
| `brain_ingest` | Ingest files/directories with content-hash dedup |
| `brain_search` | Unified FTS5 search across docs, memories, knowledge |
| `brain_reindex` | Rebuild vec0 vector index from chunks |
| `brain_memory` | Memory CRUD: add, search, list, forget, diary, get |
| `brain_kb_add` | Add/update knowledge entry (confidence-gated) |
| `brain_kb_get` | Get knowledge entry + occurrences + revisions |
| `brain_kb_record` | Record occurrence outcome for knowledge entry |
| `brain_kb_review` | Update review-state with REGATE enforcement |
| `brain_kb_search` | FTS5 search knowledge entries with filters |
| `brain_kb_stats` | Knowledge store statistics and distribution |

## Installation

```bash
bun add @four-bytes/four-opencode-brain
```

Or in your opencode config:

```json
{
  "plugins": ["@four-bytes/four-opencode-brain"]
}
```

## Usage

The plugin registers `/brain` slash commands and 10 tools. Key operations:

- **Ingest**: `/brain-ingest <path>` or `brain_ingest` tool
- **Search**: `brain_search` tool — always use before grep/glob
- **Memory**: `brain_memory` tool with mode: add, search, list, forget, diary, get
- **Knowledge**: `brain_kb_*` tools for add, get, record, review, search, stats

Auto-capture triggers on session idle to store decisions as memories.

### CLI

Standalone CLI for development and scripting:

```bash
bun run src/cli.ts ingest <path>
bun run src/cli.ts search <query>
bun run src/cli.ts memory list
bun run src/cli.ts stats
```

### Configuration (via environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_HOME` | `~/.local/share/four-opencode-brain` | Database and cache directory |
| `BRAIN_AUTO_INGEST` | `true` | Auto-ingest on startup |
| `BRAIN_DEBUG` | `false` | Enable debug logging |
| `BRAIN_MAX_FILE_SIZE_MB` | `10` | Max file size for ingestion |
| `BRAIN_CHUNK_MAX_TOKENS` | `1024` | Max tokens per chunk |

## Token Budget

Tool descriptions + system prompt: **~262 tokens** (budget: 400).

## Development

See [CONTRIBUTE.md](CONTRIBUTE.md) for workflow and [SETUP.md](docs/SETUP.md) for machine setup.

## License

Apache-2.0 — see [LICENSE](LICENSE)
