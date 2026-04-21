/**
 * AI原理图审查 - AI通信适配器
 *
 * 核心设计：
 * 1. 不使用流式传输（EDA API 不支持真正的 ReadableStream）
 * 2. 请求 stream: false，服务端返回标准 JSON
 * 3. 一次性接收完整响应，然后提取 thinking 和 text 内容
 * 4. 通过 onBlock 回调模拟流式事件，保持前端体验一致
 */

import type { CollectedData, ConfigStore, SchematicFieldsConfig, UserMessage } from './types';
import { chunkData } from './chunker';
import { buildChatSystemPrompt } from './prompt-builder';
import { extractReasoningFromDelta, getModelTemperature, getReasoningParams } from './reasoning-config';
import { ChunkType, ErrorCode, ReviewError } from './types';

/**
 * 调试日志发送函数（由 orchestrator 注入）
 */
let debugLog: ((level: string, message: string, data?: any) => void) | null = null;

export function setDebugLog(fn: (level: string, message: string, data?: any) => void): void {
	debugLog = fn;
}

function logDebug(level: string, message: string, data?: any): void {
	// 发送到前端调试面板
	if (debugLog) {
		debugLog(level, `[chat-adapter] ${message}`, data);
	}

	// 只有 warn/error 才输出到控制台
	if (level === 'warn') {
		console.warn(`[chat-adapter] ${message}`, data || '');
	}
	else if (level === 'error') {
		console.error(`[chat-adapter] ${message}`, data || '');
	}
}

/**
 * 消息块处理器（用于模拟流式体验）
 */
export type MessageBlockHandler = (block: {
	type: ChunkType;
	content: string;
	accumulatedContent: string;
	status?: 'success' | 'paused';
}) => void;

/**
 * sendMessage 选项
 */
export interface SendMessageOptions {
	tools?: import('./types').ChatToolDefinition[];
	onToolCalls?: (toolCalls: import('./types').ChatToolCall[]) => Promise<import('./types').ToolExecutionResultMessage[]>;
	maxToolRounds?: number;
}

/**
 * Chat 完成结果
 */
export interface ChatCompletionResult {
	textContent: string;
	reasoningContent: string;
	toolCalls: import('./types').ChatToolCall[];
}

/**
 * Chat 消息
 */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
	tool_calls?: import('./types').ChatToolCall[];
	tool_call_id?: string;
	name?: string;
}

/**
 * Chat 会话类
 */
export class ChatSession {
	private history: ChatMessage[] = [];
	private schematicContext: string = '';
	private schematicFields?: SchematicFieldsConfig;

	constructor(schematicData?: CollectedData, schematicFields?: SchematicFieldsConfig) {
		this.schematicFields = schematicFields;
		if (schematicData) {
			const chunks = chunkData(schematicData, { maxPinsPerChunk: 1200 }, this.schematicFields);
			if (chunks.length > 0) {
				this.schematicContext = JSON.stringify(chunks[0]);
			}
		}
	}

	/**
	 * 构建数据更新通知消息（包含数据摘要，帮助 AI 确认数据已变化）
	 */
	private static buildDataUpdateNotice(data: CollectedData): string {
		return `[System Notice] The user modified the schematic and the data was collected again.

Latest data summary: ${data.components.length} components, ${data.pins.length} pins, ${data.nets.length} nets.

Important: the <schematic_data> block in the first system prompt of this conversation is now the latest version. Use it directly when answering questions. Do not rely on conclusions from previous turns, because components and connections may have changed.`;
	}

	private static buildDataUpdateAck(data: CollectedData): string {
		return `Understood. I confirm that the <schematic_data> block in the system prompt has been updated to the latest version (${data.components.length} components, ${data.pins.length} pins, ${data.nets.length} nets). I will answer follow-up questions by checking that data directly instead of relying on earlier conclusions.`;
	}

	/**
	 * 判断一条消息是否为数据更新通知（用于 clear() 跳过和去重）
	 */
	private static isDataUpdateNotice(content: string | unknown): boolean {
		return typeof content === 'string' && content.startsWith('[System Notice] The user modified the schematic and the data was collected again.');
	}

	private static isDataUpdateAck(content: string | unknown): boolean {
		return typeof content === 'string' && content.startsWith('Understood. I confirm that the <schematic_data> block in the system prompt has been updated to the latest version');
	}

