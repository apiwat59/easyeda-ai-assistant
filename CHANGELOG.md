# Changelog

This document records all important changes to EasyEDA AI Assistant.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [1.4.0] - 2026-03-07

### Added

- Added **MCP data exposure (eda-mcp-server)** - a brand-new standalone Node.js MCP Server that lets external AI tools (Cursor, Claude Code, Codex, etc.) access schematic data in read-only mode through the MCP protocol
  - **Architecture**: EDA extension (WebSocket) -> eda-mcp-server (Node.js) -> stdio -> AI tools
  - **9 Resources**: `eda://schematic/status`, `summary`, `components`, `pins`, `nets`, `drc`, `project-info`, `netlist`, `compact`
  - **14 Tools**:
    - `schematic_status` - connection status and data version overview
    - `query_component` - query a single component and its related pins and nets
    - `query_net` - query a single net and its connected pins and components (case-insensitive fallback supported)
    - `search_schematic` - keyword search (across component names, net names, and pin names)
    - `configure_bridge` - dynamically change the WS listening address at runtime (no restart/rebuild required)
    - `get_bom` - generate a BOM list (deduplicated keys, natural sorting of reference designators)
    - `find_unconnected_pins` - find floating/unconnected pins in the schematic (component filter optional)
    - `analyze_power_nets` - automatically identify and analyze power net topology
    - `check_drc` - get a summary of DRC results
    - `refresh_data` - request the extension to push the latest snapshot again
    - `trace_connectivity` - find the electrical connection path between two components (direct/indirect connections)
    - `list_components_by_type` - group and count by component type (resistor/capacitor/IC, etc.)
    - `get_netlist_raw` - retrieve the raw netlist text
    - `get_pin_map` - retrieve the component pin mapping table (natural sorting)
  - **WebSocket Bridge**: receives schematic snapshots pushed by the EDA extension, with heartbeat keepalive, single-process incremental version management, and conditional version baseline reset

- Added **MCP Bridge (extension-side WS client)** - new `mcp-bridge.ts` module
  - Connects to the local eda-mcp-server through `eda.sys_WebSocket`
  - Automatically pushes a full snapshot after data collection completes (`CollectedData`)
  - Automatic reconnection, heartbeat keepalive, and multi-instance anti-duplication (`globalThis` pattern)
  - Permission errors are detected automatically and reconnecting is stopped to avoid infinite loops

- Added **remote connection support** - server-side `--host` parameter can bind to any network interface
  - Default `127.0.0.1` (local only), configurable as `0.0.0.0` (allow remote connections)
  - Use case: EDA runs on a machine without an IP, server runs on a machine with an IP

- Added **dynamic AI configuration** - the `configure_bridge` tool lets AI change the WS listening address at runtime
  - Users only need to tell the AI "my EDA has started on xxx", and the AI can adjust the configuration automatically
  - If startup fails, it automatically rolls back to the old configuration and resumes listening

- Added **MCP Bridge URL configuration** - the configuration panel now includes a WS bridge address input field (default `ws://127.0.0.1:3100`)

### Technical Improvements

- New standalone project `packages/eda-mcp-server/` (TypeScript + tsup bundling, supports direct startup with `npx eda-mcp-server`)
- `restart()` now tries to recover the old listening address on failure, preventing the bridge from getting stuck
- CLI `--port` parameter validation is strict (numeric only, range 1-65535)
- `SnapshotStore.update()` falls back to payload when `projectUuid` is empty
- BOM reference designators are sorted naturally (`R2` < `R10`)
- `trace_connectivity` prebuilds indexes to avoid O(P^2) complexity
- `analyze_power_nets` expands power net regex coverage (VCC/VDD/VBUS/VBAT/V3V3 and 30+ patterns)

---

## [1.3.2] - 2026-03-07

### Fixed Issues

