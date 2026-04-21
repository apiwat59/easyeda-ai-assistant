# eda-mcp-server

The MCP Server component for EasyEDA AI Assistant, which exposes schematic data to external AI tools through the [Model Context Protocol](https://modelcontextprotocol.io/).

## Architecture

```
EDA extension (WebSocket) → eda-mcp-server (Node.js) → stdio → AI tools
```

- **WebSocket Server**: receives schematic snapshots pushed by the EDA extension
- **MCP Server**: provides 9 Resources + 14 Tools to AI tools such as Cursor / Claude Code / Codex through stdio transport

## Installation and Startup

```bash
npm install
npm run build
node dist/index.js                              # Default 127.0.0.1:3100
node dist/index.js --host 0.0.0.0               # Allow remote connections
node dist/index.js --host 0.0.0.0 --port 3200   # Custom port
```

## AI Tool Configuration

### Cursor

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "eda-schematic": {
      "command": "node",
      "args": ["/path/to/eda-mcp-server/dist/index.js", "--host", "0.0.0.0"]
    }
  }
}
```

### Claude Code

Add this to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "eda-schematic": {
      "command": "node",
      "args": ["/path/to/eda-mcp-server/dist/index.js", "--host", "0.0.0.0"]
    }
  }
}
```

## Resources

| URI | Description |
|-----|------|
| `eda://schematic/status` | Connection status and snapshot version |
| `eda://schematic/summary` | Summary of component/pin/net counts |
| `eda://schematic/components` | Full component list |
| `eda://schematic/pins` | Full pin list |
| `eda://schematic/nets` | Full net list |
| `eda://schematic/drc` | DRC check results |
| `eda://schematic/project-info` | Project metadata |
| `eda://schematic/netlist` | Raw netlist text |
| `eda://schematic/compact` | Compact serialized format |

## Tools

| Tool | Parameters | Description |
|------|------|------|
| `schematic_status` | None | Connection status and data version |
| `query_component` | `designator: string` | Query a component and its pins/nets |
| `query_net` | `netName: string` | Query a net and its connectivity |
| `search_schematic` | `keyword: string, type?: string` | Keyword search |
| `configure_bridge` | `host?: string, port?: number` | Dynamically change the WS listening address (both optional) |
| `get_bom` | `includeBomExcluded?: boolean` | Generate a BOM list |
| `find_unconnected_pins` | `designator?: string` | Find floating pins (optionally limited to one component) |
| `analyze_power_nets` | None | Analyze power nets |
| `check_drc` | None | DRC result summary |
| `refresh_data` | None | Request the snapshot to be pushed again |
| `trace_connectivity` | `from: string, to: string` | Find the electrical connection path between two components |
| `list_components_by_type` | None | Group statistics by type |
| `get_netlist_raw` | None | Get the raw netlist |
| `get_pin_map` | `designator: string` | Pin mapping table |

## WS Message Protocol

```
Extension → Server:
  { type: "hello", app: { name, version }, project: { uuid, name }, snapshotVersion }
  { type: "snapshot", version, projectUuid, timestamp, payload: <CollectedData> }
  { type: "pong", timestamp, nonce? }

Server → Extension:
  { type: "request_data" }
  { type: "ping", nonce, timestamp }
  { type: "ack", version }
```

## Acknowledgments

- [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) - foundational framework for EDA extension development
- [jlc-eda-mcp](https://github.com/XuF163/jlc-eda-mcp) - MCP architecture design reference
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) - MCP protocol SDK

## License

Apache 2.0
