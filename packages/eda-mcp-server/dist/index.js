#!/usr/bin/env node

// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/snapshot-store.ts
var SnapshotStore = class {
  snapshot = null;
  /**
   * 更新快照
   *
   * 拒绝版本回滚：新版本号必须大于当前版本，否则忽略。
   */
  update(version, projectUuid, timestamp, data) {
    if (this.snapshot && version <= this.snapshot.version) {
      return false;
    }
    this.snapshot = {
      version,
      receivedAt: Date.now(),
      timestamp,
      projectUuid: projectUuid || data.projectInfo?.projectUuid || "",
      projectName: data.projectInfo?.projectName ?? "",
      data
    };
    return true;
  }
  /**
   * 获取当前快照（无数据时返回 null）
   */
  get() {
    return this.snapshot;
  }
  /**
   * 获取快照版本
   */
  getVersion() {
    return this.snapshot?.version ?? 0;
  }
  /**
   * 获取工程信息
   */
  getProjectInfo() {
    return this.snapshot?.data.projectInfo;
  }
  /**
   * 检查是否有可用数据
   */
  hasData() {
    return this.snapshot !== null;
  }
  /**
   * 重置版本基线
   *
   * 在新客户端连接（hello 握手）时调用，允许扩展重启后版本号从 1 重新开始。
   * 保留现有数据不变，仅重置版本号为 0。
   */
  resetVersionBaseline() {
    if (this.snapshot) {
      this.snapshot.version = 0;
    }
  }
  /**
   * 清空快照
   */
  clear() {
    this.snapshot = null;
  }
};

