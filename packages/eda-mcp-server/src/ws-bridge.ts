/**
 * eda-mcp-server - WebSocket Bridge
 *
 * 接收来自 EDA 扩展的 WS 连接，处理 hello/snapshot/pong 消息。
 * 在收到 snapshot 后更新 SnapshotStore。
 */
import { WebSocketServer, WebSocket } from 'ws';
import type {
	BridgeHelloMessage,
	BridgeInboundMessage,
	BridgeSnapshotMessage,
	ServerAckMessage,
	ServerPingMessage,
	ServerRequestDataMessage,
} from './types.js';
import type { SnapshotStore } from './snapshot-store.js';

/** 心跳间隔（每 15 秒发送一次 ping） */
const PING_INTERVAL_MS = 15_000;

/** 连接超时（60 秒无消息则断开） */
const CONNECTION_TIMEOUT_MS = 60_000;

export interface WsBridgeOptions {
	port: number;
	host?: string;
	store: SnapshotStore;
	onSnapshot?: (version: number) => void;
	logger?: (level: string, message: string, data?: unknown) => void;
}

interface ClientState {
	ws: WebSocket;
	appName: string;
	appVersion: string;
	projectUuid: string;
	projectName: string;
	connectedAt: number;
	lastMessageAt: number;
	pingTimer: ReturnType<typeof setInterval> | null;
	pingNonce: number;
}

export class WsBridge {
	private wss: WebSocketServer | null = null;
	private client: ClientState | null = null;
	private readonly store: SnapshotStore;
	private port: number;
	private host: string;
	private readonly onSnapshot?: (version: number) => void;
	private readonly log: (level: string, message: string, data?: unknown) => void;

	constructor(options: WsBridgeOptions) {
		this.store = options.store;
		this.port = options.port;
		this.host = options.host ?? '127.0.0.1';
		this.onSnapshot = options.onSnapshot;
		this.log = options.logger ?? ((level, msg) => console.log(`[ws-bridge] [${level}] ${msg}`));
	}

	/**
	 * 启动 WebSocket 服务
	 */
	start(): Promise<void> {
		if (this.wss) return Promise.resolve();

		return new Promise((resolve, reject) => {
			const wss = new WebSocketServer({ port: this.port, host: this.host });

			const onStartupError = (error: Error) => {
				// 启动失败：不保留 wss 引用，允许重试
				this.log('error', `WebSocket server failed to start: ${error.message}`);
				reject(error);
			};

			wss.once('listening', () => {
				// 启动成功：移除启动期 error 处理器，注册运行期处理器
				wss.removeListener('error', onStartupError);
				this.wss = wss;
				wss.on('error', (error) => {
					this.log('error', `WebSocket server error: ${error.message}`);
				});
				wss.on('connection', (ws) => this.handleConnection(ws));
				this.log('info', `WebSocket server listening on ws://${this.host}:${this.port}`);
				resolve();
			});

			wss.once('error', onStartupError);
		});
	}

	/**
	 * 停止 WebSocket 服务
	 */
	stop(): Promise<void> {
		this.cleanupClient();
		if (!this.wss) return Promise.resolve();

		return new Promise((resolve) => {
			const wss = this.wss!;
			this.wss = null;
			wss.close(() => resolve());
		});
	}

	/**
	 * 用新的 host/port 重启 WebSocket 服务
	 *
	 * 等待旧服务完全关闭后再启动新服务，避免端口竞态。
	 * 启动失败时回滚 host/port 到变更前的值。
	 */
	async restart(host: string, port: number): Promise<void> {
		const prevHost = this.host;
		const prevPort = this.port;
		await this.stop();
		this.host = host;
		this.port = port;
		try {
			await this.start();
		} catch (error) {
			// 启动失败，回滚配置并尝试恢复旧监听
			this.host = prevHost;
			this.port = prevPort;
			try {
				await this.start();
				this.log('warn', '新地址启动失败，已恢复旧监听', {
					restoredHost: prevHost,
					restoredPort: prevPort,
				});
			} catch (restoreError) {
				this.log('error', '新地址启动失败，且恢复旧监听也失败', {
					restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
				});
			}
			throw error;
		}
	}

	/**
	 * 获取当前监听地址
	 */
	getListenInfo(): { host: string; port: number } {
		return { host: this.host, port: this.port };
	}

	/**
	 * 向客户端发送 request_data 消息
	 */
	requestData(): void {
		if (!this.client || this.client.ws.readyState !== WebSocket.OPEN) return;

		const msg: ServerRequestDataMessage = { type: 'request_data' };
		this.client.ws.send(JSON.stringify(msg));
	}

