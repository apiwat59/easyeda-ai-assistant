# MCP Integration Guide

## Overview

EasyEDA AI Assistant now supports MCP tool calls through a configurable gateway. This enables external calls (web search, datasheet lookup, file access, etc.) inside schematic review conversations.

## Supported Gateway Types

### 1) REST Gateway

Use this for custom HTTP gateways.

- `POST /tools/list` — returns available tools.
- `POST /tools/call` — executes a tool call.

Request:
```json
POST /tools/list
{
  "sessionId": "xxx",
  "requestId": "xxx"
}
```

Response:
```json
{
  "tools": [
    {
      "name": "search_datasheet",
      "description": "search chip datasheet",
      "inputSchema": { "type": "object", "properties": {} }
    }
  ]
}
```

### 2) MCP Streamable HTTP (JSON-RPC 2.0)

Use this for standard MCP transports (e.g. SuperGateway).

- Single endpoint (for example `/mcp`) receives all JSON-RPC requests.

Request:
```json
POST /mcp
{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "id": 1
}
```

Response example (`SSE`):
```
event: message
data: {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
```

Session flow:
1. Send `initialize`.
2. Server returns `Mcp-Session-Id` header.
3. Send subsequent calls with this session ID.

## Protocol auto-detection

The extension auto-detects protocol from gateway URL:

- JSON-RPC mode when URL ends in: `/mcp`, `/sse`, `/http`, `/streamable`, `/jsonrpc`.
- REST mode for other paths.

Examples:
- `http://gateway.local/mcp` → JSON-RPC.
- `http://gateway.local/api` → REST.

## Configuration

### Quick validation with SuperGateway + Tavily

1. Start gateway:
```bash
# set Tavily key
export TAVILY_API_KEY="tvly-your-key"

# stateful (recommended, keeps session)
npx -y supergateway \
  --stdio "npx -y tavily-mcp@latest" \
  --outputTransport streamableHttp \
  --port 8000 \
  --stateful

# stateless mode
npx -y supergateway \
  --stdio "npx -y tavily-mcp@latest" \
  --outputTransport streamableHttp \
  --port 8000
```

2. Configure in EasyEDA:
```text
MCP Enabled: true
MCP Gateway URL: http://localhost:8000/mcp
MCP Gateway API Key: (optional)
MCP Auto Approve: true
```

### Remote SuperGateway

```text
MCP Enabled: true
MCP Gateway URL: http://your-server.com:8000/mcp
MCP Gateway API Key: set if auth is required
MCP Auto Approve: true
```

### Custom REST gateway

```text
MCP Enabled: true
MCP Gateway URL: http://your-gateway.com/api
MCP Gateway API Key: your-api-key
MCP Auto Approve: true
```

## Runtime flow

### JSON-RPC flow
```text
user query
  -> extension listTools()
  -> detect JSON-RPC mode + init needed
  -> POST /mcp method initialize (no session)
  -> store Mcp-Session-Id
  -> POST /mcp method tools/list
  -> model chooses tools
  -> POST /mcp method tools/call
  -> response returned
  -> model streams final answer
```

### REST flow
```text
user query
  -> extension listTools()
  -> POST /tools/list
  -> model chooses tools
  -> POST /tools/call
  -> response returned
  -> model streams final answer
```

## UI behavior

### Tool block (purple styling)

Tool execution is rendered in-chat.

Running:
```text
┌──────────────────────────────────────┐
│ 🔧 Calling tool: web_search          │
│ ⏳ In progress...                    │
│ args: {"query":"NE555 datasheet"}    │
└──────────────────────────────────────┘
```

Success:
```text
┌──────────────────────────────────────┐
│ ✅ Tool web_search succeeded          │
│ summary: found full datasheet...      │
│ [expand for full output]             │
└──────────────────────────────────────┘
```

Failure:
```text
┌──────────────────────────────────────┐
│ ❌ Tool web_search failed            │
│ error: gateway request timeout        │
└──────────────────────────────────────┘
```

### Debug logs

Look for MCP logs in the debug panel:
```text
[MCP-Discovery] loading tool list
[MCP-Discovery] loaded 8 MCP tools
[MCP-Call] calling web_search { args: {...} }
[MCP-Exec] tool completed { status: 'success', duration: 1234 }
```

## Testing

### Gateway health check

