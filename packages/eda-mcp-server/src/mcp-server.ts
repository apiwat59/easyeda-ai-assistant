/**
 * eda-mcp-server - MCP Server
 *
 * 通过 @modelcontextprotocol/sdk 注册 Resources 和 Tools，
 * 向外部 AI 工具（Cursor、Claude Code、Codex）暴露原理图数据。
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SnapshotStore } from './snapshot-store.js';
import type { WsBridge } from './ws-bridge.js';

export interface McpServerOptions {
	store: SnapshotStore;
	bridge: WsBridge;
	logger?: (level: string, message: string, data?: unknown) => void;
}

/**
 * 创建并配置 MCP Server 实例
 */
export function createMcpServer(options: McpServerOptions): McpServer {
	const { store, bridge } = options;
	const log = options.logger ?? ((level, msg) => console.log(`[mcp-server] [${level}] ${msg}`));

	const server = new McpServer({
		name: 'eda-mcp-server',
		version: '0.1.0',
	});

	// ============ Resources ============

	// eda://schematic/status — 连接状态和版本信息
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

	// eda://schematic/summary — 高层摘要
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

	// eda://schematic/components — 全部器件列表
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

	// eda://schematic/pins — 全部引脚列表
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

	// eda://schematic/nets — 全部网络列表
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

	// eda://schematic/drc — DRC 检查结果
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

	// eda://schematic/project-info — 工程元信息
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

	// eda://schematic/netlist — 原始网表
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

	// eda://schematic/compact — 完整紧凑序列化格式（全量 JSON）
	server.resource('schematic-compact', 'eda://schematic/compact', async () => {
		const snapshot = store.get();
		if (!snapshot) {
			return { contents: [{ uri: 'eda://schematic/compact', mimeType: 'application/json', text: '{"error":"No data available"}' }] };
		}

		// 直接将完整的 CollectedData 作为紧凑格式输出
		return {
			contents: [{
				uri: 'eda://schematic/compact',
				mimeType: 'application/json',
				text: JSON.stringify(snapshot.data),
			}],
		};
	});

	// ============ Tools ============

	// schematic_status — 返回连接状态和可用 Resource 列表
	server.tool('schematic_status', '获取 EDA 扩展连接状态、数据版本和可用 Resource 列表', {}, async () => {
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

	// query_component — 查询单个器件及其关联引脚和网络
	server.tool(
		'query_component',
		'根据位号查询单个器件的详细信息，包括其全部引脚和所连接的网络',
		{ designator: z.string().describe('器件位号，如 U1, R3, C5') },
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

			// 查找该器件的所有引脚
			const pins = snapshot.data.pins.filter(
				(p) => p.componentDesignator.toUpperCase() === upper,
			);

			// 收集关联的网络名
			const connectedNets = [...new Set(pins.map(p => p.netName).filter(Boolean))];

			// 查找这些网络的完整信息
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

	// query_net — 查询单个网络及其连接的引脚和器件
	server.tool(
		'query_net',
		'根据网络名查询该网络连接的所有引脚和器件',
		{ netName: z.string().describe('网络名称，如 GND, VCC_3V3, NET_SPI_CLK') },
		async ({ netName: rawNetName }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available. Please open a schematic in EDA."}' }] };
			}

			const netName = rawNetName.trim();
			if (!netName) {
				return { content: [{ type: 'text' as const, text: '{"error":"Net name cannot be empty"}' }] };
			}

			// 精确匹配优先，失败则回退到大小写不敏感匹配
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
					// 大小写歧义：存在多个仅大小写不同的网络名，返回候选列表
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
				// 模糊搜索候选项
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

			// 查找连接到该网络的所有引脚（使用实际的 netName 进行精确匹配）
			const actualNetName = net.netName;
			const pins = snapshot.data.pins.filter(
				(p) => p.netName === actualNetName,
			);

			// 收集涉及的器件位号
			const designators = [...new Set(pins.map(p => p.componentDesignator))];

			// 查找这些器件的详细信息
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

	// search_schematic — 关键词搜索
	server.tool(
		'search_schematic',
		'在原理图数据中按关键词搜索（跨器件名、网络名、引脚名），支持按类型过滤',
		{
			keyword: z.string().describe('搜索关键词'),
			type: z.enum(['component', 'net', 'pin', 'all']).optional().describe('搜索范围：component/net/pin/all，默认 all'),
		},
		async ({ keyword, type }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available. Please open a schematic in EDA."}' }] };
			}

			const kw = keyword.toLowerCase();
			const searchType = type ?? 'all';
			const results: Record<string, unknown[]> = {};

			// 搜索器件
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

			// 搜索网络
			if (searchType === 'all' || searchType === 'net') {
				results.nets = snapshot.data.nets.filter((n) =>
					n.netName.toLowerCase().includes(kw),
				).slice(0, 50);
			}

			// 搜索引脚
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

	// configure_bridge — 动态修改 WS Bridge 监听地址
	server.tool(
		'configure_bridge',
		'修改 WebSocket Bridge 的监听地址和端口，用于接收 EDA 扩展的远程连接。修改后会自动重启 WS 服务。',
		{
			host: z.string().optional().describe('监听地址，如 0.0.0.0（所有网卡）或 127.0.0.1（仅本地），默认不变'),
			port: z.number().int().min(1).max(65535).optional().describe('监听端口（1-65535），如 3100，默认不变'),
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
							message: '配置未变更',
							host: current.host,
							port: current.port,
							connected: bridge.isClientConnected(),
						}, null, 2),
					}],
				};
			}

			try {
				await bridge.restart(nextHost, nextPort);
				log('info', `WS Bridge 已重启: ${nextHost}:${nextPort}`);
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							message: `WS Bridge 已重启，监听 ${nextHost}:${nextPort}`,
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
							error: `WS Bridge 重启失败: ${errMsg}`,
							host: current.host,
							port: current.port,
						}, null, 2),
					}],
				};
			}
		},
	);

	// ============ 新增 Tools ============

	// get_bom — 生成 BOM 物料清单
	server.tool(
		'get_bom',
		'生成 BOM（物料清单），使用 value+料号+LCSC 编号复合分组，过滤不入 BOM 的器件',
		{
			includeBomExcluded: z.boolean().optional().describe('是否包含标记为不入 BOM 的器件，默认 false'),
		},
		async ({ includeBomExcluded }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			// 过滤不入 BOM 的器件
			const components = includeBomExcluded
				? snapshot.data.components
				: snapshot.data.components.filter(c => c.bomInclude !== 'false' && c.bomInclude !== '0');

			// 复合 key 分组：value + manufacturerPartNumber + lcscPart
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

	// find_unconnected_pins — 查找未连接的引脚
	server.tool(
		'find_unconnected_pins',
		'查找原理图中未连接到任何网络的悬空引脚，用于排查接线遗漏。区分"未连接"和"未解析"两种状态',
		{
			designator: z.string().optional().describe('可选：只检查指定器件的引脚，如 U1'),
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

			// 按器件分组，区分 unresolved 和真正 unconnected
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

	// analyze_power_nets — 分析电源网络
	server.tool(
		'analyze_power_nets',
		'自动识别电源和地网络（VCC、GND、VDD 等），列出每个电源网连接的器件和引脚',
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

	// check_drc — 查看 DRC 结果
	server.tool(
		'check_drc',
		'查看原理图的 DRC（设计规则检查）结果，包括是否通过、检查模式和时间戳',
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
						text: JSON.stringify({ status: 'no_drc_data', message: '当前快照中没有 DRC 检查结果，可能尚未执行 DRC 检查' }, null, 2),
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
							? (drc.strict ? 'DRC 严格模式通过' : 'DRC 基本模式通过')
							: (drc.strict ? 'DRC 严格模式未通过' : 'DRC 基本模式未通过'),
					}, null, 2),
				}],
			};
		},
	);

	// refresh_data — 请求 EDA 扩展重新推送数据
	server.tool(
		'refresh_data',
		'请求 EDA 扩展重新推送最新的原理图数据，用于数据可能过期时主动刷新',
		{},
		async () => {
			if (!bridge.isClientConnected()) {
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({ error: 'EDA 扩展未连接，无法请求数据刷新' }, null, 2),
					}],
				};
			}

			bridge.requestData();
			const currentVersion = store.getVersion();

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						message: '已向 EDA 扩展发送数据刷新请求，稍后数据将自动更新',
						currentVersion,
					}, null, 2),
				}],
			};
		},
	);

	// trace_connectivity — 两器件间的连通路径
	server.tool(
		'trace_connectivity',
		'查找两个器件之间的电气连接路径（直接共享网络 + 一跳间接路径），用于分析信号走向',
		{
			from: z.string().describe('起始器件位号，如 U1'),
			to: z.string().describe('目标器件位号，如 U2'),
		},
		async ({ from, to }) => {
			const snapshot = store.get();
			if (!snapshot) {
				return { content: [{ type: 'text' as const, text: '{"error":"No schematic data available."}' }] };
			}

			const fromUpper = from.toUpperCase();
			const toUpper = to.toUpperCase();

			// 预建索引：net → pins[], designator → nets[]
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

			// 直接连接：共享同一网络
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

			// 间接连接（一跳）：始终计算，通过中间器件
			const indirectSet = new Set<string>();
			const indirectPaths: { netFrom: string; middleComponent: string; netTo: string }[] = [];

			for (const fNet of fromNets) {
				const pinsOnNet = netToPins.get(fNet) ?? [];
				// 找到该网络上的中间器件
				const middleDesignators = new Set<string>();
				for (const p of pinsOnNet) {
					const des = p.componentDesignator.toUpperCase();
					if (des !== fromUpper && des !== toUpper) {
						middleDesignators.add(des);
					}
				}
				// 检查中间器件是否也连接到 to 的网络
				for (const midDes of middleDesignators) {
					const midNets = desToNets.get(midDes);
					if (!midNets) continue;
					for (const midNet of midNets) {
						if (midNet !== fNet && toNets.has(midNet)) {
							const dedupeKey = `${fNet}|${midDes}|${midNet}`;
							if (!indirectSet.has(dedupeKey)) {
								indirectSet.add(dedupeKey);
								// 获取原始大小写的位号
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

	// list_components_by_type — 按类型分组列出器件
	server.tool(
		'list_components_by_type',
		'按器件前缀（R 电阻、C 电容、U IC、L 电感等）分组统计，列出各类型数量和位号',
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
				R: '电阻', C: '电容', L: '电感', U: 'IC/芯片', Q: '三极管/MOS管',
				D: '二极管', J: '连接器', P: '插头', SW: '开关', F: '保险丝',
				LED: 'LED', T: '变压器', Y: '晶振', FB: '磁珠', RN: '排阻',
			};

			const result = [...groups.entries()]
				.map(([prefix, designators]) => ({
					prefix,
					typeName: prefixNames[prefix] ?? '其他',
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

	// get_netlist_raw — 获取原始网表文本
	server.tool(
		'get_netlist_raw',
		'获取原始网表文本（若可用），可用于导出或进一步分析',
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
						text: JSON.stringify({ status: 'no_netlist', message: '当前快照中没有原始网表数据' }, null, 2),
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

	// get_pin_map — 器件引脚映射表
	server.tool(
		'get_pin_map',
		'获取指定器件的完整引脚映射表（引脚号 → 引脚名 → 所连网络），便于分析器件接线',
		{
			designator: z.string().describe('器件位号，如 U1, U3'),
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
					// 自然排序：纯数字按数值，字母+数字（A1, B2, EP, PAD）按字典序
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
