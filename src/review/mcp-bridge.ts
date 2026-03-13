/**
 * AI原理图审查 - MCP Bridge WebSocket 客户端
 *
 * 职责：
 * 1. 通过 eda.sys_WebSocket 连接到本地 eda-mcp-server
 * 2. 在 cachedSchematicData 更新时主动推送全量快照（CollectedData）
 * 3. 响应 server 的 request_data 拉取请求（server 重启后重连场景）
 * 4. 连接管理：自动重连、心跳保活、多实例防重（复用 globalThis 模式）
 *
 * 协议（JSON 消息）：
 *
 * 扩展 → Server:
 *   { type: "hello", app: { name, version }, project: { uuid, name } }
 *   { type: "snapshot", version, projectUuid, timestamp, payload }
 *   { type: "pong", timestamp, nonce? }
 *
 * Server → 扩展:
 *   { type: "request_data" }
 *   { type: "ping", nonce? }
 *   { type: "ack", version }
 */
import type { CollectedData } from './types';

// ============ 常量 ============

/** WebSocket 连接唯一标识符（EDA sys_WebSocket API 要求） */
const WS_ID = 'eda_ai_mcp_bridge_ws_v1';

/** 默认 MCP Bridge 服务端地址 */
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:3100';

/** 调试日志 MessageBus 主题 */
const DEBUG_TOPIC = 'ai-chat/debug-log';

/** 自动重连基础延迟（首次 3 秒） */
const RECONNECT_BASE_MS = 3_000;

/** 自动重连最大延迟 */
const RECONNECT_MAX_MS = 30_000;

/** 连接超时（8 秒内未收到 onConnected 则视为失败） */
const CONNECT_TIMEOUT_MS = 8_000;

/** 健康检查间隔 */
const HEALTH_CHECK_INTERVAL_MS = 5_000;

/** 心跳超时（最后一次收到消息后 45 秒内无任何消息则视为断连） */
const HEARTBEAT_TIMEOUT_MS = 45_000;

/** 定时器 ID 前缀（EDA sys_Timer API 要求全局唯一） */
const TIMER_RECONNECT = 'eda_ai_mcp_bridge_reconnect';
const TIMER_CONNECT_TIMEOUT = 'eda_ai_mcp_bridge_connect_timeout';
const TIMER_HEALTH_CHECK = 'eda_ai_mcp_bridge_health';

// ============ 状态类型 ============

/** 预序列化的快照缓存（避免重复 JSON.stringify） */
interface CachedSnapshot {
	version: number;
	json: string;
}

/**
 * Bridge 全局状态（跨 EDA 多实例共享）
 *
 * 与 orchestrator.ts 一致，使用 globalThis 模式确保只有一个 WS 连接。
 */
interface McpBridgeState {
	/** 目标 WS 地址 */
	url: string;
	/** 是否已调用 initMcpBridge */
	initialized: boolean;
	/** 是否用户主动断开（阻止自动重连） */
	manualClose: boolean;
	/** 是否正在建立连接 */
	connecting: boolean;
	/** 是否已连接 */
	connected: boolean;
	/** 连接纪元（每次发起新连接递增，旧回调凭此丢弃） */
	connectEpoch: number;
	/** 当前重连次数（连接成功后重置） */
	reconnectAttempt: number;
	/** 重连定时器是否活跃 */
	reconnectTimerActive: boolean;
	/** 最后一次收到 server 消息的时间戳 */
	lastMessageAt: number;
	/** 快照版本计数器（单调递增） */
	snapshotVersion: number;
	/** 最新一份快照的序列化缓存（内存中仅保留 1 份） */
	pendingSnapshot: CachedSnapshot | null;
}

declare global {
	// eslint-disable-next-line vars-on-top
	var __aiSchReview_mcpBridgeState: McpBridgeState | undefined;
}

// ============ 状态管理 ============

/**
 * 获取或初始化全局 Bridge 状态
 */
