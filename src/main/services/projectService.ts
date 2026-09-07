import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import type { CreateProjectInput, Project, RecentProject, StyleTemplate } from "@shared/types";
import {
  ensureProjectDirectories,
  nowIso,
  resolveProjectPath,
  sanitizeFileName,
  withFileLock,
  writeJsonFile
} from "./utils";
import { SettingsService } from "./settingsService";

export class ProjectService {
  constructor(private readonly settingsService: SettingsService) {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    const settings = await this.settingsService.getSettings();
    const parentDirectory = settings.defaultProjectRoot.trim();
    if (!parentDirectory) {
      throw new Error("未配置默认项目目录：请先在设置页选择项目目录后再创建项目。");
    }
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
      gameType: "其他",
      style: "十六位像素风",
      styleDescription: "十六位像素美术，轮廓干净，限制色板，透明背景",
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

  /** 扫描默认项目目录一层子目录下的全部项目，按最近更新/打开时间倒序 */
  async listDiscoverableProjects(): Promise<RecentProject[]> {
    const settings = await this.settingsService.getSettings();
    const root = settings.defaultProjectRoot.trim();
    if (!root) return [];
    return this.scanProjectRoot(path.resolve(root));
  }

  private async scanProjectRoot(root: string): Promise<RecentProject[]> {
    try {
      if (!(await fs.pathExists(root))) return [];
      const entries = await fs.readdir(root, { withFileTypes: true });
      const projects: RecentProject[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectDir = path.join(root, entry.name);
        const projectJsonPath = path.join(projectDir, "project.json");
        if (!(await fs.pathExists(projectJsonPath))) continue;
        try {
          const project = await this.readNormalizedProject(projectJsonPath);
          projects.push({
            id: project.id,
            name: project.name,
            path: project.path,
            gameType: project.gameType,
            style: project.style,
            updatedAt: project.updatedAt
          });
        } catch {
          // 单个损坏的 project.json 跳过，不影响其余项目
        }
      }

      return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async deleteAsset(projectPath: string, assetId: string): Promise<Project> {
    return withFileLock(path.join(projectPath, "project.json"), async () => {
      const project = await this.readNormalizedProject(this.projectJsonPath(projectPath));
      const asset = project.assets.find((a) => a.id === assetId);
      if (asset) {
        const allPaths = [...asset.files, asset.metadataPath].filter(Boolean) as string[];
        for (const file of allPaths) {
          try { await fs.remove(resolveProjectPath(project.path, file)); } catch { /* may not exist */ }
        }
      }
      return this.saveProjectUnlocked({ ...project, assets: project.assets.filter((a) => a.id !== assetId) });
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
      gameType: project.gameType ?? "其他",
      style: this.translateLegacyDefault(project.style ?? "十六位像素风"),
      styleDescription: this.translateLegacyDefault(project.styleDescription ?? project.style ?? ""),
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
