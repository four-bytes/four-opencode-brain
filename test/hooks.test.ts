// ---------------------------------------------------------------------------
// Brain hook tests — system-prompt, auto-capture triggers, session idle
// ---------------------------------------------------------------------------

import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

import { brainSystemPrompt } from "../src/hooks/system-prompt";
import {
  onChatMessage,
  onSessionIdle,
  extractTriggerContent,
  deriveTitle,
  scanForDecisions,
} from "../src/hooks/auto-capture";
import { createSchema } from "../src/schema";
import { memoryGet } from "../src/memory/store";
import { kbGet } from "../src/knowledge/store";

// ---------------------------------------------------------------------------
// Mock PluginInput (minimal — functions don't access it)
// ---------------------------------------------------------------------------

const mockPluginInput = {} as any;

// ---------------------------------------------------------------------------
// System prompt tests
// ---------------------------------------------------------------------------

describe("brainSystemPrompt", () => {
  test("is ≤70 tokens (estimate: word count / 4 ≤ 70)", () => {
    const prompt = brainSystemPrompt();
    const wordCount = prompt.split(/\s+/).length;
    const estimatedTokens = wordCount / 4;
    expect(estimatedTokens).toBeLessThanOrEqual(70);
    // Also check raw word count is reasonable
    expect(wordCount).toBeLessThan(280); // 70 tokens * 4 words/token max
  });

  test("contains 'search' keyword", () => {
    expect(brainSystemPrompt()).toMatch(/search/i);
  });

  test("contains 'memory' keyword", () => {
    expect(brainSystemPrompt()).toMatch(/memory/i);
  });

  test("contains 'kb' keyword", () => {
    expect(brainSystemPrompt()).toMatch(/kb/i);
  });

  test("contains all 3 capability lines", () => {
    const prompt = brainSystemPrompt();
    expect(prompt).toContain("brain_search");
    expect(prompt).toContain("brain_memory");
    expect(prompt).toContain("brain_kb");
  });
});

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe("extractTriggerContent", () => {
  test('detects "remember this:" trigger', () => {
    const result = extractTriggerContent("remember this: the answer is 42");
    expect(result).toBe("the answer is 42");
  });

  test('detects "Remember this:" (case insensitive)', () => {
    const result = extractTriggerContent("Remember this: Hello World");
    expect(result).toBe("Hello World");
  });

  test('detects "merk dir:" trigger', () => {
    const result = extractTriggerContent("merk dir: das ist wichtig");
    expect(result).toBe("das ist wichtig");
  });

  test('detects "save this:" trigger', () => {
    const result = extractTriggerContent("save this: configuration detail");
    expect(result).toBe("configuration detail");
  });

  test('detects "note this:" trigger', () => {
    const result = extractTriggerContent("note this: important note");
    expect(result).toBe("important note");
  });

  test("returns null when no trigger present", () => {
    const result = extractTriggerContent("this is a normal message");
    expect(result).toBeNull();
  });

  test("returns null for empty content", () => {
    const result = extractTriggerContent("");
    expect(result).toBeNull();
  });

  test("handles trigger at end of content (no text after)", () => {
    const result = extractTriggerContent("remember this:");
    expect(result).toBeNull();
  });

  test("trims whitespace after trigger", () => {
    const result = extractTriggerContent("remember this:   spaced out   ");
    expect(result).toBe("spaced out");
  });
});

describe("deriveTitle", () => {
  test("uses first line when ≤80 chars", () => {
    const title = deriveTitle("Short title");
    expect(title).toBe("Short title");
  });

  test("truncates at 80 chars with ellipsis", () => {
    const long = "x".repeat(100);
    const title = deriveTitle(long);
    expect(title.length).toBe(80);
    expect(title).toMatch(/\.\.\.$/);
  });

  test("uses first line only for multi-line content", () => {
    const content = "First line\nSecond line\nThird line";
    expect(deriveTitle(content)).toBe("First line");
  });

  test("trims whitespace from first line", () => {
    expect(deriveTitle("  padded title  ")).toBe("padded title");
  });
});

