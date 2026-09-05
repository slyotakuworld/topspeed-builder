import path from "node:path";
import fs from "fs-extra";
import sharp from "sharp";
import type { AnimationConfig, SpriteSheetMetadata } from "@shared/types";
import { parseSize, toRelative, writeJsonFile } from "./utils";

interface SpriteFrameInput {
  filePath: string;
  name: string;
  animation: string;
  frameIndex: number;
}

export class SpriteSheetService {
  async createSpriteSheet(args: {
    projectPath: string;
    outputName: string;
    frames: SpriteFrameInput[];
    animations: AnimationConfig[];
    size: string;
  }): Promise<{ sheetPath: string; metadataPath: string; metadata: SpriteSheetMetadata }> {
    const frameSize = parseSize(args.size);
    const maxFramesPerAnimation = Math.max(...args.animations.map((animation) => animation.frames), 1);
    const sheetWidth = frameSize.width * maxFramesPerAnimation;
    const sheetHeight = frameSize.height * Math.max(args.animations.length, 1);
    const outputPath = path.join(args.projectPath, "sheets", `${args.outputName}_spritesheet.png`);
    const metadataPath = path.join(args.projectPath, "sheets", `${args.outputName}_spritesheet.json`);
    const composites: sharp.OverlayOptions[] = [];
    const metadataFrames: SpriteSheetMetadata["frames"] = [];
    const animationIndex = new Map(args.animations.map((animation, index) => [animation.name, index]));

    for (const frame of args.frames) {
      const row = animationIndex.get(frame.animation) ?? 0;
      const left = frame.frameIndex * frameSize.width;
      const top = row * frameSize.height;
      composites.push({ input: frame.filePath, left, top });
      metadataFrames.push({
        name: frame.name,
        animation: frame.animation,
        index: metadataFrames.length,
        x: left,
        y: top,
        w: frameSize.width,
        h: frameSize.height
      });
    }

    await fs.ensureDir(path.dirname(outputPath));
    await sharp({
      create: {
        width: sheetWidth,
        height: sheetHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite(composites)
      .png()
      .toFile(outputPath);

    const metadata: SpriteSheetMetadata = {
      character: args.outputName,
      frameSize,
      sheet: toRelative(args.projectPath, outputPath),
      frames: metadataFrames,
      animations: Object.fromEntries(
        args.animations.map((animation) => {
          const frames = metadataFrames
            .filter((frame) => frame.animation === animation.name)
            .map((frame) => frame.index);
          return [animation.name, { frames, fps: animation.fps, loop: animation.loop }];
        })
      )
    };

    await writeJsonFile(metadataPath, metadata);
    return {
      sheetPath: toRelative(args.projectPath, outputPath),
      metadataPath: toRelative(args.projectPath, metadataPath),
      metadata
    };
  }
}
