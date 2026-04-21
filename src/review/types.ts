/**
 * AI schematic review - type definitions
 */

// ============ Data Serialization Format ============

/**
 * SCH-REVIEW-COMPACT v1 format
 * Uses tuple arrays to save tokens
 * The fields definition specifies the column order for each tuple array, which AI should parse accordingly
 */

/** Optional field names for component tuples */
export type SchComponentFieldKey
	= | 'designator'
		| 'name'
		| 'value'
		| 'manufacturer'
		| 'manufacturerPartNumber'
		| 'lcscPart'
		| 'addIntoPcb'
		| 'bomInclude'
		| 'x'
		| 'y'
		| 'rotation';

/** Optional field names for pin tuples */
export type SchPinFieldKey
	= | 'componentDesignator'
		| 'pinNumber'
		| 'pinName'
		| 'pinType'
		| 'netName';

/** Optional field names for net tuples */
export type SchNetFieldKey = 'netName' | 'pinCount';

export interface SchReviewChunk {
	schema: 'sch-review-compact-v1' | 'sch-review-compact-v2';
	summary: {
		totalComponents: number;
		totalPins: number;
		totalNets: number;
		chunkId: string;
		chunkCount: number;
	};
	/** Column-order mapping for each tuple array; AI must use this as the parsing source of truth */
	fields: {
		components: SchComponentFieldKey[];
		pins: SchPinFieldKey[];
		nets: SchNetFieldKey[];
	};
	components: Array<Array<string | number>>;
	pins: Array<Array<string | null>>;
	nets: Array<Array<string | number>>;
	/** Optional extended data (included after the user selects it) */
	texts?: Array<[string, string, number, number]>; // [primitiveId, content, x, y]
	buses?: Array<[string, string, number[][]]>; // [primitiveId, busName, lines]
	netLabels?: Array<[string, string, number, number, 'netflag' | 'netport']>; // [primitiveId, netName, x, y, type]
	/** v2 shape-primitive tuple data */
	arcs?: Array<[string, number, number, number, number, number]>; // [primitiveId, cx, cy, radius, startAngle, endAngle]
	circles?: Array<[string, number, number, number]>; // [primitiveId, cx, cy, radius]
	polygons?: Array<[string, number[][], boolean]>; // [primitiveId, points, closed]
	rectangles?: Array<[string, number, number, number, number]>; // [primitiveId, x, y, width, height]
	primitivePins?: Array<[string, string, string, string, number, number]>; // [primitiveId, pinNumber, pinName, pinType, x, y]
	/** v2 top-level standalone fields */
	drcResult?: RawDrcResult;
	projectInfo?: RawProjectInfo;
}

// ============ Raw Data Structures ============

/**
 * Raw component data
 */
export interface RawComponent {
	primitiveId: string;
	designator: string;
	name: string;
	value: string; // Key property: resistor value, capacitor value, etc.
	prefix: string; // Reference designator prefix (R, C, U, etc.)
	addIntoPcb: string; // Whether to add to PCB (affects netlist generation)
	lcscPart: string; // LCSC part number
	jlcPart: string; // JLC part number
	bomInclude: string; // Whether to include in BOM
	manufacturer: string;
	manufacturerPartNumber: string;
	x: number;
	y: number;
	rotation: number;
	schematicPageUuid?: string;
}

/**
 * Raw pin data
 */
export interface RawPin {
	primitiveId: string;
	componentPrimitiveId: string;
	componentDesignator: string;
	pinNumber: string;
	pinName: string;
	pinType: string;
	netName: string | null;
	netBindingConfidence?: number; // 0-1, network-binding confidence
	netBindingReason?: string; // Binding source: netlist/wire/netlabel/unresolved
}

/**
 * Raw net data
 */
export interface RawNet {
	netName: string;
	pinCount: number;
	pins: string[]; // pin primitive IDs
}

/**
 * Collection mode
 */
export type CollectionMode = 'per-page' | 'per-page-hybrid';

/**
 * Collection quality levels
 * - full: all pages collected successfully
 * - partial: only some pages collected successfully; gaps exist
 * - stale: using an old snapshot or fully degraded
 */
export type CollectionQuality = 'full' | 'partial' | 'stale';

/**
 * Collection metadata (used for data integrity tracking and frontend hints)
 */
export interface CollectionMeta {
	mode: CollectionMode;
	quality: CollectionQuality;
	expectedPageCount: number;
	collectedPageCount: number;
	collectedPageUuids: string[];
	missingPageUuids: string[];
	errorMessage?: string;
}

