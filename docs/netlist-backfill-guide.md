# Netlist Delayed Backfill Mechanism — Functional Guide and Validation

## Overview

The extension uses a **non-blocking netlist flow** with delayed backfill to avoid blocking the UI when netlist generation is slow.

## How It Works

### 1) Main flow (non-blocking)

```text
start netlist collection
  ↓
wait 10 seconds
  ↓
timeout?
├─ yes -> continue using L2/L3/L4 and skip immediate L1
└─ no  -> use netlist directly with L1
```

### 2) Background flow (delayed backfill)

```text
netlist generation continues in background
  ↓
poll every 2 seconds (max 60 seconds)
  ↓
netlist completed?
├─ yes -> reparse -> backfill -> update cache -> notify IFrame
└─ no  -> stop backfill
```

## Core features

### 1) Non-blocking behavior
- Main flow continues after 10 seconds, no hard UI block.
- Users can begin chat immediately.

### 2) Automatic backfill
- If netlist eventually succeeds, low-confidence bindings are improved with L1.
- L1 (confidence `1.0`) can replace L2/L3/L4 results when better data arrives.

### 3) Epoch-based versioning
- Each collection creates an epoch number.
- Newer collects invalidate older in-flight backfills.

### 4) Observability
- Actual netlist fetch time is logged.
- Backfill metrics are logged (new bindings, improved bindings).
- All events are shown in debug logs.

## Implementation

### Key files

1. `src/review/collector.ts`
   - `collectNetlist()` with timeout handling
   - `backgroundNetlistState` for deferred workflow
   - `parseNetlist()` now exported for reuse

2. `src/review/orchestrator.ts`
   - `scheduleNetlistBackfill()` scheduler
   - uses `eda.sys_Timer.setIntervalTimer()` polling

### Core structure

```typescript
interface BackgroundNetlistState {
  promise: Promise<string | undefined>;
  startTime: number;
  completed: boolean;
  result?: string;
  duration?: number;
}
```

## Validation scenarios

### Scenario 1 — netlist completes quickly (< 10s)

Expected:
1. Netlist completes before timeout.
2. Main flow uses L1 directly.
3. No delayed backfill occurs.

How to test:
1. Open a small schematic (< 50 components).
2. Open AI assistant panel.
3. Open debug log (`Ctrl+D` or 🐛).
4. Verify log output.

Expected log sample:
```text
[INFO] Netlist format: Protel2, size: xxx chars (xxxms)
[INFO] Netlist parsed: xxx pin-net mappings
```

### Scenario 2 — timeout then success (10-60s)

Expected:
1. Timeout at 10s.
2. Main flow continues with L2/L3/L4.
3. Netlist keeps fetching in background.
4. On success, automatic backfill updates pin bindings.

How to test:
1. Open a large schematic (> 200 components).
2. Open panel and logs.
3. Wait and inspect output.

Expected logs:
```text
[WARN] Netlist fetch timeout (10000ms), continue without direct netlist binding
[INFO] Netlist fetching in background...
[INFO] Collect complete (xxxms)
... wait ...
[SUCCESS] Background netlist fetch succeeded (xxxms, xxx chars)
[INFO] Starting backfill with completed netlist...
[SUCCESS] Backfill complete: new bound pins xxx, improved pins xxx
```

### Scenario 3 — timeout and failure (> 60s)

Expected:
1. Timeout at 10s, no immediate L1.
2. Main flow uses fallback strategies.
3. Background fetch times out after 60s and gives up.

Expected:
```text
[WARN] Netlist timeout (60s) exceeded, skipping backfill
```

or

```text
[ERROR] Background netlist failed: ...
[WARN] Failed to backfill due to fetch error
```

### Scenario 4 — retrigger with epoch control

Expected:
1. First collect starts and hits timeout.
2. User triggers second collect before first finishes.
3. First backfill should be dropped as stale.

Expected log:
```text
[INFO] Background collect started (reason: start-ai-chat, epoch: 1)
[WARN] Netlist timeout (10000ms)...
[INFO] Collect complete...
... user restarts panel ...
[INFO] Background collect started (reason: start-ai-chat, epoch: 2)
[WARN] Backfill task canceled: epoch 1 expired
```

## Performance and impact

### Measured netlist fetch time

| Size | Components | Pins | Netlist fetch |
|------|------------|------|---------------|
| Small | < 50 | < 200 | 1-3s |
| Medium | 50-200 | 200-1000 | 5-15s |
| Large | > 200 | > 1000 | 15-60s |

### Backfill effects
- New bindings: previously `netName = null` now resolved.
- Improved bindings: L2/L3/L4 updated to L1 where appropriate.

## Troubleshooting

### Symptom: Netlist always times out
Possible causes:
- Schema too large ( > 500 components).
- EDA environment performance issue.

Fix:
- Increase `NETLIST_TIMEOUT_MS`.
- Increase `MAX_POLL_COUNT`.

### Symptom: No backfill effect
Possible causes:
- Parse failure.
- Backfill task already expired.

Check:
1. Look for `Netlist parsed` success log.
2. Look for `epoch expired` warning.
3. Validate `netlistMap.size` is non-zero.

### Symptom: No pin count change after backfill
Possible causes:
- Pins already bound with lower-tier strategies.
- Netlist format mismatch.

Check:
1. Verify "new bindings x, improved x" values.
2. If both are zero, no new signal was provided.
3. Ensure netlist format is PROTEL2.

## Future improvements

### 1) Adaptive timeout
- Adjust timeout by schematic size (small 5s, large 20s).

### 2) Incremental backfill
- Only backfill `netName = null` pins.
- Avoid overriding high-confidence existing bindings.

### 3) Netlist cache
- Cache parsed netlists to avoid re-parsing.

### 4) Progress UX
- Add in-IFrame progress: `Netlist in progress... (waited 15s)`.

## Related files

- `src/review/collector.ts`
- `src/review/orchestrator.ts`
- `src/review/types.ts`
- `docs/debug-questions.md`
- `verify-build.sh`

## Commit history

```text
9b2ea08 feat: implement delayed netlist backfill
8de0ab5 feat: implement L4 wire topology strategy
536e27a debug: add detailed pin-net logs
1560802 feat: add net-label collection to fix pin-net binding
4413367 fix: fix cross-page pin-id regression and timeout guard
```
