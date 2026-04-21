/**
 * eda-mcp-server - WebSocket Bridge
 *
 * Receives WS connections from the EDA extension and handles hello/snapshot/pong messages.
 * Updates the SnapshotStore when a snapshot is received.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type {
	BridgeHelloMessage,
	BridgeSnapshotMessage,
	ServerAckMessage,
	ServerPingMessage,
	ServerRequestDataMessage,
} from './types.js';
import type { SnapshotStore } from './snapshot-store.js';

/** Heartbeat interval (send ping every 15 seconds) */
const PING_INTERVAL_MS = 15_000;

/** Connection timeout (disconnect if no messages arrive for 60 seconds) */
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
	 * Start the WebSocket server
	 */
	start(): Promise<void> {
		if (this.wss) return Promise.resolve();

		return new Promise((resolve, reject) => {
			const wss = new WebSocketServer({ port: this.port, host: this.host });

			const onStartupError = (error: Error) => {
				// Startup failed: do not retain the wss reference, allowing retry
				this.log('error', `WebSocket server failed to start: ${error.message}`);
				reject(error);
			};

			wss.once('listening', () => {
				// Startup succeeded: remove the startup-time error handler and register runtime handlers
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
	 * Stop the WebSocket server
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
	 * Restart the WebSocket server with a new host/port
	 *
	 * Wait for the old server to fully close before starting the new one to avoid port races.
	 * If startup fails, roll host/port back to their previous values.
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
			// Startup failed, roll back configuration and try to restore the old listener
			this.host = prevHost;
			this.port = prevPort;
			try {
				await this.start();
				this.log('warn', 'Failed to start the new address; restored the previous listener', {
					restoredHost: prevHost,
					restoredPort: prevPort,
				});
			} catch (restoreError) {
				this.log('error', 'Failed to start the new address, and restoring the previous listener also failed', {
					restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
				});
			}
			throw error;
		}
	}

	/**
	 * Get the current listen address
	 */
	getListenInfo(): { host: string; port: number } {
		return { host: this.host, port: this.port };
	}

	/**
	 * Send a request_data message to the client
	 */
	requestData(): void {
		if (!this.client || this.client.ws.readyState !== WebSocket.OPEN) return;

		const msg: ServerRequestDataMessage = { type: 'request_data' };
		this.client.ws.send(JSON.stringify(msg));
	}

	/**
	 * Whether there is an active client connection
	 */
	isClientConnected(): boolean {
		return this.client !== null && this.client.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Get a summary of the client information
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

	// ============ Internal methods ============

	private handleConnection(ws: WebSocket): void {
		// Only allow a single client connection (MVP stage)
		if (this.client) {
			this.log('info', 'A new client connected, disconnecting the old client');
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
		this.log('info', 'Client connected');

		// Start heartbeat
		client.pingTimer = setInterval(() => this.sendPing(client), PING_INTERVAL_MS);

		ws.on('message', (data) => {
			try {
				const raw = data.toString('utf-8');
				const msg = JSON.parse(raw) as Record<string, unknown>;
				client.lastMessageAt = Date.now();
				this.handleMessage(client, msg);
			} catch {
				this.log('warn', 'Received an unparseable message');
			}
		});

		ws.on('close', (code, reason) => {
			this.log('info', `Client disconnected (code=${code}, reason=${reason.toString('utf-8')})`);
			if (this.client === client) {
				this.cleanupClient();
			}
		});

		ws.on('error', (error) => {
			this.log('error', `Client connection error: ${error.message}`);
		});

		// If the store has no data, request it proactively
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
				// Heartbeat reply; lastMessageAt is already updated above
				break;

			default:
				this.log('warn', `Received unknown message type: ${type}`);
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

		// Conditional version baseline reset:
		// 1. Client version < store version -> extension restart, baseline needs to reset
		// 2. Project UUID changes -> switched to a different project, clear old data
		if (clientProjectUuid && storeProjectUuid && clientProjectUuid !== storeProjectUuid) {
			this.log('info', 'Project switched; clearing the old snapshot', {
				oldProject: storeProjectUuid,
				newProject: clientProjectUuid,
			});
			this.store.clear();
		} else if (clientVersion < storeVersion) {
			this.log('info', 'Client version rolled back; resetting the version baseline', {
				clientVersion,
				storeVersion,
			});
			this.store.resetVersionBaseline();
		}

		this.log('info', 'Received hello handshake', {
			app: `${client.appName} v${client.appVersion}`,
			project: client.projectName || '(unknown)',
			snapshotVersion: clientVersion,
		});
	}

	private handleSnapshot(client: ClientState, msg: BridgeSnapshotMessage): void {
		if (!msg.payload) {
			this.log('warn', 'Received a snapshot but the payload is missing');
			return;
		}

		const accepted = this.store.update(msg.version, msg.projectUuid ?? '', msg.timestamp, msg.payload);
		if (!accepted) {
			this.log('warn', `Snapshot v${msg.version} is stale and will be ignored (current version v${this.store.getVersion()})`);
			return;
		}

		// Update client project information
		if (msg.payload.projectInfo) {
			client.projectUuid = msg.payload.projectInfo.projectUuid ?? client.projectUuid;
			client.projectName = msg.payload.projectInfo.projectName ?? client.projectName;
		}

		this.log('info', `Received snapshot v${msg.version}`, {
			components: msg.payload.components?.length ?? 0,
			pins: msg.payload.pins?.length ?? 0,
			nets: msg.payload.nets?.length ?? 0,
		});

		// Send confirmation
		const ack: ServerAckMessage = { type: 'ack', version: msg.version };
		if (client.ws.readyState === WebSocket.OPEN) {
			client.ws.send(JSON.stringify(ack));
		}

		// Notify upstream
		this.onSnapshot?.(msg.version);
	}

	private sendPing(client: ClientState): void {
		if (client.ws.readyState !== WebSocket.OPEN) return;

		// Check for connection timeout
		const idleMs = Date.now() - client.lastMessageAt;
		if (idleMs > CONNECTION_TIMEOUT_MS) {
			this.log('warn', 'Client heartbeat timed out; closing the connection', { idleMs });
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
