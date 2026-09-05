/// <reference types="vite/client" />

import type {
  AppSettings,
  CreateProjectInput,
  ExportProjectInput,
  ExportProjectResult,
  GenerateAssetInput,
  GeneratedAssetResult,
  GenerationHistoryRecord,
  ImportedReferenceImage,
  IpcResponse,
  Project,
  RecentProject
} from "@shared/types";

declare global {
  interface Window {
    topspeedBuilder: {
      createProject(input: CreateProjectInput): Promise<IpcResponse<Project>>;
      chooseProjectRoot(): Promise<IpcResponse<string>>;
      openProjectDialog(): Promise<IpcResponse<Project>>;
      openProjectPath(projectPath: string): Promise<IpcResponse<Project>>;
      saveProject(project: Project): Promise<IpcResponse<Project>>;
      deleteAsset(projectPath: string, assetId: string): Promise<IpcResponse<Project>>;
      getRecentProjects(): Promise<IpcResponse<RecentProject[]>>;
      removeRecentProject(projectPath: string): Promise<IpcResponse<RecentProject[]>>;
      getSettings(): Promise<IpcResponse<AppSettings>>;
      saveSettings(settings: AppSettings): Promise<IpcResponse<AppSettings>>;
      testConnection(settings: AppSettings): Promise<IpcResponse<{ ok: boolean; status: number; detail: string }>>;
      fetchModels(settings: AppSettings): Promise<IpcResponse<string[]>>;
      chooseReferenceImages(projectPath: string): Promise<IpcResponse<ImportedReferenceImage[]>>;
      chooseMaskImage(projectPath: string): Promise<IpcResponse<ImportedReferenceImage>>;
      generateAssets(input: GenerateAssetInput): Promise<IpcResponse<GeneratedAssetResult>>;
      exportProject(input: ExportProjectInput): Promise<IpcResponse<ExportProjectResult>>;
      getHistory(projectPath: string): Promise<IpcResponse<GenerationHistoryRecord[]>>;
      readImageDataUrl(projectPath: string, filePath: string): Promise<IpcResponse<string>>;
      showItemInFolder(filePath: string): Promise<IpcResponse<boolean>>;
      showProjectItemInFolder(projectPath: string, filePath: string): Promise<IpcResponse<boolean>>;
      openPath(filePath: string): Promise<IpcResponse<boolean>>;
    };
  }
}