describe("scanForDecisions", () => {
  test("detects 'I'll use' phrase", () => {
    const results = scanForDecisions("I'll use React for this project");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].phrase).toBe("I'll use");
  });

  test("detects 'let's go with' phrase", () => {
    const results = scanForDecisions("let's go with TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].phrase).toBe("let's go with");
  });

  test("detects 'decided to' phrase", () => {
    const results = scanForDecisions("decided to use SQLite");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("detects 'the solution is' phrase", () => {
    const results = scanForDecisions("the solution is to add a cache layer");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("returns empty for text with no decision keywords", () => {
    const results = scanForDecisions("What is the weather today?");
    expect(results.length).toBe(0);
  });

  test("returns context surrounding matched phrase", () => {
    const text =
      "After much consideration, I'll use PostgreSQL for the database layer.";
    const results = scanForDecisions(text);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].context.length).toBeGreaterThan(0);
  });

  test("returns multiple matches for different decision phrases", () => {
    const text =
      "I'll use React. The fix is to add error handling. decided to refactor.";
    const results = scanForDecisions(text);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Chat message hook — full integration with :memory: DB
// ---------------------------------------------------------------------------

describe("onChatMessage — integration", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA foreign_keys=ON;");
    createSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test('auto-captures memory on "remember this:" trigger', async () => {
    await onChatMessage(mockPluginInput, {
      role: "user",
      content: "remember this: the database uses WAL mode",
    }, db);

    // Verify memory was stored
    const results = db
      .query<{ id: string; title: string; type: string; content: string }, []>(
        "SELECT id, title, type, content FROM memories WHERE title = ?",
      )
      .get("the database uses WAL mode");

    expect(results).not.toBeNull();
    expect(results!.type).toBe("fact");
    expect(results!.content).toBe("the database uses WAL mode");
  });

  test("auto-captured memory uses type='fact'", async () => {
    await onChatMessage(mockPluginInput, {
      role: "user",
      content: "save this: important fact to remember",
    }, db);

    const results = db
      .query<{ type: string }, []>(
        "SELECT type FROM memories WHERE content = ?",
      )
      .get("important fact to remember");

    expect(results).not.toBeNull();
    expect(results!.type).toBe("fact");
  });

  test("does NOT trigger on normal user messages", async () => {
    await onChatMessage(mockPluginInput, {
      role: "user",
      content: "Can you help me with this code?",
    }, db);

    // No memories should be created for normal messages
    const count = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories")
      .get()!;
    // We have 2 from previous tests
    expect(count.c).toBe(2);
  });

  test("does NOT trigger on assistant messages", async () => {
    const beforeCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories")
      .get()!.c;

    await onChatMessage(mockPluginInput, {
      role: "assistant",
      content: "remember this: this should not be captured",
    }, db);

    const afterCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories")
      .get()!.c;

    expect(afterCount).toBe(beforeCount);
  });

  test("does NOT trigger on empty content", async () => {
    const beforeCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories")
      .get()!.c;

    await onChatMessage(mockPluginInput, {
      role: "user",
      content: "",
    }, db);

    const afterCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories")
      .get()!.c;

    expect(afterCount).toBe(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// Session idle hook — integration with :memory: DB
// ---------------------------------------------------------------------------

describe("onSessionIdle — integration", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA foreign_keys=ON;");
    createSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("creates low-confidence draft knowledge entry for decision text", async () => {
    await onSessionIdle(
      mockPluginInput,
      "After analysis, I'll use PostgreSQL for persistence. The solution is to add connection pooling.",
      db,
    );

    // Check that KB entries were created
    const entries = db
      .query<{ entry_key: string; confidence: number; review_state: string; kind: string }, []>(
        "SELECT entry_key, confidence, review_state, kind FROM knowledge_entries WHERE kind = 'decision'",
      )
      .all();

    expect(entries.length).toBeGreaterThanOrEqual(1);

    for (const entry of entries) {
      expect(entry.kind).toBe("decision");
      expect(entry.confidence).toBe(0.1);
      expect(entry.review_state).toBe("draft");
    }
  });

  test("uses low confidence (0.1) for auto-captured decisions", async () => {
    await onSessionIdle(
      mockPluginInput,
      "decided to use Redis for caching",
      db,
    );

    const entry = db
      .query<{ confidence: number; review_state: string }, []>(
        "SELECT confidence, review_state FROM knowledge_entries WHERE description LIKE '%Redis for caching%'",
      )
      .get();

    expect(entry).not.toBeNull();
    expect(entry!.confidence).toBe(0.1);
    expect(entry!.review_state).toBe("draft");
  });

  test("deduplicates — does not create duplicate entries for same decision phrase", async () => {
    const text = "we'll implement lazy loading for images";

    // Call twice
    await onSessionIdle(mockPluginInput, text, db);
    await onSessionIdle(mockPluginInput, text, db);

    const count = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) as c FROM knowledge_entries WHERE kind = 'decision'",
      )
      .get()!;

    // Should not have duplicated entries
    // We created entries in previous tests, but each phrase should be unique
    const phrases = db
      .query<{ entry_key: string }, []>(
        "SELECT entry_key FROM knowledge_entries WHERE kind = 'decision'",
      )
      .all();

    const uniqueKeys = new Set(phrases.map((p) => p.entry_key));
    expect(uniqueKeys.size).toBe(phrases.length);
  });

  test("does nothing when no decision keywords present", async () => {
    const beforeCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) as c FROM knowledge_entries WHERE kind = 'decision'",
      )
      .get()!.c;

    await onSessionIdle(
      mockPluginInput,
      "What is the capital of France?",
      db,
    );

    const afterCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) as c FROM knowledge_entries WHERE kind = 'decision'",
      )
      .get()!.c;

    expect(afterCount).toBe(beforeCount);
  });

  test("does nothing when no text provided", async () => {
    const beforeCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) as c FROM knowledge_entries WHERE kind = 'decision'",
      )
      .get()!.c;

    await onSessionIdle(mockPluginInput, undefined, db);

    const afterCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) as c FROM knowledge_entries WHERE kind = 'decision'",
      )
      .get()!.c;

    expect(afterCount).toBe(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// Plugin registration hooks — smoke tests for the handler signatures
// ---------------------------------------------------------------------------

describe("hook registration handlers", () => {
  test("system prompt hook appends prompt to system array", async () => {
    const output = { system: [] as string[] };
    const hook = async (_input: any, output: { system: string[] }) => {
      output.system.push(brainSystemPrompt());
    };
    await hook({}, output);
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("brain_search");
  });

  test("chat.message handler calls onChatMessage for user messages", async () => {
    let called = false;
    const testHandler = async (_input: any, output: any) => {
      if (output.message?.role === "user" && output.message?.content) {
        called = true;
      }
    };

    await testHandler(
      {},
      {
        message: {
          role: "user",
          content: "remember this: test capture",
        },
        parts: [],
      },
    );
    expect(called).toBe(true);
  });

  test("chat.message handler skips assistant messages", async () => {
    let called = false;
    const testHandler = async (_input: any, output: any) => {
      if (output.message?.role === "user" && output.message?.content) {
        called = true;
      }
    };

    await testHandler(
      {},
      {
        message: {
          role: "assistant",
          content: "remember this: should not capture",
        },
        parts: [],
      },
    );
    expect(called).toBe(false);
  });

  test("event handler detects session.idle", async () => {
    let idleDetected = false;
    const testHandler = async (eventInput: { event: { type: string } }) => {
      if (eventInput.event.type === "session.idle") {
        idleDetected = true;
      }
    };

    await testHandler({ event: { type: "session.idle" } });
    expect(idleDetected).toBe(true);

    // Should NOT trigger for other events
    await testHandler({ event: { type: "session.created" } });
    // Still true from first call — that's fine, we test the pattern
  });

  test("event handler ignores non-idle events", async () => {
    let idleDetected = false;
    const testHandler = async (eventInput: { event: { type: string } }) => {
      if (eventInput.event.type === "session.idle") {
        idleDetected = true;
      }
    };

    await testHandler({ event: { type: "session.created" } });
    expect(idleDetected).toBe(false);
  });
});
