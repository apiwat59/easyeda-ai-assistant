import type { SendMessageOptions } from './chat-adapter';
/**
 * AI Schematic Review - conversation-mode orchestrator
 *
 * Manages the full lifecycle of the IFrame panel and AI conversation
 * Isolates chat sessions by sessionId and supports streaming thinking/text updates
 */
import type { AbortRequest, AIBlockResponse, ChatToolCall, CollectedData, MessageBlock, RegenerateRequest, ToolEventMessage, UserMessage } from './types';
import { ChatSession, setDebugLog } from './chat-adapter';
import { clearBackgroundNetlistState, collectSchematicData, getBackgroundNetlistState, parseNetlist, setLogToIFrame } from './collector';
import { loadChatHistory, loadConfig, saveChatHistory, saveConfig, validateConfig } from './config';
import { initMcpBridge, pushSnapshot } from './mcp-bridge';
import { clearSessionCache, ToolOrchestrator } from './tool-orchestrator';
import { CHAT_TOPICS, ChunkType, ErrorCode, ReviewError } from './types';

// Initialize the collector log emitter
setLogToIFrame((level: string, message: string, data?: any) => {
	publishToIFrame('ai-chat/debug-log', { level, message, data });
});

// Initialize the chat-adapter log emitter
setDebugLog((level: string, message: string, data?: any) => {
	publishToIFrame('ai-chat/debug-log', { level, message, data });
});

/**
 * State for in-progress requests (isolated by requestId)
 */
interface PendingRequestState {
	sessionId: string;
	abortController: AbortController;
	thinkingAccumulated: string;
	textAccumulated: string;
}

/**
 * Request processing outcome type
 */
type RequestOutcome = 'success' | 'aborted' | 'failed' | 'rejected';

interface CompletedEntry {
	timestamp: number;
	outcome: RequestOutcome;
}

/**
 * Request deduplication guard (global singleton, cannot be reset externally)
 *
 * Merges the old processingRequests (Set) + completedRequests (Map) into a single
 * tamper-proof deduplication mechanism.
 * This fully fixes the issue where "clearAllChatSessions accidentally cleared
 * completedRequests, allowing old MessageBus callbacks to bypass deduplication".
 *
 * Design principles:
 * - tryAcquire/release is the only operation entry point; external code cannot clear/reset
 * - completed requests are evicted automatically via TTL, with no manual cleanup needed
 * - tryAcquire performs pre-eviction cleanup to avoid stale entries blocking after long idle periods
 */
class RequestGuard {
	private readonly processing = new Set<string>();
	private readonly completed = new Map<string, CompletedEntry>();
	private static readonly CACHE_TTL_MS = 60_000;

	/**
	 * Try to acquire processing ownership for requestId.
	 * Returns true if acquisition succeeds (the caller must call release after processing ends),
	 * and false if the requestId is already in progress or completed (it should be skipped).
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
	 * Release processing ownership for requestId and mark it as completed.
	 * Must be called in the finally block of handleUserMessage.
	 */
	release(requestId: string, outcome: RequestOutcome): void {
		this.processing.delete(requestId);
		this.completed.set(requestId, { timestamp: Date.now(), outcome });
		this.evictExpired();
	}

	/** Number of requests currently being processed (logging only) */
	get processingCount(): number {
		return this.processing.size;
	}

	/** Check whether a requestId is currently being processed (logging only) */
	isProcessing(requestId: string): boolean {
		return this.processing.has(requestId);
	}

	/** Get the completed state for a requestId (logging only) */
	getCompleted(requestId: string): CompletedEntry | undefined {
		return this.completed.get(requestId);
	}

	/** Remove expired completed records */
	private evictExpired(): void {
		const now = Date.now();
		for (const [id, entry] of this.completed) {
			if (now - entry.timestamp > RequestGuard.CACHE_TTL_MS) {
				this.completed.delete(id);
			}
		}
	}
}

/**
 * Orchestrator global shared state (across multiple EDA instances)
 *
 * The EDA platform can load this module multiple times (multiple isolated instances),
 * and module-level variables are not shared across instances.
 * Consolidate key state into a single object on globalThis so every instance operates
 * on the same shared state.
 */
interface OrchestratorState {
	chatSessions: Map<string, ChatSession>;
	toolOrchestratorsBySession: Map<string, ToolOrchestrator>;
	pendingRequests: Map<string, PendingRequestState>;
	requestGuard: RequestGuard;
	lastUserMessageBySession: Map<string, UserMessage>;
	cachedSchematicData: CollectedData | null;
	subscriptions: Array<{ cancel: () => void }>;
	listenerEpoch: number;
	toolListCache: { tools: Array<{ name: string; description: string }>; timestamp: number } | null;
	toolListInflight: Promise<Array<{ name: string; description: string }>> | null;
	startAIChatInFlight: boolean;
}

const TOOL_CACHE_TTL_MS = 10_000; // 10-second cache TTL

/**
 * Background collection single-flight scheduling state (cross-instance global lock)
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
	// eslint-disable-next-line vars-on-top
	var __aiSchReview_orchestratorState: OrchestratorState | undefined;
}

/**
 * Get the orchestrator state shared across instances (same pattern as getGlobalCollectionLock)
 *
 * Creates the singleton on globalThis on first call, and all later module instances
 * share the same state object.
 */
function getOrchestratorState(): OrchestratorState {
	if (!globalThis.__aiSchReview_orchestratorState) {
		globalThis.__aiSchReview_orchestratorState = {
			chatSessions: new Map<string, ChatSession>(),
			toolOrchestratorsBySession: new Map<string, ToolOrchestrator>(),
			pendingRequests: new Map<string, PendingRequestState>(),
			requestGuard: new RequestGuard(),
			lastUserMessageBySession: new Map<string, UserMessage>(),
			cachedSchematicData: null,
			subscriptions: [],
			listenerEpoch: 0,
			toolListCache: null,
			toolListInflight: null,
			startAIChatInFlight: false,
		};
	}
	return globalThis.__aiSchReview_orchestratorState;
}

