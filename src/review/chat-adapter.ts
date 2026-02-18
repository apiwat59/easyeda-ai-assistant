/**
 * AI原理图审查 - 对话式AI适配器
 *
 * 支持多轮对话历史、图片上传、原理图上下文注入
 */
import type { CollectedData, ConfigStore, UserMessage } from './types';
import { chunkData } from './chunker';
import { buildChatSystemPrompt } from './prompt-builder';
import { ErrorCode, ReviewError } from './types';

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
			const reply = await callOpenAICompatibleChat(messages, config);

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
 * 调用OpenAI兼容格式的Chat API（多轮对话）
 */
async function callOpenAICompatibleChat(
	messages: ChatMessage[],
	config: ConfigStore,
): Promise<string> {
	const url = config.apiUrl || 'https://api.openai.com/v1/chat/completions';

	const body = {
		model: config.model,
		messages: messages.map(m => ({
			role: m.role,
			content: m.content,
		})),
		temperature: 0.4,
		stream: false,
	};

	return await makeRequest(url, config, body);
}

/**
 * 发送HTTP请求
 */
async function makeRequest(
	url: string,
	config: ConfigStore,
	body: unknown,
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
						'Authorization': `Bearer ${config.apiKey}`,
					},
				},
			),
			timeoutPromise,
		]);

		if (!response.ok) {
			const errorText = await response.text();
			handleHttpError(response.status, errorText);
		}

		const responseText = await response.text();

		// 检测是否是 SSE 流式响应格式
		if (responseText.startsWith('data:') || responseText.includes('\ndata:')) {
			return parseSSEResponse(responseText);
		}

		// 标准 JSON 响应
		const data = JSON.parse(responseText);
		return extractResponseText(data);
	}
	catch (error) {
		// 捕获外部交互权限错误
		if (error instanceof Error && error.message.includes('外部交互权限')) {
			throw new ReviewError(
				ErrorCode.AI_NETWORK_ERROR,
				'未启用扩展的外部交互权限。请在扩展管理器中找到本扩展，勾选"允许外部交互"选项。',
			);
		}
		throw error;
	}
	finally {
		if (timeoutId !== undefined)
			clearTimeout(timeoutId);
	}
}

/**
 * 解析 SSE 流式响应
 */
function parseSSEResponse(text: string): string {
	const lines = text.split('\n');
	let fullContent = '';

	for (const line of lines) {
		if (line.startsWith('data:')) {
			const jsonStr = line.substring(5).trim();

			// 跳过 [DONE] 标记
			if (jsonStr === '[DONE]') {
				continue;
			}

			try {
				const chunk = JSON.parse(jsonStr);
				const content = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || '';
				fullContent += content;
			}
			catch {
				// 忽略无法解析的行
			}
		}
	}

	if (!fullContent) {
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, '无法从SSE响应中提取内容');
	}

	return fullContent;
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
	// OpenAI兼容格式
	if (data.choices?.[0]?.message?.content) {
		return data.choices[0].message.content;
	}
	throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, '无法解析AI响应格式');
}
