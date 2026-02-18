/**
 * AI原理图审查 - 对话式AI适配器
 *
 * 支持多轮对话历史、图片上传、原理图上下文注入
 */
import type { CollectedData, ConfigStore, UserMessage } from './types';
import { chunkData } from './chunker';
import { buildChatSystemPrompt } from './prompt-builder';
import { AIProvider, ErrorCode, ReviewError } from './types';

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
	 */
	async sendMessage(
		userMsg: UserMessage,
		config: ConfigStore,
	): Promise<string> {
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
			const reply = config.provider === AIProvider.CLAUDE
				? await callClaudeChat(messages, config)
				: await callOpenAIChat(messages, config);

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
	 * 清空对话历史
	 */
	clear(): void {
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
 * 调用OpenAI Chat API（多轮对话）
 */
async function callOpenAIChat(
	messages: ChatMessage[],
	config: ConfigStore,
): Promise<string> {
	const url = config.apiUrl || 'https://api.openai.com/v1/chat/completions';

	const body = {
		model: config.model,
		messages: messages.map(m => ({
			role: m.role === 'system' ? 'developer' : m.role,
			content: m.content,
		})),
		temperature: 0.4,
	};

	return await makeRequest(url, config, body);
}

/**
 * 调用Claude Chat API（多轮对话）
 */
async function callClaudeChat(
	messages: ChatMessage[],
	config: ConfigStore,
): Promise<string> {
	const url = config.apiUrl || 'https://api.anthropic.com/v1/messages';

	// Claude要求system单独传，且图片格式不同
	const systemMsg = messages.find(m => m.role === 'system');
	const chatMessages = messages.filter(m => m.role !== 'system');

	const body = {
		model: config.model,
		max_tokens: 8192,
		system: typeof systemMsg?.content === 'string' ? systemMsg.content : '',
		messages: chatMessages.map(m => ({
			role: m.role,
			content: convertContentForClaude(m.content),
		})),
		temperature: 0.4,
	};

	const headers = {
		'x-api-key': config.apiKey,
		'anthropic-version': '2023-06-01',
	};

	return await makeRequest(url, config, body, headers, true);
}

/**
 * 转换图片格式为Claude API格式
 */
function convertContentForClaude(content: ChatMessage['content']): unknown {
	if (typeof content === 'string')
		return content;

	return (content as Array<{ type: string; [key: string]: any }>).map((part) => {
		if (part.type === 'image_url' && part.image_url) {
			// Claude使用source.type=base64
			const url = (part.image_url as { url: string }).url;
			const match = url.match(/^data:([^;]+);base64,(.+)$/);
			if (match) {
				return {
					type: 'image',
					source: {
						type: 'base64',
						media_type: match[1],
						data: match[2],
					},
				};
			}
		}
		if (part.type === 'text') {
			return { type: 'text', text: (part as { text: string }).text };
		}
		return part;
	});
}

/**
 * 发送HTTP请求
 */
async function makeRequest(
	url: string,
	config: ConfigStore,
	body: unknown,
	extraHeaders: Record<string, string> = {},
	skipBearer: boolean = false,
): Promise<string> {
	const timeout = (config.timeout || 120) * 1000;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new ReviewError(
			ErrorCode.AI_TIMEOUT,
			`请求超时（>${config.timeout || 120}秒）`,
		)), timeout);
	});

	try {
		const response = await Promise.race([
			eda.sys_ClientUrl.request(
				url,
				'POST',
				JSON.stringify(body),
				{
					headers: {
						'Content-Type': 'application/json',
						...(skipBearer ? {} : { Authorization: `Bearer ${config.apiKey}` }),
						...extraHeaders,
					},
				},
			),
			timeoutPromise,
		]);

		if (!response.ok) {
			const errorText = await response.text();
			handleHttpError(response.status, errorText);
		}

		const data = await response.json();
		return extractResponseText(data);
	}
	finally {
		if (timeoutId !== undefined)
			clearTimeout(timeoutId);
	}
}

/**
 * 处理HTTP错误
 */
function handleHttpError(status: number, body: string): never {
	if (status === 401 || status === 403) {
		throw new ReviewError(ErrorCode.AI_AUTH_ERROR, 'API Key无效或权限不足');
	}
	if (status === 429) {
		throw new ReviewError(ErrorCode.AI_RATE_LIMIT, 'API请求频率超限，请稍后重试');
	}
	throw new ReviewError(ErrorCode.AI_NETWORK_ERROR, `HTTP ${status}: ${body.substring(0, 200)}`);
}

/**
 * 从AI响应中提取文本
 */
function extractResponseText(data: any): string {
	// OpenAI格式
	if (data.choices?.[0]?.message?.content) {
		return data.choices[0].message.content;
	}
	// Claude格式
	if (data.content?.[0]?.text) {
		return data.content[0].text;
	}
	throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, '无法解析AI响应格式');
}