/** Top-level module reference to the global state object shared by all instances */
const state = getOrchestratorState();

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
 * Check whether collection is currently running (used by external suppression logic)
 */
export function isCollectionInProgress(): boolean {
	const lock = getGlobalCollectionLock();
	return lock.inFlight !== null;
}

/**
 * Start the AI chat panel
 */
export async function startAIChat(): Promise<void> {
	// Reentrancy guard: openIFrame is async, so double-clicking the menu can trigger concurrent calls
	if (state.startAIChatInFlight) {
		publishDebugLog('warn', '[startAIChat] Ignoring duplicate call because the previous one has not finished yet');
		return;
	}
	state.startAIChatInFlight = true;

	try {
		// Read window size from config
		const config = loadConfig();
		const width = config.windowWidth || 960;
		const height = config.windowHeight || 700;

		// Open the IFrame panel (non-blocking, without collecting data immediately)
		try {
			await eda.sys_IFrame.openIFrame('/iframe/chat.html', width, height, 'ai-sch-chat', {
				minimizeButton: true,
			});
		}
		catch {
			throw new ReviewError(ErrorCode.UI_IFRAME_FAILED, 'Failed to open the chat panel');
		}

		// Reset session containers when opening a new panel to avoid leaking state from the previous panel
		clearAllChatSessions();

		// Set up MessageBus listeners
		setupChatListeners();

		// Initialize the local MCP bridge (idempotent; all instances share one global connection state)
		if (config.mcpBridgeUrl) {
			initMcpBridge(config.mcpBridgeUrl);
		}

		// Trigger background collection asynchronously (without blocking the UI)
		void triggerBackgroundCollection('start-ai-chat', true);
	}
	finally {
		state.startAIChatInFlight = false;
	}
}

/**
 * Public API: trigger background collection
 * - reason: trigger reason (for easier log tracing)
 * - notifyIFrame: whether to publish collecting/completed state to the IFrame
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
			publishDebugLog('info', 'Background collection is already running. A rerun has been queued', {
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
 * Background collection executor
 * - single-flight is guaranteed by triggerBackgroundCollection
 * - epoch/version ensures that only the newest result takes effect
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
					components: -1, // -1 means collection is in progress
					pins: -1,
					nets: -1,
				},
				timestamp: Date.now(),
			});
		}

		// Send the collection-start event to the IFrame debug log
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `Background collection started (reason: ${reason}, epoch: ${epoch})`,
		});

		const collected = await collectSchematicData();

		const lock = getGlobalCollectionLock();
		// epoch/version: only accept the latest collection result and discard expired ones
		if (epoch !== lock.epoch) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `Collection result discarded (epoch ${epoch} expired, current epoch ${lock.epoch})`,
			});
			return;
		}

		state.cachedSchematicData = collected;

		// Inject schematic data into all existing sessions
		for (const session of state.chatSessions.values()) {
			session.setSchematicContext(collected);
		}

		// Push the latest snapshot to the local eda-mcp-server (cache only while disconnected; send automatically after reconnect)
		pushSnapshot(collected);

		const elapsed = Date.now() - startTime;

		// Send detailed collection results to the IFrame debug log
		publishToIFrame('ai-chat/debug-log', {
			level: 'success',
			message: `Collection completed (elapsed ${elapsed}ms)`,
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

		// If the netlist timed out but is still being fetched in the background, start delayed backfill
		void scheduleNetlistBackfill(epoch, collected);
	}
	catch (error) {
		const lock = getGlobalCollectionLock();
		// Failures from expired tasks must not overwrite the state of newer tasks
		if (epoch !== lock.epoch) {
			return;
		}

		const elapsed = Date.now() - startTime;
		const errorMsg = error instanceof Error ? error.message : String(error);

		// Send the error log to the IFrame
		publishDebugLog('error', `Collection failed (elapsed ${elapsed}ms): ${errorMsg}`, {
			reason,
			epoch,
		});

		if (notifyIFrame) {
			// Collection failures must not block the UI; conversation can continue
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
 * Delay-backfill netlist data (if the background netlist fetch succeeds)
 *
 * Strategy:
 * 1. Check whether backgroundNetlistState exists and is still unfinished
 * 2. Poll for completion with a timer (every 2 seconds, up to 60 seconds)
 * 3. When completed, parse the netlist again and update pin netName values
 * 4. Update cachedSchematicData and notify the IFrame
 * 5. Use epoch version control to avoid expired tasks overwriting newer tasks
 */
