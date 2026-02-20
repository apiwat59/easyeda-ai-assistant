# MCP 集成指南

本文档介绍如何将常见的 MCP Server 接入 EasyEDA AI 原理图助手。

---

## 目录

- [支持的 MCP 接入方式](#支持的-mcp-接入方式)
- [方式对比](#方式对比)
- [方式 1：SuperGateway（推荐）](#方式-1supergateway推荐)
- [方式 2：自建 REST Gateway](#方式-2自建-rest-gateway)
- [方式 3：直接使用 Streamable HTTP MCP Server](#方式-3直接使用-streamable-http-mcp-server)
- [常见 MCP Server 转换示例](#常见-mcp-server-转换示例)
- [故障排查](#故障排查)

---

## 支持的 MCP 接入方式

EasyEDA AI 助手的 `ToolOrchestrator` 支持两种 Gateway 协议：

### 1. **MCP Streamable HTTP（JSON-RPC 2.0）** ✅ 推荐

- **协议**：JSON-RPC 2.0 over HTTP
- **端点**：单一端点（如 `/mcp`）
- **请求格式**：
  ```json
  {
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }
  ```
- **响应格式**：SSE 或 JSON
  ```
  event: message
  data: {"jsonrpc":"2.0","result":{"tools":[...]},"id":1}
  ```
- **适用场景**：
  - 使用 SuperGateway 转换 stdio MCP Server
  - 直接使用支持 Streamable HTTP 的 MCP Server
  - 云端部署的 MCP Gateway

### 2. **REST Gateway（自定义 REST API）**

- **协议**：自定义 REST API
- **端点**：
  - `POST /tools/list` - 获取工具列表
  - `POST /tools/call` - 执行工具调用
- **请求格式**：
  ```json
  {
    "sessionId": "...",
    "requestId": "...",
    "name": "tool_name",
    "arguments": {...}
  }
  ```
- **适用场景**：
  - 自建的 HTTP REST Gateway
  - 需要自定义认证/会话管理

### 自动检测逻辑

代码会根据 Gateway URL 自动选择协议：

```typescript
// JSON-RPC 模式（URL 以这些路径结尾）
http://host:port/mcp          → JSON-RPC
http://host:port/sse          → JSON-RPC
http://host:port/http         → JSON-RPC
http://host:port/streamable   → JSON-RPC
http://host:port/jsonrpc      → JSON-RPC

// REST 模式（其他 URL）
http://host:port/api          → REST
http://host:port/gateway      → REST
```

---

## 方式对比

| 方式 | 难度 | 延迟 | 适用场景 | 优点 | 缺点 |
|------|------|------|----------|------|------|
| **SuperGateway** | ⭐ 简单 | 低 | stdio MCP Server | 一行命令启动，社区标准 | 需要 Node.js 环境 |
| **自建 REST Gateway** | ⭐⭐⭐ 复杂 | 中 | 自定义需求 | 完全控制，可定制 | 需要自己实现协议转换 |
| **Streamable HTTP Server** | ⭐⭐ 中等 | 低 | 原生支持 HTTP | 无需中间层 | 需要 MCP Server 原生支持 |

---

## 方式 1：SuperGateway（推荐）

SuperGateway 是社区标准工具，可将任何 stdio MCP Server 转换为 Streamable HTTP 端点。

### 1.1 本地部署

#### 安装并启动

```bash
# 方式 A：直接运行（推荐用于测试）
npx -y supergateway \
  --stdio "npx -y @modelcontextprotocol/server-filesystem /path/to/datasheets" \
  --port 3000 \
  --outputTransport streamable-http

# 方式 B：全局安装
npm install -g supergateway
supergateway \
  --stdio "npx -y @modelcontextprotocol/server-filesystem /path/to/datasheets" \
  --port 3000 \
  --outputTransport streamable-http
```

#### 在 EasyEDA 中配置

```
MCP Enabled: ✅
MCP Gateway URL: http://localhost:3000/mcp
MCP Gateway API Key: (留空)
MCP Auto Approve: ✅
MCP Timeout: 30
```

### 1.2 云端部署（推荐用于生产）

#### Docker 部署

创建 `Dockerfile`：

```dockerfile
FROM node:20-alpine

# 安装 SuperGateway
RUN npm install -g supergateway

# 安装你的 MCP Server（以 grok-search 为例）
RUN npm install -g @modelcontextprotocol/server-grok-search

# 设置环境变量
ENV GROK_API_KEY=your-grok-api-key

# 启动 SuperGateway
CMD ["supergateway", \
     "--stdio", "npx -y @modelcontextprotocol/server-grok-search", \
     "--port", "80", \
     "--outputTransport", "streamable-http"]
```

构建并运行：

```bash
docker build -t mcp-gateway .
docker run -p 3000:80 -e GROK_API_KEY=your-key mcp-gateway
```

#### Render.com 一键部署

创建 `render.yaml`：

```yaml
services:
  - type: web
    name: mcp-gateway
    env: node
    buildCommand: npm install -g supergateway @modelcontextprotocol/server-grok-search
    startCommand: supergateway --stdio "npx -y @modelcontextprotocol/server-grok-search" --port $PORT --outputTransport streamable-http
    envVars:
      - key: GROK_API_KEY
        sync: false
```

部署后获得公网 URL：`https://your-app.onrender.com/mcp`

#### 在 EasyEDA 中配置

```
MCP Enabled: ✅
MCP Gateway URL: https://your-app.onrender.com/mcp
MCP Gateway API Key: (如果设置了认证则填写)
MCP Auto Approve: ✅
MCP Timeout: 60
```

### 1.3 多 MCP Server 聚合

SuperGateway 支持同时运行多个 MCP Server：

```bash
# 启动多个 SuperGateway 实例（不同端口）
supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem ./" --port 3001 --outputTransport streamable-http &
supergateway --stdio "npx -y @modelcontextprotocol/server-grok-search" --port 3002 --outputTransport streamable-http &

# 或使用 Nginx 反向代理聚合
```

---

## 方式 2：自建 REST Gateway

如果需要自定义认证、会话管理或特殊业务逻辑，可以自建 REST Gateway。

### 2.1 API 规范

#### 端点 1：获取工具列表

```http
POST /tools/list
Content-Type: application/json

{
  "sessionId": "session-123",
  "requestId": "request-456"
}
```

**响应**：

```json
{
  "tools": [
    {
      "name": "tool_name",
      "description": "Tool description",
      "inputSchema": {
        "type": "object",
        "properties": {...}
      }
    }
  ]
}
```

#### 端点 2：执行工具调用

```http
POST /tools/call
Content-Type: application/json

{
  "sessionId": "session-123",
  "requestId": "request-456",
  "name": "tool_name",
  "toolName": "tool_name",
  "arguments": {...},
  "autoApprove": true
}
```

**响应**：

```json
{
  "content": "Tool execution result",
  "isError": false
}
```

或 MCP 标准格式：

```json
{
  "result": {
    "content": [
      {"type": "text", "text": "Tool execution result"}
    ]
  }
}
```

### 2.2 Node.js 实现示例

```javascript
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const app = express();
app.use(express.json());

// 管理 MCP 客户端连接
const mcpClients = new Map();

async function getMcpClient(sessionId) {
  if (!mcpClients.has(sessionId)) {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
    });
    const client = new Client({ name: 'rest-gateway', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    mcpClients.set(sessionId, client);
  }
  return mcpClients.get(sessionId);
}

app.post('/tools/list', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const client = await getMcpClient(sessionId);
    const result = await client.listTools();
    res.json({ tools: result.tools });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/tools/call', async (req, res) => {
  try {
    const { sessionId, name, arguments: args } = req.body;
    const client = await getMcpClient(sessionId);
    const result = await client.callTool({ name, arguments: args });
    res.json({ content: JSON.stringify(result.content) });
  } catch (error) {
    res.status(500).json({ error: error.message, isError: true });
  }
});

app.listen(3000, () => console.log('REST Gateway running on port 3000'));
```

### 2.3 在 EasyEDA 中配置

```
MCP Enabled: ✅
MCP Gateway URL: http://localhost:3000
MCP Gateway API Key: your-custom-api-key
MCP Auto Approve: ✅
MCP Timeout: 30
```

---

## 方式 3：直接使用 Streamable HTTP MCP Server

如果 MCP Server 原生支持 Streamable HTTP，可以直接连接。

### 3.1 查找支持 Streamable HTTP 的 MCP Server

目前支持的 MCP Server（2026 年）：

- **grok-search** - Grok AI 搜索（通过 SuperGateway）
- **brave-search** - Brave 搜索 API
- **tavily** - Tavily 搜索 API
- 自定义实现的 Streamable HTTP Server

### 3.2 直接配置

```
MCP Enabled: ✅
MCP Gateway URL: https://mcp-server.example.com/mcp
MCP Gateway API Key: your-api-key
MCP Auto Approve: ✅
MCP Timeout: 30
```

---

## 常见 MCP Server 转换示例

### 示例 1：Claude Desktop 配置转换

**原始配置**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/username/Documents/datasheets"]
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "your-brave-api-key"
      }
    }
  }
}
```

**转换为 SuperGateway**：

```bash
# 启动 filesystem server
supergateway \
  --stdio "npx -y @modelcontextprotocol/server-filesystem /Users/username/Documents/datasheets" \
  --port 3001 \
  --outputTransport streamable-http

# 启动 brave-search server
BRAVE_API_KEY=your-brave-api-key supergateway \
  --stdio "npx -y @modelcontextprotocol/server-brave-search" \
  --port 3002 \
  --outputTransport streamable-http
```

**在 EasyEDA 中配置**（选择其中一个）：

```
# 使用 filesystem
MCP Gateway URL: http://localhost:3001/mcp

# 使用 brave-search
MCP Gateway URL: http://localhost:3002/mcp
```

### 示例 2：Grok-search MCP Server

**安装并启动**：

```bash
# 安装 grok-search MCP server
npm install -g @modelcontextprotocol/server-grok-search

# 通过 SuperGateway 暴露
GROK_API_KEY=your-grok-api-key supergateway \
  --stdio "npx -y @modelcontextprotocol/server-grok-search" \
  --port 3000 \
  --outputTransport streamable-http
```

**在 EasyEDA 中配置**：

```
MCP Enabled: ✅
MCP Gateway URL: http://localhost:3000/mcp
MCP Gateway API Key: (留空)
MCP Auto Approve: ✅
MCP Timeout: 60
```

**可用工具**（8 个）：

1. `web_search` - 深度网络搜索
2. `get_sources` - 获取搜索来源
3. `web_fetch` - 抓取网页内容
4. `web_map` - 网站结构遍历
5. `get_config_info` - 查看配置
6. `switch_model` - 切换 Grok 模型
7. `toggle_builtin_tools` - 控制内置工具
8. `search_planning` - 搜索规划

### 示例 3：Memory Bank MCP Server

```bash
# 安装 memory-bank
npm install -g @jmagar/memory-bank-mcp

# 启动 SuperGateway
supergateway \
  --stdio "npx -y @jmagar/memory-bank-mcp" \
  --port 3003 \
  --outputTransport streamable-http
```

**在 EasyEDA 中配置**：

```
MCP Gateway URL: http://localhost:3003/mcp
```

### 示例 4：自定义 Python MCP Server

假设你有一个 Python MCP Server（`my_mcp_server.py`）：

```bash
# 通过 SuperGateway 暴露
supergateway \
  --stdio "python3 my_mcp_server.py" \
  --port 3004 \
  --outputTransport streamable-http
```

**在 EasyEDA 中配置**：

```
MCP Gateway URL: http://localhost:3004/mcp
```

---

## 故障排查

### 问题 1：`Cannot POST /mcp/tools/list`

**原因**：URL 配置错误，代码误判为 REST 模式。

**解决方案**：

- 确保 Gateway URL 以 `/mcp`、`/sse`、`/http` 等结尾
- 正确示例：`http://host:port/mcp`
- 错误示例：`http://host:port/api/mcp`（会被识别为 REST）

### 问题 2：`Not Acceptable: Client must accept both application/json and text/event-stream`

**原因**：SuperGateway 要求客户端同时接受 JSON 和 SSE。

**解决方案**：

- 已在代码中自动添加 `Accept: application/json, text/event-stream` 头
- 如果仍报错，检查是否使用了旧版本代码（需要 commit `d063245` 或更新）

### 问题 3：工具列表为空

**原因**：MCP Server 未正确启动或响应格式不兼容。

**解决方案**：

1. **测试 SuperGateway**：
   ```bash
   curl -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
   ```

2. **检查响应格式**：
   - 应包含 `event: message` 和 `data: {...}` 行
   - data 中应有 `result.tools` 数组

3. **查看 EasyEDA 调试日志**：
   - 打开 AI 助手调试面板
   - 查找 `[MCP-Discovery]` 日志
   - 如果显示 `已加载 0 个 MCP 工具`，说明解析失败

### 问题 4：工具调用超时

**原因**：工具执行时间过长或网络延迟。

**解决方案**：

- 增加超时时间：`MCP Timeout: 60` 或更高
- 检查 SuperGateway 日志，确认工具是否真的在执行
- 对于耗时工具（如 `web_search`），考虑使用异步模式

### 问题 5：CORS 错误

**原因**：浏览器跨域限制（如果 Gateway 在远程服务器）。

**解决方案**：

在 SuperGateway 前添加 Nginx 反向代理：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location /mcp {
        proxy_pass http://localhost:3000/mcp;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # CORS 头
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "POST, GET, OPTIONS";
        add_header Access-Control-Allow-Headers "Content-Type, Authorization, Accept";

        if ($request_method = OPTIONS) {
            return 204;
        }
    }
}
```

### 问题 6：认证失败

**原因**：Gateway 需要 API Key 但未配置。

**解决方案**：

1. **在 EasyEDA 中配置**：
   ```
   MCP Gateway API Key: your-api-key
   ```

2. **SuperGateway 传递认证**：
   ```bash
   supergateway \
     --stdio "..." \
     --header "Authorization: Bearer your-upstream-api-key" \
     --port 3000
   ```

3. **自建 Gateway 验证**：
   ```javascript
   app.use((req, res, next) => {
     const auth = req.headers.authorization;
     if (auth !== 'Bearer your-api-key') {
       return res.status(401).json({ error: 'Unauthorized' });
     }
     next();
   });
   ```

---

## 最佳实践

### 1. 本地开发

- 使用 `npx -y supergateway` 快速测试
- 端口使用 3000-3999 范围避免冲突
- 启用 `--verbose` 查看详细日志

### 2. 生产部署

- 使用 Docker 容器化部署
- 配置 HTTPS（通过 Nginx/Caddy）
- 设置 API Key 认证
- 监控 Gateway 健康状态
- 使用 PM2 或 systemd 保持进程运行

### 3. 性能优化

- 对于高频调用，考虑在 Gateway 层添加缓存
- 使用连接池管理 MCP 客户端
- 设置合理的超时时间（30-60 秒）
- 监控工具执行耗时，优化慢查询

### 4. 安全建议

- 生产环境必须使用 HTTPS
- 不要在公网暴露无认证的 Gateway
- 定期更新 SuperGateway 和 MCP Server
- 审计工具调用日志，防止滥用

---

## 参考资源

- [MCP 官方规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [SuperGateway GitHub](https://github.com/supercorp-ai/supergateway)
- [MCP Server 列表](https://github.com/modelcontextprotocol/servers)
- [EasyEDA AI 助手项目](https://github.com/your-repo/easyeda-ai-assistant)

---

## 更新日志

- **2026-02-20**：初始版本，支持 SuperGateway 和 REST Gateway
- **2026-02-20**：添加 Streamable HTTP 自动检测逻辑
- **2026-02-20**：补充常见 MCP Server 转换示例
