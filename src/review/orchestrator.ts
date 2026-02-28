import type { SendMessageOptions } from './chat-adapter';
/**
 * AI原理图审查 - 对话模式编排器
 *
 * 管理IFrame面板与AI对话的完整生命周期
 * 按 sessionId 隔离对话会话，支持流式 thinking/text 推送
 */
import type { AbortRequest, AIBlockResponse, ChatToolCall, CollectedData, MessageBlock, RegenerateRequest, ToolEventMessage, UserMessage } from './types';
import { ChatSession, setDebugLog } from './chat-adapter';
import { clearBackgroundNetlistState, collectSchematicData, getBackgroundNetlistState, parseNetlist, setLogToIFrame } from './collector';
import { loadChatHistory, loadConfig, saveChatHistory, saveConfig, validateConfig } from './config';
import { clearSessionCache, ToolOrchestrator } from './tool-orchestrator';
import { CHAT_TOPICS, ChunkType, ErrorCode, ReviewError } from './types';

// 初始化 collector 的日志发送函数
setLogToIFrame((level: string, message: string, data?: any) => {
	publishToIFrame('ai-chat/debug-log', { level, message, data });
});

// 初始化 chat-adapter 的日志发送函数
setDebugLog((level: string, message: string, data?: any) => {
	publishToIFrame('ai-chat/debug-log', { level, message, data });
});

/**
 * 按 sessionId 维护对话会话（替代单一全局 chatSession）
 */
const chatSessions = new Map<string, ChatSession>();

/**
 * 按 sessionId 维护 ToolOrchestrator 实例（避免重复创建和 initialize）
 */
const toolOrchestratorsBySession = new Map<string, ToolOrchestrator>();

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
 * 请求处理结果类型
 */
type RequestOutcome = 'success' | 'aborted' | 'failed' | 'rejected';

interface CompletedEntry {
	timestamp: number;
	outcome: RequestOutcome;
}

/**
 * 请求去重守卫（全局单例，不可外部重置）
 *
 * 合并原 processingRequests (Set) + completedRequests (Map) 为单一不可篡改的防重机制。
 * 根治"clearAllChatSessions 意外清除 completedRequests 导致旧 MessageBus 回调绕过防重"的问题。
 *
 * 设计原则：
 * - tryAcquire/release 是唯一操作入口，外部无法 clear/reset
 * - 已完成请求通过 TTL 自动淘汰，无需手动清理
 * - tryAcquire 前置过期清理，避免长时间空闲后旧条目误拦截
 */
class RequestGuard {
	private readonly processing = new Set<string>();
	private readonly completed = new Map<string, CompletedEntry>();
	private static readonly CACHE_TTL_MS = 60_000;

	/**
	 * 尝试获取 requestId 的处理权。
	 * 返回 true 表示获取成功（调用方必须在处理结束后调用 release），
	 * 返回 false 表示该 requestId 正在处理或已完成（应跳过）。
	 */
	tryAcquire(requestId: string): boolean {
		this.evictExpired();
		if (this.processing.has(requestId))
			return false;
		if (this.completed.has(requestId))
			return false;
		this.processing.add(requestId);
		return true;
	}

	/**
	 * 释放 requestId 的处理权，并标记为已完成。
	 * 必须在 handleUserMessage 的 finally 块中调用。
	 */
	release(requestId: string, outcome: RequestOutcome): void {
		this.processing.delete(requestId);
		this.completed.set(requestId, { timestamp: Date.now(), outcome });
		this.evictExpired();
	}

	/** 当前处理中的请求数量（仅用于日志） */
	get processingCount(): number {
		return this.processing.size;
	}

	/** 检查某个 requestId 是否正在处理中（仅用于日志） */
	isProcessing(requestId: string): boolean {
		return this.processing.has(requestId);
	}

	/** 获取已完成请求的状态（仅用于日志） */
	getCompleted(requestId: string): CompletedEntry | undefined {
		return this.completed.get(requestId);
	}

	/** 清理过期的已完成记录 */
	private evictExpired(): void {
		const now = Date.now();
		for (const [id, entry] of this.completed) {
			if (now - entry.timestamp > RequestGuard.CACHE_TTL_MS) {
				this.completed.delete(id);
			}
		}
	}
}

/** 全局唯一的请求防重守卫（不暴露 clear/reset，避免外部误清空） */
const requestGuard = new RequestGuard();

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
 * 订阅版本号（每次 setupChatListeners 递增）
 *
 * EDA MessageBus 的 cancel() 可能无法取消已排队但未执行的回调。
 * 通过版本号机制确保旧版本订阅产生的回调在执行时被丢弃。
 */
let listenerEpoch = 0;

/**
 * MCP 工具列表缓存（避免重复 initialize 请求）
 */
let toolListCache: { tools: Array<{ name: string; description: string }>; timestamp: number } | null = null;
const TOOL_CACHE_TTL_MS = 10_000; // 10 秒缓存有效期

/**
 * 正在进行的工具列表请求（用于合并并发请求）
 */
let toolListInflight: Promise<Array<{ name: string; description: string }>> | null = null;

/**
 * 后台采集 single-flight 调度状态（跨实例全局锁）
 */
declare global {
	// eslint-disable-next-line vars-on-top
	var __aiSchReview_collectionLock: {
		inFlight: Promise<void> | null;
		rerunPending: boolean;
		rerunReason: string;
		rerunNotify: boolean;
		epoch: number;
	} | undefined;
}