	/**
	 * 是否有活跃的客户端连接
	 */
	isClientConnected(): boolean {
		return this.client !== null && this.client.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * 获取客户端信息摘要
	 */
	getClientInfo(): { connected: boolean; appName?: string; appVersion?: string; projectName?: string } {
		if (!this.client) return { connected: false };
		return {
			connected: true,
			appName: this.client.appName,
			appVersion: this.client.appVersion,
			projectName: this.client.projectName,
		};
	}

	// ============ 内部方法 ============

	private handleConnection(ws: WebSocket): void {
		// 仅允许单客户端连接（MVP 阶段）
		if (this.client) {
			this.log('info', '新客户端连接，断开旧客户端');
			this.cleanupClient();
		}

		const client: ClientState = {
			ws,
			appName: '',
			appVersion: '',
			projectUuid: '',
			projectName: '',
			connectedAt: Date.now(),
			lastMessageAt: Date.now(),
			pingTimer: null,
			pingNonce: 0,
		};

		this.client = client;
		this.log('info', '客户端已连接');

		// 启动心跳
		client.pingTimer = setInterval(() => this.sendPing(client), PING_INTERVAL_MS);

		ws.on('message', (data) => {
			try {
				const raw = data.toString('utf-8');
				const msg = JSON.parse(raw) as Record<string, unknown>;
				client.lastMessageAt = Date.now();
				this.handleMessage(client, msg);
			} catch {
				this.log('warn', '收到无法解析的消息');
			}
		});

		ws.on('close', (code, reason) => {
			this.log('info', `客户端断开 (code=${code}, reason=${reason.toString('utf-8')})`);
			if (this.client === client) {
				this.cleanupClient();
			}
		});

		ws.on('error', (error) => {
			this.log('error', `客户端连接错误: ${error.message}`);
		});

		// 如果 store 中没有数据，主动请求
		if (!this.store.hasData()) {
			setTimeout(() => {
				if (client.ws.readyState === WebSocket.OPEN) {
					this.requestData();
				}
			}, 500);
		}
	}

	private handleMessage(client: ClientState, msg: Record<string, unknown>): void {
		const type = msg.type as string;

		switch (type) {
			case 'hello':
				this.handleHello(client, msg as unknown as BridgeHelloMessage);
				break;

			case 'snapshot':
				this.handleSnapshot(client, msg as unknown as BridgeSnapshotMessage);
				break;

			case 'pong':
				// 心跳回复，仅更新 lastMessageAt（已在上层更新）
				break;

			default:
				this.log('warn', `收到未知消息类型: ${type}`);
				break;
		}
	}

	private handleHello(client: ClientState, msg: BridgeHelloMessage): void {
		client.appName = msg.app?.name ?? '';
		client.appVersion = msg.app?.version ?? '';
		client.projectUuid = msg.project?.uuid ?? '';
		client.projectName = msg.project?.name ?? '';

		const clientVersion = msg.snapshotVersion ?? 0;
		const storeVersion = this.store.getVersion();
		const storeProjectUuid = this.store.getProjectInfo()?.projectUuid ?? '';
		const clientProjectUuid = msg.project?.uuid ?? '';

		// 条件化版本基线重置：
		// 1. 客户端版本 < store 版本 → 扩展重启，需重置基线
		// 2. 项目 UUID 变化 → 切换到不同项目，清空旧数据
		if (clientProjectUuid && storeProjectUuid && clientProjectUuid !== storeProjectUuid) {
			this.log('info', '项目已切换，清空旧快照', {
				oldProject: storeProjectUuid,
				newProject: clientProjectUuid,
			});
			this.store.clear();
		} else if (clientVersion < storeVersion) {
			this.log('info', '客户端版本回退，重置版本基线', {
				clientVersion,
				storeVersion,
			});
			this.store.resetVersionBaseline();
		}

		this.log('info', '收到 hello 握手', {
			app: `${client.appName} v${client.appVersion}`,
			project: client.projectName || '(未知)',
			snapshotVersion: clientVersion,
		});
	}

	private handleSnapshot(client: ClientState, msg: BridgeSnapshotMessage): void {
		if (!msg.payload) {
			this.log('warn', '收到 snapshot 但缺少 payload');
			return;
		}

		const accepted = this.store.update(msg.version, msg.projectUuid ?? '', msg.timestamp, msg.payload);
		if (!accepted) {
			this.log('warn', `快照 v${msg.version} 已过期，忽略（当前版本 v${this.store.getVersion()}）`);
			return;
		}

		// 更新客户端 project 信息
		if (msg.payload.projectInfo) {
			client.projectUuid = msg.payload.projectInfo.projectUuid ?? client.projectUuid;
			client.projectName = msg.payload.projectInfo.projectName ?? client.projectName;
		}

		this.log('info', `收到快照 v${msg.version}`, {
			components: msg.payload.components?.length ?? 0,
			pins: msg.payload.pins?.length ?? 0,
			nets: msg.payload.nets?.length ?? 0,
		});

		// 发送确认
		const ack: ServerAckMessage = { type: 'ack', version: msg.version };
		if (client.ws.readyState === WebSocket.OPEN) {
			client.ws.send(JSON.stringify(ack));
		}

		// 通知上层
		this.onSnapshot?.(msg.version);
	}

	private sendPing(client: ClientState): void {
		if (client.ws.readyState !== WebSocket.OPEN) return;

		// 检查连接超时
		const idleMs = Date.now() - client.lastMessageAt;
		if (idleMs > CONNECTION_TIMEOUT_MS) {
			this.log('warn', '客户端心跳超时，断开连接', { idleMs });
			client.ws.close(4000, 'heartbeat-timeout');
			return;
		}

		const ping: ServerPingMessage = {
			type: 'ping',
			nonce: String(++client.pingNonce),
			timestamp: Date.now(),
		};
		client.ws.send(JSON.stringify(ping));
	}

	private cleanupClient(): void {
		if (!this.client) return;

		if (this.client.pingTimer) {
			clearInterval(this.client.pingTimer);
		}

		try {
			if (this.client.ws.readyState === WebSocket.OPEN) {
				this.client.ws.close(1000, 'server-cleanup');
			}
		} catch {
			// ignore
		}

		this.client = null;
	}
}
