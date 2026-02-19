# 更新日志

本文档记录了 EasyEDA AI Assistant 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-02-19

### 首次发布 🎉

这是 EasyEDA AI Assistant 的首个正式版本，提供完整的 AI 原理图审查和对话功能。

### 新增功能

#### 核心功能
- ✅ **多页原理图数据采集** - 完全逐页采集策略，支持跨页数据提取
- ✅ **智能 Pin-Net 绑定** - 保守模式，只使用 L1 网表绑定（置信度 1.0）
- ✅ **网表延迟回填** - 非阻塞设计，后台自动回填，解决网表超时问题
- ✅ **PROTEL NETLIST 2.0 解析** - 支持嘉立创 EDA 网表格式
- ✅ **网络标记识别** - 自动识别 GND、VCC 等网络标记
- ✅ **插件自动启动** - 文档变化自动检测，后台智能采集

#### Pin-Net 绑定策略
- **L1 网表**（置信度 1.0）- 最权威，来自 EDA 网表生成器
- **保守模式** - 禁用 L2/L3/L4 策略，避免 NC 引脚假阳性

#### 用户界面
- ✅ **对话式交互** - 流式 AI 响应，支持 thinking 和 text 分离显示
- ✅ **Markdown 渲染** - 完整 Markdown 语法支持，XSS 防护
- ✅ **停止生成** - 随时中止 AI 响应
- ✅ **重新生成** - 重新生成最后一条消息
- ✅ **历史会话** - 自动保存对话历史
- ✅ **调试面板** - 详细的采集和绑定日志

#### 配置管理
- ✅ **多 AI 提供商支持** - OpenAI 兼容 API
- ✅ **自定义 API 端点** - 支持自托管 AI 服务
- ✅ **配置持久化** - localStorage 存储配置

### 修复的问题

#### 网表解析
- 🐛 修复 PROTEL NETLIST 2.0 格式 pinNumber 提取错误
  - 问题：网表行格式为 "U4-18 RTL8723模组-CHIP_EN Input"，解析器将整行作为 pinNumber
  - 影响：所有引脚未绑定，nets 统计为 0
  - 解决：只提取第一个空格之前的部分作为 pinNumber

- 🐛 修复 JLCEDA_PRO 格式导致网表 API 超时问题
  - 问题：切换到 JLCEDA_PRO 格式后，网表 API 在 10 秒和 60 秒都超时
  - 解决：切回 PROTEL2 格式（4ms 内返回数据）

#### Pin-Net 绑定
- 🐛 启用保守模式，禁用 L2/L3/L4 引脚绑定策略
  - 问题：L2/L3/L4 策略会将 NC（悬空）引脚错误绑定到附近导线
  - 影响：约 80-100 个 NC 引脚被错误标记为已连接（假阳性）
  - 解决：只使用 L1 网表绑定，NC 引脚正确标记为未绑定

### 技术亮点

#### 非阻塞设计
- 主流程不等待网表完成（10秒超时）
- 用户可以立即开始对话
- 后台自动回填，无感知

#### Epoch 版本控制
- 避免过期任务覆盖新任务
- 支持多次重新采集
- 确保数据一致性

#### 完整的错误处理
- 网表获取失败不影响主流程
- 超时自动放弃，不阻塞
- 详细的日志记录

### 已知限制

- 大型原理图（> 500 个器件）网表获取可能超时
- NC（悬空）引脚会显示为未绑定（这是预期行为）
- 仅支持 PROTEL2 网表格式

### 文档

- 📖 [README](README.md) - 项目概述和快速开始
- 📖 [贡献指南](CONTRIBUTING.md) - 如何参与贡献
- 📖 [行为准则](CODE_OF_CONDUCT.md) - 社区行为准则
- 📖 [功能实现总结](docs/implementation-summary.md) - 技术细节
- 📖 [网表延迟回填指南](docs/netlist-backfill-guide.md) - 延迟回填机制
- 📖 [测试验证指南](docs/testing-guide.md) - 测试场景和方法
- 📖 [项目开发指南](CLAUDE.md) - 开发规范和约束

### 致谢

感谢以下项目和工具：
- [嘉立创 EDA](https://pro.lceda.cn/) - 提供扩展 API
- [marked.js](https://marked.js.org/) - Markdown 解析
- [DOMPurify](https://github.com/cure53/DOMPurify) - XSS 防护
- [Cherry Studio](https://github.com/kangfenmao/cherry-studio) - 流式响应参考

---

## 版本说明

### 版本号格式

版本号格式：`主版本号.次版本号.修订号`

- **主版本号**：不兼容的 API 变更
- **次版本号**：向下兼容的功能新增
- **修订号**：向下兼容的问题修正

### 变更类型

- `Added` - 新增功能
- `Changed` - 功能变更
- `Deprecated` - 即将废弃的功能
- `Removed` - 已移除的功能
- `Fixed` - Bug 修复
- `Security` - 安全相关

---

[1.0.0]: https://github.com/jifengshandian/easyeda-ai-assistant/releases/tag/v1.0.0
