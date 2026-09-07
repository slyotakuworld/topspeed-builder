import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  CreateProjectInput,
  GenerateAssetInput,
  GridDraft,
  GridSliceOptions,
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
  copyPng: (projectPath: string) => ipcRenderer.invoke("export:copyPng", projectPath),
  readImageDataUrl: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke("image:dataUrl", projectPath, filePath),
  deleteAsset: (projectPath: string, assetId: string) => ipcRenderer.invoke("project:deleteAsset", projectPath, assetId),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:showItem", filePath),
  showProjectItemInFolder: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke("shell:showProjectItem", projectPath, filePath),
  openPath: (filePath: string) => ipcRenderer.invoke("shell:openPath", filePath)
});
