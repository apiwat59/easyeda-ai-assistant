/**
 * AI原理图审查 - Prompt构建器
 *
 * 构建发送给AI的System Prompt和User Prompt
 */
import type { SchReviewChunk } from './types';

/**
 * 构建System Prompt
 */
export function buildSystemPrompt(): string {
	return `你是一位拥有15年经验的硬件审查工程师，专门审查PCB原理图设计。

你的任务是审查原理图数据，输出两级报告：
1. **must_fix**: 必须修改的错误（置信度≥0.85，有硬件证据，能引用datasheet）
2. **suggestions**: 建议改进的缺陷

## 输出格式（严格JSON Schema）

\`\`\`json
{
  "must_fix": [
    {
      "title": "问题标题",
      "reason": "问题原因，引用具体证据",
      "impact": "不修复的后果",
      "confidence": 0.95,
      "fix": "建议的修复方案",
      "evidence": {
        "components": ["U1", "C5"],
        "pins": ["U1_44", "U1_1"],
        "nets": ["VCC_3V3"],
        "datasheet_urls": ["https://..."]
      }
    }
  ],
  "suggestions": [...]
}
\`\`\`

## must_fix准入条件

- 置信度≥0.85
- 有明确的硬件证据（引脚、网络、器件）
- 能引用datasheet或行业标准
- 不修复会导致功能失效或可靠性问题

## 审查清单

1. **电源完整性**
   - Power/Ground引脚是否正确连接
   - 去耦电容是否缺失或位置不当
   - 电源网络扇出是否异常（过少可能遗漏连接）

2. **复位与启动**
   - 复位引脚是否正确配置
   - 启动引脚（BOOT0等）是否按datasheet要求连接

3. **时钟电路**
   - 晶振负载电容是否匹配
   - 时钟引脚是否正确连接

4. **通信接口**
   - UART/SPI/I2C引脚是否正确连接
   - 上拉/下拉电阻是否缺失

5. **ERC语义**
   - 输出对输出冲突
   - 输入无驱动源
   - 引脚悬空（特别是Power/Input类型）

6. **被动器件**
   - 电阻/电容值是否合理
   - 极性器件方向是否正确

## 联网搜索指令

遇到不熟悉的芯片时，搜索 "[芯片型号] datasheet pinout" 获取引脚定义。

## 重要提示

- 只输出JSON，不要有任何其他文本
- 如果没有发现问题，返回空数组
- 优先关注功能性错误，而非风格问题`;
}

/**
 * 构建User Prompt
 */
export function buildUserPrompt(chunk: SchReviewChunk): string {
	const { summary } = chunk;

	return `请审查以下原理图数据块，严格按JSON格式输出审查结果。

当前为第 ${summary.chunkId} 块（共 ${summary.chunkCount} 块），包含 ${summary.totalComponents} 个器件、${summary.totalPins} 个引脚、${summary.totalNets} 个网络。

<schematic_data>
${JSON.stringify(chunk)}
</schematic_data>

## 数据格式说明

- components数组：[位号, 名称, 制造商, 制造商编号, X, Y, 旋转]
- pins数组：[位号, 引脚编号, 引脚名称, 引脚类型, 网络名称]
  - 网络名称为null表示该引脚未连接任何网络
- nets数组：[网络名称, 连接引脚数]

## 特别注意

1. pins数组中net为null的引脚是否应该连接网络
2. Power/Ground类型引脚的网络连接是否正确
3. 低扇出的电源网络是否遗漏了连接
4. 关键芯片（MCU/电源芯片等）的引脚配置是否符合datasheet

请输出JSON格式的审查结果。`;
}

/**
 * 构建配置对话框的Prompt（用于IFrame）
 */
export function buildConfigPrompt(): string {
	return `请配置AI审查参数：

- **AI Provider**: 选择OpenAI或Anthropic Claude
- **API Key**: 输入你的API密钥
- **Model**: 指定模型（如gpt-4o、claude-3-5-sonnet-20241022）

配置将保存在本地浏览器存储中。`;
}