/**
 * Raw text annotation data
 */
export interface RawText {
	primitiveId: string;
	content: string;
	x: number;
	y: number;
	schematicPageUuid?: string;
}

/**
 * Raw bus data
 */
export interface RawBus {
	primitiveId: string;
	busName: string;
	lines: number[][];
	schematicPageUuid?: string;
}

/**
 * Raw net-label data (labels such as GND, VCC, etc.)
 */
export interface RawNetLabel {
	primitiveId: string;
	netName: string;
	x: number;
	y: number;
	type: 'netflag' | 'netport';
	schematicPageUuid?: string;
}

/**
 * DRC check result (global, independent of page switching)
 */
export interface RawDrcResult {
	passed: boolean;
	strict: boolean;
	timestamp: number;
}

/**
 * Project metadata (global, independent of page switching)
 */
export interface RawProjectInfo {
	projectName: string;
	projectDescription?: string;
	projectUuid: string;
	timestamp: number;
}

/**
 * Raw arc primitive data
 */
export interface RawArc {
	primitiveId: string;
	cx: number;
	cy: number;
	radius: number;
	startAngle: number;
	endAngle: number;
	schematicPageUuid?: string;
}

/**
 * Raw circle primitive data
 */
export interface RawCircle {
	primitiveId: string;
	cx: number;
	cy: number;
	radius: number;
	schematicPageUuid?: string;
}

/**
 * Raw polygon / polyline primitive data
 */
export interface RawPolygon {
	primitiveId: string;
	points: number[][];
	closed: boolean;
	schematicPageUuid?: string;
}

/**
 * Raw rectangle primitive data
 */
export interface RawRectangle {
	primitiveId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	schematicPageUuid?: string;
}

/**
 * Raw standalone pin primitive data (not attached to a component pin)
 */
export interface RawPrimitivePin {
	primitiveId: string;
	pinNumber: string;
	pinName: string;
	pinType: string;
	x: number;
	y: number;
	schematicPageUuid?: string;
}

/**
 * Collected raw data snapshot
 */
export interface CollectedData {
	components: RawComponent[];
	pins: RawPin[];
	nets: RawNet[];
	texts?: RawText[];
	buses?: RawBus[];
	netLabels?: RawNetLabel[];
	arcs?: RawArc[];
	circles?: RawCircle[];
	polygons?: RawPolygon[];
	rectangles?: RawRectangle[];
	primitivePins?: RawPrimitivePin[];
	drcResult?: RawDrcResult;
	projectInfo?: RawProjectInfo;
	netlistRaw?: string;
	timestamp: number;
	meta?: CollectionMeta;
}

// ============ Review Results ============

/**
 * Issue severity
 */
export enum IssueSeverity {
	MUST_FIX = 'must_fix',
	SUGGESTION = 'suggestion',
}

/**
 * Issue evidence
 */
export interface IssueEvidence {
	components?: string[]; // component reference designators
	pins?: string[]; // pin identifiers (format: U1.32 or U1_32)
	nets?: string[]; // net names
	datasheet_urls?: string[]; // datasheet links
}

/**
 * Review issue
 */
export interface ReviewIssue {
	id: string; // unique identifier
	severity: IssueSeverity;
	title: string;
	reason: string;
	impact: string;
	confidence: number; // 0-1
	fix: string;
	evidence: IssueEvidence;
	source: 'rule-engine' | 'ai'; // issue source
	ruleId?: string; // rule ID (if from the rule engine)
}

/**
 * Review result
 */
export interface ReviewResult {
	must_fix: ReviewIssue[];
	suggestions: ReviewIssue[];
	metadata: {
		timestamp: number;
		totalComponents: number;
		totalPins: number;
		totalNets: number;
		chunksProcessed: number;
		aiProvider?: string;
		aiModel?: string;
	};
}

// ============ Configuration ============

/**
 * AI provider type
 */
export enum AIProvider {
	OPENAI_COMPATIBLE = 'openai_compatible',
}

/**
 * Schematic field-selection config
 * Controls which fields are serialized into AI schematic_data
 * Core identifier fields (designator/pinNumber/netName) are always preserved by the backend
 */