	/**
	 * 设置原理图上下文（用于更新数据）
	 *
	 * 当已有对话历史时，注入一对 user+assistant 消息通知 AI 数据已变化。
	 * 通知中包含具体的数据摘要（器件数/引脚数/网络数），帮助 AI 确认数据确实变了，
	 * 并明确告知 AI 从 system prompt 的 <schematic_data> 中查找数据。
	 *
	 * 去重机制：setSchematicContext 可能被连续调用多次（主采集 + 网表回填），
	 * 如果末尾已是通知对则替换（因为数据摘要可能不同），避免 history 膨胀。
	 */
	setSchematicContext(data: CollectedData): void {
		this.updateSchematicContext(data);
		// 如果已有对话历史，注入数据更新通知，让 AI 知道数据已变化
		if (this.history.length > 0) {
			const len = this.history.length;

			// 去重：如果末尾已是通知对，替换为最新数据摘要（而非跳过，因为摘要数字可能不同）
			if (
				len >= 2
				&& this.history[len - 2].role === 'user'
				&& ChatSession.isDataUpdateNotice(this.history[len - 2].content)
				&& this.history[len - 1].role === 'assistant'
				&& ChatSession.isDataUpdateAck(this.history[len - 1].content)
			) {
				this.history[len - 2].content = ChatSession.buildDataUpdateNotice(data);
				this.history[len - 1].content = ChatSession.buildDataUpdateAck(data);
				logDebug('info', '[setSchematicContext] Updated the summary in the trailing notice pair', {
					historyLength: len,
					components: data.components.length,
					pins: data.pins.length,
					nets: data.nets.length,
				});
				return;
			}

			this.history.push({
				role: 'user',
				content: ChatSession.buildDataUpdateNotice(data),
			});
			this.history.push({
				role: 'assistant',
				content: ChatSession.buildDataUpdateAck(data),
			});
			logDebug('info', '[setSchematicContext] Injected the data-update notice into history', {
				historyLength: this.history.length,
				components: data.components.length,
				pins: data.pins.length,
				nets: data.nets.length,
			});
		}
		else {
			logDebug('info', '[setSchematicContext] History is empty. Only schematicContext was updated (no notice injected)');
		}
	}

	/**
	 * 静默更新原理图上下文（不注入 history 通知，用于字段配置变更后刷新）
	 */
	updateSchematicContext(data: CollectedData): void {
		const chunks = chunkData(data, { maxPinsPerChunk: 1200 }, this.schematicFields);
		if (chunks.length > 0) {
			this.schematicContext = JSON.stringify(chunks[0]);
		}
	}

	/**
	 * 更新原理图字段选择配置
	 */
	updateSchematicFields(fields: SchematicFieldsConfig): void {
		this.schematicFields = fields;
	}

	/**
	 * 重置会话（清空历史）
	 */
	reset(): void {
		this.history = [];
	}

