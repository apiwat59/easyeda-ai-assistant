/**
 * eda-mcp-server - MCP Server
 *
 * Register Resources and Tools via @modelcontextprotocol/sdk,
 * exposing schematic data to external AI tools (Cursor, Claude Code, Codex).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SnapshotStore } from './snapshot-store.js';
import type { WsBridge } from './ws-bridge.js';

export interface McpServerOptions {
	store: SnapshotStore;
	bridge: WsBridge;
	logger?: (level: string, message: string, data?: unknown) => void;
}

/**
 * Create and configure an MCP Server instance
 */
export function createMcpServer(options: McpServerOptions): McpServer {
	const { store, bridge } = options;
	const log = options.logger ?? ((level, msg) => console.log(`[mcp-server] [${level}] ${msg}`));

	const server = new McpServer({
		name: 'eda-mcp-server',
		version: '0.1.0',
	});

	// ============ Resources ============

	// eda://schematic/status - connection status and version info
	server.resource('schematic-status', 'eda://schematic/status', async () => {
		const snapshot = store.get();
		const clientInfo = bridge.getClientInfo();

		return {
			contents: [{
				uri: 'eda://schematic/status',
				mimeType: 'application/json',
				text: JSON.stringify({
					connected: clientInfo.connected,
					app: clientInfo.connected
						? { name: clientInfo.appName, version: clientInfo.appVersion }
						: null,
					snapshotVersion: snapshot?.version ?? 0,
					snapshotTimestamp: snapshot?.timestamp ?? null,
					receivedAt: snapshot?.receivedAt ?? null,
					projectName: snapshot?.projectName ?? null,
					projectUuid: snapshot?.projectUuid ?? null,
					hasData: store.hasData(),
				}, null, 2),
			}],
		};
	});

	// eda://schematic/summary - high-level summary
	server.resource('schematic-summary', 'eda://schematic/summary', async () => {
		const snapshot = store.get();
		if (!snapshot) {
			return { contents: [{ uri: 'eda://schematic/summary', mimeType: 'application/json', text: '{"error":"No data available"}' }] };
		}

		const data = snapshot.data;
		return {
			contents: [{
				uri: 'eda://schematic/summary',
				mimeType: 'application/json',
				text: JSON.stringify({
					projectName: data.projectInfo?.projectName ?? '(unknown)',
					projectUuid: data.projectInfo?.projectUuid ?? '',
					totalComponents: data.components.length,
					totalPins: data.pins.length,
					totalNets: data.nets.length,
					totalTexts: data.texts?.length ?? 0,
					totalBuses: data.buses?.length ?? 0,
					totalNetLabels: data.netLabels?.length ?? 0,
					drcPassed: data.drcResult?.passed ?? null,
					drcStrict: data.drcResult?.strict ?? null,
					collectionQuality: data.meta?.quality ?? 'unknown',
					timestamp: data.timestamp,
				}, null, 2),
			}],
		};
	});

	// eda://schematic/components - full component list
	server.resource('schematic-components', 'eda://schematic/components', async () => {
		const snapshot = store.get();
		if (!snapshot) {
			return { contents: [{ uri: 'eda://schematic/components', mimeType: 'application/json', text: '[]' }] };
		}

		return {
			contents: [{
				uri: 'eda://schematic/components',
				mimeType: 'application/json',
				text: JSON.stringify(snapshot.data.components, null, 2),
			}],
		};
	});

	// eda://schematic/pins - full pin list
	server.resource('schematic-pins', 'eda://schematic/pins', async () => {
		const snapshot = store.get();
		if (!snapshot) {
			return { contents: [{ uri: 'eda://schematic/pins', mimeType: 'application/json', text: '[]' }] };
		}

		return {
			contents: [{
				uri: 'eda://schematic/pins',
				mimeType: 'application/json',
				text: JSON.stringify(snapshot.data.pins, null, 2),
			}],
		};
	});

	// eda://schematic/nets - full net list
	server.resource('schematic-nets', 'eda://schematic/nets', async () => {
		const snapshot = store.get();
		if (!snapshot) {
			return { contents: [{ uri: 'eda://schematic/nets', mimeType: 'application/json', text: '[]' }] };
		}

		return {
			contents: [{
				uri: 'eda://schematic/nets',
				mimeType: 'application/json',
				text: JSON.stringify(snapshot.data.nets, null, 2),
			}],
		};
	});

	// eda://schematic/drc - DRC check results
	server.resource('schematic-drc', 'eda://schematic/drc', async () => {
		const snapshot = store.get();
		const drc = snapshot?.data.drcResult ?? null;

		return {
			contents: [{
				uri: 'eda://schematic/drc',
				mimeType: 'application/json',
				text: JSON.stringify(drc, null, 2),
			}],
		};
	});

	// eda://schematic/project-info - project metadata
	server.resource('schematic-project-info', 'eda://schematic/project-info', async () => {
		const snapshot = store.get();
		const info = snapshot?.data.projectInfo ?? null;

		return {
			contents: [{
				uri: 'eda://schematic/project-info',
				mimeType: 'application/json',
				text: JSON.stringify(info, null, 2),
			}],
		};
	});

	// eda://schematic/netlist - raw netlist
	server.resource('schematic-netlist', 'eda://schematic/netlist', async () => {
		const snapshot = store.get();
		const netlist = snapshot?.data.netlistRaw ?? '';

		return {
			contents: [{
				uri: 'eda://schematic/netlist',
				mimeType: 'text/plain',
				text: netlist,
			}],
		};
	});

	// eda://schematic/compact - complete compact serialization format (full JSON)
	server.resource('schematic-compact', 'eda://schematic/compact', async () => {
		const snapshot = store.get();
		if (!snapshot) {
			return { contents: [{ uri: 'eda://schematic/compact', mimeType: 'application/json', text: '{"error":"No data available"}' }] };
		}

		// Output the full CollectedData directly as the compact format
		return {
			contents: [{
				uri: 'eda://schematic/compact',
				mimeType: 'application/json',
				text: JSON.stringify(snapshot.data),
			}],
		};
	});

	// ============ Tools ============

	// schematic_status - return connection status and available Resource list
	server.tool('schematic_status', 'Get the EDA extension connection status, data version, and available Resource list', {}, async () => {
		const snapshot = store.get();
		const clientInfo = bridge.getClientInfo();

		const resources = [
			'eda://schematic/status',
			'eda://schematic/summary',
			'eda://schematic/components',
			'eda://schematic/pins',
			'eda://schematic/nets',
			'eda://schematic/drc',
			'eda://schematic/project-info',
			'eda://schematic/netlist',
			'eda://schematic/compact',
		];

		return {
			content: [{
				type: 'text' as const,
				text: JSON.stringify({
					connected: clientInfo.connected,
					app: clientInfo.connected
						? { name: clientInfo.appName, version: clientInfo.appVersion }
						: null,
					snapshotVersion: snapshot?.version ?? 0,
					hasData: store.hasData(),
					projectName: snapshot?.projectName ?? null,
					availableResources: resources,
				}, null, 2),
			}],
		};
	});

	// query_component - query a single component and its associated pins and nets
	server.tool(
		'query_component',
		'Query detailed information for a single component by designator, including all of its pins and connected nets',
		{ designator: z.string().describe('Component designator, such as U1, R3, or C5') },
		async ({ designator }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available. Please open a schematic in EDA."}' }] };
			}

			const upper = designator.toUpperCase();
			const component = snapshot.data.components.find(
				(c) => c.designator.toUpperCase() === upper,
			);

			if (!component) {
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({ error: `Component "${designator}" not found`, availableDesignators: snapshot.data.components.slice(0, 20).map(c => c.designator) }, null, 2),
					}],
				};
			}

			// Find all pins for this component
			const pins = snapshot.data.pins.filter(
				(p) => p.componentDesignator.toUpperCase() === upper,
			);

			// Collect the connected net names
			const connectedNets = [...new Set(pins.map(p => p.netName).filter(Boolean))];

			// Look up the full information for these nets
			const nets = snapshot.data.nets.filter(
				(n) => connectedNets.includes(n.netName),
			);

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({ component, pins, connectedNets: nets }, null, 2),
				}],
			};
		},
	);

	// query_net - query a single net and its connected pins and components
	server.tool(
		'query_net',
		'Query all pins and components connected to a net by name',
		{ netName: z.string().describe('Net name, such as GND, VCC_3V3, or NET_SPI_CLK') },
		async ({ netName: rawNetName }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available. Please open a schematic in EDA."}' }] };
			}

			const netName = rawNetName.trim();
			if (!netName) {
				return { content: [{ type: 'text' as const, text: '{"error":"Net name cannot be empty"}' }] };
			}

			// Prefer exact matching; fall back to case-insensitive matching
			let net = snapshot.data.nets.find(
				(n) => n.netName === netName,
			);
			if (!net) {
				const netUpper = netName.toUpperCase();
				const ciMatches = snapshot.data.nets.filter(
					(n) => n.netName.toUpperCase() === netUpper,
				);
				if (ciMatches.length === 1) {
					net = ciMatches[0];
				} else if (ciMatches.length > 1) {
					// Case ambiguity: multiple net names differ only by case, so return a candidate list
					return {
						content: [{
							type: 'text' as const,
							text: JSON.stringify({
								error: `Ambiguous net name "${netName}" (case-insensitive match found ${ciMatches.length} candidates)`,
								suggestions: ciMatches.map(n => n.netName),
							}, null, 2),
						}],
					};
				}
			}

			if (!net) {
				// Fuzzy search candidates
				const netLower = netName.toLowerCase();
				const candidates = snapshot.data.nets
					.filter(n => n.netName.toLowerCase().includes(netLower))
					.slice(0, 10);

				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							error: `Net "${netName}" not found`,
							suggestions: candidates.map(n => n.netName),
						}, null, 2),
					}],
				};
			}

			// Find all pins connected to this net (use the actual netName for exact matching)
			const actualNetName = net.netName;
			const pins = snapshot.data.pins.filter(
				(p) => p.netName === actualNetName,
			);

			// Collect the involved component designators
			const designators = [...new Set(pins.map(p => p.componentDesignator))];

			// Look up the detailed information for these components
			const components = snapshot.data.components.filter(
				(c) => designators.includes(c.designator),
			);

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({ net, pins, connectedComponents: components }, null, 2),
				}],
			};
		},
	);

	// search_schematic - keyword search
	server.tool(
		'search_schematic',
		'Search schematic data by keyword (across component names, net names, and pin names), with optional type filtering',
		{
			keyword: z.string().describe('Search keyword'),
			type: z.enum(['component', 'net', 'pin', 'all']).optional().describe('Search scope: component/net/pin/all, default is all'),
		},
		async ({ keyword, type }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available. Please open a schematic in EDA."}' }] };
			}

			const kw = keyword.toLowerCase();
			const searchType = type ?? 'all';
			const results: Record<string, unknown[]> = {};

			// Search components
			if (searchType === 'all' || searchType === 'component') {
				results.components = snapshot.data.components.filter((c) =>
					c.designator.toLowerCase().includes(kw)
					|| c.name.toLowerCase().includes(kw)
					|| c.value.toLowerCase().includes(kw)
					|| c.manufacturer.toLowerCase().includes(kw)
					|| c.manufacturerPartNumber.toLowerCase().includes(kw)
					|| c.lcscPart.toLowerCase().includes(kw),
				).slice(0, 50);
			}

			// Search nets
			if (searchType === 'all' || searchType === 'net') {
				results.nets = snapshot.data.nets.filter((n) =>
					n.netName.toLowerCase().includes(kw),
				).slice(0, 50);
			}

			// Search pins
			if (searchType === 'all' || searchType === 'pin') {
				results.pins = snapshot.data.pins.filter((p) =>
					p.pinName.toLowerCase().includes(kw)
					|| p.pinNumber.toLowerCase().includes(kw)
					|| (p.netName && p.netName.toLowerCase().includes(kw)),
				).slice(0, 50);
			}

			const totalResults = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						keyword,
						searchType,
						totalResults,
						...results,
					}, null, 2),
				}],
			};
		},
	);

	// configure_bridge - dynamically modify the WS Bridge listen address
	server.tool(
		'configure_bridge',
		'Change the WebSocket Bridge listen address and port for receiving remote connections from the EDA extension. The WS service is automatically restarted after changes.',
		{
			host: z.string().optional().describe('Listen address, such as 0.0.0.0 (all interfaces) or 127.0.0.1 (local only); unchanged by default'),
			port: z.number().int().min(1).max(65535).optional().describe('Listen port (1-65535), such as 3100; unchanged by default'),
		},
		async ({ host, port }) => {
			const current = bridge.getListenInfo();
			const nextHost = host ?? current.host;
			const nextPort = port ?? current.port;

			if (nextHost === current.host && nextPort === current.port) {
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							message: 'Configuration unchanged',
							host: current.host,
							port: current.port,
							connected: bridge.isClientConnected(),
						}, null, 2),
					}],
				};
			}

			try {
				await bridge.restart(nextHost, nextPort);
				log('info', `WS Bridge restarted: ${nextHost}:${nextPort}`);
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							message: `WS Bridge restarted and listening on ${nextHost}:${nextPort}`,
							host: nextHost,
							port: nextPort,
							previousHost: current.host,
							previousPort: current.port,
						}, null, 2),
					}],
				};
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							error: `WS Bridge restart failed: ${errMsg}`,
							host: current.host,
							port: current.port,
						}, null, 2),
					}],
				};
			}
		},
	);

	// ============ Additional Tools ============

	// get_bom - generate a BOM materials list
	server.tool(
		'get_bom',
		'Generate a BOM (bill of materials), grouped by a composite of value + part number + LCSC number, and filter out components excluded from the BOM',
		{
			includeBomExcluded: z.boolean().optional().describe('Whether to include components marked as excluded from the BOM; default is false'),
		},
		async ({ includeBomExcluded }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			// Filter out components excluded from the BOM
			const components = includeBomExcluded
				? snapshot.data.components
				: snapshot.data.components.filter(c => c.bomInclude !== 'false' && c.bomInclude !== '0');

			// Group by composite key: value + manufacturerPartNumber + lcscPart
			const groups = new Map<string, { designators: string[]; name: string; value: string; manufacturer: string; mpn: string; lcscPart: string }>();

			for (const c of components) {
				const compositeKey = `${c.value}||${c.manufacturerPartNumber}||${c.lcscPart}`;
				const existing = groups.get(compositeKey);
				if (existing) {
					existing.designators.push(c.designator);
				} else {
					groups.set(compositeKey, {
						designators: [c.designator],
						name: c.name,
						value: c.value,
						manufacturer: c.manufacturer,
						mpn: c.manufacturerPartNumber,
						lcscPart: c.lcscPart,
					});
				}
			}

			const bom = [...groups.values()]
				.map(info => ({
					quantity: info.designators.length,
					designators: [...info.designators].sort((a, b) =>
						a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
					),
					name: info.name,
					value: info.value,
					manufacturer: info.manufacturer,
					mpn: info.mpn,
					lcscPart: info.lcscPart,
				}))
				.sort((a, b) => b.quantity - a.quantity);

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						totalUniqueItems: bom.length,
						totalComponents: components.length,
						bomExcludedCount: snapshot.data.components.length - components.length,
						bom,
					}, null, 2),
				}],
			};
		},
	);

	// find_unconnected_pins - find unconnected pins
	server.tool(
		'find_unconnected_pins',
		'Find floating pins in the schematic that are not connected to any net, for troubleshooting wiring omissions. Distinguishes between "unconnected" and "unresolved" states',
		{
			designator: z.string().optional().describe('Optional: only inspect the pins of a specified component, such as U1'),
		},
		async ({ designator }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			let pins = snapshot.data.pins;
			if (designator) {
				const upper = designator.toUpperCase();
				const exists = snapshot.data.components.some(c => c.designator.toUpperCase() === upper);
				if (!exists) {
					return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Component "${designator}" not found` }, null, 2) }] };
				}
				pins = pins.filter(p => p.componentDesignator.toUpperCase() === upper);
			}

			const unconnected = pins.filter(p => !p.netName);

			// Group by component, distinguishing unresolved from truly unconnected pins
			const byComponent = new Map<string, { pinNumber: string; pinName: string; pinType: string; reason: string }[]>();
			for (const p of unconnected) {
				const list = byComponent.get(p.componentDesignator) ?? [];
				list.push({
					pinNumber: p.pinNumber,
					pinName: p.pinName,
					pinType: p.pinType,
					reason: p.netBindingReason === 'unresolved' ? 'unresolved' : 'unconnected',
				});
				byComponent.set(p.componentDesignator, list);
			}

			const grouped = [...byComponent.entries()]
				.map(([des, pinList]) => ({ designator: des, pins: pinList, count: pinList.length }))
				.sort((a, b) => b.count - a.count);

			const unresolvedCount = unconnected.filter(p => p.netBindingReason === 'unresolved').length;

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						totalUnconnected: unconnected.length,
						trulyUnconnected: unconnected.length - unresolvedCount,
						unresolvedBinding: unresolvedCount,
						totalPinsChecked: pins.length,
						components: grouped,
					}, null, 2),
				}],
			};
		},
	);

	// analyze_power_nets - analyze power nets
	server.tool(
		'analyze_power_nets',
		'Automatically identify power and ground nets (VCC, GND, VDD, etc.) and list the components and pins connected to each power net',
		{},
		async () => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			const powerPatterns = /^(\+?\d+V\d*|VCC|VDD|VBUS|VBAT|VIN|VSYS|VREF|VOUT|VEE|V3V3|V5V|V1V8|3V3|3\.3V|5V|12V|1V8|1\.8V|2\.5V|GND|AGND|DGND|PGND|VSS|AVCC|AVDD|DVCC|DVDD|VDDIO|VCCIO|SYS_\d+V)/i;
			const powerNets = snapshot.data.nets.filter(n => powerPatterns.test(n.netName));

			const result = powerNets.map(net => {
				const pins = snapshot.data.pins.filter(p => p.netName === net.netName);
				const components = [...new Set(pins.map(p => p.componentDesignator))];
				return {
					netName: net.netName,
					pinCount: net.pinCount,
					connectedComponents: components,
					pins: pins.map(p => ({
						component: p.componentDesignator,
						pin: `${p.pinNumber} (${p.pinName})`,
						pinType: p.pinType,
					})),
				};
			}).sort((a, b) => b.pinCount - a.pinCount);

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						totalPowerNets: result.length,
						powerNets: result,
					}, null, 2),
				}],
			};
		},
	);

	// check_drc - view DRC results
	server.tool(
		'check_drc',
		'View the schematic DRC (design rule check) results, including pass/fail status, check mode, and timestamp',
		{},
		async () => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			const drc = snapshot.data.drcResult;
			if (!drc) {
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({ status: 'no_drc_data', message: 'There is no DRC result in the current snapshot; the DRC check may not have been run yet' }, null, 2),
					}],
				};
			}

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						passed: drc.passed,
						strict: drc.strict,
						timestamp: drc.timestamp,
						timestampFormatted: new Date(drc.timestamp).toISOString(),
						summary: drc.passed
							? (drc.strict ? 'DRC strict mode passed' : 'DRC basic mode passed')
							: (drc.strict ? 'DRC strict mode failed' : 'DRC basic mode failed'),
					}, null, 2),
				}],
			};
		},
	);

	// refresh_data - request the EDA extension to resend data
	server.tool(
		'refresh_data',
		'Request the EDA extension to resend the latest schematic data, useful for manually refreshing potentially stale data',
		{},
		async () => {
			if (!bridge.isClientConnected()) {
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({ error: 'The EDA extension is not connected, so data refresh cannot be requested' }, null, 2),
					}],
				};
			}

			bridge.requestData();
			const currentVersion = store.getVersion();

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						message: 'A data refresh request has been sent to the EDA extension; the data will update automatically shortly',
						currentVersion,
					}, null, 2),
				}],
			};
		},
	);

	// trace_connectivity - connectivity path between two components
	server.tool(
		'trace_connectivity',
		'Find the electrical connection path between two components (direct shared nets + one-hop indirect paths) for signal-flow analysis',
		{
			from: z.string().describe('Starting component designator, such as U1'),
			to: z.string().describe('Target component designator, such as U2'),
		},
		async ({ from, to }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			const fromUpper = from.toUpperCase();
			const toUpper = to.toUpperCase();

			// Prebuild indexes: net -> pins[], designator -> nets[]
			const netToPins = new Map<string, typeof snapshot.data.pins>();
			const desToNets = new Map<string, Set<string>>();

			for (const p of snapshot.data.pins) {
				if (!p.netName) continue;
				const des = p.componentDesignator.toUpperCase();

				const pinList = netToPins.get(p.netName) ?? [];
				pinList.push(p);
				netToPins.set(p.netName, pinList);

				const netSet = desToNets.get(des) ?? new Set();
				netSet.add(p.netName);
				desToNets.set(des, netSet);
			}

			const fromNets = desToNets.get(fromUpper);
			const toNets = desToNets.get(toUpper);

			if (!fromNets || fromNets.size === 0) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Component "${from}" not found or has no connected nets` }, null, 2) }] };
			}
			if (!toNets || toNets.size === 0) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Component "${to}" not found or has no connected nets` }, null, 2) }] };
			}

			// Direct connection: share the same net
			const directNets = [...fromNets].filter(n => toNets.has(n));
			const directPaths = directNets.map(netName => {
				const allPins = netToPins.get(netName) ?? [];
				const fPin = allPins.filter(p => p.componentDesignator.toUpperCase() === fromUpper);
				const tPin = allPins.filter(p => p.componentDesignator.toUpperCase() === toUpper);
				return {
					netName,
					fromPins: fPin.map(p => `${p.pinNumber} (${p.pinName})`),
					toPins: tPin.map(p => `${p.pinNumber} (${p.pinName})`),
				};
			});

			// Indirect connection (one hop): always calculate through an intermediate component
			const indirectSet = new Set<string>();
			const indirectPaths: { netFrom: string; middleComponent: string; netTo: string }[] = [];

			for (const fNet of fromNets) {
				const pinsOnNet = netToPins.get(fNet) ?? [];
				// Find intermediate components on this net
				const middleDesignators = new Set<string>();
				for (const p of pinsOnNet) {
					const des = p.componentDesignator.toUpperCase();
					if (des !== fromUpper && des !== toUpper) {
						middleDesignators.add(des);
					}
				}
				// Check whether the intermediate component is also connected to a net of the target component
				for (const midDes of middleDesignators) {
					const midNets = desToNets.get(midDes);
					if (!midNets) continue;
					for (const midNet of midNets) {
						if (midNet !== fNet && toNets.has(midNet)) {
							const dedupeKey = `${fNet}|${midDes}|${midNet}`;
							if (!indirectSet.has(dedupeKey)) {
								indirectSet.add(dedupeKey);
								// Retrieve the original-cased designator
								const origDes = (netToPins.get(fNet) ?? []).find(p => p.componentDesignator.toUpperCase() === midDes)?.componentDesignator ?? midDes;
								indirectPaths.push({ netFrom: fNet, middleComponent: origDes, netTo: midNet });
							}
						}
					}
				}
			}

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						from,
						to,
						directConnections: directPaths.length,
						directPaths,
						indirectConnections: indirectPaths.length,
						indirectPaths: indirectPaths.slice(0, 30),
					}, null, 2),
				}],
			};
		},
	);

	// list_components_by_type - list components grouped by type
	server.tool(
		'list_components_by_type',
		'Group and count components by prefix (R resistor, C capacitor, U IC, L inductor, etc.), and list the quantity and designators for each type',
		{},
		async () => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			const groups = new Map<string, string[]>();
			for (const c of snapshot.data.components) {
				const prefix = c.prefix || c.designator.replace(/[0-9]+$/, '') || '?';
				const list = groups.get(prefix) ?? [];
				list.push(c.designator);
				groups.set(prefix, list);
			}

			const prefixNames: Record<string, string> = {
				R: 'resistor', C: 'capacitor', L: 'inductor', U: 'IC/chip', Q: 'transistor/MOSFET',
				D: 'diode', J: 'connector', P: 'plug', SW: 'switch', F: 'fuse',
				LED: 'LED', T: 'transformer', Y: 'crystal', FB: 'ferrite bead', RN: 'resistor network',
			};

			const result = [...groups.entries()]
				.map(([prefix, designators]) => ({
					prefix,
					typeName: prefixNames[prefix] ?? 'other',
					count: designators.length,
					designators: designators.sort((a, b) => {
						const numA = parseInt(a.replace(/\D/g, '')) || 0;
						const numB = parseInt(b.replace(/\D/g, '')) || 0;
						return numA - numB;
					}),
				}))
				.sort((a, b) => b.count - a.count);

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						totalComponents: snapshot.data.components.length,
						totalTypes: result.length,
						groups: result,
					}, null, 2),
				}],
			};
		},
	);

	// get_netlist_raw - get the raw netlist text
	server.tool(
		'get_netlist_raw',
		'Get the raw netlist text, if available, for export or further analysis',
		{},
		async () => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			const netlist = snapshot.data.netlistRaw;
			if (!netlist) {
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({ status: 'no_netlist', message: 'There is no raw netlist data in the current snapshot' }, null, 2),
					}],
				};
			}

			return {
				content: [{
					type: 'text' as const,
					text: netlist,
				}],
			};
		},
	);

	// get_pin_map - component pin map
	server.tool(
		'get_pin_map',
		'Get the complete pin map for a specified component (pin number -> pin name -> connected net), useful for analyzing component wiring',
		{
			designator: z.string().describe('Component designator, such as U1 or U3'),
		},
		async ({ designator }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			const upper = designator.toUpperCase();
			const component = snapshot.data.components.find(
				c => c.designator.toUpperCase() === upper,
			);

			if (!component) {
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({ error: `Component "${designator}" not found` }, null, 2),
					}],
				};
			}

			const pins = snapshot.data.pins
				.filter(p => p.componentDesignator.toUpperCase() === upper)
				.map(p => ({
					pinNumber: p.pinNumber,
					pinName: p.pinName,
					pinType: p.pinType,
					netName: p.netName ?? '(unconnected)',
					connected: p.netName !== null,
				}))
				.sort((a, b) => {
					// Natural sort: pure numbers by numeric value, letter+number values (A1, B2, EP, PAD) by lexicographic order
					const numA = parseInt(a.pinNumber);
					const numB = parseInt(b.pinNumber);
					const aIsNum = !isNaN(numA) && String(numA) === a.pinNumber;
					const bIsNum = !isNaN(numB) && String(numB) === b.pinNumber;
					if (aIsNum && bIsNum) return numA - numB;
					if (aIsNum) return -1;
					if (bIsNum) return 1;
					return a.pinNumber.localeCompare(b.pinNumber, undefined, { numeric: true });
				});

			const connectedCount = pins.filter(p => p.connected).length;

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						component: {
							designator: component.designator,
							name: component.name,
							value: component.value,
							manufacturer: component.manufacturer,
							mpn: component.manufacturerPartNumber,
						},
						totalPins: pins.length,
						connectedPins: connectedCount,
						unconnectedPins: pins.length - connectedCount,
						pinMap: pins,
					}, null, 2),
				}],
			};
		},
	);

	log('info', 'MCP server configured with 9 resources and 14 tools');

	return server;
}
