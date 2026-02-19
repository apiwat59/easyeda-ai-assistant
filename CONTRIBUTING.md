# 贡献指南

感谢你考虑为 EasyEDA AI Assistant 做出贡献！

## 行为准则

本项目采用 [Contributor Covenant](CODE_OF_CONDUCT.md) 行为准则。参与本项目即表示你同意遵守其条款。

## 如何贡献

### 报告 Bug

在提交 Bug 报告之前，请：

1. **检查现有 Issues** - 确保该问题尚未被报告
2. **使用最新版本** - 确认问题在最新版本中仍然存在
3. **提供详细信息** - 使用 Bug 报告模板，包含：
   - 清晰的标题和描述
   - 重现步骤
   - 预期行为 vs 实际行为
   - 环境信息（EasyEDA Pro 版本、操作系统等）
   - 调试日志（如果适用）
   - 截图或录屏（如果适用）

### 提出功能建议

功能建议应该：

1. **明确具体** - 清楚描述你想要什么功能
2. **解释动机** - 说明为什么需要这个功能
3. **提供示例** - 如果可能，提供使用场景或示例
4. **考虑替代方案** - 是否有其他方式实现相同目标

### 提交代码

#### 开发流程

1. **Fork 仓库**
   ```bash
   # 在 GitHub 上 Fork 仓库
   git clone https://github.com/YOUR_USERNAME/easyeda-ai-assistant.git
   cd easyeda-ai-assistant
   ```

2. **创建分支**
   ```bash
   git checkout -b feature/your-feature-name
   # 或
   git checkout -b fix/your-bug-fix
   ```

3. **安装依赖**
   ```bash
   npm install
   ```

4. **进行修改**
   - 遵循代码规范（见下文）
   - 添加必要的测试
   - 更新相关文档

5. **测试修改**
   ```bash
   npm run build
   # 在 EasyEDA Pro 中测试扩展
   ```

6. **提交更改**
   ```bash
   git add .
   git commit -m "feat: add amazing feature"
   ```

7. **推送到 GitHub**
   ```bash
   git push origin feature/your-feature-name
   ```

8. **创建 Pull Request**
   - 在 GitHub 上创建 PR
   - 填写 PR 模板
   - 等待代码审查

#### 代码规范

**TypeScript 规范**

- 使用 TypeScript 严格模式
- 所有函数必须有类型注解
- 避免使用 `any`，优先使用具体类型
- 使用接口（interface）定义数据结构

**命名规范**

- 变量/函数：`camelCase`
- 类/接口：`PascalCase`
- 常量：`UPPER_SNAKE_CASE`
- 私有成员：前缀 `_`（如 `_privateMethod`）

**代码风格**

- 使用 Tab 缩进
- 使用 ESLint 自动格式化：`npm run fix`
- 函数长度不超过 50 行（复杂逻辑除外）
- 单个文件不超过 500 行

**注释规范**

```typescript
/**
 * 函数功能描述
 *
 * @param param1 - 参数1说明
 * @param param2 - 参数2说明
 * @returns 返回值说明
 */
function exampleFunction(param1: string, param2: number): boolean {
    // 实现逻辑
    return true;
}
```

#### 提交信息规范

使用语义化提交信息（Conventional Commits）：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type 类型**

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具链更新

**示例**

```
feat(collector): 添加保守模式Pin-Net绑定策略

禁用L2/L3/L4策略以避免假阳性，只使用L1网表绑定。
这解决了NC引脚被错误绑定到附近导线的问题。

Closes #123
```

**必须包含**

每次提交必须包含：
```
Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

#### Pull Request 规范

**PR 标题**

- 使用语义化提交格式
- 简洁明了（< 70 字符）

**PR 描述**

必须包含：

1. **变更摘要** - 简要说明做了什么
2. **动机和背景** - 为什么需要这个变更
3. **测试计划** - 如何验证这个变更
4. **截图/录屏** - 如果是 UI 变更
5. **相关 Issue** - 使用 `Closes #123` 关联

**PR 检查清单**

- [ ] 代码遵循项目规范
- [ ] 已添加必要的注释
- [ ] 已更新相关文档
- [ ] 已在 EasyEDA Pro 中测试
- [ ] 提交信息符合规范
- [ ] 已解决所有 ESLint 警告

### 文档贡献

文档同样重要！你可以：

- 修正拼写/语法错误
- 改进现有文档的清晰度
- 添加缺失的文档
- 翻译文档到其他语言

## 开发环境设置

### 必需工具

- **Node.js** >= 20.17.0
- **npm** >= 9.0.0
- **EasyEDA Pro** >= 3.0.0
- **Git**

### 推荐工具

- **VS Code** - 推荐的代码编辑器
- **ESLint 扩展** - 实时代码检查
- **TypeScript 扩展** - 类型检查支持

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
├── extension.json         # 扩展配置
├── package.json           # 项目配置
└── README.md             # 项目说明
```

### 调试技巧

**启用调试日志**

在 EasyEDA Pro 中：
1. 打开 AI 助手面板
2. 点击右上角 🐛 按钮
3. 查看详细的采集和绑定日志

**常见问题**

1. **扩展未加载** - 检查 `extension.json` 格式
2. **构建失败** - 运行 `npm install` 重新安装依赖
3. **类型错误** - 确保使用最新的 `@jlceda/pro-api-types`

## 代码审查流程

所有 PR 都需要经过代码审查：

1. **自动检查** - ESLint、TypeScript 编译
2. **人工审查** - 至少一位维护者审查
3. **测试验证** - 在实际环境中测试
4. **文档检查** - 确保文档已更新

**审查标准**

- 代码质量和可读性
- 是否遵循项目规范
- 是否有充分的测试
- 是否有必要的文档
- 是否有潜在的性能问题
- 是否有安全隐患

## 发布流程

（仅限维护者）

1. 更新 `CHANGELOG.md`
2. 更新版本号（`package.json` 和 `extension.json`）
3. 创建 Git tag：`git tag v1.0.0`
4. 推送 tag：`git push origin v1.0.0`
5. GitHub Actions 自动构建和发布

## 获取帮助

如果你有任何问题：

- 📖 查看 [文档](docs/)
- 💬 在 [Discussions](https://github.com/jifengshandian/easyeda-ai-assistant/discussions) 提问
- 🐛 在 [Issues](https://github.com/jifengshandian/easyeda-ai-assistant/issues) 报告问题

## 许可证

通过贡献代码，你同意你的贡献将在 [Apache 2.0 许可证](LICENSE) 下发布。

---

再次感谢你的贡献！🎉
