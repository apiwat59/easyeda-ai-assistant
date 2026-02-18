/**
 * AI原理图审查 - 数据采集模块
 *
 * 从EDA API采集器件、引脚、导线、网络标记等数据
 */
import type { CollectedData, RawComponent, RawNet, RawPin } from './types';
import { ErrorCode, ReviewError } from './types';

/**
 * 采集原理图数据
 */
export async function collectSchematicData(): Promise<CollectedData> {
	// 检查是否有打开的原理图文档
	const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!docInfo || docInfo.documentType !== 1) { // EDMT_EditorDocumentType.SCHEMATIC_PAGE = 1
		throw new ReviewError(
			ErrorCode.COLLECT_NO_DOCUMENT,
			'没有打开的原理图文档',
		);
	}

	try {
		// 并行采集基础数据
		const [components, netlistRaw, wires] = await Promise.all([
			collectComponents(),
			collectNetlist(),
			collectWires(),
		]);

		// 采集引脚并绑定网络
		const pins = await collectPinsWithNetBinding(components, netlistRaw, wires);

		// 统计网络
		const nets = buildNetStatistics(pins);

		return {
			components,
			pins,
			nets,
			netlistRaw,
			timestamp: Date.now(),
		};
	}
	catch (error) {
		throw new ReviewError(
			ErrorCode.COLLECT_API_FAILED,
			`数据采集失败: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}

/**
 * 采集所有器件
 */
async function collectComponents(): Promise<RawComponent[]> {
	const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, true);
	const components: RawComponent[] = [];

	for (const primitive of primitives) {
		// 使用getState_*系列API
		const componentType = await primitive.getState_ComponentType();

		// 过滤掉网络标记类器件（NET_FLAG/NET_PORT）
		if (componentType === 'netflag' || componentType === 'netport') {
			continue;
		}

		const primitiveId = await primitive.getState_PrimitiveId();
		const designator = await primitive.getState_Designator();
		const name = await primitive.getState_Name();
		const x = await primitive.getState_X();
		const y = await primitive.getState_Y();
		const rotation = await primitive.getState_Rotation();

		// 获取制造商信息（可能不存在）
		let manufacturer = '';
		let manufacturerPartNumber = '';
		try {
			const mfr = await primitive.getState_Manufacturer();
			// P2: 正确的API是getState_ManufacturerId，非getState_ManufacturerPartNumber
			const mpn = await primitive.getState_ManufacturerId();
			manufacturer = mfr || '';
			manufacturerPartNumber = mpn || '';
		}
		catch {
			// 某些器件可能没有这些属性
		}

		components.push({
			primitiveId,
			designator: designator || '',
			name: name || '',
			manufacturer,
			manufacturerPartNumber,
			x,
			y,
			rotation: rotation || 0,
			schematicPageUuid: undefined, // 需要从其他API获取
		});
	}

	return components;
}

/**
 * 采集网表
 */
async function collectNetlist(): Promise<string | undefined> {
	try {
		// P2: 使用正确的枚举类型，避免 as any 绕过类型系统
		// ESYS_NetlistType.JLCEDA_PRO 的值为 "JLCEDA"
		const netlist = await eda.sch_Netlist.getNetlist('JLCEDA');
		return netlist;
	}
	catch {
		return undefined;
	}
}

/**
 * 采集导线
 */
async function collectWires(): Promise<Array<{ net: string; lines: number[][] }>> {
	const wirePrimitives = await eda.sch_PrimitiveWire.getAll();
	const wires: Array<{ net: string; lines: number[][] }> = [];

	for (const wire of wirePrimitives) {
		// getState_Net返回string，getState_Line返回Array<number> | Array<Array<number>>
		const net = await wire.getState_Net();
		const line = await wire.getState_Line();

		if (net && line) {
			// 规范化line为二维数组
			const lines = Array.isArray(line[0]) ? line as number[][] : [line as number[]];
			wires.push({
				net: net || '',
				lines,
			});
		}
	}

	return wires;
}

/**
 * 采集引脚并绑定网络（4级策略）
 */
async function collectPinsWithNetBinding(
	components: RawComponent[],
	netlistRaw: string | undefined,
	wires: Array<{ net: string; lines: number[][] }>,
): Promise<RawPin[]> {
	const pins: RawPin[] = [];

	// L1: 解析网表构建pin-net映射
	const netlistMap = parseNetlist(netlistRaw);

	for (const component of components) {
		const pinPrimitives = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(
			component.primitiveId,
		);

		if (!pinPrimitives)
			continue;

		for (const pinPrimitive of pinPrimitives) {
			// 使用getState_*系列API
			const primitiveId = await pinPrimitive.getState_PrimitiveId();
			const pinNumber = pinPrimitive.getState_PinNumber();
			const pinName = pinPrimitive.getState_PinName();
			const electricalType = pinPrimitive.getState_pinType();
			const x = await pinPrimitive.getState_X();
			const y = await pinPrimitive.getState_Y();

			const pinKey = `${component.designator}_${pinNumber}`;

			// L1: 优先使用网表映射
			let netName: string | null = netlistMap.get(pinKey) || null;
			let confidence = netName ? 1.0 : 0;
			let reason = netName ? 'netlist' : 'unresolved';

			// L2: 如果网表未解析，尝试通过导线坐标匹配
			if (!netName) {
				const wireNet = findNetByWireProximity(x, y, wires);
				if (wireNet) {
					netName = wireNet;
					confidence = 0.8;
					reason = 'wire';
				}
			}

			pins.push({
				primitiveId,
				componentPrimitiveId: component.primitiveId,
				componentDesignator: component.designator,
				pinNumber: pinNumber || '',
				pinName: pinName || '',
				pinType: electricalType || 'Passive',
				netName,
				netBindingConfidence: confidence,
				netBindingReason: reason,
			});
		}
	}

	return pins;
}

/**
 * 解析网表字符串（简化版，仅支持JLCEDA_PRO格式）
 */
function parseNetlist(netlistRaw: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!netlistRaw)
		return map;

	try {
		// JLCEDA_PRO格式示例：
		// NET: VCC_3V3
		//   U1-1
		//   C1-1
		const lines = netlistRaw.split('\n');
		let currentNet = '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith('NET:')) {
				currentNet = trimmed.substring(4).trim();
			}
			else if (currentNet && trimmed.includes('-')) {
				const [designator, pinNumber] = trimmed.split('-');
				if (designator && pinNumber) {
					map.set(`${designator.trim()}_${pinNumber.trim()}`, currentNet);
				}
			}
		}
	}
	catch {
		// 解析失败，返回空映射
	}

	return map;
}

/**
 * 通过导线坐标邻近性查找网络
 */
function findNetByWireProximity(
	pinX: number,
	pinY: number,
	wires: Array<{ net: string; lines: number[][] }>,
): string | null {
	const TOLERANCE = 10; // 0.1 inch (10 * 0.01inch)

	for (const wire of wires) {
		if (!wire.net)
			continue;

		for (const line of wire.lines) {
			// line格式: [x1, y1, x2, y2, ...]
			for (let i = 0; i < line.length; i += 2) {
				const wx = line[i];
				const wy = line[i + 1];
				if (wx === undefined || wy === undefined)
					continue;

				const distance = Math.sqrt((pinX - wx) ** 2 + (pinY - wy) ** 2);
				if (distance < TOLERANCE) {
					return wire.net;
				}
			}
		}
	}

	return null;
}

/**
 * 构建网络统计
 */
function buildNetStatistics(pins: RawPin[]): RawNet[] {
	const netMap = new Map<string, Set<string>>();

	for (const pin of pins) {
		if (!pin.netName)
			continue;

		if (!netMap.has(pin.netName)) {
			netMap.set(pin.netName, new Set());
		}
		netMap.get(pin.netName)!.add(pin.primitiveId);
	}

	return Array.from(netMap.entries()).map(([netName, pinSet]) => ({
		netName,
		pinCount: pinSet.size,
		pins: Array.from(pinSet),
	}));
}
