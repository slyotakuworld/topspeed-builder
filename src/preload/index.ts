import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  CreateProjectInput,
  ExportProjectInput,
  GenerateAssetInput,
  Project
} from "@shared/types";

contextBridge.exposeInMainWorld("topspeedBuilder", {
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke("project:create", input),
  chooseProjectRoot: () => ipcRenderer.invoke("project:chooseRoot"),
  openProjectDialog: () => ipcRenderer.invoke("project:openDialog"),
  openProjectPath: (projectPath: string) => ipcRenderer.invoke("project:openPath", projectPath),
  saveProject: (project: Project) => ipcRenderer.invoke("project:save", project),
  getRecentProjects: () => ipcRenderer.invoke("project:recent"),
  removeRecentProject: (projectPath: string) => ipcRenderer.invoke("project:removeRecent", projectPath),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke("settings:save", settings),
  testConnection: (settings: AppSettings) => ipcRenderer.invoke("settings:testConnection", settings),
  fetchModels: (settings: AppSettings) => ipcRenderer.invoke("settings:fetchModels", settings),
  chooseReferenceImages: (projectPath: string) => ipcRenderer.invoke("reference:chooseImages", projectPath),
  chooseMaskImage: (projectPath: string) => ipcRenderer.invoke("reference:chooseMask", projectPath),
  generateAssets: (input: GenerateAssetInput) => ipcRenderer.invoke("generate:assets", input),
  exportProject: (input: ExportProjectInput) => ipcRenderer.invoke("export:project", input),
  getHistory: (projectPath: string) => ipcRenderer.invoke("history:get", projectPath),
  readImageDataUrl: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke("image:dataUrl", projectPath, filePath),
  deleteAsset: (projectPath: string, assetId: string) => ipcRenderer.invoke("project:deleteAsset", projectPath, assetId),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:showItem", filePath),
  showProjectItemInFolder: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke("shell:showProjectItem", projectPath, filePath),
  openPath: (filePath: string) => ipcRenderer.invoke("shell:openPath", filePath)
});
