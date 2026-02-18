# Claude Code 项目指南

## 项目概述

这是一个基于嘉立创EDA专业版扩展API的AI原理图审查工具，支持对话式AI交互。

## 核心架构

### 后端架构
- **会话隔离**：使用 `Map<sessionId, ChatSession>` 管理多个独立对话会话
- **MessageBlock 架构**：消息由多个 block 组成（thinking + text + error）
- **SSE 流式解析**：区分 `reasoning_content` 和 `content`，支持完整的生命周期事件
- **Abort/Regenerate 支持**：每个请求有独立的 AbortController

### 前端架构
- **Block-based 渲染**：消息包含 blocks 数组，支持 thinking/text/error 三种类型
- **RAF 批量更新**：使用 `requestAnimationFrame` 批量处理 DOM 更新
- **流式状态管理**：完整的 START/DELTA/COMPLETE 生命周期

## 关键功能

### 1. 停止生成（Abort）
- 发送按钮在生成时切换为红色停止按钮
- 后端发送 `THINKING_COMPLETE(paused)` 和 `TEXT_COMPLETE(paused)` 两个事件
- **重要**：前端只在 `TEXT_COMPLETE(paused)` 时清理状态，避免截断双事件

### 2. 重新生成（Regenerate）
- 仅在当前会话有效、非 thinking、非 transient 消息时显示
- 后端调用 `session.clear()` 回滚最后一轮对话

### 3. 错误处理
- 错误使用红色卡片显示，支持查看 JSON 详情
- 所有错误内容通过 `escapeHtml` 处理，防止 XSS

### 4. ThinkingBlock 优化
- 流式时自动展开，完成/暂停后自动折叠
- 支持复制思考内容
- paused 状态显示"已停止思考（x 秒）"

## 重要约束和规则

### ⚠️ 禁止设置的安全限制

**严禁**在代码中添加以下类型的 API Key 安全限制：

1. ❌ **禁止拦截 apiKey 字段通过 MessageBus 传输**
   ```typescript
   // 错误示例 - 不要这样做
   if ('apiKey' in data) {
       throw new Error('安全限制：API Key 不能通过消息总线更新');
   }
   ```

2. ❌ **禁止在配置回传时掩码 API Key**
   ```typescript
   // 错误示例 - 不要这样做
   apiKey: config.apiKey ? '***已配置***' : ''
   ```

3. ❌ **禁止在前端拦截 API Key 输入**
   ```javascript
   // 错误示例 - 不要这样做
   if (newApiKey) {
       alert('出于安全考虑，请使用扩展配置入口设置 API Key');
       return;
   }
   ```

**原因**：用户明确要求允许通过 IFrame 配置弹窗直接设置 API Key，不需要额外的安全保护层。

### ✅ 正确的配置处理方式

**前端 (iframe/chat.html)**：
```javascript
function saveConfig() {
    var config = {
        provider: 'openai_compatible',
        apiUrl: document.getElementById('cfg-apiurl').value,
        apiKey: document.getElementById('cfg-apikey').value.trim(), // 直接发送
        model: document.getElementById('cfg-model').value
    };
    publishMessage('ai-chat/config-update', config);
    closeConfigModal();
}
```

**后端 (src/review/orchestrator.ts)**：
```typescript
subscribe(CHAT_TOPICS.CONFIG_UPDATE, async (data) => {
    // 验证字段类型和长度（包括 apiKey）
    if (data.apiKey && (typeof data.apiKey !== 'string' || data.apiKey.length > 500)) {
        console.warn('无效的 apiKey');
        return;
    }

    // 直接保存配置
    const result = await saveConfig(data);

    // 回传完整配置（包括 apiKey）
    publishToIFrame(CHAT_TOPICS.CONFIG_DATA, {
        apiUrl: result.config.apiUrl,
        apiKey: result.config.apiKey || '', // 不掩码
        model: result.config.model,
    });
});
```

## 代码修改指南

### 修改前必读
1. 使用 `ace-tool` 搜索代码，不要使用 grep/find
2. 修改文件前先用 git 跟踪
3. 参考 Cherry Studio 的实现模式
4. 使用 Codex 审查代码修改

### 常见问题排查

**问题：修改后还是报 `CONFIG_APIKEY_FORBIDDEN` 错误**

解决方案：
1. 确认代码已修改并提交
2. 重新构建：`npm run build`
3. 在 EDA 扩展管理器中重新加载扩展
4. 清除浏览器缓存后重启 EDA

**问题：paused 状态处理不正确**

检查点：
- 前端是否只在 `TEXT_COMPLETE(paused)` 时清理状态
- 后端是否按顺序发送 `THINKING_COMPLETE` → `TEXT_COMPLETE`
- `finishPendingRequest` 是否正确区分 requestId

**问题：重新生成按钮在历史会话中显示**

检查点：
- 是否检查了 `!msg.transient`
- 是否检查了 `currentSessionId` 有效性
- 是否检查了 `!isThinking`

## 文件结构

```
src/
  review/
    types.ts              # 类型定义（MessageBlock, ChunkType, ErrorCode）
    config.ts             # 配置管理（localStorage）
    collector.ts          # 数据采集（EDA API）
    chunker.ts            # 数据分块
    prompt-builder.ts     # AI Prompt 构建
    chat-adapter.ts       # AI 通信适配器（SSE 解析）
    orchestrator.ts       # 流程编排（会话管理、事件路由）
iframe/
  chat.html              # 对话 UI（Block 渲染、流式更新）
```

## 提交规范

使用语义化提交信息：
- `feat:` - 新功能
- `fix:` - Bug 修复
- `refactor:` - 重构
- `docs:` - 文档更新

每次提交必须包含：
```
Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

## 测试检查清单

- [ ] 停止生成按钮正常工作
- [ ] paused 状态正确显示
- [ ] 重新生成功能正常
- [ ] 错误详情模态框正常显示
- [ ] ThinkingBlock 自动折叠
- [ ] API Key 可以通过配置弹窗设置
- [ ] 历史会话加载正常
- [ ] 多会话隔离正常

## 参考资源

- Cherry Studio: https://github.com/kangfenmao/cherry-studio
- 嘉立创 EDA API 文档: `/home/ubuntu/pro-api-sdk-master/node_modules/@jlceda/pro-api-types/index.d.ts`
