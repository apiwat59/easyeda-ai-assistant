# EasyEDA AI Assistant 🤖

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![EasyEDA Pro](https://img.shields.io/badge/EasyEDA%20Pro-3.0%2B-green.svg)](https://pro.lceda.cn/)
[![GitHub Issues](https://img.shields.io/github/issues/jifengshandian/easyeda-ai-assistant)](https://github.com/jifengshandian/easyeda-ai-assistant/issues)
[![GitHub Stars](https://img.shields.io/github/stars/jifengshandian/easyeda-ai-assistant)](https://github.com/jifengshandian/easyeda-ai-assistant/stargazers)

> Your schematic review sidekick for EasyEDA Pro, built to help AI actually understand your circuit design.

EasyEDA AI Assistant is an AI-powered schematic chat and review extension for JLCEDA / EasyEDA Pro. It is **not** a schematic drawing tool. It is designed to **inspect, explain, and review the schematic you already built**.

---

## 🎯 What This Plugin Is For

This plugin does **not** generate schematics for you. Instead, it acts as a review assistant after your schematic is already on the page.

### Why use it?

The traditional workflow usually looks like this:

Screenshot your schematic -> send it to an AI tool -> the AI cannot see the electrical details clearly -> you only get vague suggestions.

### What this plugin does better

- ✅ Converts your schematic into structured text that AI can reason about, including components, pins, nets, and connectivity
- ✅ Breaks past screenshot limitations so the model can understand which pin connects to which net
- ✅ Lets you click blue labels in the chat to jump directly to the matching schematic object
- ✅ Supports online lookup so the AI can reference datasheets and component documentation when needed

### 🌟 Recommended setup

**Grok 4.2 is currently the recommended model** for the best experience in this project:

- 🔍 Strong web search capability for live datasheet lookup
- 🧠 Deep reasoning support with visible thinking blocks
- 🚀 Future MCP integration support for a stronger end-to-end workflow

### 🤖 Supported reasoning models

The plugin includes presets for **13+ mainstream AI providers** with reasoning or thinking support:

| Provider | Recommended model | Reasoning support |
|----------|-------------------|-------------------|
| **OpenAI** | `gpt-5.2` | ✅ Full support |
| **xAI (Grok)** | `grok-4.20-beta` | ✅ Full support (recommended) |
| **DeepSeek** | `deepseek-chat` | ✅ Full support |
| **Google Gemini** | `gemini-3-flash` | ✅ Full support |
| **OpenRouter** | `claude-sonnet-4.6` | ✅ Full support |
| **Groq** | `qwen/qwen3-32b` | ✅ Full support |
| **Mistral** | `mistral-large-latest` | ✅ Full support |
| **Qwen** | `qwen3.5-plus` | ✅ Full support |
| **Zhipu** | `glm-4.7` | ✅ Full support |
| **Kimi** | `kimi-k2.5` | ✅ Full support |
| **SiliconFlow** | `DeepSeek-V3` | ✅ Full support |
| **Doubao** | `doubao-seed-2-0-pro` | ✅ Full support |
| **Yi** | `yi-large` | ✅ Full support |

**Automatic detection:** the plugin detects model type automatically, so you do not need to configure reasoning parameters manually.

---

## 📸 Screenshots

### AI chat analysis

Talk naturally with the AI about component choice, circuit behavior, and design issues inside your schematic.

![AI chat interface](screenshots/screenshot-1.png)

### Pin-level analysis

The AI can inspect exact pin connectivity and point out floating pins or suspicious wiring.

![Pin analysis](screenshots/screenshot-2.png)

### Online datasheet lookup

When you reference an unfamiliar part, the AI can search for datasheets and return grounded recommendations.

![Online search](screenshots/screenshot-3.png)

### MCP tool integration

The plugin can work with MCP-compatible tools such as `web_search` and `web_fetch` to expand what the model can inspect.

![MCP integration](screenshots/screenshot-4.png)

---

## ✨ Features

### 🆕 Highlights from v1.1.0

- 🧠 **Clean thinking-block rendering** so the AI reasoning process is visible above the answer body
- 🤖 **Support for 10+ AI model families** including OpenAI o1/o3, Grok, DeepSeek, Claude 3.7, Gemini, Qwen, Doubao, Zhipu, Kimi, and Hunyuan
- 📜 **Improved conversation history** so you can continue prior chats with full context
- 🛡️ **Better stability** through multiple bug fixes and stronger type-safety guards
- 🐛 **Better debug logging** with detailed SSE parsing and reasoning extraction traces

### Core capabilities

- 🤖 **AI chat assistant** for schematic analysis and design review
- 📊 **Automatic data collection** for components, pins, nets, and connectivity
- 🔗 **Pin-net binding** based on the netlist with confidence `1.0`
- 📝 **Netlist parsing** with support for `PROTEL NETLIST 2.0`
- ⚡ **Non-blocking architecture** with delayed netlist backfill to avoid disrupting user interaction
- 🎯 **Conservative analysis mode** that trusts the netlist and avoids false positives on NC pins

### User experience

- 📱 **Streaming responses** so the reasoning and answer appear in real time
- 🎯 **Smart jump-to-object navigation** from blue labels such as `U1` or `VCC`
- 📎 **Attachment upload support** for datasheets and related design files
- 📜 **Persistent chat history** so previous analysis stays available
- 🧠 **Visible reasoning output** for providers that support it
- 🛡️ **Secure rendering** with XSS protection and safe Markdown handling

---

## 🔌 MCP Data Exposure (new in v1.4.0)

Expose your schematic data in **read-only** form to external AI tools such as Cursor, Claude Code, and Codex over MCP.

### Architecture

```text
┌──────────────────────────────┐
│  EDA extension (sandboxed)   │
│  mcp-bridge.ts               │
└──────────┬───────────────────┘
           │ outbound WebSocket
           ▼
┌──────────────────────────────┐
│  eda-mcp-server (Node.js)    │
│  WS server + MCP server      │
└──────────┬───────────────────┘
           │ stdio transport
           ▼
┌──────────────────────────────┐
│  Cursor / Claude Code / Codex│
│  and other AI tools          │
└──────────────────────────────┘
```

### Quick usage

**1. Start the MCP server**

```bash
cd packages/eda-mcp-server
npm install
npm run build
node dist/index.js                              # default: 127.0.0.1:3100
node dist/index.js --host 0.0.0.0               # allow remote access
node dist/index.js --host 0.0.0.0 --port 3200   # custom port
```

**2. Configure the EDA extension**

Set the MCP Bridge URL in the plugin settings:

- Local: `ws://127.0.0.1:3100` (default)
- Remote: `ws://<server-ip>:3100`

**3. Configure your AI tool**

**Cursor** (`~/.cursor/mcp.json`)

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

**Claude Code** (`~/.claude/mcp.json`)

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

### Available resources

| URI | Description |
|-----|-------------|
| `eda://schematic/status` | Connection state, snapshot version, and timestamp |
| `eda://schematic/summary` | Component, pin, and net counts plus DRC summary |
| `eda://schematic/components` | Full component list |
| `eda://schematic/pins` | Full pin list |
| `eda://schematic/nets` | Full net list |
| `eda://schematic/drc` | DRC results |
| `eda://schematic/project-info` | Project metadata |
| `eda://schematic/netlist` | Raw netlist text |
| `eda://schematic/compact` | Compact serialized full snapshot |

### Available tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `schematic_status` | none | Return connection state and data version |
| `query_component` | `designator` | Query one component with its pins and nets |
| `query_net` | `netName` | Query a net and the connected pins or components |
| `search_schematic` | `keyword`, `type?` | Search the schematic by keyword |
| `configure_bridge` | `host?`, `port?` | Change the WS bind address dynamically |
| `get_bom` | `includeBomExcluded?` | Generate a BOM |
| `find_unconnected_pins` | `designator?` | Find floating pins, optionally for one component |
| `analyze_power_nets` | none | Analyze power-net topology |
| `check_drc` | none | Return a DRC summary |
| `refresh_data` | none | Request the extension to push a fresh snapshot |
| `trace_connectivity` | `from`, `to` | Trace an electrical path between two components |
| `list_components_by_type` | none | Group and summarize components by type |
| `get_netlist_raw` | none | Return the raw netlist |
| `get_pin_map` | `designator` | Return the pin map for a component |

---

## 🚀 Quick Start

### Installation

#### Option 1: Install from the Lichuang Open Source Plaza (recommended)

1. Open EasyEDA Pro.
2. Go to **Extensions -> Extension Manager**.
3. Search for `AI Schematic Assistant`.
4. Click install.
5. Restart EasyEDA Pro.

#### Option 2: Download from GitHub Releases

1. Open the [Releases](https://github.com/jifengshandian/easyeda-ai-assistant/releases) page.
2. Download the latest `.eext` file.
3. In EasyEDA Pro, go to **Extensions -> Extension Manager -> Install Local Extension**.
4. Select the downloaded `.eext` file.
5. Restart EasyEDA Pro.

#### Option 3: Build from source

```bash
# Clone the repository
git clone https://github.com/jifengshandian/easyeda-ai-assistant.git
cd easyeda-ai-assistant

# Install dependencies
npm install

# Build the extension
npm run build
```

### Usage

1. Open a schematic.
2. Click **AI Review -> AI Schematic Assistant...**
3. On first use, configure your AI API:
   - Click the settings button `⚙️`
   - Enter the API URL and API key
   - Choose a model (**Grok 4.2 is recommended**)
4. Start chatting with the AI.

### Example configuration

**Recommended configuration (Grok)**

- API URL: `https://api.x.ai/v1`
- Model: `grok-4.20-beta`
- API key: obtain one from [x.ai](https://x.ai)

**Other compatible APIs**

- OpenAI API (`gpt-5.2`)
- DeepSeek API (`deepseek-chat`)
- Google Gemini API (`gemini-3-flash`)
- OpenRouter (multi-model access such as `claude-sonnet-4.6`)
- Any OpenAI-compatible API

---

## 📖 Example Use Cases

### Use case 1: Schematic review

```text
You: Can you check whether there is anything wrong with this power supply circuit?

AI: I can see that your power circuit uses an LM2596 buck regulator...
    [Analyze the pin connections on U1]
    [Check decoupling capacitors C1 and C2]
    [Verify the divider ratio of feedback resistors R1 and R2]

    Suggestions:
    1. C1 should be placed closer to the VIN pin of U1
    2. The resistor divider ratio of R1 and R2 should be recalculated...
```

Click labels such as `U1` or `C1` in the conversation to jump directly to the right location in the schematic.

### Use case 2: Component selection

```text
You: I need an LDO to convert 5V to 3.3V. What would you recommend?

AI: [Searching component information online]
    Based on your schematic, the load current looks to be around 500 mA...
    I recommend AMS1117-3.3 for these reasons:
    1. Up to 1 A output current, which is enough here
    2. Low dropout voltage (1.2 V), so heat is manageable
    3. Compatible package and easy to source

    [Datasheet link attached]
```

### Use case 3: Debugging startup issues

```text
You: My STM32 will not boot. Can you take a look?

AI: Let me inspect the startup-related circuitry...
    [Analyze BOOT0 and BOOT1]
    [Check the reset circuit]
    [Verify power decoupling]

    Problems found:
    1. BOOT0 is floating and should be pulled down to GND
    2. NRST is missing a pull-up resistor
```

---

## 🛠️ Development

### Requirements

- **Node.js** >= `20.17.0`
- **npm** >= `9.0.0`
- **EasyEDA Pro** >= `3.0.0`

### Development workflow

```bash
# Install dependencies
npm install

# Build for development
npm run build

# Lint the code
npm run lint

# Auto-fix lint issues
npm run fix
```

### Project structure

```text
.
├── src/                      # Source code
│   ├── index.ts              # Extension entry point
│   └── review/               # AI review module
│       ├── types.ts          # Shared types
│       ├── config.ts         # Configuration management
│       ├── collector.ts      # Data collection
│       ├── mcp-bridge.ts     # MCP bridge (WS client)
│       ├── chat-adapter.ts   # AI communication
│       └── orchestrator.ts   # Flow orchestration
├── iframe/                   # Chat UI
│   └── chat.html
├── packages/                 # Standalone subprojects
│   └── eda-mcp-server/       # MCP server for schematic data exposure
│       ├── src/
│       │   ├── index.ts          # CLI entry point
│       │   ├── ws-bridge.ts      # Receives snapshots pushed by the extension
│       │   ├── snapshot-store.ts # In-memory snapshot storage
│       │   ├── mcp-server.ts     # Resource and tool registration
│       │   └── types.ts          # Shared types
│       └── package.json
├── docs/                     # Documentation
├── extension.json            # Extension manifest
├── package.json              # Project configuration
├── CHANGELOG.md              # Changelog
└── README.md                 # This file
```

---

## 📊 Roadmap

### Near-term plan

- [x] **MCP data exposure** so Cursor, Claude Code, Codex, and similar tools can read schematic data (`v1.4.0`)
- [x] **Multi-page schematic support** with page-by-page collection (`v1.0.0`)
- [x] **Expanded element coverage** for text annotations, buses, net labels, graphic primitives, and more (`v1.3.0`)
- [x] **Improved Markdown rendering** with GFM tables, code highlighting, footnotes, and related features (`v1.1.1`)

### Long-term plan

- [ ] Support more netlist formats such as `JLCEDA_PRO` and `EASYEDA_PRO`
- [ ] Add a rule engine for automatic detection of common design issues
- [ ] Add PCB review support
- [ ] Expand localization support
- [ ] Export review reports as PDF or Markdown

---

## 🤝 Contributing

Contributions are welcome. The plugin is already published on the Lichuang Open Source Plaza and on GitHub, and feedback from electronics developers and hobbyists is very welcome.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

### Contributors

Thanks to everyone who has contributed to the project.

<!-- ALL-CONTRIBUTORS-LIST:START -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 🐛 Bug Reports

If you find a bug or want to request a feature:

1. Check the [existing issues](https://github.com/jifengshandian/easyeda-ai-assistant/issues).
2. If there is no matching issue, [open a new one](https://github.com/jifengshandian/easyeda-ai-assistant/issues/new/choose).
3. Use the issue template and include enough detail to reproduce the problem.

---

## 💬 Discussions

Questions or ideas? Join the conversation in [Discussions](https://github.com/jifengshandian/easyeda-ai-assistant/discussions).

---

## 📖 Documentation

- [CHANGELOG.md](CHANGELOG.md) - version history
- [CONTRIBUTING.md](CONTRIBUTING.md) - contribution guide
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) - community guidelines
- [docs/implementation-summary.md](docs/implementation-summary.md) - implementation notes
- [docs/netlist-backfill-guide.md](docs/netlist-backfill-guide.md) - delayed netlist backfill guide
- [docs/testing-guide.md](docs/testing-guide.md) - testing scenarios and methods

---

## 📄 License

This project is licensed under the [Apache 2.0 License](LICENSE).

---

## 🙏 Acknowledgements

Thanks to the following projects and tools:

- [JLCEDA / EasyEDA Pro](https://pro.lceda.cn/) for the extension APIs
- [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) for the SDK foundation and API examples used by this project
- [jlc-eda-mcp](https://github.com/XuF163/jlc-eda-mcp) for architectural ideas behind the MCP data-exposure bridge
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) for the TypeScript MCP implementation
- [marked.js](https://marked.js.org/) for Markdown parsing
- [DOMPurify](https://github.com/cure53/DOMPurify) for XSS protection
- [Cherry Studio](https://github.com/kangfenmao/cherry-studio) for streaming-response inspiration

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jifengshandian/easyeda-ai-assistant&type=Date)](https://star-history.com/#jifengshandian/easyeda-ai-assistant&Date)

---

**Note:** this project is built on top of [pro-api-sdk](https://github.com/easyeda/pro-api-sdk), but it is an independent AI schematic assistant extension.

If this project helps you, consider giving it a star.