- Fixed the Thinking Block collapse/expand button becoming ineffective after a specific sequence of operations - user stops AI reply -> refresh schematic -> continue asking -> after the AI reply completes, clicking the thinking-process collapse button has no effect
  - Root cause: the expanded state existed only in the DOM className (purely transient state), and it was lost after `renderMessages()` fully rebuilt the DOM (`innerHTML = ''`); meanwhile, the `StreamManager` RAF callback could find the new DOM via `getElementById` after the rebuild and overwrite className
  - Solution: move the expanded state into the data layer as `block.uiExpanded`, have `createThinkingBlockElement` decide the initial class from data, and sync the click handler back to the data layer
  - Added `StreamManager.reset()` to clear `pendingUpdates` and call `cancelAnimationFrame`, and call it at the start of `renderMessages()` to prevent old RAF callbacks from overwriting the new DOM
  - All thinking/text block className operations were changed from string `replace/indexOf/+=` to the `classList` API (`add/remove/contains`), eliminating boundary-condition risks
  - `createThinkingBlockElement` renders content with `parseMarkdown` in non-streaming mode (consistent with `StreamManager.applyUpdates`)
  - `createTextBlockElement` adds a `[generation stopped]` marker directly in paused state

### Removed

- Removed the maximize button - removed the title-bar maximize button (buggy), kept the minimize button

---

## [1.3.1] - 2026-03-06

### Fixed Issues

- Fixed the triple-processing problem caused by multiple orchestrator module instances (critical fix) - the EDA platform loaded `orchestrator.ts` three times (three independent instances), each instance registered its own MessageBus subscription, causing every user message to trigger `handleUserMessage` three times and produce three parallel AI requests and three independent responses
  - Root cause: module-level variables (`requestGuard`, `listenerEpoch`, `chatSessions`, and 8 others) were not shared across instances, so each instance independently owned its own deduplication set and version number, making each instance's epoch validation effectively hypothetical
  - Solution: use the same `globalThis` pattern as `collectionLock` (63615c8), add the `OrchestratorState` interface and `getOrchestratorState()` lazy initializer, and consolidate all key state into `globalThis.__aiSchReview_orchestratorState`
  - Result: the three instances share the same `listenerEpoch`, so only the last registered subscription passes epoch validation; `requestGuard` is shared globally, and duplicate `requestId`s are correctly blocked

### Technical Improvements

- Added the `OrchestratorState` interface, defining 11 shared state fields across instances
- Added `getOrchestratorState()` lazy initialization function (same pattern as `getGlobalCollectionLock()`)
- Extended the `declare global` block with the `__aiSchReview_orchestratorState` global variable declaration
- Updated module top-level code to use `const state = getOrchestratorState()` for shared references, touching 60+ references

---

## [1.3.0] - 2026-03-05

### Added

- Added **DRC result collection** - automatically runs DRC checks via `eda.sch_Drc.check` and passes violation information to AI for analysis
- Added **project metadata collection** - collects project name, description, and other metadata via `eda.dmt_Project.getCurrentProjectInfo`
- Added **shape primitive collection** - supports collecting arc, circle, polygon, rect, and other shape primitives
- Added **independent pin primitive collection** - collects standalone pin information from the schematic via `eda.sch_PrimitivePin.getAll`
- Added **SCH-REVIEW-COMPACT v2 serialization format** - a new data serialization format, backward compatible with v1
- Added **configuration panel enhancement** - two new checkbox groups for "Shape Primitives" and "Enhanced Data"

### Design Notes

- All new fields are disabled by default and do not increase default token usage
- All 7 collection functions have complete try-catch degradation and do not block the main flow
- DRC/ProjectInfo is collected in parallel with the netlist (global data, not dependent on page switching)
- Shape primitives are executed in parallel with existing collection during page iteration

---

## [1.2.6] - 2026-02-28

### Improved

- Added **collapsible configuration groups** - configuration items are divided into four collapsible groups: "Basic Settings", "MCP Gateway", "Schematic Fields", and "Advanced Settings". Only Basic Settings are expanded by default to reduce visual noise
- Added **scrollable configuration panel** - when modal content exceeds the window height, a scrollbar appears automatically instead of overflowing the window
- Added **custom system prompt** - supports adding a custom system prompt in the configuration to personalize AI reply style (up to 5000 characters)

### Technical Improvements

- The modal uses a flex layout plus `max-height: 80vh` constraints to adapt to different window sizes
- Collapsible groups use semantic `<button>` elements and support `aria-expanded` accessibility attributes
- Added `.modal-body`, `.config-section`, and other CSS components for a clearer, maintainable structure

---

## [1.2.5] - 2026-02-23

### Fixed Issues

- Fixed AI being unable to perceive data changes after schematic refresh (critical fix) - during a conversation, after modifying the schematic and clicking refresh, the AI still replied based on the old analysis conclusions
  - Root cause: the history retained previous analysis conclusions based on old data, so the AI tended to trust what it had said before
  - Solution: when refreshing, inject user+assistant notification pairs containing a data summary into history to inform the AI that the data has changed, and add a "real-time data principle" instruction to the system prompt
