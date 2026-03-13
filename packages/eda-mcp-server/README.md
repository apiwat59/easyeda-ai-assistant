# eda-mcp-server

EasyEDA AI Assistant 的 MCP Server 组件，通过 [Model Context Protocol](https://modelcontextprotocol.io/) 向外部 AI 工具暴露原理图数据。

## 架构

```
EDA 扩展 (WebSocket) → eda-mcp-server (Node.js) → stdio → AI 工具
```

- **WebSocket Server**：接收 EDA 扩展推送的原理图快照
- **MCP Server**：通过 stdio transport 向 Cursor / Claude Code / Codex 等 AI 工具提供 9 个 Resources + 14 个 Tools

## 安装与启动

```bash
npm install
npm run build
node dist/index.js                              # 默认 127.0.0.1:3100
node dist/index.js --host 0.0.0.0               # 允许远程连接
node dist/index.js --host 0.0.0.0 --port 3200   # 自定义端口
```

## AI 工具配置

### Cursor

在 `~/.cursor/mcp.json` 中添加：

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

在 `~/.claude/mcp.json` 中添加：

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

| URI | 说明 |
|-----|------|
| `eda://schematic/status` | 连接状态、快照版本 |
| `eda://schematic/summary` | 器件/引脚/网络数量摘要 |
| `eda://schematic/components` | 全部器件列表 |
| `eda://schematic/pins` | 全部引脚列表 |
| `eda://schematic/nets` | 全部网络列表 |
| `eda://schematic/drc` | DRC 检查结果 |
| `eda://schematic/project-info` | 工程元信息 |
| `eda://schematic/netlist` | 原始网表文本 |
| `eda://schematic/compact` | 紧凑序列化格式 |

## Tools

| Tool | 参数 | 说明 |
|------|------|------|
| `schematic_status` | 无 | 连接状态与数据版本 |
| `query_component` | `designator: string` | 查询器件及其引脚/网络 |
| `query_net` | `netName: string` | 查询网络及连接关系 |
| `search_schematic` | `keyword: string, type?: string` | 关键词搜索 |
| `configure_bridge` | `host?: string, port?: number` | 动态修改 WS 监听地址（均可选） |
| `get_bom` | `includeBomExcluded?: boolean` | 生成 BOM 清单 |
| `find_unconnected_pins` | `designator?: string` | 查找悬空引脚（可选指定器件） |
| `analyze_power_nets` | 无 | 分析电源网络 |
| `check_drc` | 无 | DRC 结果摘要 |
| `refresh_data` | 无 | 请求重新推送快照 |
| `trace_connectivity` | `from: string, to: string` | 查找两器件间的电气连接路径 |
| `list_components_by_type` | 无 | 按类型分组统计 |
| `get_netlist_raw` | 无 | 获取原始网表 |
| `get_pin_map` | `designator: string` | 引脚映射表 |

## WS 消息协议

```
扩展 → Server:
  { type: "hello", app: { name, version }, project: { uuid, name }, snapshotVersion }
  { type: "snapshot", version, projectUuid, timestamp, payload: <CollectedData> }
  { type: "pong", timestamp, nonce? }

Server → 扩展:
  { type: "request_data" }
  { type: "ping", nonce, timestamp }
  { type: "ack", version }
```

## 致谢

- [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) - EDA 扩展开发基础框架
- [jlc-eda-mcp](https://github.com/XuF163/jlc-eda-mcp) - MCP 架构设计参考
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) - MCP 协议 SDK

## 许可证

Apache 2.0