function getBridgeState(): McpBridgeState {
	if (!globalThis.__aiSchReview_mcpBridgeState) {
		globalThis.__aiSchReview_mcpBridgeState = {
			url: DEFAULT_BRIDGE_URL,
			initialized: false,
			manualClose: false,
			connecting: false,
			connected: false,
			connectEpoch: 0,
			reconnectAttempt: 0,
			reconnectTimerActive: false,
			lastMessageAt: 0,
			snapshotVersion: 0,
			pendingSnapshot: null,
		};
	}
	return globalThis.__aiSchReview_mcpBridgeState;
}

// ============ 工具函数 ============

/**
 * 调试日志：同时输出到 console 和 IFrame 调试面板
 */
function bridgeLog(level: 'info' | 'warn' | 'error' | 'success', message: string, data?: unknown): void {
	const prefixed = `[mcp-bridge] ${message}`;

	// console 输出（仅 warn/error）
	if (level === 'warn')
		console.warn(prefixed, data ?? '');
	else if (level === 'error')
		console.error(prefixed, data ?? '');

	// 转发到 IFrame 调试面板
	try {
		eda.sys_MessageBus.publishPublic(DEBUG_TOPIC, { level, message: prefixed, data });
	}
	catch {
		// IFrame 未打开时忽略
	}
}

/**
 * 提取 Error.message（兼容非 Error 类型）
 */
function toMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 规范化 WS 地址：校验协议、移除尾部斜杠
 */
function normalizeBridgeUrl(raw?: string): string {
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	if (!trimmed)
		return DEFAULT_BRIDGE_URL;

	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
			bridgeLog('warn', 'MCP Bridge 地址协议无效，回退到默认值', { input: trimmed });
			return DEFAULT_BRIDGE_URL;
		}
		// 移除纯根路径的尾部 /
		let normalized = parsed.toString();
		if (normalized.endsWith('/') && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
			normalized = normalized.slice(0, -1);
		}
		return normalized;
	}
	catch {
		bridgeLog('warn', 'MCP Bridge 地址格式无效，回退到默认值', { input: trimmed });
		return DEFAULT_BRIDGE_URL;
	}
}

// ============ 定时器封装 ============

/**
 * 安全清除定时器（不存在时不报错）
 */
function clearTimer(timerId: string): void {
	try {
		eda.sys_Timer.clearIntervalTimer(timerId);
	}
	catch {
		// 定时器不存在时忽略
	}
}

/**
 * 设置一次性定时器（利用 setIntervalTimer + 首次触发后自清除）
 */
function setOneShotTimer(timerId: string, delayMs: number, callback: () => void): void {
	clearTimer(timerId);
	eda.sys_Timer.setIntervalTimer(timerId, delayMs, () => {
		clearTimer(timerId);
		callback();
	});
}

// ============ WS 发送 ============

/**
 * 安全关闭 WS 连接（不存在时不报错）
 */
function safeClose(code: number, reason: string): void {
	try {
		(eda as any).sys_WebSocket.close(WS_ID, code, reason);
	}
	catch {
		// 连接不存在时忽略
	}
}

/**
 * 发送原始 JSON 字符串
 *
 * @returns 是否成功发送
 */
function sendRaw(json: string): boolean {
	const state = getBridgeState();
	if (!state.connected)
		return false;

	try {
		(eda as any).sys_WebSocket.send(WS_ID, json);
		return true;
	}
	catch (error) {
		bridgeLog('warn', '发送失败，触发重连', { error: toMsg(error) });
		forceReconnect('send-failed');
		return false;
	}
}

/**
 * 发送结构化消息（自动序列化）
 */
function sendMessage(message: Record<string, unknown>): boolean {
	try {
		return sendRaw(JSON.stringify(message));
	}
	catch (error) {
		bridgeLog('error', '消息序列化失败', { type: message.type, error: toMsg(error) });
		return false;
	}
}

// ============ 协议消息构造 ============

/**
 * 发送 hello 握手消息
 */
