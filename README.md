# @four-bytes/four-opencode-brain

> Unified brain plugin for [opencode](https://github.com/opencode-ai/opencode) — single SQLite database for RAG search, session memory, and knowledge base with hybrid search (FTS5 + vec0 vector extension).

![License](https://img.shields.io/badge/license-Apache%202.0-blue)
[![npm version](https://img.shields.io/npm/v/@four-bytes/four-opencode-brain)](https://www.npmjs.com/package/@four-bytes/four-opencode-brain)

## Status

Wave P12 — active development. See [HISTORY.md](HISTORY.md) for changelog.

## Architecture

"One brain, three internal engines":

```
┌─────────────────────────────────────────────┐
│              four-opencode-brain             │
├───────────┬───────────────┬─────────────────┤
│  Search   │    Memory     │   Knowledge     │
│ FTS5+vec0 │   Session DB  │  Confidence-gated│
│  Hybrid   │   SQLite      │   Problem Store  │
├───────────┴───────────────┴─────────────────┤
│  Cache (LRU) · Logger · Hooks (auto-capture)  │
└─────────────────────────────────────────────┘
```

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

The plugin adds a `/brain` slash command with subcommands:
- `/brain ingest` — Index the current project
- `/brain search <query>` — Hybrid FTS5 + vector search
- `/brain reindex` — Rebuild vector index from scratch
- `/brain memory <note>` — Save session-scoped note
- `/brain kb-add <key> <content>` — Add knowledge entry
- `/brain kb-get <key>` — Retrieve knowledge entry
- `/brain kb-review <key> <confidence>` — Review and gate knowledge

Auto-capture triggers on session idle to index new/changed files automatically.

## Development

See [CONTRIBUTE.md](CONTRIBUTE.md) for workflow and [SETUP.md](docs/SETUP.md) for machine setup.

## License

Apache-2.0 — see [LICENSE](LICENSE)
