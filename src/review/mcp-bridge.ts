/**
 * AI Schematic Review - MCP Bridge WebSocket client
 *
 * Responsibilities:
 * 1. Connect to the local eda-mcp-server through eda.sys_WebSocket
 * 2. Proactively push the full snapshot (CollectedData) when cachedSchematicData updates
 * 3. Respond to server-side request_data pull requests after reconnect scenarios such as server restarts
 * 4. Manage the connection lifecycle: auto-reconnect, heartbeat keepalive, and duplicate-instance prevention using the globalThis pattern
 *
 * Protocol (JSON messages):
 *
 * Extension -> Server:
 *   { type: "hello", app: { name, version }, project: { uuid, name } }
 *   { type: "snapshot", version, projectUuid, timestamp, payload }
 *   { type: "pong", timestamp, nonce? }
 *
 * Server -> Extension:
 *   { type: "request_data" }
 *   { type: "ping", nonce? }
 *   { type: "ack", version }
 */
import type { CollectedData } from './types';

// ============ Constants ============

/** Unique WebSocket identifier required by the EDA sys_WebSocket API */
const WS_ID = 'eda_ai_mcp_bridge_ws_v1';

/** Default MCP Bridge server URL */
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:3100';

/** Debug log MessageBus topic */
const DEBUG_TOPIC = 'ai-chat/debug-log';

/** Base auto-reconnect delay in milliseconds (first retry is 3 seconds) */
const RECONNECT_BASE_MS = 3_000;

/** Maximum auto-reconnect delay */
const RECONNECT_MAX_MS = 30_000;

/** Connection timeout. If onConnected is not received within 8 seconds, treat it as a failure */
const CONNECT_TIMEOUT_MS = 8_000;

/** Health check interval */
const HEALTH_CHECK_INTERVAL_MS = 5_000;

/** Heartbeat timeout. If no message arrives within 45 seconds after the last received message, treat the connection as lost */
const HEARTBEAT_TIMEOUT_MS = 45_000;

/** Timer ID prefixes. The EDA sys_Timer API requires globally unique IDs */
const TIMER_RECONNECT = 'eda_ai_mcp_bridge_reconnect';
const TIMER_CONNECT_TIMEOUT = 'eda_ai_mcp_bridge_connect_timeout';
const TIMER_HEALTH_CHECK = 'eda_ai_mcp_bridge_health';

// ============ State Types ============

/** Pre-serialized snapshot cache to avoid repeated JSON.stringify calls */
interface CachedSnapshot {
	version: number;
	json: string;
}

/**
 * Global bridge state shared across multiple EDA instances
 *
 * Consistent with orchestrator.ts, this uses the globalThis pattern to ensure that only one WebSocket connection exists.
 */
interface McpBridgeState {
	/** Target WebSocket URL */
	url: string;
	/** Whether initMcpBridge has been called */
	initialized: boolean;
	/** Whether the user manually disconnected. This prevents auto-reconnect */
	manualClose: boolean;
	/** Whether a connection attempt is in progress */
	connecting: boolean;
	/** Whether the bridge is currently connected */
	connected: boolean;
	/** Connection epoch. Incremented for every new connection attempt so stale callbacks can be ignored */
	connectEpoch: number;
	/** Current reconnect attempt count. Reset after a successful connection */
	reconnectAttempt: number;
	/** Whether the reconnect timer is active */
	reconnectTimerActive: boolean;
	/** Timestamp of the last message received from the server */
	lastMessageAt: number;
	/** Snapshot version counter with monotonic increments */
	snapshotVersion: number;
	/** Serialized cache of the latest snapshot. Only one snapshot is retained in memory */
	pendingSnapshot: CachedSnapshot | null;
}

declare global {
	// eslint-disable-next-line vars-on-top
	var __aiSchReview_mcpBridgeState: McpBridgeState | undefined;
}

// ============ State Management ============

/**
 * Get or initialize the global bridge state
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

// ============ Utilities ============

/**
 * Debug logger that writes to both the console and the iframe debug panel
 */
function bridgeLog(level: 'info' | 'warn' | 'error' | 'success', message: string, data?: unknown): void {
	const prefixed = `[mcp-bridge] ${message}`;

	// Console output for warnings and errors only
	if (level === 'warn')
		console.warn(prefixed, data ?? '');
	else if (level === 'error')
		console.error(prefixed, data ?? '');

	// Forward logs to the iframe debug panel
	try {
		eda.sys_MessageBus.publishPublic(DEBUG_TOPIC, { level, message: prefixed, data });
	}
	catch {
		// Ignore when the iframe is not open
	}
}