	/**
	 * 发送用户消息并获取AI回复
	 *
	 * @param userMsg 用户消息对象
	 * @param config AI 配置
	 * @param onBlock 可选的分块回调，用于模拟流式体验（实际是一次性发送）
	 * @param signal 可选的 AbortSignal，用于取消请求
	 * @param options 可选的工具调用选项
	 */
	async sendMessage(
		userMsg: UserMessage,
		config: ConfigStore,
		onBlock?: MessageBlockHandler,
		signal?: AbortSignal,
		options?: SendMessageOptions,
	): Promise<string> {
		if (signal?.aborted) {
			throw createAbortReviewError('The request was canceled before sending', undefined, signal.reason);
		}

		const systemPrompt = buildChatSystemPrompt(this.schematicContext, config.customSystemPrompt);
		const customPromptTrimmed = typeof config.customSystemPrompt === 'string'
			? config.customSystemPrompt.trim()
			: '';
		if (customPromptTrimmed) {
			logDebug('info', '[sendMessage] Custom system prompt is enabled', {
				length: customPromptTrimmed.length,
			});
		}
		const initialHistoryLength = this.history.length;

		// 构建用户消息内容
		const userContent = this.buildUserContent(userMsg);

		// 将用户消息加入历史
		this.history.push({ role: 'user', content: userContent });

		const availableTools = options?.tools && options.tools.length > 0
			? options.tools
			: undefined;
		const warnToolRounds = Math.max(1, options?.maxToolRounds || 6);
		const hardLimitRounds = 20; // 防止真正的死循环

		try {
			let round = 1;
			while (true) {
				if (signal?.aborted) {
					throw createAbortReviewError('The request was canceled', undefined, signal.reason);
				}

				// 硬性上限保护（防止死循环）
				if (round > hardLimitRounds) {
					logDebug('warn', `Tool-call rounds reached the hard limit (${hardLimitRounds}). Forcing termination`, { round });
					throw new Error(`Tool-call rounds exceeded the hard limit (>${hardLimitRounds}), which may indicate a loop`);
				}

				// 软提醒（超过建议轮次时警告但继续）
				if (round > warnToolRounds) {
					logDebug('warn', `Tool-call rounds exceeded the recommended limit (${warnToolRounds}). Current round: ${round}`, { round, warnToolRounds });
				}

				// 每轮都基于最新历史重建消息
				const messages: ChatMessage[] = [
					{ role: 'system', content: systemPrompt },
					...this.history,
				];

				const result = await callOpenAICompatibleChat(messages, config, signal, availableTools);

				logDebug('info', `[sendMessage] API returned in round ${round}`, {
					round,
					hasText: !!result.textContent,
					textLength: result.textContent.length,
					hasReasoning: !!result.reasoningContent,
					toolCallCount: result.toolCalls.length,
					historyLength: this.history.length,
				});

				// 若模型要求调用工具，进入工具执行分支
				if (result.toolCalls.length > 0) {
					this.history.push({
						role: 'assistant',
						content: result.textContent || null,
						tool_calls: result.toolCalls,
					});

					if (!options?.onToolCalls) {
						// 无工具执行器时回退成普通文本提示，避免死循环
						const fallbackText = result.textContent || 'The model requested a tool call, but tool execution is not enabled.';
						this.history.pop();
						this.history.push({
							role: 'assistant',
							content: fallbackText,
						});
						logDebug('info', '[sendMessage] No tool executor is available. Falling back to plain text (emitting complete blocks)', {
							round,
							fallbackTextLength: fallbackText.length,
						});
						emitCompleteBlocks(fallbackText, '', onBlock);
						return fallbackText;
					}

					const toolResults = await options.onToolCalls(result.toolCalls);
					if (!toolResults || toolResults.length === 0) {
						const firstCall = result.toolCalls[0];
						this.history.push({
							role: 'tool',
							tool_call_id: firstCall.id,
							name: firstCall.function.name,
							content: 'The tool executor did not return a result.',
						});
						round++;
						continue;
					}

					for (const toolResult of toolResults) {
						this.history.push({
							role: 'tool',
							tool_call_id: toolResult.toolCallId,
							name: toolResult.toolName,
							content: toolResult.content,
						});
					}
					round++;
					continue;
				}

				// 普通文本回答结束：仅在此处向 UI 发送事件，避免工具调用中间轮次重复触发
				logDebug('info', `[sendMessage] Final text response in round ${round}; emitting complete blocks`, {
					round,
					textLength: result.textContent.length,
					reasoningLength: result.reasoningContent.length,
					historyLength: this.history.length,
				});
				emitCompleteBlocks(result.textContent, result.reasoningContent, onBlock);

				const assistantContent = result.reasoningContent
					? `${result.reasoningContent}\n\n${result.textContent}`
					: result.textContent;
				this.history.push({ role: 'assistant', content: assistantContent });
				return result.textContent;
			}
		}
		catch (error) {
			// 出错回滚到本轮请求前状态，避免残留半成品 tool message
			this.history.splice(initialHistoryLength);
			throw error;
		}
	}

