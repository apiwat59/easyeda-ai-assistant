#!/usr/bin/env node
/**
 * eda-mcp-server - entry point
 *
 * Starts the WS server (receiving extension pushes) + MCP server (exposed to AI tools via stdio transport).
 *
 * Usage:
 *   npx eda-mcp-server                          # default 127.0.0.1:3100
 *   npx eda-mcp-server --port 3200              # custom port
 *   npx eda-mcp-server --host 0.0.0.0           # listen on all interfaces (allow remote connections)
 *   npx eda-mcp-server --host 0.0.0.0 --port 3200
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SnapshotStore } from './snapshot-store.js';
import { WsBridge } from './ws-bridge.js';
import { createMcpServer } from './mcp-server.js';

// ============ Command-line argument parsing ============

function parseArgs(): { port: number; host: string } {
	const args = process.argv.slice(2);
	let port = 3100;
	let host = '127.0.0.1';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--port') {
			const raw = args[i + 1];
			if (!raw || !/^\d+$/.test(raw)) {
				throw new Error(`Invalid --port argument: ${raw ?? '(missing)'}`);
			}
			const parsed = Number(raw);
			if (parsed < 1 || parsed > 65535) {
				throw new Error(`Port out of range: ${raw} (expected 1-65535)`);
			}
			port = parsed;
			i++;
			continue;
		}
		if (args[i] === '--host') {
			if (!args[i + 1]) {
				throw new Error('Missing --host argument value');
			}
			host = args[i + 1];
			i++;
		}
	}

	return { port, host };
}

// ============ Logging ============

function createLogger(prefix: string) {
	return (level: string, message: string, data?: unknown) => {
		const timestamp = new Date().toISOString().slice(11, 23);
		const dataStr = data ? ` ${JSON.stringify(data)}` : '';
		process.stderr.write(`[${timestamp}] [${prefix}] [${level}] ${message}${dataStr}\n`);
	};
}

// ============ Main entry ============

async function main() {
	const { port, host } = parseArgs();
	const mainLog = createLogger('main');

	mainLog('info', `eda-mcp-server starting (ws=${host}:${port})`);

	// 1. Create snapshot storage
	const store = new SnapshotStore();

	// 2. Start the WS bridge (receives extension pushes)
	const bridge = new WsBridge({
		port,
		host,
		store,
		onSnapshot: (version) => {
			mainLog('info', `Snapshot v${version} received and stored`);
		},
		logger: createLogger('ws-bridge'),
	});
	await bridge.start();

	// 3. Create the MCP server
	const mcpServer = createMcpServer({
		store,
		bridge,
		logger: createLogger('mcp'),
	});

	// 4. Start stdio transport (connects to Cursor/Claude Code, etc.)
	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);

	mainLog('info', 'MCP server connected via stdio transport');

	// 5. Graceful shutdown
	const shutdown = async () => {
		mainLog('info', 'Shutting down...');
		await bridge.stop();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((error) => {
	process.stderr.write(`[FATAL] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
