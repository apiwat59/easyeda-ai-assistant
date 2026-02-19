/**
 * AI原理图审查 - AI通信适配器（重构版）
 *
 * 核心改动：
 * 1. 移除假装的流式传输（readStreamingResponse）
 * 2. 简化 parseSSEResponse：先累积完整内容，再提取标签，最后发送事件
 * 3. 确保事件顺序正确：THINKING 完成后才开始 TEXT
 */

import type { ConfigStore, UserMessage } from './types';
import { ChunkType, ErrorCode, ReviewError } from './types';

/**
 * 消息块处理器
 */
export type MessageBlockHandler = (block: {
	type: ChunkType;
	content: string;
	accumulatedContent: string;
	status?: 'streaming' | 'success' | 'paused';
}) => void;

/**
 * Chat 完成结果
 */
export interface ChatCompletionResult {
	textContent: string;
	reasoningContent: string;
}

/**
 * Chat 消息
 */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

/**
 * Chat 会话类
 */
export class ChatSession {
	private history: ChatMessage[] = [];
	private schematicContext: string = '';

	constructor(schematicChunks: any[] = []) {
		if (Array.isArray(schematicChunks) && schematicChunks.length > 0) {
			this.schematicContext = JSON.stringify(schematicChunks[0]);
		}
	}

	/**
	 * 设置原理图上下文（用于更新数据）
	 */
	setSchematicContext(schematicChunks: any[]): void {
		if (Array.isArray(schematicChunks) && schematicChunks.length > 0) {
			this.schematicContext = JSON.stringify(schematicChunks[0]);
		}
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
		const messages: ChatMessage[] = [
			{ role: 'system', content: systemPrompt },
			...this.history,
		];

		// 调用 AI API
		const result = await callOpenAICompatibleChat(messages, config, onBlock, signal);

		// 将 AI 回复加入历史
		const assistantContent = result.reasoningContent
			? `${result.reasoningContent}\n\n${result.textContent}`
			: result.textContent;
		this.history.push({ role: 'assistant', content: assistantContent });

		return result.textContent;
	}

	/**
	 * 清除最后一轮对话（用于重新生成）
	 */
	clear(): void {
		if (this.history.length >= 2) {
			this.history.pop(); // 移除 assistant
			this.history.pop(); // 移除 user
		}
	}

	/**
	 * 构建用户消息内容（支持文本+图片）
	 */
	private buildUserContent(userMsg: UserMessage): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
		const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

		if (userMsg.images && userMsg.images.length > 0) {
			for (const img of userMsg.images) {
				parts.push({
					type: 'image_url',
					image_url: { url: `data:${img.type};base64,${img.data}` },
				});
			}
		}

		if (userMsg.text) {
			parts.push({ type: 'text', text: userMsg.text });
		}

		return parts;
	}
}

// ============ System Prompt ============

