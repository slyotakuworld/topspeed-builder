import path from "node:path";
import fs from "fs-extra";
import JSZip from "jszip";
import type { ExportProjectInput, ExportProjectResult, ExportTarget, Project } from "@shared/types";
import { nowIso, writeJsonFile } from "./utils";

export class ExportService {
  async exportProject(project: Project, input: ExportProjectInput): Promise<ExportProjectResult> {
    const exportRoot = path.join(project.path, "exports");
    await fs.ensureDir(exportRoot);

    const targets = input.targets.length > 0 ? input.targets : project.exportTargets;
    const files: string[] = [];

    for (const target of targets) {
      const created = await this.exportTarget(project, target);
      files.push(...created);
    }

    let zipPath: string | undefined;
    if (input.includeZip) {
      zipPath = await this.createZip(project.path, exportRoot, targets);
      files.push(zipPath);
    }

    return {
      exportRoot,
      targets,
      files,
      zipPath
    };
  }

  private async exportTarget(project: Project, target: ExportTarget): Promise<string[]> {
    const root = path.join(project.path, "exports", target);
    await fs.emptyDir(root);

    const files: string[] = [];
    const copy = async (source: string, destination: string): Promise<void> => {
      const sourcePath = path.join(project.path, source);
      if (await fs.pathExists(sourcePath)) {
        const destinationPath = path.join(root, destination);
        await fs.copy(sourcePath, destinationPath);
        files.push(destinationPath);
      }
    };

    if (target === "unity") {
      await copy("sprites", "sprites");
      await copy("icons", "sprites/icons");
      await copy("sheets", "sheets");
      await copy("atlas", "atlas");
      const guidePath = path.join(root, "unity_import_guide.md");
      await fs.writeFile(guidePath, this.unityGuide(project), "utf8");
      files.push(guidePath);
    } else if (target === "godot") {
      await copy("sprites", "sprites");
      await copy("icons", "sprites/icons");
      await copy("sheets", "sheets");
      await copy("atlas", "atlas");
      const guidePath = path.join(root, "godot_import_guide.md");
      await fs.writeFile(guidePath, this.godotGuide(project), "utf8");
      files.push(guidePath);
    } else if (target === "tiled") {
      await copy("tilesets", "tilesets");
      const guidePath = path.join(root, "tiled_import_guide.md");
      await fs.writeFile(guidePath, this.tiledGuide(project), "utf8");
      files.push(guidePath);
    } else {
      await copy("icons", "icons");
      await copy("sprites", "sprites");
      await copy("tilesets", "tilesets");
      await copy("sheets", "sheets");
      await copy("atlas", "atlas");
      const guidePath = path.join(root, `${target}_readme.md`);
      await fs.writeFile(guidePath, this.commonGuide(project, target), "utf8");
      files.push(guidePath);
    }

    const metadataPath = path.join(root, "sprites_metadata.json");
    await writeJsonFile(metadataPath, {
      exportedAt: nowIso(),
      target,
      project: {
        id: project.id,
        name: project.name,
        gameType: project.gameType,
        style: project.style,
        defaultResolution: project.defaultResolution
      },
      assets: project.assets
    });
    files.push(metadataPath);

    return files;
  }

  private async createZip(projectPath: string, exportRoot: string, targets: ExportTarget[]): Promise<string> {
    const zip = new JSZip();
    const zipPath = path.join(exportRoot, `ai_sprite_studio_export_${Date.now()}.zip`);

    zip.file("project.json", await fs.readFile(path.join(projectPath, "project.json")));

    for (const target of targets) {
      const targetRoot = path.join(exportRoot, target);
      if (await fs.pathExists(targetRoot)) {
        await this.addDirectory(zip.folder(target)!, targetRoot);
      }
    }

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await fs.writeFile(zipPath, buffer);
    return zipPath;
  }

  private async addDirectory(zip: JSZip, directory: string): Promise<void> {
    const entries = await fs.readdir(directory);
    for (const entry of entries) {
      const absolute = path.join(directory, entry);
      const stats = await fs.stat(absolute);
      if (stats.isDirectory()) {
        await this.addDirectory(zip.folder(entry)!, absolute);
      } else {
        zip.file(entry, await fs.readFile(absolute));
      }
    }
  }

  private unityGuide(project: Project): string {
    return `# Unity 导入说明

项目：${project.name}

1. 将本目录中的精灵、精灵表和图集目录拖入 Unity 项目面板。
2. 单张 PNG 的纹理类型设置为精灵，建议每单位像素数使用 ${project.defaultResolution.split("x")[0]}。
3. 精灵表设置为多精灵模式，然后在精灵编辑器中按 ${project.defaultResolution} 网格切分。
4. 图集 PNG 可放入 Unity 精灵图集，JSON 元数据可用于运行时定位帧坐标。
5. 瓦片集 PNG 可导入瓦片调色板；如使用瓦片地图，请按瓦片尺寸创建网格。
`;
  }

  private godotGuide(project: Project): string {
    return `# Godot 导入说明

项目：${project.name}

1. 将精灵、精灵表和图集目录复制到 Godot 资源目录。
2. 单张 PNG 可直接用于 Sprite2D。
3. 精灵表可在 AnimatedSprite2D 或 SpriteFrames 中按 ${project.defaultResolution} 切分。
4. 图集 JSON 保存了每个帧的坐标和尺寸，可用于 AtlasTexture 或自定义加载器。
5. 瓦片集 PNG 可在瓦片集编辑器中按瓦片尺寸创建地图层。
`;
  }

  private tiledGuide(project: Project): string {
    return `# Tiled 导入说明

项目：${project.name}

1. 打开瓦片集目录中的预览地图文件。
2. 新建地图时设置瓦片尺寸为 ${project.defaultResolution}。
3. 将瓦片集 PNG 作为瓦片集图片导入。
4. 瓦片集 JSON 包含瓦片类型、坐标和主题信息，可供游戏运行时读取。
`;
  }

  private commonGuide(project: Project, target: ExportTarget): string {
    return `# ${target} 通用资源包

项目：${project.name}

目录包含 PNG 单帧、精灵表、图集、瓦片集和 JSON 元数据。所有路径均为相对路径，适合直接拷贝到二维游戏项目资源目录中。
`;
  }
}