async function scheduleNetlistBackfill(
	epoch: number,
	collected: CollectedData,
): Promise<void> {
	const netlistState = getBackgroundNetlistState();

	// Return immediately if there is no background netlist task or it is already complete
	if (!netlistState || netlistState.completed) {
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `Netlist backfill check: ${!netlistState ? 'no background netlist task' : 'netlist already completed (no backfill needed)'}`,
		});
		return;
	}

	publishToIFrame('ai-chat/debug-log', {
		level: 'info',
		message: 'Background netlist fetch is in progress. Pin bindings will be backfilled automatically when it completes...',
	});

	let pollCount = 0;
	const MAX_POLL_COUNT = 30; // Poll at most 30 times (60 seconds)
	const POLL_INTERVAL_MS = 2000; // Check every 2 seconds
	const TIMER_ID = `netlist-backfill-epoch-${epoch}`;

	eda.sys_Timer.setIntervalTimer(TIMER_ID, POLL_INTERVAL_MS, async () => {
		pollCount++;

		// Check whether the maximum poll count has been exceeded
		if (pollCount > MAX_POLL_COUNT) {
			eda.sys_Timer.clearIntervalTimer(TIMER_ID);
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: 'Background netlist fetch timed out after 60 seconds. Skipping backfill',
			});
			clearBackgroundNetlistState();
			return;
		}

		// Check whether the epoch has expired
		const lock = getGlobalCollectionLock();
		if (epoch !== lock.epoch) {
			eda.sys_Timer.clearIntervalTimer(TIMER_ID);
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `Netlist backfill task was canceled because epoch ${epoch} expired`,
			});
			return;
		}

		// Check whether the netlist is complete
		const currentState = getBackgroundNetlistState();
		if (!currentState || !currentState.completed) {
			return; // Keep waiting
		}

		// The netlist is complete, so stop polling
		eda.sys_Timer.clearIntervalTimer(TIMER_ID);

		// Return immediately if netlist fetch failed
		if (!currentState.result) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `Background netlist fetch failed (elapsed ${currentState.duration}ms). Backfill cannot continue`,
			});
			clearBackgroundNetlistState();
			return;
		}

		// Netlist fetch succeeded, so start backfilling
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `Background netlist fetch succeeded (elapsed ${currentState.duration}ms). Starting pin-binding backfill...`,
		});

		try {
			// Parse the netlist
			const netlistMap = parseNetlist(currentState.result);

			if (netlistMap.size === 0) {
				publishToIFrame('ai-chat/debug-log', {
					level: 'warn',
					message: 'The parsed netlist result is empty, so backfill cannot be performed',
				});
				clearBackgroundNetlistState();
				return;
			}

			// Track backfill results
			let reboundCount = 0;
			let improvedCount = 0;

			// Update pin netName values (using the L1 strategy)
			for (const pin of collected.pins) {
				const pinKey = `${pin.componentDesignator}_${pin.pinNumber}`;
				const netNameFromNetlist = netlistMap.get(pinKey);

				if (netNameFromNetlist) {
					// Count pins that were previously unbound and are now bound
					if (!pin.netName) {
						reboundCount++;
					}
					// Count pins that were previously bound with lower confidence (L2/L3/L4) and are now replaced by L1
					else if (pin.netBindingConfidence && pin.netBindingConfidence < 1.0) {
						improvedCount++;
					}

					// Update the pin's net binding
					pin.netName = netNameFromNetlist;
					pin.netBindingConfidence = 1.0;
					pin.netBindingReason = 'netlist-backfill';
				}
			}

			// Rebuild net statistics
			const netMap = new Map<string, Set<string>>();
			for (const pin of collected.pins) {
				if (pin.netName) {
					if (!netMap.has(pin.netName)) {
						netMap.set(pin.netName, new Set());
					}
					netMap.get(pin.netName)!.add(pin.primitiveId);
				}
			}

			// Update net data
			collected.nets = Array.from(netMap.entries()).map(([netName, pinIds]) => ({
				netName,
				pinCount: pinIds.size,
				pins: Array.from(pinIds),
			}));

			// Update cached data if the epoch is still valid
			const lock = getGlobalCollectionLock();
			if (epoch === lock.epoch) {
				state.cachedSchematicData = collected;

				// Inject the updated data into all existing sessions
				for (const session of state.chatSessions.values()) {
					session.setSchematicContext(collected);
				}

				// Re-push the snapshot after netlist backfill so the eda-mcp-server receives the latest binding results
				pushSnapshot(collected);

				// Notify the IFrame that data has been updated
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
					message: `Netlist backfill completed: newly bound ${reboundCount} pins, improved ${improvedCount} pin bindings`,
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
					message: `Netlist backfill discarded (epoch ${epoch} expired)`,
				});
			}
		}
		catch (error) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'error',
				message: `Netlist backfill failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		finally {
			clearBackgroundNetlistState();
		}
	}, POLL_INTERVAL_MS);
}

/**
 * Set up MessageBus listeners
 */
function setupChatListeners(): void {
	// Idempotency guard: if subscriptions already exist, startAIChat was called again
	// (for example, the user clicked the menu multiple times). Re-register after cleanup,
	// but note that EDA MessageBus cancel may not fully take effect.
	const prevCount = state.subscriptions.length;
	cleanupSubscriptions();

	// Increment the version so old callbacks become invalid automatically when they run
	const currentEpoch = ++state.listenerEpoch;
	publishDebugLog('info', '[setupChatListeners] Initializing subscriptions', {
		previousSubscriptionCount: prevCount,
		listenerEpoch: currentEpoch,
		note: prevCount > 0 ? 'stale subscriptions detected; attempted cleanup and incremented epoch' : 'first registration',
	});

	// Listen for IFrame requests for schematic data
	subscribe(CHAT_TOPICS.REQUEST_DATA, () => {
		if (state.cachedSchematicData) {
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: state.cachedSchematicData.components.length,
					pins: state.cachedSchematicData.pins.length,
					nets: state.cachedSchematicData.nets.length,
				},
				drcPassed: state.cachedSchematicData.drcResult?.passed,
				projectName: state.cachedSchematicData.projectInfo?.projectName,
				timestamp: state.cachedSchematicData.timestamp,
			});
		}
		else {
			// If data has not been collected yet or collection failed, return the collecting state
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

	// Listen for IFrame requests to refresh schematic data
	subscribe(CHAT_TOPICS.REFRESH_DATA, () => {
		publishDebugLog('info', '[manual refresh] User triggered a schematic-data refresh');
		void triggerBackgroundCollection('manual-refresh', true);
	});

	// Listen for IFrame requests for config data
	subscribe(CHAT_TOPICS.REQUEST_CONFIG, () => {
		const config = loadConfig();
		const customPrompt = typeof config.customSystemPrompt === 'string' ? config.customSystemPrompt.trim() : '';
		if (customPrompt) {
			publishDebugLog('info', '[REQUEST_CONFIG] Loading custom system prompt', {
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
			mcpBridgeUrl: config.mcpBridgeUrl || 'ws://127.0.0.1:3100',
			customSystemPrompt: config.customSystemPrompt || '',
			schematicFields: config.schematicFields || {},
		});
	});

	// Listen for IFrame requests for history
	subscribe(CHAT_TOPICS.REQUEST_HISTORY, () => {
		const history = loadChatHistory();
		publishToIFrame(CHAT_TOPICS.HISTORY_DATA, { messages: history });
	});

	// Listen for IFrame requests for the tool list
	subscribe(CHAT_TOPICS.REQUEST_TOOLS, async (data: any) => {
		const config = loadConfig();
		const incomingRequestId = typeof data?.requestId === 'string' ? data.requestId : '(none)';

		// Quick check for whether MCP is enabled
		if (!config.mcpEnabled || !config.mcpGatewayUrl) {
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, { enabled: false, tools: [] });
			return;
		}

		// 1. Return immediately on cache hit
		if (state.toolListCache && (Date.now() - state.toolListCache.timestamp < TOOL_CACHE_TTL_MS)) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'info',
				message: `[REQUEST_TOOLS] Cache hit, returning ${state.toolListCache.tools.length} tools directly (requestId=${incomingRequestId})`,
			});
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, {
				enabled: true,
				tools: state.toolListCache.tools,
			});
			return;
		}

		// 2. Coalesce concurrent requests: reuse the existing in-flight request if present
		if (state.toolListInflight) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'info',
				message: `[REQUEST_TOOLS] Joined existing inflight request (requestId=${incomingRequestId})`,
			});
			try {
				const tools = await state.toolListInflight;
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

		// 3. Start a new request
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `[REQUEST_TOOLS] Starting a new tool-list request (requestId=${incomingRequestId})`,
		});
		const requestId = typeof data?.requestId === 'string'
			? data.requestId
			: `tool-preview-${Date.now()}`;
		const sessionId = typeof data?.sessionId === 'string'
			? data.sessionId
			: 'tool-preview';
		const debugEmitter = (event: ToolEventMessage): void => {
			// Preview mode does not emit tool UI events, but forwards session logs to the debug panel
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

		state.toolListInflight = toolOrchestrator.listTools()
			.then((tools) => {
				const mapped = tools.map(tool => ({
					name: tool.function.name,
					description: tool.function.description || '',
				}));
				// Update the cache
				state.toolListCache = { tools: mapped, timestamp: Date.now() };
				publishToIFrame('ai-chat/debug-log', {
					level: 'success',
					message: `[REQUEST_TOOLS] Tool list fetched successfully and cached with ${mapped.length} tools`,
				});
				return mapped;
			})
			.finally(() => { state.toolListInflight = null; });

		try {
			const tools = await state.toolListInflight;
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, { enabled: true, tools: tools ?? [] });
		}
		catch (error) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'error',
				message: `[REQUEST_TOOLS] Tool list fetch failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, {
				enabled: true,
				tools: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// Listen for user messages
	subscribe(CHAT_TOPICS.USER_MESSAGE, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		// Epoch validation: drop callbacks from older subscriptions
		// (EDA MessageBus cancel may not fully take effect)
		if (currentEpoch !== state.listenerEpoch) {
			publishDebugLog('warn', '[USER_MESSAGE] Dropping stale subscription callback', {
				callbackEpoch: currentEpoch,
				currentEpoch: state.listenerEpoch,
				requestId: (data as any)?.requestId,
			});
			return;
		}
		await handleUserMessage(data as UserMessage);
	});

	// Listen for stop-generation requests
	subscribe(CHAT_TOPICS.ABORT_REQUEST, (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		if (currentEpoch !== state.listenerEpoch) {
			publishDebugLog('warn', '[ABORT_REQUEST] Dropping stale subscription callback', {
				callbackEpoch: currentEpoch,
				currentEpoch: state.listenerEpoch,
			});
			return;
		}
		handleAbortRequest(data as AbortRequest);
	});

	// Listen for regenerate requests
	subscribe(CHAT_TOPICS.REGENERATE_REQUEST, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		if (currentEpoch !== state.listenerEpoch) {
			publishDebugLog('warn', '[REGENERATE_REQUEST] Dropping stale subscription callback', {
				callbackEpoch: currentEpoch,
				currentEpoch: state.listenerEpoch,
			});
			return;
		}
		await handleRegenerateRequest(data as RegenerateRequest);
	});

	// Listen for locate requests
	subscribe(CHAT_TOPICS.LOCATE, async (data: any) => {
		if (currentEpoch !== state.listenerEpoch) {
			publishDebugLog('warn', '[LOCATE] Dropping stale subscription callback', {
				callbackEpoch: currentEpoch,
				currentEpoch: state.listenerEpoch,
			});
			return;
		}
		if (!data?.reference)
			return;
		await handleLocateRequest(data.reference);
	});

	// Listen for config updates
	subscribe(CHAT_TOPICS.CONFIG_UPDATE, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;

		// Validate field types and lengths
		if (data.apiUrl && (typeof data.apiUrl !== 'string' || data.apiUrl.length > 500)) {
			publishDebugLog('warn', 'Config validation failed: invalid apiUrl');
			return;
		}
		if (data.apiKey && (typeof data.apiKey !== 'string' || data.apiKey.length > 500)) {
			publishDebugLog('warn', 'Config validation failed: invalid apiKey');
			return;
		}
		if (data.model && (typeof data.model !== 'string' || data.model.length > 100)) {
			publishDebugLog('warn', 'Config validation failed: invalid model');
			return;
		}
		if (data.mcpEnabled !== undefined && typeof data.mcpEnabled !== 'boolean') {
			publishDebugLog('warn', 'Config validation failed: invalid mcpEnabled');
			return;
		}
		if (data.mcpAutoApprove !== undefined && typeof data.mcpAutoApprove !== 'boolean') {
			publishDebugLog('warn', 'Config validation failed: invalid mcpAutoApprove');
			return;
		}
		if (data.mcpGatewayUrl && (typeof data.mcpGatewayUrl !== 'string' || data.mcpGatewayUrl.length > 500)) {
			publishDebugLog('warn', 'Config validation failed: invalid mcpGatewayUrl');
			return;
		}
		if (data.mcpGatewayApiKey && (typeof data.mcpGatewayApiKey !== 'string' || data.mcpGatewayApiKey.length > 500)) {
			publishDebugLog('warn', 'Config validation failed: invalid mcpGatewayApiKey');
			return;
		}
		if (data.mcpBridgeUrl !== undefined && (typeof data.mcpBridgeUrl !== 'string' || data.mcpBridgeUrl.length > 500)) {
			publishDebugLog('warn', 'Config validation failed: invalid mcpBridgeUrl');
			return;
		}
		if (data.customSystemPrompt !== undefined) {
			if (typeof data.customSystemPrompt !== 'string') {
				publishDebugLog('warn', 'Config validation failed: customSystemPrompt has the wrong type');
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: 'Failed to save config: invalid custom system prompt format',
					code: 'CONFIG_VALIDATION_FAILED',
				});
				return;
			}
			if (data.customSystemPrompt.length > 5000) {
				publishDebugLog('warn', 'Config validation failed: customSystemPrompt is too long', {
					length: data.customSystemPrompt.length,
				});
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: 'Failed to save config: the custom system prompt must be at most 5000 characters',
					code: 'CONFIG_VALIDATION_FAILED',
				});
				return;
			}
		}

		// Validate schematicFields (if present, it must be a plain object of boolean key/value pairs)
		if (data.schematicFields !== undefined) {
			if (typeof data.schematicFields !== 'object' || data.schematicFields === null || Array.isArray(data.schematicFields)) {
				publishDebugLog('warn', 'Config validation failed: schematicFields has the wrong type');
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: 'Failed to save config: schematicFields has an invalid format',
					code: 'CONFIG_VALIDATION_FAILED',
				});
				return;
			}
			// Validate that all values are booleans (empty object allowed)
			for (const [k, v] of Object.entries(data.schematicFields)) {
				if (typeof v !== 'boolean') {
					publishDebugLog('warn', `Config validation failed: schematicFields.${k} is not a boolean`);
					publishToIFrame(CHAT_TOPICS.ERROR, {
						message: `Failed to save config: schematicFields.${k} has an invalid value`,
						code: 'CONFIG_VALIDATION_FAILED',
					});
					return;
				}
			}
		}

		// Validate URL formats
		if (data.apiUrl) {
			try {
				const url = new URL(data.apiUrl);
				if (url.protocol !== 'http:' && url.protocol !== 'https:') {
					publishDebugLog('warn', 'Config validation failed: apiUrl must use HTTP or HTTPS');
					return;
				}
			}
			catch {
				publishDebugLog('warn', 'Config validation failed: apiUrl has an invalid format');
				return;
			}
		}
		if (typeof data.mcpGatewayUrl === 'string' && data.mcpGatewayUrl.trim().length > 0) {
			try {
				const gatewayUrl = new URL(data.mcpGatewayUrl);
				if (gatewayUrl.protocol !== 'http:' && gatewayUrl.protocol !== 'https:') {
					publishDebugLog('warn', 'Config validation failed: mcpGatewayUrl must use HTTP or HTTPS');
					return;
				}
			}
			catch {
				publishDebugLog('warn', 'Config validation failed: mcpGatewayUrl has an invalid format');
				return;
			}
		}
		if (typeof data.mcpBridgeUrl === 'string' && data.mcpBridgeUrl.trim().length > 0) {
			try {
				const bridgeUrl = new URL(data.mcpBridgeUrl);
				if (bridgeUrl.protocol !== 'ws:' && bridgeUrl.protocol !== 'wss:') {
					publishDebugLog('warn', 'Config validation failed: mcpBridgeUrl must use WS or WSS');
					return;
				}
			}
			catch {
				publishDebugLog('warn', 'Config validation failed: mcpBridgeUrl has an invalid format');
				return;
			}
		}

		// Clear the tool cache when config changes so the next request refetches it
		state.toolListCache = null;
		clearSessionCache(); // Clear the MCP session cache

		// Log changes to the custom system prompt
		if (data.customSystemPrompt !== undefined) {
			const trimmed = typeof data.customSystemPrompt === 'string' ? data.customSystemPrompt.trim() : '';
			publishDebugLog('info', `[CONFIG_UPDATE] Custom system prompt ${trimmed ? 'set' : 'cleared'}`, {
				length: trimmed.length,
			});
		}

		const result = await saveConfig(data);

		if (!result.success) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `Failed to save config: ${result.error || 'unknown error'}`,
				code: 'CONFIG_SAVE_FAILED',
			});
			return;
		}

		// Return the config after saving successfully
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
			mcpBridgeUrl: result.config.mcpBridgeUrl || 'ws://127.0.0.1:3100',
			customSystemPrompt: result.config.customSystemPrompt || '',
			schematicFields: result.config.schematicFields || {},
		});

		// Apply MCP bridge address changes immediately (idempotent; no side effects if unchanged)
		if (data.mcpBridgeUrl !== undefined) {
			initMcpBridge(result.config.mcpBridgeUrl);
		}

		// Refresh all existing sessions if field settings changed
		if (data.schematicFields !== undefined) {
			const newFields = result.config.schematicFields;
			publishDebugLog('info', '[CONFIG_UPDATE] schematicFields changed. Refreshing field settings for all sessions', {
				sessionCount: state.chatSessions.size,
				hasData: !!state.cachedSchematicData,
			});
			for (const session of state.chatSessions.values()) {
				// Always update field settings first, regardless of whether cached data exists
				if (newFields) {
					session.updateSchematicFields(newFields);
				}
				// Re-serialize context only when cached data exists
				if (state.cachedSchematicData) {
					session.updateSchematicContext(state.cachedSchematicData);
				}
			}
		}
	});

	// Listen for history updates
	subscribe(CHAT_TOPICS.HISTORY_UPDATE, async (data: any) => {
		if (!data || !Array.isArray(data.messages))
			return;

		// Validate array size
		if (data.messages.length > 100) {
			publishDebugLog('warn', 'History validation failed: too many sessions');
			return;
		}

		// Validate the structure of each session
		for (const session of data.messages) {
			if (!session || typeof session !== 'object') {
				publishDebugLog('warn', 'History validation failed: invalid session structure');
				return;
			}
			if (!session.id || typeof session.id !== 'string' || session.id.length > 100) {
				publishDebugLog('warn', 'History validation failed: invalid session ID');
				return;
			}
			if (!Array.isArray(session.messages) || session.messages.length > 1000) {
				publishDebugLog('warn', 'History validation failed: invalid session message list');
				return;
			}
			// Validate message structure
			for (const msg of session.messages) {
				if (!msg || typeof msg !== 'object') {
					publishDebugLog('warn', 'History validation failed: invalid message structure');
					return;
				}
				if (!msg.role || (msg.role !== 'user' && msg.role !== 'ai')) {
					publishDebugLog('warn', 'History validation failed: invalid message role');
					return;
				}
				if (typeof msg.content !== 'string' || msg.content.length > 100000) {
					publishDebugLog('warn', 'History validation failed: invalid message content');
					return;
				}
			}
		}

		const result = await saveChatHistory(data.messages);

		if (!result.success) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `Failed to save history: ${result.error || 'unknown error'}`,
				code: 'HISTORY_SAVE_FAILED',
			});
		}
	});

	// Listen for clear-session requests (supports clearing by sessionId or clearing all)
	subscribe(CHAT_TOPICS.CLEAR_SESSION, (data: any) => {
		if (currentEpoch !== state.listenerEpoch) {
			publishDebugLog('warn', '[CLEAR_SESSION] Dropping stale subscription callback', {
				callbackEpoch: currentEpoch,
				currentEpoch: state.listenerEpoch,
			});
			return;
		}
		const sessionId = typeof data?.sessionId === 'string'
			? data.sessionId
			: '';

		if (sessionId) {
			abortPendingRequestsBySession(sessionId);
			state.lastUserMessageBySession.delete(sessionId);

			const session = state.chatSessions.get(sessionId);
			if (session) {
				session.reset();
				state.chatSessions.delete(sessionId);
			}

			// Clean up the ToolOrchestrator for this session
			state.toolOrchestratorsBySession.delete(sessionId);
			return;
		}

		// Clear all sessions when no sessionId is provided
		clearAllChatSessions();
	});

	// Listen for restore-session requests (restore context from history)
	subscribe('ai-chat/restore-session', (data: any) => {
		if (currentEpoch !== state.listenerEpoch) {
			publishDebugLog('warn', '[RESTORE_SESSION] Dropping stale subscription callback', {
				callbackEpoch: currentEpoch,
				currentEpoch: state.listenerEpoch,
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

		// Get or create the session
		const session = getOrCreateChatSession(sessionId);

		// Rebuild history
		session.reset(); // Clear first
		for (const msg of messages) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}

			const role = msg.role === 'user' ? 'user' : 'assistant';
			const content = typeof msg.content === 'string' ? msg.content : '';

			// If this is an assistant message with thinkingSummary, merge it into content
			let finalContent = content;
			if (role === 'assistant' && msg.thinkingSummary) {
				finalContent = `${msg.thinkingSummary}\n\n${content}`;
			}

			// Modify history directly (bypassing sendMessage validation)
			(session as any).history.push({
				role,
				content: finalContent,
			});
		}

		publishDebugLog('info', '[restoreSession] Session restore completed', {
			sessionId,
			messageCount: messages.length,
		});
	});
}