- Fixed duplicate AI responses - after reopening the plugin, the AI produced two complete replies to the same message
  - Root cause: `emitCompleteBlocks` was being called inside `makeRequest`/`parseSSEResponse`, and intermediate tool-call rounds could also trigger it
  - Solution: move `emitCompleteBlocks` into the `while` loop of `sendMessage`, so it only fires on the final text response
- Fixed duplicate MCP tool prompt panels - sending messages in sequence caused multiple "tool call in progress..." prompt boxes
  - Root cause: `ToolOrchestrator` was cached by sessionId, but requestId was fixed at creation time, so new message tool events reused the old requestId
  - Solution: add `updateRequestContext()` to update the requestId on reuse
- Fixed `handleUserMessage` being called twice after plugin reopen - after closing and reopening the plugin, a user message was processed twice
  - Root cause: EDA MessageBus `cancel()` could not cancel already queued but not-yet-executed old callbacks
  - Solution: introduce a `listenerEpoch` versioning mechanism so callbacks from old subscriptions are automatically discarded at execution time
- Fixed generation being interrupted by notification messages - after refresh, clicking regenerate removed only notification messages, not the real user Q&A
  - Root cause: `clear()` treated injected notification messages as ordinary user messages
  - Solution: have `clear()` skip complete data-update notification pairs when searching for rollback boundaries

### Technical Improvements

- **System Prompt modularization** - extracted `buildChatSystemPrompt` from `chat-adapter.ts` into a standalone `prompt-builder.ts`
- **Unified event dispatch control** - `emitCompleteBlocks` is now controlled through `sendMessage`; `callOpenAICompatibleChat`, `makeRequest`, and `parseSSEResponse` no longer trigger UI events directly
- **Epoch guard coverage** - version validation now covers all key MessageBus subscriptions: USER_MESSAGE, ABORT_REQUEST, REGENERATE_REQUEST, CLEAR_SESSION, LOCATE, restore-session
- **Deduplication cleanup sync** - `clearAllChatSessions()` now clears `processingRequests` and `completedRequests` together to avoid stale request IDs
- **Full debug log coverage** - all modified points now emit structured debug logs to the UI debug panel

---

## [1.1.2] - 2026-02-20

### Fixed Issues

- Fixed Markdown library load failure (critical fix) - incorrect CDN paths for marked.js and highlight.js caused library loading to fail, so all Markdown syntax (including tables) could not render
  - Root cause: the CDN path for marked@17.0.1 changed from `/marked.min.js` to `/lib/marked.umd.js`, and the highlight.js npm package does not include browser build files
  - Solution: implement a dual CDN + local loading strategy, first trying the CDN (fast), and automatically falling back to local vendor/ files if it fails
  - Added detailed debug logs to the UI debug panel to record library load status and the Markdown parsing process
  - Local backup files (~224KB): marked, marked-footnote, DOMPurify, highlight.js, and 7 language packs
  - Full GFM support is now available: tables, footnotes, task lists, code highlighting, nested formatting, etc.

---

## [1.1.1] - 2026-02-20

### Added

- Added **configurable window size** - adjust the window dimensions in the interface settings (width 400-3840px, height 300-2160px); changes take effect the next time it is opened after saving
- Added **maximize/minimize buttons** - the window title bar now has maximize and minimize buttons
- Added **independent UI settings** - a gear icon in the top-right corner opens the interface settings panel, separated from AI configuration
- Added **code syntax highlighting** - uses highlight.js 11.10.0 to add syntax highlighting to code blocks
  - Supports common languages such as JavaScript, Python, TypeScript, JSON, Bash, and C/C++
  - GitHub Dark theme
- Added **enhanced Markdown rendering**
  - Upgraded marked.js: 11.0.0 -> 17.0.1 (latest version)
  - Upgraded DOMPurify: 3.0.6 -> 3.0.11 (latest security version)
  - Enabled GFM (GitHub Flavored Markdown) support
  - Optimized DOMPurify configuration to prevent accidental stripping of content such as bold text inside headings
  - Added footnote support (marked-footnote 1.4.0) - supports `[^1]` and `[^complex-footnote]` syntax
  - Added footnote area styling (divider line + smaller font + accent color)
  - Added task list styling (checkboxes)
  - Added strikethrough, horizontal rules, nested block quotes, and responsive image styling
  - Uses the Marked instance API (`new marked.Marked().use()`) instead of the global `marked.setOptions()`

