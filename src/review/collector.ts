/**
 * AI原理图审查 - 数据采集模块
 *
 * 从EDA API采集器件、引脚、导线、网络标记等数据
 */
import type { CollectedData, CollectionMeta, RawBus, RawComponent, RawNet, RawPin, RawText } from './types';
import { ErrorCode, ReviewError } from './types';

/**
 * 日志发送函数（通过 MessageBus 发送到前端）
 */
let logToIFrame: ((level: string, message: string, data?: any) => void) | null = null;

export function setLogToIFrame(fn: (level: string, message: string, data?: any) => void): void {
	logToIFrame = fn;
}

function log(level: string, message: string, data?: any): void {
	console.warn(`[${level.toUpperCase()}] ${message}`, data || '');
	if (logToIFrame) {
		logToIFrame(level, message, data);
	}
}

/**
 * 文本/总线采集选项
 */
interface CollectTextAndBusOptions {
	/** 当前采集页 UUID（逐页采集时填充） */
	schematicPageUuid?: string;
}

/**
 * 并发控制：限制同时执行的Promise数量
 */
async function promiseAllWithLimit<T>(
	tasks: Array<() => Promise<T>>,
	limit: number,
): Promise<T[]> {
	// 参数守卫
	if (limit < 1) {
		throw new Error('promiseAllWithLimit: limit must be >= 1');
	}
	if (tasks.length === 0) {
		return [];
	}

	const results: T[] = Array.from({ length: tasks.length });
	let index = 0;

	async function worker(): Promise<void> {
		while (index < tasks.length) {
			const currentIndex = index++;
			results[currentIndex] = await tasks[currentIndex]();
		}
	}

	const workers = Array.from(
		{ length: Math.min(limit, tasks.length) },
		() => worker(),
	);
	await Promise.all(workers);
	return results;
}

/**
 * 采集原理图数据（完全逐页采集策略）
 *
 * 性能优化要点：
 * 1. 所有元素（Component/Wire/Text/Bus/Pin/NetLabel）均逐页采集（避免跨页 ID 失效）
 * 2. 每页内先采集 Wire+NetLabel，再采集 Component+Pin（Pin 需要 Wire+NetLabel 数据做网络绑定）
 * 3. 减少每个图元的属性获取次数
 */
