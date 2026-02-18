/**
 * AI原理图审查 - 对话模式编排器
 *
 * 管理IFrame面板与AI对话的完整生命周期
 */
import type { CollectedData, UserMessage } from './types';
import { ChatSession } from './chat-adapter';
import { collectSchematicData } from './collector';
import { loadConfig, saveConfig, validateConfig } from './config';
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
				components: 0,
				pins: 0,
				nets: 0,
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
	subscribe(CHAT_TOPICS.CONFIG_UPDATE, (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		saveConfig(data);
	});
}

/**
 * 处理用户消息
 */
async function handleUserMessage(msg: UserMessage): Promise<void> {
	if (!chatSession) {
		publishToIFrame(CHAT_TOPICS.ERROR, { message: '会话未初始化' });
		return;
	}

	const config = loadConfig();
	const configError = validateConfig(config);

	if (configError) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: `请先配置AI: ${configError}`,
			code: ErrorCode.AI_NO_CONFIG,
		});
		return;
	}

	try {
		const reply = await chatSession.sendMessage(msg, config);

		publishToIFrame(CHAT_TOPICS.AI_RESPONSE, {
			content: reply,
			timestamp: Date.now(),
		});
	}
	catch (error) {
		const message = error instanceof ReviewError
			? error.message
			: `AI请求失败: ${error instanceof Error ? error.message : String(error)}`;

		publishToIFrame(CHAT_TOPICS.ERROR, {
			message,
			code: error instanceof ReviewError ? error.code : undefined,
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
