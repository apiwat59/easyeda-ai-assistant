# 更新日志

本文档记录了 EasyEDA AI Assistant 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.2] - 2026-03-07

### 修复的问题 🐛

- 🐛 **修复 Thinking Block 收起/展开按钮在特定操作序列后失效** - 用户终止 AI 回答 → 刷新原理图 → 继续提问 → AI 回答完成后，点击思考过程的收起按钮无反应
  - 根本原因：展开状态仅存在于 DOM className（纯临时态），`renderMessages()` 全量重建 (`innerHTML = ''`) 后丢失；同时 `StreamManager` 的 RAF 回调可能在 DOM 重建后通过 `getElementById` 找到新 DOM 并覆写 className
  - 解决方案：将展开状态提升到数据层 `block.uiExpanded`，`createThinkingBlockElement` 根据数据决定初始 class，click handler 同步写回数据层
  - `StreamManager` 新增 `reset()` 方法（清空 `pendingUpdates` + `cancelAnimationFrame`），`renderMessages()` 开头调用，切断旧 RAF 回调对新 DOM 的覆写
  - 所有 thinking/text block 的 className 操作从字符串 `replace/indexOf/+=` 改为 `classList` API（`add/remove/contains`），消除边界条件风险
  - `createThinkingBlockElement` 非流式状态下使用 `parseMarkdown` 渲染内容（与 `StreamManager.applyUpdates` 保持一致）
  - `createTextBlockElement` paused 状态直接添加 `[已停止生成]` 标记

### 移除 ❌

- ❌ **移除最大化按钮** - 移除窗口标题栏的最大化按钮（有 bug），保留最小化按钮

---

## [1.3.1] - 2026-03-06

### 修复的问题 🐛

- 🐛 **修复 orchestrator 模块多实例导致的三重处理问题（关键修复）** - EDA 平台加载 orchestrator.ts 模块 3 次（3 个独立实例），每个实例注册各自的 MessageBus 订阅，导致用户每发一条消息触发 3 次 `handleUserMessage`、产生 3 个并行 AI 请求和 3 个独立响应
  - 根本原因：模块级变量（`requestGuard`、`listenerEpoch`、`chatSessions` 等 11 个状态）在多实例间不共享，每个实例独立持有自己的防重集合和版本号，各实例的 epoch 校验形同虚设
  - 解决方案：采用与 `collectionLock` (63615c8) 相同的 `globalThis` 模式，新增 `OrchestratorState` 接口和 `getOrchestratorState()` 初始化函数，将所有关键状态统一收敛到 `globalThis.__aiSchReview_orchestratorState`
  - 效果：3 个实例共享同一个 `listenerEpoch`，只有最后注册的订阅能通过 epoch 校验；`RequestGuard` 全局共享后，重复 `requestId` 被正确拦截

### 技术改进 🔧

- 🔧 新增 `OrchestratorState` 接口，定义 11 个跨实例共享的状态字段
- 🔧 新增 `getOrchestratorState()` 惰性初始化函数（与 `getGlobalCollectionLock()` 同模式）
- 🔧 扩展 `declare global` 块，新增 `__aiSchReview_orchestratorState` 全局变量声明
- 🔧 模块顶层通过 `const state = getOrchestratorState()` 获取共享引用，约 60+ 处引用更新

---

## [1.3.0] - 2026-03-05

### 新增功能 ✨

- ✨ **DRC 检查结果采集** - 调用 `eda.sch_Drc.check` 自动运行 DRC 检查，将违规信息提供给 AI 分析
- ✨ **工程元信息采集** - 通过 `eda.dmt_Project.getCurrentProjectInfo` 采集项目名称、描述等元信息
- ✨ **图形图元采集** - 支持圆弧（Arc）、圆（Circle）、多边形（Polygon）、矩形（Rect）等图形元素采集
- ✨ **独立引脚图元采集** - 通过 `eda.sch_PrimitivePin.getAll` 采集原理图中的独立引脚信息
- ✨ **SCH-REVIEW-COMPACT v2 序列化格式** - 新的数据序列化格式，向后兼容 v1
- ✨ **配置面板增强** - 新增"图形图元"和"增强数据"两个 checkbox 分组

### 设计要点 📐

- 📐 所有新字段默认关闭，不增加默认 Token 消耗
- 📐 7 个采集函数均有完整 try-catch 降级，不阻塞主流程
- 📐 DRC/ProjectInfo 与网表并行采集（全局数据，不依赖页面切换）
- 📐 图形图元在逐页循环中与现有采集并行执行

---

## [1.2.6] - 2026-02-28

### 改进 ✨