	/**
	 * 清除最后一轮对话（用于重新生成）
	 *
	 * 工具调用场景下一轮对话可能包含多条消息：
	 *   user → assistant(tool_calls) → tool × N → assistant(final)
	 * 因此从末尾向前找到最后一条 user 消息，将其及之后的所有消息一并移除。
	 *
	 * 注意：跳过 DATA_UPDATE_NOTICE（数据更新通知），它是由 setSchematicContext
	 * 自动注入的伪用户消息，不属于真实的用户问答轮次。如果不跳过，当末尾恰好
	 * 是通知对时，clear() 只会移除通知对而保留真实的上一轮对话，导致重新生成失效。
	 */
	clear(): void {
		for (let i = this.history.length - 1; i >= 0; i--) {
			if (this.history[i].role === 'user') {
				// 仅当该 user 消息与其后的 assistant 消息组成完整通知对时，才视为伪消息并跳过
				if (ChatSession.isDataUpdateNotice(this.history[i].content)) {
					const next = this.history[i + 1];
					if (next?.role === 'assistant' && ChatSession.isDataUpdateAck(next.content)) {
						continue;
					}
				}
				this.history.splice(i);
				logDebug('info', '[clear] Rolled back the last conversation turn', {
					removedFromIndex: i,
					remainingHistoryLength: this.history.length,
				});
				return;
			}
		}
		logDebug('warn', '[clear] No real user message was found to roll back', {
			historyLength: this.history.length,
		});
	}

	/**
	 * 构建用户消息内容（支持文本+图片）
	 */
	private buildUserContent(userMsg: UserMessage): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
		// 如果没有图片，直接返回文本
		if (!userMsg.images || userMsg.images.length === 0) {
			return userMsg.text || '';
		}

		// 有图片时使用 multipart 格式
		const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

		for (const img of userMsg.images) {
			// img.data 可能是完整 data URL（data:image/...;base64,...）或纯 base64 字符串
			const url = img.data.startsWith('data:')
				? img.data
				: `data:${img.type};base64,${img.data}`;
			parts.push({
				type: 'image_url',
				image_url: { url },
			});
		}

		if (userMsg.text) {
			parts.push({ type: 'text', text: userMsg.text });
		}

		return parts;
	}
}

// ============ 文本规范化 ============

function normalizeChunkText(text: unknown): string {
	if (typeof text !== 'string')
		return '';
	// 不要 trim，保留空白和换行，避免文本粘连
	return text;
}

// ============ AI API 调用 ============

/**
 * 调用OpenAI兼容格式的Chat API
 */
async function callOpenAICompatibleChat(
	messages: ChatMessage[],
	config: ConfigStore,
	signal?: AbortSignal,
	tools?: import('./types').ChatToolDefinition[],
): Promise<ChatCompletionResult> {
	const url = config.apiUrl || 'https://api.openai.com/v1/chat/completions';

	const body: Record<string, unknown> = {
		model: config.model,
		messages: messages.map((m) => {
			const messageBody: Record<string, unknown> = {
				role: m.role,
				content: m.content,
			};

			if (m.tool_calls && m.tool_calls.length > 0) {
				messageBody.tool_calls = m.tool_calls;
			}
			if (m.tool_call_id) {
				messageBody.tool_call_id = m.tool_call_id;
			}
			if (m.name) {
				messageBody.name = m.name;
			}
			return messageBody;
		}),
		stream: true, // 需要流式模式才能获取 reasoning_content（Grok 等模型）
		...getReasoningParams(config.model, 'medium'),
	};

	// temperature 需特殊处理：某些模型有硬约束或不接受该参数
	const temperature = getModelTemperature(config.model, 'medium', 0.4);
	if (temperature !== undefined) {
		body.temperature = temperature;
	}

	if (tools && tools.length > 0) {
		body.tools = tools;
		body.tool_choice = 'auto';
	}

	return await makeRequest(url, config, body, signal);
}

/**
 * 发送HTTP请求
 */
