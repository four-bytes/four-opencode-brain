import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { sessionCache } from "./cache";
import { log, setSilent } from "./logger";
import { initBrainDatabase } from "./schema";
import { ingestPath } from "./ingest";
import { resolveFiles } from "./ingest/loader";
import { embedChunks } from "./ingest/embed";
import { loadVec0, getVec0Error, isVec0Loaded } from "./embed/extensionLoader";
import { withTimeout, TimeoutError } from "./utils/timeout";
import { brainSearch } from "./search/unified";
import { kbGet, kbAdd, kbRecord, kbReview, kbSearch, deriveEntryKey } from "./knowledge/store";
import type { KbAddInput, KbRecordInput, KbReviewInput } from "./knowledge/store";
import {
  memoryAdd,
  memorySearch,
  memoryList,
  memoryForget,
  memoryGet,
  diaryGet,
  diaryAdd,
} from "./memory/store";
import { brainSystemPrompt } from "./hooks/system-prompt";
import { onChatMessage, onSessionIdle } from "./hooks/auto-capture";
import { installBrainCommands } from "./commands/brain-slash";

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { basename, join, resolve, isAbsolute } from "path";
import { homedir } from "os";

const VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")
).version;
const s = tool.schema;

type MemoryInputType = "decision" | "pattern" | "fact" | "preference" | "error";


/**
 * Calculate ingest timeout dynamically based on file count.
 *
 * Heuristic: 10 files/s average throughput, minimum 5 minutes, cap at 30 minutes.
 * Formula: Math.max(300_000, Math.min(1_800_000, fileCount * 100))
 *
 * This replaces the old hard 120s timeout that caused failures on large projects.
 */
function calculateIngestTimeout(fileCount: number): number {
  const PER_FILE_MS = 500;          // 2 files/s — accounts for chunking + embedding + DB writes
  const MIN_TIMEOUT = 60_000;       // 1 minute minimum
  const MAX_TIMEOUT = 7_200_000;    // 120 minutes cap
  // For 2200 files: ~18 min. For 58 files: 60s (min). For 10000 files: ~83 min.
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, fileCount * PER_FILE_MS));
}

/** Unified status updates — see src/status.ts */
import { updateStatus, initStatus, initVersion } from "./status";