### Fixed Issues

- Fixed image upload failures (502 error) - images are automatically compressed before upload (max 1024px, JPEG quality 0.75) to solve proxy service rejections of large images
- Fixed duplicate data URL prefixes - corrected the issue where image URLs could become `data:image/jpeg;base64,data:image/jpeg;base64,...`
- Fixed duplicate response issues - when the proxy server sent the same request twice, the second response is now correctly ignored
- Fixed button spacing - the gear and debug buttons are now closer together (gap: 6px)
- Fixed Markdown rendering errors - optimized the DOMPurify whitelist to ensure complex syntax such as `### 1. **Bold Heading**` displays correctly

---

## [1.1.0] - 2026-02-19

### Major Improvements

#### Perfect Thinking Block Display
- `Thinking` content now appears correctly above the main text - fixed the issue where thinking blocks appeared below the main text
- Displays "AI is thinking deeply" - no longer shows inaccurate seconds, replaced with a concise status hint
- Full extraction of thinking process content - supports reasoning content extraction for models such as Grok

#### Support for More AI Models
- OpenAI o1/o3 - full support for the `reasoningEffort` parameter
- Grok - full support for extracting reasoning through `<think>` tags
- DeepSeek - support for extraction via SSE `delta.reasoning_content`
- Claude 3.7 Sonnet - support for the `thinking` parameter and `delta.thinking` field
- Gemini 2.0/3.0 - support for the `thinking_config` parameter and `delta.thoughts` field
- Qwen - support for the `enable_thinking` parameter
- Doubao - support for the `thinking.type` parameter
- Zhipu - support for the `enable_thinking` parameter
- Kimi - support for the `enable_thinking` parameter
- Hunyuan - support for the `enable_thinking` parameter
- Automatic response format detection - intelligently adapts to SSE/JSON formats
- Unified reasoning extraction - supports different field names across models (`reasoning_content`, `reasoning`, `thinking`, `thoughts`)

#### Enhanced History Conversation Features
- Support continuing conversations from history - preserves full context
- Removed distracting hint text - no longer shows "Hint: you are viewing conversation history..."
- Backend automatically rebuilds chat history - seamless conversation state recovery

#### Major Stability Improvements
- Fixed TypeError - `Cannot read properties of undefined (reading 'length')`
- Fixed duplicate `requestId` handling - the same requestId will not be processed twice
- Fixed history rollback errors in concurrent scenarios - added comprehensive type-safe protection
- Fixed block ordering logic - thinking blocks are now displayed correctly above the main text

#### Debugging Experience Improvements
- All key logs are output to the debug panel - easier for developers and users to troubleshoot
- Detailed SSE parsing process logging - including the full reasoning extraction log
- Detailed block ordering process logging - helps diagnose display-order issues

### Technical Improvements

#### SSE Parsing Rework
- Three-stage parsing - accumulate -> extract tags -> emit events
- Support multiple reasoning formats - `<think>`, `<thought>`, `<thinking>`, SSE `delta.reasoning_content`
- Automatic response format detection - intelligently determine SSE or JSON format

#### Type Safety Enhancements
- Added `coerceToString()` function - defensive type conversion
- Improved error handling - avoids crashes caused by undefined/null values

#### Frontend Rendering Optimization
- Fixed block ordering logic - ensures the correct order of thinking -> text -> error
- Optimized time display - removed inaccurate second counters

### Fixed Issues

- Fixed thinking blocks appearing below the main text - caused by incorrect ordering logic
- Fixed thinking time showing as 0 seconds - changed to display "AI is thinking deeply"
- Fixed incomplete Grok reasoning content - restored `stream: true` mode
- Fixed TypeError caused by caching - added defensive type checks
- Fixed history conversations not being able to continue - implemented a restore-session listener

### Known Issues

- Some AI models may not support reasoning content extraction (text content will still display normally)
- History restoration does not include thinking content (only text conversation is restored)

## [1.0.0] - 2026-02-19

### First Release

This is the first official version of EasyEDA AI Assistant, providing complete AI schematic review and conversation features.

### Added

