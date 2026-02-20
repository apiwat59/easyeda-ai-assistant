# 更新日志

本文档记录了 EasyEDA AI Assistant 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.1] - 2026-02-20

### 新增功能 ✨

- ✨ **窗口大小可配置** - 在界面设置中调整窗口尺寸（宽度 400-3840px，高度 300-2160px），保存后下次打开生效
- ✨ **最大化/最小化按钮** - 窗口标题栏新增最大化和最小化按钮
- ✨ **UI 设置独立** - 右上角齿轮图标 ⚙️ 打开界面设置面板，与 AI 配置分离
- ✨ **代码语法高亮** - 使用 highlight.js 11.10.0 为代码块添加语法高亮
  - 支持 JavaScript、Python、TypeScript、JSON、Bash、C/C++ 等常用语言
  - GitHub Dark 主题
- ✨ **Markdown 渲染增强**
  - 升级 marked.js: 11.0.0 → 17.0.1（最新版本）
  - 升级 DOMPurify: 3.0.6 → 3.0.11（最新安全版本）
  - 启用 GFM（GitHub Flavored Markdown）支持
  - 优化 DOMPurify 配置，防止误删标题内粗体等内容
  - 新增脚注支持（marked-footnote 1.4.0）- 支持 `[^1]` 和 `[^复杂脚注]` 语法
  - 新增脚注区域样式（分隔线+缩小字号+辅助色）
  - 新增任务列表样式（checkbox 勾选框）
  - 新增删除线、水平线、嵌套块引用、图片自适应样式
  - 使用 Marked 实例 API（`new marked.Marked().use()`）替代全局 `marked.setOptions()`

### 修复的问题 🐛

- 🐛 **修复图片上传失败（502 错误）** - 上传图片前自动压缩（最大 1024px，JPEG 质量 0.75），解决代理服务拒绝大图片的问题
- 🐛 **修复 data URL 重复前缀** - 修复图片 URL 拼接时可能出现 `data:image/jpeg;base64,data:image/jpeg;base64,...` 的问题
- 🐛 **修复重复回答问题** - 代理服务器对同一请求发送两次时，第二次响应会被正确忽略
- 🐛 **修复按钮间距** - 齿轮和调试按钮现在紧挨着（gap: 6px）
- 🐛 **修复 Markdown 渲染错误** - 优化 DOMPurify 白名单配置，确保 `### 1. **标题内粗体**` 等复杂语法正确显示
- 🐛 **修复 Markdown 库加载失败（关键修复）** - marked.js 和 highlight.js 的 CDN 路径错误导致库加载失败，所有 Markdown 语法（包括表格）都无法渲染
  - 根本原因：marked@17.0.1 的 CDN 路径从 `/marked.min.js` 变为 `/lib/marked.umd.js`，highlight.js npm 包不含浏览器构建文件
  - 解决方案：实现 CDN + 本地双重加载策略，先尝试 CDN（快速），失败时自动回退到本地 vendor/ 文件
  - 添加详细的调试日志到 UI 调试面板，记录库加载状态和 Markdown 解析过程
  - 本地备份文件（~224KB）：marked、marked-footnote、DOMPurify、highlight.js 及 7 种语言包

---

## [1.1.0] - 2026-02-19

### 主要改进 ✨

#### Thinking Block 完美显示
- ✅ **Thinking 内容正确显示在正文上方** - 修复了 thinking block 显示在正文下方的问题
- ✅ **显示"AI已深度思考"** - 不再显示不准确的秒数，改为简洁的状态提示
- ✅ **完整提取思考过程内容** - 支持 Grok 等模型的 reasoning 内容提取

#### 支持更多 AI 模型
- ✅ **OpenAI o1/o3** - 完美支持 `reasoningEffort` 参数
- ✅ **Grok** - 完美支持通过 `<think>` 标签提取 reasoning
- ✅ **DeepSeek** - 支持通过 SSE `delta.reasoning_content` 提取
- ✅ **Claude 3.7 Sonnet** - 支持 `thinking` 参数和 `delta.thinking` 字段
- ✅ **Gemini 2.0/3.0** - 支持 `thinking_config` 参数和 `delta.thoughts` 字段
- ✅ **Qwen (通义千问)** - 支持 `enable_thinking` 参数
- ✅ **Doubao (豆包)** - 支持 `thinking.type` 参数
- ✅ **Zhipu (智谱)** - 支持 `enable_thinking` 参数
- ✅ **Kimi** - 支持 `enable_thinking` 参数
- ✅ **Hunyuan (混元)** - 支持 `enable_thinking` 参数
- ✅ **自动检测响应格式** - 智能适配 SSE/JSON 格式
- ✅ **统一 reasoning 提取** - 支持所有模型的不同字段名（reasoning_content, reasoning, thinking, thoughts）

#### 历史会话功能增强
- ✅ **支持从历史会话继续对话** - 保持完整上下文
- ✅ **移除干扰提示** - 不再显示"提示：您正在查看历史会话..."
- ✅ **后端自动重建对话历史** - 无缝恢复会话状态

#### 稳定性大幅提升
- ✅ **修复 TypeError** - `Cannot read properties of undefined (reading 'length')`
- ✅ **修复 requestId 重复处理** - 同一个 requestId 不会被重复处理
- ✅ **修复并发场景下的历史回滚错误** - 添加全面的类型安全防护
- ✅ **修复 block 排序逻辑** - thinking block 现在正确显示在正文上方

#### 调试体验优化
- ✅ **所有关键日志输出到调试日志面板** - 方便开发者和用户排查问题
- ✅ **详细记录 SSE 解析过程** - 包括 reasoning 提取的完整日志
- ✅ **详细记录 block 排序过程** - 帮助诊断显示顺序问题

### 技术改进 🔧

#### SSE 解析重构
- **三阶段解析** - 累积 → 提取标签 → 发送事件
- **支持多种 reasoning 格式** - `<think>`, `<thought>`, `<thinking>`, SSE `delta.reasoning_content`
- **响应格式自动检测** - 智能判断 SSE 或 JSON 格式

#### 类型安全增强
- **添加 `coerceToString()` 函数** - 防御性类型转换
- **完善错误处理** - 避免 undefined/null 导致的崩溃

#### 前端渲染优化
- **修复 blocks 排序逻辑** - 确保 thinking → text → error 的正确顺序
- **优化时间显示** - 移除不准确的秒数显示

### 修复的问题 🐛

- 🐛 **修复 thinking block 显示在正文下方** - 排序逻辑错误导致
- 🐛 **修复 thinking 时间显示为 0 秒** - 改为显示"AI已深度思考"
- 🐛 **修复 Grok 模型 reasoning 内容不完整** - 恢复 `stream: true` 模式
- 🐛 **修复缓存导致的 TypeError** - 添加防御性类型检查
- 🐛 **修复历史会话无法继续对话** - 实现 restore-session 监听器

### 已知问题

- 部分 AI 模型可能不支持 reasoning 内容提取（会正常显示文本内容）
- 历史会话恢复时不包含 thinking 内容（仅恢复文本对话）

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