/**
 * Extract Error.message while remaining compatible with non-Error values
 */
function toMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Normalize the WebSocket URL by validating the protocol and trimming a trailing slash
 */
function normalizeBridgeUrl(raw?: string): string {
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	if (!trimmed)
		return DEFAULT_BRIDGE_URL;

	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
			bridgeLog('warn', 'Invalid MCP Bridge protocol. Falling back to the default URL', { input: trimmed });
			return DEFAULT_BRIDGE_URL;
		}
		// Remove the trailing slash for a bare root path
		let normalized = parsed.toString();
		if (normalized.endsWith('/') && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
			normalized = normalized.slice(0, -1);
		}
		return normalized;
	}
	catch {
		bridgeLog('warn', 'Invalid MCP Bridge URL format. Falling back to the default URL', { input: trimmed });
		return DEFAULT_BRIDGE_URL;
	}
}

// ============ Timer Helpers ============

/**
 * Clear a timer safely without failing when it does not exist
 */
function clearTimer(timerId: string): void {
	try {
		eda.sys_Timer.clearIntervalTimer(timerId);
	}
	catch {
		// Ignore missing timers
	}
}

/**
 * Set a one-shot timer using setIntervalTimer and clear it after the first trigger
 */
function setOneShotTimer(timerId: string, delayMs: number, callback: () => void): void {
	clearTimer(timerId);
	eda.sys_Timer.setIntervalTimer(timerId, delayMs, () => {
		clearTimer(timerId);
		callback();
	});
}

// ============ WebSocket Send ============

/**
 * Close the WebSocket safely without failing when the connection does not exist
 */
function safeClose(code: number, reason: string): void {
	try {
		(eda as any).sys_WebSocket.close(WS_ID, code, reason);
	}
	catch {
		// Ignore when the connection does not exist
	}
}

/**
 * Send a raw JSON string
 *
 * @returns Whether the message was sent successfully
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
		bridgeLog('warn', 'Send failed. Triggering reconnect', { error: toMsg(error) });
		forceReconnect('send-failed');
		return false;
	}
}

/**
 * Send a structured message and serialize it automatically
 */
function sendMessage(message: Record<string, unknown>): boolean {
	try {
		return sendRaw(JSON.stringify(message));
	}
	catch (error) {
		bridgeLog('error', 'Failed to serialize message', { type: message.type, error: toMsg(error) });
		return false;
	}
}

// ============ Protocol Message Builders ============

/**
 * Send the hello handshake message
 */
