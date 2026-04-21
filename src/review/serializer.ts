/**
 * AI Schematic Review - data serialization module
 *
 * Convert CollectedData into SCH-REVIEW-COMPACT v1 tuple format
 * Supports dynamic field selection based on SchematicFieldsConfig and embeds fields metadata in each chunk
 */
import type {
	CollectedData,
	SchComponentFieldKey,
	SchematicFieldsConfig,
	SchNetFieldKey,
	SchPinFieldKey,
	SchReviewChunk,
} from './types';
import { DEFAULT_SCHEMATIC_FIELDS, ErrorCode, ReviewError } from './types';

type RawComponent = CollectedData['components'][number];
type RawPin = CollectedData['pins'][number];
type RawNet = CollectedData['nets'][number];

/**
 * Normalize field configuration and use defaults for unset entries
 */
function resolveSchematicFields(fields?: SchematicFieldsConfig): Required<SchematicFieldsConfig> {
	return { ...DEFAULT_SCHEMATIC_FIELDS, ...(fields || {}) };
}

/**
 * Serialize to compact format
 *
 * @param data         The collected source data
 * @param chunkId      Current chunk ID
 * @param chunkCount   Total number of chunks
 * @param fields       Field selection configuration. If omitted, all default fields are used
 */
export function serializeToCompactFormat(
	data: CollectedData,
	chunkId: string,
	chunkCount: number,
	fields?: SchematicFieldsConfig,
): SchReviewChunk {
	if (!data || !data.components || !data.pins || !data.nets) {
		throw new ReviewError(
			ErrorCode.SERIALIZE_INVALID_DATA,
			'Invalid data format',
		);
	}

	const resolvedFields = resolveSchematicFields(fields);

	// Determine the schema version based on whether v2 extension data exists
	const hasV2Data = (
		(resolvedFields.includeArcs && !!data.arcs?.length)
		|| (resolvedFields.includeCircles && !!data.circles?.length)
		|| (resolvedFields.includePolygons && !!data.polygons?.length)
		|| (resolvedFields.includeRectangles && !!data.rectangles?.length)
		|| (resolvedFields.includePrimitivePins && !!data.primitivePins?.length)
		|| (resolvedFields.includeDrc && !!data.drcResult)
		|| (resolvedFields.includeProjectInfo && !!data.projectInfo)
	);
	const schema = hasV2Data ? 'sch-review-compact-v2' as const : 'sch-review-compact-v1' as const;

	// ---------- Build component field order. designator is a core field and is always retained ----------
	const componentFields: SchComponentFieldKey[] = ['designator'];
	if (resolvedFields.componentName)
		componentFields.push('name');
	if (resolvedFields.componentValue)
		componentFields.push('value');
	if (resolvedFields.componentManufacturer)
		componentFields.push('manufacturer');
	if (resolvedFields.componentManufacturerPartNumber)
		componentFields.push('manufacturerPartNumber');
	if (resolvedFields.componentLcscPart)
		componentFields.push('lcscPart');
	if (resolvedFields.componentAddIntoPcb)
		componentFields.push('addIntoPcb');
	if (resolvedFields.componentBomInclude)
		componentFields.push('bomInclude');
	if (resolvedFields.componentXy)
		componentFields.push('x', 'y');
	if (resolvedFields.componentRotation)
		componentFields.push('rotation');

	// ---------- Build pin field order. componentDesignator, pinNumber, and netName are core fields and always retained ----------
	const pinFields: SchPinFieldKey[] = ['componentDesignator', 'pinNumber'];
	if (resolvedFields.pinPinName)
		pinFields.push('pinName');
	if (resolvedFields.pinPinType)
		pinFields.push('pinType');
	pinFields.push('netName'); // Core field, always placed at the end

	// ---------- Build net field order. netName is a core field and is always retained ----------
	const netFields: SchNetFieldKey[] = ['netName'];
	if (resolvedFields.netPinCount)
		netFields.push('pinCount');

	// ---------- Field getters to avoid switch chains and keep the code readable ----------
	const componentFieldGetters: Record<SchComponentFieldKey, (c: RawComponent) => string | number> = {
		designator: c => c.designator,
		name: c => c.name,
		value: c => c.value,
		manufacturer: c => c.manufacturer,
		manufacturerPartNumber: c => c.manufacturerPartNumber,
		lcscPart: c => c.lcscPart,
		addIntoPcb: c => c.addIntoPcb,
		bomInclude: c => c.bomInclude,
		x: c => c.x,
		y: c => c.y,
		rotation: c => c.rotation,
	};

	const pinFieldGetters: Record<SchPinFieldKey, (p: RawPin) => string | null> = {
		componentDesignator: p => p.componentDesignator,
		pinNumber: p => p.pinNumber,
		pinName: p => p.pinName,
		pinType: p => p.pinType,
		netName: p => p.netName,
	};

	const netFieldGetters: Record<SchNetFieldKey, (n: RawNet) => string | number> = {
		netName: n => n.netName,
		pinCount: n => n.pinCount,
	};

	// ---------- Serialize the three main data groups ----------
	const components = data.components.map(c =>
		componentFields.map(field => componentFieldGetters[field](c)),
	);

	const pins = data.pins.map(p =>
		pinFields.map(field => pinFieldGetters[field](p)),
	);

	const nets = data.nets.map(n =>
		netFields.map(field => netFieldGetters[field](n)),
	);

	// ---------- Assemble the chunk ----------
	const chunk: SchReviewChunk = {
		schema,
		summary: {
			totalComponents: data.components.length,
			totalPins: data.pins.length,
			totalNets: data.nets.length,
			chunkId,
			chunkCount,
		},
		fields: {
			components: componentFields,
			pins: pinFields,
			nets: netFields,
		},
		components,
		pins,
		nets,
	};

	// ---------- Optional extension data, attached only when the matching field is enabled and source data exists ----------
	if (resolvedFields.includeTexts && data.texts && data.texts.length > 0) {
		chunk.texts = data.texts.map(t => [t.primitiveId, t.content, t.x, t.y]);
	}

	if (resolvedFields.includeBuses && data.buses && data.buses.length > 0) {
		chunk.buses = data.buses.map(b => [b.primitiveId, b.busName, b.lines]);
	}

	if (resolvedFields.includeNetLabels && data.netLabels && data.netLabels.length > 0) {
		chunk.netLabels = data.netLabels.map(l => [l.primitiveId, l.netName, l.x, l.y, l.type]);
	}

	// ---------- v2 graphic primitive tuple data ----------
	if (resolvedFields.includeArcs && data.arcs && data.arcs.length > 0) {
		chunk.arcs = data.arcs.map(a => [a.primitiveId, a.cx, a.cy, a.radius, a.startAngle, a.endAngle]);
	}

	if (resolvedFields.includeCircles && data.circles && data.circles.length > 0) {
		chunk.circles = data.circles.map(c => [c.primitiveId, c.cx, c.cy, c.radius]);
	}

	if (resolvedFields.includePolygons && data.polygons && data.polygons.length > 0) {
		chunk.polygons = data.polygons.map(p => [p.primitiveId, p.points, p.closed]);
	}

	if (resolvedFields.includeRectangles && data.rectangles && data.rectangles.length > 0) {
		chunk.rectangles = data.rectangles.map(r => [r.primitiveId, r.x, r.y, r.width, r.height]);
	}

	if (resolvedFields.includePrimitivePins && data.primitivePins && data.primitivePins.length > 0) {
		chunk.primitivePins = data.primitivePins.map(p => [p.primitiveId, p.pinNumber, p.pinName, p.pinType, p.x, p.y]);
	}

	// ---------- v2 standalone top-level fields ----------
	if (resolvedFields.includeDrc && data.drcResult) {
		chunk.drcResult = { ...data.drcResult };
	}

	if (resolvedFields.includeProjectInfo && data.projectInfo) {
		chunk.projectInfo = { ...data.projectInfo };
	}

	return chunk;
}

/**
 * Estimate the serialized JSON size in bytes using UTF-8 encoding
 */
export function estimateJsonSize(chunk: SchReviewChunk): number {
	try {
		const json = JSON.stringify(chunk);
		// Use TextEncoder to compute the UTF-8 byte length
		const encoder = new TextEncoder();
		return encoder.encode(json).length;
	}
	catch {
		return 0;
	}
}
