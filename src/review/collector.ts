/**
 * AI原理图审查 - 数据采集模块
 *
 * 从EDA API采集器件、引脚、导线、网络标记等数据
 */
import type { CollectedData, CollectionMeta, RawBus, RawComponent, RawNet, RawPin, RawText } from './types';
import { ErrorCode, ReviewError } from './types';

/**
 * 器件采集选项
 */
interface CollectComponentsOptions {
	/** 是否使用 API 的 allSchematicPages 参数（仅降级时使用） */
	allSchematicPages?: boolean;
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
 * 采集原理图数据（支持多子图纸逐页采集）
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

	const originalTabId = docInfo.tabId;
	const meta: CollectionMeta = {
		mode: 'per-page',
		quality: 'full',
		expectedPageCount: 0,
		collectedPageCount: 0,
		collectedPageUuids: [],
		missingPageUuids: [],
	};

	try {
		// 网表可跨页使用，优先独立采集
		const netlistRaw = await collectNetlist();

		let components: RawComponent[] = [];
		let wires: Array<{ net: string; lines: number[][] }> = [];
		let texts: RawText[] = [];
		let buses: RawBus[] = [];

		try {
			// 获取当前原理图下的全部图页
			const pages = await eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo();
			meta.expectedPageCount = pages.length;

			// 单页场景：直接按当前页采集，避免不必要切页
			if (pages.length <= 1) {
				const currentPageUuid = docInfo.uuid;
				const [singlePageComponents, singlePageWires, singlePageTexts, singlePageBuses] = await Promise.all([
					collectComponents({
						allSchematicPages: false,
						schematicPageUuid: currentPageUuid,
					}),
					collectWires(),
					collectTexts({ schematicPageUuid: currentPageUuid }),
					collectBuses({ schematicPageUuid: currentPageUuid }),
				]);

				components = singlePageComponents;
				wires = singlePageWires;
				texts = singlePageTexts;
				buses = singlePageBuses;
				if (currentPageUuid) {
					meta.collectedPageUuids.push(currentPageUuid);
				}
				meta.collectedPageCount = meta.collectedPageUuids.length;
			}
			else {
				// 多页场景：逐页打开并激活后采集
				for (const page of pages) {
					try {
						const pageTabId = await eda.dmt_EditorControl.openDocument(page.uuid);
						if (!pageTabId) {
							console.warn(`无法打开图页: ${page.name} (${page.uuid})`);
							meta.missingPageUuids.push(page.uuid);
							continue;
						}

						const activated = await eda.dmt_EditorControl.activateDocument(pageTabId);
						if (!activated) {
							console.warn(`无法激活图页: ${page.name} (${page.uuid})`);
							meta.missingPageUuids.push(page.uuid);
							continue;
						}

						const [pageComponents, pageWires, pageTexts, pageBuses] = await Promise.all([
							collectComponents({
								allSchematicPages: false,
								schematicPageUuid: page.uuid,
							}),
							collectWires(),
							collectTexts({ schematicPageUuid: page.uuid }),
							collectBuses({ schematicPageUuid: page.uuid }),
						]);

						components.push(...pageComponents);
						wires.push(...pageWires);
						texts.push(...pageTexts);
						buses.push(...pageBuses);
						meta.collectedPageUuids.push(page.uuid);
					}
					catch (pageError) {
						console.warn(`逐页采集失败，图页: ${page.name} (${page.uuid})`, pageError);
						meta.missingPageUuids.push(page.uuid);
					}
				}

				meta.collectedPageCount = meta.collectedPageUuids.length;
				if (meta.collectedPageCount === pages.length) {
					meta.quality = 'full';
				}
				else if (meta.collectedPageCount > 0) {
					meta.quality = 'partial';
				}
				else {
					// 触发降级：逐页路径完全不可用
					throw new Error('逐页采集未成功获取任何图页数据');
				}
			}
		}
		catch (perPageError) {
			// 降级策略：逐页采集失败后回退到 allSchematicPages=true
			console.warn('逐页采集失败，回退到 getAll(undefined, true):', perPageError);
			meta.mode = 'api-all-pages-fallback';
			meta.quality = 'partial';
			meta.errorMessage = perPageError instanceof Error ? perPageError.message : String(perPageError);

			const [fallbackComponents, fallbackWires, fallbackTexts, fallbackBuses] = await Promise.all([
				collectComponents({ allSchematicPages: true }),
				collectWires(),
				collectTexts(),
				collectBuses(),
			]);
			components = fallbackComponents;
			wires = fallbackWires;
			texts = fallbackTexts;
			buses = fallbackBuses;
		}
		finally {
			// 无论成功/失败，确保恢复用户原始焦点页
			try {
				await eda.dmt_EditorControl.activateDocument(originalTabId);
			}
			catch (restoreError) {
				console.warn('恢复原始文档焦点失败:', restoreError);
			}
		}

		// 采集引脚并绑定网络
		const pins = await collectPinsWithNetBinding(components, netlistRaw, wires);

		// 统计网络
		const nets = buildNetStatistics(pins);

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
		throw new ReviewError(
			ErrorCode.COLLECT_API_FAILED,
			`数据采集失败: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}

/**
 * 采集器件（支持逐页和降级两种模式）
 */
async function collectComponents(
	options: CollectComponentsOptions = {},
): Promise<RawComponent[]> {
	const { allSchematicPages = false, schematicPageUuid } = options;

	const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, allSchematicPages);

	// 第一阶段：仅获取 componentType 进行过滤（减少不必要的 API 调用）
	const filterTasks = primitives.map(primitive => async () => ({
		primitive,
		componentType: await primitive.getState_ComponentType(),
	}));

	const filtered = await promiseAllWithLimit(filterTasks, 50);

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

		// 并行获取制造商信息（可能不存在）
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

	const results = await promiseAllWithLimit(componentTasks, 20);
	return results;
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
 * 采集引脚并绑定网络（4级策略）
 */
async function collectPinsWithNetBinding(
	components: RawComponent[],
	netlistRaw: string | undefined,
	wires: Array<{ net: string; lines: number[][] }>,
): Promise<RawPin[]> {
	// L1: 解析网表构建pin-net映射
	const netlistMap = parseNetlist(netlistRaw);

	// 使用并发控制获取所有器件的引脚，限制同时处理30个器件
	// 使用并发控制获取所有器件的引脚，限制同时处理20个器件
	const componentTasks = components.map(component => async () => ({
		component,
		pinPrimitives: await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(
			component.primitiveId,
		),
	}));

	const pinPrimitivesByComponent = await promiseAllWithLimit(componentTasks, 20);

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

	// 使用并发控制处理所有引脚，限制同时处理30个引脚
	return await promiseAllWithLimit(allPinTasks, 30);
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