function sendHello(): void {
	const state = getBridgeState();

	// Try to read project metadata. This is non-critical, so failures should not block the handshake
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
		// Ignore
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
 * Send the currently cached snapshot
 */
function sendCachedSnapshot(source: 'connect' | 'request_data' | 'push'): void {
	const state = getBridgeState();
	if (!state.pendingSnapshot) {
		if (source === 'request_data') {
			bridgeLog('info', 'Received request_data, but there is no snapshot available to send');
		}
		return;
	}

	if (sendRaw(state.pendingSnapshot.json)) {
		bridgeLog('success', `Schematic snapshot sent (${source})`, {
			version: state.pendingSnapshot.version,
		});
	}
}

// ============ Connection Lifecycle ============

/**
 * Retire the current connection by incrementing the epoch, closing the socket, and clearing timers
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
 * Start the health check timer
 *
 * Every HEALTH_CHECK_INTERVAL_MS, check how long it has been since the last message.
 * If the idle time exceeds HEARTBEAT_TIMEOUT_MS, treat the connection as lost and reconnect.
 */
function startHealthCheck(): void {
	clearTimer(TIMER_HEALTH_CHECK);
	eda.sys_Timer.setIntervalTimer(TIMER_HEALTH_CHECK, HEALTH_CHECK_INTERVAL_MS, () => {
		const state = getBridgeState();
		if (!state.connected)
			return;

		const idleMs = Date.now() - state.lastMessageAt;
		if (idleMs > HEARTBEAT_TIMEOUT_MS) {
			bridgeLog('warn', 'Heartbeat timed out. Triggering reconnect', { idleMs, timeoutMs: HEARTBEAT_TIMEOUT_MS });
			forceReconnect('heartbeat-timeout');
		}
	});
}

/**
 * Schedule an automatic reconnect
 *
 * Exponential backoff: 3s, 6s, 12s, 24s, 30s max
 */
function scheduleReconnect(reason: string): void {
	const state = getBridgeState();

	// Clear connection-related timers
	clearTimer(TIMER_CONNECT_TIMEOUT);
	clearTimer(TIMER_HEALTH_CHECK);
	state.connected = false;
	state.connecting = false;

	// Guard: do not reconnect if not initialized or if closed manually
	if (!state.initialized || state.manualClose)
		return;
	// Guard against re-entry: skip if a reconnect timer is already active
	if (state.reconnectTimerActive)
		return;

	const attempt = ++state.reconnectAttempt;
	state.reconnectTimerActive = true;

	const delayMs = Math.min(
		RECONNECT_BASE_MS * (2 ** (attempt - 1)),
		RECONNECT_MAX_MS,
	);

	bridgeLog('info', `Reconnect scheduled automatically (#${attempt})`, { reason, delayMs, url: state.url });

	setOneShotTimer(TIMER_RECONNECT, delayMs, () => {
		const current = getBridgeState();
		current.reconnectTimerActive = false;
		if (!current.initialized || current.manualClose)
			return;
		connectNow('auto-reconnect');
	});
}

/**
 * Handle the WebSocket connected callback
 */
function handleConnected(epoch: number): void {
	const state = getBridgeState();
	// Epoch check: ignore callbacks from stale connections
	if (epoch !== state.connectEpoch)
		return;

	state.connecting = false;
	state.connected = true;
	state.reconnectAttempt = 0;
	state.lastMessageAt = Date.now();

	// Clear reconnect and connection-timeout timers
	state.reconnectTimerActive = false;
	clearTimer(TIMER_RECONNECT);
	clearTimer(TIMER_CONNECT_TIMEOUT);

	// Start health checks
	startHealthCheck();

	bridgeLog('success', 'MCP Bridge connected', { url: state.url, epoch });

	// Send the hello handshake
	sendHello();

	// Push the cached snapshot immediately if one exists
	sendCachedSnapshot('connect');
}

/**
 * Handle incoming messages from the server
 */
function handleMessage(epoch: number, event: any): void {
	const state = getBridgeState();
	// Epoch check
	if (epoch !== state.connectEpoch)
		return;

	state.lastMessageAt = Date.now();

	// Parse the message body. event can be a MessageEvent or direct data
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
			bridgeLog('warn', 'Received an unparsable message', { rawData });
			return;
		}
	}
	catch {
		bridgeLog('warn', 'Received a non-JSON message', { rawData });
		return;
	}

	if (typeof msg.type !== 'string') {
		bridgeLog('warn', 'Received a message without a type field', { msg });
		return;
	}

	switch (msg.type) {
		case 'ping': {
			// Reply with pong and include the nonce so the server can match it
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
			bridgeLog('info', 'Snapshot acknowledged', { version: msg.version });
			break;
		}
		default: {
			bridgeLog('warn', `Received an unknown message type: ${msg.type}`);
			break;
		}
	}
}

/**
 * Start a WebSocket connection immediately
 */
function connectNow(reason: string): void {
	const state = getBridgeState();
	if (!state.initialized || state.manualClose)
		return;
	if (state.connected || state.connecting)
		return;

	// Clear previous reconnect and timeout timers
	state.reconnectTimerActive = false;
	clearTimer(TIMER_RECONNECT);
	clearTimer(TIMER_CONNECT_TIMEOUT);

	const epoch = ++state.connectEpoch;
	state.connecting = true;
	state.connected = false;

	bridgeLog('info', 'Starting MCP Bridge connection', { reason, url: state.url, epoch });

	try {
		// Close any potentially stale existing connection first
		safeClose(4000, 're-register');

		// Register the WebSocket connection
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

		// Detect permission-related errors, such as missing external-interaction permission.
		// These failures are not recoverable through reconnect attempts.
		const isPermissionError = /\u6743\u9650|permission|\u5916\u90E8\u4EA4\u4E92|not\s*allowed|forbidden|unauthorized/i.test(errorMsg);
		if (isPermissionError) {
			bridgeLog('error', 'MCP Bridge connection was denied, possibly due to missing external-interaction permission. Reconnect has been stopped', { url: state.url, error: errorMsg });
			state.initialized = false;
			state.manualClose = true;
			return;
		}

		bridgeLog('warn', 'Failed to register WebSocket', { url: state.url, error: errorMsg });
		scheduleReconnect('register-failed');
		return;
	}

	// Connection timeout: if still not connected within 8 seconds, trigger reconnect
	setOneShotTimer(TIMER_CONNECT_TIMEOUT, CONNECT_TIMEOUT_MS, () => {
		const current = getBridgeState();
		if (epoch !== current.connectEpoch || current.connected || !current.connecting)
			return;

		current.connecting = false;
		bridgeLog('warn', 'Connection timed out', { url: current.url, epoch, timeoutMs: CONNECT_TIMEOUT_MS });
		scheduleReconnect('connect-timeout');
	});
}