export interface SchematicFieldsConfig {
	// Component fields
	componentName?: boolean;
	componentValue?: boolean;
	componentManufacturer?: boolean;
	componentManufacturerPartNumber?: boolean;
	componentLcscPart?: boolean;
	componentAddIntoPcb?: boolean;
	componentBomInclude?: boolean;
	componentXy?: boolean;
	componentRotation?: boolean;
	// Pin fields
	pinPinName?: boolean;
	pinPinType?: boolean;
	// Net fields
	netPinCount?: boolean;
	// Extra data (not sent by default)
	includeTexts?: boolean;
	includeBuses?: boolean;
	includeNetLabels?: boolean;
	// Shape primitives (not sent by default)
	includeArcs?: boolean;
	includeCircles?: boolean;
	includePolygons?: boolean;
	includeRectangles?: boolean;
	// Enriched data (not sent by default)
	includePrimitivePins?: boolean;
	includeDrc?: boolean;
	includeProjectInfo?: boolean;
}

/** Default value for all fields (true = send to AI by default, false = do not send by default) */
export const DEFAULT_SCHEMATIC_FIELDS: Required<SchematicFieldsConfig> = {
	componentName: true,
	componentValue: true,
	componentManufacturer: true,
	componentManufacturerPartNumber: true,
	componentLcscPart: true,
	componentAddIntoPcb: true,
	componentBomInclude: true,
	componentXy: true,
	componentRotation: true,
	pinPinName: true,
	pinPinType: true,
	netPinCount: true,
	includeTexts: false,
	includeBuses: false,
	includeNetLabels: false,
	includeArcs: false,
	includeCircles: false,
	includePolygons: false,
	includeRectangles: false,
	includePrimitivePins: false,
	includeDrc: false,
	includeProjectInfo: false,
};

/**
 * Configuration storage
 */
export interface ConfigStore {
	provider: AIProvider;
	apiKey: string;
	model: string;
	apiUrl?: string; // custom API address
	maxPinsPerChunk?: number; // default 1200
	windowWidth?: number; // window width, default 960
	windowHeight?: number; // window height, default 700
	mcpEnabled?: boolean; // whether to enable MCP tool calls
	mcpGatewayUrl?: string; // MCP Gateway address
	mcpGatewayApiKey?: string; // MCP Gateway auth token (optional)
	mcpAutoApprove?: boolean; // whether to auto-approve tool calls by default
	mcpBridgeUrl?: string; // local eda-mcp-server WebSocket address (default ws://127.0.0.1:3100)
	customSystemPrompt?: string; // user-defined system prompt (appended after the built-in prompt)
	schematicFields?: SchematicFieldsConfig; // schematic field selection (controls which fields are sent to AI)
}

// ============ Chat-Mode Communication Protocol ============

/**
 * MessageBus topics (chat mode)
 */
export const CHAT_TOPICS = {
	// IFrame -> main extension
	REQUEST_DATA: 'ai-chat/request-data',
	REQUEST_CONFIG: 'ai-chat/request-config',
	REQUEST_HISTORY: 'ai-chat/request-history',
	REQUEST_TOOLS: 'ai-chat/request-tools',
	REFRESH_DATA: 'ai-chat/refresh-data',
	USER_MESSAGE: 'ai-chat/user-message',
	ABORT_REQUEST: 'ai-chat/abort-request',
	REGENERATE_REQUEST: 'ai-chat/regenerate-request',
	LOCATE: 'ai-chat/locate',
	CONFIG_UPDATE: 'ai-chat/config-update',
	HISTORY_UPDATE: 'ai-chat/history-update',
	CLEAR_SESSION: 'ai-chat/clear-session',

	// main extension -> IFrame
	SCHEMATIC_DATA: 'ai-chat/schematic-data',
	CONFIG_DATA: 'ai-chat/config-data',
	HISTORY_DATA: 'ai-chat/history-data',
	TOOLS_DATA: 'ai-chat/tools-data',
	AI_RESPONSE: 'ai-chat/ai-response',
	AI_THINKING: 'ai-chat/ai-thinking',
	AI_TEXT: 'ai-chat/ai-text',
	TOOL_EVENT: 'ai-chat/tool-event',
	ERROR: 'ai-chat/error',
} as const;

/**
 * Schematic data summary (sent to the IFrame)
 */
export interface SchematicDataSummary {
	summary: {
		components: number;
		pins: number;
		nets: number;
	};
	drcPassed?: boolean;
	projectName?: string;
	timestamp: number;
}

/**
 * User message (IFrame -> main extension)
 */
