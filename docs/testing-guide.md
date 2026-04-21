# Netlist Delayed Backfill — Testing Guide

## Goal

Validate delayed netlist backfill behavior for:
1. timeout handling,
2. background collection,
3. automatic backfill,
4. epoch cancellation,
5. debug log completeness.

## Setup

### 1) Build extension
```bash
cd /home/ubuntu/pro-api-sdk-master
npm run build
```

### 2) Reload extension in EDA
1. Open EasyEDA Pro.
2. Open Extension Manager.
3. Find `AI Schematic Assistant`.
4. Disable and re-enable.
5. Wait ~2 seconds.

### 3) Prepare schematics
- Small: `< 50` components (`< 3s` netlist).
- Medium: `50-200` components (`5-15s` netlist).
- Large: `> 200` components (`> 10s`, timeout expected).

## Test scenarios

### Scenario 1 — netlist completes before timeout

Goal: verify normal flow when netlist is quick.

Steps:
1. Open a small schematic.
2. Open `AI Review -> AI Schematic Chat...`.
3. Open debug logs (`Ctrl+D` / 🐛).
4. Check output.

Expected logs:
```text
[INFO] Background collect started (reason: start-ai-chat, epoch: 1)
[INFO] Netlist format: Protel2, size: xxx chars (xxxms)
[INFO] Netlist parsed: xxx pin-net mappings
[SUCCESS] Collect complete (xxxms)
```

Checks:
- No `netlist timeout` warning.
- No `background netlist fetching` message.
- Netlist time `< 10s`.
- Pin binding count is within expected.

---

### Scenario 2 — timeout then success

Goal: verify delayed backfill path.

Steps:
1. Open a large schematic.
2. Open chat and logs.
3. Wait 30-60 seconds for background behavior.

Expected logs:
```text
[INFO] Background collect started (reason: start-ai-chat, epoch: 1)
[WARN] Netlist fetch timeout (10000ms), continuing without direct netlist binding
[INFO] Netlist in background...
[SUCCESS] Collect complete (xxxms)
[INFO] Data summary: components xxx, pins xxx, nets xxx
... wait 10-50s ...
[SUCCESS] Background netlist fetch succeeded (xxxms, xxx chars)
[INFO] Starting backfill...
[SUCCESS] Backfill complete: new xxx, improved xxx
```

Checks:
- Timeout warning exists.
- Background fetching starts.
- Main flow completes without waiting.
- Backfill logs appear.
- New/improved bindings are positive.

---

### Scenario 3 — timeout and failure

Goal: verify graceful degradation.

Steps:
1. Open very large schematic (`> 500` components).
2. Open chat and logs.
3. Wait 60+ seconds.

Expected:
```text
[WARN] Netlist background fetch timeout (60s), backfill skipped
```

or:

```text
[ERROR] Background netlist fetch failed (...): [error]
[WARN] Backfill not performed (fetch error)
```

Checks:
- Timeout warning exists.
- Main flow completes.
- Failure or timeout message appears after ~60s.
- Binding confidence stays < 1.0 when backfill did not succeed.

---

### Scenario 4 — epoch cancellation

Goal: confirm stale task cancellation.

Steps:
1. Open large schematic.
2. Open chat and note epoch.
3. Wait 5 seconds.
4. Close panel, reopen it again.
5. Compare logs.

Expected:
```text
[INFO] Background collect started (reason: start-ai-chat, epoch: 1)
...
[INFO] Background collect started (reason: start-ai-chat, epoch: 2)
...
[WARN] Backfill task canceled (epoch 1 expired)
```

Checks:
- First collect is `epoch: 1`, second is `epoch: 2`.
- First backfill is canceled.
- Second backfill runs.

---

### Scenario 5 — auto-start (plugin initialization)

Goal: ensure background collect runs without opening chat.

Steps:
1. Close and reopen EDA.
2. Open a schematic.
3. Wait 5-10 seconds without opening chat.
4. Open chat and check logs.

Expected:
```text
[INFO] Background collect started (reason: doc-change:xxx-uuid, epoch: 1)
[SUCCESS] Collect complete (xxxms)
```

Checks:
- Auto collect log exists.
- Data is ready before chat open.

---

### Scenario 6 — document switch re-collect

Goal: verify document-change detection.

Steps:
1. Open schematic A and panel.
2. Wait for initial collect.
3. Switch to schematic B (keep panel open).
4. Wait 5-10 seconds.
5. Check logs.

Expected:
```text
[INFO] Background collect started (reason: start-ai-chat, epoch: 1)
...
[INFO] Background collect started (reason: doc-change:yyy-uuid, epoch: 2)
```

Checks:
- Collect triggers on document switch.
- Epoch increments from 1 to 2.
- Sidebar values update.

## Performance baseline

Record for each scenario:

| Metric | Small | Medium | Large |
|--------|-------|--------|-------|
| Components | | | |
| Pins | | | |
| Nets | | | |
| Total collect time | | | |
| Netlist time | | | |
| Timeout? | | | |
| Backfill time | | | |
| New bindings | | | |
| Improved bindings | | | |

Targets:
- Small: total < 5s, netlist < 3s.
- Medium: total < 15s, netlist < 15s.
- Large: total < 30s, netlist < 60s.

## Troubleshooting

### Missing timeout logs
- Schematic too small (netlist done under 10s), or direct exception before timeout.
- Use larger schematic and check error logs.

### Missing backfill success
- Netlist not parseable.
- Epoch expired.
- Backfill logic issue.

### No binding change after backfill
- Pins already bound by fallback strategies.
- Netlist format mismatch.

### Auto-start not working
- `activate()` not called.
- Timer not set.
- Document UUID detection failing.

For each case, verify debug logs and EDA console, restart plugin if needed.

## Test report template

```markdown
# Netlist Delayed Backfill — Test Report

## Environment
- EDA version:
- Extension version:
- Test date:
- Tester:

## Results
- Scenario 1: [ ] Pass [ ] Fail
- Scenario 2: [ ] Pass [ ] Fail
- Scenario 3: [ ] Pass [ ] Fail
- Scenario 4: [ ] Pass [ ] Fail
- Scenario 5: [ ] Pass [ ] Fail
- Scenario 6: [ ] Pass [ ] Fail

## Notes
1.
2.
3.

## Overall status
- [ ] Fully working
- [ ] Mostly working with minor issues
- [ ] Fails major requirements

## Signature
Tester: __________
Date: __________
```

## Next action

If all scenarios pass, proceed to next milestone.