function sendHello(): void {
	const state = getBridgeState();

	// 尝试获取工程信息（非关键，失败不阻塞）
	let projectUuid = '';
	let projectName = '';
	try {
		const project = (globalThis as any).__aiSchReview_orchestratorState?.cachedSchematicData?.projectInfo;
		if (project) {
			projectUuid = project.projectUuid || '';
			projectName = project.projectName || '';
		}
	}
	catch {
		// 忽略
	}

	sendMessage({
		type: 'hello',
		app: { name: 'easyeda-ai-assistant', version: '1.4.0' },
		project: { uuid: projectUuid, name: projectName },
		snapshotVersion: state.snapshotVersion,
		timestamp: Date.now(),
	});
}

/**
 * 发送当前缓存的快照
 */
function sendCachedSnapshot(source: 'connect' | 'request_data' | 'push'): void {
	const state = getBridgeState();
	if (!state.pendingSnapshot) {
		if (source === 'request_data') {
			bridgeLog('info', '收到 request_data 但当前无可发送快照');
		}
		return;
	}

	if (sendRaw(state.pendingSnapshot.json)) {
		bridgeLog('success', `已发送原理图快照 (${source})`, {
			version: state.pendingSnapshot.version,
		});
	}
}

// ============ 连接生命周期 ============

/**
 * 退役当前连接（递增 epoch、关闭 WS、清理定时器）
 */
function retireConnection(code: number, reason: string): void {
	const state = getBridgeState();
	state.connected = false;
	state.connecting = false;
	state.connectEpoch++;
	clearTimer(TIMER_CONNECT_TIMEOUT);
	clearTimer(TIMER_HEALTH_CHECK);
	safeClose(code, reason);
}

/**
 * 启动健康检查定时器
 *
 * 每隔 HEALTH_CHECK_INTERVAL_MS 检查最后一次收到消息的时间，
 * 若超过 HEARTBEAT_TIMEOUT_MS 则判定连接断开并触发重连。
 */
function startHealthCheck(): void {
	clearTimer(TIMER_HEALTH_CHECK);
	eda.sys_Timer.setIntervalTimer(TIMER_HEALTH_CHECK, HEALTH_CHECK_INTERVAL_MS, () => {
		const state = getBridgeState();
		if (!state.connected)
			return;

		const idleMs = Date.now() - state.lastMessageAt;
		if (idleMs > HEARTBEAT_TIMEOUT_MS) {
			bridgeLog('warn', '心跳超时，触发重连', { idleMs, timeoutMs: HEARTBEAT_TIMEOUT_MS });
			forceReconnect('heartbeat-timeout');
		}
	});
}

/**
 * 安排自动重连
 *
 * 指数退避：3s, 6s, 12s, 24s, 30s(max)
 */
function scheduleReconnect(reason: string): void {
	const state = getBridgeState();

	// 清理连接相关定时器
	clearTimer(TIMER_CONNECT_TIMEOUT);
	clearTimer(TIMER_HEALTH_CHECK);
	state.connected = false;
	state.connecting = false;

	// 防御：未初始化或手动关闭时不重连
	if (!state.initialized || state.manualClose)
		return;
	// 防重入：已有重连定时器则跳过
	if (state.reconnectTimerActive)
		return;

	const attempt = ++state.reconnectAttempt;
	state.reconnectTimerActive = true;

	const delayMs = Math.min(
		RECONNECT_BASE_MS * (2 ** (attempt - 1)),
		RECONNECT_MAX_MS,
	);

	bridgeLog('info', `自动重连已安排 (#${attempt})`, { reason, delayMs, url: state.url });

	setOneShotTimer(TIMER_RECONNECT, delayMs, () => {
		const current = getBridgeState();
		current.reconnectTimerActive = false;
		if (!current.initialized || current.manualClose)
			return;
		connectNow('auto-reconnect');
	});
}

/**
 * 处理 WS 连接建立回调
 */
