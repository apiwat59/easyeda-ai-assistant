/**
 * AI Schematic Review - Data Collection Module
 *
 * Collect components, pins, wires, net labels, and other data from the EDA API
 */
import type {
	CollectedData,
	CollectionMeta,
	RawArc,
	RawBus,
	RawCircle,
	RawComponent,
	RawDrcResult,
	RawNet,
	RawNetLabel,
	RawPin,
	RawPolygon,
	RawPrimitivePin,
	RawProjectInfo,
	RawRectangle,
	RawText,
} from './types';
import { ErrorCode, ReviewError } from './types';

/**
 * Log dispatch function (sends to the frontend via MessageBus)
 */
let logToIFrame: ((level: string, message: string, data?: any) => void) | null = null;

/**
 * Debug log switch (disabled by default)
 */
const ENABLE_VERBOSE_DEBUG_LOGS = false;

export function setLogToIFrame(fn: (level: string, message: string, data?: any) => void): void {
	logToIFrame = fn;
}

function log(level: string, message: string, data?: any): void {
	// debug-level logs are gated by the switch
	if (level === 'debug' && !ENABLE_VERBOSE_DEBUG_LOGS) {
		return;
	}

	// Send to the frontend debug panel
	if (logToIFrame) {
		logToIFrame(level, message, data);
	}

	// Only warn/error are printed to the console
	if (level === 'warn') {
		console.warn(`[${level.toUpperCase()}] ${message}`, data || '');
	}
	else if (level === 'error') {
		console.error(`[${level.toUpperCase()}] ${message}`, data || '');
	}
}

/**
 * Text/Bus collection options
 */
interface CollectTextAndBusOptions {
	/** Current collection page UUID (filled during per-page collection) */
	schematicPageUuid?: string;
}

/**
 * Concurrency control: limit the number of Promises running at once
 */