/**
 * Force a disconnect and reconnect. Used for send failures, heartbeat timeouts, and similar scenarios
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

// ============ Public API ============

/**
 * Initialize the MCP Bridge connection
 *
 * This operation is idempotent. Repeated calls only reconnect when the target URL changes.
 * In multi-instance scenarios, all instances share the same globalThis state. The first caller
 * establishes the connection, and later instances reuse it.
 *
 * @param url WebSocket URL. Defaults to ws://127.0.0.1:3100
 */
export function initMcpBridge(url?: string): void {
	const state = getBridgeState();
	const nextUrl = normalizeBridgeUrl(url);
	const urlChanged = state.url !== nextUrl;

	state.url = nextUrl;
	state.initialized = true;
	state.manualClose = false;
	state.reconnectAttempt = 0;

	// Disconnect the old connection if the URL changed
	if (urlChanged && (state.connected || state.connecting)) {
		bridgeLog('info', 'MCP Bridge URL changed. Reconnecting', { newUrl: nextUrl });
		retireConnection(4001, 'url-changed');
	}

	// Cancel any pending reconnect
	if (state.reconnectTimerActive) {
		state.reconnectTimerActive = false;
		clearTimer(TIMER_RECONNECT);
	}

	// If already connected or connecting and the URL did not change, there is nothing to do
	if (state.connected || state.connecting)
		return;

	connectNow(urlChanged ? 'url-changed' : 'init');
}

/**
 * Push a schematic snapshot to the MCP Bridge
 *
 * The snapshot is cached immediately after serialization. If already connected, it is sent right away.
 * If not connected, it will be sent automatically after the next successful connection or after request_data arrives.
 *
 * @param data The complete collected schematic data
 */
export function pushSnapshot(data: CollectedData): void {
	const state = getBridgeState();

	// Skip serialization when uninitialized or manually disconnected to avoid unnecessary work
	if (!state.initialized || state.manualClose)
		return;

	const version = ++state.snapshotVersion;

	// Build the snapshot message
	const message = {
		type: 'snapshot' as const,
		version,
		projectUuid: data.projectInfo?.projectUuid || '',
		timestamp: Date.now(),
		payload: data,
	};

	// Pre-serialize and cache it
	try {
		state.pendingSnapshot = { version, json: JSON.stringify(message) };
	}
	catch (error) {
		bridgeLog('error', 'Failed to serialize snapshot', { version, error: toMsg(error) });
		return;
	}

	// If already connected, push immediately
	if (state.connected) {
		if (sendRaw(state.pendingSnapshot.json)) {
			bridgeLog('success', 'Schematic snapshot pushed', {
				version,
				components: data.components.length,
				pins: data.pins.length,
				nets: data.nets.length,
			});
		}
	}
	else {
		bridgeLog('info', 'Snapshot cached and will be sent after the connection is established', { version });
	}
}

/**
 * Disconnect the MCP Bridge
 *
 * After a manual disconnect, auto-reconnect is disabled until initMcpBridge is called again.
 */
export function disconnectMcpBridge(): void {
	const state = getBridgeState();
	state.initialized = false;
	state.manualClose = true;
	state.reconnectAttempt = 0;

	state.reconnectTimerActive = false;
	clearTimer(TIMER_RECONNECT);
	retireConnection(1000, 'manual-disconnect');

	bridgeLog('info', 'MCP Bridge disconnected manually');
}

/**
 * Check whether the MCP Bridge is connected
 */
export function isMcpBridgeConnected(): boolean {
	return getBridgeState().connected;
}
