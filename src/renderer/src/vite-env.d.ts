/// <reference types="vite/client" />

/** 由 electron.vite.config.ts 注入的构建时刻（本地时间，每次 dev/构建刷新） */
declare const __APP_BUILD_TS__: string;

import type {
  AppSettings,
  CreateProjectInput,
  GenerateAssetInput,
  GeneratedAssetResult,
  GenerationHistoryEntry,
  GridDraft,
  GridSliceOptions,
  ImportedReferenceImage,
  IpcResponse,
  Project,
  RecentProject
} from "@shared/types";

declare global {
  /** 由 electron.vite.config.ts 注入的构建时刻（本地时间，每次 dev/构建刷新） */
  const __APP_BUILD_TS__: string;

  interface Window {
    topspeedBuilder: {
      createProject(input: CreateProjectInput): Promise<IpcResponse<Project>>;
      openProjectPath(projectPath: string): Promise<IpcResponse<Project>>;
      chooseDirectory(title: string, defaultPath?: string): Promise<IpcResponse<string>>;
      saveProject(project: Project): Promise<IpcResponse<Project>>;
      deleteAsset(projectPath: string, assetId: string): Promise<IpcResponse<Project>>;
      listDiscoverableProjects(): Promise<IpcResponse<RecentProject[]>>;
      getSettings(): Promise<IpcResponse<AppSettings>>;
      saveSettings(settings: AppSettings): Promise<IpcResponse<AppSettings>>;
      testConnection(settings: AppSettings): Promise<IpcResponse<{ ok: boolean; status: number; detail: string }>>;
      fetchModels(settings: AppSettings): Promise<IpcResponse<string[]>>;
      chooseReferenceImages(projectPath: string): Promise<IpcResponse<ImportedReferenceImage[]>>;
      generateGrid(input: GenerateAssetInput): Promise<IpcResponse<GridDraft>>;
      commitSlice(
        input: GenerateAssetInput,
        draft: GridDraft,
        options: GridSliceOptions
      ): Promise<IpcResponse<GeneratedAssetResult>>;
      copyPng(projectPath: string): Promise<IpcResponse<string>>;
      listGenerationHistory(projectPath: string): Promise<IpcResponse<GenerationHistoryEntry[]>>;
      removeGenerationHistory(projectPath: string, runId: string): Promise<IpcResponse<boolean>>;
      saveHistorySnapshot(
        projectPath: string,
        runId: string | null,
        input: GenerateAssetInput
      ): Promise<IpcResponse<{ runId: string }>>;
      readImageDataUrl(projectPath: string, filePath: string): Promise<IpcResponse<string>>;
      readImageThumbnail(projectPath: string, runId: string): Promise<IpcResponse<string>>;
      showItemInFolder(filePath: string): Promise<IpcResponse<boolean>>;
      showProjectItemInFolder(projectPath: string, filePath: string): Promise<IpcResponse<boolean>>;
      openPath(filePath: string): Promise<IpcResponse<boolean>>;
      /** 性能诊断单向上报（写 <userData>/perf-log.txt），无此方法时静默降级 */
      perfLog?(line: string): void;
    };
  }
}
