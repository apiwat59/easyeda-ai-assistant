# AI 原理图助手 - EasyEDA Pro 扩展

基于嘉立创 EDA 专业版的 AI 原理图审查与对话助手，支持智能原理图分析、Pin-Net 绑定和对话式交互。

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.x-blue.svg)](https://www.typescriptlang.org/)
[![EasyEDA Pro](https://img.shields.io/badge/EasyEDA%20Pro-Compatible-green.svg)](https://pro.lceda.cn/)

## 功能特性

### 核心功能

- ✅ **多页原理图数据采集** - 完全逐页采集策略，支持跨页数据提取
- ✅ **智能 Pin-Net 绑定** - 四级策略（L1-L4），置信度 0.6-1.0
- ✅ **网表延迟回填** - 非阻塞设计，后台自动回填，解决网表超时问题
- ✅ **导线拓扑分析** - Union-Find 算法构建拓扑图，推断连接关系
- ✅ **网络标记识别** - 自动识别 GND、VCC 等网络标记
- ✅ **插件自动启动** - 文档变化自动检测，后台智能采集
- ✅ **Markdown 渲染** - 支持完整 Markdown 语法，XSS 防护
- ✅ **详细调试日志** - 完整的采集和绑定日志，支持调试面板

### Pin-Net 绑定策略

| 策略 | 数据源 | 置信度 | 说明 |
|------|--------|--------|------|
| L1 | 网表（Netlist） | 1.0 | 最权威，来自 EDA 网表生成器 |
| L2 | 导线坐标邻近性 | 0.9 | 通过导线的 net 属性匹配 |
| L3 | 网络标记坐标邻近性 | 0.8 | 通过 GND/VCC 等标记匹配 |
| L4 | 导线拓扑分析 | 0.6 | 通过导线连通性推断 |

### 网表延迟回填机制

解决大型原理图网表获取超时（10秒）导致引脚无法绑定的问题：

```
主流程：超时后继续 → 使用 L2/L3/L4 策略
后台流程：网表继续获取 → 完成后自动回填 → 提升置信度到 1.0
```

**效果**：
- 新绑定：未绑定引脚 → L1 策略
- 改进：L2/L3/L4 → L1 策略
- 最终：所有引脚绑定，置信度 1.0

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 构建扩展

```bash
npm run build
```

### 3. 在 EDA 中安装

1. 打开嘉立创 EDA 专业版
2. 进入 **扩展 → 扩展管理器**
3. 点击 **安装本地扩展**
4. 选择 `build/dist/` 目录下的扩展包

### 4. 使用扩展

1. 打开原理图
2. 点击菜单 **AI Review → AI Schematic Chat...**
3. 配置 AI API（首次使用）
4. 开始对话

## 配置说明

### AI 配置

点击菜单 **AI Review → AI Config** 配置 AI API：

- **API URL**: OpenAI 兼容的 API 地址
- **API Key**: 你的 API 密钥
- **Model**: 使用的模型（如 gpt-4, claude-3-opus 等）

### 调试日志

按 **Ctrl+D** 或点击 **🐛** 按钮打开调试日志面板，查看：
- 采集过程日志
- Pin-Net 绑定详情
- 网表回填状态
- 性能统计

## 性能指标

### 采集性能

| 原理图规模 | 器件数 | 引脚数 | 采集时间 | 网表时间 |
|-----------|--------|--------|---------|---------|
| 小型      | < 50   | < 200  | 2-5 秒  | 1-3 秒  |
| 中型      | 50-200 | 200-1000 | 8-15 秒 | 5-15 秒 |
| 大型      | > 200  | > 1000 | 15-30 秒 | 15-60 秒 |

### Pin-Net 绑定效果

测试原理图：200 个器件，800 个引脚

- 网表超时前：589 个引脚（L1，置信度 1.0）
- 网表超时后：200 个引脚（L2/L3/L4，置信度 0.6-0.9）
- 网表回填后：800 个引脚（全部 L1，置信度 1.0）
- 改进效果：+211 个引脚绑定，+200 个引脚置信度提升

## 项目结构

```
.
├── src/
│   ├── index.ts                 # 扩展入口
│   └── review/
│       ├── types.ts             # 类型定义
│       ├── config.ts            # 配置管理
│       ├── collector.ts         # 数据采集
│       ├── serializer.ts        # 数据序列化
│       ├── chunker.ts           # 分块策略
│       ├── prompt-builder.ts    # AI Prompt 构建
│       ├── chat-adapter.ts      # AI 通信适配器
│       └── orchestrator.ts      # 流程编排
├── iframe/
│   └── chat.html                # 对话 UI
├── docs/
│   ├── implementation-summary.md    # 功能总结
│   ├── netlist-backfill-guide.md   # 延迟回填详细说明
│   ├── testing-guide.md            # 测试验证指南
│   └── session-summary.md          # 会话总结
├── extension.json               # 扩展配置
└── README.md                    # 本文件
```

## 文档

- [功能实现总结](docs/implementation-summary.md) - 完整的功能说明和技术细节
- [网表延迟回填指南](docs/netlist-backfill-guide.md) - 延迟回填机制详细说明
- [测试验证指南](docs/testing-guide.md) - 完整的测试场景和验证方法
- [项目开发指南](CLAUDE.md) - 开发规范和约束

## 开发

### 开发环境

- Node.js >= 14
- TypeScript >= 4.x
- EasyEDA Pro >= 2.x

### 构建命令

```bash
# 安装依赖
npm install

# 开发构建
npm run build

# 清理构建产物
npm run clean
```

### 代码规范

- 使用 ESLint 进行代码检查
- 使用 TypeScript 严格模式
- 遵循语义化提交规范

### 提交规范

```
feat: 新功能
fix: Bug 修复
docs: 文档更新
refactor: 重构
test: 测试
chore: 构建/工具链
```

每次提交必须包含：
```
Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

## 测试

### 测试场景

1. 网表快速完成（< 10 秒）
2. 网表超时但最终成功（10-60 秒）
3. 网表超时且失败（> 60 秒）
4. Epoch 版本控制
5. 插件自动启动
6. 切换原理图自动重新采集

详细测试步骤请参考 [测试验证指南](docs/testing-guide.md)。

## 故障排查

### 问题：网表一直超时

**可能原因**：
- 原理图过大（> 500 个器件）
- EDA 性能问题

**解决方案**：
- 增加超时时间（修改 `NETLIST_TIMEOUT_MS`）
- 增加轮询最大次数（修改 `MAX_POLL_COUNT`）

### 问题：回填没有生效

**可能原因**：
- 网表解析失败
- Epoch 版本过期

**排查步骤**：
1. 检查调试日志中的 "网表解析完成" 消息
2. 检查是否有 "epoch 已过期" 警告
3. 检查 `netlistMap.size` 是否为 0

更多问题请参考 [网表延迟回填指南](docs/netlist-backfill-guide.md)。

## 技术亮点

### 1. 非阻塞设计

- 主流程不等待网表完成
- 用户可以立即开始对话
- 后台自动回填，无感知

### 2. Epoch 版本控制

- 避免过期任务覆盖新任务
- 支持多次重新采集
- 确保数据一致性

### 3. 四级 Pin-Net 绑定策略

- L1（网表）：最权威，置信度 1.0
- L2（导线）：坐标邻近性，置信度 0.9
- L3（标记）：网络标记，置信度 0.8
- L4（拓扑）：导线连通性，置信度 0.6

### 4. 完整的错误处理

- 网表获取失败不影响主流程
- 超时自动放弃，不阻塞
- 详细的日志记录

## 贡献

欢迎提交 Issue 和 Pull Request！

### 贡献指南

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'feat: Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 许可证

本项目采用 Apache 2.0 许可证 - 详见 [LICENSE](LICENSE) 文件。

## 致谢

- [嘉立创 EDA](https://pro.lceda.cn/) - 提供扩展 API
- [marked.js](https://marked.js.org/) - Markdown 解析
- [DOMPurify](https://github.com/cure53/DOMPurify) - XSS 防护

## 联系方式

- 项目主页：[GitHub](https://github.com/easyeda/pro-api-sdk)
- 问题反馈：[Issues](https://github.com/easyeda/pro-api-sdk/issues)
- 官方文档：[https://prodocs.lceda.cn/](https://prodocs.lceda.cn/)

---

**注意**：本项目基于 [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) 开发，是一个 AI 原理图助手扩展的实现。