async function makeRequest(
	url: string,
	config: ConfigStore,
	body: unknown,
	signal?: AbortSignal,
): Promise<ChatCompletionResult> {
	let abortHandler: (() => void) | undefined;

	const abortPromise = signal
		? new Promise<never>((_, reject) => {
				const onAbort = (): void => {
					reject(createAbortReviewError('The request was canceled', url, signal.reason));
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
			JSON.stringify(body),
			{
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${config.apiKey}`,
				},
			},
		) as Promise<unknown>;

		// 只支持用户主动取消，不设置超时限制（有些 AI 推理时间很长）
		const response = abortPromise
			? await Promise.race([requestPromise, abortPromise]) as Response
			: await requestPromise as Response;

		if (!response.ok) {
			const errorText = await response.text();
			logDebug('warn', 'AI HTTP request returned a non-success response', {
				url,
				status: response.status,
				bodyLength: coerceToString(errorText).length,
			});
			handleHttpError(response.status, errorText, url);
		}

		if (signal?.aborted) {
			throw createAbortReviewError('The request was canceled', url, signal.reason);
		}

		// 读取完整响应（EDA API 不支持真正的流式传输）
		let responseText = '';
		try {
			const rawResponseText = await response.text();
			// 防御性类型转换：确保是字符串
			responseText = coerceToString(rawResponseText);
			logDebug('info', 'response.text() succeeded', {
				url,
				textLength: responseText.length,
				textType: typeof rawResponseText,
			});
		}
		catch (error) {
			logDebug('error', 'response.text() failed', {
				url,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				`Failed to read response content: ${error instanceof Error ? error.message : String(error)}`,
				{ url, originalError: serializeUnknownError(error) },
			);
		}

		if (signal?.aborted) {
			throw createAbortReviewError('The request was canceled', url, signal.reason);
		}

		// 检查是否是 SSE 格式
		const contentType = response.headers.get('content-type') || '';
		const isSSE = contentType.includes('text/event-stream')
			|| contentType.includes('text/plain')
			|| responseText.startsWith('data:')
			|| responseText.includes('\ndata:');

		logDebug('info', 'Response format detection', {
			contentType,
			isSSE,
			startsWithData: responseText.startsWith('data:'),
		});

		if (isSSE) {
			// SSE 格式：解析所有事件，累积 reasoning 和 content
			return parseSSEResponse(responseText);
		}

		// 标准 JSON 响应
		let data: any;
		try {
			data = JSON.parse(responseText);
		}
		catch (parseError) {
			logDebug('error', 'Failed to parse AI response JSON', {
				url,
				responseLength: responseText.length,
			});
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				'Failed to parse the AI response: the server returned non-JSON content',
				{
					url,
					responseBody: responseText.substring(0, 2000),
					parseError: serializeUnknownError(parseError),
				},
			);
		}

		// 提取 text、reasoning 和 tool_calls 内容
		const textContent = extractResponseText(data);
		const reasoningContent = extractReasoningText(data);
		const toolCalls = extractToolCalls(data);

		logDebug('info', 'Raw extraction result', {
			textLength: textContent.length,
			reasoningLength: reasoningContent.length,
			toolCallCount: toolCalls.length,
			hasThinkTag: /<think/i.test(textContent),
		});

		if (!textContent && !reasoningContent && toolCalls.length === 0) {
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				'The AI response contained neither content/reasoning_content nor tool_calls',
				{
					url,
					responseBody: JSON.stringify(data).substring(0, 2000),
				},
			);
		}

		// 提取 <think> 标签（如果 AI 在 content 中包含了思考过程）
		const { finalText, extractedReasoning } = extractThinkTags(textContent);

		// 合并提取的 reasoning（优先使用非空白的 reasoningContent）
		const finalReasoning = hasNonWhitespace(reasoningContent) ? reasoningContent : extractedReasoning;

		logDebug('info', 'Final extraction result', {
			finalTextLength: finalText.length,
			finalReasoningLength: finalReasoning.length,
			reasoningSource: hasNonWhitespace(reasoningContent) ? 'API field' : (extractedReasoning ? '<think> tag' : 'none'),
			toolCallCount: toolCalls.length,
		});

		return { textContent: finalText, reasoningContent: finalReasoning, toolCalls };
	}
	catch (error) {
		if (isAbortLikeError(error)) {
			throw createAbortReviewError('The request was canceled', url, signal?.reason);
		}

		if (error instanceof ReviewError) {
			throw error;
		}

		// 捕获外部交互权限错误
		if (error instanceof Error) {
			const msg = error.message.toLowerCase();
			const permissionKeywords = [
				'external interaction permission',
				'external interaction',
				'external interaction',
				'permission denied',
				'access denied',
				'cors',
			];

			if (permissionKeywords.some(keyword => msg.includes(keyword.toLowerCase()))) {
				throw new ReviewError(
					ErrorCode.AI_NETWORK_ERROR,
					'External interaction permission is not enabled for this extension. Open the extension manager and enable "Allow external interaction".',
					{
						url,
						originalError: serializeUnknownError(error),
					},
				);
			}
		}

		throw new ReviewError(
			ErrorCode.AI_NETWORK_ERROR,
			`Network request failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				url,
				originalError: serializeUnknownError(error),
			},
		);
	}
	finally {
		if (signal && abortHandler) {
			signal.removeEventListener('abort', abortHandler);
		}
	}
}

// ============ SSE 解析 ============

/**
 * 解析 SSE 响应
 *
 * 策略：
 * 1. 解析所有 SSE 事件，累积完整的 text 和 reasoning 内容
 * 2. 提取 <think> 标签（如果有）
 * 3. 返回累积结果（事件发送由 sendMessage 统一控制）
 */
function parseSSEResponse(text: string): ChatCompletionResult {
	// 防御性检查
	if (!text || typeof text !== 'string') {
		logDebug('error', 'The SSE response is empty or malformed', {
			textType: typeof text,
			textValue: text,
		});
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, 'The SSE response is empty or malformed');
	}

	logDebug('info', 'Starting SSE response parsing', {
		textLength: text.length,
	});

	const lines = text.split(/\r?\n/);

	let textContent = '';
	let reasoningContent = '';
	const toolCallsBuffer = new Map<number, { id: string; name: string; argumentsText: string }>();
	let currentEventData: string[] = [];
	let parseErrorCount = 0;

	// 第一阶段：解析所有 SSE 事件，累积内容
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// 空行表示事件结束
		if (line === '') {
			if (currentEventData.length > 0) {
				processEvent(currentEventData.join(''));
				currentEventData = [];
			}
			continue;
		}

		// 处理 data: 行
		if (line.startsWith('data:')) {
			const dataContent = line.substring(5).trim();

			// 跳过 [DONE] 标记
			if (dataContent === '[DONE]') {
				if (currentEventData.length > 0) {
					processEvent(currentEventData.join(''));
					currentEventData = [];
				}
				continue;
			}

			currentEventData.push(dataContent);
		}
	}

	// 处理最后一个事件
	if (currentEventData.length > 0) {
		processEvent(currentEventData.join(''));
	}

	// 解析单个 SSE 事件
	function processEvent(eventText: string): void {
		try {
			const chunk = JSON.parse(eventText);
			const delta = chunk?.choices?.[0]?.delta;
			if (!delta)
				return;

			// 累积 SSE 中的 tool_calls delta
			appendSseToolCalls(delta.tool_calls, toolCallsBuffer);

			// 🆕 使用统一的 reasoning 提取函数（支持所有模型）
			const reasoning = normalizeChunkText(extractReasoningFromDelta(delta));
			const content = normalizeChunkText(delta.content);

			if (reasoning) {
				reasoningContent += reasoning;
			}
			if (content) {
				textContent += content;
			}
		}
		catch {
			// 忽略单个事件的解析错误
			parseErrorCount++;
		}
	}

	logDebug('info', 'SSE parsing completed (accumulation phase)', {
		textLength: textContent.length,
		reasoningLength: reasoningContent.length,
	});

	if (parseErrorCount > 0) {
		logDebug('warn', 'Some SSE event fragments failed to parse', { parseErrorCount });
	}

	// 第二阶段：提取标签
	if (!reasoningContent && textContent) {
		// 提取 <think> 标签（贪婪匹配，确保提取完整内容）
		const thinkTagRegex = /<think>[\s\S]*<\/think>|<thought>[\s\S]*<\/thought>|<thinking>[\s\S]*<\/thinking>/gi;
		const thinkMatches = textContent.match(thinkTagRegex);
		if (thinkMatches && thinkMatches.length > 0) {
			reasoningContent = thinkMatches.map((match) => {
				return match.replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
			}).join('\n\n');
			textContent = textContent.replace(thinkTagRegex, '').trim();
			logDebug('info', 'Extracted reasoning from the <think> tag', {
				extractedLength: reasoningContent.length,
				matchCount: thinkMatches.length,
			});
		}
		else {
			logDebug('warn', 'A complete <think> tag was not found', {
				hasOpenTag: textContent.includes('<think>'),
				hasCloseTag: textContent.includes('</think>'),
			});
		}
	}

	logDebug('info', 'Final SSE extraction result', {
		textLength: textContent.length,
		reasoningLength: reasoningContent.length,
		toolCallCount: toolCallsBuffer.size,
		reasoningSource: reasoningContent ? 'SSE delta' : 'none',
	});

	const toolCalls = buildToolCallsFromBuffer(toolCallsBuffer);

	if (!textContent && !reasoningContent && toolCalls.length === 0) {
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, 'Failed to extract content from the SSE response');
	}

	return { textContent, reasoningContent, toolCalls };
}

