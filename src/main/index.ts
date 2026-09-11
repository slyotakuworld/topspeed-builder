import path from "node:path";
import fs from "fs-extra";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AppSettings,
  CreateProjectInput,
  FreeCutData,
  GenerateAssetInput,
  GridDraft,
  GridSliceOptions,
  IpcResponse,
  ManualRegion,
  Project,
  PromptAssistantSettings,
  PromptAssistantInput
} from "@shared/types";
import { createServices, type Services } from "./services/factory";
import { getUserDataDir, resolveProjectPath, sanitizeFileName } from "./services/utils";

const services: Services = createServices();
const { settingsService, projectService, referenceService, aiService, imageService, historyService, generationService, promptAssistantService } = services;

// ---- 运行时性能诊断：记录到 <userData>/perf-log.txt，便于定位「历史加载后输入卡顿」类问题 ----
const perfLogPath = path.join(app.getPath("userData"), "perf-log.txt");
let perfLogWrites = 0;
function appendPerfLine(line: string): void {
  perfLogWrites += 1;
  void (async () => {
    try {
      await fs.ensureDir(path.dirname(perfLogPath));
      if (perfLogWrites === 1 || (await fs.pathExists(perfLogPath)) === false) {
        await fs.writeFile(perfLogPath, "");
      }
      // 防日志无限膨胀：超过 1MB 时丢弃最旧一半
      const stat = await fs.stat(perfLogPath).catch(() => null);
      if (stat && stat.size > 1024 * 1024) {
        const raw = await fs.readFile(perfLogPath, "utf8");
        await fs.writeFile(perfLogPath, raw.slice(raw.length - 512 * 1024));
      }
      await fs.appendFile(perfLogPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // 诊断日志失败不影响主流程
    }
  })();
}
let perfLagLast = Date.now();
function installPerfSamplers(): void {
  // 渲染进程单向上报（长任务/链路计时）
  ipcMain.on("perf:log", (_event, line: unknown) => {
    if (typeof line === "string") appendPerfLine(`[renderer] ${line.slice(0, 500)}`);
  });
  // 主进程事件循环延迟采样：2s 心跳，漂移 >150ms 说明主进程被长时间阻塞
  setInterval(() => {
    const now = Date.now();
    const drift = now - perfLagLast - 2000;
    perfLagLast = now;
    if (drift > 150) appendPerfLine(`[main] event-loop lag ~${drift}ms (blocked)`);
  }, 2000);
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    title: "Topspeed Builder",
    backgroundColor: "#07090b",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  handle("project:create", (input: CreateProjectInput) => projectService.createProject(input));
  handle("project:openPath", (projectPath: string) => projectService.openProjectPath(projectPath));
  handle("project:save", (project: Project) => projectService.saveProject(project));
  handle("project:listDiscoverable", () => projectService.listDiscoverableProjects());

  handle("settings:get", () => settingsService.getSettings());
  handle("settings:save", (settings: AppSettings) => settingsService.saveSettings(settings));
  handle("settings:testConnection", (settings: AppSettings) => aiService.testConnection(settings));
  handle("settings:fetchModels", (settings: AppSettings) => aiService.fetchModels(settings));
  // 提示词助手：独立于出图模型的配置与调用
  handle("settings:getPromptAssistant", () => settingsService.getPromptAssistant());
  handle("settings:savePromptAssistant", (data: PromptAssistantSettings) => settingsService.savePromptAssistant(data));
  handle("promptAssistant:test", (settings: PromptAssistantSettings) => promptAssistantService.testConnection(settings));
  handle("promptAssistant:fetchModels", (settings: PromptAssistantSettings) => promptAssistantService.fetchModels(settings));
  handle("promptAssistant:generate", (settings: PromptAssistantSettings, input: PromptAssistantInput) =>
    promptAssistantService.generate(settings, input)
  );
  handle("dialog:chooseDirectory", async (title: string, defaultPath: string) => {
    const result = await dialog.showOpenDialog({
      title: title || "选择目录",
      defaultPath: defaultPath || undefined,
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0];
  });

  handle("project:deleteAsset", async (projectPath: string, assetId: string) => {
    const project = await projectService.deleteAsset(projectPath, assetId);
    await historyService.removeByAsset(projectPath, assetId);
    return project;
  });
  handle("reference:chooseImages", (projectPath: string) => referenceService.chooseReferenceImages(projectPath));

  handle("generate:grid", (input: GenerateAssetInput) => generationService.generateGrid(input));
  handle("generate:commit", (input: GenerateAssetInput, draft: GridDraft, options: GridSliceOptions) =>
    generationService.commitSlice(input, draft, options)
  );
  // 对已有大图重新跑一次内容感知检测（不重新生成图）。载入历史草稿时用它刷新绿框预览，
  // 避免看到旧算法留下的缓存结果——真正切分时 commitSlice 本来就会重算，两者必须一致。
  handle("grid:detectAutoCells", async (projectPath: string, gridImagePath: string, count: number) => {
    if (count <= 1) return null;
    const absolutePath = resolveProjectPath(projectPath, gridImagePath);
    if (!(await fs.pathExists(absolutePath))) return null;
    return imageService.detectAutoCells(await fs.readFile(absolutePath), count);
  });
  // 自由切图：独立于智能对齐与正常导出。load 无缓存时回退智能对齐结果作为初始数据；
  // restore 重新跑检测覆盖缓存；export 按用户多边形区域裁切并入库。
  handle("freecut:load", (projectPath: string, gridImagePath: string, count: number, runId: string) =>
    generationService.loadFreeCut(projectPath, gridImagePath, count, runId)
  );
  handle("freecut:save", (projectPath: string, gridImagePath: string, data: FreeCutData) =>
    generationService.saveFreeCut(projectPath, gridImagePath, data)
  );
  handle("freecut:restore", (projectPath: string, gridImagePath: string, count: number, runId: string) =>
    generationService.restoreFreeCut(projectPath, gridImagePath, count, runId)
  );
  handle(
    "freecut:export",
    (input: GenerateAssetInput, gridImagePath: string, runId: string, regions: ManualRegion[]) =>
      generationService.sliceManualRegions(input, gridImagePath, runId, regions)
  );
  handle("history:list", (projectPath: string) => historyService.list(projectPath));
  handle("history:remove", (projectPath: string, runId: string) => historyService.remove(projectPath, runId));
  handle("history:saveSnapshot", (projectPath: string, runId: string | null, input: GenerateAssetInput) =>
    historyService.saveSnapshot(projectPath, runId, input)
  );
  handle("image:thumbnail", (projectPath: string, runId: string) => historyService.thumbnailDataUrl(projectPath, runId));
  handle("export:copyPng", async (projectPath: string) => {
    const project = await projectService.openProjectPath(projectPath);
    const settings = await settingsService.getSettings();
    const destination = settings.defaultExportDirectory.trim();
    if (!destination) {
      throw new Error("未配置默认导出目录：请先在设置页选择导出目录。");
    }
    const sourceDirectory = path.join(project.path, "sprites");
    if (!(await fs.pathExists(sourceDirectory))) {
      throw new Error("项目里还没有可导出的素材。");
    }
    const targetDirectory = path.join(destination, sanitizeFileName(project.name), "sprites");
    await fs.copy(sourceDirectory, targetDirectory, { overwrite: true });
    return targetDirectory;
  });

  handle("image:dataUrl", async (projectPath: string, filePath: string) => {
    const absolutePath = resolveProjectPath(projectPath, filePath);
    // 预览通道：超过 1024px 的大图在主进程降采样后再返回，绝不让渲染进程解码全尺寸网格图/参考图
    return imageService.previewDataUrl(absolutePath, 1024);
  });

  handle("shell:showItem", async (filePath: string) => {
    shell.showItemInFolder(filePath);
    return true;
  });

  handle("shell:showProjectItem", async (projectPath: string, filePath: string) => {
    shell.showItemInFolder(resolveProjectPath(projectPath, filePath));
    return true;
  });

  handle("shell:openPath", async (filePath: string) => {
    const result = await shell.openPath(filePath);
    if (result) {
      throw new Error(result);
    }
    return true;
  });
}

function handle<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (...args: TArgs) => Promise<TResult> | TResult
): void {
  ipcMain.handle(channel, async (_event, ...args: TArgs): Promise<IpcResponse<TResult>> => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  installPerfSamplers();
  createWindow();

  // 对外 MCP 链接（可选）：仅在设置 MCP_PORT 时，在主进程内启动 HTTP/SSE MCP server，
  // 复用已实例化的 services（与 GUI 完全一致的出图 / 切图逻辑）。
  if (process.env.MCP_PORT) {
    void startMcpInMainProcess(services).catch((err) => {
      console.error("[MCP] 主进程内启动 MCP server 失败：", err);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

async function startMcpInMainProcess(shared: Services): Promise<void> {
  const { createMcpServer } = await import("../mcp/server");
  const { startMcpHttpServer } = await import("../mcp/http");
  const port = Number(process.env.MCP_PORT);
  const host = process.env.MCP_HOST || "127.0.0.1";
  const idleEnv = process.env.MCP_SESSION_IDLE_MS;
  const idleMs = idleEnv === undefined || idleEnv === "" ? undefined : Number(idleEnv);
  const sessionIdleTimeoutMs =
    idleMs === undefined || Number.isNaN(idleMs) || idleMs < 0 ? undefined : idleMs;
  const settingsPath = path.join(getUserDataDir(), "settings.json");
  // 传入工厂而非实例：每个 MCP 会话使用独立 Server 实例，支持并发客户端
  const httpServer = await startMcpHttpServer(() => createMcpServer(shared), {
    host,
    port,
    info: { settingsPath, settingsFound: await fs.pathExists(settingsPath) },
    sessionIdleTimeoutMs
  });
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  console.log(`[MCP] 主进程 MCP server 已启动：http://${host}:${boundPort}/mcp`);
  console.log(`[MCP] 出图配置：${settingsPath}`);
  if (host === "0.0.0.0") {
    console.warn("[MCP] 警告：MCP 监听 0.0.0.0，请确认已有网络层鉴权/防火墙保护。");
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
