/**
 * Reasoning model configuration
 * Based on Cherry Studio's implementation, with support for all mainstream reasoning models
 */

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'auto';

export type ModelType
	= | 'openai-reasoning' // OpenAI o1 and o3 series
		| 'grok' // Grok series
		| 'deepseek' // DeepSeek R1 and Hybrid
		| 'claude-thinking' // Claude 3.7 Sonnet
		| 'gemini' // Gemini 2.0 and 3.0
		| 'gemini-flash' // Gemini Flash series
		| 'qwen' // Qwen
		| 'doubao' // Doubao
		| 'doubao-seed' // Doubao Seed series
		| 'zhipu' // Zhipu GLM
		| 'kimi' // Kimi
		| 'hunyuan' // Hunyuan
		| 'unknown';

/**
 * Detect the model type
 */
export function getModelType(modelId: string): ModelType {
	const id = modelId.toLowerCase();

	// OpenAI o1/o3 series
	if (/o1|o3/.test(id)) {
		return 'openai-reasoning';
	}

	// Grok series
	if (/grok/i.test(id)) {
		return 'grok';
	}

	// DeepSeek series
	if (/deepseek/i.test(id)) {
		return 'deepseek';
	}

	// Claude 3.7 Sonnet
	if (/claude.*3\.7/i.test(id) || /claude-3-7/i.test(id)) {
		return 'claude-thinking';
	}

	// Gemini series
	if (/gemini/i.test(id)) {
		if (/flash/i.test(id)) {
			return 'gemini-flash';
		}
		return 'gemini';
	}

	// Qwen
	if (/qwen/i.test(id)) {
		return 'qwen';
	}

	// Doubao
	if (/doubao/i.test(id)) {
		if (/seed/i.test(id)) {
			return 'doubao-seed';
		}
		return 'doubao';
	}

	// Zhipu GLM
	if (/glm|zhipu/i.test(id)) {
		return 'zhipu';
	}

	// Kimi
	if (/kimi/i.test(id)) {
		return 'kimi';
	}

	// Hunyuan
	if (/hunyuan/i.test(id)) {
		return 'hunyuan';
	}

	return 'unknown';
}

/**
 * Get reasoning request parameters
 */
export function getReasoningParams(
	modelId: string,
	reasoningEffort: ReasoningEffort = 'medium',
): Record<string, any> {
	const type = getModelType(modelId);

	// If reasoning is explicitly disabled
	if (reasoningEffort === 'none') {
		return getDisableReasoningParams(type);
	}

	// Enable reasoning
	return getEnableReasoningParams(type, reasoningEffort);
}

/**
 * Get parameters for disabling reasoning
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
		case 'hunyuan':
			return { enable_thinking: false };

		case 'kimi':
			return {
				enable_thinking: false,
			};

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
			// Gemini 3.0 does not support disabling reasoning
			return {};

		default:
			return {};
	}
}

/**
 * Get parameters for enabling reasoning
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
							thinking_budget: -1, // -1 means automatic
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
		case 'hunyuan':
			return {
				enable_thinking: true,
			};

		case 'kimi':
			return {
				enable_thinking: true,
			};

		default:
			return {};
	}
}

/**
 * Calculate the thinking budget based on the effort level
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
			return -1; // Automatic
		default:
			return 5000;
	}
}

/**
 * Get the model-specific temperature value
 * Some models have hard temperature constraints in specific modes:
 * - Kimi in thinking mode must use temperature=1, and non-thinking mode is fixed at 0.6
 * - OpenAI o1/o3 reasoning models do not accept a temperature parameter
 * Returning undefined means the temperature field should not be sent
 */
export function getModelTemperature(
	modelId: string,
	reasoningEffort: ReasoningEffort,
	fallback: number,
): number | undefined {
	const type = getModelType(modelId);

	// OpenAI o1/o3 reasoning models do not accept explicit temperature
	if (type === 'openai-reasoning') {
		return undefined;
	}

	// Kimi has hard constraints
	if (type === 'kimi') {
		return reasoningEffort === 'none' ? 0.6 : 1;
	}

	return fallback;
}

/**
 * Extract reasoning content from an SSE delta
 * Supports the different field names used by all models
 */
export function extractReasoningFromDelta(delta: any): string {
	if (!delta) {
		return '';
	}

	// Try all possible field names
	return (
		delta.reasoning_content // DeepSeek, Qwen, Doubao, Kimi, Zhipu, Hunyuan
		|| delta.reasoning // OpenAI
		|| delta.thinking // Claude
		|| delta.thoughts // Gemini
		|| ''
	);
}

/**
 * Get the list of supported models for documentation
 */
export function getSupportedModels(): Array<{ name: string; type: ModelType; example: string }> {
	return [
		{ name: 'OpenAI o1/o3', type: 'openai-reasoning', example: 'o1-mini, o1-pro, o3-mini' },
		{ name: 'Grok', type: 'grok', example: 'grok-2, grok-beta' },
		{ name: 'DeepSeek', type: 'deepseek', example: 'deepseek-reasoner, deepseek-r1' },
		{ name: 'Claude 3.7', type: 'claude-thinking', example: 'claude-3-7-sonnet' },
		{ name: 'Gemini', type: 'gemini', example: 'gemini-2.0-flash, gemini-3.0' },
		{ name: 'Qwen', type: 'qwen', example: 'qwen-max, qwen-plus' },
		{ name: 'Doubao', type: 'doubao', example: 'doubao-pro' },
		{ name: 'Zhipu', type: 'zhipu', example: 'glm-4-plus' },
		{ name: 'Kimi', type: 'kimi', example: 'kimi-k1' },
		{ name: 'Hunyuan', type: 'hunyuan', example: 'hunyuan-turbo' },
	];
}
