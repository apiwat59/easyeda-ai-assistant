/**
 * AI schematic review - MCP tool orchestrator
 *
 * Responsibilities:
 * 1. Fetch the available tool list (Gateway -> /tools/list or JSON-RPC tools/list)
 * 2. Execute tool calls (Gateway -> /tools/call or JSON-RPC tools/call)
 * 3. Emit observable tool events to the IFrame
 *
 * Supports two Gateway modes:
 * - REST Gateway: custom REST API (/tools/list, /tools/call)
 * - MCP Streamable HTTP: JSON-RPC 2.0 protocol (single endpoint, such as /mcp)
 */
import type {
	ChatToolCall,
	ChatToolDefinition,
	ConfigStore,
	ToolEventMessage,
	ToolExecutionResultMessage,
} from './types';

interface ToolOrchestratorContext {
	requestId: string;
	sessionId: string;
}

interface ToolListResponseShape {
	tools?: unknown;
	result?: {
		tools?: unknown;
	};
	// JSON-RPC format
	jsonrpc?: string;
	id?: number | string;
}

interface ToolCallResponseShape {
	content?: unknown;
	result?: unknown;
	output?: unknown;
	isError?: boolean;
	error?: unknown;
	// JSON-RPC format
	jsonrpc?: string;
	id?: number | string;
}

/**
 * Gateway type
 */
enum GatewayType {
	REST = 'rest', // custom REST API
	JSON_RPC = 'json-rpc', // MCP Streamable HTTP (JSON-RPC 2.0)
}

/**
 * JSON-RPC request
 */
interface JsonRpcRequest {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
	id: number;
}

/**
 * JSON-RPC response (reserved type definition, not used directly yet)
 */
interface _JsonRpcResponse {
	jsonrpc: '2.0';
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
	id: number | string;
}

/**
 * Module-level MCP session cache (avoids re-running initialize every time ToolOrchestrator is created)
 *
 * Strategy:
 * - Cache session ID or a stateless marker by gatewayBaseUrl
 * - 30-minute TTL with automatic expiration cleanup
 * - Clear the cache when configuration changes
 */
interface SessionCacheEntry {
	mode: 'session' | 'stateless';
	sessionId?: string; // present when mode=session
	timestamp: number;
}

const sessionCache = new Map<string, SessionCacheEntry>();
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Initialize result type
 */
interface InitializeResult {
	mode: 'session' | 'stateless';
	sessionId?: string; // present when mode=session
}

/**
 * Get the cached session ID or stateless marker (if not expired)
 */
function getCachedSessionId(gatewayBaseUrl: string): InitializeResult | null {
	const entry = sessionCache.get(gatewayBaseUrl);
	if (!entry) {
		return null;
	}

	// Check expiration
	if (Date.now() - entry.timestamp > SESSION_CACHE_TTL_MS) {
		sessionCache.delete(gatewayBaseUrl);
		return null;
	}

	if (entry.mode === 'session' && entry.sessionId) {
		return { mode: 'session', sessionId: entry.sessionId };
	}
	else if (entry.mode === 'stateless') {
		return { mode: 'stateless' };
	}

	return null;
}

/**
 * Save the session ID or stateless marker to the cache
 */
function setCachedSessionId(gatewayBaseUrl: string, result: InitializeResult): void {
	if (result.mode === 'session' && result.sessionId) {
		sessionCache.set(gatewayBaseUrl, {
			mode: 'session',
			sessionId: result.sessionId,
			timestamp: Date.now(),
		});
	}
	else if (result.mode === 'stateless') {
		sessionCache.set(gatewayBaseUrl, {
			mode: 'stateless',
			timestamp: Date.now(),
		});
	}
}

/**
 * Module-level initialize inflight promise (merges concurrent initialize requests across instances)
 * Bucketed by gatewayBaseUrl to avoid blocking requests for different gateways
 */
const initializeInflight = new Map<string, Promise<InitializeResult | null>>();

/**
 * Clear all cached session IDs (called when configuration changes)
 */
export function clearSessionCache(): void {
	sessionCache.clear();
	// Also clear the module-level inflight promises
	initializeInflight.clear();
}

/**
 * Tool orchestrator
 */
