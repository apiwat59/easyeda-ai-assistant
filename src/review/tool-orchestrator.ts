/**
 * AI原理图审查 - MCP 工具编排器
 *
 * 职责：
 * 1. 拉取可用工具列表（Gateway -> /tools/list）
 * 2. 执行工具调用（Gateway -> /tools/call）
 * 3. 向 IFrame 发出可观测的工具事件
 */
import type {
	ChatToolCall,
	ChatToolDefinition,
	ConfigStore,
	ToolEventMessage,
	ToolExecutionResultMessage,
} from './types';

interface ToolOrchestratorContext {
	requestId: string;
	sessionId: string;
}

interface ToolListResponseShape {
	tools?: unknown;
	result?: {
		tools?: unknown;
	};
}

interface ToolCallResponseShape {
	content?: unknown;
	result?: unknown;
	output?: unknown;
	isError?: boolean;
	error?: unknown;
}

/**
 * 工具编排器
 */
export class ToolOrchestrator {
	private readonly gatewayBaseUrl: string;

	constructor(
		private readonly config: ConfigStore,
		private readonly context: ToolOrchestratorContext,
		private readonly emitEvent: (event: ToolEventMessage) => void,
	) {
		this.gatewayBaseUrl = normalizeGatewayBaseUrl(config.mcpGatewayUrl || '');
	}

	isEnabled(): boolean {
		return !!this.config.mcpEnabled && this.gatewayBaseUrl.length > 0;
	}