function getGlobalCollectionLock() {
	if (!globalThis.__aiSchReview_collectionLock) {
		globalThis.__aiSchReview_collectionLock = {
			inFlight: null,
			rerunPending: false,
			rerunReason: '',
			rerunNotify: false,
			epoch: 0,
		};
	}
	return globalThis.__aiSchReview_collectionLock;
}

/**
 * 检查是否正在采集中（用于外部抑制逻辑）
 */
export function isCollectionInProgress(): boolean {
	const lock = getGlobalCollectionLock();
	return lock.inFlight !== null;
}

/**
 * startAIChat 重入锁（防止用户快速双击菜单导致多次注册订阅）
 */
let startAIChatInFlight = false;

/**
 * 启动AI对话面板
 */
export async function startAIChat(): Promise<void> {
	// 防重入：openIFrame 是异步调用，双击菜单会导致两次调用并发执行
	if (startAIChatInFlight) {
		publishDebugLog('warn', '[startAIChat] 忽略重复调用（上次尚未完成）');
		return;
	}
	startAIChatInFlight = true;

	try {
		// 从配置读取窗口尺寸
		const config = loadConfig();
		const width = config.windowWidth || 960;
		const height = config.windowHeight || 700;

		// 打开IFrame面板（不阻塞，不立即采集数据）
		try {
			await eda.sys_IFrame.openIFrame('/iframe/chat.html', width, height, 'ai-sch-chat', {
				maximizeButton: true,
				minimizeButton: true,
			});
		}
		catch {
			throw new ReviewError(ErrorCode.UI_IFRAME_FAILED, '无法打开对话面板');
		}

		// 打开新面板时重置会话容器，避免旧面板状态串入
		clearAllChatSessions();

		// 设置MessageBus监听
		setupChatListeners();

		// 异步触发后台采集（不阻塞UI）
		void triggerBackgroundCollection('start-ai-chat', true);
	}
	finally {
		startAIChatInFlight = false;
	}
}

/**
 * 对外暴露：触发后台采集
 * - reason: 触发原因（便于日志追踪）
 * - notifyIFrame: 是否向 IFrame 发布采集中/完成状态
 */
export function triggerBackgroundCollection(
	reason = 'external-trigger',
	notifyIFrame = false,
): Promise<void> {
	const lock = getGlobalCollectionLock();

	if (lock.inFlight) {
		const wasPending = lock.rerunPending;
		lock.rerunPending = true;
		lock.rerunReason = reason;
		lock.rerunNotify = lock.rerunNotify || notifyIFrame;
		if (!wasPending) {
			publishDebugLog('info', '后台采集进行中，已登记重跑', {
				reason,
				notifyIFrame,
				epoch: lock.epoch,
			});
		}
		return lock.inFlight;
	}

	const epoch = ++lock.epoch;
	lock.inFlight = executeBackgroundCollection(epoch, reason, notifyIFrame)
		.finally(() => {
			lock.inFlight = null;

			if (!lock.rerunPending) {
				return;
			}

			const rerunReason = lock.rerunReason || 'rerun';
			const rerunNotify = lock.rerunNotify;
			lock.rerunPending = false;
			lock.rerunReason = '';
			lock.rerunNotify = false;

			void triggerBackgroundCollection(`${rerunReason}:rerun`, rerunNotify);
		});

	return lock.inFlight;
}

/**
 * 后台采集执行体
 * - single-flight 由 triggerBackgroundCollection 保证
 * - epoch/version 保证仅最新结果生效
 */