// src/ws-bridge.ts
import { WebSocketServer, WebSocket } from "ws";
var PING_INTERVAL_MS = 15e3;
var CONNECTION_TIMEOUT_MS = 6e4;
var WsBridge = class {
  wss = null;
  client = null;
  store;
  port;
  host;
  onSnapshot;
  log;
  constructor(options) {
    this.store = options.store;
    this.port = options.port;
    this.host = options.host ?? "127.0.0.1";
    this.onSnapshot = options.onSnapshot;
    this.log = options.logger ?? ((level, msg) => console.log(`[ws-bridge] [${level}] ${msg}`));
  }
  /**
   * 启动 WebSocket 服务
   */
  start() {
    if (this.wss) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.port, host: this.host });
      const onStartupError = (error) => {
        this.log("error", `WebSocket server failed to start: ${error.message}`);
        reject(error);
      };
      wss.once("listening", () => {
        wss.removeListener("error", onStartupError);
        this.wss = wss;
        wss.on("error", (error) => {
          this.log("error", `WebSocket server error: ${error.message}`);
        });
        wss.on("connection", (ws) => this.handleConnection(ws));
        this.log("info", `WebSocket server listening on ws://${this.host}:${this.port}`);
        resolve();
      });
      wss.once("error", onStartupError);
    });
  }
  /**
   * 停止 WebSocket 服务
   */
  stop() {
    this.cleanupClient();
    if (!this.wss) return Promise.resolve();
    return new Promise((resolve) => {
      const wss = this.wss;
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
  async restart(host, port) {
    const prevHost = this.host;
    const prevPort = this.port;
    await this.stop();
    this.host = host;
    this.port = port;
    try {
      await this.start();
    } catch (error) {
      this.host = prevHost;
      this.port = prevPort;
      try {
        await this.start();
        this.log("warn", "\u65B0\u5730\u5740\u542F\u52A8\u5931\u8D25\uFF0C\u5DF2\u6062\u590D\u65E7\u76D1\u542C", {
          restoredHost: prevHost,
          restoredPort: prevPort
        });
      } catch (restoreError) {
        this.log("error", "\u65B0\u5730\u5740\u542F\u52A8\u5931\u8D25\uFF0C\u4E14\u6062\u590D\u65E7\u76D1\u542C\u4E5F\u5931\u8D25", {
          restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError)
        });
      }
      throw error;
    }
  }
  /**
   * 获取当前监听地址
   */
  getListenInfo() {
    return { host: this.host, port: this.port };
  }
  /**
   * 向客户端发送 request_data 消息
   */
  requestData() {
    if (!this.client || this.client.ws.readyState !== WebSocket.OPEN) return;
    const msg = { type: "request_data" };
    this.client.ws.send(JSON.stringify(msg));
  }
  /**
   * 是否有活跃的客户端连接
   */
  isClientConnected() {
    return this.client !== null && this.client.ws.readyState === WebSocket.OPEN;
  }
  /**
   * 获取客户端信息摘要
   */
  getClientInfo() {
    if (!this.client) return { connected: false };
    return {
      connected: true,
      appName: this.client.appName,
      appVersion: this.client.appVersion,
      projectName: this.client.projectName
    };
  }
  // ============ 内部方法 ============
  handleConnection(ws) {
    if (this.client) {
      this.log("info", "\u65B0\u5BA2\u6237\u7AEF\u8FDE\u63A5\uFF0C\u65AD\u5F00\u65E7\u5BA2\u6237\u7AEF");
      this.cleanupClient();
    }
    const client = {
      ws,
      appName: "",
      appVersion: "",
      projectUuid: "",
      projectName: "",
      connectedAt: Date.now(),
      lastMessageAt: Date.now(),
      pingTimer: null,
      pingNonce: 0
    };
    this.client = client;
    this.log("info", "\u5BA2\u6237\u7AEF\u5DF2\u8FDE\u63A5");
    client.pingTimer = setInterval(() => this.sendPing(client), PING_INTERVAL_MS);
    ws.on("message", (data) => {
      try {
        const raw = data.toString("utf-8");
        const msg = JSON.parse(raw);
        client.lastMessageAt = Date.now();
        this.handleMessage(client, msg);
      } catch {
        this.log("warn", "\u6536\u5230\u65E0\u6CD5\u89E3\u6790\u7684\u6D88\u606F");
      }
    });
    ws.on("close", (code, reason) => {
      this.log("info", `\u5BA2\u6237\u7AEF\u65AD\u5F00 (code=${code}, reason=${reason.toString("utf-8")})`);
      if (this.client === client) {
        this.cleanupClient();
      }
    });
    ws.on("error", (error) => {
      this.log("error", `\u5BA2\u6237\u7AEF\u8FDE\u63A5\u9519\u8BEF: ${error.message}`);
    });
    if (!this.store.hasData()) {
      setTimeout(() => {
        if (client.ws.readyState === WebSocket.OPEN) {
          this.requestData();
        }
      }, 500);
    }
  }
  handleMessage(client, msg) {
    const type = msg.type;
    switch (type) {
      case "hello":
        this.handleHello(client, msg);
        break;
      case "snapshot":
        this.handleSnapshot(client, msg);
        break;
      case "pong":
        break;
      default:
        this.log("warn", `\u6536\u5230\u672A\u77E5\u6D88\u606F\u7C7B\u578B: ${type}`);
        break;
    }
  }
  handleHello(client, msg) {
    client.appName = msg.app?.name ?? "";
    client.appVersion = msg.app?.version ?? "";
    client.projectUuid = msg.project?.uuid ?? "";
    client.projectName = msg.project?.name ?? "";
    const clientVersion = msg.snapshotVersion ?? 0;
    const storeVersion = this.store.getVersion();
    const storeProjectUuid = this.store.getProjectInfo()?.projectUuid ?? "";
    const clientProjectUuid = msg.project?.uuid ?? "";
    if (clientProjectUuid && storeProjectUuid && clientProjectUuid !== storeProjectUuid) {
      this.log("info", "\u9879\u76EE\u5DF2\u5207\u6362\uFF0C\u6E05\u7A7A\u65E7\u5FEB\u7167", {
        oldProject: storeProjectUuid,
        newProject: clientProjectUuid
      });
      this.store.clear();
    } else if (clientVersion < storeVersion) {
      this.log("info", "\u5BA2\u6237\u7AEF\u7248\u672C\u56DE\u9000\uFF0C\u91CD\u7F6E\u7248\u672C\u57FA\u7EBF", {
        clientVersion,
        storeVersion
      });
      this.store.resetVersionBaseline();
    }
    this.log("info", "\u6536\u5230 hello \u63E1\u624B", {
      app: `${client.appName} v${client.appVersion}`,
      project: client.projectName || "(\u672A\u77E5)",
      snapshotVersion: clientVersion
    });
  }
  handleSnapshot(client, msg) {
    if (!msg.payload) {
      this.log("warn", "\u6536\u5230 snapshot \u4F46\u7F3A\u5C11 payload");
      return;
    }
    const accepted = this.store.update(msg.version, msg.projectUuid ?? "", msg.timestamp, msg.payload);
    if (!accepted) {
      this.log("warn", `\u5FEB\u7167 v${msg.version} \u5DF2\u8FC7\u671F\uFF0C\u5FFD\u7565\uFF08\u5F53\u524D\u7248\u672C v${this.store.getVersion()}\uFF09`);
      return;
    }
    if (msg.payload.projectInfo) {
      client.projectUuid = msg.payload.projectInfo.projectUuid ?? client.projectUuid;
      client.projectName = msg.payload.projectInfo.projectName ?? client.projectName;
    }
    this.log("info", `\u6536\u5230\u5FEB\u7167 v${msg.version}`, {
      components: msg.payload.components?.length ?? 0,
      pins: msg.payload.pins?.length ?? 0,
      nets: msg.payload.nets?.length ?? 0
    });
    const ack = { type: "ack", version: msg.version };
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(ack));
    }
    this.onSnapshot?.(msg.version);
  }
  sendPing(client) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    const idleMs = Date.now() - client.lastMessageAt;
    if (idleMs > CONNECTION_TIMEOUT_MS) {
      this.log("warn", "\u5BA2\u6237\u7AEF\u5FC3\u8DF3\u8D85\u65F6\uFF0C\u65AD\u5F00\u8FDE\u63A5", { idleMs });
      client.ws.close(4e3, "heartbeat-timeout");
      return;
    }
    const ping = {
      type: "ping",
      nonce: String(++client.pingNonce),
      timestamp: Date.now()
    };
    client.ws.send(JSON.stringify(ping));
  }
  cleanupClient() {
    if (!this.client) return;
    if (this.client.pingTimer) {
      clearInterval(this.client.pingTimer);
    }
    try {
      if (this.client.ws.readyState === WebSocket.OPEN) {
        this.client.ws.close(1e3, "server-cleanup");
      }
    } catch {
    }
    this.client = null;
  }
};

