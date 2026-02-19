/**
 * AI原理图审查 - 对话式AI适配器
 *
 * 支持多轮对话历史、图片上传、原理图上下文注入
 * 支持流式SSE响应，区分 thinking/text 两种 block 类型
 */
import type { CollectedData, ConfigStore, MessageBlock, UserMessage } from './types';
import { chunkData } from './chunker';
import { buildChatSystemPrompt } from './prompt-builder';
import { ChunkType, ErrorCode, ReviewError } from './types';

/**
 * Chat Completion 结果（区分 reasoning 和 text）
 */
interface ChatCompletionResult {
	textContent: string;
	reasoningContent: string;
}

/**
 * 流式分块回调
 */
type MessageBlockHandler = (block: MessageBlock) => void;

/**
 * 对话历史条目
 */
interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | Array<{ type: string; [key: string]: unknown }>;
}

/**
 * 对话管理器 - 维护对话状态
 */
export class ChatSession {
	private history: ChatMessage[] = [];
	private schematicContext: string | null = null;

	/**
	 * 初始化原理图上下文（在首次对话或数据更新时调用）
	 */
	setSchematicContext(data: CollectedData): void {
		const chunks = chunkData(data, { maxPinsPerChunk: 1200 });
		if (chunks.length > 0) {
			this.schematicContext = JSON.stringify(chunks[0]);
		}
	}

	/**
	 * 发送用户消息并获取AI回复
	 *
	 * @param onBlock 可选的流式分块回调，接收 thinking/text 事件
	 * @param signal 可选的 AbortSignal，用于取消请求
	 */
	async sendMessage(
		userMsg: UserMessage,
		config: ConfigStore,
		onBlock?: MessageBlockHandler,
		signal?: AbortSignal,
	): Promise<string> {
		if (signal?.aborted) {
			throw createAbortReviewError('请求在发送前已取消', undefined, signal.reason);
		}

		const systemPrompt = buildChatSystemPrompt(this.schematicContext);

		// 构建用户消息内容
		const userContent = this.buildUserContent(userMsg);

		// 将用户消息加入历史
		this.history.push({ role: 'user', content: userContent });

		// 构建完整消息列表
		const messages = [
			{ role: 'system' as const, content: systemPrompt },
			...this.history,
		];

		try {
			const result = await callOpenAICompatibleChat(messages, config, onBlock, signal);
			const reply = result.textContent || result.reasoningContent;

			// 将AI回复加入历史
			this.history.push({ role: 'assistant', content: reply });
			return reply;
		}
		catch (error) {
			// 失败时移除刚加入的用户消息，保持历史一致
			this.history.pop();
			throw error;
		}
	}

	/**
	 * 清空最后一轮对话（用于重新生成）
	 */
	clear(): void {
		if (this.history.length === 0)
			return;

		const lastMessage = this.history[this.history.length - 1];
		if (lastMessage?.role === 'assistant') {
			this.history.pop();
		}

		const userMessage = this.history[this.history.length - 1];
		if (userMessage?.role === 'user') {
			this.history.pop();
		}
	}

	/**
	 * 清空全部对话历史（用于会话销毁）
	 */
	reset(): void {
		this.history = [];
	}

	/**
	 * 构建用户消息内容（含图片）
	 */
	private buildUserContent(msg: UserMessage): string | Array<{ type: string; [key: string]: unknown }> {
		if (!msg.images || msg.images.length === 0) {
			return msg.text;
		}

		// 有图片时使用multipart格式
		const parts: Array<{ type: string; [key: string]: unknown }> = [];

		for (const img of msg.images) {
			const base64 = img.data.includes(',') ? img.data.split(',')[1] : img.data;
			parts.push({
				type: 'image_url',
				image_url: {
					url: `data:${img.type};base64,${base64}`,
				},
			});
		}

		if (msg.text) {
			parts.push({ type: 'text', text: msg.text });
		}

		return parts;
	}
}

/**
 * 调用OpenAI兼容格式的Chat API（多轮对话，流式）
 */
async function callOpenAICompatibleChat(
	messages: ChatMessage[],
	config: ConfigStore,
	onBlock?: MessageBlockHandler,
	signal?: AbortSignal,
): Promise<ChatCompletionResult> {
	const url = config.apiUrl || 'https://api.openai.com/v1/chat/completions';

	const body = {
		model: config.model,
		messages: messages.map(m => ({
			role: m.role,
			content: m.content,
		})),
		temperature: 0.4,
		stream: true,
	};

	return await makeRequest(url, config, body, onBlock, signal);
}

