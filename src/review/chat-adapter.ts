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
 * 真正的流式读取（逐块读取 ReadableStream）
 */
async function readStreamingResponse(
	body: ReadableStream<Uint8Array>,
	onBlock: MessageBlockHandler | undefined,
	signal: AbortSignal | undefined,
	url: string,
): Promise<ChatCompletionResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let textContent = '';
	let reasoningContent = '';

	try {
		while (true) {
			if (signal?.aborted) {
				reader.cancel();
				throw createAbortReviewError('请求已取消', url, signal.reason);
			}

			const { done, value } = await reader.read();
			if (done)
				break;

			// 解码新数据块
			buffer += decoder.decode(value, { stream: true });

			// 按行分割处理 SSE 事件
			const lines = buffer.split('\n');
			buffer = lines.pop() || ''; // 保留最后一个不完整的行

			for (const line of lines) {
				if (!line.trim() || line.startsWith(':'))
					continue;

				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]')
						continue;

					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta;
						if (!delta)
							continue;

						let reasoning = delta.reasoning_content || '';
						let content = delta.content || '';

						// 标签格式检测和分离（<think>, <thought>, <thinking> 等）
						if (!reasoning && content) {
							const thinkTagRegex = /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<thinking>[\s\S]*?<\/thinking>/gi;
							const thinkMatches = content.match(thinkTagRegex);
							if (thinkMatches && thinkMatches.length > 0) {
								// 提取标签内的内容作为 thinking
								reasoning = thinkMatches.map((match) => {
									return match.replace(/<\/?think(?:ing|thought)>/gi, '').trim();
								}).join('\n\n');
								// 从 content 中移除标签及其内容
								content = content.replace(thinkTagRegex, '').trim();
							}
						}

						// Grok 格式检测和分离
						if (!reasoning && content) {
							const hasGrokMarkers = /\[(?:Agent\s+\d+|Grok)\]\[/.test(content) || /browse_page\s*\{/.test(content);
							if (hasGrokMarkers) {
								const contentLines = content.split('\n');
								const thinkingLines: string[] = [];
								const textLines: string[] = [];

								for (const l of contentLines) {
									const trimmed = l.trim();
									if (trimmed.match(/^\[(?:Agent\s+\d+|Grok)\]\[/) || trimmed.startsWith('browse_page')) {
										thinkingLines.push(l);
									}
									else if (trimmed.length > 0) {
										textLines.push(l);
									}
								}

								if (thinkingLines.length > 0) {
									reasoning = thinkingLines.join('\n').trim();
									content = textLines.join('\n').trim();
								}
							}
						}

						// 累积内容
						if (reasoning)
							reasoningContent += reasoning;
						if (content)
							textContent += content;

						// 实时发送增量更新
						if (onBlock) {
							if (reasoning) {
								onBlock({
									type: ChunkType.THINKING_DELTA,
									content: reasoning,
									accumulatedContent: reasoningContent,
								});
							}
							if (content) {
								onBlock({
									type: ChunkType.TEXT_DELTA,
									content,
									accumulatedContent: textContent,
								});
							}
						}
					}
					catch {
						// 忽略解析错误，继续处理下一行
					}
				}
			}
		}

		// 在最终累积内容上提取标签（修复跨chunk标签问题）
		let finalReasoning = reasoningContent;
		let finalText = textContent;

		// 如果没有 reasoning 但 text 中包含标签，提取之
		if (!finalReasoning && finalText) {
			const thinkTagRegex = /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<thinking>[\s\S]*?<\/thinking>/gi;
			const thinkMatches = finalText.match(thinkTagRegex);
			if (thinkMatches && thinkMatches.length > 0) {
				// 提取标签内的内容作为 thinking
				finalReasoning = thinkMatches.map((match) => {
					return match.replace(/<\/?think(?:ing|thought)>/gi, '').trim();
				}).join('\n\n');
				// 从 text 中移除标签及其内容
				finalText = finalText.replace(thinkTagRegex, '').trim();

				// 更新累积内容
				reasoningContent = finalReasoning;
				textContent = finalText;
			}
		}

		// 发送完成事件
		if (onBlock) {
			if (reasoningContent) {
				onBlock({
					type: ChunkType.THINKING_COMPLETE,
					content: '',
					accumulatedContent: reasoningContent,
					status: 'success',
				});
			}
			if (textContent) {
				onBlock({
					type: ChunkType.TEXT_COMPLETE,
					content: '',
					accumulatedContent: textContent,
					status: 'success',
				});
			}
		}

		return { textContent, reasoningContent };
	}
	catch (error) {
		reader.cancel();
		throw error;
	}
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

		// 尝试真正的流式读取（如果支持 ReadableStream）
		if (isSSE && response.body && typeof response.body.getReader === 'function') {
			return await readStreamingResponse(response.body, onBlock, signal, url);
		}

		// 降级：等待完整响应
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
 * 参考 NextChat 的实现：
 * - 简化的状态管理：只用 isThinking 标志
 * - 每个 chunk 返回累积内容，不是增量
 * - 前端根据 accumulatedContent 渲染
 *
 * 生命周期：
 *   THINKING_START → THINKING_DELTA(n) → THINKING_COMPLETE
 *   TEXT_START     → TEXT_DELTA(n)     → TEXT_COMPLETE
 */
