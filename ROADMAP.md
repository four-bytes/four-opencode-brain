# four-opencode-brain — Evolution Roadmap

> Canonical plan for eliminating duplication, extracting atomic modules, and hardening reliability.

## Wave Ordering (Revised)

```
A2 (atomic dedup + module extraction) → A5 (open-source readiness) → A6 (memory fixes) → A7+ (further)
```

**A4 is done** — unified `updateStatus()` with session-scoped status files (#69, #70).  
**A3 is obsolete** — no blocked-directory scanning bug.  
**A1 is merged into A2** — library extraction now part of the atomic module plan.

---

## Wave A2 — Atomic Dedup + Module Extraction (FIRST)

> Priority: HIGH. Eliminates duplication, extracts reusable npm packages, makes the codebase modular.

### Background

Brain currently has two types of duplication:
1. **opencode-native duplication** — spinner array, hardcoded colors (can use opencode's built-in components)
2. **Monolith architecture** — single package with 4 engines (ingest, search, memory, knowledge) + TUI + hooks, making it hard to reuse individual engines

### A2 subdivided into two phases:

#### Phase 1: Spinner/Color Dedup (A2.1–A2.3)

| # | Task | Current | Target |
|---|------|---------|--------|
| A2.1 | Replace file polling with TuiEventBus | `setInterval(poll, 200ms)` reading status JSON file | `api.event.on('brain:status', handler)` — push-based |
| A2.2 | Use opencode `<Spinner>` | Handwritten braille `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]` + manual `spin++` | Import `<Spinner>` from opencode TUI |
| A2.3 | Use `api.theme` colors | Hardcoded `setFg(GREEN)`, `setFg(RED)`, `setFg(YELLOW)` | `theme().success`, `theme().error`, `theme().warning` |

#### Phase 2: Atomic Module Extraction (A2.4)

Each engine becomes its own npm package under `@four-bytes/` scope:

```
@four-bytes/brain-core              — DB schema init, LRU cache, logger, shared utils
@four-bytes/brain-ingest            — File walker, content-hash dedup, chunker, embed pipeline
@four-bytes/brain-search            — FTS5+vec0 hybrid search, query parser, FTS sanitizer
@four-bytes/brain-memory            — Memory CRUD (add/search/list/forget) + diary
@four-bytes/brain-knowledge         — KB entries, confidence gating, REGATE lifecycle
@four-bytes/brain-hooks             — System prompt generator, auto-capture triggers
@four-bytes/brain-tui               — SolidJS BrainStatusBar component, spinner/color integration
@four-bytes/opencode-plugin-lib     — Toast wrapper (createToast), shared plugin utilities
```

The main `@four-bytes/four-opencode-brain` becomes a thin **composer** that imports all modules and wires them together:

```typescript
// four-opencode-brain.ts (post-extraction)
import { initBrainDatabase } from "@four-bytes/brain-core";
import { ingestPath } from "@four-bytes/brain-ingest";
import { brainSearch } from "@four-bytes/brain-search";
import { memoryAdd, memorySearch } from "@four-bytes/brain-memory";
import { kbAdd, kbSearch } from "@four-bytes/brain-knowledge";
import { brainSystemPrompt } from "@four-bytes/brain-hooks";
import { createToast } from "@four-bytes/opencode-plugin-lib";
import { BrainStatusBar } from "@four-bytes/brain-tui";
```

#### Extraction Order (dependency-driven)

```
1. opencode-plugin-lib  →  Toast wrapper (no deps)
2. brain-core           →  Schema, cache, logger, shared (no deps)
3. brain-ingest         →  Depends on core (DB, cache)
4. brain-search         →  Depends on core (DB)
5. brain-memory         →  Depends on core (DB)
6. brain-knowledge      →  Depends on core (DB)
7. brain-hooks          →  Depends on memory + knowledge
8. brain-tui            →  Depends on core (project-agnostic)
9. four-opencode-brain  →  Composer (depends on all)
```

### Tasks

#### A2.1 — Replace file polling with TuiEventBus
- [ ] In `src/status.ts`: `publishBrainEvent('brain:status', payload)` instead of `writeFileSync()`
- [ ] In `src/tui.tsx`: subscribe to `api.event.on('brain:status', handler)` instead of `setInterval(poll, 200ms)`
- [ ] Remove `POLL_MS`, `setInterval`, `onCleanup(clearInterval)` polling loop
- [ ] Remove file-based `writeFileSync` / `readFile` status mechanism
- [ ] **Verification:** Status bar updates in real time; no file I/O for status

#### A2.2 — Use opencode `<Spinner>` component
- [ ] Remove `const SPINNER = ["⠋","⠙",…]` + `spin` variable from `tui.tsx`
- [ ] Use opencode's `<Spinner />` component (verify import path from `@opencode-ai/plugin/tui`)
- [ ] Wire spinner visibility to `data.phase === 'busy'` or equivalent
- [ ] **Verification:** Spinner animates identically to opencode's native spinners

#### A2.3 — Use `api.theme` colors
- [ ] Replace all `setFg(GREEN)` / `setFg(RED)` / `setFg(YELLOW)` with theme equivalents
- [ ] Map: GREEN → `theme().success`, RED → `theme().error`, YELLOW/ORANGE → `theme().warning`
- [ ] Map: MUTED → `theme().textMuted`, accent pulse → `theme().accent`
- [ ] Remove hardcoded color constants
- [ ] **Verification:** Colors match the user's opencode theme

#### A2.4 — Extract atomic npm packages
- [ ] **A2.4a** — Extract `@four-bytes/opencode-plugin-lib` (toast wrapper)
- [ ] **A2.4b** — Extract `@four-bytes/brain-core` (schema, cache, logger, shared)
- [ ] **A2.4c** — Extract `@four-bytes/brain-ingest` (walker, chunker, embed, dedup)
- [ ] **A2.4d** — Extract `@four-bytes/brain-search` (FTS5+vec0, query parser)
- [ ] **A2.4e** — Extract `@four-bytes/brain-memory` (CRUD + diary)
- [ ] **A2.4f** — Extract `@four-bytes/brain-knowledge` (KB, confidence, REGATE)
- [ ] **A2.4g** — Extract `@four-bytes/brain-hooks` (system prompt, auto-capture)
- [ ] **A2.4h** — Extract `@four-bytes/brain-tui` (BrainStatusBar + spinner)
- [ ] **A2.4i** — Refactor `@four-bytes/four-opencode-brain` as composer
- [ ] **Verification:** All tests pass; plugin behavior identical; each module independently publishable

### Acceptance Criteria (A2)
- [ ] No handwritten spinner array in brain code
- [ ] No hardcoded color constants — uses `api.theme`
- [ ] No polling loop in TUI — uses TuiEventBus
- [ ] All 8 sub-packages extracted and independently buildable
- [ ] `four-opencode-brain` composer passes all tests
- [ ] Each package has its own `package.json`, `tsconfig.json`, build script

---

## Wave A4 — Unified Status-Update Function ✅

> **DONE (#69, #70).** Single `updateStatus()` function with directory-scoped status files.
>
> **What was built:**
> - `src/status.ts` — `updateStatus(state, opts?)` supporting busy/success/warning/error/ready
> - Session-scoped status files via `getBrainStatusFile(directory)` (MD5-hash)
> - Wired to all 10 tool paths (ingest, search, reindex, memory, KB operations)
> - TUI polls per-directory file via `api.state.path.directory`

---

## Wave A5 — Open-Source Readiness

> Priority: MEDIUM. Required before public announcement.

### Tasks

#### A5.1 — README.md
- [ ] Project description: "Unified brain plugin — SQLite DB for RAG search, memory, and knowledge base"
- [ ] Installation: `npm install @four-bytes/four-opencode-brain` or opencode plugin marketplace
- [ ] Quick start: `/brain ingest`, `/brain search`, etc.
- [ ] Tool reference table (all 10 brain tools)
- [ ] Architecture diagram (three engines: ingest, search, memory)
- [ ] Configuration (env vars: `BRAIN_AUTO_INGEST`, `BRAIN_DEBUG`)
- [ ] Requirements (Bun, opencode, vec0 extension)

#### A5.2 — CONTRIBUTING.md
- [ ] Branch workflow: Issue → Branch → PR → Merge
- [ ] Conventional commits: `feat:`, `fix:`, `refactor:`
- [ ] Build discipline: `bun run build` after every change
- [ ] Testing: `bun test`
- [ ] PR template checklist

#### A5.3 — Issue Templates
- [ ] `.github/ISSUE_TEMPLATE/bug_report.md`
- [ ] `.github/ISSUE_TEMPLATE/feature_request.md`
- [ ] `.github/PULL_REQUEST_TEMPLATE.md`

#### A5.4 — GitHub Metadata
- [ ] Repository description, topics, website
- [ ] About section with key features
- [ ] License badge, npm version badge

### Acceptance Criteria (A5)
- [ ] README is complete and welcoming
- [ ] CONTRIBUTING.md covers full workflow
- [ ] Issue templates guide quality reports
- [ ] Repository looks professional and discoverable

---

## Wave A6 — Fix Memory Module

> Priority: HIGH. Memory (diary, important updates, store) currently silently broken.

### Root Causes (ranked)

| # | Bug | File | Fix |
|---|-----|------|-----|
| 1 | `memories_dedup_bi` trigger silently ignores repeat inserts; `memoryAdd()` returns success with fake ID | `schema.ts:574–582`, `store.ts:85–116` | Check `result.changes` after INSERT; return error if 0 |
| 2 | No data migration from `~/.four-mem/` to SQLite | Both repos | One-time migration script (personal use only) |
| 3 | `memorySearch` returns `[]` without error when no query | `store.ts:123` | Return explicit error like old plugin |
| 4 | Diary auto-capture depends on external API call that can fail silently | `four-opencode-brain.ts:738–767` | Add fallback — if API fails, create diary from event properties |
| 5 | `memoryAdd()` never verifies INSERT succeeded | `store.ts:85–116` | Check `result.changes` and connect to `updateStatus` |
| 6 | `onSessionIdle` creates knowledge entries, not memory entries | `auto-capture.ts:207–362` | Ensure memory patterns also create `memoryAdd` entries |
| 7 | Diary API requires `subMode: "add"` (non-obvious) | `four-opencode-brain.ts:486–499` | Improve API: auto-detect add vs get |
| 8 | Tool renamed from `memory` → `brain_memory` | N/A | No fix needed — no code references old name |

### Tasks

#### A6.1 — Fix dedup: validate INSERT success (Fix #1, #5)
- [ ] In `memoryAdd()`: capture `const result = db.run("INSERT INTO memories …")`
- [ ] If `result.changes === 0`, throw error: `"Memory not stored: duplicate content detected"`
- [ ] Wire to `updateStatus('warning', { text: 'Duplicate', toast: 'Memory already exists' })`
- [ ] Apply same pattern to `diaryAdd()`, `kbAdd()`, and any other INSERT

#### A6.2 — Fix empty query response (Fix #3)
- [ ] In `memorySearch()`: if `!opts.query`, return structured error `{ error: "query required" }`
- [ ] Match old plugin's behavior

#### A6.3 — Fix diary resilience (Fix #4)
- [ ] In `event` hook handler:
  - [ ] If `client.session.messages()` fails → fall back to `eventInput.event.properties` text
  - [ ] Log warning but still attempt `onSessionIdle`
- [ ] Ensure diary entries are always created on session idle

#### A6.4 — Fix memory auto-capture (Fix #6)
- [ ] In `onSessionIdle` / `onChatMessage`: after creating knowledge entries, also create `memoryAdd` entries
- [ ] Pattern: decisions → `memoryAdd` with `type: "decision"` AND `kbAdd` with `kind: "decision"`
- [ ] Ensure both stores are populated

#### A6.5 — Improve diary API (Fix #7)
- [ ] Simplify: `diaryGet` returns today if no date specified
- [ ] `diaryAdd` becomes simpler: `brain_memory({ mode: "diary", title: "...", content: "..." })` auto-detects add vs get
- [ ] Backward compatible with current API

#### A6.6 — Migration script (Fix #2)
- [ ] Create `scripts/migrate-from-four-mem.ts`
- [ ] Reads `~/.four-mem/MEMORY.md` → parses entries → inserts into SQLite
- [ ] Reads `~/.four-mem/diary/*.md` → parses entries → inserts into `diary_entries`
- [ ] One-time use, documented in README
- [ ] **Note:** Personal script — not part of plugin runtime

### Acceptance Criteria (A6)
- [ ] Re-adding the same memory returns a clear error, not fake success
- [ ] `brain_memory({ mode: "search" })` without query returns error
- [ ] Diary entries created on every session idle
- [ ] Memory entries created alongside knowledge entries on auto-capture
- [ ] Diary API is intuitive (auto-detect add vs get)
- [ ] Migration script available for old data

---

## Dependency Graph (Revised)

```
A2 (atomic dedup + modules)
 ├─► A5 (open-source readiness) — independent, can run in parallel with A2 phase 1
 └─► A6 (memory fixes) — uses modules from A2
```

## Execution Order

1. **A2 Phase 1** → Replace spinner, colors, polling with opencode-native APIs
2. **A2 Phase 2** → Extract 8 atomic npm packages + refactor composer
3. **A5** → README, CONTRIBUTING, issue templates, repo polish (parallelizable with A2 phase 2)
4. **A6** → Fix memory dedup, search, diary, migration script

---

## Status

| Wave | Status | Issue |
|------|--------|-------|
| A2 | ✅ Done | #71, #76 |
| A4 | ✅ **Done** | #69, #70 |
| A5 | ✅ Done | #85 |
| A6 | ✅ Done | #86 |

## Historical (Completed/Obsolte)

| Wave | Status | Issue |
|------|--------|-------|
| A1 | Merged into A2 | #49 |
| A3 | **Obsolete** | — |
