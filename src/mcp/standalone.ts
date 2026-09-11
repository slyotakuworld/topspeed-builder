import fs from "fs-extra";
import path from "node:path";
import { createMcpServer } from "./server";
import { startMcpHttpServer } from "./http";
import { createServices } from "../main/services/factory";
import { getUserDataDir } from "../main/services/utils";

/**
 * 独立启动 MCP server（无 GUI）：用于把出图 / 切图能力以「对外 MCP 链接」暴露给远程客户端。
 *
 * 环境变量：
 * - MCP_PORT：必填，HTTP 监听端口（不设置则本脚本直接退出）。
 * - MCP_HOST：可选，监听地址，默认 127.0.0.1；设 0.0.0.0 可对外网/局域网开放（请注意鉴权风险）。
 * - MCP_SESSION_IDLE_MS：可选，空闲会话回收阈值（毫秒），默认 1800000（30 分钟）。
 *   客户端异常断线（未发 DELETE）的会话会在此阈值后被回收，避免内存泄漏；设 0 关闭定时回收。
 * - TOPSPEED_USER_DATA：可选，配置目录（settings.json 等），默认 ~/.topspeed-builder。
 */
async function main(): Promise<void> {
  const port = Number(process.env.MCP_PORT);
  if (!port || Number.isNaN(port)) {
    console.error("未设置 MCP_PORT，MCP server 不启动。用法：MCP_PORT=3000 [MCP_HOST=127.0.0.1] npm run mcp");
    process.exit(1);
  }
  const host = process.env.MCP_HOST || "127.0.0.1";

  const idleEnv = process.env.MCP_SESSION_IDLE_MS;
  const idleMs = idleEnv === undefined || idleEnv === "" ? undefined : Number(idleEnv);
  const sessionIdleTimeoutMs =
    idleMs === undefined || Number.isNaN(idleMs) || idleMs < 0 ? undefined : idleMs;

  // 明确告知读的是哪份配置：默认与 GUI 共享同一个 userData 目录（settings.json）
  const settingsPath = path.join(getUserDataDir(), "settings.json");
  const hasSettings = await fs.pathExists(settingsPath);
  console.log(
    `[MCP] 出图配置：${settingsPath}${hasSettings ? "" : "（未找到，将使用空配置；请在 GUI 设置页配置出图 API）"}`
  );

  const services = createServices();
  // 传入工厂而非实例：HTTP 传输层会为每个会话创建独立的 Server 实例（支持并发客户端）
  const httpServer = await startMcpHttpServer(() => createMcpServer(services), {
    host,
    port,
    info: { settingsPath, settingsFound: hasSettings },
    sessionIdleTimeoutMs
  });

  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  console.log(`[MCP] Topspeed Builder MCP server 已启动：http://${host}:${boundPort}/mcp`);
  console.log(`[MCP] 健康检查：http://${host}:${boundPort}/healthz`);
  if (host === "0.0.0.0") {
    console.warn("[MCP] 警告：监听地址为 0.0.0.0（对所有网络接口开放），请确保有网络层鉴权/防火墙保护。");
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[MCP] 收到 ${signal}，正在关闭…`);
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err) => {
  console.error("[MCP] 启动失败：", err);
  process.exit(1);
});
