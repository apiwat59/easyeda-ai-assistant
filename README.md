# EasyEDA AI Assistant

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![EasyEDA Pro](https://img.shields.io/badge/EasyEDA%20Pro-3.0%2B-green.svg)](https://pro.lceda.cn/)
[![GitHub Issues](https://img.shields.io/github/issues/jifengshandian/easyeda-ai-assistant)](https://github.com/jifengshandian/easyeda-ai-assistant/issues)
[![GitHub Stars](https://img.shields.io/github/stars/jifengshandian/easyeda-ai-assistant)](https://github.com/jifengshandian/easyeda-ai-assistant/stargazers)

> AI-powered schematic review and chat assistant for EasyEDA Pro

基于嘉立创 EDA 专业版的 AI 原理图审查与对话助手，支持智能原理图分析、Pin-Net 绑定和对话式交互。

[English](README.en.md) | 简体中文

## ✨ 功能特性

### 核心功能

- 🤖 **AI 对话助手** - 与 AI 对话，分析原理图设计
- 📊 **智能数据采集** - 自动采集原理图数据（器件、引脚、网络）
- 🔗 **Pin-Net 绑定** - 基于网表的引脚-网络绑定（置信度 1.0）
- 📝 **网表解析** - 支持 PROTEL NETLIST 2.0 格式
- ⚡ **非阻塞设计** - 网表延迟回填，不阻塞用户操作
- 🎯 **保守模式** - 避免 NC 引脚假阳性，只信任网表
- 📱 **流式响应** - 实时显示 AI 思考过程和回答
- 🛡️ **安全防护** - XSS 防护，Markdown 安全渲染

### Pin-Net 绑定策略

| 策略 | 数据源 | 置信度 | 说明 |
|------|--------|--------|------|
| L1 | 网表（Netlist） | 1.0 | 最权威，来自 EDA 网表生成器 |

**保守模式**：禁用 L2/L3/L4 策略，避免将 NC（悬空）引脚错误绑定到附近导线。

### 网表延迟回填机制

解决大型原理图网表获取超时（10秒）导致引脚无法绑定的问题：

```
主流程：超时后继续 → 用户可立即开始对话
后台流程：网表继续获取 → 完成后自动回填 → 提升置信度到 1.0
```

## 🚀 快速开始

### 安装

#### 方式 1：从源码构建

```bash
# 克隆仓库
git clone https://github.com/jifengshandian/easyeda-ai-assistant.git
cd easyeda-ai-assistant

# 安装依赖
npm install

# 构建扩展
npm run build
```

#### 方式 2：下载发布版本

从 [Releases](https://github.com/jifengshandian/easyeda-ai-assistant/releases) 页面下载最新版本。

### 在 EasyEDA Pro 中安装

1. 打开嘉立创 EDA 专业版
2. 进入 **扩展 → 扩展管理器**
3. 点击 **安装本地扩展**
4. 选择 `build/dist/` 目录下的扩展包（或下载的 `.zip` 文件）
5. 重启 EasyEDA Pro

### 使用

1. 打开原理图
2. 点击菜单 **AI Review → AI 原理图助手...**
3. 首次使用需要配置 AI API：
   - 点击配置按钮 ⚙️
   - 填写 API URL 和 API Key
   - 选择模型
4. 开始与 AI 对话！

## 📖 文档

- [贡献指南](CONTRIBUTING.md) - 如何参与贡献
- [行为准则](CODE_OF_CONDUCT.md) - 社区行为准则
- [更新日志](CHANGELOG.md) - 版本历史
- [功能实现总结](docs/implementation-summary.md) - 技术细节
- [网表延迟回填指南](docs/netlist-backfill-guide.md) - 延迟回填机制
- [测试验证指南](docs/testing-guide.md) - 测试场景和方法
- [项目开发指南](CLAUDE.md) - 开发规范和约束

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
│       ├── chat-adapter.ts # AI 通信
│       └── orchestrator.ts # 流程编排
├── iframe/                # 对话 UI
│   └── chat.html
├── docs/                  # 文档
├── .github/               # GitHub 配置
│   ├── ISSUE_TEMPLATE/   # Issue 模板
│   ├── workflows/        # CI/CD 工作流
│   └── pull_request_template.md
├── extension.json         # 扩展配置
├── package.json           # 项目配置
├── CONTRIBUTING.md        # 贡献指南
├── CODE_OF_CONDUCT.md     # 行为准则
├── CHANGELOG.md           # 更新日志
└── README.md             # 本文件
```

## 🤝 贡献

欢迎贡献！请查看 [贡献指南](CONTRIBUTING.md) 了解如何参与。

### 贡献者

感谢所有贡献者的付出！

<!-- ALL-CONTRIBUTORS-LIST:START -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

## 🐛 问题反馈

如果你发现了 Bug 或有功能建议，请：

1. 查看 [现有 Issues](https://github.com/jifengshandian/easyeda-ai-assistant/issues)
2. 如果没有相关 Issue，[创建新 Issue](https://github.com/jifengshandian/easyeda-ai-assistant/issues/new/choose)
3. 使用 Issue 模板，提供详细信息

## 💬 讨论

有问题或想法？欢迎在 [Discussions](https://github.com/jifengshandian/easyeda-ai-assistant/discussions) 讨论！

## 📊 路线图

- [ ] 支持更多网表格式（JLCEDA_PRO、EASYEDA_PRO）
- [ ] 添加规则引擎，自动检测常见设计问题
- [ ] 支持 PCB 审查
- [ ] 多语言支持（英文、日文）
- [ ] 导出审查报告（PDF、Markdown）

## 📄 许可证

本项目采用 [Apache 2.0 许可证](LICENSE)。

## 🙏 致谢

感谢以下项目和工具：

- [嘉立创 EDA](https://pro.lceda.cn/) - 提供扩展 API
- [marked.js](https://marked.js.org/) - Markdown 解析
- [DOMPurify](https://github.com/cure53/DOMPurify) - XSS 防护
- [Cherry Studio](https://github.com/kangfenmao/cherry-studio) - 流式响应参考

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jifengshandian/easyeda-ai-assistant&type=Date)](https://star-history.com/#jifengshandian/easyeda-ai-assistant&Date)

---

**注意**：本项目基于 [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) 开发，是一个独立的 AI 原理图助手扩展实现。

如果这个项目对你有帮助，请给个 ⭐️ Star！