// ============ 辅助函数 ============

/**
 * 从文本中提取 <think> 标签
 */
function extractThinkTags(text: string): { finalText: string; extractedReasoning: string } {
	if (!text) {
		return { finalText: '', extractedReasoning: '' };
	}

	// 提取 <think> 标签
	const thinkTagRegex = /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<thinking>[\s\S]*?<\/thinking>/gi;
	const thinkMatches = text.match(thinkTagRegex);

	if (thinkMatches && thinkMatches.length > 0) {
		const extractedReasoning = thinkMatches.map((match) => {
			return match.replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
		}).join('\n\n');
		const finalText = text.replace(thinkTagRegex, '').trim();
		return { finalText, extractedReasoning };
	}

	// 提取 Grok 格式
	const hasGrokMarkers = /\[(?:Agent\s+\d+|Grok)\]\[/.test(text) || /browse_page\s*\{/.test(text);
	if (hasGrokMarkers) {
		const contentLines = text.split('\n');
		const thinkingLines: string[] = [];
		const textLines: string[] = [];

		for (const line of contentLines) {
			const trimmed = line.trim();
			if (trimmed.match(/^\[(?:Agent\s+\d+|Grok)\]\[/) || trimmed.startsWith('browse_page')) {
				thinkingLines.push(line);
			}
			else if (trimmed.length > 0) {
				textLines.push(line);
			}
		}

		if (thinkingLines.length > 0) {
			return {
				finalText: textLines.join('\n').trim(),
				extractedReasoning: thinkingLines.join('\n').trim(),
			};
		}
	}

	return { finalText: text, extractedReasoning: '' };
}

function emitCompleteBlocks(
	textContent: string,
	reasoningContent: string,
	onBlock?: MessageBlockHandler,
): void {
	if (!onBlock) {
		logDebug('debug', 'onBlock 回调为空，跳过事件发送');
		return;
	}

	logDebug('debug', '准备发送事件', {
		hasReasoning: !!reasoningContent,
		hasText: !!textContent,
		reasoningLength: reasoningContent.length,
		textLength: textContent.length,
	});

	if (reasoningContent) {
		logDebug('debug', '发送 THINKING 事件', { length: reasoningContent.length });
		onBlock({ type: ChunkType.THINKING_START, content: '', accumulatedContent: '' });
		onBlock({ type: ChunkType.THINKING_DELTA, content: reasoningContent, accumulatedContent: reasoningContent });
		onBlock({ type: ChunkType.THINKING_COMPLETE, content: '', accumulatedContent: reasoningContent, status: 'success' });
	}
	else {
		logDebug('debug', '没有 reasoning 内容，跳过 THINKING 事件');
	}

	if (textContent) {
		logDebug('debug', '发送 TEXT 事件', { length: textContent.length });
		onBlock({ type: ChunkType.TEXT_START, content: '', accumulatedContent: '' });
		onBlock({ type: ChunkType.TEXT_DELTA, content: textContent, accumulatedContent: textContent });
		onBlock({ type: ChunkType.TEXT_COMPLETE, content: '', accumulatedContent: textContent, status: 'success' });
	}
	else {
		logDebug('debug', '没有 text 内容，跳过 TEXT 事件');
	}
}

function extractResponseText(data: any): string {
	return normalizeChunkText(
		data.choices?.[0]?.message?.content
		|| data.choices?.[0]?.text
		|| data.content,
	);
}

function extractReasoningText(data: any): string {
	return normalizeChunkText(
		data.choices?.[0]?.message?.reasoning_content
		|| data.choices?.[0]?.message?.reasoning
		|| data.choices?.[0]?.reasoning_content,
	);
}

function extractToolCalls(data: any): import('./types').ChatToolCall[] {
	return normalizeToolCalls(data?.choices?.[0]?.message?.tool_calls);
}

function createAbortReviewError(message: string, url?: string, reason?: unknown): ReviewError {
	return new ReviewError(
		ErrorCode.AI_ABORTED,
		message,
		{
			aborted: true,
			url,
			reason: reason === undefined ? undefined : serializeUnknownError(reason),
		},
	);
}

function isAbortLikeError(error: unknown): boolean {
	if (error instanceof ReviewError && error.code === ErrorCode.AI_ABORTED) {
		return true;
	}
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		return msg.includes('abort') || msg.includes('cancel');
	}
	return false;
}

function serializeUnknownError(error: unknown): any {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}
	return String(error);
}

function handleHttpError(status: number, errorText: unknown, url: string): never {
	let errorMessage = `HTTP ${status}`;
	let errorCode = ErrorCode.AI_NETWORK_ERROR;

	if (status === 401 || status === 403) {
		errorMessage = 'The API key is invalid or does not have permission';
		errorCode = ErrorCode.AI_AUTH_ERROR;
	}
	else if (status === 429) {
		errorMessage = 'The API rate limit was exceeded. Please retry later';
		errorCode = ErrorCode.AI_RATE_LIMIT;
	}
	else if (status >= 500) {
		errorMessage = 'The AI service is temporarily unavailable';
		errorCode = ErrorCode.AI_SERVER_ERROR;
	}

	throw new ReviewError(
		errorCode,
		errorMessage,
		{
			url,
			status,
			responseBody: coerceToString(errorText).substring(0, 500),
		},
	);
}

/**
 * 检查字符串是否包含非空白字符
 */
function hasNonWhitespace(text: string): boolean {
	return text.trim().length > 0;
}

/**
 * 将未知类型强制转换为字符串
 */
function coerceToString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'object') {
		try {
			return JSON.stringify(value);
		}
		catch {
			return String(value);
		}
	}
	return String(value);
}

