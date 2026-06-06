// ---------------------------------------------------------------------------
// Hook handlers for auto-capture: chat.message triggers + session.idle scanning
// ---------------------------------------------------------------------------

import type { PluginInput } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { openDatabase, createSchema } from "../schema";
import { memoryAdd } from "../memory/store";
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
): Promise<void> {
  if (!text) return;

  log("debug", "autocapture", "Scanning session text for decisions", { textLength: text.length });

  const decisions = scanForDecisions(text);
  if (decisions.length === 0) {
    log("debug", "autocapture", "No decision patterns found in session text", { textLength: text.length });
    return;
  }

  const conn = db ?? openDatabase();
  try {
    createSchema(conn);

    for (const decision of decisions) {
      const entryKey = deriveEntryKey(decision.context.slice(0, 64));

      // Dedup: skip if entry_key already exists for kind="decision"
      const existing = conn
        .query<{ entry_key: string }, [string]>(
          "SELECT entry_key FROM knowledge_entries WHERE entry_key = ? AND kind = 'decision' LIMIT 1",
        )
        .get(entryKey);

      if (existing) continue;

      // Create entry (new entries always get confidence 0.0)
      kbAdd(conn, {
        entry_key: entryKey,
        kind: "decision",
        title: `Decision: ${decision.phrase}`,
        description: decision.context,
        entity_type: "decision",
      });

      // Update confidence to 0.1 via review (same state, different confidence)
      kbReview(conn, {
        entry_key: entryKey,
        kind: "decision",
        review_state: "draft",
        confidence: 0.1,
      });

      log("info", "autocapture", "auto-captured decision", {
        entryKey,
        phrase: decision.phrase,
      });
    }

    log("debug", "autocapture", "Auto-capture complete", { decisionsFound: decisions.length });

    // Toast notification for captured decisions
    if (client && decisions.length > 0) {
      showToast(client, `Auto-captured ${decisions.length} decision(s)`, "success", "Brain");
    }
  } finally {
    if (!db) conn.close();
  }
}