const _serverPlugin = async (input: PluginInput) => {
  const { client, project, directory, $ } = input;

  sessionCache.reset();
  initStatus(client);
  initVersion(VERSION);
  const toast = (msg: string, variant?: string, _title?: string) => {
    try { client.tui.showToast({ body: { message: msg, variant: (variant as any) ?? "info", title: "Brain 🧠" } }).catch(() => {}); } catch {}
  };
  log("info", "init", `v${VERSION} loaded`, { pid: process.pid });
  setSilent(true); // suppress all subsequent console output

  // Status file written to BRAIN_STATUS_FILE — TUI reads it directly (no HTTP server needed)


  // Signal TUI we're initializing
  updateStatus("busy", { text: "initializing" });

  // Ensure DB + schema on startup
  try {
    const db = initBrainDatabase();
    db.close();
  } catch (err) {
    log("error", "schema", `Schema init failed: ${String(err)}`);
  }

  // ---- Auto-ingest on startup (non-blocking, with toast notifications) ----
  const autoIngest = process.env.BRAIN_AUTO_INGEST?.toLowerCase() !== "false";

  // Only auto-ingest inside git repos, never in home root
  const normDir = directory ? resolve(directory) : "";
  const homeRoot = resolve(homedir());
  const isSystemDir = normDir === homeRoot || normDir === "/" || normDir === "/tmp"
    || normDir.startsWith("/home/") && normDir.split("/").length === 3;
  let hasGit = false;
  try { hasGit = statSync(join(normDir, ".git")).isDirectory(); } catch {}
  const shouldSkip = !hasGit || isSystemDir;

  if (autoIngest && directory && !shouldSkip) {
    log("info", "auto-ingest", "Auto-ingest starting", { directory });

    // Fire-and-forget — don't block plugin readiness
    (async () => {
      // Signal TUI we're scanning the directory tree
      updateStatus("busy", { text: "scanning files" });

      // Quick preliminary file count for toast + timeout calculation
      let fileCount = 0;
      try {
        const walked = await resolveFiles(directory, true);
        fileCount = walked.files.length;
        const timeoutS = (calculateIngestTimeout(fileCount) / 1000).toFixed(0);
        toast( `Indexing ${fileCount} files… (timeout: ${timeoutS}s)`, "info", "Brain 🧠");
        updateStatus("busy", { text: `ingesting 0/${fileCount}`, progress: 0, current: 0, total: fileCount });
      } catch {
        toast( `Indexing ${project?.name ?? "project"}…`, "info", "Brain 🧠");
        updateStatus("busy", { text: "ingesting…", progress: 0 });
      }

      const ingestDb = initBrainDatabase();
      const timeoutMs = calculateIngestTimeout(fileCount);
      try {
        const result = await withTimeout(
          ingestPath(ingestDb, directory, {
            recursive: true,
            reIndex: false,
            project: directory,
            progressCallback: ({ current, total }) => {
              const pct = total > 0 ? Math.round((current / total) * 100) : 0;
              // Update status file every tick so TUI spinner stays live
              updateStatus("busy", { text: `ingesting ${current}/${total} (${pct}%)`, progress: pct, current, total });
            },
          }),
          timeoutMs,
          `auto-ingest ${directory}`,
        );
        if (result.filesFound === 0) {
          const dirname = directory.split("/").filter(Boolean).pop() ?? directory;
          const msg = `🧠 Found 0 files in ${dirname} — check path`;
          updateStatus("warning", { toast: msg.replace("🧠 ", "") });
          toast( msg.replace("🧠 ", ""), "warning", "Brain 🧠");
          log("warn", "auto-ingest", msg, {
            filesFound: result.filesFound,
            filesSkipped: result.filesSkipped,
            filesIndexed: result.filesIndexed,
            errors: result.errors.length,
            durationMs: result.durationMs,
            directory,
          });
        } else {
          const msg = `🧠 Indexed ${result.filesIndexed} new, ${result.filesSkipped} skipped in ${(result.durationMs / 1000).toFixed(1)}s`;
          updateStatus("success", { toast: msg.replace("🧠 ", "") });
          toast( msg.replace("🧠 ", ""), "success", "Brain 🧠");
          log("info", "auto-ingest", msg, {
            filesFound: result.filesFound,
            filesIndexed: result.filesIndexed,
            filesSkipped: result.filesSkipped,
            errors: result.errors.length,
            durationMs: result.durationMs,
            directory,
          });
        }
      } catch (err) {
        if (err instanceof TimeoutError) {
          const msg = `🧠 Auto-ingest timed out after ${(timeoutMs / 1000).toFixed(0)}s — partial results`;
          updateStatus("warning", { toast: msg.replace("🧠 ", "") });
          toast( msg.replace("🧠 ", ""), "warning", "Brain 🧠");
          log("warn", "auto-ingest", msg, { directory, timeoutMs });
        } else {
          const errMsg = `🧠 Auto-ingest failed: ${String(err)}`;
          updateStatus("error", { toast: errMsg.replace("🧠 ", "") });
          toast( errMsg.replace("🧠 ", ""), "error", "Brain 🧠");
          log("error", "auto-ingest", errMsg);
        }
      } finally {
        ingestDb.close();
      }
    })();
  }

  else if (autoIngest && shouldSkip) {
    log("warn", "auto-ingest", "Skipped — not a git repo or system dir: " + normDir);
    updateStatus("warning", { text: "ingest excluded" });
  }
  // Install slash commands on first run (silent unless error)
  try {
    installBrainCommands();
  } catch (err) {
    log("error", "commands", `Command install failed: ${String(err)}`);
  }

  // Check vec0 extension availability (one-time toast warning only)
  {
    const checkDb = initBrainDatabase();
    const errDetail = getVec0Error();
    if (errDetail && !isVec0Loaded()) {
      log("warn", "vec0", `vec0 extension not available — vector search disabled. Chunk search falls back to SQL. (${errDetail})`, { platform: process.platform, arch: process.arch });
      toast( `vec0 extension unavailable — vector search disabled: ${errDetail}`, "error", "Brain 🧠");
    }
    checkDb.close();
  }

  // ---- First-run toast: show only when no files have been indexed yet ----
  {
    const firstRunDb = initBrainDatabase();
    try {
      const fileCount = firstRunDb
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM files")
        .get()!;
      if (fileCount.c === 0 && !autoIngest) {
        toast( "Brain initialized — use /brain ingest to index", "info", "Brain 🧠");
      }
    } catch {
      // DB might not have tables yet on truly first run — ignore
    }
    firstRunDb.close();
  }

  // Init complete — only set idle if NOT auto-ingesting
  if (!autoIngest) {
    updateStatus("ready"); // init complete, no auto-ingest
  }

  // ---- Tool definitions ----

  const brain_ingest = tool({
    description: "Ingest files/directories into the brain index. Uses content-hash dedup to skip unchanged files. Supports .ts, .js, .php, .md.",
    args: {
      path: s.string().optional().default(".").describe("File or directory path to ingest (default: .)"),
      recursive: s.boolean().optional().describe("Recurse into subdirectories (default: true)"),
      reIndex: s.boolean().optional().describe("Force re-index even if unchanged (default: false)"),
    },
    execute: async (args, toolCtx) => {
      const db = initBrainDatabase();
      const resolvedPath = resolve(toolCtx.directory, args.path);
      try {
        // Resolve path relative to project directory (like RAG plugin does)
        const name = basename(resolvedPath);
        toolCtx.metadata({ title: `Indexing ${name}…` });

        // Walk first to get file count for dynamic timeout
        let fileCount = 0;
        try {
          const walked = await resolveFiles(resolvedPath, args.recursive !== false);
          fileCount = walked.files.length;
        } catch {
          // fallback: use default
        }
        const timeoutMs = calculateIngestTimeout(fileCount);

        const result = await withTimeout(
          ingestPath(db, resolvedPath, {
            recursive: args.recursive !== false,
            reIndex: args.reIndex === true,
            project: toolCtx.directory,
            progressCallback: ({ current, total }) => {
              const pct = total > 0 ? Math.round((current / total) * 100) : 0;
              // Update status file every tick so TUI spinner stays live
              updateStatus("busy", { text: `ingesting ${current}/${total} (${pct}%)`, progress: pct, current, total });
            },
          }),
          timeoutMs,
          `ingestPath(${resolvedPath})`,
        );
        const msg = `🧠 Indexed ${result.filesIndexed} new, ${result.filesSkipped} skipped in ${(result.durationMs / 1000).toFixed(1)}s`;
        toolCtx.metadata({
          title: msg,
          metadata: {
            filesIndexed: result.filesIndexed,
            filesSkipped: result.filesSkipped,
            durationMs: result.durationMs,
          },
        });
        updateStatus("success", { toast: msg.replace("🧠 ", "") });
        return JSON.stringify(result);
      } catch (err) {
        if (err instanceof TimeoutError) {
          const timeoutMsg = `🧠 Ingest timed out after ${(timeoutMs / 1000).toFixed(0)}s`;
          toolCtx.metadata({ title: timeoutMsg });
          updateStatus("warning", { toast: timeoutMsg.replace("🧠 ", "") });
          log("warn", "ingest-timeout", timeoutMsg, { path: resolvedPath });
          return JSON.stringify({ error: timeoutMsg, partial: true });
        }
        const errMsg = `🧠 Ingest error: ${String(err)}`;
        toolCtx.metadata({ title: errMsg });
        updateStatus("error", { toast: errMsg.replace("🧠 ", "") });
        return JSON.stringify({ error: String(err) });
      } finally {
        db.close();
      }
    },
  });

  const brain_search = tool({
    description: "Unified FTS5 search across docs+memories+knowledge. Use before grep/glob.",
    args: {
      query: s.string().describe("Search query"),
      filters: s.string().optional().describe("language:ts path:src/ kind:function entity_type:problem"),
      limit: s.number().optional().describe("Max results (default 20)"),
      contentType: s.string().optional().describe("document|memory|knowledge|chunk|symbol|all"),
      project: s.string().optional().describe("Project name or hash to scope search"),
    },
    execute: async (args, toolCtx) => {
      updateStatus("busy", { text: "searching" });
      const db = initBrainDatabase();
      try {
        const results = await withTimeout(
          brainSearch(db, args.query, {
            filters: args.filters,
            limit: args.limit ?? 20,
            contentType: (args.contentType ?? "all") as
              | "document"
              | "memory"
              | "knowledge"
              | "chunk"
              | "symbol"
              | "all",
            project: (args.project as string | undefined) ?? toolCtx.directory,
          }),
          30_000,
          `brainSearch(${args.query})`,
        );
        updateStatus("ready");
        return JSON.stringify({ results, count: results.length });
      } catch (err) {
        if (err instanceof TimeoutError) {
          log("warn", "search-timeout", `Search timed out after 30s`, { query: args.query });
          updateStatus("warning");
        return JSON.stringify({ results: [], count: 0, error: "Search timed out — try a simpler query" });
        }
        const errMsg = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
        log("error", "search", errMsg, { query: args.query });
        updateStatus("error");
        return JSON.stringify({ results: [], count: 0, error: errMsg });
      } finally {
        db.close();
      }
    },
  });

  const brain_reindex = tool({
    description: "Rebuild vec0 vector index from chunks.",
    args: {},
    execute: async () => {
      updateStatus("busy", { text: "Rebuilding vector index…" });
      const db = initBrainDatabase();
      try {
        db.run("DROP TABLE IF EXISTS chunks_vec");
        db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
            chunk_id TEXT PRIMARY KEY,
            embedding FLOAT[384]
          )
        `);

        const chunkRows = db.query<{ id: string }, []>(
          "SELECT id FROM chunks",
        ).all();
        const totalChunks = chunkRows.length;

        let embedded = 0;
        if (totalChunks > 0 && loadVec0(db)) {
          const chunkIds = chunkRows.map((r) => r.id);
          embedded = await embedChunks(db, chunkIds);
        }

                updateStatus("success", { toast: `Vector index rebuilt: ${embedded}/${totalChunks} chunks` });
        return JSON.stringify({
          ok: true,
          chunks: totalChunks,
          embedded,
          message: `Vector index rebuilt. ${embedded}/${totalChunks} chunks embedded.`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
                return JSON.stringify({ ok: false, error: msg });
      } finally {
        db.close();
      }
    },
  });

  const brain_memory = tool({
    description: "Memory CRUD for the brain — add, search, list, forget, diary, get.",
    args: {
      mode: s.string().describe("add|search|list|forget|diary|get"),
      type: s.string().optional().describe("decision|pattern|fact|preference|error"),
      title: s.string().optional(),
      content: s.string().optional(),
      tags: s.string().optional(),
      project: s.string().optional(),
      query: s.string().optional(),
      limit: s.number().optional(),
      offset: s.number().optional(),
      date: s.string().optional(),
      id: s.string().optional(),
      crossProject: s.boolean().optional().describe("Show memories from all projects"),
      subMode: s.string().optional().describe("For diary mode: add | get"),
      diaryTitle: s.string().optional().describe("Diary entry title (for add)"),
      diaryContent: s.string().optional().describe("Diary entry content (for add)"),
      diaryDate: s.string().optional().describe("Diary date YYYY-MM-DD (defaults today)"),
    },
    execute: async (args) => {
      const db = initBrainDatabase();
      try {
        switch (args.mode) {
          case "add":
            updateStatus("busy", { text: "Storing memory…" });
            const addResult = memoryAdd(db, {
                type: (args.type ?? "fact") as MemoryInputType,
                title: args.title as string,
                content: args.content as string,
                tags: args.tags as string | undefined,
                project: args.project as string | undefined,
              });
            updateStatus("success", { toast: "Memory stored" });
            return JSON.stringify(addResult);
          case "search":
            return JSON.stringify(
              memorySearch(db, {
                query: args.query as string | undefined,
                type: args.type as string | undefined,
                tags: args.tags as string | undefined,
                project: args.project as string | undefined,
                crossProject: args.crossProject === true,
                limit: args.limit as number | undefined,
              }),
            );
          case "list":
            return JSON.stringify(
              memoryList(db, {
                type: args.type as string | undefined,
                project: args.project as string | undefined,
                limit: args.limit as number | undefined,
                offset: args.offset as number | undefined,
              }),
            );
          case "forget":
            updateStatus("busy", { text: "Removing memory…" });
            const forgetOk = memoryForget(db, args.id as string);
            updateStatus(forgetOk ? "success" : "error", { toast: forgetOk ? "Memory removed" : "Memory not found" });
            return JSON.stringify({ ok: forgetOk });
          case "diary": {
            // Auto-detect: if title + content provided → add entry; otherwise → get
            const diaryDate = (args.diaryDate as string) ?? (args.date as string) ?? new Date().toISOString().split("T")[0];
            if (args.diaryTitle && args.diaryContent) {
              diaryAdd(db, { title: args.diaryTitle, content: args.diaryContent, date: diaryDate });
              return JSON.stringify(diaryGet(db, diaryDate));
            }
            if (args.title && args.content) {
              diaryAdd(db, { title: args.title, content: args.content, date: diaryDate });
              return JSON.stringify(diaryGet(db, diaryDate));
            }
            return JSON.stringify(diaryGet(db, diaryDate));
          }
          case "get": {
            const found = memoryGet(db, args.id as string);
            return JSON.stringify(found ?? { error: `Memory not found: ${args.id}` });
          }
          default:
            return JSON.stringify({
              error: `Unknown memory mode: ${args.mode}`,
              modes: "add|search|list|forget|diary|get",
            });
        }
      } catch (err) {
        const errMsg = `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`;
        log("error", "memory", errMsg, { mode: args.mode });
        return JSON.stringify({ error: errMsg });
      } finally {
        db.close();
      }
    },
  });

  const brain_kb_get = tool({
    description: "Get knowledge entry + occurrences + revisions by key.",
    args: {
      entry_key: s.string().describe("Knowledge entry key"),
      kind: s.string().optional().describe("Entry kind"),
    },
    execute: async (args) => {
      const db = initBrainDatabase();
      try {
        const entry = kbGet(db, args.entry_key, args.kind);
        return JSON.stringify(entry ?? { error: `Knowledge entry not found: ${args.entry_key}` });
      } catch (err) {
        const errMsg = `kb_get failed: ${err instanceof Error ? err.message : String(err)}`;
        log("error", "kb-get", errMsg, { entry_key: args.entry_key });
        return JSON.stringify({ error: errMsg });
      } finally {
        db.close();
      }
    },
  });

  const brain_kb_add = tool({
    description: "Add/update knowledge entry. Confidence-gated updates. New entries default to draft.",
    args: {
      title: s.string().describe("Entry title"),
      entry_key: s.string().optional().describe("Auto-derived from title if omitted"),
      kind: s.string().optional().describe("Entry kind (default: problem)"),
      description: s.string().optional(),
      entity_type: s.string().optional(),
      root_cause: s.string().optional(),
      canonical_solution: s.string().optional(),
      tags: s.string().optional(),
      confidence: s.number().optional(),
      review_state: s.string().optional(),
    },
    execute: async (args) => {
      const db = initBrainDatabase();
      try {
                updateStatus("busy", { text: "Saving knowledge entry…" });
        const result = kbAdd(db, {
          entry_key: (args.entry_key as string) ?? deriveEntryKey(args.title as string),
          kind: (args.kind as string) ?? "problem",
          title: args.title as string,
          description: args.description as string | undefined,
          entity_type: args.entity_type as string | undefined,
          root_cause: args.root_cause as string | undefined,
          canonical_solution: args.canonical_solution as string | undefined,
          tags: args.tags as string | undefined,
          confidence: args.confidence as number | undefined,
          review_state: args.review_state as string | undefined,
        } satisfies KbAddInput);
                updateStatus("success", { toast: "Knowledge entry saved" });
        return JSON.stringify(result);
      } catch (err) {
        updateStatus("error", { toast: `kb_add failed` });
        const errMsg = `kb_add failed: ${err instanceof Error ? err.message : String(err)}`;
        log("error", "kb-add", errMsg, { entry_key: args.entry_key ?? deriveEntryKey(args.title as string) });
        return JSON.stringify({ error: errMsg });
      } finally {
        db.close();
      }
    },
  });

  const brain_kb_record = tool({
    description: "Record occurrence outcome for knowledge entry. Creates bad_attempt for failed outcomes.",
    args: {
      entry_key: s.string().describe("Knowledge entry key"),
      kind: s.string().describe("Entry kind"),
      outcome: s.string().describe("fixed|failed|workaround|observed"),
      project_ref: s.string().optional(),
      repo_ref: s.string().optional(),
      issue_ref: s.string().optional(),
      commit_ref: s.string().optional(),
      observed_symptoms: s.string().optional(),
    },
    execute: async (args) => {
      const db = initBrainDatabase();
      try {
                updateStatus("busy", { text: "Recording occurrence…" });
        const occurrence = kbRecord(db, {
          entry_key: args.entry_key as string,
          kind: args.kind as string,
          project_ref: args.project_ref as string | undefined,
          repo_ref: args.repo_ref as string | undefined,
          issue_ref: args.issue_ref as string | undefined,
          commit_ref: args.commit_ref as string | undefined,
          observed_symptoms: args.observed_symptoms as string | undefined,
          outcome: args.outcome as "fixed" | "failed" | "workaround" | "observed",
        } satisfies KbRecordInput);
                updateStatus("success", { toast: "Occurrence recorded" });
        return JSON.stringify(occurrence);
      } catch (err) {
        updateStatus("error", { toast: `kb_record failed` });
        const errMsg = `kb_record failed: ${err instanceof Error ? err.message : String(err)}`;
        log("error", "kb-record", errMsg, { entry_key: args.entry_key, kind: args.kind });
        return JSON.stringify({ error: errMsg });
      } finally {
        db.close();
      }
    },
  });

  const brain_kb_review = tool({
    description: "Update review-state with REGATE enforcement. Supports draft→reviewed→accepted lifecycle.",
    args: {
      entry_key: s.string().describe("Knowledge entry key"),
      kind: s.string().describe("Entry kind"),
      review_state: s.string().describe("draft|reviewed|accepted|rejected|superseded"),
      confidence: s.number().optional(),
    },
    execute: async (args) => {
      const db = initBrainDatabase();
      try {
                updateStatus("busy", { text: "Updating review…" });
        const entry = kbReview(db, {
          entry_key: args.entry_key as string,
          kind: args.kind as string,
          review_state: args.review_state as "draft" | "reviewed" | "accepted" | "rejected" | "superseded",
          confidence: args.confidence as number | undefined,
        } satisfies KbReviewInput);
                updateStatus("success", { toast: "Review updated" });
        return JSON.stringify(entry);
      } catch (err) {
        updateStatus("error", { toast: `kb_review failed` });
        const errMsg = `kb_review failed: ${err instanceof Error ? err.message : String(err)}`;
        log("error", "kb-review", errMsg, { entry_key: args.entry_key, kind: args.kind });
        return JSON.stringify({ error: errMsg });
      } finally {
        db.close();
      }
    },
  });

  const brain_kb_search = tool({
    description: "FTS5 search knowledge entries. Filter by entity_type, kind, confidence_min, review_state.",
    args: {
      query: s.string().describe("Search query"),
      entity_type: s.string().optional().describe("Filter by entity type"),
      kind: s.string().optional().describe("Filter by kind"),
      confidence_min: s.number().optional().describe("Minimum confidence (0.0-1.0)"),
      review_state: s.string().optional().describe("draft|reviewed|accepted|rejected|superseded"),
      limit: s.number().optional().describe("Max results (default 20)"),
      offset: s.number().optional().describe("Result offset"),
    },
    execute: async (args) => {
      const db = initBrainDatabase();
      try {
        const results = kbSearch(db, {
          query: args.query as string,
          entity_type: args.entity_type as string | undefined,
          kind: args.kind as string | undefined,
          confidence_min: args.confidence_min as number | undefined,
          review_state: args.review_state as string | undefined,
          limit: (args.limit as number | undefined) ?? 20,
          offset: args.offset as number | undefined,
        });
        return JSON.stringify({ results, count: results.length });
      } catch (err) {
        const errMsg = `kb_search failed: ${err instanceof Error ? err.message : String(err)}`;
        log("error", "kb-search", errMsg, { query: args.query });
        updateStatus("ready");
        return JSON.stringify({ results: [], count: 0, error: errMsg });
      } finally {
        db.close();
      }
    },
  });

  const brain_kb_stats = tool({
    description: "Knowledge store statistics — totals, confidence distribution, review states.",
    args: {},
    execute: async () => {
      const db = initBrainDatabase();
      try {
        const total = db
          .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM knowledge_entries")
          .get()!;
        const avgConfidence = db
          .query<{ c: number | null }, []>("SELECT AVG(confidence) AS c FROM knowledge_entries")
          .get()!;
        const byEntityType = db
          .query<{ entity_type: string; c: number }, []>(
            "SELECT entity_type, COUNT(*) AS c FROM knowledge_entries GROUP BY entity_type ORDER BY c DESC",
          )
          .all();
        const byReviewState = db
          .query<{ review_state: string; c: number }, []>(
            "SELECT review_state, COUNT(*) AS c FROM knowledge_entries GROUP BY review_state ORDER BY c DESC",
          )
          .all();

        return JSON.stringify({
          totalEntries: total.c,
          avgConfidence: avgConfidence.c ?? 0,
          byEntityType,
          byReviewState,
        });
      } catch (err) {
        const errMsg = `kb_stats failed: ${err instanceof Error ? err.message : String(err)}`;
        log("error", "kb-stats", errMsg);
        return JSON.stringify({ error: errMsg });
      } finally {
        db.close();
      }
    },
  });

  return {
    "experimental.chat.system.transform": async (_hookInput, output) => {
      output.system.push(brainSystemPrompt());
    },
    "chat.message": async (_hookInput, output) => {
      if (output.message?.role === "user" && output.message?.content) {
        const stored = await onChatMessage(input, output.message as { role: string; content: string });
        if (stored && output.parts) {
          output.parts.push({
            id: `brain-mem-stored-${Date.now()}`,
            sessionID: output.message?.id ?? "",
            messageID: output.message?.id ?? "",
            type: "text" as const,
            text: `[Memory stored] The user asked to remember something. Acknowledge this briefly.`,
            synthetic: true,
          } as any);
        }
      }
    },
    "event": async (eventInput) => {
      if (eventInput.event.type === "session.idle") {
        const { sessionID } = eventInput.event.properties;
        let text = "";
        try {
          const result = await input.client.session.messages({
            path: { id: sessionID },
            query: { limit: 10, directory },
          });
          if (result.data) {
            const texts: string[] = [];
            for (const msg of result.data) {
              for (const part of msg.parts) {
                if (part.type === "text") {
                  texts.push(part.text);
                }
              }
            }
            text = texts.join("\n");
          }
        } catch (err) {
          log("debug", "autocapture", "Failed to fetch session messages — using event summary", { error: String(err) });
          // Fallback: use any available text from event properties
          text = JSON.stringify(eventInput.event.properties ?? {});
        }
        if (text) {
          await onSessionIdle(input, text, undefined, input.client, sessionID);
        } else {
          log("debug", "autocapture", "No session text to scan for decisions", { sessionID });
        }
      }
    },
    tool: {
      brain_ingest,
      brain_search,
      brain_reindex,
      brain_memory,
      brain_kb_get,
      brain_kb_add,
      brain_kb_record,
      brain_kb_review,
      brain_kb_search,
      brain_kb_stats,
    },
  };
};


// ==================================================================
// TUI companion — SolidJS component (see src/tui.tsx)

// ==================================================================
export default {
  id: "four-opencode-brain",
  server: _serverPlugin,
};
