/**
 * AI原理图审查 - 对话模式编排器
 *
 * 管理IFrame面板与AI对话的完整生命周期
 * 按 sessionId 隔离对话会话，支持流式 thinking/text 推送
 */
import type { AbortRequest, AIBlockResponse, CollectedData, MessageBlock, RegenerateRequest, UserMessage } from './types';
import { ChatSession } from './chat-adapter';
import { collectSchematicData } from './collector';
import { loadChatHistory, loadConfig, saveChatHistory, saveConfig, validateConfig } from './config';
import { CHAT_TOPICS, ChunkType, ErrorCode, ReviewError } from './types';

/**
 * 按 sessionId 维护对话会话（替代单一全局 chatSession）
 */
const chatSessions = new Map<string, ChatSession>();

/**
 * 进行中请求的状态（按 requestId 隔离）
 */
interface PendingRequestState {
	sessionId: string;
	abortController: AbortController;
	thinkingAccumulated: string;
	textAccumulated: string;
}

const pendingRequests = new Map<string, PendingRequestState>();

/**
 * 记录每个会话最后一条用户消息（用于重新生成）
 */
const lastUserMessageBySession = new Map<string, UserMessage>();

/**
 * 缓存的原理图数据
 */
let cachedSchematicData: CollectedData | null = null;

/**
 * MessageBus订阅引用
 */
const subscriptions: Array<{ cancel: () => void }> = [];

/**
 * 启动AI对话面板
 */
export async function startAIChat(): Promise<void> {
	// 打开IFrame面板（不阻塞，不立即采集数据）
	try {
		await eda.sys_IFrame.openIFrame('/iframe/chat.html', 960, 700, 'ai-sch-chat');
	}
	catch {
		throw new ReviewError(ErrorCode.UI_IFRAME_FAILED, '无法打开对话面板');
	}

	// 打开新面板时重置会话容器，避免旧面板状态串入
	clearAllChatSessions();

	// 设置MessageBus监听
	setupChatListeners();

	// 异步采集原理图数据（不阻塞UI）
	collectDataInBackground();
}

/**
 * 后台采集原理图数据
 */
async function collectDataInBackground(): Promise<void> {
	try {
		// 立即通知IFrame开始采集
		publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
			summary: {
				components: -1, // -1 表示正在采集
				pins: -1,
				nets: -1,
			},
			timestamp: Date.now(),
		});

		cachedSchematicData = await collectSchematicData();

		// 将原理图数据注入所有已存在的会话
		for (const session of chatSessions.values()) {
			session.setSchematicContext(cachedSchematicData);
		}

		// 通知IFrame数据已就绪
		publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
			summary: {
				components: cachedSchematicData.components.length,
				pins: cachedSchematicData.pins.length,
				nets: cachedSchematicData.nets.length,
			},
			timestamp: cachedSchematicData.timestamp,
		});
	}
	catch (error) {
		console.warn('后台采集数据失败:', error);
		// 数据采集失败不阻塞对话，用户仍可以上传截图
		publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
			summary: {
				components: -1,
				pins: -1,
				nets: -1,
			},
			timestamp: Date.now(),
		});
	}
}

/**
 * 设置MessageBus监听器
 */