// src/mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
function createMcpServer(options) {
  const { store, bridge } = options;
  const log = options.logger ?? ((level, msg) => console.log(`[mcp-server] [${level}] ${msg}`));
  const server = new McpServer({
    name: "eda-mcp-server",
    version: "0.1.0"
  });
  server.resource("schematic-status", "eda://schematic/status", async () => {
    const snapshot = store.get();
    const clientInfo = bridge.getClientInfo();
    return {
      contents: [{
        uri: "eda://schematic/status",
        mimeType: "application/json",
        text: JSON.stringify({
          connected: clientInfo.connected,
          app: clientInfo.connected ? { name: clientInfo.appName, version: clientInfo.appVersion } : null,
          snapshotVersion: snapshot?.version ?? 0,
          snapshotTimestamp: snapshot?.timestamp ?? null,
          receivedAt: snapshot?.receivedAt ?? null,
          projectName: snapshot?.projectName ?? null,
          projectUuid: snapshot?.projectUuid ?? null,
          hasData: store.hasData()
        }, null, 2)
      }]
    };
  });
  server.resource("schematic-summary", "eda://schematic/summary", async () => {
    const snapshot = store.get();
    if (!snapshot) {
      return { contents: [{ uri: "eda://schematic/summary", mimeType: "application/json", text: '{"error":"No data available"}' }] };
    }
    const data = snapshot.data;
    return {
      contents: [{
        uri: "eda://schematic/summary",
        mimeType: "application/json",
        text: JSON.stringify({
          projectName: data.projectInfo?.projectName ?? "(unknown)",
          projectUuid: data.projectInfo?.projectUuid ?? "",
          totalComponents: data.components.length,
          totalPins: data.pins.length,
          totalNets: data.nets.length,
          totalTexts: data.texts?.length ?? 0,
          totalBuses: data.buses?.length ?? 0,
          totalNetLabels: data.netLabels?.length ?? 0,
          drcPassed: data.drcResult?.passed ?? null,
          drcStrict: data.drcResult?.strict ?? null,
          collectionQuality: data.meta?.quality ?? "unknown",
          timestamp: data.timestamp
        }, null, 2)
      }]
    };
  });
  server.resource("schematic-components", "eda://schematic/components", async () => {
    const snapshot = store.get();
    if (!snapshot) {
      return { contents: [{ uri: "eda://schematic/components", mimeType: "application/json", text: "[]" }] };
    }
    return {
      contents: [{
        uri: "eda://schematic/components",
        mimeType: "application/json",
        text: JSON.stringify(snapshot.data.components, null, 2)
      }]
    };
  });
  server.resource("schematic-pins", "eda://schematic/pins", async () => {
    const snapshot = store.get();
    if (!snapshot) {
      return { contents: [{ uri: "eda://schematic/pins", mimeType: "application/json", text: "[]" }] };
    }
    return {
      contents: [{
        uri: "eda://schematic/pins",
        mimeType: "application/json",
        text: JSON.stringify(snapshot.data.pins, null, 2)
      }]
    };
  });
  server.resource("schematic-nets", "eda://schematic/nets", async () => {
    const snapshot = store.get();
    if (!snapshot) {
      return { contents: [{ uri: "eda://schematic/nets", mimeType: "application/json", text: "[]" }] };
    }
    return {
      contents: [{
        uri: "eda://schematic/nets",
        mimeType: "application/json",
        text: JSON.stringify(snapshot.data.nets, null, 2)
      }]
    };
  });
  server.resource("schematic-drc", "eda://schematic/drc", async () => {
    const snapshot = store.get();
    const drc = snapshot?.data.drcResult ?? null;
    return {
      contents: [{
        uri: "eda://schematic/drc",
        mimeType: "application/json",
        text: JSON.stringify(drc, null, 2)
      }]
    };
  });
  server.resource("schematic-project-info", "eda://schematic/project-info", async () => {
    const snapshot = store.get();
    const info = snapshot?.data.projectInfo ?? null;
    return {
      contents: [{
        uri: "eda://schematic/project-info",
        mimeType: "application/json",
        text: JSON.stringify(info, null, 2)
      }]
    };
  });
  server.resource("schematic-netlist", "eda://schematic/netlist", async () => {
    const snapshot = store.get();
    const netlist = snapshot?.data.netlistRaw ?? "";
    return {
      contents: [{
        uri: "eda://schematic/netlist",
        mimeType: "text/plain",
        text: netlist
      }]
    };
  });
  server.resource("schematic-compact", "eda://schematic/compact", async () => {
    const snapshot = store.get();
    if (!snapshot) {
      return { contents: [{ uri: "eda://schematic/compact", mimeType: "application/json", text: '{"error":"No data available"}' }] };
    }
    return {
      contents: [{
        uri: "eda://schematic/compact",
        mimeType: "application/json",
        text: JSON.stringify(snapshot.data)
      }]
    };
  });
  server.tool("schematic_status", "\u83B7\u53D6 EDA \u6269\u5C55\u8FDE\u63A5\u72B6\u6001\u3001\u6570\u636E\u7248\u672C\u548C\u53EF\u7528 Resource \u5217\u8868", {}, async () => {
    const snapshot = store.get();
    const clientInfo = bridge.getClientInfo();
    const resources = [
      "eda://schematic/status",
      "eda://schematic/summary",
      "eda://schematic/components",
      "eda://schematic/pins",
      "eda://schematic/nets",
      "eda://schematic/drc",
      "eda://schematic/project-info",
      "eda://schematic/netlist",
      "eda://schematic/compact"
    ];
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          connected: clientInfo.connected,
          app: clientInfo.connected ? { name: clientInfo.appName, version: clientInfo.appVersion } : null,
          snapshotVersion: snapshot?.version ?? 0,
          hasData: store.hasData(),
          projectName: snapshot?.projectName ?? null,
          availableResources: resources
        }, null, 2)
      }]
    };
  });
  server.tool(
    "query_component",
    "\u6839\u636E\u4F4D\u53F7\u67E5\u8BE2\u5355\u4E2A\u5668\u4EF6\u7684\u8BE6\u7EC6\u4FE1\u606F\uFF0C\u5305\u62EC\u5176\u5168\u90E8\u5F15\u811A\u548C\u6240\u8FDE\u63A5\u7684\u7F51\u7EDC",
    { designator: z.string().describe("\u5668\u4EF6\u4F4D\u53F7\uFF0C\u5982 U1, R3, C5") },
    async ({ designator }) => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available. Please open a schematic in EDA."}' }] };
      }
      const upper = designator.toUpperCase();
      const component = snapshot.data.components.find(
        (c) => c.designator.toUpperCase() === upper
      );
      if (!component) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: `Component "${designator}" not found`, availableDesignators: snapshot.data.components.slice(0, 20).map((c) => c.designator) }, null, 2)
          }]
        };
      }
      const pins = snapshot.data.pins.filter(
        (p) => p.componentDesignator.toUpperCase() === upper
      );
      const connectedNets = [...new Set(pins.map((p) => p.netName).filter(Boolean))];
      const nets = snapshot.data.nets.filter(
        (n) => connectedNets.includes(n.netName)
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ component, pins, connectedNets: nets }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "query_net",
    "\u6839\u636E\u7F51\u7EDC\u540D\u67E5\u8BE2\u8BE5\u7F51\u7EDC\u8FDE\u63A5\u7684\u6240\u6709\u5F15\u811A\u548C\u5668\u4EF6",
    { netName: z.string().describe("\u7F51\u7EDC\u540D\u79F0\uFF0C\u5982 GND, VCC_3V3, NET_SPI_CLK") },
    async ({ netName: rawNetName }) => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available. Please open a schematic in EDA."}' }] };
      }
      const netName = rawNetName.trim();
      if (!netName) {
        return { content: [{ type: "text", text: '{"error":"Net name cannot be empty"}' }] };
      }
      let net = snapshot.data.nets.find(
        (n) => n.netName === netName
      );
      if (!net) {
        const netUpper = netName.toUpperCase();
        const ciMatches = snapshot.data.nets.filter(
          (n) => n.netName.toUpperCase() === netUpper
        );
        if (ciMatches.length === 1) {
          net = ciMatches[0];
        } else if (ciMatches.length > 1) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `Ambiguous net name "${netName}" (case-insensitive match found ${ciMatches.length} candidates)`,
                suggestions: ciMatches.map((n) => n.netName)
              }, null, 2)
            }]
          };
        }
      }
      if (!net) {
        const netLower = netName.toLowerCase();
        const candidates = snapshot.data.nets.filter((n) => n.netName.toLowerCase().includes(netLower)).slice(0, 10);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Net "${netName}" not found`,
              suggestions: candidates.map((n) => n.netName)
            }, null, 2)
          }]
        };
      }
      const actualNetName = net.netName;
      const pins = snapshot.data.pins.filter(
        (p) => p.netName === actualNetName
      );
      const designators = [...new Set(pins.map((p) => p.componentDesignator))];
      const components = snapshot.data.components.filter(
        (c) => designators.includes(c.designator)
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ net, pins, connectedComponents: components }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "search_schematic",
    "\u5728\u539F\u7406\u56FE\u6570\u636E\u4E2D\u6309\u5173\u952E\u8BCD\u641C\u7D22\uFF08\u8DE8\u5668\u4EF6\u540D\u3001\u7F51\u7EDC\u540D\u3001\u5F15\u811A\u540D\uFF09\uFF0C\u652F\u6301\u6309\u7C7B\u578B\u8FC7\u6EE4",
    {
      keyword: z.string().describe("\u641C\u7D22\u5173\u952E\u8BCD"),
      type: z.enum(["component", "net", "pin", "all"]).optional().describe("\u641C\u7D22\u8303\u56F4\uFF1Acomponent/net/pin/all\uFF0C\u9ED8\u8BA4 all")
    },
    async ({ keyword, type }) => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available. Please open a schematic in EDA."}' }] };
      }
      const kw = keyword.toLowerCase();
      const searchType = type ?? "all";
      const results = {};
      if (searchType === "all" || searchType === "component") {
        results.components = snapshot.data.components.filter(
          (c) => c.designator.toLowerCase().includes(kw) || c.name.toLowerCase().includes(kw) || c.value.toLowerCase().includes(kw) || c.manufacturer.toLowerCase().includes(kw) || c.manufacturerPartNumber.toLowerCase().includes(kw) || c.lcscPart.toLowerCase().includes(kw)
        ).slice(0, 50);
      }
      if (searchType === "all" || searchType === "net") {
        results.nets = snapshot.data.nets.filter(
          (n) => n.netName.toLowerCase().includes(kw)
        ).slice(0, 50);
      }
      if (searchType === "all" || searchType === "pin") {
        results.pins = snapshot.data.pins.filter(
          (p) => p.pinName.toLowerCase().includes(kw) || p.pinNumber.toLowerCase().includes(kw) || p.netName && p.netName.toLowerCase().includes(kw)
        ).slice(0, 50);
      }
      const totalResults = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            keyword,
            searchType,
            totalResults,
            ...results
          }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "configure_bridge",
    "\u4FEE\u6539 WebSocket Bridge \u7684\u76D1\u542C\u5730\u5740\u548C\u7AEF\u53E3\uFF0C\u7528\u4E8E\u63A5\u6536 EDA \u6269\u5C55\u7684\u8FDC\u7A0B\u8FDE\u63A5\u3002\u4FEE\u6539\u540E\u4F1A\u81EA\u52A8\u91CD\u542F WS \u670D\u52A1\u3002",
    {
      host: z.string().optional().describe("\u76D1\u542C\u5730\u5740\uFF0C\u5982 0.0.0.0\uFF08\u6240\u6709\u7F51\u5361\uFF09\u6216 127.0.0.1\uFF08\u4EC5\u672C\u5730\uFF09\uFF0C\u9ED8\u8BA4\u4E0D\u53D8"),
      port: z.number().int().min(1).max(65535).optional().describe("\u76D1\u542C\u7AEF\u53E3\uFF081-65535\uFF09\uFF0C\u5982 3100\uFF0C\u9ED8\u8BA4\u4E0D\u53D8")
    },
    async ({ host, port }) => {
      const current = bridge.getListenInfo();
      const nextHost = host ?? current.host;
      const nextPort = port ?? current.port;
      if (nextHost === current.host && nextPort === current.port) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "\u914D\u7F6E\u672A\u53D8\u66F4",
              host: current.host,
              port: current.port,
              connected: bridge.isClientConnected()
            }, null, 2)
          }]
        };
      }
      try {
        await bridge.restart(nextHost, nextPort);
        log("info", `WS Bridge \u5DF2\u91CD\u542F: ${nextHost}:${nextPort}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: `WS Bridge \u5DF2\u91CD\u542F\uFF0C\u76D1\u542C ${nextHost}:${nextPort}`,
              host: nextHost,
              port: nextPort,
              previousHost: current.host,
              previousPort: current.port
            }, null, 2)
          }]
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `WS Bridge \u91CD\u542F\u5931\u8D25: ${errMsg}`,
              host: current.host,
              port: current.port
            }, null, 2)
          }]
        };
      }
    }
  );
  server.tool(
    "get_bom",
    "\u751F\u6210 BOM\uFF08\u7269\u6599\u6E05\u5355\uFF09\uFF0C\u4F7F\u7528 value+\u6599\u53F7+LCSC \u7F16\u53F7\u590D\u5408\u5206\u7EC4\uFF0C\u8FC7\u6EE4\u4E0D\u5165 BOM \u7684\u5668\u4EF6",
    {
      includeBomExcluded: z.boolean().optional().describe("\u662F\u5426\u5305\u542B\u6807\u8BB0\u4E3A\u4E0D\u5165 BOM \u7684\u5668\u4EF6\uFF0C\u9ED8\u8BA4 false")
    },
    async ({ includeBomExcluded }) => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available."}' }] };
      }
      const components = includeBomExcluded ? snapshot.data.components : snapshot.data.components.filter((c) => c.bomInclude !== "false" && c.bomInclude !== "0");
      const groups = /* @__PURE__ */ new Map();
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
            lcscPart: c.lcscPart
          });
        }
      }
      const bom = [...groups.values()].map((info) => ({
        quantity: info.designators.length,
        designators: [...info.designators].sort(
          (a, b) => a.localeCompare(b, void 0, { numeric: true, sensitivity: "base" })
        ),
        name: info.name,
        value: info.value,
        manufacturer: info.manufacturer,
        mpn: info.mpn,
        lcscPart: info.lcscPart
      })).sort((a, b) => b.quantity - a.quantity);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalUniqueItems: bom.length,
            totalComponents: components.length,
            bomExcludedCount: snapshot.data.components.length - components.length,
            bom
          }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "find_unconnected_pins",
    '\u67E5\u627E\u539F\u7406\u56FE\u4E2D\u672A\u8FDE\u63A5\u5230\u4EFB\u4F55\u7F51\u7EDC\u7684\u60AC\u7A7A\u5F15\u811A\uFF0C\u7528\u4E8E\u6392\u67E5\u63A5\u7EBF\u9057\u6F0F\u3002\u533A\u5206"\u672A\u8FDE\u63A5"\u548C"\u672A\u89E3\u6790"\u4E24\u79CD\u72B6\u6001',
    {
      designator: z.string().optional().describe("\u53EF\u9009\uFF1A\u53EA\u68C0\u67E5\u6307\u5B9A\u5668\u4EF6\u7684\u5F15\u811A\uFF0C\u5982 U1")
    },
    async ({ designator }) => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available."}' }] };
      }
      let pins = snapshot.data.pins;
      if (designator) {
        const upper = designator.toUpperCase();
        const exists = snapshot.data.components.some((c) => c.designator.toUpperCase() === upper);
        if (!exists) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Component "${designator}" not found` }, null, 2) }] };
        }
        pins = pins.filter((p) => p.componentDesignator.toUpperCase() === upper);
      }
      const unconnected = pins.filter((p) => !p.netName);
      const byComponent = /* @__PURE__ */ new Map();
      for (const p of unconnected) {
        const list = byComponent.get(p.componentDesignator) ?? [];
        list.push({
          pinNumber: p.pinNumber,
          pinName: p.pinName,
          pinType: p.pinType,
          reason: p.netBindingReason === "unresolved" ? "unresolved" : "unconnected"
        });
        byComponent.set(p.componentDesignator, list);
      }
      const grouped = [...byComponent.entries()].map(([des, pinList]) => ({ designator: des, pins: pinList, count: pinList.length })).sort((a, b) => b.count - a.count);
      const unresolvedCount = unconnected.filter((p) => p.netBindingReason === "unresolved").length;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalUnconnected: unconnected.length,
            trulyUnconnected: unconnected.length - unresolvedCount,
            unresolvedBinding: unresolvedCount,
            totalPinsChecked: pins.length,
            components: grouped
          }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "analyze_power_nets",
    "\u81EA\u52A8\u8BC6\u522B\u7535\u6E90\u548C\u5730\u7F51\u7EDC\uFF08VCC\u3001GND\u3001VDD \u7B49\uFF09\uFF0C\u5217\u51FA\u6BCF\u4E2A\u7535\u6E90\u7F51\u8FDE\u63A5\u7684\u5668\u4EF6\u548C\u5F15\u811A",
    {},
    async () => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available."}' }] };
      }
      const powerPatterns = /^(\+?\d+V\d*|VCC|VDD|VBUS|VBAT|VIN|VSYS|VREF|VOUT|VEE|V3V3|V5V|V1V8|3V3|3\.3V|5V|12V|1V8|1\.8V|2\.5V|GND|AGND|DGND|PGND|VSS|AVCC|AVDD|DVCC|DVDD|VDDIO|VCCIO|SYS_\d+V)/i;
      const powerNets = snapshot.data.nets.filter((n) => powerPatterns.test(n.netName));
      const result = powerNets.map((net) => {
        const pins = snapshot.data.pins.filter((p) => p.netName === net.netName);
        const components = [...new Set(pins.map((p) => p.componentDesignator))];
        return {
          netName: net.netName,
          pinCount: net.pinCount,
          connectedComponents: components,
          pins: pins.map((p) => ({
            component: p.componentDesignator,
            pin: `${p.pinNumber} (${p.pinName})`,
            pinType: p.pinType
          }))
        };
      }).sort((a, b) => b.pinCount - a.pinCount);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalPowerNets: result.length,
            powerNets: result
          }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "check_drc",
    "\u67E5\u770B\u539F\u7406\u56FE\u7684 DRC\uFF08\u8BBE\u8BA1\u89C4\u5219\u68C0\u67E5\uFF09\u7ED3\u679C\uFF0C\u5305\u62EC\u662F\u5426\u901A\u8FC7\u3001\u68C0\u67E5\u6A21\u5F0F\u548C\u65F6\u95F4\u6233",
    {},
    async () => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available."}' }] };
      }
      const drc = snapshot.data.drcResult;
      if (!drc) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "no_drc_data", message: "\u5F53\u524D\u5FEB\u7167\u4E2D\u6CA1\u6709 DRC \u68C0\u67E5\u7ED3\u679C\uFF0C\u53EF\u80FD\u5C1A\u672A\u6267\u884C DRC \u68C0\u67E5" }, null, 2)
          }]
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            passed: drc.passed,
            strict: drc.strict,
            timestamp: drc.timestamp,
            timestampFormatted: new Date(drc.timestamp).toISOString(),
            summary: drc.passed ? drc.strict ? "DRC \u4E25\u683C\u6A21\u5F0F\u901A\u8FC7" : "DRC \u57FA\u672C\u6A21\u5F0F\u901A\u8FC7" : drc.strict ? "DRC \u4E25\u683C\u6A21\u5F0F\u672A\u901A\u8FC7" : "DRC \u57FA\u672C\u6A21\u5F0F\u672A\u901A\u8FC7"
          }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "refresh_data",
    "\u8BF7\u6C42 EDA \u6269\u5C55\u91CD\u65B0\u63A8\u9001\u6700\u65B0\u7684\u539F\u7406\u56FE\u6570\u636E\uFF0C\u7528\u4E8E\u6570\u636E\u53EF\u80FD\u8FC7\u671F\u65F6\u4E3B\u52A8\u5237\u65B0",
    {},
    async () => {
      if (!bridge.isClientConnected()) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: "EDA \u6269\u5C55\u672A\u8FDE\u63A5\uFF0C\u65E0\u6CD5\u8BF7\u6C42\u6570\u636E\u5237\u65B0" }, null, 2)
          }]
        };
      }
      bridge.requestData();
      const currentVersion = store.getVersion();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            message: "\u5DF2\u5411 EDA \u6269\u5C55\u53D1\u9001\u6570\u636E\u5237\u65B0\u8BF7\u6C42\uFF0C\u7A0D\u540E\u6570\u636E\u5C06\u81EA\u52A8\u66F4\u65B0",
            currentVersion
          }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "trace_connectivity",
    "\u67E5\u627E\u4E24\u4E2A\u5668\u4EF6\u4E4B\u95F4\u7684\u7535\u6C14\u8FDE\u63A5\u8DEF\u5F84\uFF08\u76F4\u63A5\u5171\u4EAB\u7F51\u7EDC + \u4E00\u8DF3\u95F4\u63A5\u8DEF\u5F84\uFF09\uFF0C\u7528\u4E8E\u5206\u6790\u4FE1\u53F7\u8D70\u5411",
    {
      from: z.string().describe("\u8D77\u59CB\u5668\u4EF6\u4F4D\u53F7\uFF0C\u5982 U1"),
      to: z.string().describe("\u76EE\u6807\u5668\u4EF6\u4F4D\u53F7\uFF0C\u5982 U2")
    },
    async ({ from, to }) => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available."}' }] };
      }
      const fromUpper = from.toUpperCase();
      const toUpper = to.toUpperCase();
      const netToPins = /* @__PURE__ */ new Map();
      const desToNets = /* @__PURE__ */ new Map();
      for (const p of snapshot.data.pins) {
        if (!p.netName) continue;
        const des = p.componentDesignator.toUpperCase();
        const pinList = netToPins.get(p.netName) ?? [];
        pinList.push(p);
        netToPins.set(p.netName, pinList);
        const netSet = desToNets.get(des) ?? /* @__PURE__ */ new Set();
        netSet.add(p.netName);
        desToNets.set(des, netSet);
      }
      const fromNets = desToNets.get(fromUpper);
      const toNets = desToNets.get(toUpper);
      if (!fromNets || fromNets.size === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Component "${from}" not found or has no connected nets` }, null, 2) }] };
      }
      if (!toNets || toNets.size === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Component "${to}" not found or has no connected nets` }, null, 2) }] };
      }
      const directNets = [...fromNets].filter((n) => toNets.has(n));
      const directPaths = directNets.map((netName) => {
        const allPins = netToPins.get(netName) ?? [];
        const fPin = allPins.filter((p) => p.componentDesignator.toUpperCase() === fromUpper);
        const tPin = allPins.filter((p) => p.componentDesignator.toUpperCase() === toUpper);
        return {
          netName,
          fromPins: fPin.map((p) => `${p.pinNumber} (${p.pinName})`),
          toPins: tPin.map((p) => `${p.pinNumber} (${p.pinName})`)
        };
      });
      const indirectSet = /* @__PURE__ */ new Set();
      const indirectPaths = [];
      for (const fNet of fromNets) {
        const pinsOnNet = netToPins.get(fNet) ?? [];
        const middleDesignators = /* @__PURE__ */ new Set();
        for (const p of pinsOnNet) {
          const des = p.componentDesignator.toUpperCase();
          if (des !== fromUpper && des !== toUpper) {
            middleDesignators.add(des);
          }
        }
        for (const midDes of middleDesignators) {
          const midNets = desToNets.get(midDes);
          if (!midNets) continue;
          for (const midNet of midNets) {
            if (midNet !== fNet && toNets.has(midNet)) {
              const dedupeKey = `${fNet}|${midDes}|${midNet}`;
              if (!indirectSet.has(dedupeKey)) {
                indirectSet.add(dedupeKey);
                const origDes = (netToPins.get(fNet) ?? []).find((p) => p.componentDesignator.toUpperCase() === midDes)?.componentDesignator ?? midDes;
                indirectPaths.push({ netFrom: fNet, middleComponent: origDes, netTo: midNet });
              }
            }
          }
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            from,
            to,
            directConnections: directPaths.length,
            directPaths,
            indirectConnections: indirectPaths.length,
            indirectPaths: indirectPaths.slice(0, 30)
          }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "list_components_by_type",
    "\u6309\u5668\u4EF6\u524D\u7F00\uFF08R \u7535\u963B\u3001C \u7535\u5BB9\u3001U IC\u3001L \u7535\u611F\u7B49\uFF09\u5206\u7EC4\u7EDF\u8BA1\uFF0C\u5217\u51FA\u5404\u7C7B\u578B\u6570\u91CF\u548C\u4F4D\u53F7",
    {},
    async () => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available."}' }] };
      }
      const groups = /* @__PURE__ */ new Map();
      for (const c of snapshot.data.components) {
        const prefix = c.prefix || c.designator.replace(/[0-9]+$/, "") || "?";
        const list = groups.get(prefix) ?? [];
        list.push(c.designator);
        groups.set(prefix, list);
      }
      const prefixNames = {
        R: "\u7535\u963B",
        C: "\u7535\u5BB9",
        L: "\u7535\u611F",
        U: "IC/\u82AF\u7247",
        Q: "\u4E09\u6781\u7BA1/MOS\u7BA1",
        D: "\u4E8C\u6781\u7BA1",
        J: "\u8FDE\u63A5\u5668",
        P: "\u63D2\u5934",
        SW: "\u5F00\u5173",
        F: "\u4FDD\u9669\u4E1D",
        LED: "LED",
        T: "\u53D8\u538B\u5668",
        Y: "\u6676\u632F",
        FB: "\u78C1\u73E0",
        RN: "\u6392\u963B"
      };
      const result = [...groups.entries()].map(([prefix, designators]) => ({
        prefix,
        typeName: prefixNames[prefix] ?? "\u5176\u4ED6",
        count: designators.length,
        designators: designators.sort((a, b) => {
          const numA = parseInt(a.replace(/\D/g, "")) || 0;
          const numB = parseInt(b.replace(/\D/g, "")) || 0;
          return numA - numB;
        })
      })).sort((a, b) => b.count - a.count);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalComponents: snapshot.data.components.length,
            totalTypes: result.length,
            groups: result
          }, null, 2)
        }]
      };
    }
  );
  server.tool(
    "get_netlist_raw",
    "\u83B7\u53D6\u539F\u59CB\u7F51\u8868\u6587\u672C\uFF08\u82E5\u53EF\u7528\uFF09\uFF0C\u53EF\u7528\u4E8E\u5BFC\u51FA\u6216\u8FDB\u4E00\u6B65\u5206\u6790",
    {},
    async () => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available."}' }] };
      }
      const netlist = snapshot.data.netlistRaw;
      if (!netlist) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "no_netlist", message: "\u5F53\u524D\u5FEB\u7167\u4E2D\u6CA1\u6709\u539F\u59CB\u7F51\u8868\u6570\u636E" }, null, 2)
          }]
        };
      }
      return {
        content: [{
          type: "text",
          text: netlist
        }]
      };
    }
  );
  server.tool(
    "get_pin_map",
    "\u83B7\u53D6\u6307\u5B9A\u5668\u4EF6\u7684\u5B8C\u6574\u5F15\u811A\u6620\u5C04\u8868\uFF08\u5F15\u811A\u53F7 \u2192 \u5F15\u811A\u540D \u2192 \u6240\u8FDE\u7F51\u7EDC\uFF09\uFF0C\u4FBF\u4E8E\u5206\u6790\u5668\u4EF6\u63A5\u7EBF",
    {
      designator: z.string().describe("\u5668\u4EF6\u4F4D\u53F7\uFF0C\u5982 U1, U3")
    },
    async ({ designator }) => {
      const snapshot = store.get();
      if (!snapshot) {
        return { content: [{ type: "text", text: '{"error":"No schematic data available."}' }] };
      }
      const upper = designator.toUpperCase();
      const component = snapshot.data.components.find(
        (c) => c.designator.toUpperCase() === upper
      );
      if (!component) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: `Component "${designator}" not found` }, null, 2)
          }]
        };
      }
      const pins = snapshot.data.pins.filter((p) => p.componentDesignator.toUpperCase() === upper).map((p) => ({
        pinNumber: p.pinNumber,
        pinName: p.pinName,
        pinType: p.pinType,
        netName: p.netName ?? "(unconnected)",
        connected: p.netName !== null
      })).sort((a, b) => {
        const numA = parseInt(a.pinNumber);
        const numB = parseInt(b.pinNumber);
        const aIsNum = !isNaN(numA) && String(numA) === a.pinNumber;
        const bIsNum = !isNaN(numB) && String(numB) === b.pinNumber;
        if (aIsNum && bIsNum) return numA - numB;
        if (aIsNum) return -1;
        if (bIsNum) return 1;
        return a.pinNumber.localeCompare(b.pinNumber, void 0, { numeric: true });
      });
      const connectedCount = pins.filter((p) => p.connected).length;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            component: {
              designator: component.designator,
              name: component.name,
              value: component.value,
              manufacturer: component.manufacturer,
              mpn: component.manufacturerPartNumber
            },
            totalPins: pins.length,
            connectedPins: connectedCount,
            unconnectedPins: pins.length - connectedCount,
            pinMap: pins
          }, null, 2)
        }]
      };
    }
  );
  log("info", "MCP server configured with 9 resources and 14 tools");
  return server;
}

// src/index.ts
function parseArgs() {
  const args = process.argv.slice(2);
  let port = 3100;
  let host = "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      const raw = args[i + 1];
      if (!raw || !/^\d+$/.test(raw)) {
        throw new Error(`\u65E0\u6548\u7684 --port \u53C2\u6570: ${raw ?? "(\u7F3A\u5931)"}`);
      }
      const parsed = Number(raw);
      if (parsed < 1 || parsed > 65535) {
        throw new Error(`\u7AEF\u53E3\u8D85\u51FA\u8303\u56F4: ${raw}\uFF08\u5E94\u4E3A 1-65535\uFF09`);
      }
      port = parsed;
      i++;
      continue;
    }
    if (args[i] === "--host") {
      if (!args[i + 1]) {
        throw new Error("\u7F3A\u5C11 --host \u53C2\u6570\u503C");
      }
      host = args[i + 1];
      i++;
    }
  }
  return { port, host };
}
function createLogger(prefix) {
  return (level, message, data) => {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    process.stderr.write(`[${timestamp}] [${prefix}] [${level}] ${message}${dataStr}
`);
  };
}
async function main() {
  const { port, host } = parseArgs();
  const mainLog = createLogger("main");
  mainLog("info", `eda-mcp-server starting (ws=${host}:${port})`);
  const store = new SnapshotStore();
  const bridge = new WsBridge({
    port,
    host,
    store,
    onSnapshot: (version) => {
      mainLog("info", `Snapshot v${version} received and stored`);
    },
    logger: createLogger("ws-bridge")
  });
  await bridge.start();
  const mcpServer = createMcpServer({
    store,
    bridge,
    logger: createLogger("mcp")
  });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  mainLog("info", "MCP server connected via stdio transport");
  const shutdown = async () => {
    mainLog("info", "Shutting down...");
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
main().catch((error) => {
  process.stderr.write(`[FATAL] ${error instanceof Error ? error.message : String(error)}
`);
  process.exit(1);
});