/**
 * Handle a user message
 */
async function handleUserMessage(msg: UserMessage): Promise<void> {
	// Validate message structure
	if (!msg || typeof msg !== 'object') {
		return;
	}

	// Validate required fields
	if (!msg.requestId || !msg.sessionId) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: 'Invalid message format: requestId or sessionId is missing',
		});
		return;
	}

	publishDebugLog('info', '[handleUserMessage] Request received', {
		requestId: msg.requestId,
		sessionId: msg.sessionId,
		hasText: !!msg.text,
		imageCount: msg.images?.length || 0,
		guardProcessingCount: state.requestGuard.processingCount,
	});

	// Unified deduplication: tryAcquire combines the processing + completed checks
	// and cannot be cleared externally
	if (!state.requestGuard.tryAcquire(msg.requestId)) {
		const completed = state.requestGuard.getCompleted(msg.requestId);
		if (completed) {
			publishDebugLog('info', '[handleUserMessage] Ignoring request that already completed', {
				requestId: msg.requestId,
				elapsed: Date.now() - completed.timestamp,
				outcome: completed.outcome,
			});
		}
		else {
			publishDebugLog('warn', '[handleUserMessage] Ignoring duplicate request that is already in progress', {
				requestId: msg.requestId,
				guardProcessingCount: state.requestGuard.processingCount,
			});
		}
		return;
	}

	const requestStartTime = Date.now();
	let requestOutcome: RequestOutcome = 'failed';

	try {
		// Validate text length
		if (msg.text && msg.text.length > 50000) {
			requestOutcome = 'rejected';
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: 'The message is too long (maximum 50000 characters)',
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			return;
		}

		// Validate image count and size
		if (msg.images) {
			if (msg.images.length > 10) {
				requestOutcome = 'rejected';
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: 'Too many images (maximum 10)',
					requestId: msg.requestId,
					sessionId: msg.sessionId,
				});
				return;
			}

			for (const img of msg.images) {
				if (img.data && img.data.length > 10 * 1024 * 1024) {
					requestOutcome = 'rejected';
					publishToIFrame(CHAT_TOPICS.ERROR, {
						message: 'An image is too large (maximum 10 MB per image)',
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
				message: `Please configure AI first: ${configError}`,
				code: ErrorCode.AI_NO_CONFIG,
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			return;
		}

		// Create a new AbortController
		const abortController = new AbortController();
		state.pendingRequests.set(msg.requestId, {
			sessionId: msg.sessionId,
			abortController,
			thinkingAccumulated: '',
			textAccumulated: '',
		});

		// Get or create the session by sessionId (core isolation mechanism)
		const session = getOrCreateChatSession(msg.sessionId);

		// Get or create the tool orchestrator (reused per session to avoid repeated initialization)
		let toolOrchestrator = state.toolOrchestratorsBySession.get(msg.sessionId);
		if (!toolOrchestrator) {
			toolOrchestrator = new ToolOrchestrator(
				config,
				{ requestId: msg.requestId, sessionId: msg.sessionId },
				publishToolEvent,
			);
			state.toolOrchestratorsBySession.set(msg.sessionId, toolOrchestrator);
			publishDebugLog('info', '[handleUserMessage] Created a new ToolOrchestrator', {
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
		}
		else {
			// requestId must be updated when reusing it, otherwise tool events will carry
			// the old request ID, causing the frontend to miss the current message and
			// create extra tool-call prompt boxes
			publishDebugLog('info', '[handleUserMessage] Reusing the existing ToolOrchestrator and updating requestId', {
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			toolOrchestrator.updateRequestContext(msg.requestId);
		}

		// Fetch the tool list if MCP is enabled
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
					title: 'Failed to load tool list. Continuing with plain-text conversation',
					error: toolListError instanceof Error ? toolListError.message : String(toolListError),
					timestamp: Date.now(),
				});
			}
		}

		// Build sendMessage options
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

				// Record accumulated content
				const pending = state.pendingRequests.get(msg.requestId);
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
			publishDebugLog('info', '[handleUserMessage] Request aborted', {
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			return;
		}

		requestOutcome = 'success';
		// Save the last user message (used for regeneration)
		state.lastUserMessageBySession.set(msg.sessionId, cloneUserMessage(msg));

		publishToIFrame(CHAT_TOPICS.AI_RESPONSE, {
			content: reply,
			timestamp: Date.now(),
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});

		publishDebugLog('success', '[handleUserMessage] Response sent successfully', {
			requestId: msg.requestId,
			sessionId: msg.sessionId,
			replyLength: reply.length,
			elapsed: Date.now() - requestStartTime,
		});
	}
	catch (error) {
		publishDebugLog('error', '[handleUserMessage] Processing failed', {
			requestId: msg.requestId,
			sessionId: msg.sessionId,
			error: error instanceof Error ? error.message : String(error),
		});

		// Silence abort errors
		if (isAbortError(error)) {
			requestOutcome = 'aborted';
			publishDebugLog('info', '[handleUserMessage] Abort error handled silently', {
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
		// Clean up in-progress request state
		state.pendingRequests.delete(msg.requestId);
		// Release RequestGuard ownership and mark as completed (expired entries are cleaned up automatically)
		state.requestGuard.release(msg.requestId, requestOutcome);
	}
}

/**
 * Handle a locate request
 */
async function handleLocateRequest(reference: string): Promise<void> {
	try {
		// Determine whether this is a component designator or a net name
		const isComponent = /^[URCLDQJK]\d+$/i.test(reference);
		const type = isComponent ? 'component' : 'net';

		publishDebugLog('info', `[locate] Attempting to locate ${type}`, {
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
			publishDebugLog('success', `[locate] ${type} located successfully`, {
				reference,
				type: isComponent ? 'component' : 'net',
			});
		}
		else {
			publishDebugLog('warn', `[locate] Failed to locate ${type}: API returned false (it may not exist or may not be on the current page)`, {
				reference,
				type: isComponent ? 'component' : 'net',
			});
		}
	}
	catch (error) {
		publishDebugLog('error', '[locate] Locate operation failed', {
			reference,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// ============ Session management (isolated by sessionId) ============

/**
 * Get or create the chat session for the specified sessionId
 */
function getOrCreateChatSession(sessionId: string): ChatSession {
	const existing = state.chatSessions.get(sessionId);
	if (existing)
		return existing;

	const config = loadConfig();
	const session = new ChatSession(undefined, config.schematicFields);
	if (state.cachedSchematicData) {
		session.setSchematicContext(state.cachedSchematicData);
	}

	state.chatSessions.set(sessionId, session);
	return session;
}

/**
 * Clear all chat sessions
 */
function clearAllChatSessions(): void {
	abortAllPendingRequests();

	// RequestGuard is a global deduplication guard that cannot be reset, so its
	// state is intentionally preserved here. Even if MessageBus redelivers an old
	// message after cleanup, requestGuard can still block it.

	for (const session of state.chatSessions.values()) {
		session.reset();
	}
	state.chatSessions.clear();
	state.lastUserMessageBySession.clear();
	state.toolListCache = null; // Clear the tool cache
	clearSessionCache(); // Clear the MCP session cache
	state.toolOrchestratorsBySession.clear(); // Clear the ToolOrchestrator cache

	publishDebugLog('info', '[clearAllChatSessions] Cleared all session state (RequestGuard preserved)');
}

// ============ Abort management ============

/**
 * Handle a stop-generation request
 */
function handleAbortRequest(data: AbortRequest): void {
	const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
	const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';

	if (!requestId || !sessionId) {
		publishDebugLog('warn', '[abort] Invalid request format', { requestId, sessionId });
		return;
	}

	const pending = state.pendingRequests.get(requestId);
	if (!pending) {
		publishDebugLog('info', '[abort] No in-progress request was found', { requestId, sessionId });
		return;
	}
	if (pending.sessionId !== sessionId) {
		publishDebugLog('warn', '[abort] sessionId mismatch, ignoring request', {
			requestId,
			expectedSessionId: pending.sessionId,
			actualSessionId: sessionId,
		});
		return;
	}

	pending.abortController.abort();
	publishDebugLog('info', '[abort] Request aborted', { requestId, sessionId });
	publishPausedCompleteBlocks(requestId, sessionId, pending);
	state.pendingRequests.delete(requestId);
}

/**
 * Handle a regenerate request
 */
async function handleRegenerateRequest(data: RegenerateRequest): Promise<void> {
	const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
	const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';

	if (!requestId || !sessionId) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: 'Invalid regenerate-request format',
			code: 'REGENERATE_REQUEST_INVALID',
		});
		return;
	}

	// Abort first if the current session still has an in-progress request
	abortPendingRequestsBySession(sessionId);

	const session = state.chatSessions.get(sessionId);
	if (!session) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: 'No session was found for regeneration',
			code: 'REGENERATE_SESSION_NOT_FOUND',
			requestId,
			sessionId,
		});
		return;
	}

	const lastUserMessage = state.lastUserMessageBySession.get(sessionId);
	if (!lastUserMessage) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: 'The current session has no user message that can be regenerated',
			code: 'REGENERATE_NO_MESSAGE',
			requestId,
			sessionId,
		});
		return;
	}

	// Roll back the latest conversation turn, then send again
	session.clear();

	const regenerateMessage: UserMessage = {
		...cloneUserMessage(lastUserMessage),
		requestId,
		sessionId,
	};
	await handleUserMessage(regenerateMessage);
}

/**
 * Abort all in-progress requests
 */
function abortAllPendingRequests(): void {
	for (const pending of state.pendingRequests.values()) {
		pending.abortController.abort();
	}
	state.pendingRequests.clear();
}

/**
 * Abort all in-progress requests for the specified session
 */
function abortPendingRequestsBySession(sessionId: string): void {
	for (const [requestId, pending] of state.pendingRequests.entries()) {
		if (pending.sessionId !== sessionId)
			continue;

		pending.abortController.abort();
		state.pendingRequests.delete(requestId);
	}
}

/**
 * Send COMPLETE events with paused status (used on abort)
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
 * Check whether this is an abort error
 */
function isAbortError(error: unknown): boolean {
	return error instanceof ReviewError && error.code === ErrorCode.AI_ABORTED;
}

/**
 * Build the payload for an error message
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
			message: `AI request failed: ${error.message}`,
			details: { name: error.name, message: error.message },
		};
	}

	return {
		message: `AI request failed: ${String(error)}`,
	};
}

/**
 * Deep-copy a user message (used for regeneration)
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

// ============ Streaming block publishing ============

/**
 * Publish a MessageBlock to the IFrame
 * thinking blocks use the AI_THINKING topic, text blocks use the AI_TEXT topic
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
 * Publish tool execution events to the IFrame
 */
function publishToolEvent(event: ToolEventMessage): void {
	publishToIFrame(CHAT_TOPICS.TOOL_EVENT, event);
}

/**
 * Check whether a block is a thinking block
 */
function isThinkingBlock(type: ChunkType): boolean {
	return type === ChunkType.THINKING_START
		|| type === ChunkType.THINKING_DELTA
		|| type === ChunkType.THINKING_COMPLETE;
}

// ============ MessageBus communication ============

/**
 * Unified debug-log publisher (sends logs to the IFrame debug panel)
 */
function publishDebugLog(level: string, message: string, data?: unknown): void {
	publishToIFrame('ai-chat/debug-log', { level, message, data });
}

/**
 * Publish a message to the IFrame
 */
function publishToIFrame(topic: string, data: unknown): void {
	try {
		eda.sys_MessageBus.publishPublic(topic, data);
	}
	catch (error) {
		console.warn('Failed to publish message:', topic, error instanceof Error ? error.message : 'unknown error');
	}
}

/**
 * Subscribe to the MessageBus
 */
function subscribe(topic: string, handler: (data: any) => void | Promise<void>): void {
	const task = eda.sys_MessageBus.subscribePublic(topic, handler);
	state.subscriptions.push(task);
}

/**
 * Clean up all subscriptions
 */
function cleanupSubscriptions(): void {
	for (const sub of state.subscriptions) {
		try {
			sub.cancel();
		}
		catch {
			// ignore cleanup errors
		}
	}
	state.subscriptions.length = 0;
}
