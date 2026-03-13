# EasyEDA AI Assistant 🤖

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![EasyEDA Pro](https://img.shields.io/badge/EasyEDA%20Pro-3.0%2B-green.svg)](https://pro.lceda.cn/)
[![GitHub Issues](https://img.shields.io/github/issues/jifengshandian/easyeda-ai-assistant)](https://github.com/jifengshandian/easyeda-ai-assistant/issues)
[![GitHub Stars](https://img.shields.io/github/stars/jifengshandian/easyeda-ai-assistant)](https://github.com/jifengshandian/easyeda-ai-assistant/stargazers)

> 你的原理图审查小助手 - 让 AI 真正"看懂"你的电路设计

基于嘉立创 EDA 专业版的 AI 原理图对话助手，**不是帮你画图，而是帮你检查**！

[English](README.en.md) | 简体中文

---

## 🎯 核心定位

**它并不会帮你绘制原理图**，而是作为你画完原理图后帮你检查的小助手 🧐

### 为什么选择这个插件？

传统方式：截图 → 发给 AI → AI 看不懂电路细节 → 只能给出模糊建议 😤

**本插件的优势**：
- ✅ **以文字形式**完整理解你的原理图（器件、引脚、网络、连接关系）
- ✅ **打破截图局限**，AI 能精确知道每个引脚连接到哪个网络
- ✅ **智能跳转**，点击对话中的蓝色标签直接定位到原理图元件
- ✅ **联网搜索**，AI 可以查询芯片手册、数据手册，给出专业建议

### 🌟 推荐配置

**强烈推荐使用 Grok 4.2 模型**！
- 🔍 联网搜索能力超强，能实时查询芯片资料
- 🧠 深度思考模式，显示完整推理过程
- 🚀 后续将加入 MCP 功能（grok-search mcp），搭配更强大的模型体验更佳

### 🤖 支持的 Reasoning 模型

本插件支持 **13+ 种主流 AI 服务商**的 reasoning/thinking 功能，内置一键预设：

| 服务商 | 推荐模型 | Reasoning 支持 |
|--------|---------|---------------|
| **OpenAI** | gpt-5.2 | ✅ 完整支持 |
| **xAI (Grok)** | grok-4.20-beta | ✅ 完整支持（推荐） |
| **DeepSeek** | deepseek-chat | ✅ 完整支持 |
| **Google Gemini** | gemini-3-flash | ✅ 完整支持 |
| **OpenRouter** | claude-sonnet-4.6 | ✅ 完整支持 |
| **Groq** | qwen/qwen3-32b | ✅ 完整支持 |
| **Mistral** | mistral-large-latest | ✅ 完整支持 |
| **Qwen (通义千问)** | qwen3.5-plus | ✅ 完整支持 |
| **Zhipu (智谱)** | glm-4.7 | ✅ 完整支持 |
| **Kimi** | kimi-k2.5 | ✅ 完整支持 |
| **SiliconFlow** | DeepSeek-V3 | ✅ 完整支持 |
| **Doubao (豆包)** | doubao-seed-2-0-pro | ✅ 完整支持 |
| **Yi (零一万物)** | yi-large | ✅ 完整支持 |

**自动检测**：插件会自动识别模型类型，无需手动配置 reasoning 参数。

---

## 📸 界面展示

### AI 对话分析
> 与 AI 自由对话，讨论原理图中的芯片选型、电路设计等问题

![AI 对话界面](screenshots/screenshot-1.png)

### 引脚级精准分析
> AI 能精确分析每个引脚的连接关系，指出悬空引脚和潜在问题

![引脚分析功能](screenshots/screenshot-2.png)

### 联网搜索 Datasheet
> 遇到不熟悉的芯片，AI 自动联网搜索数据手册，给出专业建议

![联网搜索能力](screenshots/screenshot-3.png)

### MCP 工具集成
> 支持 MCP 协议，集成 web_search、web_fetch 等工具，增强 AI 的信息获取能力

![MCP 工具集成](screenshots/screenshot-4.png)

---

## ✨ 功能特性

### 🆕 v1.1.0 新特性

- 🧠 **Thinking Block 完美显示** - AI 思考过程清晰可见，显示在正文上方
- 🤖 **支持 10+ AI 模型** - OpenAI o1/o3、Grok、DeepSeek、Claude 3.7、Gemini、Qwen、Doubao、Zhipu、Kimi、Hunyuan 等思考类模型
- 📜 **历史会话增强** - 从历史对话无缝继续，保持完整上下文
- 🛡️ **稳定性大幅提升** - 修复多个 Bug，添加类型安全防护
- 🐛 **调试日志优化** - 详细的 SSE 解析和 reasoning 提取日志

### 核心功能

- 🤖 **AI 对话助手** - 与 AI 对话，分析原理图设计
- 📊 **智能数据采集** - 自动采集原理图数据（器件、引脚、网络）
- 🔗 **Pin-Net 绑定** - 基于网表的引脚-网络绑定（置信度 1.0）
- 📝 **网表解析** - 支持 PROTEL NETLIST 2.0 格式
- ⚡ **非阻塞设计** - 网表延迟回填，不阻塞用户操作
- 🎯 **保守模式** - 避免 NC 引脚假阳性，只信任网表

### 用户体验

- 📱 **流式响应** - 实时显示 AI 思考过程和回答
- 🎯 **智能跳转** - 点击蓝色标签（如 `U1`、`VCC`）直接定位到原理图
- 📎 **上传附件** - 支持上传芯片手册、数据手册等文件
- 📜 **历史记录** - 自动保存对话历史，随时回顾
- 🧠 **显示思考过程** - 支持 Grok、DeepSeek、OpenAI o1 等模型的 reasoning 显示
- 🛡️ **安全防护** - XSS 防护，Markdown 安全渲染

---

## 🔌 MCP 数据暴露（v1.4.0 新功能）

让 Cursor、Claude Code、Codex 等外部 AI 工具通过 MCP 协议**只读访问**你的原理图数据。

### 架构

```
┌─────────────────────────────┐
│  EDA 扩展 (沙盒 WebView)     │
│  mcp-bridge.ts              │
└──────────┬──────────────────┘
           │ WebSocket 出站
           ▼
┌─────────────────────────────┐
│  eda-mcp-server (Node.js)    │
│  WS Server + MCP Server      │
└──────────┬──────────────────┘
           │ stdio transport
           ▼
┌─────────────────────────────┐
│  Cursor / Claude Code / Codex │
│  等 AI 工具                   │
└─────────────────────────────┘
```

### 快速使用

**1. 启动 MCP Server**

```bash
cd packages/eda-mcp-server
npm install
npm run build
node dist/index.js                        # 默认 127.0.0.1:3100
node dist/index.js --host 0.0.0.0         # 允许远程连接
node dist/index.js --host 0.0.0.0 --port 3200  # 自定义端口
```

**2. 配置 EDA 扩展**

在插件配置面板中设置 MCP Bridge URL：
- 本机：`ws://127.0.0.1:3100`（默认）
- 远程：`ws://<server-ip>:3100`

**3. 配置 AI 工具**

**Cursor** (`~/.cursor/mcp.json`)：
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

**Claude Code** (`~/.claude/mcp.json`)：
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

### 可用 Resources

| URI | 说明 |
|-----|------|
| `eda://schematic/status` | 连接状态、快照版本、时间戳 |
| `eda://schematic/summary` | 器件/引脚/网络数量、DRC 状态摘要 |
| `eda://schematic/components` | 全部器件列表 |
| `eda://schematic/pins` | 全部引脚列表 |
| `eda://schematic/nets` | 全部网络列表 |
| `eda://schematic/drc` | DRC 检查结果 |
| `eda://schematic/project-info` | 工程元信息 |
| `eda://schematic/netlist` | 原始网表文本 |
| `eda://schematic/compact` | 紧凑序列化格式（完整输出） |

### 可用 Tools

| Tool | 参数 | 说明 |
|------|------|------|
| `schematic_status` | 无 | 返回连接状态、数据版本 |
| `query_component` | `designator` | 查询单个器件及其关联引脚和网络 |
| `query_net` | `netName` | 查询网络及连接的引脚/器件 |
| `search_schematic` | `keyword`, `type?` | 关键词搜索 |
| `configure_bridge` | `host?`, `port?` | 动态修改 WS 监听地址（均可选） |
| `get_bom` | `includeBomExcluded?` | 生成 BOM 清单 |
| `find_unconnected_pins` | `designator?` | 查找悬空引脚（可选指定器件） |
| `analyze_power_nets` | 无 | 分析电源网络拓扑 |
| `check_drc` | 无 | 获取 DRC 结果摘要 |
| `refresh_data` | 无 | 请求扩展重新推送快照 |
| `trace_connectivity` | `from`, `to` | 查找两器件间的电气连接路径 |
| `list_components_by_type` | 无 | 按类型分组统计器件 |
| `get_netlist_raw` | 无 | 获取原始网表 |
| `get_pin_map` | `designator` | 获取器件引脚映射表 |

---

## 🚀 快速开始

### 安装

#### 方式 1：从立创开源广场安装（推荐）

1. 打开嘉立创 EDA 专业版
2. 进入 **扩展 → 扩展管理器**
3. 搜索 "AI Schematic Assistant"
4. 点击安装
5. 重启 EasyEDA Pro

#### 方式 2：从 GitHub Releases 下载

1. 访问 [Releases](https://github.com/jifengshandian/easyeda-ai-assistant/releases) 页面
2. 下载最新版本的 `.eext` 文件
3. 在 EasyEDA Pro 中：**扩展 → 扩展管理器 → 安装本地扩展**
4. 选择下载的 `.eext` 文件
5. 重启 EasyEDA Pro

#### 方式 3：从源码构建

```bash
# 克隆仓库
git clone https://github.com/jifengshandian/easyeda-ai-assistant.git
cd easyeda-ai-assistant

# 安装依赖
npm install

# 构建扩展
npm run build
```

### 使用

1. 打开原理图
2. 点击菜单 **AI Review → AI 原理图助手...**
3. 首次使用需要配置 AI API：
   - 点击配置按钮 ⚙️
   - 填写 API URL 和 API Key
   - 选择模型（**推荐 Grok 4.2**）
4. 开始与 AI 对话！

### 配置示例

**推荐配置（Grok）**：
- API URL: `https://api.x.ai/v1`
- 模型: `grok-4.20-beta`
- API Key: 从 [x.ai](https://x.ai) 获取

**其他兼容 API**：
- OpenAI API (`gpt-5.2`)
- DeepSeek API (`deepseek-chat`)
- Google Gemini API (`gemini-3-flash`)
- OpenRouter（聚合多模型，如 `claude-sonnet-4.6`）
- 任何 OpenAI 兼容的 API

---

## 📖 使用场景

### 场景 1：原理图审查

```
你：帮我检查一下这个电源电路有没有问题

AI：我看到你的电源电路使用了 LM2596 降压芯片...
    [分析 U1 的引脚连接]
    [检查去耦电容 C1、C2]
    [验证反馈电阻 R1、R2 的分压比]

    建议：
    1. C1 的位置应该更靠近 U1 的 VIN 引脚
    2. R1、R2 的分压比计算...
```

点击对话中的 `U1`、`C1` 等蓝色标签，直接跳转到原理图对应位置！

### 场景 2：芯片选型咨询

```
你：我需要一个 5V 转 3.3V 的 LDO，推荐一下

AI：[联网搜索芯片资料]
    根据你的原理图，我看到负载电流约 500mA...
    推荐使用 AMS1117-3.3，理由：
    1. 输出电流最大 1A，满足需求
    2. 压差低（1.2V），发热小
    3. 封装兼容，易于采购

    [附上数据手册链接]
```

### 场景 3：调试问题排查

```
你：我的 STM32 无法启动，帮我看看

AI：让我检查启动相关的电路...
    [分析 BOOT0、BOOT1 引脚]
    [检查复位电路]
    [验证电源去耦]

    发现问题：
    1. BOOT0 引脚悬空，应该下拉到 GND
    2. NRST 引脚缺少上拉电阻
```

---

## 🛠️ 开发

### 环境要求

- **Node.js** >= 20.17.0
- **npm** >= 9.0.0
- **EasyEDA Pro** >= 3.0.0

### 开发流程

```bash
# 安装依赖
npm install

# 开发构建
npm run build

# 代码检查
npm run lint

# 自动修复
npm run fix
```

### 项目结构

```
.
├── src/                    # 源代码
│   ├── index.ts           # 扩展入口
│   └── review/            # AI 审查模块
│       ├── types.ts       # 类型定义
│       ├── config.ts      # 配置管理
│       ├── collector.ts   # 数据采集
│       ├── mcp-bridge.ts  # MCP Bridge（WS 客户端）
│       ├── chat-adapter.ts # AI 通信
│       └── orchestrator.ts # 流程编排
├── iframe/                # 对话 UI
│   └── chat.html
├── packages/              # 独立子项目
│   └── eda-mcp-server/   # MCP Server（对外暴露原理图数据）
│       ├── src/
│       │   ├── index.ts          # 入口（CLI 启动）
│       │   ├── ws-bridge.ts      # WS 接收扩展推送
│       │   ├── snapshot-store.ts # 快照内存存储
│       │   ├── mcp-server.ts     # Resources + Tools 注册
│       │   └── types.ts          # 共享类型
│       └── package.json
├── docs/                  # 文档
├── extension.json         # 扩展配置
├── package.json           # 项目配置
├── CHANGELOG.md           # 更新日志
└── README.md             # 本文件
```

---

## 📊 路线图

### 近期计划

- [x] **MCP 数据暴露** - 独立 MCP Server，让 Cursor/Claude Code/Codex 等外部 AI 工具读取原理图数据（v1.4.0 已完成）
- [x] **多页原理图支持** - 逐页采集策略（v1.0.0 已实现）
- [x] **扩展元素类型** - 支持文本标注、总线、网络标记、图形图元等（v1.3.0 已实现）
- [x] **Markdown 渲染增强** - GFM 表格、代码高亮、脚注等（v1.1.1 已实现）

### 长期计划

- [ ] 支持更多网表格式（JLCEDA_PRO、EASYEDA_PRO）
- [ ] 添加规则引擎，自动检测常见设计问题
- [ ] 支持 PCB 审查
- [ ] 多语言支持（英文、日文）
- [ ] 导出审查报告（PDF、Markdown）

---

## 🤝 贡献

欢迎贡献！本插件已上架**立创开源广场**和 **GitHub**，期待广大电子爱好者的指正和批评 🫡

请查看 [贡献指南](CONTRIBUTING.md) 了解如何参与。

### 贡献者

感谢所有贡献者的付出！

<!-- ALL-CONTRIBUTORS-LIST:START -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 🐛 问题反馈

如果你发现了 Bug 或有功能建议，请：

1. 查看 [现有 Issues](https://github.com/jifengshandian/easyeda-ai-assistant/issues)
2. 如果没有相关 Issue，[创建新 Issue](https://github.com/jifengshandian/easyeda-ai-assistant/issues/new/choose)
3. 使用 Issue 模板，提供详细信息

---

## 💬 讨论

有问题或想法？欢迎在 [Discussions](https://github.com/jifengshandian/easyeda-ai-assistant/discussions) 讨论！

---

## 📖 文档

- [更新日志](CHANGELOG.md) - 版本历史
- [贡献指南](CONTRIBUTING.md) - 如何参与贡献
- [行为准则](CODE_OF_CONDUCT.md) - 社区行为准则
- [功能实现总结](docs/implementation-summary.md) - 技术细节
- [网表延迟回填指南](docs/netlist-backfill-guide.md) - 延迟回填机制
- [测试验证指南](docs/testing-guide.md) - 测试场景和方法

---

## 📄 许可证

本项目采用 [Apache 2.0 许可证](LICENSE)。

---

## 🙏 致谢

感谢以下项目和工具：

- [嘉立创 EDA](https://pro.lceda.cn/) - 提供扩展 API
- [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) - 本项目基于此 SDK 开发，提供了 EDA 扩展开发的基础框架和 API 示例
- [jlc-eda-mcp](https://github.com/XuF163/jlc-eda-mcp) - MCP 数据暴露功能的架构设计参考，提供了 EDA 扩展与 MCP Server 通过 WebSocket 桥接的思路
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) - MCP 协议 TypeScript 实现
- [marked.js](https://marked.js.org/) - Markdown 解析
- [DOMPurify](https://github.com/cure53/DOMPurify) - XSS 防护
- [Cherry Studio](https://github.com/kangfenmao/cherry-studio) - 流式响应参考

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jifengshandian/easyeda-ai-assistant&type=Date)](https://star-history.com/#jifengshandian/easyeda-ai-assistant&Date)

---

**注意**：本项目基于 [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) 开发，是一个独立的 AI 原理图助手扩展实现。

如果这个项目对你有帮助，请给个 ⭐️ Star！
