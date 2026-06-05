# Setup Guide — four-opencode-brain

## Prerequisites

- **Bun** ≥ 1.x — [install guide](https://bun.sh)
- **Git** — for cloning and version control
- **curl** — for downloading the vec0 extension (already installed on most systems)

No C compiler needed — the vec0 vector extension is downloaded as a prebuilt binary.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/four-bytes/four-opencode-brain.git
cd four-opencode-brain

# Install dependencies
bun install

# Build (downloads vec0 extension + bundles TypeScript)
bun run build

# Run tests
bun test
```

Expected output: `221 pass, 0 fail`

## Development Workflow

1. **Edit code** in `src/`
2. **Build**: `bun run build` (runs vec0 download + bundling)
3. **Test**: `bun test`
4. **Commit**: following [Conventional Commits](https://www.conventionalcommits.org/)

## Build Details

`bun run build` executes two steps:
1. `bash scripts/build-vec.sh` — Downloads the prebuilt `vec0` SQLite extension from GitHub Releases (v0.1.9). Cached in `.cache/` for subsequent builds.
2. `bun build src/four-opencode-brain.ts --outdir=dist --target=bun` — Bundles the TypeScript plugin.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_AUTO_INGEST` | `true` | Auto-index project on plugin startup. Set to `"false"` to disable. |
| `BRAIN_DEBUG` | `false` | Enable debug-level logging. Set to `"true"` to enable. |

## Project Structure

```
four-opencode-brain/
├── src/                    # Source code
│   ├── four-opencode-brain.ts  # Plugin entry point
│   ├── ingest/             # File walker, hash dedup, chunker
│   ├── search/             # FTS5 + vec0 hybrid search
│   ├── memory/             # Session SQLite notes
│   ├── knowledge/          # Confidence-gated knowledge store
│   ├── embed/              # Vec0 extension loader
│   ├── hooks/              # System prompt + auto-capture
│   ├── commands/           # /brain slash commands
│   ├── cache.ts            # Per-session LRU cache
│   └── logger.ts           # Throttled JSON logger
├── dist/                   # Build output (gitignored)
├── scripts/                # Build scripts
├── test/                   # Test files
├── docs/                   # Documentation
└── .github/                # GitHub templates
```

## Troubleshooting

### "vec0 extension unavailable"

The build script downloads the extension for your platform. If your platform isn't supported, the plugin falls back to SQL LIKE search (no vector search). Supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64.

### "bun: command not found"

Install Bun from [bun.sh](https://bun.sh). Verify with `bun --version`.

### Tests fail

- Make sure `bun run build` completed successfully
- Check that `dist/extensions/<platform>/vec0.so` exists
- Run `bun test` from the repository root
