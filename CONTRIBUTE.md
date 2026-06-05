# Contributing to four-opencode-brain

## Golden Workflow

1. **Issue first** — Every change starts with a GitHub issue (Purpose, Scope, AC).
2. **Branch** — `feat/GH-{issue}-description` or `fix/GH-{issue}-description`
3. **Code** — Follow [GUIDELINES.md](GUIDELINES.md). Version bump in `package.json` + `bun run build` after every change.
4. **Test** — `bun test` must pass (221+ tests).
5. **PR** — Open pull request with description and checklist. Link the issue.
6. **Review** — All PRs require review. Merge only when passing.
7. **Cleanup** — Squash-merge, delete branch after merge.

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: description (#issue)
fix: description (#issue)
chore: description (#issue)
docs: description (#issue)
refactor: description (#issue)
```

## Branch Naming

```
feat/GH-{nr}-short-description
fix/GH-{nr}-short-description
chore/GH-{nr}-short-description
docs/GH-{nr}-short-description
```

## Build & Test

```bash
bun install          # Install dependencies
bun run build        # Download vec0 extension + bundle
bun test             # Run 221 tests
```

## PR Checklist

- [ ] Conventional commit format
- [ ] `bun test` passes
- [ ] `bun run build` succeeds
- [ ] Version bumped in `package.json`
- [ ] No personal paths in committed files (use `AGENTS.local.md`)
- [ ] `HISTORY.md` updated for user-facing changes

## License

By contributing, you agree that your contributions will be licensed under Apache-2.0.
