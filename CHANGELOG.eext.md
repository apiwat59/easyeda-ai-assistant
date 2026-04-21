# Changelog

## [1.4.1] - 2026-03-13

### Fixes

- Fixed a Kimi API 400 issue by adapting `temperature=1` automatically in thinking mode
- Fixed OpenAI o1/o3 model errors by skipping unsupported temperature parameters
- Fixed config-save failures caused by storage corruption with automatic detection and recovery

### Improvements

- Reduced plugin package size from 23 MB to 1.2 MB

## [1.4.0] - 2026-03-07

### Added

- MCP data exposure for external AI tools such as Cursor, Claude Code, and Codex
- Standalone `eda-mcp-server`
- Read-only schematic resources and tool APIs
- Remote MCP bridge support

## [1.3.2] - 2026-03-07

### Fixes

- Fixed the Thinking Block collapse/expand button after refresh and continued chat
- Improved render-state persistence for thinking blocks
- Prevented stale RAF updates from overwriting fresh DOM state

## [1.3.1] - 2026-03-06

### Fixes

- Fixed triple-processing caused by multiple module instances
- Consolidated shared state into a single global object
- Improved duplicate-request protection

## [1.3.0] - 2026-03-05

### Added

- DRC result collection
- Project metadata collection
- Graphic primitive collection
- Primitive pin collection
- SCH-REVIEW-COMPACT v2 format
- Expanded configuration groups