export interface UserMessage {
	text: string;
	images?: Array<{
		name: string;
		type: string;
		data: string; // base64
	}>;
	schematicData?: SchematicDataSummary | null;
	requestId: string; // request unique identifier, used for response matching
	sessionId: string; // session identifier, prevents cross-thread leakage
}

/**
 * AI response (main extension -> IFrame)
 */
export interface AIResponse {
	content: string;
	timestamp: number;
	requestId: string; // echoed request ID
	sessionId: string; // echoed session ID
}

/**
 * Streaming chunk types (refer to Cherry Studio ChunkType)
 */
export enum ChunkType {
	THINKING_START = 'THINKING_START',
	THINKING_DELTA = 'THINKING_DELTA',
	THINKING_COMPLETE = 'THINKING_COMPLETE',
	TEXT_START = 'TEXT_START',
	TEXT_DELTA = 'TEXT_DELTA',
	TEXT_COMPLETE = 'TEXT_COMPLETE',
}

/**
 * Streaming chunk status
 */
export type MessageBlockStatus = 'success' | 'paused' | 'streaming' | 'error';

/**
 * AI streaming message block (backend internal use)
 */
export interface MessageBlock {
	type: ChunkType;
	content: string; // current incremental content
	accumulatedContent: string; // cumulative content up to now
	timestamp: number;
	status?: MessageBlockStatus;
}

/**
 * AI streaming message block (main extension -> IFrame)
 */
export interface AIBlockResponse extends MessageBlock {
	requestId: string;
	sessionId: string;
}

// ============ MCP Tool Call Types ============

/**
 * Chat Completions - tool definitions available to the model (OpenAI function calling format)
 */
export interface ChatToolDefinition {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

/**
 * Chat Completions - tool calls initiated by the model
 */
export interface ChatToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string; // JSON string
	};
}

/**
 * Message returned to the model after tool execution
 */
export interface ToolExecutionResultMessage {
	toolCallId: string;
	toolName: string;
	content: string;
	isError?: boolean;
}

/** Tool event status */
export type ToolEventStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

/** Tool event stage */
export type ToolEventStage = 'tools-list' | 'tool-call';

/**
 * Tool execution event (main extension -> IFrame)
 */
export interface ToolEventMessage {
	requestId: string;
	sessionId: string;
	eventId: string;
	stage: ToolEventStage;
	status: ToolEventStatus;
	title: string;
	toolName?: string;
	toolCallId?: string;
	detail?: string;
	resultPreview?: string;
	error?: string;
	timestamp: number;
}

/**
 * Locate request (IFrame -> main extension)
 */
export interface LocateRequest {
	reference: string; // component reference designator or net name
}

/**
 * Abort generation request (IFrame -> main extension)
 */
export interface AbortRequest {
	requestId: string;
	sessionId: string;
}

/**
 * Regenerate request (IFrame -> main extension)
 */
export interface RegenerateRequest {
	requestId: string;
	sessionId: string;
}

/**
 * Error message (main extension -> IFrame)
 */
export interface ErrorMessage {
	message: string;
	code?: string;
	details?: unknown;
	requestId?: string; // echoed request ID (if present)
	sessionId?: string; // echoed session ID (if present)
}

// ============ Error Codes ============

export enum ErrorCode {
	// Collection errors
	COLLECT_NO_DOCUMENT = 'COLLECT_NO_DOCUMENT',
	COLLECT_API_FAILED = 'COLLECT_API_FAILED',

	// Serialization errors
	SERIALIZE_INVALID_DATA = 'SERIALIZE_INVALID_DATA',

	// AI communication errors
	AI_NO_CONFIG = 'AI_NO_CONFIG',
	AI_NETWORK_ERROR = 'AI_NETWORK_ERROR',
	AI_CORS_ERROR = 'AI_CORS_ERROR',
	AI_AUTH_ERROR = 'AI_AUTH_ERROR',
	AI_RATE_LIMIT = 'AI_RATE_LIMIT',
	AI_TIMEOUT = 'AI_TIMEOUT',
	AI_ABORTED = 'AI_ABORTED',
	AI_INVALID_RESPONSE = 'AI_INVALID_RESPONSE',
	AI_SERVER_ERROR = 'AI_SERVER_ERROR',

	// UI errors
	UI_IFRAME_FAILED = 'UI_IFRAME_FAILED',
	UI_MESSAGEBUS_FAILED = 'UI_MESSAGEBUS_FAILED',
}

/**
 * Review error
 */
export class ReviewError extends Error {
	constructor(
		public code: ErrorCode,
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = 'ReviewError';
	}
}