async function promiseAllWithLimit<T>(
	tasks: Array<() => Promise<T>>,
	limit: number,
): Promise<T[]> {
	// Parameter guard
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
 * Collect schematic data (fully per-page collection strategy)
 *
 * Performance optimization notes:
 * 1. All elements (Component/Wire/Text/Bus/Pin/NetLabel) are collected per page (avoids cross-page ID invalidation)
 * 2. Within each page, collect Wire+NetLabel first, then Component+Pin (Pin needs Wire+NetLabel data for net binding)
 * 3. Reduce the number of property fetches for each primitive
 */
export async function collectSchematicData(): Promise<CollectedData> {
	const startTime = Date.now();
	log('info', '[Collect] Start collecting schematic data...');

	// Check whether a schematic document is open
	const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!docInfo || docInfo.documentType !== 1) { // EDMT_EditorDocumentType.SCHEMATIC_PAGE = 1
		log('warn', '[Collect] The current document is not a schematic, abort collection', {
			documentType: docInfo?.documentType,
		});
		throw new ReviewError(
			ErrorCode.COLLECT_NO_DOCUMENT,
			'No schematic document is open',
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
		// Fetch all page information under the current schematic
		const pages = await eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo();
		meta.expectedPageCount = pages.length;
		log('info', `[Collect] Detected ${pages.length} pages`);

		// Collect global data first (no need for per-page switching, unrelated to page switching)
		const t0 = Date.now();
		const [netlistRaw, drcResult, projectInfo] = await Promise.all([
			collectNetlist(),
			collectDrcResult(),
			collectProjectInfo(),
		]);
		log('info', `[Collect] Global data collection complete (took ${Date.now() - t0}ms)`, {
			hasNetlist: !!netlistRaw,
			drcPassed: drcResult?.passed,
			projectName: projectInfo?.projectName,
		});

		// Parse the netlist to build the pin-net map (global)
		const netlistMap = parseNetlist(netlistRaw);

		// Collect all elements per page (Component/Wire/Text/Bus/Pin/NetLabel)
		let components: RawComponent[] = [];
		let pins: RawPin[] = [];
		let allValidWires: Array<{ net: string; lines: number[][] }> = [];
		let allEmptyWires: Array<{ lines: number[][] }> = [];
		let texts: RawText[] = [];
		let buses: RawBus[] = [];
		let netLabels: RawNetLabel[] = [];
		let arcs: RawArc[] = [];
		let circles: RawCircle[] = [];
		let polygons: RawPolygon[] = [];
		let rectangles: RawRectangle[] = [];
		let primitivePins: RawPrimitivePin[] = [];

		if (pages.length === 1) {
			// Single-page scenario: no switching required
			const t1 = Date.now();
			const [wireData, pageTexts, pageBuses, pageNetLabels, pageArcs, pageCircles, pagePolygons, pageRectangles, pagePrimitivePins] = await Promise.all([
				collectWires(),
				collectTexts({ schematicPageUuid: pages[0].uuid }),
				collectBuses({ schematicPageUuid: pages[0].uuid }),
				collectNetLabels({ schematicPageUuid: pages[0].uuid }),
				collectArcs({ schematicPageUuid: pages[0].uuid }),
				collectCircles({ schematicPageUuid: pages[0].uuid }),
				collectPolygons({ schematicPageUuid: pages[0].uuid }),
				collectRectangles({ schematicPageUuid: pages[0].uuid }),
				collectPrimitivePins({ schematicPageUuid: pages[0].uuid }),
			]);

			allValidWires = wireData.validWires;
			allEmptyWires = wireData.emptyWires;

			// Collect components + pins (requires Wire+NetLabel data)
			const { components: pageComponents, pins: pagePins } = await collectComponentsAndPins({
				schematicPageUuid: pages[0].uuid,
				netlistMap,
				wireData,
				netLabels: pageNetLabels,
			});

			components = pageComponents;
			pins = pagePins;
			texts = pageTexts;
			buses = pageBuses;
			netLabels = pageNetLabels;
			arcs = pageArcs;
			circles = pageCircles;
			polygons = pagePolygons;
			rectangles = pageRectangles;
			primitivePins = pagePrimitivePins;

			log('info', `[Collect] Single-page data collection complete: ${components.length} components, ${pins.length} pins, ${allValidWires.length + allEmptyWires.length} wires, ${texts.length} text, ${buses.length} buses, ${netLabels.length} net labels, ${arcs.length} arcs, ${circles.length} circles, ${polygons.length} polygons, ${rectangles.length} rectangles, ${primitivePins.length} standalonepins (took ${Date.now() - t1}ms)`);
			meta.collectedPageUuids = [pages[0].uuid];
			meta.collectedPageCount = 1;
		}
		else {
			// Multi-page scenario: collect by switching pages
			log('info', `[Collect] Start collecting all elements page by page...`);
			const t1 = Date.now();
			for (let i = 0; i < pages.length; i++) {
				const page = pages[i];
				const pageStartTime = Date.now();
				try {
					// Open and activate the page
					const pageTabId = await eda.dmt_EditorControl.openDocument(page.uuid);
					if (!pageTabId) {
						log('warn', `[Collect] Unable to open page ${i + 1}/${pages.length}: ${page.name}`);
						meta.missingPageUuids.push(page.uuid);
						continue;
					}

					await eda.dmt_EditorControl.activateDocument(pageTabId);

					// Collect Wire/Text/Bus/NetLabel/shape primitives first
					const [wireData, pageTexts, pageBuses, pageNetLabels, pageArcs, pageCircles, pagePolygons, pageRectangles, pagePrimitivePins] = await Promise.all([
						collectWires(),
						collectTexts({ schematicPageUuid: page.uuid }),
						collectBuses({ schematicPageUuid: page.uuid }),
						collectNetLabels({ schematicPageUuid: page.uuid }),
						collectArcs({ schematicPageUuid: page.uuid }),
						collectCircles({ schematicPageUuid: page.uuid }),
						collectPolygons({ schematicPageUuid: page.uuid }),
						collectRectangles({ schematicPageUuid: page.uuid }),
						collectPrimitivePins({ schematicPageUuid: page.uuid }),
					]);

					allValidWires.push(...wireData.validWires);
					allEmptyWires.push(...wireData.emptyWires);

					// Then collect components + pins (requires Wire+NetLabel data for net binding)
					const { components: pageComponents, pins: pagePins } = await collectComponentsAndPins({
						schematicPageUuid: page.uuid,
						netlistMap,
						wireData,
						netLabels: pageNetLabels,
					});

					components.push(...pageComponents);
					pins.push(...pagePins);
					texts.push(...pageTexts);
					buses.push(...pageBuses);
					netLabels.push(...pageNetLabels);
					arcs.push(...pageArcs);
					circles.push(...pageCircles);
					polygons.push(...pagePolygons);
					rectangles.push(...pageRectangles);
					primitivePins.push(...pagePrimitivePins);
					meta.collectedPageUuids.push(page.uuid);
					log('info', `[Collect] Page ${i + 1}/${pages.length} (${page.name}): ${pageComponents.length} components, ${pagePins.length} pins, ${wireData.validWires.length + wireData.emptyWires.length} wires, ${pageTexts.length} text, ${pageBuses.length} buses, ${pageNetLabels.length} net labels, ${pageArcs.length} arcs, ${pageCircles.length} circles, ${pagePolygons.length} polygons, ${pageRectangles.length} rectangles, ${pagePrimitivePins.length} standalonepins (took ${Date.now() - pageStartTime}ms)`);
				}
				catch (pageError) {
					log('error', `[Collect] CollectPagefailed ${i + 1}/${pages.length} (${page.name})`, pageError);
					meta.missingPageUuids.push(page.uuid);
				}
			}
			log('info', `[Collect] Per-page collection complete: total ${components.length} components, ${pins.length} pins, ${allValidWires.length + allEmptyWires.length} wires, ${texts.length} text, ${buses.length} buses, ${netLabels.length} net labels, ${arcs.length} arcs, ${circles.length} circles, ${polygons.length} polygons, ${rectangles.length} rectangles, ${primitivePins.length} standalone pins (total took ${Date.now() - t1}ms)`);

			meta.collectedPageCount = meta.collectedPageUuids.length;
			if (meta.missingPageUuids.length > 0) {
				meta.quality = 'partial';
			}
		}

		// Check data integrity
		if (components.length === 0 && allValidWires.length === 0) {
			meta.quality = 'stale';
		}

		// Restore the user's original focused page
		try {
			await eda.dmt_EditorControl.activateDocument(originalTabId);
		}
		catch (restoreError) {
			log('warn', '[Collect] Failed to restore the original document focus', {
				error: restoreError instanceof Error ? restoreError.message : String(restoreError),
			});
		}

		// Build net statistics
		const nets = buildNetStatistics(pins);

		// Compute component property fetch statistics
		const stats = {
			total: components.length,
			withValue: components.filter(c => c.value).length,
			withPrefix: components.filter(c => c.prefix).length,
			withAddIntoPcb: components.filter(c => c.addIntoPcb).length,
			withLcscPart: components.filter(c => c.lcscPart).length,
			withJlcPart: components.filter(c => c.jlcPart).length,
			withBomInclude: components.filter(c => c.bomInclude).length,
			withManufacturer: components.filter(c => c.manufacturer).length,
			withManufacturerPartNumber: components.filter(c => c.manufacturerPartNumber).length,
		};

		log('info', `[Collect] Component property stats`, stats);

		const totalTime = Date.now() - startTime;
		log('success', `[Collect] Collection complete: ${components.length} components, ${pins.length} pins, ${nets.length} net, ${netLabels.length} net labels (total took ${totalTime}ms)`);

		return {
			components,
			pins,
			nets,
			texts,
			buses,
			netLabels,
			arcs,
			circles,
			polygons,
			rectangles,
			primitivePins,
			drcResult,
			projectInfo,
			netlistRaw,
			timestamp: Date.now(),
			meta,
		};
	}
	catch (error) {
		// Ensure the original focused page is restored
		try {
			await eda.dmt_EditorControl.activateDocument(originalTabId);
		}
		catch {
			// ignore
		}

		log('error', '[Collect] Collection failed', {
			error: error instanceof Error ? error.message : String(error),
		});
		throw new ReviewError(
			ErrorCode.COLLECT_API_FAILED,
			`Data collection failed: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}

/**
 * Collect the current page's components and pins (unified collection, avoids cross-page ID invalidation)
 *
 * Complete everything within the same page context:
 * 1. Fetch the component list -> separate netflag/netport and normal components
 * 2. Fetch detailed information and pins for normal components
 * 3. Bind nets (L1: netlist -> L2: wire coordinates -> L3: net label coordinates -> L4: wire topology)
 */
async function collectComponentsAndPins(options: {
	schematicPageUuid?: string;
	netlistMap: Map<string, string>;
	wireData: WireData;
	netLabels: RawNetLabel[];
}): Promise<{ components: RawComponent[]; pins: RawPin[] }> {
	const { schematicPageUuid, netlistMap, wireData, netLabels } = options;

	// Debug: function entry log (always emitted)
	log('info', `[Collect] ========== Start collecting components and pins ==========`, {
		timestamp: new Date().toISOString(),
		pageUuid: schematicPageUuid || '(single-page mode)',
		netlistMappingCount: netlistMap.size,
		validWireCount: wireData.validWires.length,
		emptyWireCount: wireData.emptyWires.length,
		netLabelCount: netLabels.length,
	});

	// Build the wire topology graph (L4 strategy)
	const wireClusters = buildWireTopology(wireData.validWires, wireData.emptyWires, netLabels);

	// Fetch all components on the current page (allSchematicPages=false)
	const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, false);

	// Phase 1: fetch only componentType for classification
	const filterTasks = primitives.map(primitive => async () => ({
		primitive,
		componentType: await primitive.getState_ComponentType(),
	}));
	const filtered = await promiseAllWithLimit(filterTasks, 100);

	// Filter out net label components (NET_FLAG/NET_PORT) - they are already collected separately in collectNetLabels()
	const validPrimitives = filtered.filter(
		item => item.componentType !== 'netflag' && item.componentType !== 'netport',
	);

	// Debug：outputcomponentsCollectstatistics
	log('info', `[Collect] componentsCollectstatistics`, {
		totalComponents: primitives.length,
		afterFilter: filtered.length,
		validComponentCount: validPrimitives.length,
		netLabelCount: filtered.length - validPrimitives.length,
	});

	// Phase 2: fetch detailed component information + pins
	const allComponents: RawComponent[] = [];
	const allPins: RawPin[] = [];

	// Unbound pin statistics (aggregate output, avoids per-item log spam)
	const MAX_UNRESOLVED_SAMPLES = 12;
	let unresolvedPinCount = 0;
	let unresolvedPowerPinCount = 0;
	const unresolvedPinSamples: any[] = [];

	const componentTasks = validPrimitives.map(({ primitive }, _index) => async () => {
		// Phase 1: fetch critical fields (skip the entire component on failure)
		let primitiveId = '';
		let designator = '';
		let pinPrimitives: any[] = [];

		try {
			// Fetch primitiveId first (call once to avoid duplication)
			primitiveId = await primitive.getState_PrimitiveId();

			// Fetch critical fields in parallel: designator and pins
			[designator, pinPrimitives] = await Promise.all([
				primitive.getState_Designator(),
				eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId),
			]);
		}
		catch (criticalError) {
			log('error', `[Collect] Failed to fetch critical information (skip component)`, {
				primitiveId: primitiveId || '(unknown)',
				error: criticalError instanceof Error ? criticalError.message : String(criticalError),
			});
			// Critical information fetch failed, skip this component
			return { component: null, pins: [] };
		}

		// Phase 2: fetch non-critical fields (use defaults on failure)
		let name = '';
		let x = 0;
		let y = 0;
		let rotation = 0;

		try {
			[name, x, y, rotation] = await Promise.all([
				primitive.getState_Name(),
				primitive.getState_X(),
				primitive.getState_Y(),
				primitive.getState_Rotation(),
			]);
		}
		catch (nonCriticalError) {
			log('warn', `[Collect] Failed to fetch non-critical information (using default values)`, {
				designator,
				primitiveId,
				error: nonCriticalError instanceof Error ? nonCriticalError.message : String(nonCriticalError),
			});
			// Non-critical field fetch failed, continuing with defaults
		}

		// Manufacturer info and key properties (from OtherProperty and standard methods)
		let manufacturer = '';
		let manufacturerPartNumber = '';
		let value = '';
		let prefix = '';
		let addIntoPcb = '';
		let lcscPart = '';
		let jlcPart = '';
		let bomInclude = '';

		try {
			// Fetch standard properties (these methods do exist)
			const [mfr, mpn, aipBool, aibBool] = await Promise.all([
				primitive.getState_Manufacturer(),
				primitive.getState_ManufacturerId(),
				primitive.getState_AddIntoPcb(),
				primitive.getState_AddIntoBom(),
			]);
			manufacturer = mfr || '';
			manufacturerPartNumber = mpn || '';
			addIntoPcb = aipBool !== undefined ? String(aipBool) : '';
			bomInclude = aibBool !== undefined ? String(aibBool) : '';

			// LCSC part number extraction: prefer primitive.supplierId (direct property)
			// supplierId is a direct property of primitive and unrelated to otherProperty, so read it first
			const supplierIdDirect = (primitive as any).supplierId;
			if (supplierIdDirect && /^C\d+$/i.test(String(supplierIdDirect).trim())) {
				lcscPart = String(supplierIdDirect).trim();
			}

			// Fetch OtherProperty (includes Value, Prefix, LCSC Part, JLC Part, etc.)
			const otherProperty = await primitive.getState_OtherProperty();
			if (otherProperty) {
				// Try multiple possible key names
				value = String(otherProperty.Value || otherProperty.value || '');
				prefix = String(otherProperty.Prefix || otherProperty.prefix || '');

				// If supplierId does not yield an LCSC part number, fall back to OtherProperty
				if (!lcscPart) {
					const lcscPartName = String(otherProperty['LCSC Part Name'] || '');
					const lcscPartDirect = String(otherProperty['LCSC Part'] || otherProperty.LcscPart || otherProperty.lcscPart || '');

					// Prefer the direct LCSC Part number
					if (lcscPartDirect && /^C\d+$/i.test(lcscPartDirect.trim())) {
						lcscPart = lcscPartDirect.trim();
					}
					// Check whether LCSC Part Name is an ID format (e.g. "C12345")
					else if (lcscPartName && /^C\d+$/i.test(lcscPartName.trim())) {
						lcscPart = lcscPartName.trim();
					}
					// Iterate all keys to find any value containing an LCSC number
					else {
						for (const key of Object.keys(otherProperty)) {
							const val = String(otherProperty[key] || '').trim();
							if (/^C\d{4,}$/.test(val) && key.toLowerCase().includes('lcsc')) {
								lcscPart = val;
								break;
							}
						}
						// If no LCSC number is found, use LCSC Part Name as the name identifier
						if (!lcscPart && lcscPartName) {
							lcscPart = lcscPartName;
						}
					}
				}

				jlcPart = String(
					otherProperty['JLCPCB Part Class']
					|| otherProperty['JLC Part']
					|| otherProperty.JlcPart
					|| otherProperty.jlcPart
					|| '',
				);

				// BomInclude may exist in OtherProperty or in standard properties
				if (!bomInclude) {
					bomInclude = String(otherProperty['BOM Include'] || otherProperty.BomInclude || otherProperty.bomInclude || '');
				}
			}

			// If Prefix is still empty, try extracting it from designator (e.g. "R1" -> "R")
			if (!prefix && designator) {
				const match = designator.match(/^([A-Z]+)/i);
				if (match) {
					prefix = match[1];
				}
			}
		}
		catch (error) {
			// Some components may not have these properties
			log('warn', `[Collect] Failed to fetch component properties (${designator})`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		const component: RawComponent = {
			primitiveId,
			designator: designator || '',
			name: name || '',
			value,
			prefix,
			addIntoPcb,
			lcscPart,
			jlcPart,
			bomInclude,
			manufacturer,
			manufacturerPartNumber,
			x,
			y,
			rotation: rotation || 0,
			schematicPageUuid,
		};

		// Collect this component's pins (fail individually to avoid skipping the entire component)
		const componentPins: RawPin[] = [];
		let pinFailureCount = 0;
		if (pinPrimitives && pinPrimitives.length > 0) {
			const pinTasks = pinPrimitives.map((pinPrimitive, pinIndex) => async () => {
				try {
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

					// L1: use only the netlist map (conservative mode)
					// Disable L2/L3/L4 strategies to avoid false positives (binding NC pins to nearby wires by mistake)
					const netName: string | null = netlistMap.get(pinKey) || null;
					const confidence = netName ? 1.0 : 0;
					const reason = netName ? 'netlist' : 'unresolved';
					const debugInfo: any = {
						pin: pinKey,
						coord: `(${pinX}, ${pinY})`,
						L1_netlist: netName || 'miss',
					};

					// L2/L3/L4 strategies are disabled (conservative mode)
					// Reason: avoid incorrectly binding NC (floating) pins to wires that are physically close but not actually connected
					// If pins are not in the netlist, mark them as unbound (netName = null)
					//
					// To enable hybrid mode, uncomment the following:
					/*
				// L2: Ifnetlistunresolved，tryviawirescoordinatesmatch
				if (!netName) {
					const wireNet = _findNetByWireProximity(pinX, pinY, wireData.validWires);
					debugInfo.L2_wire = wireNet || 'miss';
					if (wireNet) {
						netName = wireNet;
						confidence = 0.8;
						reason = 'wire';
					}
				}

				// L3: If wires still do not match, try matching by net label coordinates
				if (!netName) {
					const labelNet = _findNetByLabelProximity(pinX, pinY, netLabels);
					debugInfo.L3_netlabel = labelNet || 'miss';
					if (labelNet) {
						netName = labelNet;
						confidence = 0.7;
						reason = 'netlabel';
					}
				}

				// L4: If the first three layers fail, try inferring from wire topology
				if (!netName) {
					const topologyResult = _findNetByWireTopology(pinX, pinY, wireClusters);
					debugInfo.L4_topology = topologyResult?.netName || 'miss';
					if (topologyResult) {
						netName = topologyResult.netName;
						confidence = topologyResult.confidence;
						reason = 'topology';
					}
				}
				*/

					// Output debug information for unbound pins (with nearest-neighbor distance to diagnose tolerance issues)
					if (!netName) {
						const nearestWire = findNearestWireDistance(pinX, pinY, wireData.validWires, wireData.emptyWires);
						const nearestLabel = findNearestLabelDistance(pinX, pinY, netLabels);
						const nearestTopo = findNearestTopoDistance(pinX, pinY, wireClusters);
						debugInfo.nearest = {
							wire: nearestWire ? `${nearestWire.distance.toFixed(1)}(${nearestWire.net || 'empty'})` : 'none',
							label: nearestLabel ? `${nearestLabel.distance.toFixed(1)}(${nearestLabel.net})` : 'none',
							topo: nearestTopo ? `${nearestTopo.distance.toFixed(1)}` : 'none',
						};

						// Aggregate statistics, no per-item output
						if (electricalType === 'Power' || electricalType === 'Ground') {
							unresolvedPowerPinCount++;
						}
						else {
							unresolvedPinCount++;
						}

						// Collect the first N samples
						if (unresolvedPinSamples.length < MAX_UNRESOLVED_SAMPLES) {
							unresolvedPinSamples.push(debugInfo);
						}
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
				}
				catch (pinError) {
					pinFailureCount++;
					log('warn', `[Collect] Pin fetch failed (skip this pin)`, {
						designator: component.designator,
						primitiveId: component.primitiveId,
						pinIndex,
						error: pinError instanceof Error ? pinError.message : String(pinError),
					});
					return null; // Return null to indicate this pin failed
				}
			});

			const pinResults = await promiseAllWithLimit(pinTasks, 50);
			// Filter out failed pins (null)
			componentPins.push(...pinResults.filter((pin): pin is RawPin => pin !== null));

			// If the pin failure rate is too high, record a warning
			if (pinFailureCount > 0) {
				log('warn', `[Collect] componentpinspartialfailed`, {
					designator: component.designator,
					primitiveId: component.primitiveId,
					totalPins: pinPrimitives.length,
					failedPins: pinFailureCount,
					successPins: componentPins.length,
				});
			}
		}

		return { component, pins: componentPins };
	});

	const results = await promiseAllWithLimit(componentTasks, 30);
	for (const result of results) {
		if (result.component === null)
			continue; // Skip components whose basic information fetch failed
		allComponents.push(result.component);
		allPins.push(...result.pins);
	}

	// Output unbound pin statistics in aggregate
	if (unresolvedPinCount > 0 || unresolvedPowerPinCount > 0) {
		log(unresolvedPowerPinCount > 0 ? 'warn' : 'info', '[Pin-Net] Unbound pin summary', {
			unresolvedPinCount,
			unresolvedPowerPinCount,
			sampleCount: unresolvedPinSamples.length,
			samples: unresolvedPinSamples,
		});
	}

	return { components: allComponents, pins: allPins };
}

/**
 * Background netlist fetch state (used for delayed backfill)
 */
interface BackgroundNetlistState {
	promise: Promise<string | undefined>;
	startTime: number;
	completed: boolean;
	result?: string;
	duration?: number;
	token: number; // Version control: only callbacks whose token matches may update state
}

let backgroundNetlistState: BackgroundNetlistState | null = null;
let backgroundNetlistTokenCounter = 0; // Global token counter

/**
 * Collect the netlist (with timeout protection + background continuation)
 *
 * Strategy:
 * 1. Start netlist fetch with a 10-second timeout
 * 2. If it times out, return undefined so the main flow continues (using L2/L3/L4)
 * 3. But the netlist fetch continues in the background and records the actual time spent
 * 4. If it ultimately succeeds, trigger rebinding through the orchestrator
 */
async function collectNetlist(): Promise<string | undefined> {
	try {
		const NETLIST_TIMEOUT_MS = 10000; // 10-second timeout (main flow)
		const startTime = Date.now();
		log('info', `[Collect] Start fetching the netlist...`);

		// Use PROTEL2 format (actual return format is PROTEL NETLIST 2.0)
		const netlistPromise = eda.sch_Netlist.getNetlist(ESYS_NetlistType.PROTEL2);

		// Allocate a new token to prevent old task callbacks from overwriting new tasks
		const currentToken = ++backgroundNetlistTokenCounter;

		// Save to global state for later queries
		backgroundNetlistState = {
			promise: netlistPromise.then(
				(result) => {
					const duration = Date.now() - startTime;
					// Only update state when the token matches (prevents old tasks from overwriting new ones)
					if (backgroundNetlistState && backgroundNetlistState.token === currentToken) {
						backgroundNetlistState.completed = true;
						backgroundNetlistState.result = result;
						backgroundNetlistState.duration = duration;
						log('success', `[Collect] Netlist background fetch succeeded (token=${currentToken}, took ${duration}ms, size: ${result.length} characters)`);
					}
					else {
						log('warn', `[Collect] Netlist background fetch succeeded but is stale (token=${currentToken}, current=${backgroundNetlistState?.token})`);
					}
					return result;
				},
				(error) => {
					const duration = Date.now() - startTime;
					// Only update state when the token matches
					if (backgroundNetlistState && backgroundNetlistState.token === currentToken) {
						backgroundNetlistState.completed = true;
						backgroundNetlistState.duration = duration;
						log('error', `[Collect] Netlist background fetch failed (token=${currentToken}, took ${duration}ms): ${error instanceof Error ? error.message : String(error)}`);
					}
					else {
						log('warn', `[Collect] Netlist background fetch failed but is stale (token=${currentToken}, current=${backgroundNetlistState?.token})`);
					}
					return undefined;
				},
			),
			startTime,
			completed: false,
			token: currentToken,
		};

		// Main flow wait timed out
		const result = await Promise.race([
			netlistPromise,
			new Promise<undefined>((resolve) => {
				setTimeout(() => resolve(undefined), NETLIST_TIMEOUT_MS);
			}),
		]);

		if (result === undefined) {
			log('warn', `[Collect] Netlist fetch timed out (${NETLIST_TIMEOUT_MS}ms)，skipping netlist binding (background fetch continues...)`);
		}
		else {
			log('info', `[Collect] Netlist format: Protel2, size: ${result.length} characters (took ${Date.now() - startTime}ms)`);
		}

		return result;
	}
	catch (error) {
		log('error', `[Collect] Netlist fetch exception: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/**
 * Get the background netlist state (for external queries)
 */
export function getBackgroundNetlistState(): BackgroundNetlistState | null {
	return backgroundNetlistState;
}

/**
 * Clear the background netlist state
 */
export function clearBackgroundNetlistState(): void {
	backgroundNetlistState = null;
}

/**
 * Wire data structure (includes wires with and without net values)
 */
interface WireData {
	validWires: Array<{ net: string; lines: number[][] }>;
	emptyWires: Array<{ lines: number[][] }>;
}

/**
 * Collect wires (including wires with empty nets, used for topology analysis)
 */
async function collectWires(): Promise<WireData> {
	const wirePrimitives = await eda.sch_PrimitiveWire.getAll();

	let emptyNetCount = 0;

	const wireTasks = wirePrimitives.map(wire => async () => {
		const [net, line] = await Promise.all([
			wire.getState_Net(),
			wire.getState_Line(),
		]);

		if (!line) {
			return null;
		}

		// Normalize line into a 2D array
		const lines = Array.isArray(line[0]) ? line as number[][] : [line as number[]];

		if (!net) {
			emptyNetCount++;
			return { type: 'empty' as const, lines };
		}

		return { type: 'valid' as const, net, lines };
	});

	const results = await promiseAllWithLimit(wireTasks, 50);
	const validWires: Array<{ net: string; lines: number[][] }> = [];
	const emptyWires: Array<{ lines: number[][] }> = [];

	for (const result of results) {
		if (!result)
			continue;
		if (result.type === 'valid') {
			validWires.push({ net: result.net, lines: result.lines });
		}
		else {
			emptyWires.push({ lines: result.lines });
		}
	}

	// outputwiresCollectstatistics
	log('info', `[Collect] wiresstatistics: total=${wirePrimitives.length}, valid=${validWires.length}, net empty=${emptyNetCount}`);

	return { validWires, emptyWires };
}

/**
 * Collect text annotations
 * On failure, degrade to an empty array without blocking the main flow
 */
async function collectTexts(
	options: CollectTextAndBusOptions = {},
): Promise<RawText[]> {
	const { schematicPageUuid } = options;

	try {
		let failedCount = 0;
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
			catch {
				failedCount++;
				return null;
			}
		});

		const results = await promiseAllWithLimit(textTasks, 50);
		const filtered = results.filter((item): item is RawText => item !== null);

		if (failedCount > 0) {
			log('warn', '[Collect] textprimitiveCollectpartialfailed', {
				failedCount,
				total: textPrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		return filtered;
	}
	catch (error) {
		log('warn', '[Collect] Failed to collect text annotations; degraded to an empty array', {
			error: error instanceof Error ? error.message : String(error),
			schematicPageUuid: schematicPageUuid || '(currentpage)',
		});
		return [];
	}
}

/**
 * Collectbuses
 * On failure, degrade to an empty array without blocking the main flow
 */
async function collectBuses(
	options: CollectTextAndBusOptions = {},
): Promise<RawBus[]> {
	const { schematicPageUuid } = options;

	try {
		let failedCount = 0;
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

				// Normalize line into a 2D array
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
			catch {
				failedCount++;
				return null;
			}
		});

		const results = await promiseAllWithLimit(busTasks, 50);
		const filtered = results.filter((item): item is RawBus => item !== null);

		if (failedCount > 0) {
			log('warn', '[Collect] busesprimitiveCollectpartialfailed', {
				failedCount,
				total: busPrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		return filtered;
	}
	catch (error) {
		log('warn', '[Collect] Failed to collect buses; degraded to an empty array', {
			error: error instanceof Error ? error.message : String(error),
			schematicPageUuid: schematicPageUuid || '(currentpage)',
		});
		return [];
	}
}

/**
 * Collect net labels (labels such as GND and VCC)
 * On failure, degrade to an empty array without blocking the main flow
 */
async function collectNetLabels(
	options: CollectTextAndBusOptions = {},
): Promise<RawNetLabel[]> {
	const { schematicPageUuid } = options;

	try {
		let failedCount = 0;
		// Fetch all components on the current page
		const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, false);

		// Phase 1: fetch only componentType for filtering
		const filterTasks = primitives.map(primitive => async () => ({
			primitive,
			componentType: await primitive.getState_ComponentType(),
		}));
		const filtered = await promiseAllWithLimit(filterTasks, 100);

		// Keep only net label components (NET_FLAG/NET_PORT)
		const netLabelPrimitives = filtered.filter(
			item => item.componentType === 'netflag' || item.componentType === 'netport',
		);

		// Phase 2: fetch detailed information for net labels
		const netLabelTasks = netLabelPrimitives.map(({ primitive, componentType }) => async () => {
			try {
				const [primitiveId, designator, x, y] = await Promise.all([
					primitive.getState_PrimitiveId(),
					primitive.getState_Designator(),
					primitive.getState_X(),
					primitive.getState_Y(),
				]);

				// The net label designator is the net name (e.g. "GND", "VCC_3V3")
				return {
					primitiveId,
					netName: designator || '',
					x,
					y,
					type: componentType as 'netflag' | 'netport',
					schematicPageUuid,
				} as RawNetLabel;
			}
			catch {
				failedCount++;
				return null;
			}
		});

		const results = await promiseAllWithLimit(netLabelTasks, 50);
		const filteredResults = results.filter((item): item is RawNetLabel => item !== null);

		if (failedCount > 0) {
			log('warn', '[Collect] net labelsCollectpartialfailed', {
				failedCount,
				total: netLabelPrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		return filteredResults;
	}
	catch (error) {
		log('warn', '[Collect] Failed to collect net labels; degraded to an empty array', {
			error: error instanceof Error ? error.message : String(error),
			schematicPageUuid: schematicPageUuid || '(currentpage)',
		});
		return [];
	}
}

/**
 * Collect DRC results (global, independent of page switching)
 * On failure, degrade to undefined without blocking the main flow
 */
async function collectDrcResult(): Promise<RawDrcResult | undefined> {
	const t0 = Date.now();
	log('info', '[Collect] Start collecting DRC results...');

	try {
		const passed = await eda.sch_Drc.check(false, false);
		const result: RawDrcResult = {
			passed: !!passed,
			strict: false,
			timestamp: Date.now(),
		};
		log('info', `[Collect] DRC check complete (took ${Date.now() - t0}ms)`, {
			passed: result.passed,
		});
		return result;
	}
	catch (error) {
		log('warn', '[Collect] DRC check failed, degraded to undefined', {
			error: error instanceof Error ? error.message : String(error),
			elapsed: Date.now() - t0,
		});
		return undefined;
	}
}

/**
 * Collect current project metadata (global, independent of page switching)
 * On failure, degrade to undefined without blocking the main flow
 */
async function collectProjectInfo(): Promise<RawProjectInfo | undefined> {
	const t0 = Date.now();
	log('info', '[Collect] StartCollectprojectmetadata...');

	try {
		const project = await eda.dmt_Project.getCurrentProjectInfo();
		if (!project) {
			log('warn', '[Collect] Project metadata is empty, degraded to undefined', {
				elapsed: Date.now() - t0,
			});
			return undefined;
		}
		const result: RawProjectInfo = {
			projectName: project.friendlyName || project.name || '',
			projectDescription: project.description || undefined,
			projectUuid: project.uuid,
			timestamp: Date.now(),
		};
		log('info', `[Collect] projectmetadataCollection complete (took ${Date.now() - t0}ms)`, {
			projectName: result.projectName,
			projectUuid: result.projectUuid,
		});
		return result;
	}
	catch (error) {
		log('warn', '[Collect] Failed to fetch project metadata, degraded to undefined', {
			error: error instanceof Error ? error.message : String(error),
			elapsed: Date.now() - t0,
		});
		return undefined;
	}
}

/**
 * Collectarcsprimitive
 * On failure, degrade to an empty array without blocking the main flow
 */
async function collectArcs(
	options: CollectTextAndBusOptions = {},
): Promise<RawArc[]> {
	const { schematicPageUuid } = options;
	const t0 = Date.now();

	try {
		let failedCount = 0;
		let deriveFailedCount = 0;
		const arcPrimitives = await eda.sch_PrimitiveArc.getAll();

		const arcTasks = arcPrimitives.map(arcPrimitive => async () => {
			try {
				const [primitiveId, startX, startY, referenceX, referenceY, endX, endY] = await Promise.all([
					arcPrimitive.getState_PrimitiveId(),
					arcPrimitive.getState_StartX(),
					arcPrimitive.getState_StartY(),
					arcPrimitive.getState_ReferenceX(),
					arcPrimitive.getState_ReferenceY(),
					arcPrimitive.getState_EndX(),
					arcPrimitive.getState_EndY(),
				]);

				// Compute arc geometry from three points using circumcircle geometry
				const geometry = deriveArcGeometry(startX, startY, referenceX, referenceY, endX, endY);
				if (!geometry) {
					failedCount++;
					deriveFailedCount++;
					return null;
				}

				return {
					primitiveId,
					...geometry,
					schematicPageUuid,
				} as RawArc;
			}
			catch {
				failedCount++;
				return null;
			}
		});

		const results = await promiseAllWithLimit(arcTasks, 50);
		const filtered = results.filter((item): item is RawArc => item !== null);

		if (failedCount > 0) {
			log('warn', '[Collect] arcsprimitiveCollectpartialfailed', {
				failedCount,
				deriveFailedCount,
				total: arcPrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		log('info', `[Collect] arcsprimitiveCollection complete: total=${arcPrimitives.length}, success=${filtered.length}, failed=${failedCount} (geometry derivation failed=${deriveFailedCount}), took=${Date.now() - t0}ms`);

		return filtered;
	}
	catch (error) {
		log('warn', '[Collect] Failed to collect arc primitives; degraded to an empty array', {
			error: error instanceof Error ? error.message : String(error),
			elapsed: Date.now() - t0,
			schematicPageUuid: schematicPageUuid || '(currentpage)',
		});
		return [];
	}
}

/**
 * Collectcirclesprimitive
 * On failure, degrade to an empty array without blocking the main flow
 */
async function collectCircles(
	options: CollectTextAndBusOptions = {},
): Promise<RawCircle[]> {
	const { schematicPageUuid } = options;
	const t0 = Date.now();

	try {
		let failedCount = 0;
		const circlePrimitives = await eda.sch_PrimitiveCircle.getAll();

		const circleTasks = circlePrimitives.map(circlePrimitive => async () => {
			try {
				const [primitiveId, cx, cy, radius] = await Promise.all([
					circlePrimitive.getState_PrimitiveId(),
					circlePrimitive.getState_CenterX(),
					circlePrimitive.getState_CenterY(),
					circlePrimitive.getState_Radius(),
				]);

				return {
					primitiveId,
					cx,
					cy,
					radius,
					schematicPageUuid,
				} as RawCircle;
			}
			catch {
				failedCount++;
				return null;
			}
		});

		const results = await promiseAllWithLimit(circleTasks, 50);
		const filtered = results.filter((item): item is RawCircle => item !== null);

		if (failedCount > 0) {
			log('warn', '[Collect] circlesprimitiveCollectpartialfailed', {
				failedCount,
				total: circlePrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		log('info', `[Collect] circlesprimitiveCollection complete: total=${circlePrimitives.length}, success=${filtered.length}, failed=${failedCount}, took=${Date.now() - t0}ms`);

		return filtered;
	}
	catch (error) {
		log('warn', '[Collect] Failed to collect circle primitives; degraded to an empty array', {
			error: error instanceof Error ? error.message : String(error),
			elapsed: Date.now() - t0,
			schematicPageUuid: schematicPageUuid || '(currentpage)',
		});
		return [];
	}
}

/**
 * Collect polygon/polyline primitives
 * On failure, degrade to an empty array without blocking the main flow
 */
async function collectPolygons(
	options: CollectTextAndBusOptions = {},
): Promise<RawPolygon[]> {
	const { schematicPageUuid } = options;
	const t0 = Date.now();

	try {
		let failedCount = 0;
		let invalidLineCount = 0;
		let tooFewPointsCount = 0;
		const polygonPrimitives = await eda.sch_PrimitivePolygon.getAll();

		const polygonTasks = polygonPrimitives.map(polygonPrimitive => async () => {
			try {
				const [primitiveId, line] = await Promise.all([
					polygonPrimitive.getState_PrimitiveId(),
					polygonPrimitive.getState_Line(),
				]);

				if (!line) {
					invalidLineCount++;
					return null;
				}

				// Convert a flat coordinate array into point pairs
				const points: number[][] = [];
				const flatLine = Array.isArray(line[0]) ? (line as number[][]).flat() : line as number[];
				for (let i = 0; i + 1 < flatLine.length; i += 2) {
					points.push([flatLine[i], flatLine[i + 1]]);
				}

				if (points.length < 2) {
					tooFewPointsCount++;
					return null;
				}

				// Determine whether the shape is closed (first and last points coincide)
				const first = points[0];
				const last = points[points.length - 1];
				const closed = points.length > 2 && first[0] === last[0] && first[1] === last[1];

				return {
					primitiveId,
					points,
					closed,
					schematicPageUuid,
				} as RawPolygon;
			}
			catch {
				failedCount++;
				return null;
			}
		});

		const results = await promiseAllWithLimit(polygonTasks, 50);
		const filtered = results.filter((item): item is RawPolygon => item !== null);

		if (failedCount > 0) {
			log('warn', '[Collect] polygonsprimitiveCollectpartialfailed', {
				failedCount,
				total: polygonPrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		if (invalidLineCount > 0 || tooFewPointsCount > 0) {
			log('warn', '[Collect] Polygon primitives contain invalid geometry data', {
				invalidLineCount,
				tooFewPointsCount,
				total: polygonPrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		log('info', `[Collect] polygonsprimitiveCollection complete: total=${polygonPrimitives.length}, success=${filtered.length}, failed=${failedCount}, invalid line=${invalidLineCount}, too few points=${tooFewPointsCount}, took=${Date.now() - t0}ms`);

		return filtered;
	}
	catch (error) {
		log('warn', '[Collect] Failed to collect polygon primitives; degraded to an empty array', {
			error: error instanceof Error ? error.message : String(error),
			elapsed: Date.now() - t0,
			schematicPageUuid: schematicPageUuid || '(currentpage)',
		});
		return [];
	}
}

/**
 * Collectrectanglesprimitive
 * On failure, degrade to an empty array without blocking the main flow
 */
async function collectRectangles(
	options: CollectTextAndBusOptions = {},
): Promise<RawRectangle[]> {
	const { schematicPageUuid } = options;
	const t0 = Date.now();

	try {
		let failedCount = 0;
		const rectanglePrimitives = await eda.sch_PrimitiveRectangle.getAll();

		const rectangleTasks = rectanglePrimitives.map(rectanglePrimitive => async () => {
			try {
				const [primitiveId, x, y, width, height] = await Promise.all([
					rectanglePrimitive.getState_PrimitiveId(),
					rectanglePrimitive.getState_TopLeftX(),
					rectanglePrimitive.getState_TopLeftY(),
					rectanglePrimitive.getState_Width(),
					rectanglePrimitive.getState_Height(),
				]);

				return {
					primitiveId,
					x,
					y,
					width,
					height,
					schematicPageUuid,
				} as RawRectangle;
			}
			catch {
				failedCount++;
				return null;
			}
		});

		const results = await promiseAllWithLimit(rectangleTasks, 50);
		const filtered = results.filter((item): item is RawRectangle => item !== null);

		if (failedCount > 0) {
			log('warn', '[Collect] rectanglesprimitiveCollectpartialfailed', {
				failedCount,
				total: rectanglePrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		log('info', `[Collect] rectanglesprimitiveCollection complete: total=${rectanglePrimitives.length}, success=${filtered.length}, failed=${failedCount}, took=${Date.now() - t0}ms`);

		return filtered;
	}
	catch (error) {
		log('warn', '[Collect] Failed to collect rectangle primitives; degraded to an empty array', {
			error: error instanceof Error ? error.message : String(error),
			elapsed: Date.now() - t0,
			schematicPageUuid: schematicPageUuid || '(currentpage)',
		});
		return [];
	}
}

/**
 * Collect standalone pin primitives (pins not belonging to components)
 * On failure, degrade to an empty array without blocking the main flow
 */
async function collectPrimitivePins(
	options: CollectTextAndBusOptions = {},
): Promise<RawPrimitivePin[]> {
	const { schematicPageUuid } = options;
	const t0 = Date.now();

	try {
		let failedCount = 0;
		const pinPrimitives = await eda.sch_PrimitivePin.getAll();

		const pinTasks = pinPrimitives.map(pinPrimitive => async () => {
			try {
				const [primitiveId, pinNumber, pinName, pinType, x, y] = await Promise.all([
					pinPrimitive.getState_PrimitiveId(),
					pinPrimitive.getState_PinNumber(),
					pinPrimitive.getState_PinName(),
					pinPrimitive.getState_pinType(),
					pinPrimitive.getState_X(),
					pinPrimitive.getState_Y(),
				]);

				return {
					primitiveId,
					pinNumber: pinNumber || '',
					pinName: pinName || '',
					pinType: pinType !== undefined ? String(pinType) : '',
					x,
					y,
					schematicPageUuid,
				} as RawPrimitivePin;
			}
			catch {
				failedCount++;
				return null;
			}
		});

		const results = await promiseAllWithLimit(pinTasks, 50);
		const filtered = results.filter((item): item is RawPrimitivePin => item !== null);

		if (failedCount > 0) {
			log('warn', '[Collect] standalonepinsprimitiveCollectpartialfailed', {
				failedCount,
				total: pinPrimitives.length,
				schematicPageUuid: schematicPageUuid || '(currentpage)',
			});
		}

		log('info', `[Collect] standalonepinsprimitiveCollection complete: total=${pinPrimitives.length}, success=${filtered.length}, failed=${failedCount}, took=${Date.now() - t0}ms`);

		return filtered;
	}
	catch (error) {
		log('warn', '[Collect] Failed to collect standalone pin primitives; degraded to an empty array', {
			error: error instanceof Error ? error.message : String(error),
			elapsed: Date.now() - t0,
			schematicPageUuid: schematicPageUuid || '(currentpage)',
		});
		return [];
	}
}

/**
 * Compute arc geometry using three-point circumcircle
 * Derive the center, radius, and angles from the start, reference, and end coordinates
 */
function deriveArcGeometry(
	startX: number,
	startY: number,
	referenceX: number,
	referenceY: number,
	endX: number,
	endY: number,
): { cx: number; cy: number; radius: number; startAngle: number; endAngle: number } | null {
	const determinant = 2 * (
		startX * (referenceY - endY)
		+ referenceX * (endY - startY)
		+ endX * (startY - referenceY)
	);

	// Three collinear points cannot form an arc
	if (Math.abs(determinant) < 1e-6) {
		return null;
	}

	const startSq = startX ** 2 + startY ** 2;
	const refSq = referenceX ** 2 + referenceY ** 2;
	const endSq = endX ** 2 + endY ** 2;

	const cx = (
		startSq * (referenceY - endY)
		+ refSq * (endY - startY)
		+ endSq * (startY - referenceY)
	) / determinant;
	const cy = (
		startSq * (endX - referenceX)
		+ refSq * (startX - endX)
		+ endSq * (referenceX - startX)
	) / determinant;

	const radius = Math.sqrt((startX - cx) ** 2 + (startY - cy) ** 2);
	if (!Number.isFinite(radius) || radius <= 0) {
		return null;
	}

	const toDeg = (rad: number) => (rad * 180) / Math.PI;
	const normalize = (angle: number) => {
		const mod = angle % 360;
		return mod < 0 ? mod + 360 : mod;
	};

	const startAngle = normalize(toDeg(Math.atan2(startY - cy, startX - cx)));
	const endAngle = normalize(toDeg(Math.atan2(endY - cy, endX - cx)));

	return { cx, cy, radius, startAngle, endAngle };
}

/**
 * Parse the netlist string (supports JLCEDA_PRO and Protel2 formats)
 */
export function parseNetlist(netlistRaw: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!netlistRaw)
		return map;

	try {
		log('debug', '[Collect] Start parsing the netlist', { length: netlistRaw.length });

		// Strategy 1: JLCEDA_PRO format (keyword "NET:")
		if (netlistRaw.includes('NET:')) {
			parseNetlistJlcedaPro(netlistRaw, map);
		}

		// Strategy 2: PROTEL NETLIST 2.0 format (square-bracketed components + parenthesized nets)
		if (map.size === 0 && netlistRaw.startsWith('PROTEL NETLIST 2.0')) {
			parseNetlistProtel2V2(netlistRaw, map);
		}

		// Strategy 3: Protel2 standard format (keywords "Net List" or "Component List")
		if (map.size === 0 && (netlistRaw.includes('Net List') || netlistRaw.includes('Component List'))) {
			parseNetlistProtel2Standard(netlistRaw, map);
		}

		// Strategy 4: generic Designator-Pin format (uses global regex matching)
		if (map.size === 0) {
			parseNetlistGeneric(netlistRaw, map);
		}

		log('info', `[Collect] Netlist parsing complete: ${map.size} pin-net mappings`);
	}
	catch (error) {
		log('warn', `[Collect] Netlist parsing failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return map;
}

/**
 * Parse JLCEDA_PRO-format netlists
 *
 * Format:
 * NET: VCC_3V3
 *   U1-1
 *   C1-1
 */
function parseNetlistJlcedaPro(netlistRaw: string, map: Map<string, string>): void {
	const lines = netlistRaw.split('\n');
	let currentNet = '';

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('NET:')) {
			currentNet = trimmed.substring(4).trim();
		}
		else if (currentNet && trimmed.includes('-')) {
			const dashIdx = trimmed.indexOf('-');
			const designator = trimmed.substring(0, dashIdx).trim();
			const pinNumber = trimmed.substring(dashIdx + 1).trim();
			if (designator && pinNumber && /^[A-Z]/.test(designator)) {
				map.set(`${designator}_${pinNumber}`, currentNet);
			}
		}
	}
}

/**
 * Parse PROTEL NETLIST 2.0-format netlists
 *
 * Format characteristics:
 * - First line: "PROTEL NETLIST 2.0"
 * - Component section: wrapped in square brackets [...], containing DESIGNATOR/FOOTPRINT/PARTTYPE, etc.
 * - Net section: wrapped in parentheses (...), containing the net name and Designator-Pin connections
 *
 * Example：
 * PROTEL NETLIST 2.0
 * [
 * DESIGNATOR
 * U1
 * FOOTPRINT
 * LQFP-48
 * ...
 * ]
 * (
 * GND
 * U1-14
 * C1-2
 * )
 * (
 * VCC_3V3
 * U1-1
 * C1-1
 * )
 */
function parseNetlistProtel2V2(netlistRaw: string, map: Map<string, string>): void {
	const lines = netlistRaw.split('\n');
	let inNetSection = false;
	let currentNet = '';
	let justOpenedParen = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed)
			continue;

		// Opening parenthesis: marks one net block in the Net section
		if (trimmed === '(') {
			inNetSection = true;
			justOpenedParen = true;
			currentNet = '';
			continue;
		}

		// Closing parenthesis: ends the current net block
		if (trimmed === ')') {
			inNetSection = false;
			currentNet = '';
			justOpenedParen = false;
			continue;
		}

		// Square brackets open/close the Component section (skip it)
		if (trimmed === '[' || trimmed === ']') {
			inNetSection = false;
			justOpenedParen = false;
			continue;
		}

		if (inNetSection) {
			// The first non-empty line after the parenthesis is the net name
			if (justOpenedParen) {
				currentNet = trimmed;
				justOpenedParen = false;
				continue;
			}

			// Subsequent lines are Designator-Pin connections
			// Format: U4-18 RTL8723 module-CHIP_EN Input
			// Need to extract: Designator=U4, PinNumber=18 (take only the part before the first space)
			if (currentNet) {
				const dashIdx = trimmed.indexOf('-');
				if (dashIdx > 0) {
					const designator = trimmed.substring(0, dashIdx);
					const afterDash = trimmed.substring(dashIdx + 1);
					// Take only the part before the first space as pinNumber
					const spaceIdx = afterDash.indexOf(' ');
					const pinNumber = spaceIdx > 0 ? afterDash.substring(0, spaceIdx) : afterDash;
					if (designator && pinNumber && /^[A-Z]/.test(designator)) {
						map.set(`${designator}_${pinNumber}`, currentNet);
					}
				}
			}
		}
	}

	if (map.size > 0) {
		log('debug', `[Collect] Use the PROTEL NETLIST 2.0 parser`);
	}
}

/**
 * Parse Protel2 standard-format netlists
 *
 * The structure contains two parts:
 * ( { Component List }
 *   ( U1 LQFP-48 )
 *   ( C1 C0402 )
 * )
 * ( { Net List }
 *   ( GND
 *     U1-14
 *     C1-2
 *   )
 *   ( VCC_3V3
 *     U1-1
 *     C1-1
 *   )
 * )
 */
function parseNetlistProtel2Standard(netlistRaw: string, map: Map<string, string>): void {
	const lines = netlistRaw.split('\n');
	let inNetListSection = false;
	let currentNet = '';

	for (const line of lines) {
		const trimmed = line.trim();

		// Detect the start of the Net List section
		if (trimmed.includes('Net List')) {
			inNetListSection = true;
			currentNet = '';
			continue;
		}

		// Detect the Component List section (skip)
		if (trimmed.includes('Component List')) {
			inNetListSection = false;
			currentNet = '';
			continue;
		}

		if (!inNetListSection)
			continue;

		// Match net-name lines: ( GND or ( VCC_3V3 or ( NET_LCD_DE
		// The net name follows "(" and may be on its own line or on the same line as "("
		const netOpenMatch = trimmed.match(/^\(\s*([^\s)]+)\s*$/);
		if (netOpenMatch && !trimmed.endsWith(')')) {
			const candidate = netOpenMatch[1];
			// Exclude lines that are clearly not net names (such as brace comments)
			if (candidate && !candidate.startsWith('{') && !candidate.startsWith('(')) {
				currentNet = candidate;
				continue;
			}
		}

		// Match pin-connection lines: U1-14 or R1-2 or J1-3
		// Designator format: letters+numbers, Pin format: numbers (may include letters like A1)
		if (currentNet) {
			const pinMatch = trimmed.match(/^([A-Z][A-Z0-9]*\d)-(\S+)\s*$/);
			if (pinMatch) {
				map.set(`${pinMatch[1]}_${pinMatch[2]}`, currentNet);
				continue;
			}
		}

		// Net ends: a standalone )
		if (trimmed === ')') {
			currentNet = '';
		}
	}

	if (map.size > 0) {
		log('debug', `[Collect] Use the Protel2 standard parser`);
	}
}

/**
 * Generic netlist parser (global regex matching)
 *
 * Search the entire netlist text for Designator-Pin patterns,
 * and infer the net name from context.
 * Supports multiple variant formats.
 */
function parseNetlistGeneric(netlistRaw: string, map: Map<string, string>): void {
	const lines = netlistRaw.split('\n');
	let currentNet = '';
	let lastOpenParen = '';

	for (const line of lines) {
		const trimmed = line.trim();

		// Track blocks that start with "(" - they may be net names
		const parenMatch = trimmed.match(/^\(\s*([^\s)]+)\s*$/);
		if (parenMatch) {
			const content = parenMatch[1];
			// If the content is neither a brace comment nor a Designator-Pin format
			if (!content.startsWith('{') && !content.match(/^[A-Z]\S*-\d/)) {
				lastOpenParen = content;
			}
			continue;
		}

		// Match Designator-Pin patterns (loose)
		const pinMatch = trimmed.match(/^([A-Z][A-Z0-9]*\d)-(\S+)$/);
		if (pinMatch && lastOpenParen) {
			currentNet = lastOpenParen;
			map.set(`${pinMatch[1]}_${pinMatch[2]}`, currentNet);
			continue;
		}

		// A standalone ) ends the current block
		if (trimmed === ')') {
			lastOpenParen = '';
			currentNet = '';
		}
	}

	if (map.size > 0) {
		log('debug', `[Collect] Use the generic parser`);
	}
}

/**
 * Find nets by wire-coordinate proximity
 */
function _findNetByWireProximity(
	pinX: number,
	pinY: number,
	wires: Array<{ net: string; lines: number[][] }>,
): string | null {
	const TOLERANCE = 50; // increase tolerance to match pin offsets (50 * 0.01inch = 0.5 inch)

	for (const wire of wires) {
		if (!wire.net)
			continue;

		for (const line of wire.lines) {
			// line format: [x1, y1, x2, y2, ...]
			for (let i = 0; i < line.length; i += 2) {
				const wx = line[i];
				const wy = line[i + 1];
				if (wx === undefined || wy === undefined)
					continue;

				const distance = Math.sqrt((pinX - wx) ** 2 + (pinY - wy) ** 2);
				if (distance <= TOLERANCE) {
					return wire.net;
				}
			}
		}
	}

	return null;
}

/**
 * Diagnostic helper: find the distance to the nearest wire endpoint (used to judge whether tolerance is appropriate)
 */
function findNearestWireDistance(
	pinX: number,
	pinY: number,
	validWires: Array<{ net: string; lines: number[][] }>,
	emptyWires: Array<{ lines: number[][] }>,
): { distance: number; net: string | null } | null {
	let nearest: { distance: number; net: string | null } | null = null;

	const allWires: Array<{ net: string | null; lines: number[][] }> = [
		...validWires.map(w => ({ net: w.net as string | null, lines: w.lines })),
		...emptyWires.map(w => ({ net: null as string | null, lines: w.lines })),
	];

	for (const wire of allWires) {
		for (const line of wire.lines) {
			for (let i = 0; i < line.length; i += 2) {
				const wx = line[i];
				const wy = line[i + 1];
				if (wx === undefined || wy === undefined)
					continue;

				const distance = Math.sqrt((pinX - wx) ** 2 + (pinY - wy) ** 2);
				if (!nearest || distance < nearest.distance) {
					nearest = { distance, net: wire.net };
				}
			}
		}
	}

	return nearest;
}

/**
 * Diagnostic helper: find the distance to the nearest net label
 */
function findNearestLabelDistance(
	pinX: number,
	pinY: number,
	netLabels: RawNetLabel[],
): { distance: number; net: string } | null {
	let nearest: { distance: number; net: string } | null = null;

	for (const label of netLabels) {
		if (!label.netName)
			continue;

		const distance = Math.sqrt((pinX - label.x) ** 2 + (pinY - label.y) ** 2);
		if (!nearest || distance < nearest.distance) {
			nearest = { distance, net: label.netName };
		}
	}

	return nearest;
}

/**
 * Diagnostic helper: find the distance to the nearest wire-topology point
 */
function findNearestTopoDistance(
	pinX: number,
	pinY: number,
	wireClusters: WireCluster[],
): { distance: number } | null {
	let nearest: { distance: number } | null = null;

	for (const cluster of wireClusters) {
		for (const point of cluster.points) {
			const dist = Math.sqrt((pinX - point.x) ** 2 + (pinY - point.y) ** 2);
			if (!nearest || dist < nearest.distance) {
				nearest = { distance: dist };
			}
		}
	}

	return nearest;
}

/**
 * Find nets by net-label coordinate proximity
 * Third-layer strategy for pin-net binding (L3)
 */
function _findNetByLabelProximity(
	pinX: number,
	pinY: number,
	netLabels: RawNetLabel[],
): string | null {
	const TOLERANCE = 100; // Increase tolerance to cover connections through wires in the middle of a segment
	let bestNet: string | null = null;
	let bestDistance = TOLERANCE;

	for (const label of netLabels) {
		if (!label.netName)
			continue;

		const distance = Math.sqrt((pinX - label.x) ** 2 + (pinY - label.y) ** 2);
		if (distance <= bestDistance) {
			bestDistance = distance;
			bestNet = label.netName;
		}
	}

	return bestNet;
}

/**
 * Wire topology cluster (data structure for the L4 strategy)
 */
interface WireCluster {
	id: string;
	netName: string | null;
	points: Array<{ x: number; y: number }>;
	confidence: number; // 0.5=infer, 0.6=empty wires, 0.7=label, 0.8=wire net
}

/**
 * L4: Build the wire topology graph
 * Infer the net via the physical connectivity of wires, even when the wire net property is empty
 */
function buildWireTopology(
	validWires: Array<{ net: string; lines: number[][] }>,
	emptyWires: Array<{ lines: number[][] }>,
	netLabels: RawNetLabel[],
): WireCluster[] {
	const CONNECT_TOLERANCE = 15; // Wire endpoint connection tolerance (increased to match grid offsets)

	// 1. Collect all wire segments
	interface WireSegment {
		net: string | null;
		points: Array<{ x: number; y: number }>;
	}

	const allSegments: WireSegment[] = [];

	// Wires with nets
	for (const wire of validWires) {
		for (const line of wire.lines) {
			const points: Array<{ x: number; y: number }> = [];
			for (let i = 0; i < line.length; i += 2) {
				if (line[i] !== undefined && line[i + 1] !== undefined) {
					points.push({ x: line[i], y: line[i + 1] });
				}
			}
			if (points.length >= 2) {
				allSegments.push({ net: wire.net, points });
			}
		}
	}

	// Wires with empty nets
	for (const wire of emptyWires) {
		for (const line of wire.lines) {
			const points: Array<{ x: number; y: number }> = [];
			for (let i = 0; i < line.length; i += 2) {
				if (line[i] !== undefined && line[i + 1] !== undefined) {
					points.push({ x: line[i], y: line[i + 1] });
				}
			}
			if (points.length >= 2) {
				allSegments.push({ net: null, points });
			}
		}
	}

	if (allSegments.length === 0) {
		return [];
	}

	// 2. Use union-find to build connected components
	const parent = new Map<number, number>();
	const rank = new Map<number, number>();

	function find(x: number): number {
		if (!parent.has(x)) {
			parent.set(x, x);
			rank.set(x, 0);
		}
		if (parent.get(x) !== x) {
			parent.set(x, find(parent.get(x)!));
		}
		return parent.get(x)!;
	}

	function union(x: number, y: number): void {
		const rootX = find(x);
		const rootY = find(y);
		if (rootX === rootY)
			return;

		const rankX = rank.get(rootX) || 0;
		const rankY = rank.get(rootY) || 0;

		if (rankX < rankY) {
			parent.set(rootX, rootY);
		}
		else if (rankX > rankY) {
			parent.set(rootY, rootX);
		}
		else {
			parent.set(rootY, rootX);
			rank.set(rootX, rankX + 1);
		}
	}

	// 3. Connect adjacent wire segments
	for (let i = 0; i < allSegments.length; i++) {
		for (let j = i + 1; j < allSegments.length; j++) {
			const seg1 = allSegments[i];
			const seg2 = allSegments[j];

			// Check whether the endpoints of two segments are close
			for (const p1 of seg1.points) {
				for (const p2 of seg2.points) {
					const dist = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
					if (dist < CONNECT_TOLERANCE) {
						union(i, j);
					}
				}
			}
		}
	}

	// 4. Group by connected component
	const clusters = new Map<number, number[]>();
	for (let i = 0; i < allSegments.length; i++) {
		const root = find(i);
		if (!clusters.has(root)) {
			clusters.set(root, []);
		}
		clusters.get(root)!.push(i);
	}

	// 5. Determine the net name for each connected component
	const wireClusters: WireCluster[] = [];
	let clusterIndex = 0;

	for (const [_root, segmentIndices] of clusters.entries()) {
		// Collect all points in this connected component
		const allPoints: Array<{ x: number; y: number }> = [];
		let netFromWire: string | null = null;

		for (const idx of segmentIndices) {
			const seg = allSegments[idx];
			allPoints.push(...seg.points);
			if (seg.net && !netFromWire) {
				netFromWire = seg.net;
			}
		}

		// Prefer the wire's built-in net
		let netName = netFromWire;
		let confidence = netFromWire ? 0.8 : 0.6;

		// If a wire has no net, try inferring it from net labels
		if (!netName) {
			const LABEL_TOLERANCE = 100;
			for (const label of netLabels) {
				for (const point of allPoints) {
					const dist = Math.sqrt((point.x - label.x) ** 2 + (point.y - label.y) ** 2);
					if (dist < LABEL_TOLERANCE) {
						netName = label.netName;
						confidence = 0.7;
						break;
					}
				}
				if (netName)
					break;
			}
		}

		// If there is still no name, assign a temporary one
		if (!netName) {
			netName = `WIRE_CLUSTER_${String(clusterIndex + 1).padStart(3, '0')}`;
			confidence = 0.5;
		}

		wireClusters.push({
			id: `cluster_${clusterIndex}`,
			netName,
			points: allPoints,
			confidence,
		});

		clusterIndex++;
	}

	log('debug', `[L4 topology] Built ${wireClusters.length} wire clusters`);

	return wireClusters;
}

/**
 * L4: Find nets via wire topology
 */
function _findNetByWireTopology(
	pinX: number,
	pinY: number,
	wireClusters: WireCluster[],
): { netName: string; confidence: number } | null {
	const TOLERANCE = 50; // Increase tolerance to match pin offsets

	for (const cluster of wireClusters) {
		for (const point of cluster.points) {
			const dist = Math.sqrt((pinX - point.x) ** 2 + (pinY - point.y) ** 2);
			if (dist <= TOLERANCE) {
				return {
					netName: cluster.netName!,
					confidence: cluster.confidence,
				};
			}
		}
	}

	return null;
}

/**
 * Build net statistics
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
