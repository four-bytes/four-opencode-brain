# Contributing to four-opencode-brain

## Workflow

Every change follows: **Issue → Branch → Commit → PR → Review → Merge → Cleanup**

1. **Create an issue** — describe the bug, feature, or refactor
2. **Branch** — `feat/<issue>-short-desc` | `fix/<issue>-short-desc` | `refactor/<issue>-short-desc`
3. **Implement** — follow conventions below
4. **Commit** — conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`
5. **PR** — fill template, reference issue with `Closes #N`
6. **Review** — architect reviews, CI passes
7. **Merge** — squash merge, delete branch
8. **Cleanup** — `git checkout main && git pull --ff-only && git branch -D <branch>`

## Conventions

### Code
- **Source file:** `src/four-opencode-brain.ts` (not `src/index.ts`)
- **Language:** TypeScript, strict mode, ESM
- **Target:** Bun
- **Format:** No semicolons, single quotes, 2-space indent

### Commits
```
feat: short description #42
fix: short description #42
docs: short description #50
```

Always reference the issue number.

### Build
```bash
bun run build     # Full build (Bun server + tsc TUI + vec0 extraction)
bun test          # Run tests
```

Every code change must end with a successful `bun run build`. Dist is gitignored.

## Architecture

Three internal engines:
- **Ingest** — File walker, hash dedup, chunker, embeddings
- **Search** — Unified hybrid search (FTS5 + vec0)
- **Memory** — Session/project-scoped notes (SQLite)

See `ROADMAP.md` for the evolution plan.
