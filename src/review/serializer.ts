/**
 * AI原理图审查 - 数据序列化模块
 *
 * 将CollectedData转换为SCH-REVIEW-COMPACT v1 tuple格式
 * 支持根据 SchematicFieldsConfig 动态选择字段，并在 chunk 中嵌入 fields 元数据
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
 * 归一化字段配置，未设置的项使用默认值
 */
function resolveSchematicFields(fields?: SchematicFieldsConfig): Required<SchematicFieldsConfig> {
	return { ...DEFAULT_SCHEMATIC_FIELDS, ...(fields || {}) };
}

/**
 * 序列化为紧凑格式
 *
 * @param data         采集的原始数据
 * @param chunkId      当前块ID
 * @param chunkCount   总块数
 * @param fields       字段选择配置（未传时使用所有默认字段）
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
			'数据格式无效',
		);
	}

	const resolvedFields = resolveSchematicFields(fields);

	// 判断是否存在 v2 扩展数据，决定 schema 版本
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

	// ---------- 构建器件字段顺序（designator 为核心字段，强制保留）----------
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

	// ---------- 构建引脚字段顺序（componentDesignator / pinNumber / netName 为核心字段，强制保留）----------
	const pinFields: SchPinFieldKey[] = ['componentDesignator', 'pinNumber'];
	if (resolvedFields.pinPinName)
		pinFields.push('pinName');
	if (resolvedFields.pinPinType)
		pinFields.push('pinType');
	pinFields.push('netName'); // 核心字段，强制放在末尾

	// ---------- 构建网络字段顺序（netName 为核心字段，强制保留）----------
	const netFields: SchNetFieldKey[] = ['netName'];
	if (resolvedFields.netPinCount)
		netFields.push('pinCount');

	// ---------- 字段取值器（避免 switch 链，提升可读性）----------
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

	// ---------- 序列化三类数据 ----------
	const components = data.components.map(c =>
		componentFields.map(field => componentFieldGetters[field](c)),
	);

	const pins = data.pins.map(p =>
		pinFields.map(field => pinFieldGetters[field](p)),
	);

	const nets = data.nets.map(n =>
		netFields.map(field => netFieldGetters[field](n)),
	);

	// ---------- 组装 chunk ----------
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

	// ---------- 可选扩展数据（仅当对应字段启用且源数据存在时附加）----------
	if (resolvedFields.includeTexts && data.texts && data.texts.length > 0) {
		chunk.texts = data.texts.map(t => [t.primitiveId, t.content, t.x, t.y]);
	}

	if (resolvedFields.includeBuses && data.buses && data.buses.length > 0) {
		chunk.buses = data.buses.map(b => [b.primitiveId, b.busName, b.lines]);
	}

	if (resolvedFields.includeNetLabels && data.netLabels && data.netLabels.length > 0) {
		chunk.netLabels = data.netLabels.map(l => [l.primitiveId, l.netName, l.x, l.y, l.type]);
	}

	// ---------- v2 图形图元 tuple 数据 ----------
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

	// ---------- v2 独立顶层字段 ----------
	if (resolvedFields.includeDrc && data.drcResult) {
		chunk.drcResult = { ...data.drcResult };
	}

	if (resolvedFields.includeProjectInfo && data.projectInfo) {
		chunk.projectInfo = { ...data.projectInfo };
	}

	return chunk;
}

/**
 * 估算序列化后的JSON字节大小（UTF-8编码）
 */
export function estimateJsonSize(chunk: SchReviewChunk): number {
	try {
		const json = JSON.stringify(chunk);
		// 使用TextEncoder计算UTF-8字节数
		const encoder = new TextEncoder();
		return encoder.encode(json).length;
	}
	catch {
		return 0;
	}
}
