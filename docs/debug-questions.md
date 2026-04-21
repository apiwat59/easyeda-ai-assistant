# Debug Checklist

## ✅ Resolved Items

### 1. Netlist timeout
**Issue**: Netlist generation timing out at 10 seconds caused many pins to remain unbound.

**Fix**: Implemented delayed netlist backfill.
- Main flow continues after timeout and falls back to L2/L3/L4 strategies.
- Netlist collection continues in background and is merged automatically when complete.
- See `/home/ubuntu/netlist-backfill-guide.md`.

**Commit**: `9b2ea08 feat: implement delayed netlist backfill`

### 2. Wire topology analysis
**Issue**: Wire `net` field was empty, so L2 strategy could not bind pins.

**Fix**: Added L4 wire-topology strategy.
- Build wire topology graph and infer connectivity.
- Match pin coordinates to wire endpoints.

**Commit**: `8de0ab5 feat: implement L4 wire topology analysis strategy`

### 3. Net labels not collected
**Issue**: Labels like `GND` and `VCC` were not collected, so L3 strategy did not work.

**Fix**: Added net label collection.
- Collect `NetFlag` and `NetPort` primitives.
- Match labels to pins by coordinate proximity.

**Commit**: `1560802 feat: add net-label collection to fix pin-net binding`

### 4. Debug logs
**Issue**: Pin-net binding path was hard to trace during diagnostics.

**Fix**: Added verbose pin-net binding logs.
- Log each strategy attempted per pin (`L1/L2/L3/L4`).
- Log final net name and confidence.

**Commit**: `536e27a debug: add detailed pin-net binding logs`

### 5. Multi-page collection
**Issue**: Pin IDs became invalid when switching schematic pages, causing missed pin collection.

**Fix**: Switched to fully page-by-page collection.
- Collect components, pins, and wires per page.
- Tag every item with `schematicPageUuid`.

**Commit**: `4413367 fix: resolve multi-page pin ID regression and add netlist timeout guard`

---

## Key Info to Confirm

### 1. Is wire `net` field empty?

In EDA:
1. Select a wire connecting a chip pin and resistor.
2. Open its property panel.
3. Confirm whether `Net` / `Network` exists and its value.

### 2. Actual wire collection quality

Add these counts in debug logs:
- Total wires collected.
- How many wires have empty `net` value.
- How many wires were dropped.

### 3. Net-label placement

Confirm:
- Is `GND` label attached directly to component pins, or linked by wire?
- Is `GND` attached directly to resistor pins, or linked by wire?
- If linked by wire, approximate wire length (for tolerance validation).

### 4. Schematic network analysis state

Confirm:
- Any "unconnected" or "network error" warnings present.
- Whether manual actions are required (e.g. `refresh network` or `reanalyze`).

## Candidate Approaches

### Option A: Improve wire collection logic
Keep wires with empty `net` instead of dropping them. Assign temporary names (for example, `WIRE_001`) and merge connected wires by topology.

### Option B: Add L4 wire topology strategy
Build a topology graph from wire endpoints and infer connectivity between pins.

### Option C: Increase L3 tolerance
Increase net-label matching tolerance from `50` to `100+`.

### Option D: Add deeper debug logs
Emit detailed binding details during collection:
- Tried strategies (`L1/L2/L3`).
- Match outcome per strategy.
- Final net name and confidence score.
