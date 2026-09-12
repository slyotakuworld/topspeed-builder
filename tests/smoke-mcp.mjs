// 冒烟测试：启动独立 MCP server（子进程）→ 健康检查 → 双会话并发 initialize → tools/list
// 双会话是为了回归验证「同一 Server 实例被重复 connect 会抛 Already connected」的问题已修复。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["build/extra/mcp.cjs"], {
  env: { ...process.env, MCP_PORT: String(PORT), MCP_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d.toString()));
child.stderr.on("data", (d) => (serverLog += d.toString()));

function parseMcpResponse(text) {
  // 可能是纯 JSON 或 SSE（data: {...}）
  const dataLine = text
    .split("\n")
    .find((l) => l.startsWith("data:"));
  const json = dataLine ? dataLine.slice(5).trim() : text.trim();
  try {
    return JSON.parse(json);
  } catch {
    return { raw: text };
  }
}

async function initialize(label) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: label, version: "1.0" } }
    })
  });
  const body = parseMcpResponse(await res.text());
  console.log(`INITIALIZE[${label}] status:`, res.status, "session:", res.headers.get("mcp-session-id"));
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), body };
}

async function listTools(sessionId) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId ?? ""
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });
  const body = parseMcpResponse(await res.text());
  return body?.result?.tools ?? [];
}

try {
  await sleep(3500);

  const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
  console.log("HEALTH:", JSON.stringify(health));

  // 两个会话同时保持打开（不关闭第一个），验证并发可用
  const a = await initialize("smoke-A");
  const b = await initialize("smoke-B");

  const toolsA = await listTools(a.sessionId);
  const toolsB = await listTools(b.sessionId);
  console.log("TOOLS[A]:", toolsA.map((t) => t.name).join(", "));
  console.log("TOOLS[B]:", toolsB.map((t) => t.name).join(", "));
  console.log("TOOL SCHEMA REQUIRED:", JSON.stringify(toolsA[0]?.inputSchema?.required));

  const ok =
    a.status === 200 &&
    b.status === 200 &&
    toolsA.length === 1 &&
    toolsB.length === 1 &&
    toolsA[0].name === "generate_sprites" &&
    toolsB[0].name === "generate_sprites";
  console.log("OK:", ok);
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.error("SMOKE FAILED:", err);
  console.error("SERVER LOG:\n", serverLog);
  process.exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
}