function buildChatSystemPrompt(schematicContext: string): string {
	return `你是一个专业的硬件工程师助手，擅长分析原理图设计。

当前原理图数据：
${schematicContext || '（暂无数据）'}

请根据用户的问题，提供专业、准确的回答。`;
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

		// 等待完整响应（EDA API 不支持真正的流式传输）
		const responseText = await response.text();

		if (signal?.aborted) {
			throw createAbortReviewError('请求已取消', url, signal.reason);
		}

		// 检查是否是 SSE 格式
		const contentType = response.headers.get('content-type') || '';
		const isSSE = contentType.includes('text/event-stream')
			|| contentType.includes('text/plain')
			|| responseText.startsWith('data:')
			|| responseText.includes('\ndata:');

		if (isSSE) {
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

		// 提取 text 和 reasoning 内容
		const textContent = extractResponseText(data);
		const reasoningContent = extractReasoningText(data);

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

		// 捕获外部交互权限错误
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
			`网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
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

// ============ SSE 解析（简化版） ============

/**
 * 解析 SSE 响应（简化版）
 *
 * 策略：
 * 1. 先解析所有 SSE 事件，累积完整的 text 和 reasoning 内容
 * 2. 然后提取标签（<think>, Grok 格式等）
 * 3. 最后按正确顺序发送事件：THINKING → TEXT
 */
function parseSSEResponse(text: string, onBlock?: MessageBlockHandler): ChatCompletionResult {
	const lines = text.split(/\r?\n/);

	let textContent = '';
	let reasoningContent = '';
	let currentEventData: string[] = [];

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

			// 提取 reasoning 和 content
			const reasoning = normalizeChunkText(delta.reasoning_content || delta.reasoning);
			const content = normalizeChunkText(delta.content);

			if (reasoning) {
				reasoningContent += reasoning;
			}
			if (content) {
				textContent += content;
			}
		}
		catch {
			// 忽略解析错误
		}
	}

	// 第二阶段：提取标签
	if (!reasoningContent && textContent) {
		// 提取 <think> 标签
		const thinkTagRegex = /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<thinking>[\s\S]*?<\/thinking>/gi;
		const thinkMatches = textContent.match(thinkTagRegex);
		if (thinkMatches && thinkMatches.length > 0) {
			reasoningContent = thinkMatches.map((match) => {
				return match.replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
			}).join('\n\n');
			textContent = textContent.replace(thinkTagRegex, '').trim();
		}
		// 提取 Grok 格式
		else {
			const hasGrokMarkers = /\[(?:Agent\s+\d+|Grok)\]\[/.test(textContent) || /browse_page\s*\{/.test(textContent);
			if (hasGrokMarkers) {
				const contentLines = textContent.split('\n');
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
					reasoningContent = thinkingLines.join('\n').trim();
					textContent = textLines.join('\n').trim();
				}
			}
		}
	}

	// 第三阶段：按正确顺序发送事件
	if (onBlock) {
		// 先发送 THINKING 事件（如果有）
		if (reasoningContent) {
			onBlock({ type: ChunkType.THINKING_START, content: '', accumulatedContent: '' });
			onBlock({ type: ChunkType.THINKING_DELTA, content: reasoningContent, accumulatedContent: reasoningContent });
			onBlock({ type: ChunkType.THINKING_COMPLETE, content: '', accumulatedContent: reasoningContent, status: 'success' });
		}

		// 再发送 TEXT 事件（如果有）
		if (textContent) {
			onBlock({ type: ChunkType.TEXT_START, content: '', accumulatedContent: '' });
			onBlock({ type: ChunkType.TEXT_DELTA, content: textContent, accumulatedContent: textContent });
			onBlock({ type: ChunkType.TEXT_COMPLETE, content: '', accumulatedContent: textContent, status: 'success' });
		}
	}

	if (!textContent && !reasoningContent) {
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, '无法从SSE响应中提取内容');
	}

	return { textContent, reasoningContent };
}

// ============ 辅助函数 ============

function emitCompleteBlocks(
	textContent: string,
	reasoningContent: string,
	onBlock?: MessageBlockHandler,
): void {
	if (!onBlock)
		return;

	if (reasoningContent) {
		onBlock({ type: ChunkType.THINKING_START, content: '', accumulatedContent: '' });
		onBlock({ type: ChunkType.THINKING_DELTA, content: reasoningContent, accumulatedContent: reasoningContent });
		onBlock({ type: ChunkType.THINKING_COMPLETE, content: '', accumulatedContent: reasoningContent, status: 'success' });
	}

	if (textContent) {
		onBlock({ type: ChunkType.TEXT_START, content: '', accumulatedContent: '' });
		onBlock({ type: ChunkType.TEXT_DELTA, content: textContent, accumulatedContent: textContent });
		onBlock({ type: ChunkType.TEXT_COMPLETE, content: '', accumulatedContent: textContent, status: 'success' });
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

function handleHttpError(status: number, errorText: string, url: string): never {
	let errorMessage = `HTTP ${status}`;
	let errorCode = ErrorCode.AI_NETWORK_ERROR;

	if (status === 401 || status === 403) {
		errorMessage = 'API Key 无效或权限不足';
		errorCode = ErrorCode.AI_AUTH_ERROR;
	}
	else if (status === 429) {
		errorMessage = 'API 请求频率超限，请稍后重试';
		errorCode = ErrorCode.AI_RATE_LIMIT;
	}
	else if (status >= 500) {
		errorMessage = 'AI 服务暂时不可用';
		errorCode = ErrorCode.AI_SERVER_ERROR;
	}

	throw new ReviewError(
		errorCode,
		errorMessage,
		{
			url,
			status,
			responseBody: errorText.substring(0, 500),
		},
	);
}