async function executeBackgroundCollection(
	epoch: number,
	reason: string,
	notifyIFrame: boolean,
): Promise<void> {
	const startTime = Date.now();
	try {
		if (notifyIFrame) {
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: -1, // -1 表示正在采集
					pins: -1,
					nets: -1,
				},
				timestamp: Date.now(),
			});
		}

		// 发送采集开始事件到 IFrame 调试日志
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `后台采集开始 (原因: ${reason}, epoch: ${epoch})`,
		});

		const collected = await collectSchematicData();

		const lock = getGlobalCollectionLock();
		// epoch/version：只接纳最新采集结果，过期结果直接丢弃
		if (epoch !== lock.epoch) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `采集结果被丢弃 (epoch ${epoch} 已过期, 当前 ${lock.epoch})`,
			});
			return;
		}

		cachedSchematicData = collected;

		// 将原理图数据注入所有已存在的会话
		for (const session of chatSessions.values()) {
			session.setSchematicContext(collected);
		}

		const elapsed = Date.now() - startTime;

		// 发送详细采集结果到 IFrame 调试日志
		publishToIFrame('ai-chat/debug-log', {
			level: 'success',
			message: `采集完成 (耗时 ${elapsed}ms)`,
			data: {
				components: collected.components.length,
				pins: collected.pins.length,
				nets: collected.nets.length,
				texts: collected.texts?.length || 0,
				buses: collected.buses?.length || 0,
				meta: collected.meta,
				elapsed,
			},
		});

		if (notifyIFrame) {
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: collected.components.length,
					pins: collected.pins.length,
					nets: collected.nets.length,
				},
				drcPassed: collected.drcResult?.passed,
				projectName: collected.projectInfo?.projectName,
				timestamp: collected.timestamp,
			});
		}

		// 如果网表超时但后台仍在获取，启动延迟回填
		void scheduleNetlistBackfill(epoch, collected);
	}
	catch (error) {
		const lock = getGlobalCollectionLock();
		// 过期任务失败不需要覆盖新任务状态
		if (epoch !== lock.epoch) {
			return;
		}

		const elapsed = Date.now() - startTime;
		const errorMsg = error instanceof Error ? error.message : String(error);

		// 发送错误日志到 IFrame
		publishDebugLog('error', `采集失败 (耗时 ${elapsed}ms): ${errorMsg}`, {
			reason,
			epoch,
		});

		if (notifyIFrame) {
			// 采集失败不阻塞 UI，对话仍可继续
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
}

/**
 * 延迟回填网表数据（如果后台网表获取成功）
 *
 * 策略：
 * 1. 检查 backgroundNetlistState 是否存在且未完成
 * 2. 使用定时器轮询检查完成状态（每 2 秒检查一次，最多 60 秒）
 * 3. 当完成时，重新解析网表并更新引脚的 netName
 * 4. 更新 cachedSchematicData 并通知 IFrame
 * 5. 使用 epoch 版本控制，避免过期任务覆盖新任务
 */
async function scheduleNetlistBackfill(
	epoch: number,
	collected: CollectedData,
): Promise<void> {
	const netlistState = getBackgroundNetlistState();

	// 如果没有后台网表任务，或者已经完成，直接返回
	if (!netlistState || netlistState.completed) {
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `网表回填检查: ${!netlistState ? '无后台网表任务' : '网表已完成（无需回填）'}`,
		});
		return;
	}

	publishToIFrame('ai-chat/debug-log', {
		level: 'info',
		message: '网表后台获取中，将在完成后自动回填引脚绑定...',
	});

	let pollCount = 0;
	const MAX_POLL_COUNT = 30; // 最多轮询 30 次（60 秒）
	const POLL_INTERVAL_MS = 2000; // 每 2 秒检查一次
	const TIMER_ID = `netlist-backfill-epoch-${epoch}`;

	eda.sys_Timer.setIntervalTimer(TIMER_ID, POLL_INTERVAL_MS, async () => {
		pollCount++;

		// 检查是否超过最大轮询次数
		if (pollCount > MAX_POLL_COUNT) {
			eda.sys_Timer.clearIntervalTimer(TIMER_ID);
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: '网表后台获取超时（60秒），放弃回填',
			});
			clearBackgroundNetlistState();
			return;
		}

		// 检查 epoch 是否过期
		const lock = getGlobalCollectionLock();
		if (epoch !== lock.epoch) {
			eda.sys_Timer.clearIntervalTimer(TIMER_ID);
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `网表回填任务被取消（epoch ${epoch} 已过期）`,
			});
			return;
		}

		// 检查网表是否完成
		const currentState = getBackgroundNetlistState();
		if (!currentState || !currentState.completed) {
			return; // 继续等待
		}

		// 网表已完成，停止轮询
		eda.sys_Timer.clearIntervalTimer(TIMER_ID);

		// 如果网表获取失败，直接返回
		if (!currentState.result) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `网表后台获取失败（耗时 ${currentState.duration}ms），无法回填`,
			});
			clearBackgroundNetlistState();
			return;
		}

		// 网表获取成功，开始回填
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `网表后台获取成功（耗时 ${currentState.duration}ms），开始回填引脚绑定...`,
		});

		try {
			// 解析网表
			const netlistMap = parseNetlist(currentState.result);

			if (netlistMap.size === 0) {
				publishToIFrame('ai-chat/debug-log', {
					level: 'warn',
					message: '网表解析结果为空，无法回填',
				});
				clearBackgroundNetlistState();
				return;
			}

			// 统计回填效果
			let reboundCount = 0;
			let improvedCount = 0;

			// 更新引脚的 netName（使用 L1 策略）
			for (const pin of collected.pins) {
				const pinKey = `${pin.componentDesignator}_${pin.pinNumber}`;
				const netNameFromNetlist = netlistMap.get(pinKey);

				if (netNameFromNetlist) {
					// 如果原来没有绑定，现在绑定了
					if (!pin.netName) {
						reboundCount++;
					}
					// 如果原来有绑定，但置信度较低（L2/L3/L4），现在用 L1 覆盖
					else if (pin.netBindingConfidence && pin.netBindingConfidence < 1.0) {
						improvedCount++;
					}

					// 更新引脚的网络绑定
					pin.netName = netNameFromNetlist;
					pin.netBindingConfidence = 1.0;
					pin.netBindingReason = 'netlist-backfill';
				}
			}

			// 重新构建网络统计
			const netMap = new Map<string, Set<string>>();
			for (const pin of collected.pins) {
				if (pin.netName) {
					if (!netMap.has(pin.netName)) {
						netMap.set(pin.netName, new Set());
					}
					netMap.get(pin.netName)!.add(pin.primitiveId);
				}
			}

			// 更新网络数据
			collected.nets = Array.from(netMap.entries()).map(([netName, pinIds]) => ({
				netName,
				pinCount: pinIds.size,
				pins: Array.from(pinIds),
			}));

			// 更新缓存数据（如果 epoch 仍然有效）
			const lock = getGlobalCollectionLock();
			if (epoch === lock.epoch) {
				cachedSchematicData = collected;

				// 将更新后的数据注入所有已存在的会话
				for (const session of chatSessions.values()) {
					session.setSchematicContext(collected);
				}

				// 通知 IFrame 数据已更新
				publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
					summary: {
						components: collected.components.length,
						pins: collected.pins.length,
						nets: collected.nets.length,
					},
					drcPassed: collected.drcResult?.passed,
					projectName: collected.projectInfo?.projectName,
					timestamp: collected.timestamp,
				});

				publishToIFrame('ai-chat/debug-log', {
					level: 'success',
					message: `网表回填完成：新绑定 ${reboundCount} 个引脚，改进 ${improvedCount} 个引脚绑定`,
					data: {
						reboundCount,
						improvedCount,
						totalNetlistMappings: netlistMap.size,
						totalPins: collected.pins.length,
						totalNets: collected.nets.length,
					},
				});
			}
			else {
				publishToIFrame('ai-chat/debug-log', {
					level: 'warn',
					message: `网表回填被丢弃（epoch ${epoch} 已过期）`,
				});
			}
		}
		catch (error) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'error',
				message: `网表回填失败: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		finally {
			clearBackgroundNetlistState();
		}
	}, POLL_INTERVAL_MS);
}

/**
 * 设置MessageBus监听器
 */
function setupChatListeners(): void {
	// 幂等保护：如果已有订阅存在，说明 startAIChat 被重复调用（如用户多次点击菜单）
	// 仅清理并重新注册即可，但需注意 EDA MessageBus 的 cancel 可能不完全生效
	const prevCount = subscriptions.length;
	cleanupSubscriptions();

	// 递增版本号，使旧回调在执行时自动失效
	const currentEpoch = ++listenerEpoch;
	publishDebugLog('info', '[setupChatListeners] 初始化订阅', {
		previousSubscriptionCount: prevCount,
		listenerEpoch: currentEpoch,
		note: prevCount > 0 ? '检测到旧订阅，已尝试清理并递增 epoch' : '首次注册',
	});

	// 监听IFrame请求原理图数据
	subscribe(CHAT_TOPICS.REQUEST_DATA, () => {
		if (cachedSchematicData) {
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: cachedSchematicData.components.length,
					pins: cachedSchematicData.pins.length,
					nets: cachedSchematicData.nets.length,
				},
				drcPassed: cachedSchematicData.drcResult?.passed,
				projectName: cachedSchematicData.projectInfo?.projectName,
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

	// 监听IFrame请求刷新原理图数据
	subscribe(CHAT_TOPICS.REFRESH_DATA, () => {
		publishDebugLog('info', '[手动刷新] 用户触发原理图数据刷新');
		void triggerBackgroundCollection('manual-refresh', true);
	});

	// 监听IFrame请求配置数据
	subscribe(CHAT_TOPICS.REQUEST_CONFIG, () => {
		const config = loadConfig();
		const customPrompt = typeof config.customSystemPrompt === 'string' ? config.customSystemPrompt.trim() : '';
		if (customPrompt) {
			publishDebugLog('info', '[REQUEST_CONFIG] 加载自定义系统提示词', {
				length: customPrompt.length,
			});
		}
		publishToIFrame(CHAT_TOPICS.CONFIG_DATA, {
			apiUrl: config.apiUrl,
			apiKey: config.apiKey || '',
			model: config.model,
			windowWidth: config.windowWidth || 960,
			windowHeight: config.windowHeight || 700,
			mcpEnabled: !!config.mcpEnabled,
			mcpGatewayUrl: config.mcpGatewayUrl || '',
			mcpGatewayApiKey: config.mcpGatewayApiKey || '',
			mcpAutoApprove: config.mcpAutoApprove !== false,
			customSystemPrompt: config.customSystemPrompt || '',
			schematicFields: config.schematicFields || {},
		});
	});

	// 监听IFrame请求历史记录
	subscribe(CHAT_TOPICS.REQUEST_HISTORY, () => {
		const history = loadChatHistory();
		publishToIFrame(CHAT_TOPICS.HISTORY_DATA, { messages: history });
	});

	// 监听IFrame请求工具列表
	subscribe(CHAT_TOPICS.REQUEST_TOOLS, async (data: any) => {
		const config = loadConfig();
		const incomingRequestId = typeof data?.requestId === 'string' ? data.requestId : '(none)';

		// 快速判断是否启用 MCP
		if (!config.mcpEnabled || !config.mcpGatewayUrl) {
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, { enabled: false, tools: [] });
			return;
		}

		// 1. 命中缓存则直接返回
		if (toolListCache && (Date.now() - toolListCache.timestamp < TOOL_CACHE_TTL_MS)) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'info',
				message: `[REQUEST_TOOLS] 缓存命中，直接返回 ${toolListCache.tools.length} 个工具 (requestId=${incomingRequestId})`,
			});
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, {
				enabled: true,
				tools: toolListCache.tools,
			});
			return;
		}

		// 2. 合并并发请求：如果已有 in-flight 请求，复用它
		if (toolListInflight) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'info',
				message: `[REQUEST_TOOLS] 合并到已有 inflight 请求 (requestId=${incomingRequestId})`,
			});
			try {
				const tools = await toolListInflight;
				publishToIFrame(CHAT_TOPICS.TOOLS_DATA, { enabled: true, tools });
			}
			catch (error) {
				publishToIFrame(CHAT_TOPICS.TOOLS_DATA, {
					enabled: true,
					tools: [],
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}

		// 3. 发起新请求
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `[REQUEST_TOOLS] 发起新的工具列表请求 (requestId=${incomingRequestId})`,
		});
		const requestId = typeof data?.requestId === 'string'
			? data.requestId
			: `tool-preview-${Date.now()}`;
		const sessionId = typeof data?.sessionId === 'string'
			? data.sessionId
			: 'tool-preview';
		const debugEmitter = (event: ToolEventMessage): void => {
			// 预览模式不发送工具 UI 事件，但将 session 日志转发到调试面板
			if (event.stage === 'mcp-session') {
				publishToIFrame('ai-chat/debug-log', {
					level: event.status === 'error' ? 'error' : 'info',
					message: event.title || '',
				});
			}
		};
		const toolOrchestrator = new ToolOrchestrator(
			config,
			{ requestId, sessionId },
			debugEmitter,
		);

		toolListInflight = toolOrchestrator.listTools()
			.then((tools) => {
				const mapped = tools.map(tool => ({
					name: tool.function.name,
					description: tool.function.description || '',
				}));
				// 更新缓存
				toolListCache = { tools: mapped, timestamp: Date.now() };
				publishToIFrame('ai-chat/debug-log', {
					level: 'success',
					message: `[REQUEST_TOOLS] 工具列表拉取成功，已缓存 ${mapped.length} 个工具`,
				});
				return mapped;
			})
			.finally(() => { toolListInflight = null; });

		try {
			const tools = await toolListInflight;
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, { enabled: true, tools: tools ?? [] });
		}
		catch (error) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'error',
				message: `[REQUEST_TOOLS] 工具列表拉取失败: ${error instanceof Error ? error.message : String(error)}`,
			});
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, {
				enabled: true,
				tools: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// 监听用户消息
	subscribe(CHAT_TOPICS.USER_MESSAGE, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		// epoch 校验：丢弃旧版本订阅产生的回调（EDA MessageBus cancel 可能不彻底）
		if (currentEpoch !== listenerEpoch) {
			publishDebugLog('warn', '[USER_MESSAGE] 丢弃过期订阅回调', {
				callbackEpoch: currentEpoch,
				currentEpoch: listenerEpoch,
				requestId: (data as any)?.requestId,
			});
			return;
		}
		await handleUserMessage(data as UserMessage);
	});

	// 监听停止生成请求
	subscribe(CHAT_TOPICS.ABORT_REQUEST, (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		if (currentEpoch !== listenerEpoch) {
			publishDebugLog('warn', '[ABORT_REQUEST] 丢弃过期订阅回调', {
				callbackEpoch: currentEpoch,
				currentEpoch: listenerEpoch,
			});
			return;
		}
		handleAbortRequest(data as AbortRequest);
	});

	// 监听重新生成请求
	subscribe(CHAT_TOPICS.REGENERATE_REQUEST, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		if (currentEpoch !== listenerEpoch) {
			publishDebugLog('warn', '[REGENERATE_REQUEST] 丢弃过期订阅回调', {
				callbackEpoch: currentEpoch,
				currentEpoch: listenerEpoch,
			});
			return;
		}
		await handleRegenerateRequest(data as RegenerateRequest);
	});

	// 监听定位请求
	subscribe(CHAT_TOPICS.LOCATE, async (data: any) => {
		if (currentEpoch !== listenerEpoch) {
			publishDebugLog('warn', '[LOCATE] 丢弃过期订阅回调', {
				callbackEpoch: currentEpoch,
				currentEpoch: listenerEpoch,
			});
			return;
		}
		if (!data?.reference)
			return;
		await handleLocateRequest(data.reference);
	});

	// 监听配置更新
	subscribe(CHAT_TOPICS.CONFIG_UPDATE, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;

		// 验证字段类型和长度
		if (data.apiUrl && (typeof data.apiUrl !== 'string' || data.apiUrl.length > 500)) {
			publishDebugLog('warn', '配置验证失败: 无效的 apiUrl');
			return;
		}
		if (data.apiKey && (typeof data.apiKey !== 'string' || data.apiKey.length > 500)) {
			publishDebugLog('warn', '配置验证失败: 无效的 apiKey');
			return;
		}
		if (data.model && (typeof data.model !== 'string' || data.model.length > 100)) {
			publishDebugLog('warn', '配置验证失败: 无效的 model');
			return;
		}
		if (data.mcpEnabled !== undefined && typeof data.mcpEnabled !== 'boolean') {
			publishDebugLog('warn', '配置验证失败: 无效的 mcpEnabled');
			return;
		}
		if (data.mcpAutoApprove !== undefined && typeof data.mcpAutoApprove !== 'boolean') {
			publishDebugLog('warn', '配置验证失败: 无效的 mcpAutoApprove');
			return;
		}
		if (data.mcpGatewayUrl && (typeof data.mcpGatewayUrl !== 'string' || data.mcpGatewayUrl.length > 500)) {
			publishDebugLog('warn', '配置验证失败: 无效的 mcpGatewayUrl');
			return;
		}
		if (data.mcpGatewayApiKey && (typeof data.mcpGatewayApiKey !== 'string' || data.mcpGatewayApiKey.length > 500)) {
			publishDebugLog('warn', '配置验证失败: 无效的 mcpGatewayApiKey');
			return;
		}
		if (data.customSystemPrompt !== undefined) {
			if (typeof data.customSystemPrompt !== 'string') {
				publishDebugLog('warn', '配置验证失败: customSystemPrompt 类型错误');
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: '配置保存失败: 自定义系统提示词格式无效',
					code: 'CONFIG_VALIDATION_FAILED',
				});
				return;
			}
			if (data.customSystemPrompt.length > 5000) {
				publishDebugLog('warn', '配置验证失败: customSystemPrompt 超长', {
					length: data.customSystemPrompt.length,
				});
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: '配置保存失败: 自定义系统提示词最多 5000 字符',
					code: 'CONFIG_VALIDATION_FAILED',
				});
				return;
			}
		}

		// 验证 schematicFields（若存在，必须是纯 boolean 键值对对象）
		if (data.schematicFields !== undefined) {
			if (typeof data.schematicFields !== 'object' || data.schematicFields === null || Array.isArray(data.schematicFields)) {
				publishDebugLog('warn', '配置验证失败: schematicFields 类型错误');
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: '配置保存失败: schematicFields 格式无效',
					code: 'CONFIG_VALIDATION_FAILED',
				});
				return;
			}
			// 校验所有值必须是 boolean（允许空对象）
			for (const [k, v] of Object.entries(data.schematicFields)) {
				if (typeof v !== 'boolean') {
					publishDebugLog('warn', `配置验证失败: schematicFields.${k} 不是 boolean`);
					publishToIFrame(CHAT_TOPICS.ERROR, {
						message: `配置保存失败: schematicFields.${k} 值无效`,
						code: 'CONFIG_VALIDATION_FAILED',
					});
					return;
				}
			}
		}

		// 验证 URL 格式
		if (data.apiUrl) {
			try {
				const url = new URL(data.apiUrl);
				if (url.protocol !== 'http:' && url.protocol !== 'https:') {
					publishDebugLog('warn', '配置验证失败: apiUrl 必须是 http 或 https 协议');
					return;
				}
			}
			catch {
				publishDebugLog('warn', '配置验证失败: apiUrl 格式无效');
				return;
			}
		}
		if (typeof data.mcpGatewayUrl === 'string' && data.mcpGatewayUrl.trim().length > 0) {
			try {
				const gatewayUrl = new URL(data.mcpGatewayUrl);
				if (gatewayUrl.protocol !== 'http:' && gatewayUrl.protocol !== 'https:') {
					publishDebugLog('warn', '配置验证失败: mcpGatewayUrl 必须是 http 或 https 协议');
					return;
				}
			}
			catch {
				publishDebugLog('warn', '配置验证失败: mcpGatewayUrl 格式无效');
				return;
			}
		}

		// 配置变更时清空工具缓存，确保下次请求重新拉取
		toolListCache = null;
		clearSessionCache(); // 清空 MCP Session 缓存

		// 记录自定义系统提示词变更
		if (data.customSystemPrompt !== undefined) {
			const trimmed = typeof data.customSystemPrompt === 'string' ? data.customSystemPrompt.trim() : '';
			publishDebugLog('info', `[CONFIG_UPDATE] 自定义系统提示词${trimmed ? '已设置' : '已清空'}`, {
				length: trimmed.length,
			});
		}

		const result = await saveConfig(data);

		if (!result.success) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `配置保存失败: ${result.error || '未知错误'}`,
				code: 'CONFIG_SAVE_FAILED',
			});
			return;
		}

		// 保存成功后回传配置
		publishToIFrame(CHAT_TOPICS.CONFIG_DATA, {
			apiUrl: result.config.apiUrl,
			apiKey: result.config.apiKey || '',
			model: result.config.model,
			windowWidth: result.config.windowWidth || 960,
			windowHeight: result.config.windowHeight || 700,
			mcpEnabled: !!result.config.mcpEnabled,
			mcpGatewayUrl: result.config.mcpGatewayUrl || '',
			mcpGatewayApiKey: result.config.mcpGatewayApiKey || '',
			mcpAutoApprove: result.config.mcpAutoApprove !== false,
			customSystemPrompt: result.config.customSystemPrompt || '',
			schematicFields: result.config.schematicFields || {},
		});

		// 若字段配置有变更，刷新所有现有会话
		if (data.schematicFields !== undefined) {
			const newFields = result.config.schematicFields;
			publishDebugLog('info', '[CONFIG_UPDATE] schematicFields 已变更，刷新所有会话字段配置', {
				sessionCount: chatSessions.size,
				hasData: !!cachedSchematicData,
			});
			for (const session of chatSessions.values()) {
				// 无论是否有缓存数据，都先更新字段配置
				if (newFields) {
					session.updateSchematicFields(newFields);
				}
				// 只有有缓存数据时才重新序列化上下文
				if (cachedSchematicData) {
					session.updateSchematicContext(cachedSchematicData);
				}
			}
		}
	});

	// 监听历史记录更新
	subscribe(CHAT_TOPICS.HISTORY_UPDATE, async (data: any) => {
		if (!data || !Array.isArray(data.messages))
			return;

		// 验证数组大小
		if (data.messages.length > 100) {
			publishDebugLog('warn', '历史记录验证失败: 会话数量过多');
			return;
		}

		// 验证每个会话的结构
		for (const session of data.messages) {
			if (!session || typeof session !== 'object') {
				publishDebugLog('warn', '历史记录验证失败: 无效的会话结构');
				return;
			}
			if (!session.id || typeof session.id !== 'string' || session.id.length > 100) {
				publishDebugLog('warn', '历史记录验证失败: 无效的会话 ID');
				return;
			}
			if (!Array.isArray(session.messages) || session.messages.length > 1000) {
				publishDebugLog('warn', '历史记录验证失败: 无效的会话消息列表');
				return;
			}
			// 验证消息结构
			for (const msg of session.messages) {
				if (!msg || typeof msg !== 'object') {
					publishDebugLog('warn', '历史记录验证失败: 无效的消息结构');
					return;
				}
				if (!msg.role || (msg.role !== 'user' && msg.role !== 'ai')) {
					publishDebugLog('warn', '历史记录验证失败: 无效的消息角色');
					return;
				}
				if (typeof msg.content !== 'string' || msg.content.length > 100000) {
					publishDebugLog('warn', '历史记录验证失败: 无效的消息内容');
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
		if (currentEpoch !== listenerEpoch) {
			publishDebugLog('warn', '[CLEAR_SESSION] 丢弃过期订阅回调', {
				callbackEpoch: currentEpoch,
				currentEpoch: listenerEpoch,
			});
			return;
		}
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

			// 清理该会话的 ToolOrchestrator
			toolOrchestratorsBySession.delete(sessionId);
			return;
		}

		// 无 sessionId 时清空所有会话
		clearAllChatSessions();
	});

	// 监听恢复会话请求（从历史记录恢复上下文）
	subscribe('ai-chat/restore-session', (data: any) => {
		if (currentEpoch !== listenerEpoch) {
			publishDebugLog('warn', '[RESTORE_SESSION] 丢弃过期订阅回调', {
				callbackEpoch: currentEpoch,
				currentEpoch: listenerEpoch,
			});
			return;
		}
		if (!data || typeof data !== 'object') {
			return;
		}

		const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
		const messages = Array.isArray(data.messages) ? data.messages : [];

		if (!sessionId || messages.length === 0) {
			return;
		}

		// 获取或创建会话
		const session = getOrCreateChatSession(sessionId);

		// 重建历史记录
		session.reset(); // 先清空
		for (const msg of messages) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}

			const role = msg.role === 'user' ? 'user' : 'assistant';
			const content = typeof msg.content === 'string' ? msg.content : '';

			// 如果是 assistant 消息且有 thinkingSummary，合并到 content
			let finalContent = content;
			if (role === 'assistant' && msg.thinkingSummary) {
				finalContent = `${msg.thinkingSummary}\n\n${content}`;
			}

			// 直接操作 history（绕过 sendMessage 的验证）
			(session as any).history.push({
				role,
				content: finalContent,
			});
		}

		publishDebugLog('info', '[restoreSession] 会话恢复完成', {
			sessionId,
			messageCount: messages.length,
		});
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

	publishDebugLog('info', '[handleUserMessage] 收到请求', {
		requestId: msg.requestId,
		sessionId: msg.sessionId,
		hasText: !!msg.text,
		imageCount: msg.images?.length || 0,
		guardProcessingCount: requestGuard.processingCount,
	});

	// 统一防重：tryAcquire 合并了 processing + completed 的检查，且不可被外部 clear
	if (!requestGuard.tryAcquire(msg.requestId)) {
		const completed = requestGuard.getCompleted(msg.requestId);
		if (completed) {
			publishDebugLog('info', '[handleUserMessage] 忽略已完成请求', {
				requestId: msg.requestId,
				elapsed: Date.now() - completed.timestamp,
				outcome: completed.outcome,
			});
		}
		else {
			publishDebugLog('warn', '[handleUserMessage] 忽略重复请求（正在处理中）', {
				requestId: msg.requestId,
				guardProcessingCount: requestGuard.processingCount,
			});
		}
		return;
	}

	const requestStartTime = Date.now();
	let requestOutcome: RequestOutcome = 'failed';

	try {
		// 验证文本长度
		if (msg.text && msg.text.length > 50000) {
			requestOutcome = 'rejected';
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
				requestOutcome = 'rejected';
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: '图片数量过多（最大 10 张）',
					requestId: msg.requestId,
					sessionId: msg.sessionId,
				});
				return;
			}

			for (const img of msg.images) {
				if (img.data && img.data.length > 10 * 1024 * 1024) {
					requestOutcome = 'rejected';
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
			requestOutcome = 'rejected';
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `请先配置AI: ${configError}`,
				code: ErrorCode.AI_NO_CONFIG,
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			return;
		}

		// 创建新的 AbortController
		const abortController = new AbortController();
		pendingRequests.set(msg.requestId, {
			sessionId: msg.sessionId,
			abortController,
			thinkingAccumulated: '',
			textAccumulated: '',
		});

		// 按 sessionId 获取或创建会话（核心隔离机制）
		const session = getOrCreateChatSession(msg.sessionId);

		// 获取或创建工具编排器（会话级复用，避免重复 initialize）
		let toolOrchestrator = toolOrchestratorsBySession.get(msg.sessionId);
		if (!toolOrchestrator) {
			toolOrchestrator = new ToolOrchestrator(
				config,
				{ requestId: msg.requestId, sessionId: msg.sessionId },
				publishToolEvent,
			);
			toolOrchestratorsBySession.set(msg.sessionId, toolOrchestrator);
			publishDebugLog('info', '[handleUserMessage] 创建新的 ToolOrchestrator', {
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
		}
		else {
			// 复用时必须更新 requestId，否则工具事件会携带旧请求 ID，
			// 导致前端匹配不到当前消息，创建多余的工具调用提示框
			publishDebugLog('info', '[handleUserMessage] 复用已有 ToolOrchestrator，更新 requestId', {
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			toolOrchestrator.updateRequestContext(msg.requestId);
		}

		// 如果启用 MCP，拉取工具列表
		let availableTools: import('./types').ChatToolDefinition[] = [];
		if (toolOrchestrator.isEnabled()) {
			try {
				availableTools = await toolOrchestrator.listTools(abortController.signal);
			}
			catch (toolListError) {
				publishToolEvent({
					requestId: msg.requestId,
					sessionId: msg.sessionId,
					eventId: `tool-list-error-${Date.now()}`,
					stage: 'tools-list',
					status: 'error',
					title: '加载工具清单失败，继续纯文本对话',
					error: toolListError instanceof Error ? toolListError.message : String(toolListError),
					timestamp: Date.now(),
				});
			}
		}

		// 构建 sendMessage 选项
		const sendOptions: SendMessageOptions | undefined = toolOrchestrator.isEnabled()
			? {
					tools: availableTools,
					onToolCalls: async (toolCalls: ChatToolCall[]) => {
						return await toolOrchestrator.executeToolCalls(toolCalls, abortController.signal);
					},
					maxToolRounds: 6,
				}
			: undefined;

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
			sendOptions,
		);

		if (abortController.signal.aborted) {
			requestOutcome = 'aborted';
			publishDebugLog('info', '[handleUserMessage] 请求已中止', {
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			return;
		}

		requestOutcome = 'success';
		// 保存最后一条用户消息（用于重新生成）
		lastUserMessageBySession.set(msg.sessionId, cloneUserMessage(msg));

		publishToIFrame(CHAT_TOPICS.AI_RESPONSE, {
			content: reply,
			timestamp: Date.now(),
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});

		publishDebugLog('success', '[handleUserMessage] 响应发送完成', {
			requestId: msg.requestId,
			sessionId: msg.sessionId,
			replyLength: reply.length,
			elapsed: Date.now() - requestStartTime,
		});
	}
	catch (error) {
		publishDebugLog('error', '[handleUserMessage] 处理失败', {
			requestId: msg.requestId,
			sessionId: msg.sessionId,
			error: error instanceof Error ? error.message : String(error),
		});

		// 如果是中止错误，静默处理
		if (isAbortError(error)) {
			requestOutcome = 'aborted';
			publishDebugLog('info', '[handleUserMessage] 中止错误，静默处理', {
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			return;
		}

		const payload = buildErrorPayload(error);
		publishToIFrame(CHAT_TOPICS.ERROR, {
			...payload,
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
	}
	finally {
		// 清理进行中请求状态
		pendingRequests.delete(msg.requestId);
		// 释放 RequestGuard 处理权并标记为已完成（过期自动清理）
		requestGuard.release(msg.requestId, requestOutcome);
	}
}

/**
 * 处理定位请求
 */
async function handleLocateRequest(reference: string): Promise<void> {
	try {
		// 判断是器件位号还是网络名
		const isComponent = /^[URCLDQJK]\d+$/i.test(reference);
		const type = isComponent ? '器件' : '网络';

		publishDebugLog('info', `[定位] 尝试定位${type}`, {
			reference,
			type: isComponent ? 'component' : 'net',
		});

		let success = false;

		if (isComponent) {
			success = await eda.sch_SelectControl.doCrossProbeSelect(
				[reference], // components
				[], // pins
				[], // nets
				true, // clearSelection
				true, // zoomToFit
			);
		}
		else {
			success = await eda.sch_SelectControl.doCrossProbeSelect(
				[],
				[],
				[reference],
				true,
				true,
			);
		}

		if (success) {
			publishDebugLog('success', `[定位] ${type}定位成功`, {
				reference,
				type: isComponent ? 'component' : 'net',
			});
		}
		else {
			publishDebugLog('warn', `[定位] ${type}定位失败：API 返回 false（可能不存在或不在当前页面）`, {
				reference,
				type: isComponent ? 'component' : 'net',
			});
		}
	}
	catch (error) {
		publishDebugLog('error', '[定位] 定位异常', {
			reference,
			error: error instanceof Error ? error.message : String(error),
		});
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

	const config = loadConfig();
	const session = new ChatSession(undefined, config.schematicFields);
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

	// RequestGuard 为全局不可重置的防重守卫，此处不清空其状态。
	// 即使 MessageBus 在清理后重新投递旧消息，requestGuard 仍能拦截。

	for (const session of chatSessions.values()) {
		session.reset();
	}
	chatSessions.clear();
	lastUserMessageBySession.clear();
	toolListCache = null; // 清空工具缓存
	clearSessionCache(); // 清空 MCP Session 缓存
	toolOrchestratorsBySession.clear(); // 清空 ToolOrchestrator 缓存

	publishDebugLog('info', '[clearAllChatSessions] 已清理所有会话状态（RequestGuard 保持不变）');
}

// ============ 中止管理 ============

/**
 * 处理停止生成请求
 */
function handleAbortRequest(data: AbortRequest): void {
	const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
	const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';

	if (!requestId || !sessionId) {
		publishDebugLog('warn', '[abort] 请求格式无效', { requestId, sessionId });
		return;
	}

	const pending = pendingRequests.get(requestId);
	if (!pending) {
		publishDebugLog('info', '[abort] 未找到进行中请求', { requestId, sessionId });
		return;
	}
	if (pending.sessionId !== sessionId) {
		publishDebugLog('warn', '[abort] sessionId 不匹配，忽略', {
			requestId,
			expectedSessionId: pending.sessionId,
			actualSessionId: sessionId,
		});
		return;
	}

	pending.abortController.abort();
	publishDebugLog('info', '[abort] 请求已中止', { requestId, sessionId });
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
					drcPassed: msg.schematicData.drcPassed,
					projectName: msg.schematicData.projectName,
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
 * 推送工具运行事件到 IFrame
 */
function publishToolEvent(event: ToolEventMessage): void {
	publishToIFrame(CHAT_TOPICS.TOOL_EVENT, event);
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
 * 统一调试日志发送（发送到 IFrame 调试面板）
 */
function publishDebugLog(level: string, message: string, data?: unknown): void {
	publishToIFrame('ai-chat/debug-log', { level, message, data });
}

/**
 * 发布消息到IFrame
 */
function publishToIFrame(topic: string, data: unknown): void {
	try {
		eda.sys_MessageBus.publishPublic(topic, data);
	}
	catch (error) {
		console.warn('发布消息失败:', topic, error instanceof Error ? error.message : '未知错误');
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
