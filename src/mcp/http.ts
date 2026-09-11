import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface McpHttpOptions {
  host?: string;
  port: number;
  /** 附加到 /healthz 返回体的诊断信息（如读取的配置文件路径），便于确认配置来源 */
  info?: Record<string, unknown>;
  /**
   * 会话空闲回收阈值（毫秒）。客户端异常断线（未发 DELETE）时，transport 会留在内存里，
   * 长期运行会泄漏。默认 30 分钟空闲即回收。设为 0 可关闭定时回收（仍保留 onclose 即时清理）。
   */
  sessionIdleTimeoutMs?: number;
}

/** 一次 MCP 会话：独立 Server 实例 + 其 transport + 最近活动时间 */
interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastActivity: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * 以 Streamable HTTP 传输层启动 MCP server（单端点 /mcp，兼容 POST 请求 + GET SSE 流式响应）。
 * 适合作为「对外 MCP 链接」被 Cursor / Claude Desktop / 自定义客户端远程调用。
 *
 * - **每个会话一个独立 Server 实例**：SDK 的 `Protocol.connect()` 在同一实例上只允许连接一个
 *   transport（重复 connect 会抛 "Already connected"）。若所有会话共用一个 Server，第二个并发
 *   客户端就会失败。故这里接收的是一个「工厂」，按会话生成新实例。
 * - **会话回收**：客户端正常断开会发 DELETE（触发 transport.onclose 即时清理）；若异常断线
 *   （如浏览器/进程直接关闭、网络中断），则靠定时 sweep 回收空闲超过阈值的会话，避免内存泄漏。
 * - 状态化会话：首次 POST（initialize）生成 Mcp-Session-Id，后续请求需带该头。
 * - 允许跨域（CORS *）以便浏览器 / 远程客户端接入；如需收紧请在反向代理层处理。
 */
export async function startMcpHttpServer(
  createServerInstance: () => Server,
  options: McpHttpOptions
): Promise<HttpServer> {
  const sessions = new Map<string, McpSession>();
  const idleTimeout = options.sessionIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const touch = (id: string): void => {
    const s = sessions.get(id);
    if (s) s.lastActivity = Date.now();
  };

  const removeSession = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close().catch(() => undefined);
    void s.server.close().catch(() => undefined);
  };

  const sweep = idleTimeout > 0
    ? setInterval(() => {
        const now = Date.now();
        const minutes = Math.round(idleTimeout / 60000);
        for (const [id, s] of sessions) {
          if (now - s.lastActivity > idleTimeout) {
            removeSession(id);
            console.warn(`[MCP] 回收空闲会话 ${id}（超过 ${minutes} 分钟未活动）`);
          }
        }
      }, Math.max(5000, Math.min(SWEEP_INTERVAL_MS, Math.floor(idleTimeout / 2))))
    : undefined;

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(createServerInstance, sessions, touch, removeSession, options.info, req, res);
  });

  if (sweep) {
    // 服务器关闭时停止回收定时器，避免常驻引用阻止进程退出
    httpServer.once("close", () => clearInterval(sweep));
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host ?? "127.0.0.1", () => resolve());
  });

  return httpServer;
}

async function handleRequest(
  createServerInstance: () => Server,
  sessions: Map<string, McpSession>,
  touch: (id: string) => void,
  removeSession: (id: string) => void,
  info: Record<string, unknown> | undefined,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // CORS（远程链接常见需求）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, Accept");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  // 健康检查 / 索引
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: "topspeed-builder-mcp",
        status: "ok",
        endpoint: "/mcp",
        transport: "streamable-http",
        activeSessions: sessions.size,
        ...(info ?? {})
      })
    );
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  try {
    if (req.method === "POST") {
      const headerId = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(headerId) ? headerId[0] : headerId;

      if (sessionId && sessions.has(sessionId)) {
        touch(sessionId);
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      // 新会话：为该会话单独创建一个 Server 实例并绑定 transport
      const sessionServer = createServerInstance();
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport: newTransport, server: sessionServer, lastActivity: Date.now() });
        },
        onsessionclosed: (id: string) => {
          // 客户端正常发 DELETE 关闭会话，即时清理
          sessions.delete(id);
        }
      });
      newTransport.onclose = () => {
        if (newTransport.sessionId) {
          removeSession(newTransport.sessionId);
        }
      };
      await sessionServer.connect(newTransport);
      await newTransport.handleRequest(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const headerId = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(headerId) ? headerId[0] : headerId;
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "无效或缺失的 session id" },
            id: null
          })
        );
        return;
      }
      touch(sessionId);
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}
