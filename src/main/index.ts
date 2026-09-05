import path from "node:path";
import fs from "fs-extra";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type {
  AppSettings,
  CreateProjectInput,
  ExportProjectInput,
  GenerateAssetInput,
  IpcResponse,
  Project
} from "@shared/types";
import { AIGenerationService } from "./services/aiService";
import { AtlasPackingService } from "./services/atlasService";
import { ExportService } from "./services/exportService";
import { GenerationService } from "./services/generationService";
import { HistoryService } from "./services/historyService";
import { ImageProcessingService } from "./services/imageService";
import { ProjectService } from "./services/projectService";
import { ReferenceService } from "./services/referenceService";
import { SettingsService } from "./services/settingsService";
import { SpriteSheetService } from "./services/spriteSheetService";
import { TileSetService } from "./services/tileSetService";
import { resolveProjectPath } from "./services/utils";

const settingsService = new SettingsService();
const projectService = new ProjectService(settingsService);
const referenceService = new ReferenceService();
const aiService = new AIGenerationService();
const imageService = new ImageProcessingService();
const spriteSheetService = new SpriteSheetService();
const atlasService = new AtlasPackingService();
const tileSetService = new TileSetService();
const historyService = new HistoryService();
const exportService = new ExportService();
const generationService = new GenerationService(
  settingsService,
  projectService,
  aiService,
  imageService,
  spriteSheetService,
  atlasService,
  tileSetService,
  historyService
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
  handle("project:chooseRoot", () => projectService.chooseProjectRoot());
  handle("project:openDialog", () => projectService.openProjectDialog());
  handle("project:openPath", (projectPath: string) => projectService.openProjectPath(projectPath));
  handle("project:save", (project: Project) => projectService.saveProject(project));
  handle("project:recent", () => projectService.getRecentProjects());
  handle("project:removeRecent", (projectPath: string) => projectService.removeRecentProject(projectPath));

  handle("settings:get", () => settingsService.getSettings());
  handle("settings:save", (settings: AppSettings) => settingsService.saveSettings(settings));
  handle("settings:testConnection", (settings: AppSettings) => aiService.testConnection(settings));
  handle("settings:fetchModels", (settings: AppSettings) => aiService.fetchModels(settings));

  handle("project:deleteAsset", (projectPath: string, assetId: string) => projectService.deleteAsset(projectPath, assetId));
  handle("reference:chooseImages", (projectPath: string) => referenceService.chooseReferenceImages(projectPath));
  handle("reference:chooseMask", (projectPath: string) => referenceService.chooseMask(projectPath));

  handle("generate:assets", (input: GenerateAssetInput) => generationService.generate(input));
  handle("history:get", (projectPath: string) => historyService.getHistory(projectPath));

  handle("export:project", async (input: ExportProjectInput) => {
    const project = await projectService.openProjectPath(input.projectPath);
    return exportService.exportProject(project, input);
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