	async listTools(signal?: AbortSignal): Promise<ChatToolDefinition[]> {
		if (!this.isEnabled()) {
			return [];
		}

		this.emit({
			stage: 'tools-list',
			status: 'running',
			title: '正在拉取 MCP 工具清单',
		});

		try {
			const response = await this.postJson<ToolListResponseShape>(
				'/tools/list',
				{
					sessionId: this.context.sessionId,
					requestId: this.context.requestId,
				},
				signal,
			);
			const tools = normalizeToolDefinitions(response);

			this.emit({
				stage: 'tools-list',
				status: 'success',
				title: `已加载 ${tools.length} 个 MCP 工具`,
				detail: truncateText(tools.map(tool => tool.function.name).join(', '), 240),
			});

			return tools;
		}
		catch (error) {
			this.emit({
				stage: 'tools-list',
				status: 'error',
				title: '工具清单加载失败',
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async executeToolCalls(
		toolCalls: ChatToolCall[],
		signal?: AbortSignal,
	): Promise<ToolExecutionResultMessage[]> {
		const results: ToolExecutionResultMessage[] = [];

		for (const toolCall of toolCalls) {
			if (signal?.aborted) {
				throw new Error('工具调用已取消');
			}

			const toolName = toolCall.function.name;
			const argsPreview = truncateText(toolCall.function.arguments || '{}', 240);

			this.emit({
				stage: 'tool-call',
				status: 'running',
				toolCallId: toolCall.id,
				toolName,
				title: `调用工具 ${toolName}`,
				detail: argsPreview,
			});

			try {
				const parsedArguments = parseToolArguments(toolCall.function.arguments);
				const response = await this.postJson<ToolCallResponseShape>(
					'/tools/call',
					{
						sessionId: this.context.sessionId,
						requestId: this.context.requestId,
						name: toolName,
						toolName,
						arguments: parsedArguments,
						autoApprove: this.config.mcpAutoApprove !== false,
					},
					signal,
				);

				const content = coerceToolResultToText(response);
				const isError = detectToolError(response);

				results.push({
					toolCallId: toolCall.id,
					toolName,
					content,
					isError,
				});

				this.emit({
					stage: 'tool-call',
					status: isError ? 'error' : 'success',
					toolCallId: toolCall.id,
					toolName,
					title: isError ? `工具 ${toolName} 返回错误` : `工具 ${toolName} 执行成功`,
					resultPreview: truncateText(content, 320),
				});
			}
			catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const fallback = JSON.stringify({
					error: true,
					tool: toolName,
					message: errorMessage,
				}, null, 2);

				results.push({
					toolCallId: toolCall.id,
					toolName,
					content: fallback,
					isError: true,
				});

				this.emit({
					stage: 'tool-call',
					status: 'error',
					toolCallId: toolCall.id,
					toolName,
					title: `工具 ${toolName} 执行失败`,
					error: errorMessage,
				});
			}
		}

		return results;
	}

	private async postJson<T>(
		path: string,
		payload: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted) {
			throw new Error('请求已取消');
		}

		const url = `${this.gatewayBaseUrl}${path}`;
		const timeoutMs = (this.config.mcpTimeout || 30) * 1000;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let abortHandler: (() => void) | undefined;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new Error(`Gateway 请求超时（>${this.config.mcpTimeout || 30}秒）`));
			}, timeoutMs);
		});

		const abortPromise = signal
			? new Promise<never>((_, reject) => {
					const onAbort = (): void => {
						reject(new Error('Gateway 请求已取消'));
					};

					if (signal.aborted) {
						onAbort();
						return;
					}

					abortHandler = onAbort;
					signal.addEventListener('abort', onAbort, { once: true });
				})
			: undefined;

		try {
			const requestPromise = eda.sys_ClientUrl.request(
				url,
				'POST',
				JSON.stringify(payload),
				{
					headers: buildGatewayHeaders(this.config),
				},
			) as Promise<unknown>;

			const raceTasks: Array<Promise<unknown>> = [requestPromise, timeoutPromise];
			if (abortPromise) {
				raceTasks.push(abortPromise);
			}

			const response = await Promise.race(raceTasks) as Response;
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Gateway HTTP ${response.status}: ${truncateText(text, 500)}`);
			}

			const rawText = await response.text();
			if (!rawText) {
				return {} as T;
			}

			try {
				return JSON.parse(rawText) as T;
			}
			catch {
				return { content: rawText } as T;
			}
		}
		finally {
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId);
			}
			if (signal && abortHandler) {
				signal.removeEventListener('abort', abortHandler);
			}
		}
	}

	private emit(event: Omit<ToolEventMessage, 'requestId' | 'sessionId' | 'eventId' | 'timestamp'>): void {
		this.emitEvent({
			...event,
			requestId: this.context.requestId,
			sessionId: this.context.sessionId,
			eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			timestamp: Date.now(),
		});
	}
}

// ============ 辅助函数 ============

function buildGatewayHeaders(config: ConfigStore): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	if (config.mcpGatewayApiKey && config.mcpGatewayApiKey.trim().length > 0) {
		headers.Authorization = `Bearer ${config.mcpGatewayApiKey.trim()}`;
	}
	headers['X-MCP-Auto-Approve'] = config.mcpAutoApprove === false ? 'false' : 'true';
	return headers;
}

function normalizeGatewayBaseUrl(url: string): string {
	const normalized = url.trim().replace(/\/+$/, '');
	return normalized;
}

function normalizeToolDefinitions(payload: unknown): ChatToolDefinition[] {
	const rawTools = extractRawTools(payload);
	const definitions: ChatToolDefinition[] = [];

	for (const item of rawTools) {
		if (!isRecord(item))
			continue;

		const name = typeof item.name === 'string' ? item.name : '';
		if (!name)
			continue;

		const description = typeof item.description === 'string' ? item.description : '';
		const inputSchema = isRecord(item.inputSchema)
			? item.inputSchema
			: (isRecord(item.input_schema) ? item.input_schema : (isRecord(item.parameters) ? item.parameters : undefined));

		definitions.push({
			type: 'function',
			function: {
				name,
				description: description || undefined,
				parameters: inputSchema || { type: 'object', additionalProperties: true },
			},
		});
	}

	return definitions;
}

function extractRawTools(payload: unknown): unknown[] {
	if (!isRecord(payload))
		return [];

	if (Array.isArray(payload.tools)) {
		return payload.tools;
	}
	if (isRecord(payload.result) && Array.isArray(payload.result.tools)) {
		return payload.result.tools;
	}
	return [];
}

function parseToolArguments(argumentsText: string): unknown {
	const text = (argumentsText || '').trim();
	if (!text)
		return {};
	try {
		return JSON.parse(text) as unknown;
	}
	catch {
		return { _raw: text };
	}
}

function coerceToolResultToText(response: unknown): string {
	if (!isRecord(response)) {
		return stringifyUnknown(response);
	}

	if (isRecord(response.result)) {
		return coerceToolResultToText(response.result);
	}
	if (Array.isArray(response.content)) {
		return extractTextFromContentArray(response.content);
	}
	if (typeof response.content === 'string') {
		return response.content;
	}
	if (response.output !== undefined) {
		return stringifyUnknown(response.output);
	}
	if (response.error !== undefined) {
		return stringifyUnknown(response.error);
	}
	return stringifyUnknown(response);
}

function extractTextFromContentArray(content: unknown[]): string {
	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
			parts.push(item.text);
		}
		else {
			parts.push(stringifyUnknown(item));
		}
	}
	return parts.join('\n').trim();
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength)}...`;
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value, null, 2);
	}
	catch {
		return String(value);
	}
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null;
}

/**
 * 递归检测工具响应中的错误状态
 *
 * 按 MCP 规范：
 * - 工具执行错误：result.isError = true
 * - 协议级错误：顶层 error 字段（非空对象或非空字符串）
 *
 * 递归检查所有嵌套的 result 层级，避免深层错误漏检
 */
function detectToolError(response: unknown, visited = new Set<any>()): boolean {
	if (!isRecord(response)) {
		return false;
	}

	// 防止循环引用导致无限递归
	if (visited.has(response)) {
		return false;
	}
	visited.add(response);

	// 检查顶层 isError
	if (response.isError === true) {
		return true;
	}

	// 检查顶层 error 字段（协议级错误）
	// 只有非空对象或有意义的字符串才算错误
	if (response.error !== undefined && response.error !== null && response.error !== false) {
		if (typeof response.error === 'string' && response.error.trim().length > 0) {
			return true;
		}
		if (typeof response.error === 'object') {
			return true;
		}
	}

	// 递归检查嵌套的 result
	if (isRecord(response.result)) {
		if (detectToolError(response.result, visited)) {
			return true;
		}
	}

	return false;
}
