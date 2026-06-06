// ---------------------------------------------------------------------------
// Hook handlers for auto-capture: chat.message triggers + session.idle scanning
// ---------------------------------------------------------------------------

import type { PluginInput } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { openDatabase, createSchema } from "../schema";
import { memoryAdd, diaryAdd } from "../memory/store";
import { kbAdd, kbReview, deriveEntryKey } from "../knowledge/store";
import { log } from "../logger";

/**
 * TUI toast notification — silently handles all errors.
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Explicit trigger patterns for chat.message auto-capture */
const TRIGGER_PATTERNS = [
  /\bremember\s+this\b/i,
  /\bmerk\s+dir\b/i,
  /\bsave\s+this\b/i,
  /\bnote\s+this\b/i,
];

/** Decision keywords for session.idle scanning */
const DECISION_PHRASES = [
  "I'll use",
  "let's go with",
  "decided to",
  "we'll implement",
  "the fix is",
  "the solution is",
];

/** "we considered X but chose Y" regex pattern */
const CONSIDERED_PATTERN = /we considered\s.+?\sbut\s(chose|decided|went with)/i;

/** Error/repeated-error patterns for E8.2 passive capture (lowercased) */
const ERROR_KEYWORDS = ["error", "failed", "crash", "bug", "exception", "typo", "mistake"];

// E8.2: Throttle — max 3 auto-captures per session
const autoCaptureCounts = new Map<string, number>();
const MAX_AUTO_CAPTURES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract content after the first trigger pattern match.
 * Strips leading punctuation (colon) and whitespace.
 * Returns null if no trigger is found or nothing meaningful after.
 */
export function extractTriggerContent(content: string): string | null {
  for (const pattern of TRIGGER_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      let after = content.slice(match.index + match[0].length).trim();
      // Strip leading colon and whitespace
      after = after.replace(/^[:\s]+/, "").trim();
      return after.length > 0 ? after : null;
    }
  }
  return null;
}

/**
 * Derive a title from content: first line or first 80 chars.
 */
export function deriveTitle(content: string): string {
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77) + "...";
}

/**
 * Scan text for decision phrases and return matches with context.
 */