export class ToolOrchestrator {
	private readonly gatewayBaseUrl: string;
	private readonly gatewayType: GatewayType;
	private jsonRpcIdCounter = 1;
	private mcpSessionId: string | null = null;

	constructor(
		private readonly config: ConfigStore,
		private readonly context: ToolOrchestratorContext,
		private readonly emitEvent: (event: ToolEventMessage) => void,
	) {
		this.gatewayBaseUrl = normalizeGatewayBaseUrl(config.mcpGatewayUrl || '');
		this.gatewayType = detectGatewayType(this.gatewayBaseUrl);

		// Restore the session ID or stateless marker from the module-level cache to avoid repeated initialize calls
		if (this.gatewayType === GatewayType.JSON_RPC) {
			const cached = getCachedSessionId(this.gatewayBaseUrl);
			if (cached) {
				if (cached.mode === 'session' && cached.sessionId) {
					this.mcpSessionId = cached.sessionId;
				}
				else if (cached.mode === 'stateless') {
					// Stateless mode was already initialized; keep mcpSessionId null and skip repeated initialize calls
					this.mcpSessionId = null;
				}
			}
		}
	}

	/**
	 * Update the current request context (must be called whenever reusing for a new request)
	 *
	 * ToolOrchestrator is reused by sessionId, but requestId changes for each request.
	 * If not updated, tool events will carry the old requestId, the frontend will fail to match them
	 * to the current message, and redundant tool-call prompt boxes will be created.
	 */
	updateRequestContext(requestId: string): void {
		const oldRequestId = this.context.requestId;
		if (!requestId || requestId === oldRequestId) {
			return;
		}
		this.context.requestId = requestId;
		// Note: do not use this.emit(); it goes through the TOOL_EVENT channel and the frontend renders it as a tool prompt box
		// Only output console debug information here (not warning level; this is part of normal flow)
		// eslint-disable-next-line no-console
		console.log(
			`[tool-orchestrator] requestId updated: ${oldRequestId.substring(0, 12)}->${requestId.substring(0, 12)}`,
		);
	}

	isEnabled(): boolean {
		return !!this.config.mcpEnabled && this.gatewayBaseUrl.length > 0;
	}