// ============ Tool Calls 辅助函数 ============

function normalizeToolCalls(rawToolCalls: unknown): import('./types').ChatToolCall[] {
	if (!Array.isArray(rawToolCalls)) {
		return [];
	}

	const calls: import('./types').ChatToolCall[] = [];
	for (let i = 0; i < rawToolCalls.length; i++) {
		const rawCall = rawToolCalls[i];
		if (!isRecord(rawCall))
			continue;
		if (rawCall.type !== 'function')
			continue;

		const rawFunction = isRecord(rawCall.function) ? rawCall.function : null;
		const name = rawFunction && typeof rawFunction.name === 'string'
			? rawFunction.name
			: '';
		if (!name)
			continue;

		const argumentsText = rawFunction && typeof rawFunction.arguments === 'string'
			? rawFunction.arguments
			: '{}';
		const id = typeof rawCall.id === 'string' && rawCall.id
			? rawCall.id
			: `tool_call_${i + 1}`;

		calls.push({
			id,
			type: 'function',
			function: {
				name,
				arguments: argumentsText,
			},
		});
	}
	return calls;
}

function appendSseToolCalls(
	rawDeltaToolCalls: unknown,
	buffer: Map<number, { id: string; name: string; argumentsText: string }>,
): void {
	if (!Array.isArray(rawDeltaToolCalls)) {
		return;
	}

	for (let i = 0; i < rawDeltaToolCalls.length; i++) {
		const rawToolCall = rawDeltaToolCalls[i];
		if (!isRecord(rawToolCall))
			continue;

		const index = typeof rawToolCall.index === 'number'
			? rawToolCall.index
			: i;
		const existing = buffer.get(index) || {
			id: '',
			name: '',
			argumentsText: '',
		};

		if (typeof rawToolCall.id === 'string' && rawToolCall.id) {
			existing.id = rawToolCall.id;
		}

		const rawFunction = isRecord(rawToolCall.function) ? rawToolCall.function : null;
		if (rawFunction) {
			if (typeof rawFunction.name === 'string' && rawFunction.name) {
				existing.name = rawFunction.name;
			}
			if (typeof rawFunction.arguments === 'string') {
				existing.argumentsText += rawFunction.arguments;
			}
		}

		buffer.set(index, existing);
	}
}

function buildToolCallsFromBuffer(buffer: Map<number, { id: string; name: string; argumentsText: string }>): import('./types').ChatToolCall[] {
	const calls: import('./types').ChatToolCall[] = [];
	const entries = Array.from(buffer.entries()).sort((a, b) => a[0] - b[0]);

	for (const [index, value] of entries) {
		if (!value.name) {
			continue;
		}
		calls.push({
			id: value.id || `tool_call_${index + 1}`,
			type: 'function',
			function: {
				name: value.name,
				arguments: value.argumentsText || '{}',
			},
		});
	}

	return calls;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null;
}
