// MCP 会话回收验证：1) 正常 DELETE 即时清理  2) 空闲会话定时回收（避免异常断线泄漏）
import { spawn } from "node:child_process";

const PORT = 3398;
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(
    process.execPath,
    ["build/extra/mcp.cjs"],
    {
      env: { ...process.env, MCP_PORT: String(PORT), MCP_HOST: HOST, MCP_SESSION_IDLE_MS: "1500" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function post(body, sessionId) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const sid = res.headers.get("mcp-session-id");
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: res.status, sid, data };
}

async function del(sessionId) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId }
  });
  return res.status;
}

async function health() {
  const res = await fetch(`${BASE}/healthz`);
  return res.json();
}

async function initSession(tag) {
  const init = await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: tag, version: "1.0" } }
  });
  if (init.status !== 200 || !init.sid) throw new Error(`[${tag}] initialize 失败 status=${init.status} sid=${init.sid}`);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.sid);
  return init.sid;
}

const child = startServer();
let failed = false;
try {
  await sleep(2500); // 等 sharp 加载
  const h0 = await health();
  console.log("启动后 activeSessions:", h0.activeSessions, h0.activeSessions === 0 ? "OK" : "FAIL");
  if (h0.activeSessions !== 0) failed = true;

  // 1) 正常 DELETE → 即时清理
  const sidA = await initSession("sweep-A");
  const h1 = await health();
  console.log("建会话A后 activeSessions:", h1.activeSessions, h1.activeSessions === 1 ? "OK" : "FAIL");
  if (h1.activeSessions !== 1) failed = true;

  const delStatus = await del(sidA);
  await sleep(300);
  const h2 = await health();
  console.log(`DELETE 状态=${delStatus}；删除后 activeSessions:`, h2.activeSessions, h2.activeSessions === 0 ? "OK" : "FAIL");
  if (h2.activeSessions !== 0) failed = true;

  // 2) 空闲会话定时回收（不发 DELETE，等 sweep 超过 1.5s 阈值）
  const sidB = await initSession("sweep-B");
  const h3 = await health();
  console.log("建会话B后 activeSessions:", h3.activeSessions, h3.activeSessions === 1 ? "OK" : "FAIL");
  if (h3.activeSessions !== 1) failed = true;

  console.log("等待 7s 让 sweep 回收空闲会话B…");
  await sleep(7000);
  const h4 = await health();
  console.log("空闲回收后 activeSessions:", h4.activeSessions, h4.activeSessions === 0 ? "OK" : "FAIL");
  if (h4.activeSessions !== 0) failed = true;

  console.log(failed ? "\n❌ 存在失败断言" : "\n✅ 会话回收全部验证通过");
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error("测试异常:", e);
  process.exit(1);
} finally {
  child.kill("SIGTERM");
}