#### Core Features
- **Multi-page schematic data collection** - full page-by-page collection strategy with cross-page data extraction support
- **Intelligent Pin-Net binding** - conservative mode, using only L1 netlist binding (confidence 1.0)
- **Netlist delayed backfill** - non-blocking design, automatic backend backfill, solves netlist timeout issues
- **PROTEL NETLIST 2.0 parsing** - supports JLCEDA netlist format
- **Net label recognition** - automatically recognizes GND, VCC, and other net labels
- **Automatic plugin startup** - document-change detection and backend auto-collection

#### Pin-Net Binding Strategy
- **L1 netlist** (confidence 1.0) - most authoritative, from the EDA netlist generator
- **Conservative mode** - disables L2/L3/L4 strategies to avoid false positives on NC pins

#### User Interface
- **Conversation-style interaction** - fluent AI responses with thinking and text displayed separately
- **Markdown rendering** - full Markdown syntax support with XSS protection
- **Stop generation** - stop AI responses at any time
- **Regenerate** - regenerate the latest message
- **History conversations** - automatically save conversation history
- **Debug panel** - detailed collection and binding logs

#### Configuration Management
- **Support for multiple AI providers** - OpenAI-compatible APIs
- **Custom API endpoints** - supports self-hosted AI services
- **Persistent configuration** - stored in localStorage

### Fixed Issues

#### Netlist Parsing
- Fixed pinNumber extraction error in PROTEL NETLIST 2.0 format
  - Problem: the netlist line format was `U4-18 RTL8723 module-CHIP_EN Input`, and the parser treated the entire line as pinNumber
  - Impact: all pins were unbound and net count was 0
  - Fix: extract only the part before the first space as pinNumber

- Fixed netlist API timeout issues caused by the JLCEDA_PRO format
  - Problem: after switching to JLCEDA_PRO format, the netlist API timed out at both 10 and 60 seconds
  - Fix: switch back to PROTEL2 format (data returned within 4 ms)

#### Pin-Net Binding
- Enabled conservative mode and disabled L2/L3/L4 pin-binding strategies
  - Problem: the L2/L3/L4 strategies could incorrectly bind NC (floating) pins to nearby traces
  - Impact: about 80-100 NC pins were incorrectly marked as connected (false positives)
  - Fix: use only L1 netlist binding; NC pins are correctly marked as unbound

### Technical Highlights

#### Non-blocking Design
- The main flow does not wait for the netlist to complete (10 second timeout)
- Users can start chatting immediately
- Automatic backfill in the background, no awareness needed

#### Epoch Version Control
- Prevents expired tasks from overwriting new tasks
- Supports repeated collection
- Ensures data consistency

#### Complete Error Handling
- Netlist retrieval failures do not affect the main flow
- Timeouts are automatically abandoned and do not block
- Detailed logging

### Known Limitations

- Large schematics (> 500 components) may time out during netlist retrieval
- NC (floating) pins will appear as unbound (this is expected)
- Only PROTEL2 netlist format is supported

### Documents

- [README](README.md) - project overview and quick start
- [CONTRIBUTING](CONTRIBUTING.md) - how to contribute
- [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md) - community code of conduct
- [Implementation Summary](docs/implementation-summary.md) - technical details
- [Netlist Backfill Guide](docs/netlist-backfill-guide.md) - delayed backfill mechanism
- [Testing Guide](docs/testing-guide.md) - test scenarios and methods
- [Project Development Guide](CLAUDE.md) - development standards and constraints

### Acknowledgments

Thanks to the following projects and tools:
- [JLCEDA](https://pro.lceda.cn/) - provides extension APIs
- [marked.js](https://marked.js.org/) - Markdown parsing
- [DOMPurify](https://github.com/cure53/DOMPurify) - XSS protection
- [Cherry Studio](https://github.com/kangfenmao/cherry-studio) - streaming response reference

---

## Versioning Notes

### Version Number Format

Version format: `major.minor.patch`

- **Major version**: incompatible API changes
- **Minor version**: backward-compatible feature additions
- **Patch version**: backward-compatible bug fixes

### Change Types

- `Added` - new features
- `Changed` - feature changes
- `Deprecated` - soon-to-be removed features
- `Removed` - removed features
- `Fixed` - bug fixes
- `Security` - security-related changes

---

[1.0.0]: https://github.com/jifengshandian/easyeda-ai-assistant/releases/tag/v1.0.0
