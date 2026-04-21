/**
 * eda-mcp-server - shared type definitions
 *
 * Re-exported and simplified from the EDA extension types.ts, containing only the data types needed by the MCP server.
 */

// ============ Raw data structures (1:1 with the extension side) ============

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
 * Complete collection snapshot (consistent with the extension-side CollectedData)
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

// ============ WS bridge protocol types ============

/** Extension -> Server: hello handshake */
export interface BridgeHelloMessage {
	type: 'hello';
	app: { name: string; version: string };
	project: { uuid: string; name: string };
	snapshotVersion: number;
	timestamp: number;
}

/** Extension -> Server: data snapshot */
export interface BridgeSnapshotMessage {
	type: 'snapshot';
	version: number;
	projectUuid: string;
	timestamp: number;
	payload: CollectedData;
}

/** Extension -> Server: pong heartbeat reply */
export interface BridgePongMessage {
	type: 'pong';
	timestamp: number;
	nonce?: string;
	pingTimestamp?: number;
}

/** Union of all messages sent by the extension */
export type BridgeInboundMessage = BridgeHelloMessage | BridgeSnapshotMessage | BridgePongMessage;

/** Server -> Extension: request data */
export interface ServerRequestDataMessage {
	type: 'request_data';
}

/** Server -> Extension: heartbeat ping */
export interface ServerPingMessage {
	type: 'ping';
	nonce?: string;
	timestamp?: number;
}

/** Server -> Extension: snapshot acknowledgement */
export interface ServerAckMessage {
	type: 'ack';
	version: number;
}

/** Union of all messages sent by the server */
export type ServerOutboundMessage = ServerRequestDataMessage | ServerPingMessage | ServerAckMessage;
