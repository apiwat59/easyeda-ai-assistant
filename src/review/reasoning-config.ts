/**
 * Reasoning 模型配置
 * 参考 Cherry Studio 的实现，支持所有主流 reasoning 模型
 */

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'auto';

export type ModelType
	= | 'openai-reasoning' // OpenAI o1, o3 系列
		| 'grok' // Grok 系列
		| 'deepseek' // DeepSeek R1, Hybrid
		| 'claude-thinking' // Claude 3.7 Sonnet
		| 'gemini' // Gemini 2.0/3.0
		| 'gemini-flash' // Gemini Flash 系列
		| 'qwen' // 通义千问
		| 'doubao' // 豆包
		| 'doubao-seed' // 豆包 Seed 系列
		| 'zhipu' // 智谱 GLM
		| 'kimi' // Kimi
		| 'hunyuan' // 混元
		| 'unknown';

/**
 * 检测模型类型
 */
export function getModelType(modelId: string): ModelType {
	const id = modelId.toLowerCase();

	// OpenAI o1/o3 系列
	if (/o1|o3/.test(id)) {
		return 'openai-reasoning';
	}

	// Grok 系列
	if (/grok/i.test(id)) {
		return 'grok';
	}

	// DeepSeek 系列
	if (/deepseek/i.test(id)) {
		return 'deepseek';
	}

	// Claude 3.7 Sonnet
	if (/claude.*3\.7/i.test(id) || /claude-3-7/i.test(id)) {
		return 'claude-thinking';
	}

	// Gemini 系列
	if (/gemini/i.test(id)) {
		if (/flash/i.test(id)) {
			return 'gemini-flash';
		}
		return 'gemini';
	}

	// 通义千问
	if (/qwen/i.test(id)) {
		return 'qwen';
	}

	// 豆包
	if (/doubao/i.test(id)) {
		if (/seed/i.test(id)) {
			return 'doubao-seed';
		}
		return 'doubao';
	}

	// 智谱 GLM
	if (/glm|zhipu/i.test(id)) {
		return 'zhipu';
	}

	// Kimi
	if (/kimi/i.test(id)) {
		return 'kimi';
	}

	// 混元
	if (/hunyuan/i.test(id)) {
		return 'hunyuan';
	}

	return 'unknown';
}

/**
 * 获取 reasoning 请求参数
 */
export function getReasoningParams(
	modelId: string,
	reasoningEffort: ReasoningEffort = 'medium',
): Record<string, any> {
	const type = getModelType(modelId);

	// 如果明确禁用 reasoning
	if (reasoningEffort === 'none') {
		return getDisableReasoningParams(type);
	}

	// 启用 reasoning
	return getEnableReasoningParams(type, reasoningEffort);
}

/**
 * 获取禁用 reasoning 的参数
 */
function getDisableReasoningParams(type: ModelType): Record<string, any> {
	switch (type) {
		case 'openai-reasoning':
			return { reasoningEffort: 'none' };

		case 'grok':
			return { reasoning: { enabled: false } };

		case 'deepseek':
		case 'qwen':
		case 'zhipu':
		case 'kimi':
		case 'hunyuan':
			return { enable_thinking: false };

		case 'claude-thinking':
			return { thinking: { type: 'disabled' } };

		case 'doubao':
			return { thinking: { type: 'disabled' } };

		case 'doubao-seed':
			return { reasoningEffort: 'none' };

		case 'gemini-flash':
			return {
				extra_body: {
					google: {
						thinking_config: {
							thinking_budget: 0,
						},
					},
				},
			};

		case 'gemini':
			// Gemini 3.0 不支持禁用 reasoning
			return {};

		default:
			return {};
	}
}

/**
 * 获取启用 reasoning 的参数
 */
function getEnableReasoningParams(
	type: ModelType,
	reasoningEffort: ReasoningEffort,
): Record<string, any> {
	switch (type) {
		case 'openai-reasoning':
			return {
				reasoningEffort: reasoningEffort === 'auto' ? 'medium' : reasoningEffort,
			};

		case 'grok':
			return {
				reasoning: {
					enabled: true,
					effort: reasoningEffort === 'auto' ? 'medium' : reasoningEffort,
				},
			};

		case 'deepseek':
			return {
				enable_thinking: true,
			};

		case 'claude-thinking':
			return {
				thinking: {
					type: 'enabled',
					budget_tokens: getThinkingBudget(reasoningEffort),
				},
			};

		case 'gemini':
			return {
				extra_body: {
					google: {
						thinking_config: {
							thinking_budget: -1, // -1 表示自动
							include_thoughts: true,
						},
					},
				},
			};

		case 'gemini-flash':
			return {
				extra_body: {
					google: {
						thinking_config: {
							thinking_budget: getThinkingBudget(reasoningEffort),
							include_thoughts: true,
						},
					},
				},
			};

		case 'qwen':
			return {
				enable_thinking: true,
				thinking_budget: getThinkingBudget(reasoningEffort),
			};

		case 'doubao':
			if (reasoningEffort === 'high') {
				return { thinking: { type: 'enabled' } };
			}
			if (reasoningEffort === 'auto') {
				return { thinking: { type: 'auto' } };
			}
			return {};

		case 'doubao-seed':
			return {
				reasoningEffort: reasoningEffort === 'auto' ? 'medium' : reasoningEffort,
			};

		case 'zhipu':
		case 'kimi':
		case 'hunyuan':
			return {
				enable_thinking: true,
			};

		default:
			return {};
	}
}

/**
 * 根据 effort 级别计算 thinking budget
 */
function getThinkingBudget(effort: ReasoningEffort): number {
	switch (effort) {
		case 'low':
			return 2000;
		case 'medium':
			return 5000;
		case 'high':
			return 10000;
		case 'auto':
			return -1; // 自动
		default:
			return 5000;
	}
}

/**
 * 从 SSE delta 中提取 reasoning 内容
 * 支持所有模型的不同字段名
 */
export function extractReasoningFromDelta(delta: any): string {
	if (!delta) {
		return '';
	}

	// 尝试所有可能的字段名
	return (
		delta.reasoning_content // DeepSeek, Qwen, Doubao, Kimi, Zhipu, Hunyuan
		|| delta.reasoning // OpenAI
		|| delta.thinking // Claude
		|| delta.thoughts // Gemini
		|| ''
	);
}

/**
 * 获取支持的模型列表（用于文档）
 */
export function getSupportedModels(): Array<{ name: string; type: ModelType; example: string }> {
	return [
		{ name: 'OpenAI o1/o3', type: 'openai-reasoning', example: 'o1-mini, o1-pro, o3-mini' },
		{ name: 'Grok', type: 'grok', example: 'grok-2, grok-beta' },
		{ name: 'DeepSeek', type: 'deepseek', example: 'deepseek-reasoner, deepseek-r1' },
		{ name: 'Claude 3.7', type: 'claude-thinking', example: 'claude-3-7-sonnet' },
		{ name: 'Gemini', type: 'gemini', example: 'gemini-2.0-flash, gemini-3.0' },
		{ name: 'Qwen (通义千问)', type: 'qwen', example: 'qwen-max, qwen-plus' },
		{ name: 'Doubao (豆包)', type: 'doubao', example: 'doubao-pro' },
		{ name: 'Zhipu (智谱)', type: 'zhipu', example: 'glm-4-plus' },
		{ name: 'Kimi', type: 'kimi', example: 'kimi-k1' },
		{ name: 'Hunyuan (混元)', type: 'hunyuan', example: 'hunyuan-turbo' },
	];
}
