/**
 * eda-mcp-server - 共享类型定义
 *
 * 从 EDA 扩展的 types.ts 精简导出，仅包含 MCP server 需要的数据类型。
 */

// ============ 原始数据结构（与扩展端 1:1 对应） ============

export interface RawComponent {
	primitiveId: string;
	designator: string;
	name: string;
	value: string;
	prefix: string;
	addIntoPcb: string;
	lcscPart: string;
	jlcPart: string;
	bomInclude: string;
	manufacturer: string;
	manufacturerPartNumber: string;
	x: number;
	y: number;
	rotation: number;
	schematicPageUuid?: string;
}

export interface RawPin {
	primitiveId: string;
	componentPrimitiveId: string;
	componentDesignator: string;
	pinNumber: string;
	pinName: string;
	pinType: string;
	netName: string | null;
	netBindingConfidence?: number;
	netBindingReason?: string;
}

export interface RawNet {
	netName: string;
	pinCount: number;
	pins: string[];
}

export interface RawText {
	primitiveId: string;
	content: string;
	x: number;
	y: number;
	schematicPageUuid?: string;
}

export interface RawBus {
	primitiveId: string;
	busName: string;
	lines: number[][];
	schematicPageUuid?: string;
}

export interface RawNetLabel {
	primitiveId: string;
	netName: string;
	x: number;
	y: number;
	type: 'netflag' | 'netport';
	schematicPageUuid?: string;
}

export interface RawDrcResult {
	passed: boolean;
	strict: boolean;
	timestamp: number;
}

export interface RawProjectInfo {
	projectName: string;
	projectDescription?: string;
	projectUuid: string;
	timestamp: number;
}

export interface RawArc {
	primitiveId: string;
	cx: number;
	cy: number;
	radius: number;
	startAngle: number;
	endAngle: number;
	schematicPageUuid?: string;
}

export interface RawCircle {
	primitiveId: string;
	cx: number;
	cy: number;
	radius: number;
	schematicPageUuid?: string;
}

export interface RawPolygon {
	primitiveId: string;
	points: number[][];
	closed: boolean;
	schematicPageUuid?: string;
}

export interface RawRectangle {
	primitiveId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	schematicPageUuid?: string;
}

export interface RawPrimitivePin {
	primitiveId: string;
	pinNumber: string;
	pinName: string;
	pinType: string;
	x: number;
	y: number;
	schematicPageUuid?: string;
}

export interface CollectionMeta {
	mode: string;
	quality: string;
	expectedPageCount: number;
	collectedPageCount: number;
	collectedPageUuids: string[];
	missingPageUuids: string[];
	errorMessage?: string;
}

/**
 * 完整的采集数据快照（与扩展端 CollectedData 一致）
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

// ============ WS 桥接协议类型 ============

/** 扩展 → Server: hello 握手 */
export interface BridgeHelloMessage {
	type: 'hello';
	app: { name: string; version: string };
	project: { uuid: string; name: string };
	snapshotVersion: number;
	timestamp: number;
}

/** 扩展 → Server: 数据快照 */
export interface BridgeSnapshotMessage {
	type: 'snapshot';
	version: number;
	projectUuid: string;
	timestamp: number;
	payload: CollectedData;
}

/** 扩展 → Server: pong 心跳回复 */
export interface BridgePongMessage {
	type: 'pong';
	timestamp: number;
	nonce?: string;
	pingTimestamp?: number;
}

/** 所有来自扩展的消息联合类型 */
export type BridgeInboundMessage = BridgeHelloMessage | BridgeSnapshotMessage | BridgePongMessage;

/** Server → 扩展: 请求数据 */
export interface ServerRequestDataMessage {
	type: 'request_data';
}

/** Server → 扩展: 心跳 */
export interface ServerPingMessage {
	type: 'ping';
	nonce?: string;
	timestamp?: number;
}

/** Server → 扩展: 快照确认 */
export interface ServerAckMessage {
	type: 'ack';
	version: number;
}

/** 所有 server 发出的消息联合类型 */
export type ServerOutboundMessage = ServerRequestDataMessage | ServerPingMessage | ServerAckMessage;