- ✨ **配置面板折叠分组** - 配置项按功能分为「基础配置」「MCP 工具网关」「原理图字段」「高级设置」四个可折叠分组，默认仅展开基础配置，减少视觉干扰
- ✨ **配置面板可滚动** - 模态框内容超出窗口高度时自动出现滚动条，不再溢出窗口
- ✨ **自定义系统提示词** - 支持在配置中添加自定义系统提示词，个性化 AI 回答风格（最多 5000 字）

### 技术改进 🔧

- 🔧 模态框采用 flex 布局 + `max-height: 80vh` 约束，适配不同窗口尺寸
- 🔧 折叠分组使用语义化 `<button>` 元素，支持 `aria-expanded` 无障碍属性
- 🔧 新增 `.modal-body`、`.config-section` 等 CSS 组件，结构清晰可维护

---

## [1.2.5] - 2026-02-23

### 修复的问题 🐛

- 🐛 **修复原理图刷新后 AI 无法感知数据变化（关键修复）** - 对话过程中修改原理图后点击刷新，AI 仍然依赖旧的分析结论回答问题
  - 根本原因：history 中保留了之前轮次基于旧数据的分析结论，AI 倾向于相信自己之前说过的话
  - 解决方案：刷新时向 history 注入包含数据摘要的 user+assistant 通知对，告知 AI 数据已变化，并在 system prompt 中增加"实时数据原则"指令
- 🐛 **修复 AI 重复回答问题** - 插件重新打开后，AI 对同一条消息产生两次完整回复
  - 根本原因：`emitCompleteBlocks` 在 `makeRequest`/`parseSSEResponse` 内部被调用，工具调用中间轮次也会触发
  - 解决方案：将 `emitCompleteBlocks` 上移到 `sendMessage` 的 while 循环中，仅在最终文本响应时触发
- 🐛 **修复 MCP 工具提示框重复显示** - 连续发送消息时，出现多个"工具调用中..."提示框
  - 根本原因：`ToolOrchestrator` 按 sessionId 缓存复用，但 requestId 在创建时固定，新消息的工具事件携带旧 requestId
  - 解决方案：添加 `updateRequestContext()` 方法，复用时更新 requestId
- 🐛 **修复插件重开后 handleUserMessage 被重复调用** - 关闭再打开插件后，用户消息被处理两次
  - 根本原因：EDA MessageBus 的 `cancel()` 可能无法取消已排队但未执行的旧回调
  - 解决方案：引入 `listenerEpoch` 版本号机制，旧版本订阅的回调在执行时自动丢弃
- 🐛 **修复重新生成功能被通知消息干扰** - 刷新后点击重新生成时，只移除了通知对而非真实的用户问答
  - 根本原因：`clear()` 方法将注入的通知消息视为普通用户消息
  - 解决方案：`clear()` 在查找回滚边界时跳过完整的数据更新通知对

### 技术改进 🔧

- 🔧 **System Prompt 模块化** - `buildChatSystemPrompt` 从 `chat-adapter.ts` 提取到独立的 `prompt-builder.ts`
- 🔧 **事件发送统一管控** - `emitCompleteBlocks` 调用由 `sendMessage` 统一控制，`callOpenAICompatibleChat`、`makeRequest`、`parseSSEResponse` 不再直接触发 UI 事件
- 🔧 **epoch 守卫全覆盖** - 版本号校验覆盖所有关键 MessageBus 订阅：USER_MESSAGE、ABORT_REQUEST、REGENERATE_REQUEST、CLEAR_SESSION、LOCATE、restore-session
- 🔧 **防重集合同步清理** - `clearAllChatSessions()` 同步清除 `processingRequests` 和 `completedRequests`，避免旧请求 ID 残留
- 🔧 **调试日志全覆盖** - 所有修改点均添加结构化调试日志，输出到 UI 调试面板

---

## [1.1.2] - 2026-02-20

### 修复的问题 🐛

- 🐛 **修复 Markdown 库加载失败（关键修复）** - marked.js 和 highlight.js 的 CDN 路径错误导致库加载失败，所有 Markdown 语法（包括表格）都无法渲染
  - 根本原因：marked@17.0.1 的 CDN 路径从 `/marked.min.js` 变为 `/lib/marked.umd.js`，highlight.js npm 包不含浏览器构建文件
  - 解决方案：实现 CDN + 本地双重加载策略，先尝试 CDN（快速），失败时自动回退到本地 vendor/ 文件
  - 添加详细的调试日志到 UI 调试面板，记录库加载状态和 Markdown 解析过程
  - 本地备份文件（~224KB）：marked、marked-footnote、DOMPurify、highlight.js 及 7 种语言包
  - 现在支持完整的 GFM 语法：表格、脚注、任务列表、代码高亮、嵌套格式等

---

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