/**
 * 发送HTTP请求
 */
async function makeRequest(
	url: string,
	config: ConfigStore,
	body: unknown,
	onBlock?: MessageBlockHandler,
	signal?: AbortSignal,
): Promise<ChatCompletionResult> {
	const timeout = (config.timeout || 120) * 1000;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new ReviewError(
			ErrorCode.AI_TIMEOUT,
			`请求超时（>${config.timeout || 120}秒）`,
			{ timeoutMs: timeout, url },
		)), timeout);
	});

	const abortPromise = signal
		? new Promise<never>((_, reject) => {
				const onAbort = (): void => {
					reject(createAbortReviewError('请求已取消', url, signal.reason));
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
		const requestTasks: Array<Promise<unknown>> = [
			eda.sys_ClientUrl.request(
				url,
				'POST',
				JSON.stringify(body),
				{
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${config.apiKey}`,
					},
				},
			) as Promise<unknown>,
			timeoutPromise,
		];
		if (abortPromise)
			requestTasks.push(abortPromise);

		const response = await Promise.race(requestTasks) as Response;

		if (!response.ok) {
			const errorText = await response.text();
			handleHttpError(response.status, errorText, url);
		}

		if (signal?.aborted) {
			throw createAbortReviewError('请求已取消', url, signal.reason);
		}

		// 检查响应头判断是否是 SSE 流式响应
		const contentType = response.headers.get('content-type') || '';
		const isSSE = contentType.includes('text/event-stream') || contentType.includes('text/plain');

		const responseText = await response.text();

		if (signal?.aborted) {
			throw createAbortReviewError('请求已取消', url, signal.reason);
		}

		// 如果是 SSE 格式或响应文本包含 SSE 标记，使用 SSE 解析
		if (isSSE || responseText.startsWith('data:') || responseText.includes('\ndata:')) {
			return parseSSEResponse(responseText, onBlock);
		}

		// 标准 JSON 响应（非流式回退）
		let data: any;
		try {
			data = JSON.parse(responseText);
		}
		catch (parseError) {
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				'AI响应解析失败：返回了非JSON内容',
				{
					url,
					responseBody: responseText.substring(0, 2000),
					parseError: serializeUnknownError(parseError),
				},
			);
		}

		// 提取 text 和 reasoning 内容（至少需要一个）
		const textContent = extractResponseText(data);
		const reasoningContent = extractReasoningText(data);

		// 验证至少有一个内容
		if (!textContent && !reasoningContent) {
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				'AI响应中既没有 content 也没有 reasoning_content',
				{
					url,
					responseBody: JSON.stringify(data).substring(0, 2000),
				},
			);
		}

		emitCompleteBlocks(textContent, reasoningContent, onBlock);

		return { textContent, reasoningContent };
	}
	catch (error) {
		if (isAbortLikeError(error)) {
			throw createAbortReviewError('请求已取消', url, signal?.reason);
		}

		if (error instanceof ReviewError) {
			throw error;
		}

		// 捕获外部交互权限错误（支持中英文多种表述）
		if (error instanceof Error) {
			const msg = error.message.toLowerCase();
			const permissionKeywords = [
				'外部交互权限',
				'外部交互',
				'external interaction',
				'permission denied',
				'access denied',
				'cors',
			];

			if (permissionKeywords.some(keyword => msg.includes(keyword.toLowerCase()))) {
				throw new ReviewError(
					ErrorCode.AI_NETWORK_ERROR,
					'未启用扩展的外部交互权限。请在扩展管理器中找到本扩展，勾选"允许外部交互"选项。',
					{
						url,
						originalError: serializeUnknownError(error),
					},
				);
			}
		}

		throw new ReviewError(
			ErrorCode.AI_NETWORK_ERROR,
			`AI请求失败: ${error instanceof Error ? error.message : String(error)}`,
			{
				url,
				originalError: serializeUnknownError(error),
			},
		);
	}
	finally {
		if (timeoutId !== undefined)
			clearTimeout(timeoutId);
		if (signal && abortHandler) {
			signal.removeEventListener('abort', abortHandler);
		}
	}
}

// ============ SSE 解析（区分 thinking/text） ============

/**
 * 解析 SSE 流式响应，区分 reasoning_content 和 content
 *
 * 生命周期：
 *   THINKING_START → THINKING_DELTA(n) → THINKING_COMPLETE
 *   TEXT_START     → TEXT_DELTA(n)     → TEXT_COMPLETE
 */
function parseSSEResponse(text: string, onBlock?: MessageBlockHandler): ChatCompletionResult {
	const lines = text.split('\n');
	let textContent = '';
	let reasoningContent = '';
	let currentEventData: string[] = [];
	let thinkingStarted = false;
	let textStarted = false;
	let thinkingCompleted = false;
	let textCompleted = false;

	const flushEvent = (): void => {
		if (currentEventData.length === 0)
			return;

		// 合并多行 data（某些提供商可能分多行发送 JSON）
		const eventText = currentEventData.join('');
		currentEventData = [];

		try {
			const chunk = JSON.parse(eventText);
			const choice = chunk?.choices?.[0];
			if (!choice)
				return;

			const delta = choice.delta || {};

			// 支持多种 reasoning 字段格式（参考 Cherry Studio）
			const deltaReasoning = normalizeChunkText(
				delta.reasoning_content || delta.reasoning,
			);
			const deltaText = normalizeChunkText(delta.content);

			// 处理 thinking 增量
			if (deltaReasoning) {
				if (!thinkingStarted) {
					thinkingStarted = true;
					emitBlock(onBlock, ChunkType.THINKING_START, '', reasoningContent);
				}
				reasoningContent += deltaReasoning;
				emitBlock(onBlock, ChunkType.THINKING_DELTA, deltaReasoning, reasoningContent);
			}

			// 处理 text 增量
			if (deltaText) {
				// 如果 thinking 尚未结束，先结束它（参考 Cherry Studio 的 emitThinkingCompleteIfNeeded）
				if (thinkingStarted && !thinkingCompleted) {
					thinkingCompleted = true;
					emitBlock(onBlock, ChunkType.THINKING_COMPLETE, '', reasoningContent);
				}
				if (!textStarted) {
					textStarted = true;
					emitBlock(onBlock, ChunkType.TEXT_START, '', textContent);
				}
				textContent += deltaText;
				emitBlock(onBlock, ChunkType.TEXT_DELTA, deltaText, textContent);
			}

			// 兼容某些提供方：SSE 事件中直接给完整 message 内容
			if (!deltaReasoning && !reasoningContent && choice.message) {
				const messageReasoning = normalizeChunkText(
					choice.message.reasoning_content || choice.message.reasoning,
				);
				if (messageReasoning) {
					thinkingStarted = true;
					reasoningContent = messageReasoning;
					emitBlock(onBlock, ChunkType.THINKING_START, '', '');
					emitBlock(onBlock, ChunkType.THINKING_DELTA, messageReasoning, reasoningContent);
				}
			}

			if (!deltaText && !textContent && choice.message) {
				const messageText = normalizeChunkText(choice.message.content);
				if (messageText) {
					// 如果有 reasoning 但还没结束，先结束它
					if (thinkingStarted && !thinkingCompleted) {
						thinkingCompleted = true;
						emitBlock(onBlock, ChunkType.THINKING_COMPLETE, '', reasoningContent);
					}
					textStarted = true;
					textContent = messageText;
					emitBlock(onBlock, ChunkType.TEXT_START, '', '');
					emitBlock(onBlock, ChunkType.TEXT_DELTA, messageText, textContent);
				}
			}

			// 检查 finish_reason 发送完成事件
			if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
				if (thinkingStarted && !thinkingCompleted) {
					thinkingCompleted = true;
					emitBlock(onBlock, ChunkType.THINKING_COMPLETE, '', reasoningContent);
				}
				if (textStarted && !textCompleted) {
					textCompleted = true;
					emitBlock(onBlock, ChunkType.TEXT_COMPLETE, '', textContent);
				}
			}
		}
		catch (error) {
			// 忽略无法解析的事件，但记录日志便于调试
			console.warn('SSE chunk parse failed:', eventText.substring(0, 100), error);
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// 空行表示事件结束
		if (line === '') {
			flushEvent();
			continue;
		}

		// 处理 data: 行
		if (line.startsWith('data:')) {
			const dataContent = line.substring(5).trim();

			// 跳过 [DONE] 标记
			if (dataContent === '[DONE]') {
				flushEvent();
				continue;
			}

			// 累积多行 data
			currentEventData.push(dataContent);
		}
	}

	// 处理最后一个事件（如果没有以空行结尾）
	flushEvent();

	// 确保所有已开始的 block 都收到 COMPLETE 事件
	if (thinkingStarted && !thinkingCompleted) {
		emitBlock(onBlock, ChunkType.THINKING_COMPLETE, '', reasoningContent);
	}
	if (textStarted && !textCompleted) {
		emitBlock(onBlock, ChunkType.TEXT_COMPLETE, '', textContent);
	}

	if (!textContent && !reasoningContent) {
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, '无法从SSE响应中提取内容');
	}

	return { textContent, reasoningContent };
}

// ============ 辅助函数 ============

/**
 * 发送一个 MessageBlock 事件
 */
function emitBlock(
	onBlock: MessageBlockHandler | undefined,
	type: ChunkType,
	content: string,
	accumulatedContent: string,
): void {
	if (!onBlock)
		return;

	onBlock({
		type,
		content,
		accumulatedContent,
		timestamp: Date.now(),
	});
}

/**
 * 对非流式 JSON 响应，补发完整的 block 生命周期事件
 */
function emitCompleteBlocks(
	textContent: string,
	reasoningContent: string,
	onBlock?: MessageBlockHandler,
): void {
	if (!onBlock)
		return;

	if (reasoningContent) {
		emitBlock(onBlock, ChunkType.THINKING_START, '', '');
		emitBlock(onBlock, ChunkType.THINKING_DELTA, reasoningContent, reasoningContent);
		emitBlock(onBlock, ChunkType.THINKING_COMPLETE, '', reasoningContent);
	}

	if (textContent) {
		emitBlock(onBlock, ChunkType.TEXT_START, '', '');
		emitBlock(onBlock, ChunkType.TEXT_DELTA, textContent, textContent);
		emitBlock(onBlock, ChunkType.TEXT_COMPLETE, '', textContent);
	}
}

/**
 * 规范化 chunk 文本值（兼容 string / string[] / {text:string}[] 等格式）
 */
function normalizeChunkText(value: unknown): string {
	if (typeof value === 'string')
		return value;

	if (Array.isArray(value)) {
		return value.map((item) => {
			if (typeof item === 'string')
				return item;
			if (item && typeof item === 'object') {
				const text = (item as { text?: unknown }).text;
				return typeof text === 'string' ? text : '';
			}
			return '';
		}).join('');
	}

	return '';
}

/**
 * 处理HTTP错误
 */
function handleHttpError(status: number, body: string, url?: string): never {
	const responseBody = body.substring(0, 2000);
	const details = { httpStatus: status, responseBody, url };

	if (status === 401 || status === 403) {
		throw new ReviewError(ErrorCode.AI_AUTH_ERROR, 'API Key无效或权限不足', details);
	}
	if (status === 429) {
		throw new ReviewError(ErrorCode.AI_RATE_LIMIT, 'API请求频率超限，请稍后重试', details);
	}
	throw new ReviewError(ErrorCode.AI_NETWORK_ERROR, `HTTP ${status}: ${responseBody.substring(0, 200)}`, details);
}

/**
 * 从AI响应中提取文本（允许为空，因为可能只有 reasoning 内容）
 */
function extractResponseText(data: any): string {
	return normalizeChunkText(data.choices?.[0]?.message?.content);
}

/**
 * 从AI响应中提取 reasoning 文本
 */
function extractReasoningText(data: any): string {
	return normalizeChunkText(
		data.choices?.[0]?.message?.reasoning_content
		|| data.choices?.[0]?.message?.reasoning
		|| data.choices?.[0]?.reasoning_content,
	);
}

// ============ 中止与错误序列化 ============

/**
 * 构造统一的中止错误
 */
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

/**
 * 判断错误是否为中止错误
 */
function isAbortLikeError(error: unknown): boolean {
	if (error instanceof ReviewError) {
		return error.code === ErrorCode.AI_ABORTED;
	}
	return error instanceof Error && error.name === 'AbortError';
}

/**
 * 将 unknown 错误序列化为可传输对象
 */
function serializeUnknownError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	if (error && typeof error === 'object') {
		return { ...(error as Record<string, unknown>) };
	}

	return { value: String(error) };
}