export async function collectSchematicData(): Promise<CollectedData> {
	const startTime = Date.now();
	log('info', '[采集] 开始采集原理图数据...');

	// 检查是否有打开的原理图文档
	const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!docInfo || docInfo.documentType !== 1) { // EDMT_EditorDocumentType.SCHEMATIC_PAGE = 1
		throw new ReviewError(
			ErrorCode.COLLECT_NO_DOCUMENT,
			'没有打开的原理图文档',
		);
	}

	const originalTabId = docInfo.tabId;
	const meta: CollectionMeta = {
		mode: 'per-page-hybrid',
		quality: 'full',
		expectedPageCount: 0,
		collectedPageCount: 0,
		collectedPageUuids: [],
		missingPageUuids: [],
	};

	try {
		// 获取当前原理图下的全部图页信息
		const pages = await eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo();
		meta.expectedPageCount = pages.length;
		log('info', `[采集] 检测到 ${pages.length} 个图页`);

		// 先采集网表（全局数据，无需逐页）
		const t0 = Date.now();
		const netlistRaw = await collectNetlist();
		log('info', `[采集] 网表采集完成 (耗时 ${Date.now() - t0}ms)`);

		// 解析网表构建 pin-net 映射（全局）
		const netlistMap = parseNetlist(netlistRaw);

		// 逐页采集所有元素（Component/Wire/Text/Bus/Pin/NetLabel）
		let components: RawComponent[] = [];
		let pins: RawPin[] = [];
		let wires: Array<{ net: string; lines: number[][] }> = [];
		let texts: RawText[] = [];
		let buses: RawBus[] = [];
		let netLabels: RawNetLabel[] = [];

		if (pages.length === 1) {
			// 单页场景：无需切换
			const t1 = Date.now();
			const [pageWires, pageTexts, pageBuses, pageNetLabels] = await Promise.all([
				collectWires(),
				collectTexts({ schematicPageUuid: pages[0].uuid }),
				collectBuses({ schematicPageUuid: pages[0].uuid }),
				collectNetLabels({ schematicPageUuid: pages[0].uuid }),
			]);
			// 采集器件+引脚（需要 Wire+NetLabel 数据）
			const { components: pageComponents, pins: pagePins } = await collectComponentsAndPins({
				schematicPageUuid: pages[0].uuid,
				netlistMap,
				wires: pageWires,
				netLabels: pageNetLabels,
			});

			components = pageComponents;
			pins = pagePins;
			wires = pageWires;
			texts = pageTexts;
			buses = pageBuses;
			netLabels = pageNetLabels;

			log('info', `[采集] 单页数据采集完成: ${components.length} 器件, ${pins.length} 引脚, ${wires.length} 导线, ${texts.length} 文本, ${buses.length} 总线, ${netLabels.length} 网络标记 (耗时 ${Date.now() - t1}ms)`);
			meta.collectedPageUuids = [pages[0].uuid];
			meta.collectedPageCount = 1;
		}
		else {
			// 多页场景：逐页切换采集
			log('info', `[采集] 开始逐页采集所有元素...`);
			const t1 = Date.now();
			for (let i = 0; i < pages.length; i++) {
				const page = pages[i];
				const pageStartTime = Date.now();
				try {
					// 打开并激活页面
					const pageTabId = await eda.dmt_EditorControl.openDocument(page.uuid);
					if (!pageTabId) {
						log('warn', `[采集] 无法打开图页 ${i + 1}/${pages.length}: ${page.name}`);
						meta.missingPageUuids.push(page.uuid);
						continue;
					}

					await eda.dmt_EditorControl.activateDocument(pageTabId);

					// 先采集 Wire/Text/Bus/NetLabel
					const [pageWires, pageTexts, pageBuses, pageNetLabels] = await Promise.all([
						collectWires(),
						collectTexts({ schematicPageUuid: page.uuid }),
						collectBuses({ schematicPageUuid: page.uuid }),
						collectNetLabels({ schematicPageUuid: page.uuid }),
					]);

					// 再采集器件+引脚（需要 Wire+NetLabel 数据做网络绑定）
					const { components: pageComponents, pins: pagePins } = await collectComponentsAndPins({
						schematicPageUuid: page.uuid,
						netlistMap,
						wires: pageWires,
						netLabels: pageNetLabels,
					});

					components.push(...pageComponents);
					pins.push(...pagePins);
					wires.push(...pageWires);
					texts.push(...pageTexts);
					buses.push(...pageBuses);
					netLabels.push(...pageNetLabels);
					meta.collectedPageUuids.push(page.uuid);
					log('info', `[采集] 图页 ${i + 1}/${pages.length} (${page.name}): ${pageComponents.length} 器件, ${pagePins.length} 引脚, ${pageWires.length} 导线, ${pageTexts.length} 文本, ${pageBuses.length} 总线, ${pageNetLabels.length} 网络标记 (耗时 ${Date.now() - pageStartTime}ms)`);
				}
				catch (pageError) {
					log('error', `[采集] 采集图页失败 ${i + 1}/${pages.length} (${page.name})`, pageError);
					meta.missingPageUuids.push(page.uuid);
				}
			}
			log('info', `[采集] 逐页采集完成: 总计 ${components.length} 器件, ${pins.length} 引脚, ${wires.length} 导线, ${texts.length} 文本, ${buses.length} 总线, ${netLabels.length} 网络标记 (总耗时 ${Date.now() - t1}ms)`);

			meta.collectedPageCount = meta.collectedPageUuids.length;
			if (meta.missingPageUuids.length > 0) {
				meta.quality = 'partial';
			}
		}

		// 检查数据完整性
		if (components.length === 0 && wires.length === 0) {
			meta.quality = 'stale';
		}

		// 恢复用户原始焦点页
		try {
			await eda.dmt_EditorControl.activateDocument(originalTabId);
		}
		catch (restoreError) {
			console.warn('[采集] 恢复原始文档焦点失败:', restoreError);
		}

		// 统计网络
		const nets = buildNetStatistics(pins);

		const totalTime = Date.now() - startTime;
		log('success', `[采集] 采集完成: ${components.length} 器件, ${pins.length} 引脚, ${nets.length} 网络, ${netLabels.length} 网络标记 (总耗时 ${totalTime}ms)`);

		return {
			components,
			pins,
			nets,
			texts,
			buses,
			netLabels,
			netlistRaw,
			timestamp: Date.now(),
			meta,
		};
	}
	catch (error) {
		// 确保恢复原始焦点页
		try {
			await eda.dmt_EditorControl.activateDocument(originalTabId);
		}
		catch {
			// ignore
		}

		console.error('[采集] 采集失败:', error);
		throw new ReviewError(
			ErrorCode.COLLECT_API_FAILED,
			`数据采集失败: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}

/**
 * 采集当前页的器件及其引脚（统一采集，避免跨页 ID 失效）
 *
 * 在同一个页面上下文中完成：
 * 1. 获取器件列表 → 分离 netflag/netport 和普通器件
 * 2. 获取普通器件的详细信息和引脚
 * 3. 绑定网络（网表优先，导线坐标次之，网络标记坐标兜底）
 */
async function collectComponentsAndPins(options: {
	schematicPageUuid?: string;
	netlistMap: Map<string, string>;
	wires: Array<{ net: string; lines: number[][] }>;
	netLabels: RawNetLabel[];
}): Promise<{ components: RawComponent[]; pins: RawPin[] }> {
	const { schematicPageUuid, netlistMap, wires, netLabels } = options;

	// 获取当前页的所有器件（allSchematicPages=false）
	const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, false);

	// 第一阶段：仅获取 componentType 进行分类
	const filterTasks = primitives.map(primitive => async () => ({
		primitive,
		componentType: await primitive.getState_ComponentType(),
	}));
	const filtered = await promiseAllWithLimit(filterTasks, 100);

	// 过滤掉网络标记类器件（NET_FLAG/NET_PORT）— 它们已在 collectNetLabels() 中单独采集
	const validPrimitives = filtered.filter(
		item => item.componentType !== 'netflag' && item.componentType !== 'netport',
	);

	// 第二阶段：获取器件详细信息 + 引脚
	const allComponents: RawComponent[] = [];
	const allPins: RawPin[] = [];

	const componentTasks = validPrimitives.map(({ primitive }) => async () => {
		// 并行获取器件基本信息 + 引脚列表
		const [
			primitiveId,
			designator,
			name,
			x,
			y,
			rotation,
			pinPrimitives,
		] = await Promise.all([
			primitive.getState_PrimitiveId(),
			primitive.getState_Designator(),
			primitive.getState_Name(),
			primitive.getState_X(),
			primitive.getState_Y(),
			primitive.getState_Rotation(),
			eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(
				await primitive.getState_PrimitiveId(),
			),
		]);

		// 制造商信息可选
		let manufacturer = '';
		let manufacturerPartNumber = '';
		try {
			const [mfr, mpn] = await Promise.all([
				primitive.getState_Manufacturer(),
				primitive.getState_ManufacturerId(),
			]);
			manufacturer = mfr || '';
			manufacturerPartNumber = mpn || '';
		}
		catch {
			// 某些器件可能没有这些属性
		}

		const component: RawComponent = {
			primitiveId,
			designator: designator || '',
			name: name || '',
			manufacturer,
			manufacturerPartNumber,
			x,
			y,
			rotation: rotation || 0,
			schematicPageUuid,
		};

		// 采集该器件的引脚
		const componentPins: RawPin[] = [];
		if (pinPrimitives && pinPrimitives.length > 0) {
			const pinTasks = pinPrimitives.map(pinPrimitive => async () => {
				const [
					pinPrimitiveId,
					pinNumber,
					pinName,
					electricalType,
					pinX,
					pinY,
				] = await Promise.all([
					pinPrimitive.getState_PrimitiveId(),
					pinPrimitive.getState_PinNumber(),
					pinPrimitive.getState_PinName(),
					pinPrimitive.getState_pinType(),
					pinPrimitive.getState_X(),
					pinPrimitive.getState_Y(),
				]);

				const pinKey = `${component.designator}_${pinNumber}`;

				// L1: 优先使用网表映射
				let netName: string | null = netlistMap.get(pinKey) || null;
				let confidence = netName ? 1.0 : 0;
				let reason = netName ? 'netlist' : 'unresolved';
				const debugInfo: any = {
					pin: pinKey,
					coord: `(${pinX}, ${pinY})`,
					L1_netlist: netName || 'miss',
				};

				// L2: 如果网表未解析，尝试通过导线坐标匹配
				if (!netName) {
					const wireNet = findNetByWireProximity(pinX, pinY, wires);
					debugInfo.L2_wire = wireNet || 'miss';
					if (wireNet) {
						netName = wireNet;
						confidence = 0.8;
						reason = 'wire';
					}
				}

				// L3: 如果导线也没匹配到，尝试通过网络标记坐标匹配（新增）
				if (!netName) {
					const labelNet = findNetByLabelProximity(pinX, pinY, netLabels);
					debugInfo.L3_netlabel = labelNet || 'miss';
					if (labelNet) {
						netName = labelNet;
						confidence = 0.7;
						reason = 'netlabel';
					}
				}

				// 输出未绑定引脚的调试信息
				if (!netName && (electricalType === 'Power' || electricalType === 'Ground')) {
					log('warn', `[Pin-Net] 电源/地引脚未绑定`, debugInfo);
				}
				else if (!netName) {
					log('debug', `[Pin-Net] 引脚未绑定`, debugInfo);
				}

				return {
					primitiveId: pinPrimitiveId,
					componentPrimitiveId: component.primitiveId,
					componentDesignator: component.designator,
					pinNumber: pinNumber || '',
					pinName: pinName || '',
					pinType: electricalType || 'Passive',
					netName,
					netBindingConfidence: confidence,
					netBindingReason: reason,
				} as RawPin;
			});

			const pinResults = await promiseAllWithLimit(pinTasks, 50);
			componentPins.push(...pinResults);
		}

		return { component, pins: componentPins };
	});

	const results = await promiseAllWithLimit(componentTasks, 30);
	for (const result of results) {
		allComponents.push(result.component);
		allPins.push(...result.pins);
	}

	return { components: allComponents, pins: allPins };
}

/**
 * 采集网表（带超时保护，避免阻塞整体采集流程）
 */
async function collectNetlist(): Promise<string | undefined> {
	try {
		const NETLIST_TIMEOUT_MS = 10000; // 10秒超时

		const result = await Promise.race([
			eda.sch_Netlist.getNetlist(ESYS_NetlistType.JLCEDA_PRO),
			new Promise<undefined>((resolve) => {
				setTimeout(() => resolve(undefined), NETLIST_TIMEOUT_MS);
			}),
		]);

		if (result === undefined) {
			log('warn', `[采集] 网表获取超时 (${NETLIST_TIMEOUT_MS}ms)，跳过网表绑定`);
		}

		return result;
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

	// 使用并发控制，限制同时处理100条导线
	let emptyNetCount = 0;

	const wireTasks = wirePrimitives.map(wire => async () => {
		const [net, line] = await Promise.all([
			wire.getState_Net(),
			wire.getState_Line(),
		]);

		if (!net || !line) {
			if (!net) {
				emptyNetCount++;
			}
			return null;
		}
		// 规范化line为二维数组
		const lines = Array.isArray(line[0]) ? line as number[][] : [line as number[]];
		return {
			net: net || '',
			lines,
		};
	});

	const results = await promiseAllWithLimit(wireTasks, 50);
	const validWires = results.filter((w): w is { net: string; lines: number[][] } => w !== null);

	// 输出导线采集统计
	log('info', `[采集] 导线统计: 总数=${wirePrimitives.length}, 有效=${validWires.length}, net为空=${emptyNetCount}`);

	return validWires;
}

/**
 * 采集文本标注
 * 失败时降级为空数组，不阻塞主流程
 */
async function collectTexts(
	options: CollectTextAndBusOptions = {},
): Promise<RawText[]> {
	const { schematicPageUuid } = options;

	try {
		const textPrimitives = await eda.sch_PrimitiveText.getAll();

		const textTasks = textPrimitives.map(textPrimitive => async () => {
			try {
				const [primitiveId, content, x, y] = await Promise.all([
					textPrimitive.getState_PrimitiveId(),
					textPrimitive.getState_Content(),
					textPrimitive.getState_X(),
					textPrimitive.getState_Y(),
				]);

				return {
					primitiveId,
					content: content || '',
					x,
					y,
					schematicPageUuid,
				} as RawText;
			}
			catch (textError) {
				console.warn('采集单个文本图元失败:', textError);
				return null;
			}
		});

		const results = await promiseAllWithLimit(textTasks, 50);
		return results.filter((item): item is RawText => item !== null);
	}
	catch (error) {
		console.warn('采集文本标注失败，已降级为空数组:', error);
		return [];
	}
}

/**
 * 采集总线
 * 失败时降级为空数组，不阻塞主流程
 */
async function collectBuses(
	options: CollectTextAndBusOptions = {},
): Promise<RawBus[]> {
	const { schematicPageUuid } = options;

	try {
		const busPrimitives = await eda.sch_PrimitiveBus.getAll();

		const busTasks = busPrimitives.map(busPrimitive => async () => {
			try {
				const [primitiveId, busName, line] = await Promise.all([
					busPrimitive.getState_PrimitiveId(),
					busPrimitive.getState_BusName(),
					busPrimitive.getState_Line(),
				]);

				if (!line) {
					return null;
				}

				// 规范化 line 为二维数组
				const lines = Array.isArray(line[0])
					? line as number[][]
					: [line as number[]];

				return {
					primitiveId,
					busName: busName || '',
					lines,
					schematicPageUuid,
				} as RawBus;
			}
			catch (busError) {
				console.warn('采集单个总线图元失败:', busError);
				return null;
			}
		});

		const results = await promiseAllWithLimit(busTasks, 50);
		return results.filter((item): item is RawBus => item !== null);
	}
	catch (error) {
		console.warn('采集总线失败，已降级为空数组:', error);
		return [];
	}
}

/**
 * 采集网络标记（GND、VCC 等标签）
 * 失败时降级为空数组，不阻塞主流程
 */
async function collectNetLabels(
	options: CollectTextAndBusOptions = {},
): Promise<RawNetLabel[]> {
	const { schematicPageUuid } = options;

	try {
		// 获取当前页的所有器件
		const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, false);

		// 第一阶段：仅获取 componentType 进行过滤
		const filterTasks = primitives.map(primitive => async () => ({
			primitive,
			componentType: await primitive.getState_ComponentType(),
		}));
		const filtered = await promiseAllWithLimit(filterTasks, 100);

		// 只保留网络标记类器件（NET_FLAG/NET_PORT）
		const netLabelPrimitives = filtered.filter(
			item => item.componentType === 'netflag' || item.componentType === 'netport',
		);

		// 第二阶段：获取网络标记的详细信息
		const netLabelTasks = netLabelPrimitives.map(({ primitive, componentType }) => async () => {
			try {
				const [primitiveId, designator, x, y] = await Promise.all([
					primitive.getState_PrimitiveId(),
					primitive.getState_Designator(),
					primitive.getState_X(),
					primitive.getState_Y(),
				]);

				// 网络标记的 designator 就是网络名称（如 "GND", "VCC_3V3"）
				return {
					primitiveId,
					netName: designator || '',
					x,
					y,
					type: componentType as 'netflag' | 'netport',
					schematicPageUuid,
				} as RawNetLabel;
			}
			catch (labelError) {
				console.warn('采集单个网络标记失败:', labelError);
				return null;
			}
		});

		const results = await promiseAllWithLimit(netLabelTasks, 50);
		return results.filter((item): item is RawNetLabel => item !== null);
	}
	catch (error) {
		console.warn('采集网络标记失败，已降级为空数组:', error);
		return [];
	}
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
 * 通过网络标记坐标邻近性查找网络
 * 用于 pin-net 绑定的第三层策略（L3）
 */
function findNetByLabelProximity(
	pinX: number,
	pinY: number,
	netLabels: RawNetLabel[],
): string | null {
	const TOLERANCE = 50; // 更宽松的容差（网络标记可能与引脚有一定距离）
	let bestNet: string | null = null;
	let bestDistance = TOLERANCE;

	for (const label of netLabels) {
		if (!label.netName)
			continue;

		const distance = Math.sqrt((pinX - label.x) ** 2 + (pinY - label.y) ** 2);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestNet = label.netName;
		}
	}

	return bestNet;
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