function handleConnected(epoch: number): void {
	const state = getBridgeState();
	// epoch 校验：丢弃过期连接的回调
	if (epoch !== state.connectEpoch)
		return;

	state.connecting = false;
	state.connected = true;
	state.reconnectAttempt = 0;
	state.lastMessageAt = Date.now();

	// 清理重连和连接超时定时器
	state.reconnectTimerActive = false;
	clearTimer(TIMER_RECONNECT);
	clearTimer(TIMER_CONNECT_TIMEOUT);

	// 启动健康检查
	startHealthCheck();

	bridgeLog('success', 'MCP Bridge 已连接', { url: state.url, epoch });

	// 发送 hello 握手
	sendHello();

	// 如果有缓存快照，立即推送
	sendCachedSnapshot('connect');
}

/**
 * 处理 server 下发的消息
 */
function handleMessage(epoch: number, event: any): void {
	const state = getBridgeState();
	// epoch 校验
	if (epoch !== state.connectEpoch)
		return;

	state.lastMessageAt = Date.now();

	// 解析消息体：event 可能是 MessageEvent 或直接是 data
	const rawData = event?.data !== undefined ? event.data : event;

	let msg: Record<string, unknown>;
	try {
		if (typeof rawData === 'string') {
			msg = JSON.parse(rawData) as Record<string, unknown>;
		}
		else if (typeof rawData === 'object' && rawData !== null) {
			msg = rawData as Record<string, unknown>;
		}
		else {
			bridgeLog('warn', '收到无法解析的消息', { rawData });
			return;
		}
	}
	catch {
		bridgeLog('warn', '收到非 JSON 消息', { rawData });
		return;
	}

	if (typeof msg.type !== 'string') {
		bridgeLog('warn', '收到缺少 type 字段的消息', { msg });
		return;
	}

	switch (msg.type) {
		case 'ping': {
			// 回复 pong（携带 nonce 以便 server 匹配）
			const pong: Record<string, unknown> = { type: 'pong', timestamp: Date.now() };
			if (typeof msg.nonce === 'string')
				pong.nonce = msg.nonce;
			if (typeof msg.timestamp === 'number')
				pong.pingTimestamp = msg.timestamp;
			sendMessage(pong);
			break;
		}
		case 'request_data': {
			sendCachedSnapshot('request_data');
			break;
		}
		case 'ack': {
			bridgeLog('info', '收到快照确认', { version: msg.version });
			break;
		}
		default: {
			bridgeLog('warn', `收到未知消息类型: ${msg.type}`);
			break;
		}
	}
}

/**
 * 立即发起 WS 连接
 */
function connectNow(reason: string): void {
	const state = getBridgeState();
	if (!state.initialized || state.manualClose)
		return;
	if (state.connected || state.connecting)
		return;

	// 清理旧的重连/超时定时器
	state.reconnectTimerActive = false;
	clearTimer(TIMER_RECONNECT);
	clearTimer(TIMER_CONNECT_TIMEOUT);

	const epoch = ++state.connectEpoch;
	state.connecting = true;
	state.connected = false;

	bridgeLog('info', '开始连接 MCP Bridge', { reason, url: state.url, epoch });

	try {
		// 先关闭可能残存的旧连接
		safeClose(4000, 're-register');

		// 注册 WS 连接
		(eda as any).sys_WebSocket.register(
			WS_ID,
			state.url,
			(event: any) => handleMessage(epoch, event),
			() => handleConnected(epoch),
		);
	}
	catch (error) {
		state.connecting = false;
		const errorMsg = toMsg(error);

		// 检测权限类错误（如未授权"外部交互"权限），此类错误无法通过重连恢复
		const isPermissionError = /权限|permission|外部交互|not\s*allowed|forbidden|unauthorized/i.test(errorMsg);
		if (isPermissionError) {
			bridgeLog('error', 'MCP Bridge 连接被拒绝（可能缺少"外部交互"权限），已停止重连', { url: state.url, error: errorMsg });
			state.initialized = false;
			state.manualClose = true;
			return;
		}

		bridgeLog('warn', '注册 WS 失败', { url: state.url, error: errorMsg });
		scheduleReconnect('register-failed');
		return;
	}

	// 连接超时：8s 内未连接则触发重连
	setOneShotTimer(TIMER_CONNECT_TIMEOUT, CONNECT_TIMEOUT_MS, () => {
		const current = getBridgeState();
		if (epoch !== current.connectEpoch || current.connected || !current.connecting)
			return;

		current.connecting = false;
		bridgeLog('warn', '连接超时', { url: current.url, epoch, timeoutMs: CONNECT_TIMEOUT_MS });
		scheduleReconnect('connect-timeout');
	});
}