	async listTools(signal?: AbortSignal): Promise<ChatToolDefinition[]> {
		if (!this.isEnabled()) {
			return [];
		}

		this.emit({
			stage: 'tools-list',
			status: 'running',
			title: 'Loading MCP tool list',
		});

		try {
			// JSON-RPC mode requires initializing the session first
			if (this.gatewayType === GatewayType.JSON_RPC) {
				await this.ensureInitialized(signal);
			}

			let response: ToolListResponseShape;

			if (this.gatewayType === GatewayType.JSON_RPC) {
				// MCP Streamable HTTP (JSON-RPC)
				const jsonRpcRequest: JsonRpcRequest = {
					jsonrpc: '2.0',
					method: 'tools/list',
					id: this.jsonRpcIdCounter++,
				};
				response = await this.postJson<ToolListResponseShape>(
					'',
					jsonRpcRequest,
					signal,
				);
			}
			else {
				// REST Gateway
				response = await this.postJson<ToolListResponseShape>(
					'/tools/list',
					{
						sessionId: this.context.sessionId,
						requestId: this.context.requestId,
					},
					signal,
				);
			}

			const tools = normalizeToolDefinitions(response);

			this.emit({
				stage: 'tools-list',
				status: 'success',
				title: `Loaded ${tools.length} MCP tools`,
				detail: truncateText(tools.map(tool => tool.function.name).join(', '), 240),
			});

			return tools;
		}
		catch (error) {
			this.emit({
				stage: 'tools-list',
				status: 'error',
				title: 'Failed to load tool list',
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async executeToolCalls(
		toolCalls: ChatToolCall[],
		signal?: AbortSignal,
	): Promise<ToolExecutionResultMessage[]> {
		const results: ToolExecutionResultMessage[] = [];

		for (const toolCall of toolCalls) {
			if (signal?.aborted) {
				throw new Error('Tool call was canceled');
			}

			const toolName = toolCall.function.name;
			const argsPreview = truncateText(toolCall.function.arguments || '{}', 240);

			this.emit({
				stage: 'tool-call',
				status: 'running',
				toolCallId: toolCall.id,
				toolName,
				title: `Calling tool ${toolName}`,
				detail: argsPreview,
			});

			try {
				// JSON-RPC mode requires initializing the session first
				if (this.gatewayType === GatewayType.JSON_RPC) {
					await this.ensureInitialized(signal);
				}

				const parsedArguments = parseToolArguments(toolCall.function.arguments);
				let response: ToolCallResponseShape;

				if (this.gatewayType === GatewayType.JSON_RPC) {
					// MCP Streamable HTTP (JSON-RPC)
					const jsonRpcRequest: JsonRpcRequest = {
						jsonrpc: '2.0',
						method: 'tools/call',
						params: {
							name: toolName,
							arguments: parsedArguments,
						},
						id: this.jsonRpcIdCounter++,
					};
					response = await this.postJson<ToolCallResponseShape>(
						'',
						jsonRpcRequest,
						signal,
					);
				}
				else {
					// REST Gateway
					response = await this.postJson<ToolCallResponseShape>(
						'/tools/call',
						{
							sessionId: this.context.sessionId,
							requestId: this.context.requestId,
							name: toolName,
							toolName,
							arguments: parsedArguments,
							autoApprove: this.config.mcpAutoApprove !== false,
						},
						signal,
					);
				}

				const content = coerceToolResultToText(response);
				const isError = detectToolError(response);

				results.push({
					toolCallId: toolCall.id,
					toolName,
					content,
					isError,
				});

				this.emit({
					stage: 'tool-call',
					status: isError ? 'error' : 'success',
					toolCallId: toolCall.id,
					toolName,
					title: isError ? `Tool ${toolName} returned an error` : `Tool ${toolName} completed successfully`,
					resultPreview: truncateText(content, 320),
				});
			}
			catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const fallback = JSON.stringify({
					error: true,
					tool: toolName,
					message: errorMessage,
				}, null, 2);

				results.push({
					toolCallId: toolCall.id,
					toolName,
					content: fallback,
					isError: true,
				});

				this.emit({
					stage: 'tool-call',
					status: 'error',
					toolCallId: toolCall.id,
					toolName,
					title: `Tool ${toolName} failed`,
					error: errorMessage,
				});
			}
		}

		return results;
	}

	/**
	 * Ensure the MCP session has been initialized (required only for JSON-RPC mode)
	 *
	 * Uses a module-level inflight promise to merge concurrent initialize requests across instances.
	 * Bucketed by gatewayBaseUrl to avoid blocking requests for different gateways.
	 * Supports stateless mode: if the session ID is inaccessible (CORS), mark as initialized without a session ID.
	 */
	private async ensureInitialized(signal?: AbortSignal): Promise<void> {
		// Check the cache: both session mode and stateless mode count as initialized
		const cached = getCachedSessionId(this.gatewayBaseUrl);
		if (cached) {
			if (cached.mode === 'session' && cached.sessionId) {
				this.mcpSessionId = cached.sessionId;
				this.emit({
					stage: 'mcp-session',
					status: 'success',
					title: `MCP session is cached (${cached.sessionId.substring(0, 8)}...), skipping initialize`,
				});
			}
			else if (cached.mode === 'stateless') {
				this.emit({
					stage: 'mcp-session',
					status: 'success',
					title: 'MCP stateless mode already initialized, skipping initialize',
				});
			}
			return;
		}

		// Module-level inflight: if another instance is already initializing, wait for it to finish (bucketed by gateway)
		const existingInflight = initializeInflight.get(this.gatewayBaseUrl);
		if (existingInflight) {
			this.emit({
				stage: 'mcp-session',
				status: 'running',
				title: 'MCP initialize merged into an existing request, waiting...',
			});
			const result = await existingInflight;
			if (result?.mode === 'session' && result.sessionId) {
				this.mcpSessionId = result.sessionId;
			}
			this.emit({
				stage: 'mcp-session',
				status: 'success',
				title: result?.mode === 'session'
					? `MCP initialize completed (reused ${result.sessionId!.substring(0, 8)}...)`
					: 'MCP initialize completed (stateless mode)',
			});
			return;
		}

		// Start a new initialize call and use module-level inflight deduplication (bucketed by gateway)
		this.emit({
			stage: 'mcp-session',
			status: 'running',
			title: 'Starting MCP initialize handshake...',
		});
		const inflightPromise = this.performInitialize(signal);
		initializeInflight.set(this.gatewayBaseUrl, inflightPromise);
		try {
			const result = await inflightPromise;
			if (result?.mode === 'session' && result.sessionId) {
				this.mcpSessionId = result.sessionId;
			}
		}
		finally {
			initializeInflight.delete(this.gatewayBaseUrl);
		}
	}

	/**
	 * Perform the MCP initialize handshake
	 *
	 * Returns InitializeResult:
	 * - mode=session: successfully obtained a session ID
	 * - mode=stateless: header was inaccessible (CORS) but the request succeeded, so fall back to stateless mode
	 */
	private async performInitialize(signal?: AbortSignal): Promise<InitializeResult | null> {
		const initRequest: JsonRpcRequest = {
			jsonrpc: '2.0',
			method: 'initialize',
			params: {
				protocolVersion: '2025-03-26',
				capabilities: {},
				clientInfo: {
					name: 'easyeda-ai-assistant',
					version: '1.1.2',
				},
			},
			id: this.jsonRpcIdCounter++,
		};

		await this.postJson<any>(
			'',
			initRequest,
			signal,
			true, // skipSessionHeader = true (do not send a session ID during initialize)
		);

		// If a session ID was obtained successfully, save it to the module-level cache
		if (this.mcpSessionId) {
			const result: InitializeResult = { mode: 'session', sessionId: this.mcpSessionId };
			this.emit({
				stage: 'mcp-session',
				status: 'success',
				title: `MCP initialize succeeded, session ID: ${this.mcpSessionId.substring(0, 8)}...`,
			});
			setCachedSessionId(this.gatewayBaseUrl, result);
			return result;
		}

		// Session ID was not obtained (for example due to CORS restrictions), so fall back to stateless mode
		// Do not throw; allow follow-up requests to proceed without a session ID
		const result: InitializeResult = { mode: 'stateless' };
		this.emit({
			stage: 'mcp-session',
			status: 'success',
			title: 'MCP initialize succeeded but no session ID was returned (CORS?). Falling back to stateless mode',
		});
		setCachedSessionId(this.gatewayBaseUrl, result);
		return result;
	}

	private async postJson<T>(
		path: string,
		payload: unknown,
		signal?: AbortSignal,
		skipSessionHeader = false,
	): Promise<T> {
		if (signal?.aborted) {
			throw new Error('Request was canceled');
		}

		const url = `${this.gatewayBaseUrl}${path}`;
		let abortHandler: (() => void) | undefined;

		const abortPromise = signal
			? new Promise<never>((_, reject) => {
					const onAbort = (): void => {
						reject(new Error('Gateway request was canceled'));
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
			const headers = buildGatewayHeaders(this.config, this.gatewayType);

			// JSON-RPC mode: add the MCP session ID unless this is an initialize request
			if (this.gatewayType === GatewayType.JSON_RPC && !skipSessionHeader && this.mcpSessionId) {
				headers['Mcp-Session-Id'] = this.mcpSessionId;
			}

			const requestPromise = eda.sys_ClientUrl.request(
				url,
				'POST',
				JSON.stringify(payload),
				{ headers },
			) as Promise<unknown>;

			// Only support explicit user cancellation; do not set a timeout because some MCP tools run for a long time
			const response = abortPromise
				? await Promise.race([requestPromise, abortPromise]) as Response
				: await requestPromise as Response;
			if (!response.ok) {
				const text = await response.text();

				// Session became invalid (for example after a supergateway restart): clear cache so later requests re-initialize
				if (this.gatewayType === GatewayType.JSON_RPC && !skipSessionHeader
					&& (response.status === 404 || response.status === 400 || response.status === 410)) {
					this.mcpSessionId = null;
					sessionCache.delete(this.gatewayBaseUrl);
					this.emit({
						stage: 'mcp-session',
						status: 'error',
						title: 'MCP session became invalid and the cache was cleared',
						error: `Gateway HTTP ${response.status}; future requests will re-run initialize`,
					});
				}

				throw new Error(`Gateway HTTP ${response.status}: ${truncateText(text, 500)}`);
			}

			// JSON-RPC mode: extract the MCP session ID (only during initialize)
			if (this.gatewayType === GatewayType.JSON_RPC && skipSessionHeader) {
				const sessionId = response.headers.get('mcp-session-id');
				if (sessionId) {
					this.mcpSessionId = sessionId;
				}
			}

			const rawText = await response.text();
			if (!rawText) {
				return {} as T;
			}

			// MCP Streamable HTTP uses SSE format
			if (this.gatewayType === GatewayType.JSON_RPC && rawText.startsWith('event:')) {
				return parseSSEResponse(rawText) as T;
			}

			try {
				return JSON.parse(rawText) as T;
			}
			catch {
				return { content: rawText } as T;
			}
		}
		finally {
			if (signal && abortHandler) {
				signal.removeEventListener('abort', abortHandler);
			}
		}
	}

	private emit(event: Omit<ToolEventMessage, 'requestId' | 'sessionId' | 'eventId' | 'timestamp'>): void {
		this.emitEvent({
			...event,
			requestId: this.context.requestId,
			sessionId: this.context.sessionId,
			eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			timestamp: Date.now(),
		});
	}
}

// ============ Helper Functions ============

function buildGatewayHeaders(config: ConfigStore, gatewayType: GatewayType): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	// MCP Streamable HTTP must accept both JSON and SSE
	if (gatewayType === GatewayType.JSON_RPC) {
		headers.Accept = 'application/json, text/event-stream';
	}

	if (config.mcpGatewayApiKey && config.mcpGatewayApiKey.trim().length > 0) {
		headers.Authorization = `Bearer ${config.mcpGatewayApiKey.trim()}`;
	}

	// REST Gateway-specific header
	if (gatewayType === GatewayType.REST) {
		headers['X-MCP-Auto-Approve'] = config.mcpAutoApprove === false ? 'false' : 'true';
	}

	return headers;
}

function normalizeGatewayBaseUrl(url: string): string {
	const normalized = url.trim().replace(/\/+$/, '');
	return normalized;
}

/**
 * Detect the Gateway type
 *
 * Rules:
 * - If the URL ends with an MCP transport path such as /mcp, /sse, or /http, treat it as JSON-RPC
 * - Otherwise treat it as a REST Gateway
 */
function detectGatewayType(url: string): GatewayType {
	const lowerUrl = url.toLowerCase();

	// Common MCP Streamable HTTP endpoint patterns
	const jsonRpcPatterns = [
		'/mcp',
		'/sse',
		'/http',
		'/streamable',
		'/jsonrpc',
	];

	for (const pattern of jsonRpcPatterns) {
		if (lowerUrl.endsWith(pattern)) {
			return GatewayType.JSON_RPC;
		}
	}

	return GatewayType.REST;
}

function normalizeToolDefinitions(payload: unknown): ChatToolDefinition[] {
	const rawTools = extractRawTools(payload);
	const definitions: ChatToolDefinition[] = [];

	for (const item of rawTools) {
		if (!isRecord(item))
			continue;

		const name = typeof item.name === 'string' ? item.name : '';
		if (!name)
			continue;

		const description = typeof item.description === 'string' ? item.description : '';
		const inputSchema = isRecord(item.inputSchema)
			? item.inputSchema
			: (isRecord(item.input_schema) ? item.input_schema : (isRecord(item.parameters) ? item.parameters : undefined));

		definitions.push({
			type: 'function',
			function: {
				name,
				description: description || undefined,
				parameters: inputSchema || { type: 'object', additionalProperties: true },
			},
		});
	}

	return definitions;
}

function extractRawTools(payload: unknown): unknown[] {
	if (!isRecord(payload))
		return [];

	// JSON-RPC response format: { jsonrpc: "2.0", result: { tools: [...] }, id: 1 }
	if (payload.jsonrpc === '2.0' && isRecord(payload.result)) {
		if (Array.isArray(payload.result.tools)) {
			return payload.result.tools;
		}
		// Some implementations return result: [...] directly
		if (Array.isArray(payload.result)) {
			return payload.result;
		}
	}

	// REST response format: { tools: [...] } or { result: { tools: [...] } }
	if (Array.isArray(payload.tools)) {
		return payload.tools;
	}
	if (isRecord(payload.result) && Array.isArray(payload.result.tools)) {
		return payload.result.tools;
	}

	return [];
}

function parseToolArguments(argumentsText: string): unknown {
	const text = (argumentsText || '').trim();
	if (!text)
		return {};
	try {
		return JSON.parse(text) as unknown;
	}
	catch {
		return { _raw: text };
	}
}

function coerceToolResultToText(response: unknown): string {
	if (!isRecord(response)) {
		return stringifyUnknown(response);
	}

	// JSON-RPC error response: { jsonrpc: "2.0", error: {...}, id: 1 }
	if (response.jsonrpc === '2.0' && isRecord(response.error)) {
		const error = response.error;
		const message = typeof error.message === 'string' ? error.message : '';
		const code = typeof error.code === 'number' ? error.code : '';
		return `JSON-RPC Error ${code}: ${message}`;
	}

	// JSON-RPC success response: { jsonrpc: "2.0", result: {...}, id: 1 }
	if (response.jsonrpc === '2.0' && response.result !== undefined) {
		return coerceToolResultToText(response.result);
	}

	// Recursively handle nested result values
	if (isRecord(response.result)) {
		return coerceToolResultToText(response.result);
	}

	// MCP standard content-array format
	if (Array.isArray(response.content)) {
		return extractTextFromContentArray(response.content);
	}

	// Simple string content
	if (typeof response.content === 'string') {
		return response.content;
	}

	// Other fields
	if (response.output !== undefined) {
		return stringifyUnknown(response.output);
	}
	if (response.error !== undefined) {
		return stringifyUnknown(response.error);
	}

	return stringifyUnknown(response);
}

function extractTextFromContentArray(content: unknown[]): string {
	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
			parts.push(item.text);
		}
		else {
			parts.push(stringifyUnknown(item));
		}
	}
	return parts.join('\n').trim();
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength)}...`;
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value, null, 2);
	}
	catch {
		return String(value);
	}
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null;
}

/**
 * Parse an SSE response (MCP Streamable HTTP)
 *
 * Format:
 * event: message
 * data: {"jsonrpc":"2.0","result":{...},"id":1}
 */
function parseSSEResponse(text: string): unknown {
	const lines = text.split(/\r?\n/);
	let dataLine = '';

	for (const line of lines) {
		if (line.startsWith('data:')) {
			dataLine = line.substring(5).trim();
			break;
		}
	}

	if (!dataLine) {
		throw new Error('No data field was found in the SSE response');
	}

	try {
		return JSON.parse(dataLine);
	}
	catch (error) {
		throw new Error(`Failed to parse SSE data: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Recursively detect error status in a tool response
 *
 * Supports two formats:
 * 1. JSON-RPC 2.0: { jsonrpc: "2.0", error: {...}, id: 1 }
 * 2. MCP spec: { result: { isError: true } } or { error: "..." }
 *
 * Recursively checks all nested result levels to avoid missing deep errors.
 */
function detectToolError(response: unknown, visited = new Set<any>()): boolean {
	if (!isRecord(response)) {
		return false;
	}

	// Prevent infinite recursion caused by circular references
	if (visited.has(response)) {
		return false;
	}
	visited.add(response);

	// JSON-RPC error response
	if (response.jsonrpc === '2.0' && response.error !== undefined) {
		return true;
	}

	// Check top-level isError
	if (response.isError === true) {
		return true;
	}

	// Check top-level error field (protocol-level errors)
	// Only non-empty objects or meaningful strings count as errors
	if (response.error !== undefined && response.error !== null && response.error !== false) {
		if (typeof response.error === 'string' && response.error.trim().length > 0) {
			return true;
		}
		if (typeof response.error === 'object') {
			return true;
		}
	}

	// Recursively check nested result
	if (isRecord(response.result)) {
		if (detectToolError(response.result, visited)) {
			return true;
		}
	}

	return false;
}
