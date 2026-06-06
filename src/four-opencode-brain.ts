import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { sessionCache } from "./cache";
import { log, setSilent } from "./logger";
import { initBrainDatabase } from "./schema";
import { ingestPath } from "./ingest";
import { embedChunks } from "./ingest/embed";
import { loadVec0, getVec0Error } from "./embed/extensionLoader";
import { brainSearch } from "./search/unified";
import { kbGet, kbAdd, kbRecord, kbReview, deriveEntryKey } from "./knowledge/store";
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

import { readFileSync } from "fs";
import { basename, join, resolve, isAbsolute } from "path";

const VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")
).version;
const s = tool.schema;

type MemoryInputType = "decision" | "pattern" | "fact" | "preference" | "error";

/**
 * TUI toast notification — silently handles all errors.
 * Matches RAG plugin pattern: never breaks plugin operation on UI failure.
 */
function showToast(
  client: PluginInput["client"],
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
  title?: string,
): void {
  try {
    client.tui.showToast({ body: { message, variant, ...(title ? { title } : {}) } }).catch(() => {});
  } catch {
    // Never let UI errors break plugin operation
  }
}

export default (async (input: PluginInput) => {
  const { client, project, directory, $ } = input;

  sessionCache.reset();
  log("info", "init", `v${VERSION} loaded`, { pid: process.pid });
  setSilent(true); // suppress all subsequent console output

  // Ensure DB + schema on startup
  try {
    const db = initBrainDatabase();
    db.close();
  } catch (err) {
    log("error", "schema", `Schema init failed: ${String(err)}`);
  }

  // ---- Auto-ingest on startup (non-blocking, with toast notifications) ----
  const autoIngest = process.env.BRAIN_AUTO_INGEST?.toLowerCase() !== "false";
  if (autoIngest && directory) {
    showToast(client, `Indexing ${project?.name ?? "project"}…`, "info", "Brain");
    log("info", "auto-ingest", "Auto-ingest starting", { directory });

    // Fire-and-forget — don't block plugin readiness
    (async () => {
      const ingestDb = initBrainDatabase();
      try {
        const result = await ingestPath(ingestDb, directory, { recursive: true, reIndex: false });
        if (result.filesFound === 0) {
          const dirname = directory.split("/").filter(Boolean).pop() ?? directory;
          const msg = `Found 0 files in ${dirname} — check path`;
          showToast(client, msg, "warning", "Brain");
          log("warn", "auto-ingest", msg, {
            filesFound: result.filesFound,
            filesSkipped: result.filesSkipped,
            filesIndexed: result.filesIndexed,
            errors: result.errors.length,
            durationMs: result.durationMs,
            directory,
          });
        } else {
          const msg = `Indexed ${result.filesIndexed} new, ${result.filesSkipped} skipped in ${(result.durationMs / 1000).toFixed(1)}s`;
          showToast(client, msg, "success", "Brain");
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
        const errMsg = `Auto-ingest failed: ${String(err)}`;
        showToast(client, errMsg, "error", "Brain");
        log("error", "auto-ingest", errMsg);
      } finally {
        ingestDb.close();
      }
    })();
  }

  // Install slash commands on first run (silent unless error)
  try {
    installBrainCommands();
  } catch (err) {
    log("error", "commands", `Command install failed: ${String(err)}`);
  }

  // Check vec0 extension availability (logged once per session)
  {
    const checkDb = initBrainDatabase();
    const errDetail = getVec0Error();
    if (errDetail) {
      log("warn", "vec0", `vec0 extension not available — vector search disabled. Chunk search falls back to SQL. (${errDetail})`, { platform: process.platform, arch: process.arch });
      showToast(client, `vec0 extension unavailable — vector search disabled: ${errDetail}`, "error", "Brain");
    }
    checkDb.close();
  }

  // ---- Tool definitions ----

  const brain_ingest = tool({
    description: "Ingest files/directories into the brain index. Uses content-hash dedup to skip unchanged files. Supports .ts, .js, .php, .md.",
    args: {
      path: s.string().describe("File or directory path to ingest"),
      recursive: s.boolean().optional().describe("Recurse into subdirectories (default: true)"),
      reIndex: s.boolean().optional().describe("Force re-index even if unchanged (default: false)"),
    },
    execute: async (args, toolCtx) => {
      const db = initBrainDatabase();
      try {
        // Resolve path relative to project directory (like RAG plugin does)
        const resolvedPath = resolve(toolCtx.directory, args.path);
        const name = basename(resolvedPath);
        toolCtx.metadata({ title: `Indexing ${name}…` });
        const result = await ingestPath(db, resolvedPath, {
          recursive: args.recursive !== false,
          reIndex: args.reIndex === true,
        });
        const msg = `Indexed ${result.filesIndexed} new, ${result.filesSkipped} skipped in ${(result.durationMs / 1000).toFixed(1)}s`;
        toolCtx.metadata({
          title: msg,
          metadata: {
            filesIndexed: result.filesIndexed,
            filesSkipped: result.filesSkipped,
            durationMs: result.durationMs,
          },
        });
        showToast(client, msg, "success", "Brain Ingest");
        return JSON.stringify(result);
      } catch (err) {
        const errMsg = `Ingest error: ${String(err)}`;
        toolCtx.metadata({ title: errMsg });
        showToast(client, errMsg, "error", "Brain Ingest");
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
      contentType: s.string().optional().describe("document|memory|knowledge|chunk|all"),
    },
    execute: async (args) => {
      const db = initBrainDatabase();
      const results = brainSearch(db, args.query, {
        filters: args.filters,
        limit: args.limit ?? 20,
        contentType: (args.contentType ?? "all") as
          | "document"
          | "memory"
          | "knowledge"
          | "chunk"
          | "all",
      });
      db.close();
      return JSON.stringify({ results, count: results.length });
    },
  });

  const brain_reindex = tool({
    description: "Rebuild vec0 vector index from chunks.",
    args: {},
    execute: async () => {
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
          embedded = embedChunks(db, chunkIds);
        }

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
            return JSON.stringify(
              memoryAdd(db, {
                type: (args.type ?? "fact") as MemoryInputType,
                title: args.title as string,
                content: args.content as string,
                tags: args.tags as string | undefined,
                project: args.project as string | undefined,
              }),
            );
          case "search":
            return JSON.stringify(
              memorySearch(db, {
                query: args.query as string | undefined,
                type: args.type as string | undefined,
                tags: args.tags as string | undefined,
                project: args.project as string | undefined,
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
            return JSON.stringify({ ok: memoryForget(db, args.id as string) });
          case "diary":
            if (args.subMode === "add") {
              if (!args.diaryTitle || !args.diaryContent) {
                return JSON.stringify({ error: "diaryTitle and diaryContent required for subMode=add" });
              }
              diaryAdd(db, {
                title: args.diaryTitle as string,
                content: args.diaryContent as string,
                date: args.diaryDate as string | undefined,
              });
              return JSON.stringify(diaryGet(db, (args.diaryDate as string) ?? new Date().toISOString().split("T")[0]));
            }
            return JSON.stringify(
              diaryGet(db, (args.date as string) ?? new Date().toISOString().split("T")[0]),
            );
          case "get": {
            const found = memoryGet(db, args.id as string);
            return JSON.stringify(found ?? { error: "not found" });
          }
          default:
            return JSON.stringify({
              error: "unknown mode",
              modes: "add|search|list|forget|diary|get",
            });
        }
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
        return JSON.stringify(entry ?? { error: "not found" });
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
        return JSON.stringify(result);
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
        return JSON.stringify(occurrence);
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
        const entry = kbReview(db, {
          entry_key: args.entry_key as string,
          kind: args.kind as string,
          review_state: args.review_state as "draft" | "reviewed" | "accepted" | "rejected" | "superseded",
          confidence: args.confidence as number | undefined,
        } satisfies KbReviewInput);
        return JSON.stringify(entry);
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
        await onChatMessage(input, output.message as { role: string; content: string });
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
          log("debug", "autocapture", "Failed to fetch session messages", { error: String(err) });
        }
        if (text) {
          await onSessionIdle(input, text);
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
    },
  };
}) satisfies Plugin;
