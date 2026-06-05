import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { sessionCache } from "./cache";
import { log } from "./logger";
import { openDatabase, createSchema } from "./schema";
import { ingestPath } from "./ingest";
import { embedChunks } from "./ingest/embed";
import { loadVec0 } from "./embed/extensionLoader";
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
} from "./memory/store";
import { brainSystemPrompt } from "./hooks/system-prompt";
import { onChatMessage, onSessionIdle } from "./hooks/auto-capture";

const VERSION = "0.1.0";

export default (async (input: PluginInput) => {
  const { client, project, directory, $ } = input;

  sessionCache.reset();
  log("info", "init", `v${VERSION} loaded`, { pid: process.pid });

  // Ensure DB + schema on startup
  try {
    const db = openDatabase();
    createSchema(db);
    db.close();
    log("info", "schema", "Schema ready");
  } catch (err) {
    log("error", "schema", `Schema init failed: ${String(err)}`);
  }

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
        await onSessionIdle(input);
      }
    },
    tools: [
      {
        name: "brain_ingest",
        description: "Ingest files/directories into the brain index. Uses content-hash dedup to skip unchanged files. Supports .ts, .js, .php, .md.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File or directory path to ingest" },
            recursive: {
              type: "boolean",
              description: "Recurse into subdirectories (default: true)",
            },
            reIndex: {
              type: "boolean",
              description: "Force re-index even if unchanged (default: false)",
            },
          },
          required: ["path"],
        },
        execute: async (args: { path: string; recursive?: boolean; reIndex?: boolean }) => {
          const db = openDatabase();
          createSchema(db);
          const result = await ingestPath(db, args.path, {
            recursive: args.recursive !== false,
            reIndex: args.reIndex === true,
          });
          db.close();
          return JSON.stringify(result);
        },
      },
      {
        name: "brain_search",
        description: "Unified FTS5 search across docs+memories+knowledge. Use before grep/glob.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            filters: {
              type: "string",
              description: "language:ts path:src/ kind:function entity_type:problem",
            },
            limit: { type: "number", description: "Max results (default 20)" },
            contentType: {
              type: "string",
              description: "document|memory|knowledge|chunk|all",
            },
          },
          required: ["query"],
        },
        execute: async (args: {
          query: string;
          filters?: string;
          limit?: number;
          contentType?: string;
        }) => {
          const db = openDatabase();
          createSchema(db);
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
      },
      {
        name: "brain_reindex",
        description: "Rebuild vec0 vector index from chunks.",
        parameters: {
          type: "object",
          properties: {},
          required: []
        },
        execute: async () => {
          const db = openDatabase();
          createSchema(db);
          try {
            // Drop and recreate chunks_vec table
            db.run("DROP TABLE IF EXISTS chunks_vec");
            db.run(`
              CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
                chunk_id TEXT PRIMARY KEY,
                embedding FLOAT[384]
              )
            `);

            // Re-embed all existing chunks
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
        }
      },
      {
        name: "brain_memory",
        description: "Memory CRUD for the brain — add, search, list, forget, diary, get.",
        parameters: {
          type: "object",
          properties: {
            mode: { type: "string", description: "add|search|list|forget|diary|get" },
            type: { type: "string", description: "decision|pattern|fact|preference|error" },
            title: { type: "string" },
            content: { type: "string" },
            tags: { type: "string" },
            project: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
            offset: { type: "number" },
            date: { type: "string" },
            id: { type: "string" },
          },
          required: ["mode"],
        },
        execute: async (args: Record<string, unknown>) => {
          const db = openDatabase();
          createSchema(db);
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
      },
      {
        name: "brain_kb_get",
        description: "Get knowledge entry + occurrences + revisions by key.",
        parameters: {
          type: "object",
          properties: {
            entry_key: { type: "string" },
            kind: { type: "string" },
          },
          required: ["entry_key"],
        },
        execute: async (args: { entry_key: string; kind?: string }) => {
          const db = openDatabase();
          createSchema(db);
          try {
            const entry = kbGet(db, args.entry_key, args.kind);
            return JSON.stringify(entry ?? { error: "not found" });
          } finally {
            db.close();
          }
        },
      },
      {
        name: "brain_kb_add",
        description: "Add/update knowledge entry. Confidence-gated updates.",
        parameters: {
          type: "object",
          properties: {
            entry_key: { type: "string" },
            kind: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            entity_type: { type: "string" },
            root_cause: { type: "string" },
            canonical_solution: { type: "string" },
            tags: { type: "string" },
            confidence: { type: "number" },
            review_state: { type: "string" },
          },
          required: ["title"],
        },
        execute: async (args: Record<string, unknown>) => {
          const db = openDatabase();
          createSchema(db);
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
      },
      {
        name: "brain_kb_record",
        description: "Record occurrence outcome for knowledge entry. Creates bad_attempt for failed outcomes.",
        parameters: {
          type: "object",
          properties: {
            entry_key: { type: "string" },
            kind: { type: "string" },
            project_ref: { type: "string" },
            repo_ref: { type: "string" },
            issue_ref: { type: "string" },
            commit_ref: { type: "string" },
            observed_symptoms: { type: "string" },
            outcome: {
              type: "string",
              enum: ["fixed", "failed", "workaround", "observed"],
            },
          },
          required: ["entry_key", "kind", "outcome"],
        },
        execute: async (args: Record<string, unknown>) => {
          const db = openDatabase();
          createSchema(db);
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
      },
      {
        name: "brain_kb_review",
        description: "Update review-state with REGATE enforcement. Supports draft→reviewed→accepted lifecycle.",
        parameters: {
          type: "object",
          properties: {
            entry_key: { type: "string" },
            kind: { type: "string" },
            review_state: {
              type: "string",
              enum: ["draft", "reviewed", "accepted", "rejected", "superseded"],
            },
            confidence: { type: "number" },
          },
          required: ["entry_key", "kind", "review_state"],
        },
        execute: async (args: Record<string, unknown>) => {
          const db = openDatabase();
          createSchema(db);
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
      },
    ],
  };
}) satisfies Plugin;

type MemoryInputType = "decision" | "pattern" | "fact" | "preference" | "error";

// Re-export for internal use
export { sessionCache } from "./cache";
export { log } from "./logger";
