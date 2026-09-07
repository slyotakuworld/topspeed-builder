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
const generationService = new GenerationService(
  settingsService,
  projectService,
  aiService,
  imageService
);

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

  handle("project:deleteAsset", (projectPath: string, assetId: string) => projectService.deleteAsset(projectPath, assetId));
  handle("reference:chooseImages", (projectPath: string) => referenceService.chooseReferenceImages(projectPath));

  handle("generate:grid", (input: GenerateAssetInput) => generationService.generateGrid(input));
  handle("generate:commit", (input: GenerateAssetInput, draft: GridDraft, options: GridSliceOptions) =>
    generationService.commitSlice(input, draft, options)
  );
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
    const buffer = await fs.readFile(absolutePath);
    const extension = path.extname(absolutePath).replace(".", "").toLowerCase() || "png";
    const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
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