function parseSSEResponse(text: string, onBlock?: MessageBlockHandler): ChatCompletionResult {
	// 使用正则支持 \r\n 和 \n 两种换行符
	const lines = text.split(/\r?\n/);

	let textContent = '';
	let reasoningContent = '';
	let currentEventData: string[] = [];
	let isInThinkingMode = false;
	let hasStartedThinking = false;
	let hasStartedText = false;

	const parseChunk = (eventText: string): { isThinking: boolean; content: string; isFinish: boolean } | null => {
		try {
			const chunk = JSON.parse(eventText);

			const choice = chunk?.choices?.[0];
			if (!choice) {
				return null;
			}

			const delta = choice.delta || {};
			const finishReason = choice.finish_reason;
			const isFinish = finishReason !== null && finishReason !== undefined;

			// 参考 Cherry Studio：优先检查 reasoning_content
			let reasoning = normalizeChunkText(
				delta.reasoning_content || delta.reasoning,
			);
			let content = normalizeChunkText(delta.content);

			// 标签格式检测和分离（<think>, <thought>, <thinking> 等）
			if (!reasoning && content) {
				const thinkTagRegex = /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<thinking>[\s\S]*?<\/thinking>/gi;
				const thinkMatches = content.match(thinkTagRegex);
				if (thinkMatches && thinkMatches.length > 0) {
					// 提取标签内的内容作为 thinking
					reasoning = thinkMatches.map((match) => {
						return match.replace(/<\/?think(?:ing|thought)>/gi, '').trim();
					}).join('\n\n');
					// 从 content 中移除标签及其内容
					content = content.replace(thinkTagRegex, '').trim();
				}
			}

			// 支持 Grok 的行前缀标记格式
			// Grok 输出格式：[Agent X][AgentThink]、[Agent X][WebSearch]、[Grok][WebSearch]、browse_page {...}
			// 这些都是 AI 的内部操作过程，应该归类为 thinking
			// 正式回答通常以 ** 开头（Markdown 粗体）或者是普通文本
			if (!reasoning && content) {
				// 检测是否包含 Grok 的中间过程标记（检查整个content，不只是开头）
				const hasGrokMarkers = /\[(?:Agent\s+\d+|Grok)\]\[/.test(content) || /browse_page\s*\{/.test(content);

				if (hasGrokMarkers) {
					// 按行分类：中间过程标记开头的行归为 thinking，其他归为 content
					const lines = content.split('\n');
					const thinkingLines: string[] = [];
					const contentLines: string[] = [];

					for (const line of lines) {
						const trimmed = line.trim();
						// Grok 中间过程标记：[Agent X][xxx]、[Grok][xxx]、browse_page
						if (trimmed.match(/^\[(?:Agent\s+\d+|Grok)\]\[/) || trimmed.startsWith('browse_page')) {
							thinkingLines.push(line);
						}
						// 正式回答通常以 ** 开头或者是普通段落
						else if (trimmed.length > 0) {
							contentLines.push(line);
						}
					}

					// 如果有 thinking 内容，分离出来
					if (thinkingLines.length > 0) {
						reasoning = thinkingLines.join('\n').trim();
						content = contentLines.join('\n').trim();
					}
				}
			}

			// 参考 Cherry Studio：优先返回 reasoning
			if (reasoning && reasoning.length > 0) {
				return {
					isThinking: true,
					content: reasoning,
					isFinish,
				};
			}
			else if (content && content.length > 0) {
				return {
					isThinking: false,
					content,
					isFinish,
				};
			}

			// 无增量但包含 finish_reason（最后一个 chunk）
			if (isFinish) {
				return {
					isThinking: isInThinkingMode,
					content: '',
					isFinish: true,
				};
			}

			return null; // 空 chunk
		}
		catch (error) {
			console.error('[SSE Parser] JSON 解析失败:', eventText.substring(0, 100), error);
			return null;
		}
	};

	// 安全地发送 THINKING_COMPLETE（幂等）
	let thinkingCompleted = false;
	const emitThinkingComplete = (): void => {
		if (!hasStartedThinking || thinkingCompleted) {
			return;
		}
		emitBlock(onBlock, ChunkType.THINKING_COMPLETE, '', reasoningContent);
		thinkingCompleted = true;
	};

	// 安全地发送 TEXT_COMPLETE（幂等）
	let textCompleted = false;
	const emitTextComplete = (): void => {
		if (!hasStartedText || textCompleted) {
			return;
		}
		emitBlock(onBlock, ChunkType.TEXT_COMPLETE, '', textContent);
		textCompleted = true;
	};

	// 处理已解析的 chunk
	const handleParsedChunk = (
		parsed: { isThinking: boolean; content: string; isFinish: boolean },
	): void => {
		if (parsed.content) {
			if (parsed.isThinking) {
				// Thinking 模式
				if (!isInThinkingMode) {
					if (hasStartedText)
						emitTextComplete();
					isInThinkingMode = true;
					if (!hasStartedThinking) {
						hasStartedThinking = true;
						emitBlock(onBlock, ChunkType.THINKING_START, '', '');
					}
				}
				reasoningContent += parsed.content;
				thinkingCompleted = false;
				emitBlock(onBlock, ChunkType.THINKING_DELTA, parsed.content, reasoningContent);
			}
			else {
				// Text 模式
				if (isInThinkingMode) {
					emitThinkingComplete();
					isInThinkingMode = false;
				}
				if (!hasStartedText) {
					hasStartedText = true;
					emitBlock(onBlock, ChunkType.TEXT_START, '', '');
				}
				textContent += parsed.content;
				textCompleted = false;
				emitBlock(onBlock, ChunkType.TEXT_DELTA, parsed.content, textContent);
			}
		}

		// finish_reason 到达时补齐 COMPLETE 事件
		if (parsed.isFinish) {
			if (isInThinkingMode)
				emitThinkingComplete();
			else
				emitTextComplete();
		}
	};

	const flushEvent = (): void => {
		if (currentEventData.length === 0)
			return;

		const eventText = currentEventData.join('');
		currentEventData = [];

		const parsed = parseChunk(eventText);
		if (!parsed) {
			return;
		}

		handleParsedChunk(parsed);
	};

	// 兼容"无空行分隔"的 SSE：每次累积 data 后尝试解析
	const maybeFlushCompletedJson = (): void => {
		if (currentEventData.length === 0)
			return;

		const eventText = currentEventData.join('');
		if (!isCompleteJson(eventText)) {
			return;
		}

		// data 行本身已是完整 JSON，立即 flush
		flushEvent();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// 空行表示事件结束
		if (line === '') {
			if (currentEventData.length > 0) {
				flushEvent();
			}
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
			// 关键修复：兼容无空行分隔的 SSE 文本
			maybeFlushCompletedJson();
		}
	}

	// 处理最后一个事件
	if (currentEventData.length > 0) {
		flushEvent();
	}

	// 在最终累积内容上提取标签（修复跨chunk标签问题）
	let finalReasoning = reasoningContent;
	let finalText = textContent;

	// 如果没有 reasoning 但 text 中包含标签，提取之
	if (!finalReasoning && finalText) {
		const thinkTagRegex = /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<thinking>[\s\S]*?<\/thinking>/gi;
		const thinkMatches = finalText.match(thinkTagRegex);
		if (thinkMatches && thinkMatches.length > 0) {
			// 提取标签内的内容作为 thinking
			finalReasoning = thinkMatches.map((match) => {
				return match.replace(/<\/?think(?:ing|thought)>/gi, '').trim();
			}).join('\n\n');
			// 从 text 中移除标签及其内容
			finalText = finalText.replace(thinkTagRegex, '').trim();

			// 更新累积内容
			reasoningContent = finalReasoning;
			textContent = finalText;

			// 重置完成标志，强制重新发送正确的 COMPLETE 事件
			thinkingCompleted = false;
			textCompleted = false;
			hasStartedThinking = true;
			hasStartedText = true;
		}
	}

	// 确保所有已开始的 block 都收到 COMPLETE 事件（幂等调用）
	emitThinkingComplete();
	emitTextComplete();

	if (!textContent && !reasoningContent) {
		console.error('[SSE Parser] 错误：无法从 SSE 响应中提取内容');
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, '无法从SSE响应中提取内容');
	}

	return { textContent, reasoningContent };
}

/**
 * 判断当前 data 缓冲是否已经构成完整 JSON
 *
 * 用于兼容某些环境下"丢失空行分隔"的 SSE 文本：
 * data: {...}\n\ndata: {...}\n  -> 正常
 * data: {...}\ndata: {...}\n     -> 无空行，也能逐条解析
 */
function isCompleteJson(eventText: string): boolean {
	if (!eventText)
		return false;

	const first = eventText[0];
	if (first !== '{' && first !== '[')
		return false;

	try {
		JSON.parse(eventText);
		return true;
	}
	catch {
		return false;
	}
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
 *
 * 注意：非流式响应一次性返回完整内容，所以 DELTA 事件的 content 和 accumulatedContent 相同
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
		// 非流式：content=完整内容, accumulatedContent=完整内容
		emitBlock(onBlock, ChunkType.THINKING_DELTA, reasoningContent, reasoningContent);
		emitBlock(onBlock, ChunkType.THINKING_COMPLETE, '', reasoningContent);
	}

	if (textContent) {
		emitBlock(onBlock, ChunkType.TEXT_START, '', '');
		// 非流式：content=完整内容, accumulatedContent=完整内容
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
