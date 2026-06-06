# four-opencode-brain — Evolution Roadmap

> Canonical plan for eliminating duplication, hardening reliability, and preparing for open source.

## Wave Ordering

```
A2 (dedup elimination) → A1 (lib extraction) → A4 (unified status) → A5 (open-source readiness) → A6 (memory fixes)
```

**A3 is obsolete** — blocked-directory scanning has no bug; the recent `scanning: false` fix (#47) resolved the spinner-stuck issue.

---

## Wave A2 — Eliminate opencode Duplication (FIRST)

> Priority: HIGH. This makes A1 simpler and removes the most technical debt.

### Background
Brain duplicates several patterns that opencode already provides natively:

| Duplicated Pattern | Brain Implementation | opencode Native |
|---|---|---|
| Spinner | Handwritten braille array `["⠋","⠙",…]` | `<Spinner>` SolidJS component (`packages/opencode/src/cli/cmd/tui/component/spinner.tsx`) |
| Status bar | Polling HTTP at 200ms (`Bun.serve :16936`) | Reactive `RunFooter` + `TuiEventBus` |
| Color constants | Hardcoded `RED`, `ORANGE`, `YELLOW`, `GREEN`, `MUTED` | `api.theme` RGBA values |
| Progress reporting | `writeStatus()` → file + in-memory → HTTP endpoint → poll | `api.ui.toast()` + `TuiEventBus.publish()` |

### Tasks

#### A2.1 — Replace polling HTTP with TuiEventBus
**Goal:** Eliminate the `Bun.serve` HTTP server on port 16936 and use opencode's event bus for backend→TUI communication.

- [ ] Remove `Bun.serve({ port: 16936, … })` from `src/four-opencode-brain.ts` (lines 106–121)
- [ ] Remove `STATUS_FILE`, `writeStatus()`, `clearStatus()`, `currentStatus` (lines 72–94)
- [ ] Add `api.event.publish('brain:status', { phase, … })` at every status transition
- [ ] Update `src/tui.tsx` to subscribe to `api.event.on('brain:status', handler)` instead of polling `fetch(STATUS_URL)`
- [ ] Remove `STATUS_URL`, `POLL_MS`, `setInterval` polling loop from `tui.tsx`
- [ ] **Verification:** Status-bar updates in real time; no port 16936 listener

#### A2.2 — Use opencode `<Spinner>` component
**Goal:** Drop the handwritten braille spinner array; import opencode's native component.

- [ ] Remove `const SPINNER = ["⠋","⠙",…]` from `src/tui.tsx`
- [ ] Import `Spinner` from `@opencode-ai/plugin/tui` (or wherever opencode exposes it)
- [ ] Replace manual `setIndicator(SPINNER[spin % SPINNER.length])` with `<Spinner />`
- [ ] **Verification:** Spinner looks and animates identically to opencode's native spinners

#### A2.3 — Use `api.theme` instead of hardcoded colors
**Goal:** Remove `RED`, `ORANGE`, `YELLOW`, `GREEN`, `MUTED`, `BRIGHT` constants.

- [ ] Replace `setFg(GREEN)` with `api.theme.success` or equivalent
- [ ] Replace `setFg(RED)` with `api.theme.error` or equivalent
- [ ] Replace `fg={MUTED}` with theme.muted equivalent
- [ ] **Verification:** Colors match the user's opencode theme

#### A2.4 — Remove `writeStatus()` → replace with unified function (A4)
**Goal:** After A2.1–A2.3, `writeStatus()` is dead code. Replace it with the unified `updateStatus()` function designed in Wave A4.

- [ ] Make `writeStatus` private/internal, renamed to `updateStatus`
- [ ] Wire all call sites to the new function
- [ ] **Verification:** Same or better status-bar responsiveness

### Acceptance Criteria (A2)
- [ ] No HTTP server on port 16936
- [ ] No handwritten spinner array in brain code
- [ ] No hardcoded color constants
- [ ] No polling loop in TUI
- [ ] Status bar responds to opencode event bus

---

## Wave A1 — Extract `@four-bytes/opencode-plugin-lib`

> Priority: MEDIUM. Public npm package. Only extract patterns NOT provided by opencode.

### Library Scope (post-A2)

After A2 eliminates duplication, only **one** pattern remains to extract:

| Pattern | Extract? | Reason |
|---------|----------|--------|
| Toast Wrapper | **YES** | Thin wrapper around `client.tui.showToast()` with error swallowing — useful for all plugins |
| Spinner | **NO** | opencode provides `<Spinner>` natively |
| Status bar | **NO** | opencode provides `RunFooter` + event bus |
| Polling helper | **NO** | Replaced by event bus in A2 |
| Status-update function | **NO** | Brain-specific (see A4); expose from lib only as optional utility |

### Tasks

#### A1.1 — Create repo `four-bytes/four-opencode-plugin-lib`
- [ ] Create GitHub repo (public, Apache-2.0)
- [ ] Initialize with `package.json` (`@four-bytes/opencode-plugin-lib`, ESM, Bun-targeted, strict TS)
- [ ] Set up build pipeline (Bun build, tsc for TUI types)
- [ ] Add AGENTS.md, CLAUDE.md

#### A1.2 — Extract Toast Wrapper
- [ ] Move `showToast()` pattern from `four-opencode-brain/src/four-opencode-brain.ts` (lines 42–53) into lib
- [ ] Export as `createToast(client, pluginName)` — returns `(message, variant, title?) => void`
- [ ] Handle all error cases silently (never break plugin on toast failure)
- [ ] **Verification:** Brain and deepseek-meter both use the lib's toast wrapper

#### A1.3 — Refactor brain to consume lib
- [ ] Add `@four-bytes/opencode-plugin-lib` as dependency
- [ ] Replace inline `showToast()` with `createToast(client, 'Brain 🧠')`
- [ ] **Verification:** Toasts appear identically, no regressions

### Acceptance Criteria (A1)
- [ ] `@four-bytes/opencode-plugin-lib` published to npm (public)
- [ ] Toast wrapper extracted and reusable
- [ ] Brain plugin consumes lib (no breaking changes)

---

## Wave A3 — Blocked Directory Scanning

> **OBSOLETE — NO BUG.** Confirmed by exhaustive trace analysis (see research log).

The `shouldSkip` guard at `four-opencode-brain.ts:145` correctly prevents all file scanning on blocked directories. The recent `scanning: false` fix (#47) resolved the only related issue (spinner stuck after fast finish).

**No tasks. Skipped.**

---

## Wave A4 — Unified Status-Update Function

> Priority: MEDIUM. Every DB/file/LLM operation should show busy→done lifecycle.

### Problem
Only `brain_ingest` and `brain_search` update the TUI status bar. Eight other tool paths are completely silent, including the heavy `brain_reindex` (drops + recreates vec0 table, re-embeds all chunks).

### Design: Single `updateStatus()` function

```typescript
type StatusState = 'busy' | 'success' | 'warning' | 'error' | 'ready';
type StatusOptions = {
  text?: string;          // Status-bar text
  toast?: string;         // Optional toast message
  toastVariant?: 'info' | 'success' | 'warning' | 'error';
};

function updateStatus(state: StatusState, opts?: StatusOptions): void {
  // Spinner + text for 'busy'
  // Green dot + text for 'success'  
  // Yellow dot for 'warning'
  // Red dot for 'error'
  // Green dot, no text for 'ready'
  // Optional toast via createToast()
}
```

### TUI Mapping

| `updateStatus()` call | Indicator | Color | Toast? |
|---|---|---|---|
| `updateStatus('busy', { text: 'Indexing…' })` | Spinner | Theme accent | No |
| `updateStatus('busy', { text: 'Searching…' })` | Spinner | Theme accent | No |
| `updateStatus('success', { text: 'Done', toast: 'Indexed 42 files' })` | • | Green | Yes |
| `updateStatus('warning', { text: 'Timeout', toast: 'Partial results' })` | • | Yellow | Yes |
| `updateStatus('error', { text: 'Failed', toast: 'Error: …' })` | • | Red | Yes |
| `updateStatus('ready')` | • | Green | No |

### Tasks

#### A4.1 — Implement `updateStatus()` function
- [ ] Create `src/status.ts` with the function + types
- [ ] Wire into TUI via event bus (publish `brain:status` events)
- [ ] TUI subscribes and maps state → indicator/color/text/toast

#### A4.2 — Wire all tool paths
- [ ] `brain_reindex`: `busy('Rebuilding index…')` → `success('Done', toast)`
- [ ] `brain_memory/add`: `busy('Storing…')` → `success('Stored', toast)` or `error`
- [ ] `brain_memory/forget`: `busy('Removing…')` → `success('Removed')` or `error`
- [ ] `brain_memory/diary:add`: `busy('Saving…')` → `success('Saved')`
- [ ] `brain_kb_add`: `busy('Saving entry…')` → `success('Entry saved')`
- [ ] `brain_kb_record`: `busy('Recording…')` → `success('Recorded')`
- [ ] `brain_kb_review`: `busy('Updating…')` → `success('Updated')`
- [ ] `brain_kb_stats`: brief `busy('Querying…')` → `ready()`
- [ ] `chat.message` hook: silent (no spinner — too frequent)
- [ ] `session.idle` hook: silent (no spinner — background)

#### A4.3 — Refactor existing status paths
- [ ] Replace `brain_ingest` direct `writeStatus` calls with `updateStatus`
- [ ] Replace `brain_search` direct `writeStatus` calls with `updateStatus`
- [ ] **Verification:** All operations show busy spinner → finish indicator

### Acceptance Criteria (A4)
- [ ] Every tool execution shows spinner while working
- [ ] Spinner resolves to success/warning/error indicator
- [ ] Optional toast on completion
- [ ] No regression in existing ingest/search status display

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
- [ ] In `event` hook handler (`four-opencode-brain.ts:738–767`):
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

## Dependency Graph

```
A2 (dedup elimination)
 ├─► A1 (lib extraction) — only Toast Wrapper remains
 │    └─► A4 (unified status) — uses event bus from A2 + wrapper from A1
 │         └─► A6 (memory fixes) — uses updateStatus from A4
 └─► A5 (open-source) — independent, can run in parallel
```

## Execution Order

1. **A2** → Remove polling HTTP, spinner, hardcoded colors → use opencode native APIs
2. **A1** → Extract Toast Wrapper to `@four-bytes/opencode-plugin-lib` (public npm)
3. **A4** → Unified `updateStatus()` function, wire to all tool paths
4. **A5** → README, CONTRIBUTING, issue templates, repo polish (can parallelize with A4)
5. **A6** → Fix memory dedup, search, diary, migration script

---

## Status

| Wave | Status | Issue |
|------|--------|-------|
| A2 | Pending | — |
| A1 | Pending | #49 |
| A3 | **Obsolete** | — |
| A4 | Pending | — |
| A5 | Pending | — |
| A6 | Pending | — |
