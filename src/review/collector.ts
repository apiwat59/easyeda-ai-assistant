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
 * 器件采集选项
 */
interface CollectComponentsOptions {
	/** 当前采集页 UUID（逐页采集时填充） */
	schematicPageUuid?: string;
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
 * 1. 所有元素（Component/Wire/Text/Bus）均逐页采集（allSchematicPages=true 会超时）
 * 2. 每页内并行采集所有元素类型
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

		// 逐页采集所有元素（Component/Wire/Text/Bus）
		let components: RawComponent[] = [];
		let wires: Array<{ net: string; lines: number[][] }> = [];
		let texts: RawText[] = [];
		let buses: RawBus[] = [];

		if (pages.length === 1) {
			// 单页场景：无需切换
			const t1 = Date.now();
			[components, wires, texts, buses] = await Promise.all([
				collectComponents({ schematicPageUuid: pages[0].uuid }),
				collectWires(),
				collectTexts({ schematicPageUuid: pages[0].uuid }),
				collectBuses({ schematicPageUuid: pages[0].uuid }),
			]);
			log('info', `[采集] 单页数据采集完成: ${components.length} 器件, ${wires.length} 导线, ${texts.length} 文本, ${buses.length} 总线 (耗时 ${Date.now() - t1}ms)`);
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

					// 并行采集当前页的所有元素
					const [pageComponents, pageWires, pageTexts, pageBuses] = await Promise.all([
						collectComponents({ schematicPageUuid: page.uuid }),
						collectWires(),
						collectTexts({ schematicPageUuid: page.uuid }),
						collectBuses({ schematicPageUuid: page.uuid }),
					]);

					components.push(...pageComponents);
					wires.push(...pageWires);
					texts.push(...pageTexts);
					buses.push(...pageBuses);
					meta.collectedPageUuids.push(page.uuid);
					log('info', `[采集] 图页 ${i + 1}/${pages.length} (${page.name}): ${pageComponents.length} 器件, ${pageWires.length} 导线, ${pageTexts.length} 文本, ${pageBuses.length} 总线 (耗时 ${Date.now() - pageStartTime}ms)`);
				}
				catch (pageError) {
					log('error', `[采集] 采集图页失败 ${i + 1}/${pages.length} (${page.name})`, pageError);
					meta.missingPageUuids.push(page.uuid);
				}
			}
			log('info', `[采集] 逐页采集完成: 总计 ${components.length} 器件, ${wires.length} 导线, ${texts.length} 文本, ${buses.length} 总线 (总耗时 ${Date.now() - t1}ms)`);

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

		// 采集引脚并绑定网络
		const t3 = Date.now();
		const pins = await collectPinsWithNetBinding(components, netlistRaw, wires);
		log('info', `[采集] 引脚采集完成: ${pins.length} 个引脚 (耗时 ${Date.now() - t3}ms)`);

		// 统计网络
		const nets = buildNetStatistics(pins);

		const totalTime = Date.now() - startTime;
		log('success', `[采集] 采集完成: ${components.length} 器件, ${pins.length} 引脚, ${nets.length} 网络 (总耗时 ${totalTime}ms)`);

		return {
			components,
			pins,
			nets,
			texts,
			buses,
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
 * 采集器件（当前页，优化并发性能）
 */
async function collectComponents(
	options: CollectComponentsOptions = {},
): Promise<RawComponent[]> {
	const { schematicPageUuid } = options;

	// 获取当前页的所有器件（allSchematicPages=false，避免超时）
	const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, false);

	// 第一阶段：仅获取 componentType 进行过滤（减少不必要的 API 调用）
	const filterTasks = primitives.map(primitive => async () => ({
		primitive,
		componentType: await primitive.getState_ComponentType(),
	}));

	const filtered = await promiseAllWithLimit(filterTasks, 100);

	// 过滤掉网络标记类器件（NET_FLAG/NET_PORT）
	const validPrimitives = filtered.filter(
		item => item.componentType !== 'netflag' && item.componentType !== 'netport',
	);

	// 第二阶段：仅对有效器件获取详细信息
	const componentTasks = validPrimitives.map(({ primitive }) => async () => {
		// 并行获取所有基本字段
		const [
			primitiveId,
			designator,
			name,
			x,
			y,
			rotation,
		] = await Promise.all([
			primitive.getState_PrimitiveId(),
			primitive.getState_Designator(),
			primitive.getState_Name(),
			primitive.getState_X(),
			primitive.getState_Y(),
			primitive.getState_Rotation(),
		]);

		// 制造商信息可选，失败不影响主流程
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

		return {
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
	});

	return await promiseAllWithLimit(componentTasks, 50);
}

/**
 * 采集网表
 */
async function collectNetlist(): Promise<string | undefined> {
	try {
		// P2: 使用正确的枚举类型ESYS_NetlistType.JLCEDA_PRO
		const netlist = await eda.sch_Netlist.getNetlist(ESYS_NetlistType.JLCEDA_PRO);
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

	// 使用并发控制，限制同时处理100条导线
	const wireTasks = wirePrimitives.map(wire => async () => {
		const [net, line] = await Promise.all([
			wire.getState_Net(),
			wire.getState_Line(),
		]);

		if (net && line) {
			// 规范化line为二维数组
			const lines = Array.isArray(line[0]) ? line as number[][] : [line as number[]];
			return {
				net: net || '',
				lines,
			};
		}
		return null;
	});

	const results = await promiseAllWithLimit(wireTasks, 50);
	// 过滤掉null值
	return results.filter((w): w is { net: string; lines: number[][] } => w !== null);
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
 * 采集引脚并绑定网络（优化并发性能）
 */
async function collectPinsWithNetBinding(
	components: RawComponent[],
	netlistRaw: string | undefined,
	wires: Array<{ net: string; lines: number[][] }>,
): Promise<RawPin[]> {
	// L1: 解析网表构建pin-net映射
	const netlistMap = parseNetlist(netlistRaw);

	// 使用并发控制获取所有器件的引脚
	const componentTasks = components.map(component => async () => ({
		component,
		pinPrimitives: await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(
			component.primitiveId,
		),
	}));

	const pinPrimitivesByComponent = await promiseAllWithLimit(componentTasks, 50); // 提高并发限制

	// 收集所有引脚处理任务
	const allPinTasks: Array<() => Promise<RawPin>> = [];

	for (const { component, pinPrimitives } of pinPrimitivesByComponent) {
		if (!pinPrimitives)
			continue;

		for (const pinPrimitive of pinPrimitives) {
			// 为每个引脚创建一个任务
			allPinTasks.push(async () => {
				const [
					primitiveId,
					pinNumber,
					pinName,
					electricalType,
					x,
					y,
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

				// L2: 如果网表未解析，尝试通过导线坐标匹配
				if (!netName) {
					const wireNet = findNetByWireProximity(x, y, wires);
					if (wireNet) {
						netName = wireNet;
						confidence = 0.8;
						reason = 'wire';
					}
				}

				return {
					primitiveId,
					componentPrimitiveId: component.primitiveId,
					componentDesignator: component.designator,
					pinNumber: pinNumber || '',
					pinName: pinName || '',
					pinType: electricalType || 'Passive',
					netName,
					netBindingConfidence: confidence,
					netBindingReason: reason,
				};
			});
		}
	}

	// 使用并发控制处理所有引脚
	return await promiseAllWithLimit(allPinTasks, 100); // 提高并发限制
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
