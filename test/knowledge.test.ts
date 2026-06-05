// ---------------------------------------------------------------------------
// Brain knowledge store — kbGet / kbAdd tests
// ---------------------------------------------------------------------------

import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

import { createSchema, generateId } from "../src/schema";
import {
  kbGet,
  kbAdd,
  kbRecord,
  kbReview,
  deriveEntryKey,
} from "../src/knowledge/store";
import type { KbAddInput, KbRecordInput, KbReviewInput } from "../src/knowledge/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = "/tmp/brain-knowledge-test-" + Date.now();
const TEST_DB = join(TEST_DIR, "brain.db");

let db: Database;

function freshDb(): Database {
  if (db) db.close();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  const d = new Database(TEST_DB);
  d.exec("PRAGMA journal_mode=WAL;");
  d.exec("PRAGMA foreign_keys=ON;");
  createSchema(d);
  return d;
}

beforeAll(() => {
  db = freshDb();
});

afterAll(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// deriveEntryKey
// ---------------------------------------------------------------------------

describe("deriveEntryKey", () => {
  test("lowercases title", () => {
    expect(deriveEntryKey("Hello World")).toBe("hello-world");
  });

  test("replaces non-alphanumeric with hyphens", () => {
    expect(deriveEntryKey("Fix: BUG #123")).toBe("fix-bug-123");
  });

  test("strips leading/trailing hyphens", () => {
    expect(deriveEntryKey("--hello--")).toBe("hello");
  });

  test("truncates to 64 chars", () => {
    const long = "a-" + "x".repeat(100);
    const derived = deriveEntryKey(long);
    expect(derived.length).toBeLessThanOrEqual(64);
  });

  test("collapses multiple separators into one", () => {
    expect(deriveEntryKey("foo   bar   baz")).toBe("foo-bar-baz");
  });
});

// ---------------------------------------------------------------------------
// kbAdd — create
// ---------------------------------------------------------------------------

describe("kbAdd — create", () => {
  let entryKey: string;

  beforeAll(() => {
    db = freshDb();
    entryKey = "kbadd-create-test";

    kbAdd(db, {
      entry_key: entryKey,
      kind: "problem",
      title: "Create test entry",
      description: "A test entry for creation",
      tags: "test,create",
      entity_type: "bug",
    });
  });

  test("returns action: created for new entry", () => {
    const result = kbAdd(db, {
      entry_key: "kbadd-create-returns-created",
      kind: "problem",
      title: "Create returns created",
    });
    expect(result.action).toBe("created");
  });

  test("stores entry with correct fields", () => {
    const entry = kbGet(db, entryKey, "problem")!;
    expect(entry.entry_key).toBe(entryKey);
    expect(entry.kind).toBe("problem");
    expect(entry.title).toBe("Create test entry");
  });

  test("new entry has confidence 0.0 regardless of input", () => {
    const customKey = "kbadd-confidence-override";
    const result = kbAdd(db, {
      entry_key: customKey,
      kind: "problem",
      title: "Confidence override test",
      confidence: 0.9,
    });

    expect(result.action).toBe("created");
    expect(result.entry.confidence).toBe(0.0);
  });

  test("new entry has review_state draft regardless of input", () => {
    const customKey = "kbadd-state-override";
    const result = kbAdd(db, {
      entry_key: customKey,
      kind: "problem",
      title: "State override test",
      review_state: "accepted",
    });

    expect(result.action).toBe("created");
    expect(result.entry.review_state).toBe("draft");
  });

  test("new entry has empty occurrences and revisions arrays", () => {
    const entry = kbGet(db, entryKey, "problem")!;
    expect(entry.occurrences).toEqual([]);
    expect(entry.revisions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// kbAdd — auto-derived entry_key
// ---------------------------------------------------------------------------

describe("kbAdd — auto-derived entry_key", () => {
  beforeAll(() => {
    db = freshDb();
  });

  test("derives entry_key from title when entry_key is empty string", () => {
    const result = kbAdd(db, {
      entry_key: "",
      kind: "pattern",
      title: "My Important Pattern",
    });

    expect(result.entry.entry_key).toBe("my-important-pattern");
    expect(result.action).toBe("created");
  });

  test("derives entry_key from title when entry_key is explicitly empty", () => {
    const result = kbAdd(db, {
      entry_key: "",
      kind: "fix",
      title: "Fix: Null Pointer Exception in Login",
    });

    expect(result.entry.entry_key).toBe("fix-null-pointer-exception-in-login");
    expect(result.action).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// kbGet — retrieval
// ---------------------------------------------------------------------------

describe("kbGet — retrieval", () => {
  const key = "kbget-full-test";
  const kind = "observation";

  beforeAll(() => {
    db = freshDb();

    // Seed an entry
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Full get test",
      description: "Testing full retrieval",
      entity_type: "observation",
      root_cause: "test root cause",
      canonical_solution: "test solution",
      tags: "get,full,test",
    });

    // Seed an occurrence directly
    const occId = generateId();
    db.run(
      `INSERT INTO knowledge_occurrences (id, entry_key, kind, project_ref, outcome)
       VALUES (?, ?, ?, ?, ?)`,
      [occId, key, kind, "test-project", "fixed"],
    );

    // Trigger an update to create a revision — preserve entity_type
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Full get test",
      description: "Updated description",
      entity_type: "observation",
      root_cause: "test root cause",
      canonical_solution: "test solution",
      tags: "get,full,test",
      confidence: 0.8,
    });
  });

  test("returns full entry by key", () => {
    const entry = kbGet(db, key);
    expect(entry).not.toBeNull();
    expect(entry!.entry_key).toBe(key);
    expect(entry!.kind).toBe(kind);
    expect(entry!.title).toBe("Full get test");
  });

  test("filters by kind when provided", () => {
    const entry = kbGet(db, key, kind);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe(kind);
  });

  test("returns first matching entry when kind is omitted", () => {
    const entry = kbGet(db, key);
    expect(entry).not.toBeNull();
    expect(entry!.entry_key).toBe(key);
  });

  test("includes all entry fields", () => {
    const entry = kbGet(db, key)!;
    expect(entry.description).toBe("Updated description");
    expect(entry.entity_type).toBe("observation");
    expect(entry.root_cause).toBe("test root cause");
    expect(entry.canonical_solution).toBe("test solution");
    expect(entry.tags).toBe("get,full,test");
    expect(typeof entry.confidence).toBe("number");
    expect(entry.review_state).toBe("draft");
  });

  test("includes occurrences array", () => {
    const entry = kbGet(db, key)!;
    expect(Array.isArray(entry.occurrences)).toBe(true);
    expect(entry.occurrences.length).toBeGreaterThanOrEqual(1);
    expect(entry.occurrences[0].entry_key).toBe(key);
    expect(entry.occurrences[0].outcome).toBe("fixed");
  });

  test("includes revisions array", () => {
    const entry = kbGet(db, key)!;
    expect(Array.isArray(entry.revisions)).toBe(true);
    expect(entry.revisions.length).toBeGreaterThanOrEqual(1);
    // The revision should track the description change
    const descRev = entry.revisions.find((r) => r.field_name === "description");
    expect(descRev).toBeDefined();
    expect(descRev!.old_value).toBe("Testing full retrieval");
    expect(descRev!.new_value).toBe("Updated description");
  });

  test("returns null for nonexistent entry", () => {
    const entry = kbGet(db, "nonexistent-key-12345");
    expect(entry).toBeNull();
  });

  test("returns null for nonexistent kind", () => {
    const entry = kbGet(db, key, "nonexistent-kind");
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kbAdd — confidence gate
// ---------------------------------------------------------------------------

describe("kbAdd — confidence gate", () => {
  const key = "kbadd-cg-test";
  const kind = "problem";

  beforeAll(() => {
    db = freshDb();

    // Seed with confidence 0.5
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Confidence gate test",
      description: "Original description",
      tags: "original",
      confidence: 0.5,
    });
  });

  test("update with higher confidence succeeds", () => {
    const result = kbAdd(db, {
      entry_key: key,
      kind,
      title: "Confidence gate test",
      description: "Updated by higher confidence",
      tags: "updated",
      confidence: 0.9,
    });

    expect(result.action).toBe("updated");
    expect(result.entry.description).toBe("Updated by higher confidence");
    expect(result.entry.tags).toBe("updated");
    expect(result.entry.confidence).toBe(0.9);
  });

  test("update with lower confidence is gated", () => {
    const entryBefore = kbGet(db, key)!;
    const confidenceBefore = entryBefore.confidence;

    const result = kbAdd(db, {
      entry_key: key,
      kind,
      title: "Confidence gate test",
      description: "Should not change",
      confidence: 0.2, // lower than current 0.9
    });

    expect(result.action).toBe("gated");
    expect(result.entry.description).toBe("Updated by higher confidence");
    expect(result.entry.confidence).toBe(confidenceBefore);
  });

  test("update with equal confidence is gated", () => {
    const result = kbAdd(db, {
      entry_key: key,
      kind,
      title: "Confidence gate test",
      description: "Equal confidence should not update",
      confidence: 0.9, // equal to current
    });

    expect(result.action).toBe("gated");
  });

  test("original entry unchanged after gate", () => {
    const entry = kbGet(db, key)!;
    expect(entry.description).toBe("Updated by higher confidence");
    expect(entry.confidence).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// kbAdd — revision tracking
// ---------------------------------------------------------------------------

describe("kbAdd — revision tracking", () => {
  const key = "kbadd-revision-test";
  const kind = "pattern";

  beforeAll(() => {
    db = freshDb();

    // Seed
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Revision test entry",
      description: "Original description",
    });
  });

  test("records revision for changed description field", () => {
    const before = kbGet(db, key)!;
    expect(before.revisions.length).toBe(0);

    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Revision test entry",
      description: "Changed description",
      confidence: 0.7,
    });

    const after = kbGet(db, key)!;
    const descRevisions = after.revisions.filter(
      (r) => r.field_name === "description",
    );
    expect(descRevisions.length).toBe(1);
    expect(descRevisions[0].old_value).toBe("Original description");
    expect(descRevisions[0].new_value).toBe("Changed description");
  });

  test("revision has confidence_at_time and review_state_at_time", () => {
    const entry = kbGet(db, key)!;
    const revision = entry.revisions.find(
      (r) => r.field_name === "description",
    );
    expect(revision).toBeDefined();
    expect(revision!.confidence_at_time).toBe(0.7);
    expect(revision!.review_state_at_time).toBe("draft");
  });

  test("does not record revision for unchanged fields", () => {
    // Title remained "Revision test entry" — no revision for it
    const entry = kbGet(db, key)!;
    const titleRevisions = entry.revisions.filter(
      (r) => r.field_name === "title",
    );
    expect(titleRevisions.length).toBe(0);
  });

  test("records multiple revisions across multiple updates", () => {
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Revision test entry",
      description: "Second change",
      tags: "new-tag",
      confidence: 0.8,
    });

    const entry = kbGet(db, key)!;
    const descRevisions = entry.revisions.filter(
      (r) => r.field_name === "description",
    );
    const tagRevisions = entry.revisions.filter(
      (r) => r.field_name === "tags",
    );
    expect(descRevisions.length).toBe(2);
    expect(tagRevisions.length).toBe(1);
    expect(tagRevisions[0].old_value).toBeNull();
    expect(tagRevisions[0].new_value).toBe("new-tag");
  });
});

// ---------------------------------------------------------------------------
// kbAdd — validation
// ---------------------------------------------------------------------------

describe("kbAdd — validation", () => {
  beforeAll(() => {
    db = freshDb();
  });

  test("rejects confidence > 1.0", () => {
    expect(() =>
      kbAdd(db, {
        entry_key: "invalid-confidence-high",
        kind: "problem",
        title: "Bad confidence",
        confidence: 1.5,
      }),
    ).toThrow("Confidence must be between 0.0 and 1.0");
  });

  test("rejects confidence < 0.0", () => {
    expect(() =>
      kbAdd(db, {
        entry_key: "invalid-confidence-low",
        kind: "problem",
        title: "Bad confidence negative",
        confidence: -0.1,
      }),
    ).toThrow("Confidence must be between 0.0 and 1.0");
  });

  test("allows confidence exactly 0.0", () => {
    const result = kbAdd(db, {
      entry_key: "confidence-zero",
      kind: "problem",
      title: "Zero confidence OK",
      confidence: 0.0,
    });
    expect(result.action).toBe("created");
    expect(result.entry.confidence).toBe(0.0);
  });

  test("allows confidence exactly 1.0", () => {
    const result = kbAdd(db, {
      entry_key: "confidence-one",
      kind: "problem",
      title: "One point zero confidence",
      confidence: 1.0,
    });
    expect(result.action).toBe("created");
    expect(result.entry.confidence).toBe(0.0); // new entries always 0.0
  });
});

// ---------------------------------------------------------------------------
// kbAdd — updated_at
// ---------------------------------------------------------------------------

describe("kbAdd — updated_at", () => {
  const key = "kbadd-updated-at";
  const kind = "decision";

  beforeAll(() => {
    db = freshDb();
  });

  test("is null on creation", () => {
    const result = kbAdd(db, {
      entry_key: key,
      kind,
      title: "Updated_at test",
    });
    expect(result.entry.updated_at).toBeNull();
  });

  test("changes on update", () => {
    const before = kbGet(db, key)!;
    expect(before.updated_at).toBeNull();

    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Updated_at test",
      description: "Now with description",
      confidence: 0.6,
    });

    const after = kbGet(db, key)!;
    expect(after.updated_at).not.toBeNull();
    expect(after.updated_at).not.toBe(before.updated_at);
  });

  test("changes again on second update", async () => {
    const before = kbGet(db, key)!;
    const beforeUpdated = before.updated_at;

    // datetime('now') has second granularity; wait >1s for a distinct value
    await Bun.sleep(1100);

    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Updated_at test",
      description: "Second update",
      confidence: 0.7,
    });

    const after = kbGet(db, key)!;
    expect(after.updated_at).not.toBeNull();
    expect(after.updated_at).not.toBe(beforeUpdated);
  });
});

// ---------------------------------------------------------------------------
// kbGet — occurrences from store
// ---------------------------------------------------------------------------

describe("kbGet — occurrences array", () => {
  const key = "kbget-occurrences-test";
  const kind = "fix";

  beforeAll(() => {
    db = freshDb();

    // Create entry
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Occurrences test",
    });

    // Insert multiple occurrences
    const occ1 = generateId();
    const occ2 = generateId();
    db.run(
      `INSERT INTO knowledge_occurrences (id, entry_key, kind, project_ref, repo_ref, issue_ref, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [occ1, key, kind, "proj-a", "repo-a", "issue-1", "fixed"],
    );
    db.run(
      `INSERT INTO knowledge_occurrences (id, entry_key, kind, project_ref, repo_ref, issue_ref, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [occ2, key, kind, "proj-b", "repo-b", "issue-2", "observed"],
    );
  });

  test("returns all occurrences", () => {
    const entry = kbGet(db, key)!;
    expect(entry.occurrences.length).toBe(2);
  });

  test("occurrences contain all fields", () => {
    const entry = kbGet(db, key)!;
    const occ = entry.occurrences.find((o) => o.project_ref === "proj-a");
    expect(occ).toBeDefined();
    expect(occ!.repo_ref).toBe("repo-a");
    expect(occ!.issue_ref).toBe("issue-1");
    expect(occ!.outcome).toBe("fixed");
    expect(occ!.id).toBeDefined();
    expect(occ!.entry_key).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// kbAdd — kind default
// ---------------------------------------------------------------------------

describe("kbAdd — kind defaults", () => {
  beforeAll(() => {
    db = freshDb();
  });

  test("kind defaults to 'problem' via the tool layer", () => {
    // The default for kind = "problem" is applied in the tool handler.
    // Here we test that explicit kind is passed through correctly.
    const result = kbAdd(db, {
      entry_key: "explicit-kind-test",
      kind: "convention",
      title: "Explicit kind",
    });
    expect(result.entry.kind).toBe("convention");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: add → get → add higher confidence → get
// ---------------------------------------------------------------------------

describe("kbAdd + kbGet round-trip", () => {
  const key = "kbadd-roundtrip";
  const kind = "summary";

  beforeAll(() => {
    db = freshDb();
  });

  test("full lifecycle: create → verify → update → verify", () => {
    // Create
    const created = kbAdd(db, {
      entry_key: key,
      kind,
      title: "Round-trip entry",
      description: "Initial state",
      tags: "roundtrip",
    });
    expect(created.action).toBe("created");

    // Verify via get
    const afterCreate = kbGet(db, key, kind)!;
    expect(afterCreate.description).toBe("Initial state");
    expect(afterCreate.confidence).toBe(0.0);
    expect(afterCreate.occurrences).toEqual([]);

    // Update with higher confidence
    const updated = kbAdd(db, {
      entry_key: key,
      kind,
      title: "Round-trip entry",
      description: "Updated state",
      tags: "roundtrip,updated",
      confidence: 0.75,
    });
    expect(updated.action).toBe("updated");

    // Verify updated via get
    const afterUpdate = kbGet(db, key, kind)!;
    expect(afterUpdate.description).toBe("Updated state");
    expect(afterUpdate.tags).toBe("roundtrip,updated");
    expect(afterUpdate.confidence).toBe(0.75);
    expect(afterUpdate.updated_at).not.toBeNull();
    expect(afterUpdate.revisions.length).toBeGreaterThanOrEqual(2); // description + tags changed
  });
});

// ---------------------------------------------------------------------------
// kind filtering in kbGet
// ---------------------------------------------------------------------------

describe("kbGet — kind filtering", () => {
  const sharedKey = "shared-key-multiple-kinds";

  beforeAll(() => {
    db = freshDb();

    // Create two entries with same key but different kind
    kbAdd(db, {
      entry_key: sharedKey,
      kind: "problem",
      title: "Problem variant",
      description: "This is a problem",
    });
    kbAdd(db, {
      entry_key: sharedKey,
      kind: "fix",
      title: "Fix variant",
      description: "This is a fix",
    });
  });

  test("returns correct entry when kind is specified", () => {
    const problem = kbGet(db, sharedKey, "problem");
    expect(problem).not.toBeNull();
    expect(problem!.kind).toBe("problem");
    expect(problem!.description).toBe("This is a problem");

    const fix = kbGet(db, sharedKey, "fix");
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe("fix");
    expect(fix!.description).toBe("This is a fix");
  });

  test("returns first matching entry when kind is omitted", () => {
    const first = kbGet(db, sharedKey);
    expect(first).not.toBeNull();
    // Primary key (entry_key, kind) sorts "fix" before "problem"
    expect(first!.kind).toBe("fix");
  });
});

// ---------------------------------------------------------------------------
// kbRecord — Record occurrence outcome
// ---------------------------------------------------------------------------

describe("kbRecord — record occurrence", () => {
  const key = "kbrecord-test";
  const kind = "problem";

  beforeAll(() => {
    db = freshDb();
    // Create entry to record against
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Record test entry",
    });
  });

  test("record fixed outcome returns occurrence with id", () => {
    const occ = kbRecord(db, {
      entry_key: key,
      kind,
      outcome: "fixed",
    });
    expect(occ).toBeDefined();
    expect(occ.id).toBeDefined();
    expect(occ.id.length).toBeGreaterThan(0);
    expect(occ.outcome).toBe("fixed");
  });

  test("record failed outcome creates bad_attempt record", () => {
    const occ = kbRecord(db, {
      entry_key: key,
      kind,
      outcome: "failed",
      observed_symptoms: "Test failure symptom",
    });
    expect(occ.outcome).toBe("failed");
    expect(occ.observed_symptoms).toBe("Test failure symptom");
  });

  test("record on nonexistent entry throws", () => {
    expect(() =>
      kbRecord(db, {
        entry_key: "nonexistent-record-key",
        kind: "problem",
        outcome: "fixed",
      }),
    ).toThrow("entry not found");
  });

  test("occurrence includes entry_key and kind reference", () => {
    const occ = kbRecord(db, {
      entry_key: key,
      kind,
      outcome: "workaround",
    });
    expect(occ.entry_key).toBe(key);
    expect(occ.kind).toBe(kind);
  });

  test("multiple occurrences for same entry", () => {
    const occ1 = kbRecord(db, {
      entry_key: key,
      kind,
      outcome: "observed",
    });
    const occ2 = kbRecord(db, {
      entry_key: key,
      kind,
      outcome: "fixed",
    });
    expect(occ1.id).not.toBe(occ2.id);

    // Verify both exist via kbGet
    const entry = kbGet(db, key, kind)!;
    expect(entry.occurrences.length).toBeGreaterThanOrEqual(5); // 4 above + earlier seeded ones
  });
});

// ---------------------------------------------------------------------------
// kbReview — Review-state lifecycle with REGATE
// ---------------------------------------------------------------------------

describe("kbReview — valid transitions", () => {
  beforeAll(() => {
    db = freshDb();
  });

  test("draft → reviewed is a valid transition", () => {
    kbAdd(db, {
      entry_key: "review-draft-reviewed",
      kind: "problem",
      title: "Draft to reviewed",
    });
    const result = kbReview(db, {
      entry_key: "review-draft-reviewed",
      kind: "problem",
      review_state: "reviewed",
    });
    expect(result.review_state).toBe("reviewed");
  });

  test("reviewed → accepted is a valid transition", () => {
    const key = "review-reviewed-accepted";
    kbAdd(db, {
      entry_key: key,
      kind: "problem",
      title: "Reviewed to accepted",
    });
    kbReview(db, {
      entry_key: key,
      kind: "problem",
      review_state: "reviewed",
    });
    const result = kbReview(db, {
      entry_key: key,
      kind: "problem",
      review_state: "accepted",
    });
    expect(result.review_state).toBe("accepted");
  });
});

describe("kbReview — skip steps (rejected)", () => {
  beforeAll(() => {
    db = freshDb();
  });

  test("draft → accepted is rejected (skip steps)", () => {
    kbAdd(db, {
      entry_key: "review-skip-step",
      kind: "problem",
      title: "Skip step test",
    });
    expect(() =>
      kbReview(db, {
        entry_key: "review-skip-step",
        kind: "problem",
        review_state: "accepted",
      }),
    ).toThrow("Invalid transition: draft → accepted");
  });
});

describe("kbReview — REGATE backward movement blocked", () => {
  beforeAll(() => {
    db = freshDb();
  });

  test("accepted → draft is rejected (REGATE backward)", () => {
    const key = "review-regate-backward";
    kbAdd(db, {
      entry_key: key,
      kind: "problem",
      title: "REGATE backward test",
    });
    kbReview(db, { entry_key: key, kind: "problem", review_state: "reviewed" });
    kbReview(db, { entry_key: key, kind: "problem", review_state: "accepted" });
    expect(() =>
      kbReview(db, {
        entry_key: key,
        kind: "problem",
        review_state: "draft",
      }),
    ).toThrow("Invalid transition: accepted → draft");
  });
});

describe("kbReview — terminal states", () => {
  beforeAll(() => {
    db = freshDb();
  });

  test("rejected cannot transition to anything", () => {
    const key = "review-terminal-rejected";
    kbAdd(db, {
      entry_key: key,
      kind: "problem",
      title: "Terminal rejected test",
    });
    kbReview(db, { entry_key: key, kind: "problem", review_state: "rejected" });
    expect(() =>
      kbReview(db, {
        entry_key: key,
        kind: "problem",
        review_state: "reviewed",
      }),
    ).toThrow("terminal state: rejected");
  });

  test("superseded cannot transition to anything", () => {
    // Manually set superseded state since kbReview doesn't allow it
    const key = "review-terminal-superseded";
    kbAdd(db, {
      entry_key: key,
      kind: "problem",
      title: "Terminal superseded test",
    });
    db.run(
      "UPDATE knowledge_entries SET review_state = 'superseded' WHERE entry_key = ? AND kind = ?",
      [key, "problem"],
    );
    expect(() =>
      kbReview(db, {
        entry_key: key,
        kind: "problem",
        review_state: "draft",
      }),
    ).toThrow("terminal state: superseded");
  });
});

describe("kbReview — terminal override", () => {
  beforeAll(() => {
    db = freshDb();
  });

  test("accepted → rejected is allowed (terminal override)", () => {
    const key = "review-terminal-override";
    kbAdd(db, {
      entry_key: key,
      kind: "problem",
      title: "Terminal override test",
    });
    kbReview(db, { entry_key: key, kind: "problem", review_state: "reviewed" });
    kbReview(db, { entry_key: key, kind: "problem", review_state: "accepted" });
    const result = kbReview(db, {
      entry_key: key,
      kind: "problem",
      review_state: "rejected",
    });
    expect(result.review_state).toBe("rejected");
  });
});

describe("kbReview — revision tracking", () => {
  const key = "review-revision-test";
  const kind = "pattern";

  beforeAll(() => {
    db = freshDb();
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Review revision test",
    });
  });

  test("review records revision for review_state change", () => {
    kbReview(db, { entry_key: key, kind, review_state: "reviewed" });
    const entry = kbGet(db, key, kind)!;
    const stateRev = entry.revisions.find(
      (r) => r.field_name === "review_state",
    );
    expect(stateRev).toBeDefined();
    expect(stateRev!.old_value).toBe("draft");
    expect(stateRev!.new_value).toBe("reviewed");
  });
});

describe("kbReview — confidence update", () => {
  const key = "review-confidence-test";
  const kind = "decision";

  beforeAll(() => {
    db = freshDb();
    kbAdd(db, {
      entry_key: key,
      kind,
      title: "Review confidence test",
    });
  });

  test("confidence update during review", () => {
    const result = kbReview(db, {
      entry_key: key,
      kind,
      review_state: "reviewed",
      confidence: 0.85,
    });
    expect(result.confidence).toBe(0.85);
  });

  test("revision records confidence_at_time", () => {
    const entry = kbGet(db, key, kind)!;
    const stateRev = entry.revisions.find(
      (r) => r.field_name === "review_state",
    );
    expect(stateRev).toBeDefined();
    expect(stateRev!.confidence_at_time).toBe(0.85);
  });
});
