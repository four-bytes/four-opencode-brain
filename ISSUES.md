**Status:** Last reviewed 2026-06-14. 2/2 fixed (brain), 3/3 fixed (plugin-lib), 2/2 fixed (local-bus), 2/2 fixed (context-curator).

# Known Issues

## #1 — Bus reconnect never triggered after initial connection

**Symptom:** Once brain's `_busPromise` resolves successfully, a subsequent bus death (idle
shutdown, crash) causes all `write()` calls to fail silently. No reconnect is ever attempted
for the lifetime of the plugin process. The TUI stops receiving status updates; the bus
never restarts from the brain side.

**Root cause:** `getBus()` in `status.ts` caches `_busPromise` and only nulls it on
`BusClient.connect()` rejection. `BusClient.connect()` never rejects (falls back to
`MemoryBusClient`), so `_busPromise` is never null after the first call.

When the bus dies post-connect, `write()` swallows the publish error in `.catch()` but does
NOT reset `_busPromise`. Every subsequent `write()` calls the same dead `BusClient`.

**Location:** `src/status.ts` — `write()` (line ~139) and `getBus()` (line ~75).

**Fix:** Reset `_busPromise = null` when a publish fails, so the next `write()` triggers
`BusClient.connect()` which re-discovers the new bus (or spawns one):

```typescript
getBus()
  .then(async (bus) => {
    const scoped = bus.forService("brain");
    const target = sid ? scoped.forSession(sid) : scoped;
    await target.publish("status", payload);
  })
  .catch((err) => {
    console.warn("[brain] Bus publish failed:", (err as Error).message);
    _busPromise = null; // reset — next write() will reconnect
  });
```

**Dependency:** This fix is only fully effective once `@four-bytes/opencode-plugin-lib` has
the spawn lock (plugin-lib ISSUES #2) to prevent simultaneous re-spawn races.

---

✅ FIXED — commit cb15dc8 (reset `_busPromise = null` in write catch)

## #2 — ALS-based session scoping is a footgun (future work)

`withSessionId` / `AsyncLocalStorage` wraps every tool execute to scope status publishes to
the right channel. This is fragile: any await that crosses an async boundary without the ALS
context will silently publish to the wrong (or no) session channel.

The ROADMAP (Wave 2, Task 2.3) replaces this with an explicit `createSessionStatus(sessionId)`
that holds a `SessionPublisher`. No ALS needed; session ID is passed explicitly at call sites.

⚠️ ROADMAP Wave 2 — not yet fixed.
