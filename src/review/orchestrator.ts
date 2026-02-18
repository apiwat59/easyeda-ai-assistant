/**
 * AI原理图审查 - 对话模式编排器
 *
 * 管理IFrame面板与AI对话的完整生命周期
 */
import type { CollectedData, UserMessage } from './types';
import { ChatSession } from './chat-adapter';
import { collectSchematicData } from './collector';
import { loadChatHistory, loadConfig, saveChatHistory, saveConfig, validateConfig } from './config';
import { CHAT_TOPICS, ErrorCode, ReviewError } from './types';

/**
 * 全局对话会话
 */
let chatSession: ChatSession | null = null;

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

	// 初始化对话会话
	chatSession = new ChatSession();

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
		chatSession?.setSchematicContext(cachedSchematicData);

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
				components: -1, // 使用 -1 表示采集失败，与 REQUEST_DATA 保持一致
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

		// 安全限制：拒绝通过公共消息总线更新 apiKey
		if ('apiKey' in data && data.apiKey) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: '安全限制：API Key 不能通过消息总线更新。请使用扩展配置界面设置。',
				code: 'CONFIG_APIKEY_FORBIDDEN',
			});
			// 移除 apiKey 字段，继续处理其他配置
			delete data.apiKey;
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
			// 保存失败，发送错误消息
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `配置保存失败: ${result.error || '未知错误'}`,
				code: 'CONFIG_SAVE_FAILED',
			});
			return;
		}

		// 保存成功后回传配置状态（安全考虑：不发送 apiKey 实际值）
		publishToIFrame(CHAT_TOPICS.CONFIG_DATA, {
			apiUrl: result.config.apiUrl,
			apiKey: result.config.apiKey ? '***已配置***' : '', // 仅显示状态
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
			// 保存失败，发送错误消息
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `历史记录保存失败: ${result.error || '未知错误'}`,
				code: 'HISTORY_SAVE_FAILED',
			});
		}
	});

	// 监听清空会话请求
	subscribe(CHAT_TOPICS.CLEAR_SESSION, () => {
		if (chatSession) {
			chatSession.clear();
		}
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

	if (!chatSession) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '会话未初始化',
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
		return;
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

	try {
		const reply = await chatSession.sendMessage(msg, config);

		publishToIFrame(CHAT_TOPICS.AI_RESPONSE, {
			content: reply,
			timestamp: Date.now(),
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
	}
	catch (error) {
		const message = error instanceof ReviewError
			? error.message
			: `AI请求失败: ${error instanceof Error ? error.message : String(error)}`;

		publishToIFrame(CHAT_TOPICS.ERROR, {
			message,
			code: error instanceof ReviewError ? error.code : undefined,
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
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
