import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, dialog } from "electron";
import fs from "fs-extra";
import type { CreateProjectInput, Project, RecentProject, StyleTemplate } from "@shared/types";
import {
  ensureProjectDirectories,
  nowIso,
  readJsonFile,
  resolveProjectPath,
  sanitizeFileName,
  uniqueByPath,
  withFileLock,
  writeJsonFile
} from "./utils";
import { SettingsService } from "./settingsService";

export class ProjectService {
  private readonly recentPath: string;

  constructor(private readonly settingsService: SettingsService) {
    this.recentPath = path.join(app.getPath("userData"), "recent-projects.json");
  }

  async chooseProjectRoot(): Promise<string> {
    const result = await dialog.showOpenDialog({
      title: "选择项目父目录",
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("已取消选择目录");
    }

    return result.filePaths[0];
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const settings = await this.settingsService.getSettings();
    const parentDirectory = input.parentDirectory?.trim() || settings.defaultProjectRoot;
    const projectPath = path.join(parentDirectory, sanitizeFileName(input.name));

    if (await fs.pathExists(path.join(projectPath, "project.json"))) {
      throw new Error(`项目已存在：${projectPath}`);
    }

    await ensureProjectDirectories(projectPath);

    const createdAt = nowIso();
    const project: Project = {
      id: randomUUID(),
      name: input.name.trim() || "未命名项目",
      path: projectPath,
      gameType: input.gameType,
      style: input.style,
      styleDescription: input.style,
      defaultResolution: input.defaultResolution,
      defaultBackground: input.defaultBackground,
      exportTargets: input.exportTargets,
      assets: [],
      styleTemplates: [
        {
          id: randomUUID(),
          name: "十六位像素风",
          description: "十六位像素美术，轮廓干净，限制色板，透明背景",
          lineWeight: "清晰一像素边缘",
          lighting: "左上方柔和主光",
          cameraView: "侧视角"
        },
        {
          id: randomUUID(),
          name: "暗黑地牢",
          description: "暗黑地牢幻想，可读形状，低饱和金属与石材色板",
          lineWeight: "粗轮廓",
          lighting: "低照度暖色火把光",
          cameraView: "俯视角"
        }
      ],
      createdAt,
      updatedAt: createdAt
    };

    await this.saveProject(project);
    return project;
  }

  async openProjectDialog(): Promise<Project> {
    const result = await dialog.showOpenDialog({
      title: "打开 Topspeed Builder 项目",
      filters: [{ name: "Topspeed Builder 项目", extensions: ["json"] }],
      properties: ["openFile"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("已取消打开项目");
    }

    return this.openProjectPath(result.filePaths[0]);
  }

  async openProjectPath(inputPath: string): Promise<Project> {
    const projectJsonPath = this.projectJsonPath(inputPath);

    if (!(await fs.pathExists(projectJsonPath))) {
      throw new Error(`未找到项目配置文件：${projectJsonPath}`);
    }

    return withFileLock(projectJsonPath, async () => {
      const normalized = await this.readNormalizedProject(projectJsonPath);
      return this.saveProjectUnlocked(normalized);
    });
  }

  async saveProject(project: Project): Promise<Project> {
    return withFileLock(path.join(project.path, "project.json"), () => this.saveProjectUnlocked(project));
  }

  private async saveProjectUnlocked(project: Project): Promise<Project> {
    const nextProject: Project = {
      ...project,
      updatedAt: nowIso()
    };

    await ensureProjectDirectories(nextProject.path);
    await writeJsonFile(path.join(nextProject.path, "project.json"), nextProject);
    await this.addRecent(nextProject);
    return nextProject;
  }

  async addAssets(projectPath: string, assets: Project["assets"]): Promise<Project> {
    return withFileLock(path.join(projectPath, "project.json"), async () => {
      const project = await this.readNormalizedProject(this.projectJsonPath(projectPath));
      const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]));

      for (const asset of assets) {
        assetMap.set(asset.id, asset);
      }

      return this.saveProjectUnlocked({
        ...project,
        assets: Array.from(assetMap.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      });
    });
  }

  async getRecentProjects(): Promise<RecentProject[]> {
    return withFileLock(this.recentPath, async () => {
      const recent = await readJsonFile<RecentProject[]>(this.recentPath, []);
      const existing: RecentProject[] = [];

      for (const item of recent) {
        if (await fs.pathExists(path.join(item.path, "project.json"))) {
          existing.push({
            ...item,
            name: this.translateLegacyDefault(item.name),
            style: this.translateLegacyDefault(item.style)
          });
        }
      }

      if (existing.length !== recent.length) {
        await writeJsonFile(this.recentPath, existing);
      }

      return existing;
    });
  }

  async deleteAsset(projectPath: string, assetId: string): Promise<Project> {
    return withFileLock(path.join(projectPath, "project.json"), async () => {
      const project = await this.readNormalizedProject(this.projectJsonPath(projectPath));
      const asset = project.assets.find((a) => a.id === assetId);
      if (asset) {
        const allPaths = [
          ...asset.files,
          asset.metadataPath,
          asset.atlasPath,
          asset.sheetPath
        ].filter(Boolean) as string[];
        for (const file of allPaths) {
          try { await fs.remove(resolveProjectPath(project.path, file)); } catch { /* may not exist */ }
        }
      }
      return this.saveProjectUnlocked({ ...project, assets: project.assets.filter((a) => a.id !== assetId) });
    });
  }

  async removeRecentProject(projectPath: string): Promise<RecentProject[]> {
    return withFileLock(this.recentPath, async () => {
      const recent = await readJsonFile<RecentProject[]>(this.recentPath, []);
      const next = recent.filter((item) => path.normalize(item.path) !== path.normalize(projectPath));
      await writeJsonFile(this.recentPath, next);
      return next;
    });
  }

  private async addRecent(project: Project): Promise<void> {
    await withFileLock(this.recentPath, async () => {
      const recent = await readJsonFile<RecentProject[]>(this.recentPath, []);
      const next = uniqueByPath([
        {
          id: project.id,
          name: project.name,
          path: project.path,
          gameType: project.gameType,
          style: project.style,
          updatedAt: nowIso()
        },
        ...recent
      ]).slice(0, 12);

      await writeJsonFile(this.recentPath, next);
    });
  }

  private projectJsonPath(inputPath: string): string {
    return inputPath.endsWith("project.json")
      ? inputPath
      : path.join(inputPath, "project.json");
  }

  private async readNormalizedProject(projectJsonPath: string): Promise<Project> {
    const project = await fs.readJson(projectJsonPath);
    return {
      id: project.id ?? randomUUID(),
      name: this.translateLegacyDefault(project.name ?? project.projectName ?? "未命名项目"),
      path: path.dirname(projectJsonPath),
      gameType: project.gameType ?? "RPG",
      style: this.translateLegacyDefault(project.style ?? "十六位像素风"),
      styleDescription: this.translateLegacyDefault(project.styleDescription ?? project.style ?? ""),
      defaultResolution: project.defaultResolution ?? "64x64",
      defaultBackground: project.defaultBackground ?? "transparent",
      exportTargets: project.exportTargets ?? ["common"],
      assets: project.assets ?? [],
      styleTemplates: this.normalizeStyleTemplates(project.styleTemplates ?? []),
      createdAt: project.createdAt ?? nowIso(),
      updatedAt: project.updatedAt ?? nowIso()
    };
  }

  private normalizeStyleTemplates(templates: StyleTemplate[]): StyleTemplate[] {
    return templates.map((template) => ({
      ...template,
      name: this.translateLegacyDefault(template.name),
      description: this.translateLegacyDefault(template.description),
      lineWeight: template.lineWeight ? this.translateLegacyDefault(template.lineWeight) : template.lineWeight,
      lighting: template.lighting ? this.translateLegacyDefault(template.lighting) : template.lighting,
      cameraView: template.cameraView ? this.translateLegacyDefault(template.cameraView) : template.cameraView
    }));
  }

  private translateLegacyDefault(value: string): string {
    const legacy: Record<string, string> = {
      "Untitled Project": "未命名项目",
      "16-bit pixel art": "十六位像素风",
      "16-bit pixel art, clean silhouette, limited palette, transparent background": "十六位像素美术，轮廓干净，限制色板，透明背景",
      "dark dungeon fantasy, readable shapes, muted metal and stone palette": "暗黑地牢幻想，可读形状，低饱和金属与石材色板",
      "crisp 1px edges": "清晰一像素边缘",
      "top-left soft key light": "左上方柔和主光",
      "side-view": "侧视角",
      "bold outline": "粗轮廓",
      "low warm torch light": "低照度暖色火把光",
      "top-down": "俯视角"
    };
    return legacy[value] ?? value;
  }
}
