import path from "node:path";
import fs from "fs-extra";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AppSettings,
  CreateProjectInput,
  GenerateAssetInput,
  GridDraft,
  GridSliceOptions,
  IpcResponse,
  Project
} from "@shared/types";
import { AIGenerationService } from "./services/aiService";
import { GenerationHistoryService } from "./services/generationHistoryService";
import { GenerationService } from "./services/generationService";
import { ImageProcessingService } from "./services/imageService";
import { ProjectService } from "./services/projectService";
import { ReferenceService } from "./services/referenceService";
import { SettingsService } from "./services/settingsService";
import { resolveProjectPath, sanitizeFileName } from "./services/utils";

const settingsService = new SettingsService();
const projectService = new ProjectService(settingsService);
const referenceService = new ReferenceService();
const aiService = new AIGenerationService();
const imageService = new ImageProcessingService();
const historyService = new GenerationHistoryService();
const generationService = new GenerationService(
  settingsService,
  projectService,
  aiService,
  imageService,
  historyService
);

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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