function setupChatListeners(): void {
	cleanupSubscriptions();

	// 监听IFrame请求原理图数据
	subscribe(CHAT_TOPICS.REQUEST_DATA, () => {
		if (cachedSchematicData) {
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: cachedSchematicData.components.length,
					pins: cachedSchematicData.pins.length,
					nets: cachedSchematicData.nets.length,
				},
				timestamp: cachedSchematicData.timestamp,
			});
		}
		else {
			// 如果数据尚未采集或采集失败，返回采集中状态
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: -1,
					pins: -1,
					nets: -1,
				},
				timestamp: Date.now(),
			});
		}
	});

	// 监听IFrame请求配置数据
	subscribe(CHAT_TOPICS.REQUEST_CONFIG, () => {
		const config = loadConfig();
		// 安全考虑：不发送 apiKey 到 IFrame，仅发送配置状态
		publishToIFrame(CHAT_TOPICS.CONFIG_DATA, {
			apiUrl: config.apiUrl,
			apiKey: config.apiKey ? '***已配置***' : '', // 仅显示状态，不发送实际值
			model: config.model,
		});
	});

	// 监听IFrame请求历史记录
	subscribe(CHAT_TOPICS.REQUEST_HISTORY, () => {
		const history = loadChatHistory();
		publishToIFrame(CHAT_TOPICS.HISTORY_DATA, { messages: history });
	});

	// 监听用户消息
	subscribe(CHAT_TOPICS.USER_MESSAGE, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		await handleUserMessage(data as UserMessage);
	});

	// 监听停止生成请求
	subscribe(CHAT_TOPICS.ABORT_REQUEST, (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		handleAbortRequest(data as AbortRequest);
	});

	// 监听重新生成请求
	subscribe(CHAT_TOPICS.REGENERATE_REQUEST, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		await handleRegenerateRequest(data as RegenerateRequest);
	});

	// 监听定位请求
	subscribe(CHAT_TOPICS.LOCATE, async (data: any) => {
		if (!data?.reference)
			return;
		await handleLocateRequest(data.reference);
	});

	// 监听配置更新
	subscribe(CHAT_TOPICS.CONFIG_UPDATE, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;

		// 安全限制：完全拒绝包含 apiKey 字段的消息
		if ('apiKey' in data) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: '安全限制：API Key 不能通过消息总线更新。请使用扩展配置入口设置。',
				code: 'CONFIG_APIKEY_FORBIDDEN',
			});
			return; // 直接返回，不处理任何配置
		}

		// 验证字段类型和长度
		if (data.apiUrl && (typeof data.apiUrl !== 'string' || data.apiUrl.length > 500)) {
			console.warn('无效的 apiUrl');
			return;
		}
		if (data.model && (typeof data.model !== 'string' || data.model.length > 100)) {
			console.warn('无效的 model');
			return;
		}

		// 验证 URL 格式
		if (data.apiUrl) {
			try {
				const url = new URL(data.apiUrl);
				if (url.protocol !== 'http:' && url.protocol !== 'https:') {
					console.warn('apiUrl 必须是 http 或 https 协议');
					return;
				}
			}
			catch {
				console.warn('apiUrl 格式无效');
				return;
			}
		}

		const result = await saveConfig(data);

		if (!result.success) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `配置保存失败: ${result.error || '未知错误'}`,
				code: 'CONFIG_SAVE_FAILED',
			});
			return;
		}

		// 保存成功后回传配置状态（安全考虑：不发送 apiKey 实际值）
		publishToIFrame(CHAT_TOPICS.CONFIG_DATA, {
			apiUrl: result.config.apiUrl,
			apiKey: result.config.apiKey ? '***已配置***' : '',
			model: result.config.model,
		});
	});

	// 监听历史记录更新
	subscribe(CHAT_TOPICS.HISTORY_UPDATE, async (data: any) => {
		if (!data || !Array.isArray(data.messages))
			return;

		// 验证数组大小
		if (data.messages.length > 100) {
			console.warn('历史会话数量过多（最大 100）');
			return;
		}

		// 验证每个会话的结构
		for (const session of data.messages) {
			if (!session || typeof session !== 'object') {
				console.warn('无效的会话结构');
				return;
			}
			if (!session.id || typeof session.id !== 'string' || session.id.length > 100) {
				console.warn('无效的会话 ID');
				return;
			}
			if (!Array.isArray(session.messages) || session.messages.length > 1000) {
				console.warn('无效的会话消息列表');
				return;
			}
			// 验证消息结构
			for (const msg of session.messages) {
				if (!msg || typeof msg !== 'object') {
					console.warn('无效的消息结构');
					return;
				}
				if (!msg.role || (msg.role !== 'user' && msg.role !== 'ai')) {
					console.warn('无效的消息角色');
					return;
				}
				if (typeof msg.content !== 'string' || msg.content.length > 100000) {
					console.warn('无效的消息内容');
					return;
				}
			}
		}

		const result = await saveChatHistory(data.messages);

		if (!result.success) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `历史记录保存失败: ${result.error || '未知错误'}`,
				code: 'HISTORY_SAVE_FAILED',
			});
		}
	});

	// 监听清空会话请求（支持按 sessionId 清空或全部清空）
	subscribe(CHAT_TOPICS.CLEAR_SESSION, (data: any) => {
		const sessionId = typeof data?.sessionId === 'string'
			? data.sessionId
			: '';

		if (sessionId) {
			abortPendingRequestsBySession(sessionId);
			lastUserMessageBySession.delete(sessionId);

			const session = chatSessions.get(sessionId);
			if (session) {
				session.reset();
				chatSessions.delete(sessionId);
			}
			return;
		}

		// 无 sessionId 时清空所有会话
		clearAllChatSessions();
	});
}

/**
 * 处理用户消息
 */