#### Test JSON-RPC mode
```bash
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'

# then extract Mcp-Session-Id and call tools/list
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

#### Test REST mode
```bash
curl -X POST http://your-gateway.com/api/tools/list \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test","requestId":"test"}'
```

### In-extension test
1. Save config and open chat.
2. Ask:
   ```text
   What is the pinout for NE555?
   ```
3. Confirm debug logs show discovery/call/exec flow.
4. Confirm tool block appears in conversation.

## Troubleshooting

### Q1: `No valid session ID provided`
- Gateway was started with `--stateful`.
- Ensure URL ends with `/mcp` so JSON-RPC mode is selected.
- Restart extension to reinitialize session.

### Q2: `Not Acceptable: Client must accept both application/json and text/event-stream`
- Missing `Accept` header.
- Current version auto-adds required header.

### Q3: Tool list empty
- Gateway endpoint not returning valid MCP schema.
- Verify with curl and inspect raw response/errors in logs.

### Q4: CORS issues
- For `streamableHttp`, configure CORS on reverse proxy (example below).
- `--cors` in gateway is mainly for SSE/WS output modes.

```nginx
location /mcp {
  if ($request_method = OPTIONS) {
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS";
    add_header Access-Control-Allow-Headers "Content-Type, Accept, Mcp-Session-Id";
    add_header Access-Control-Max-Age 86400;
    return 204;
  }
  proxy_pass http://localhost:8000;
  add_header Access-Control-Allow-Origin *;
  add_header Access-Control-Allow-Methods "GET, POST, OPTIONS";
  add_header Access-Control-Allow-Headers "Content-Type, Accept, Mcp-Session-Id";
}
```

### No hard request timeout
- MCP requests are not hard-capped because some tools can be long-running.
- User can cancel with **Stop Generation**.
- `AbortSignal` is used to stop gateway calls early when cancellation happens.

### Tool call round limit
- No hard limit on normal rounds; system warns after 6 calls and hard-caps at 20.
- Frequent high-round usage usually means tool quality or output quality needs review.

## Available MCP servers

### GrokSearch (recommended)
GitHub: https://github.com/GuDaStudio/GrokSearch/tree/grok-with-tavily

Core idea:
- Grok handles AI search.
- Tavily handles web fetching and mapping.
- Firecrawl used as fallback.

Environment:
1. Grok API key (required): https://x.ai
2. Tavily API key (optional/recommended): https://app.tavily.com/sign-in
3. Firecrawl API key (optional): https://firecrawl.dev/

Start:
```bash
export GROK_API_URL="https://your-grok-endpoint.com/v1"
export GROK_API_KEY="your-grok-api-key"
export TAVILY_API_KEY="tvly-your-key"

npx -y supergateway \
  --stdio "uvx --from git+https://github.com/GuDaStudio/GrokSearch@grok-with-tavily grok-search" \
  --outputTransport streamableHttp \
  --port 8000 \
  --stateful
```

Tools available: `web_search`, `get_sources`, `web_fetch`, `web_map`, `get_config_info`, `switch_model`, `toggle_builtin_tools`, `search_planning`.

### Tavily (alternative)
```bash
export TAVILY_API_KEY="tvly-your-key"
npx -y supergateway \
  --stdio "npx -y tavily-mcp@latest" \
  --outputTransport streamableHttp \
  --port 8000 \
  --stateful
```

### Filesystem MCP
```bash
npx -y supergateway \
  --stdio "npx -y @modelcontextprotocol/server-filesystem /path/to/datasheets" \
  --outputTransport streamableHttp \
  --port 8000
```

### Other servers
Browse all options at [MCP Registry](https://modelcontextprotocol.io/registry).

## Architecture

```text
orchestrator.ts
  └─ ToolOrchestrator (tool-orchestrator.ts)
       ├─ detectGatewayType()
       ├─ ensureInitialized()
       ├─ performInitialize()
       ├─ listTools()
       ├─ executeToolCalls()
       └─ postJson()
```

### Key files

| File | Responsibility |
|------|----------------|
| `src/review/tool-orchestrator.ts` | MCP orchestration |
| `src/review/orchestrator.ts` | Tool events + config integration |
| `src/review/chat-adapter.ts` | Multi-turn tool-calling loop |
| `src/review/types.ts` | MCP protocol types |
| `src/review/config.ts` | Gateway settings |
| `iframe/chat.html` | Tool block and logs UI |

### Commit history

```text
a900684 fix: implement MCP Streamable HTTP session management
d063245 feat: support MCP Streamable HTTP (JSON-RPC 2.0)
bd21d3b feat: add MCP tool orchestration
```

## References

- [MCP specification](https://modelcontextprotocol.io/specification/2025-03-26)
- [SuperGateway](https://github.com/supercorp-ai/supergateway)
- [MCP Registry](https://modelcontextprotocol.io/registry)
- [GrokSearch](https://github.com/GuDaStudio/GrokSearch/tree/grok-with-tavily)

## Contribution

Open issues or PRs to improve MCP integration.