/**
 * 强制断开并重连（用于发送失败、心跳超时等场景）
 */
function forceReconnect(reason: string): void {
	const state = getBridgeState();
	if (!state.initialized || state.manualClose)
		return;

	retireConnection(4001, reason);
	state.reconnectTimerActive = false;
	clearTimer(TIMER_RECONNECT);
	scheduleReconnect(reason);
}

// ============ 公共 API ============

/**
 * 初始化 MCP Bridge 连接
 *
 * 幂等操作：多次调用仅在地址变化时重连。
 * 多实例场景下，所有实例共享同一个 globalThis 状态，第一个调用的实例建立连接，
 * 后续实例复用已有连接。
 *
 * @param url WS 地址，默认 ws://127.0.0.1:3100
 */
export function initMcpBridge(url?: string): void {
	const state = getBridgeState();
	const nextUrl = normalizeBridgeUrl(url);
	const urlChanged = state.url !== nextUrl;

	state.url = nextUrl;
	state.initialized = true;
	state.manualClose = false;
	state.reconnectAttempt = 0;

	// 地址变化时断开旧连接
	if (urlChanged && (state.connected || state.connecting)) {
		bridgeLog('info', 'MCP Bridge 地址变更，重新连接', { newUrl: nextUrl });
		retireConnection(4001, 'url-changed');
	}

	// 取消待执行的重连
	if (state.reconnectTimerActive) {
		state.reconnectTimerActive = false;
		clearTimer(TIMER_RECONNECT);
	}

	// 已连接/正在连接 且地址未变，无需操作
	if (state.connected || state.connecting)
		return;

	connectNow(urlChanged ? 'url-changed' : 'init');
}

/**
 * 推送原理图快照到 MCP Bridge
 *
 * 立即缓存快照（序列化后保存），如果当前已连接则同步发送。
 * 如果未连接，快照会在下次连接建立后或收到 request_data 时自动发送。
 *
 * @param data 采集到的完整原理图数据
 */
export function pushSnapshot(data: CollectedData): void {
	const state = getBridgeState();

	// 未初始化或已手动断开时跳过序列化，避免无谓开销
	if (!state.initialized || state.manualClose)
		return;

	const version = ++state.snapshotVersion;

	// 构建快照消息
	const message = {
		type: 'snapshot' as const,
		version,
		projectUuid: data.projectInfo?.projectUuid || '',
		timestamp: Date.now(),
		payload: data,
	};

	// 预序列化并缓存
	try {
		state.pendingSnapshot = { version, json: JSON.stringify(message) };
	}
	catch (error) {
		bridgeLog('error', '快照序列化失败', { version, error: toMsg(error) });
		return;
	}

	// 已连接则立即推送
	if (state.connected) {
		if (sendRaw(state.pendingSnapshot.json)) {
			bridgeLog('success', '已推送原理图快照', {
				version,
				components: data.components.length,
				pins: data.pins.length,
				nets: data.nets.length,
			});
		}
	}
	else {
		bridgeLog('info', '快照已缓存，等待连接后发送', { version });
	}
}

/**
 * 断开 MCP Bridge 连接
 *
 * 主动断开后不会自动重连，需要再次调用 initMcpBridge 重新连接。
 */
export function disconnectMcpBridge(): void {
	const state = getBridgeState();
	state.initialized = false;
	state.manualClose = true;
	state.reconnectAttempt = 0;

	state.reconnectTimerActive = false;
	clearTimer(TIMER_RECONNECT);
	retireConnection(1000, 'manual-disconnect');

	bridgeLog('info', 'MCP Bridge 已手动断开');
}

/**
 * 查询 MCP Bridge 连接状态
 */
export function isMcpBridgeConnected(): boolean {
	return getBridgeState().connected;
}
