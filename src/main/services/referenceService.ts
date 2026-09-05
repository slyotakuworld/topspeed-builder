import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { dialog } from "electron";
import fs from "fs-extra";
import sharp from "sharp";
import type { ImportedReferenceImage } from "@shared/types";
import { ensureProjectDirectories, sanitizeFileName, toRelative } from "./utils";

const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

export class ReferenceService {
  async chooseReferenceImages(projectPath: string): Promise<ImportedReferenceImage[]> {
    const result = await dialog.showOpenDialog({
      title: "选择参考图",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      properties: ["openFile", "multiSelections"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("已取消选择参考图");
    }

    const imported: ImportedReferenceImage[] = [];
    for (const filePath of result.filePaths) {
      imported.push(await this.importImage(projectPath, filePath, "references/images"));
    }
    return imported;
  }

  async chooseMask(projectPath: string): Promise<ImportedReferenceImage> {
    const result = await dialog.showOpenDialog({
      title: "选择局部编辑蒙版图片",
      filters: [{ name: "PNG 蒙版", extensions: ["png"] }],
      properties: ["openFile"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("已取消选择蒙版");
    }

    const imported = await this.importImage(projectPath, result.filePaths[0], "references/masks", true);
    return imported;
  }

  private async importImage(
    projectPath: string,
    sourcePath: string,
    destinationDirectory: string,
    requireAlpha = false
  ): Promise<ImportedReferenceImage> {
    await ensureProjectDirectories(projectPath);

    const extension = path.extname(sourcePath).toLowerCase();
    const mime = MIME_BY_EXTENSION[extension];
    if (!mime) {
      throw new Error(`不支持的参考图格式：${extension || "未知"}，仅支持 PNG/JPG/WebP。`);
    }

    if (requireAlpha && extension !== ".png") {
      throw new Error("蒙版必须是带透明通道的 PNG 文件。");
    }

    const stats = await fs.stat(sourcePath);
    if (stats.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`参考图超过 20MB：${sourcePath}`);
    }

    const metadata = await sharp(sourcePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`无法读取参考图尺寸：${sourcePath}`);
    }

    if (requireAlpha && !metadata.hasAlpha) {
      throw new Error("蒙版图片必须包含透明通道；透明区域表示可编辑区域。");
    }

    const buffer = await fs.readFile(sourcePath);
    const hash = createHash("sha256").update(buffer).digest("hex");
    const baseName = sanitizeFileName(path.basename(sourcePath, extension));
    const fileName = `${hash.slice(0, 12)}_${baseName || randomUUID()}${extension}`;
    const targetPath = path.join(projectPath, destinationDirectory, fileName);
    await fs.ensureDir(path.dirname(targetPath));
    await fs.copy(sourcePath, targetPath, { overwrite: true });

    const thumbnail = await sharp(buffer)
      .ensureAlpha()
      .resize({
        width: 144,
        height: 144,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();

    const thumbnailPath = path.join(projectPath, "references", "thumbnails", `${hash.slice(0, 12)}_${baseName}.png`);
    await fs.ensureDir(path.dirname(thumbnailPath));
    await fs.writeFile(thumbnailPath, thumbnail);

    return {
      path: toRelative(projectPath, targetPath),
      role: "subject",
      name: path.basename(sourcePath),
      width: metadata.width,
      height: metadata.height,
      mime,
      bytes: stats.size,
      hash,
      thumbnailPath: toRelative(projectPath, thumbnailPath),
      dataUrl: `data:image/png;base64,${thumbnail.toString("base64")}`
    };
  }
}
