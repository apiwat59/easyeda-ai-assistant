#!/usr/bin/env node
/**
 * eda-mcp-server - 入口文件
 *
 * 启动 WS server（接收扩展推送）+ MCP server（通过 stdio transport 暴露给 AI 工具）。
 *
 * 使用方式：
 *   npx eda-mcp-server                          # 默认 127.0.0.1:3100
 *   npx eda-mcp-server --port 3200              # 自定义端口
 *   npx eda-mcp-server --host 0.0.0.0           # 监听所有网卡（允许远程连接）
 *   npx eda-mcp-server --host 0.0.0.0 --port 3200
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SnapshotStore } from './snapshot-store.js';
import { WsBridge } from './ws-bridge.js';
import { createMcpServer } from './mcp-server.js';

// ============ 命令行参数解析 ============

function parseArgs(): { port: number; host: string } {
	const args = process.argv.slice(2);
	let port = 3100;
	let host = '127.0.0.1';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--port') {
			const raw = args[i + 1];
			if (!raw || !/^\d+$/.test(raw)) {
				throw new Error(`无效的 --port 参数: ${raw ?? '(缺失)'}`);
			}
			const parsed = Number(raw);
			if (parsed < 1 || parsed > 65535) {
				throw new Error(`端口超出范围: ${raw}（应为 1-65535）`);
			}
			port = parsed;
			i++;
			continue;
		}
		if (args[i] === '--host') {
			if (!args[i + 1]) {
				throw new Error('缺少 --host 参数值');
			}
			host = args[i + 1];
			i++;
		}
	}

	return { port, host };
}

// ============ 日志 ============

function createLogger(prefix: string) {
	return (level: string, message: string, data?: unknown) => {
		const timestamp = new Date().toISOString().slice(11, 23);
		const dataStr = data ? ` ${JSON.stringify(data)}` : '';
		process.stderr.write(`[${timestamp}] [${prefix}] [${level}] ${message}${dataStr}\n`);
	};
}

// ============ 主入口 ============

async function main() {
	const { port, host } = parseArgs();
	const mainLog = createLogger('main');

	mainLog('info', `eda-mcp-server starting (ws=${host}:${port})`);

	// 1. 创建快照存储
	const store = new SnapshotStore();

	// 2. 启动 WS Bridge（接收扩展推送）
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

	// 3. 创建 MCP Server
	const mcpServer = createMcpServer({
		store,
		bridge,
		logger: createLogger('mcp'),
	});

	// 4. 启动 stdio transport（连接到 Cursor/Claude Code 等）
	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);

	mainLog('info', 'MCP server connected via stdio transport');

	// 5. 优雅退出
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