export function scanForDecisions(
  text: string,
): Array<{ phrase: string; context: string }> {
  const matches: Array<{ phrase: string; context: string }> = [];
  for (const phrase of DECISION_PHRASES) {
    const regex = new RegExp(
      `.${"{0,40}"}${escapeRegex(phrase)}.{0,40}`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      matches.push({ phrase, context: m[0].trim() });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Hook: chat.message — explicit trigger auto-capture
// ---------------------------------------------------------------------------

/**
 * Auto-capture on chat message with explicit trigger phrases.
 *
 * Detects triggers like "remember this:", "merk dir:", "save this:"
 * and stores the remainder as a memory entry with type="fact".
 *
 * @param _input - PluginInput (unused, reserved for future client access)
 * @param message - The incoming message { role, content }
 * @param db - Optional Database instance (for testing with :memory:)
 */
export async function onChatMessage(
  _input: PluginInput,
  message: { role: string; content: string },
  db?: Database,
): Promise<boolean> {
  if (message.role !== "user" || !message.content) return false;

  const extracted = extractTriggerContent(message.content);
  if (!extracted) return false;

  const title = deriveTitle(extracted);
  const conn = db ?? openDatabase();
  try {
    createSchema(conn);
    memoryAdd(conn, { type: "fact", title, content: extracted });
    log("info", "autocapture", "auto-captured memory", { title });
    return true;
  } finally {
    if (!db) conn.close();
  }
}

/**
 * Scan text for error/repeated error keywords and return context snippets.
 * Each keyword yields at most one capture per session (dedup by keyword).
 */
export function scanForErrors(
  text: string,
): Array<{ keyword: string; context: string; count: number }> {
  const results: Array<{ keyword: string; context: string; count: number }> = [];
  for (const keyword of ERROR_KEYWORDS) {
    const regex = new RegExp(`.{0,40}${escapeRegex(keyword)}.{0,40}`, "gi");
    const contexts: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      contexts.push(m[0].trim());
    }
    if (contexts.length > 1) {
      // Only capture if the keyword appears more than once (repeated pattern)
      results.push({ keyword, context: contexts[0], count: contexts.length });
    }
  }
  return results;
}

/**
 * Scan text for "we considered X but chose Y" patterns.
 */
export function scanForConsideredDecisions(
  text: string,
): Array<{ context: string }> {
  const matches: Array<{ context: string }> = [];
  const regex = new RegExp(CONSIDERED_PATTERN.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    matches.push({ context: m[0].trim() });
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Hook: event (session.idle) — delayed decision auto-capture
// ---------------------------------------------------------------------------

/**
 * Auto-capture on session idle — creates low-confidence knowledge entries
 * for decisions found in the provided text.
 *
 * Scans text for decision keywords, deduplicates by entry_key, and creates
 * draft knowledge entries with confidence=0.1.
 *
 * @param _input - PluginInput (unused, reserved for future client access)
 * @param text - Text to scan for decisions (omit to skip)
 * @param db - Optional Database instance (for testing with :memory:)
 */
export async function onSessionIdle(
  _input: PluginInput,
  text?: string,
  db?: Database,
  client?: PluginInput["client"],
  sessionId?: string,
): Promise<void> {
  if (!text) return;

  const sid = sessionId ?? "default";
  const conn = db ?? openDatabase();

  try {
    createSchema(conn);
    let totalCaptures = 0;

    // ── E8.2: Throttle check ──────────────────────────────────────────────
    const currentCount = autoCaptureCounts.get(sid) ?? 0;
    if (currentCount >= MAX_AUTO_CAPTURES) {
      log("debug", "autocapture", "Throttle reached — skipping auto-capture", { session: sid });
      return;
    }

    log("debug", "autocapture", "Scanning session text", { textLength: text.length, session: sid });

    // ── E8.2: Scan for "we considered X but chose Y" patterns ──────────────
    const consideredDecisions = scanForConsideredDecisions(text);
    let consideredSaved = 0;
    for (const cd of consideredDecisions) {
      if (totalCaptures >= MAX_AUTO_CAPTURES) break;
      const entryKey = deriveEntryKey(cd.context.slice(0, 64));

      const existing = conn
        .query<{ entry_key: string }, [string]>(
          "SELECT entry_key FROM knowledge_entries WHERE entry_key = ? AND kind = 'decision' LIMIT 1",
        )
        .get(entryKey);
      if (existing) continue;

      kbAdd(conn, {
        entry_key: entryKey,
        kind: "decision",
        title: "Decision: considered alternative",
        description: cd.context,
        entity_type: "decision",
      });
      kbReview(conn, {
        entry_key: entryKey,
        kind: "decision",
        review_state: "draft",
        confidence: 0.1,
      });

      log("info", "autocapture", "auto-captured considered decision", { entryKey });
      consideredSaved++;
      totalCaptures++;
    }

    // ── Scan for standard decision phrases ─────────────────────────────────
    const decisions = scanForDecisions(text);
    let decisionsSaved = 0;
    for (const decision of decisions) {
      if (totalCaptures >= MAX_AUTO_CAPTURES) break;
      const entryKey = deriveEntryKey(decision.context.slice(0, 64));

      const existing = conn
        .query<{ entry_key: string }, [string]>(
          "SELECT entry_key FROM knowledge_entries WHERE entry_key = ? AND kind = 'decision' LIMIT 1",
        )
        .get(entryKey);
      if (existing) continue;

      kbAdd(conn, {
        entry_key: entryKey,
        kind: "decision",
        title: `Decision: ${decision.phrase}`,
        description: decision.context,
        entity_type: "decision",
      });
      kbReview(conn, {
        entry_key: entryKey,
        kind: "decision",
        review_state: "draft",
        confidence: 0.1,
      });

      log("info", "autocapture", "auto-captured decision", { entryKey, phrase: decision.phrase });
      decisionsSaved++;
      totalCaptures++;
    }

    // ── E8.2: Capture repeated error patterns as type="error" memory ──────
    const errors = scanForErrors(text);
    let errorsSaved = 0;
    for (const err of errors) {
      if (totalCaptures >= MAX_AUTO_CAPTURES) break;

      memoryAdd(conn, {
        type: "error",
        title: `Repeated error pattern: ${err.keyword}`,
        content: `The keyword "${err.keyword}" appeared ${err.count} times in the session.\nContext: ${err.context}`,
        tags: `error,${err.keyword},auto-captured`,
      });

      log("info", "autocapture", "auto-captured error pattern", { keyword: err.keyword, count: err.count });
      errorsSaved++;
      totalCaptures++;
    }

    // ── E8.3: Diary Auto-Capture ──────────────────────────────────────────
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toTimeString().split(" ")[0];

    const diaryLines: string[] = [];
    diaryLines.push(`Session activity summary`);
    diaryLines.push(``);
    if (decisionsSaved > 0 || consideredSaved > 0) {
      diaryLines.push(`Decisions made: ${decisionsSaved + consideredSaved}`);
    }
    if (errorsSaved > 0) {
      diaryLines.push(`Errors encountered: ${errorsSaved}`);
    }
    diaryLines.push(``);
    diaryLines.push(`---`);
    diaryLines.push(`Session text snippet:`);
    diaryLines.push(text.slice(0, 500));

    diaryAdd(conn, {
      date: dateStr,
      title: `Session — ${dateStr} ${timeStr}`,
      content: diaryLines.join("\n"),
    });

    // Update throttle counter
    autoCaptureCounts.set(sid, (autoCaptureCounts.get(sid) ?? 0) + totalCaptures);

    const summary: string[] = [];
    if (decisionsSaved + consideredSaved > 0) summary.push(`${decisionsSaved + consideredSaved} decision(s)`);
    if (errorsSaved > 0) summary.push(`${errorsSaved} error pattern(s)`);
    const summaryText = summary.length > 0 ? summary.join(", ") : "no new captures";

    log("info", "autocapture", "Auto-capture complete", {
      decisionsFound: decisions.length + consideredDecisions.length,
      decisionsSaved,
      errorsSaved,
      totalCaptures,
      session: sid,
    });

    if (client && (decisionsSaved + consideredSaved + errorsSaved) > 0) {
      showToast(client, `🧠 Auto-captured ${summaryText}`, "success", "Brain");
    }
  } finally {
    if (!db) conn.close();
  }
}