async function handleUserMessage(msg: UserMessage): Promise<void> {
	// 验证消息结构
	if (!msg || typeof msg !== 'object') {
		return;
	}

	// 验证必需字段
	if (!msg.requestId || !msg.sessionId) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '消息格式错误：缺少 requestId 或 sessionId',
		});
		return;
	}

	// 验证文本长度
	if (msg.text && msg.text.length > 50000) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '消息过长（最大 50000 字符）',
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
		return;
	}

	// 验证图片数量和大小
	if (msg.images) {
		if (msg.images.length > 10) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: '图片数量过多（最大 10 张）',
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			return;
		}

		for (const img of msg.images) {
			if (img.data && img.data.length > 10 * 1024 * 1024) {
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: '图片过大（单张最大 10MB）',
					requestId: msg.requestId,
					sessionId: msg.sessionId,
				});
				return;
			}
		}
	}

	const config = loadConfig();
	const configError = validateConfig(config);

	if (configError) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: `请先配置AI: ${configError}`,
			code: ErrorCode.AI_NO_CONFIG,
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
		return;
	}

	// 如果已有相同 requestId 的请求，先中止
	const existingPending = pendingRequests.get(msg.requestId);
	if (existingPending) {
		existingPending.abortController.abort();
		pendingRequests.delete(msg.requestId);
	}

	// 创建新的 AbortController
	const abortController = new AbortController();
	pendingRequests.set(msg.requestId, {
		sessionId: msg.sessionId,
		abortController,
		thinkingAccumulated: '',
		textAccumulated: '',
	});

	try {
		// 按 sessionId 获取或创建会话（核心隔离机制）
		const session = getOrCreateChatSession(msg.sessionId);

		const reply = await session.sendMessage(
			msg,
			config,
			(block) => {
				if (abortController.signal.aborted)
					return;

				// 记录累积内容
				const pending = pendingRequests.get(msg.requestId);
				if (pending) {
					if (isThinkingBlock(block.type))
						pending.thinkingAccumulated = block.accumulatedContent;
					else
						pending.textAccumulated = block.accumulatedContent;
				}

				publishMessageBlock(msg.requestId, msg.sessionId, block);
			},
			abortController.signal,
		);

		if (abortController.signal.aborted)
			return;

		// 保存最后一条用户消息（用于重新生成）
		lastUserMessageBySession.set(msg.sessionId, cloneUserMessage(msg));

		publishToIFrame(CHAT_TOPICS.AI_RESPONSE, {
			content: reply,
			timestamp: Date.now(),
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
	}
	catch (error) {
		// 如果是中止错误，静默处理
		if (isAbortError(error))
			return;

		const payload = buildErrorPayload(error);
		publishToIFrame(CHAT_TOPICS.ERROR, {
			...payload,
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
	}
	finally {
		pendingRequests.delete(msg.requestId);
	}
}

/**
 * 处理定位请求
 */
async function handleLocateRequest(reference: string): Promise<void> {
	try {
		// 判断是器件位号还是网络名
		const isComponent = /^[URCLDQJK]\d+$/i.test(reference);

		if (isComponent) {
			await eda.sch_SelectControl.doCrossProbeSelect(
				[reference], // components
				[], // pins
				[], // nets
				true, // clearSelection
				true, // zoomToFit
			);
		}
		else {
			await eda.sch_SelectControl.doCrossProbeSelect(
				[],
				[],
				[reference],
				true,
				true,
			);
		}
	}
	catch (error) {
		console.warn('定位失败:', error);
	}
}

// ============ 会话管理（按 sessionId 隔离） ============

/**
 * 获取或创建指定 sessionId 的对话会话
 */
function getOrCreateChatSession(sessionId: string): ChatSession {
	const existing = chatSessions.get(sessionId);
	if (existing)
		return existing;

	const session = new ChatSession();
	if (cachedSchematicData) {
		session.setSchematicContext(cachedSchematicData);
	}

	chatSessions.set(sessionId, session);
	return session;
}

/**
 * 清空所有对话会话
 */
function clearAllChatSessions(): void {
	abortAllPendingRequests();

	for (const session of chatSessions.values()) {
		session.reset();
	}
	chatSessions.clear();
	lastUserMessageBySession.clear();
}

// ============ 中止管理 ============

/**
 * 处理停止生成请求
 */
function handleAbortRequest(data: AbortRequest): void {
	const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
	const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';

	if (!requestId || !sessionId)
		return;

	const pending = pendingRequests.get(requestId);
	if (!pending)
		return;
	if (pending.sessionId !== sessionId)
		return;

	pending.abortController.abort();
	publishPausedCompleteBlocks(requestId, sessionId, pending);
	pendingRequests.delete(requestId);
}

/**
 * 处理重新生成请求
 */
async function handleRegenerateRequest(data: RegenerateRequest): Promise<void> {
	const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
	const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';

	if (!requestId || !sessionId) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '重新生成请求格式错误',
			code: 'REGENERATE_REQUEST_INVALID',
		});
		return;
	}

	// 如果当前会话还有进行中的请求，先中止
	abortPendingRequestsBySession(sessionId);

	const session = chatSessions.get(sessionId);
	if (!session) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '未找到可重新生成的会话',
			code: 'REGENERATE_SESSION_NOT_FOUND',
			requestId,
			sessionId,
		});
		return;
	}

	const lastUserMessage = lastUserMessageBySession.get(sessionId);
	if (!lastUserMessage) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '当前会话没有可重新生成的用户消息',
			code: 'REGENERATE_NO_MESSAGE',
			requestId,
			sessionId,
		});
		return;
	}

	// 回滚最后一轮对话，再重新发送
	session.clear();

	const regenerateMessage: UserMessage = {
		...cloneUserMessage(lastUserMessage),
		requestId,
		sessionId,
	};
	await handleUserMessage(regenerateMessage);
}

