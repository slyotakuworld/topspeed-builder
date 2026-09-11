import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  CreateProjectInput,
  FreeCutData,
  GenerateAssetInput,
  GeneratedAssetResult,
  GridDraft,
  GridSliceOptions,
  ManualRegion,
  Project
} from "@shared/types";

contextBridge.exposeInMainWorld("topspeedBuilder", {
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke("project:create", input),
  openProjectPath: (projectPath: string) => ipcRenderer.invoke("project:openPath", projectPath),
  chooseDirectory: (title: string, defaultPath?: string) =>
    ipcRenderer.invoke("dialog:chooseDirectory", title, defaultPath ?? ""),
  saveProject: (project: Project) => ipcRenderer.invoke("project:save", project),
  listDiscoverableProjects: () => ipcRenderer.invoke("project:listDiscoverable"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke("settings:save", settings),
  testConnection: (settings: AppSettings) => ipcRenderer.invoke("settings:testConnection", settings),
  fetchModels: (settings: AppSettings) => ipcRenderer.invoke("settings:fetchModels", settings),
  chooseReferenceImages: (projectPath: string) => ipcRenderer.invoke("reference:chooseImages", projectPath),
  generateGrid: (input: GenerateAssetInput) => ipcRenderer.invoke("generate:grid", input),
  commitSlice: (input: GenerateAssetInput, draft: GridDraft, options: GridSliceOptions) =>
    ipcRenderer.invoke("generate:commit", input, draft, options),
  detectAutoCells: (projectPath: string, gridImagePath: string, count: number) =>
    ipcRenderer.invoke("grid:detectAutoCells", projectPath, gridImagePath, count),
  freecutLoad: (projectPath: string, gridImagePath: string, count: number, runId: string) =>
    ipcRenderer.invoke("freecut:load", projectPath, gridImagePath, count, runId),
  freecutSave: (projectPath: string, gridImagePath: string, data: FreeCutData) =>
    ipcRenderer.invoke("freecut:save", projectPath, gridImagePath, data),
  freecutRestore: (projectPath: string, gridImagePath: string, count: number, runId: string) =>
    ipcRenderer.invoke("freecut:restore", projectPath, gridImagePath, count, runId),
  freecutExport: (input: GenerateAssetInput, gridImagePath: string, runId: string, regions: ManualRegion[]) =>
    ipcRenderer.invoke("freecut:export", input, gridImagePath, runId, regions),
  copyPng: (projectPath: string) => ipcRenderer.invoke("export:copyPng", projectPath),
  listGenerationHistory: (projectPath: string) => ipcRenderer.invoke("history:list", projectPath),
  removeGenerationHistory: (projectPath: string, runId: string) =>
    ipcRenderer.invoke("history:remove", projectPath, runId),
  saveHistorySnapshot: (projectPath: string, runId: string | null, input: GenerateAssetInput) =>
    ipcRenderer.invoke("history:saveSnapshot", projectPath, runId, input),
  readImageDataUrl: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke("image:dataUrl", projectPath, filePath),
  readImageThumbnail: (projectPath: string, runId: string) =>
    ipcRenderer.invoke("image:thumbnail", projectPath, runId),
  deleteAsset: (projectPath: string, assetId: string) => ipcRenderer.invoke("project:deleteAsset", projectPath, assetId),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:showItem", filePath),
  showProjectItemInFolder: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke("shell:showProjectItem", projectPath, filePath),
  openPath: (filePath: string) => ipcRenderer.invoke("shell:openPath", filePath),
  perfLog: (line: string) => ipcRenderer.send("perf:log", line)
});
