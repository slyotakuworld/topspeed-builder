import path from "node:path";
import fs from "fs-extra";
import sharp from "sharp";
import type { AtlasMetadata } from "@shared/types";
import { toRelative, writeJsonFile } from "./utils";

export class AtlasPackingService {
  async pack(args: {
    projectPath: string;
    name: string;
    files: string[];
    padding?: number;
    maxWidth?: number;
  }): Promise<{ atlasPath: string; metadataPath: string; metadata: AtlasMetadata }> {
    const padding = args.padding ?? 2;
    const maxWidth = args.maxWidth ?? 1024;
    const images = await Promise.all(
      args.files.map(async (filePath) => {
        const metadata = await sharp(filePath).metadata();
        return {
          filePath,
          name: path.basename(filePath),
          width: metadata.width ?? 1,
          height: metadata.height ?? 1
        };
      })
    );

    if (images.length === 0) {
      throw new Error("图集打包失败：没有可用 PNG 文件。");
    }

    let x = padding;
    let y = padding;
    let rowHeight = 0;
    let atlasWidth = 0;
    const placements: Array<(typeof images)[number] & { x: number; y: number }> = [];

    for (const image of images) {
      if (x + image.width + padding > maxWidth && x > padding) {
        x = padding;
        y += rowHeight + padding;
        rowHeight = 0;
      }

      placements.push({ ...image, x, y });
      x += image.width + padding;
      rowHeight = Math.max(rowHeight, image.height);
      atlasWidth = Math.max(atlasWidth, x);
    }

    const atlasHeight = y + rowHeight + padding;
    const outputPath = path.join(args.projectPath, "atlas", `${args.name}_atlas.png`);
    const metadataPath = path.join(args.projectPath, "atlas", `${args.name}_atlas.json`);

    await fs.ensureDir(path.dirname(outputPath));
    await sharp({
      create: {
        width: Math.max(atlasWidth, 1),
        height: Math.max(atlasHeight, 1),
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite(placements.map((item) => ({ input: item.filePath, left: item.x, top: item.y })))
      .png()
      .toFile(outputPath);

    const metadata: AtlasMetadata = {
      meta: {
        image: toRelative(args.projectPath, outputPath),
        size: { w: atlasWidth, h: atlasHeight },
        padding
      },
      frames: Object.fromEntries(
        placements.map((item) => [
          item.name,
          {
            frame: {
              x: item.x,
              y: item.y,
              w: item.width,
              h: item.height
            }
          }
        ])
      )
    };

    await writeJsonFile(metadataPath, metadata);
    return {
      atlasPath: toRelative(args.projectPath, outputPath),
      metadataPath: toRelative(args.projectPath, metadataPath),
      metadata
    };
  }
}