/**
 * 中止全部进行中请求
 */
function abortAllPendingRequests(): void {
	for (const pending of pendingRequests.values()) {
		pending.abortController.abort();
	}
	pendingRequests.clear();
}

/**
 * 中止指定会话的所有进行中请求
 */
function abortPendingRequestsBySession(sessionId: string): void {
	for (const [requestId, pending] of pendingRequests.entries()) {
		if (pending.sessionId !== sessionId)
			continue;

		pending.abortController.abort();
		pendingRequests.delete(requestId);
	}
}

/**
 * 发送 paused 状态的 COMPLETE 事件（中止时使用）
 */
function publishPausedCompleteBlocks(
	requestId: string,
	sessionId: string,
	pending: PendingRequestState,
): void {
	if (pending.thinkingAccumulated) {
		publishMessageBlock(requestId, sessionId, {
			type: ChunkType.THINKING_COMPLETE,
			content: '',
			accumulatedContent: pending.thinkingAccumulated,
			timestamp: Date.now(),
			status: 'paused',
		});
	}
	publishMessageBlock(requestId, sessionId, {
		type: ChunkType.TEXT_COMPLETE,
		content: '',
		accumulatedContent: pending.textAccumulated,
		timestamp: Date.now(),
		status: 'paused',
	});
}

/**
 * 判断是否为中止错误
 */
function isAbortError(error: unknown): boolean {
	return error instanceof ReviewError && error.code === ErrorCode.AI_ABORTED;
}

/**
 * 构建错误消息的 payload
 */
function buildErrorPayload(error: unknown): { message: string; code?: string; details?: unknown } {
	if (error instanceof ReviewError) {
		return {
			message: error.message,
			code: error.code,
			details: error.details,
		};
	}

	if (error instanceof Error) {
		return {
			message: `AI请求失败: ${error.message}`,
			details: { name: error.name, message: error.message },
		};
	}

	return {
		message: `AI请求失败: ${String(error)}`,
	};
}

/**
 * 深拷贝用户消息（用于重新生成）
 */
function cloneUserMessage(msg: UserMessage): UserMessage {
	return {
		...msg,
		images: msg.images?.map(img => ({ ...img })),
		schematicData: msg.schematicData
			? {
					summary: { ...msg.schematicData.summary },
					timestamp: msg.schematicData.timestamp,
				}
			: msg.schematicData,
	};
}

// ============ 流式 Block 推送 ============

/**
 * 将 MessageBlock 推送到 IFrame
 * thinking 类型使用 AI_THINKING topic，text 类型使用 AI_TEXT topic
 */
function publishMessageBlock(
	requestId: string,
	sessionId: string,
	block: MessageBlock,
): void {
	const topic = isThinkingBlock(block.type)
		? CHAT_TOPICS.AI_THINKING
		: CHAT_TOPICS.AI_TEXT;

	const payload: AIBlockResponse = {
		...block,
		requestId,
		sessionId,
	};

	publishToIFrame(topic, payload);
}

/**
 * 判断是否为 thinking 类型的 block
 */
function isThinkingBlock(type: ChunkType): boolean {
	return type === ChunkType.THINKING_START
		|| type === ChunkType.THINKING_DELTA
		|| type === ChunkType.THINKING_COMPLETE;
}

// ============ MessageBus 通信 ============

/**
 * 发布消息到IFrame
 */
function publishToIFrame(topic: string, data: unknown): void {
	try {
		eda.sys_MessageBus.publishPublic(topic, data);
	}
	catch {
		console.warn('发布消息失败:', topic);
	}
}

/**
 * 订阅MessageBus
 */
function subscribe(topic: string, handler: (data: any) => void | Promise<void>): void {
	const task = eda.sys_MessageBus.subscribePublic(topic, handler);
	subscriptions.push(task);
}

/**
 * 清理所有订阅
 */
function cleanupSubscriptions(): void {
	for (const sub of subscriptions) {
		try {
			sub.cancel();
		}
		catch {
			// ignore cleanup errors
		}
	}
	subscriptions.length = 0;
}
