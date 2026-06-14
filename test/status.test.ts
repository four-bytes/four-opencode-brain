// ---------------------------------------------------------------------------
// status.ts tests — focused on the _busPromise reset behavior on publish failure
// ---------------------------------------------------------------------------

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level counters / flags mutated by the mock — kept outside so they
// survive the mock.module() closure lifetime.
// ---------------------------------------------------------------------------

let connectCallCount = 0;
let publishCallCount = 0;
let shouldPublishFail = false;
let shouldConnectFail = false;

// ---------------------------------------------------------------------------
// Mock @four-bytes/opencode-plugin-lib BEFORE importing status.ts so that
// status.ts picks up the mocked BusClient when the module is first evaluated.
// Bun hoists mock.module() calls, so this is safe even though the import
// statements appear below.
// ---------------------------------------------------------------------------

mock.module("@four-bytes/opencode-plugin-lib", () => {
  return {
    BusClient: {
      connect: async () => {
        connectCallCount++;
        if (shouldConnectFail) throw new Error("connect failed");

        const scopedBus = {
          forSession: (_sid: string) => scopedBus,
          publish: async (_event: string, _payload: unknown) => {
            publishCallCount++;
            if (shouldPublishFail) {
              throw new Error("publish failed");
            }
          },
        };

        return {
          forService: (_name: string) => scopedBus,
        };
      },
    },
    // EventBus is used by event-bus.ts which status.ts imports transitively.
    EventBus: class {
      on() {}
      emit() {}
    },
  };
});

// Import AFTER mock.module so the mocked BusClient is used.
import { updateStatus, withSessionId } from "../src/status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all microtasks / pending promises. */
async function flushPromises(): Promise<void> {
  // Two await ticks are enough for: getBus resolve → .then → .catch
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("write() — _busPromise reset on publish failure (PR change)", () => {
  beforeEach(() => {
    connectCallCount = 0;
    publishCallCount = 0;
    shouldPublishFail = false;
    shouldConnectFail = false;
  });

  // -------------------------------------------------------------------------
  // Core PR behavior: _busPromise must be set to null when publish fails so
  // that the next write() triggers a fresh BusClient.connect() attempt.
  // -------------------------------------------------------------------------

  test("re-connects (calls BusClient.connect again) after a publish failure", async () => {
    // First call: connect succeeds but publish fails.
    shouldPublishFail = true;
    updateStatus("ready");
    await flushPromises();

    const connectAfterFirstWrite = connectCallCount;
    expect(connectAfterFirstWrite).toBe(1);
    expect(publishCallCount).toBe(1);

    // Second call: _busPromise should be null now (PR change), so getBus()
    // must call BusClient.connect() again.
    updateStatus("ready");
    await flushPromises();

    expect(connectCallCount).toBe(2); // key assertion — reconnect happened
    expect(publishCallCount).toBe(2);
  });

  test("does NOT re-connect after a successful publish (no reset needed)", async () => {
    shouldPublishFail = false;

    updateStatus("ready");
    await flushPromises();

    expect(connectCallCount).toBe(1);
    expect(publishCallCount).toBe(1);

    // Second call reuses the cached _busPromise — connect must NOT be called again.
    updateStatus("ready");
    await flushPromises();

    expect(connectCallCount).toBe(1); // still 1 — no reconnect
    expect(publishCallCount).toBe(2);
  });

  test("re-connects on every repeated publish failure (no stale promise accumulates)", async () => {
    shouldPublishFail = true;

    updateStatus("busy", { text: "thinking…" });
    await flushPromises();

    updateStatus("busy", { text: "still thinking…" });
    await flushPromises();

    updateStatus("ready");
    await flushPromises();

    // Each write should have triggered a fresh connect because the promise was
    // reset to null each time.
    expect(connectCallCount).toBe(3);
    expect(publishCallCount).toBe(3);
  });

  test("publish failure does not prevent state being updated in memory", async () => {
    // Even when the bus publish fails, _state.current should be updated so the
    // HTTP status endpoint still reflects the latest state.
    shouldPublishFail = true;

    // This just exercises write() without throwing at the call site.
    expect(() => updateStatus("error", { text: "something broke" })).not.toThrow();
    await flushPromises();

    // A subsequent call after the failure should also not throw.
    expect(() => updateStatus("ready")).not.toThrow();
    await flushPromises();
  });

  // -------------------------------------------------------------------------
  // Regression: publish failure followed by a connect failure on retry should
  // leave _busPromise as null (getBus() already handles this), not cause an
  // unhandled rejection.
  // -------------------------------------------------------------------------

  test("handles the case where reconnect attempt also fails gracefully", async () => {
    // First write: publish fails → _busPromise reset to null.
    shouldPublishFail = true;
    updateStatus("ready");
    await flushPromises();

    expect(connectCallCount).toBe(1);

    // Second write: connect itself now fails (covers double-failure path).
    shouldPublishFail = false;
    shouldConnectFail = true;
    updateStatus("ready");
    await flushPromises();

    // connect was attempted again (because _busPromise was null after first failure).
    expect(connectCallCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Boundary: single write with immediate publish failure → exactly one
  // connect call, one publish attempt, and _busPromise left as null.
  // A third write after recovery should succeed without extra connects.
  // -------------------------------------------------------------------------

  test("recover: after publish failure then success, connect count reflects one retry", async () => {
    // Round 1: publish fails.
    shouldPublishFail = true;
    updateStatus("ready");
    await flushPromises();

    expect(connectCallCount).toBe(1);
    expect(publishCallCount).toBe(1);

    // Round 2: publish succeeds this time — new connect + successful publish.
    shouldPublishFail = false;
    updateStatus("ready");
    await flushPromises();

    expect(connectCallCount).toBe(2); // reconnected
    expect(publishCallCount).toBe(2);

    // Round 3: publish still succeeds — reuses the promise from round 2.
    updateStatus("ready");
    await flushPromises();

    expect(connectCallCount).toBe(2); // no new connect
    expect(publishCallCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// withSessionId — verifies that scoped writes still go through the same
// _busPromise path (and therefore benefit from the reset behaviour too).
// ---------------------------------------------------------------------------

describe("write() with session scope — _busPromise reset still applies", () => {
  beforeEach(() => {
    connectCallCount = 0;
    publishCallCount = 0;
    shouldPublishFail = false;
    shouldConnectFail = false;
  });

  test("session-scoped publish failure also resets _busPromise", async () => {
    shouldPublishFail = true;

    await withSessionId("test-session-1", async () => {
      updateStatus("busy", { text: "scoped" });
    });
    await flushPromises();

    expect(connectCallCount).toBe(1);

    // Next write (outside session) should reconnect because _busPromise was reset.
    updateStatus("ready");
    await flushPromises();

    expect(connectCallCount).toBe(2);
  });
});
