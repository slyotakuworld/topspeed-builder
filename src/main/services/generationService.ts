import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import sharp from "sharp";
import type {
  Asset,
  GenerateAssetInput,
  GeneratedAssetResult,
  GenerationHistoryRecord,
  Project,
  ReferenceImageInput,
  ReferenceImageRole,
  Size
} from "@shared/types";
import { AIGenerationService } from "./aiService";
import { AtlasPackingService } from "./atlasService";
import { HistoryService } from "./historyService";
import { ImageProcessingService } from "./imageService";
import { ProjectService } from "./projectService";
import { SettingsService } from "./settingsService";
import { SpriteSheetService } from "./spriteSheetService";
import { TileSetService } from "./tileSetService";
import { nowIso, parseSize, resolveProjectPath, sanitizeFileName, toRelative, writeJsonFile } from "./utils";

interface GeneratedFrame {
  absolutePath: string;
  relativePath: string;
  name: string;
  animation: string;
  frameIndex: number;
}

interface ResolvedReferenceImage extends ReferenceImageInput {
  filePath: string;
}

interface FrameDiagnostic {
  file: string;
  alphaRatio: number;
  largeComponents: number;
  warnings: string[];
}

interface CharacterSheetGrid {
  columns: number;
  rows: number;
  transparentBackground: boolean;
}

interface SheetCropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FloatRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class GenerationService {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly projectService: ProjectService,
    private readonly aiService: AIGenerationService,
    private readonly imageService: ImageProcessingService,
    private readonly spriteSheetService: SpriteSheetService,
    private readonly atlasService: AtlasPackingService,
    private readonly tileSetService: TileSetService,
    private readonly historyService: HistoryService
  ) {}

  async generate(input: GenerateAssetInput): Promise<GeneratedAssetResult> {
    const project = await this.projectService.openProjectPath(input.projectPath);
    this.validateInput(input);

    if (input.assetType === "character") {
      return this.generateCharacter(project, input);
    }

    if (input.assetType === "tileset") {
      return this.generateTileset(project, input);
    }

    if (input.assetType === "icon" || input.assetType === "item" || input.assetType === "ui") {
      return this.generateIconBatch(project, input);
    }

    return this.generateGeneric(project, input);
  }

  private async generateIconBatch(project: Project, input: GenerateAssetInput): Promise<GeneratedAssetResult> {
    const logs: string[] = [];
    const runId = randomUUID();
    const assetName = sanitizeFileName(input.name || "icons");
    const storageName = this.storageName(assetName, runId);
    const size = parseSize(input.size);
    const itemNames = this.resolveIconNames(input);
    const outputDirectory = input.assetType === "ui" ? "icons/ui" : "icons/items";
    const files: string[] = [];
    const absoluteFiles: string[] = [];
    const prompts: string[] = [];
    const referenceImages = this.resolveReferenceImages(project, input);
    const maskImagePath = this.resolveMaskImagePath(project, input);
    const referenceGuidance = this.buildReferenceGuidance(input);

    for (let index = 0; index < itemNames.length; index += 1) {
      const itemName = itemNames[index];
      const itemSlug = sanitizeFileName(itemName);
      const fileName = `${input.assetType}_${itemSlug}_${String(index).padStart(2, "0")}.png`;
      const rawPath = path.join(project.path, "generated", "raw", runId, fileName);
      const processedPath = path.join(project.path, outputDirectory, storageName, fileName);
      const prompt = this.aiService.buildPrompt({
        assetType: this.assetTypeLabel(input.assetType),
        name: itemName,
        description: `${input.description}。同批次物品列表：${itemNames.join("、")}`,
        style: this.buildStylePrompt(project, input),
        size: input.size,
        transparentBackground: input.transparentBackground,
        extra: [
          "单个居中图标。正交视角的游戏背包素材。与同批次保持一致色板。",
          this.buildSingleSubjectGuidance(input),
          referenceGuidance
        ]
          .filter(Boolean)
          .join(" ")
      });
      prompts.push(prompt);

      try {
        const image = await this.generateWithRetry(prompt, input.size, input.transparentBackground, input, referenceImages, maskImagePath);
        await fs.ensureDir(path.dirname(rawPath));
        await fs.writeFile(rawPath, image);
        logs.push(`保存原始图像: ${rawPath}`);

        await this.imageService.saveProcessedImage(image, processedPath, {
          width: size.width,
          height: size.height,
          transparentBackground: input.transparentBackground,
          trim: true,
          isolateSubject: input.assetType !== "ui"
        });
        logs.push(`保存处理图像: ${processedPath}`);

        files.push(toRelative(project.path, processedPath));
        absoluteFiles.push(processedPath);
      } catch (error) {
        logs.push(`生成失败 ${itemName}: ${this.formatError(error)}`);
      }
    }

    if (files.length === 0) {
      throw new Error(`批量图标生成失败，没有成功输出。日志：${logs.join(" | ")}`);
    }

    let atlasPath: string | undefined;
    let atlasMetadataPath: string | undefined;
    if (input.makeAtlas && absoluteFiles.length > 0) {
      const atlas = await this.atlasService.pack({
        projectPath: project.path,
        name: storageName,
        files: absoluteFiles
      });
      atlasPath = atlas.atlasPath;
      atlasMetadataPath = atlas.metadataPath;
      logs.push(`生成图集: ${path.join(project.path, atlasPath)}`);
    }

    const metadataPath = path.join(project.path, outputDirectory, storageName, `${storageName}_metadata.json`);
    const metadata = {
      name: input.name,
      type: input.assetType,
      style: project.style,
      detailPrompt: this.resolveDetailPrompt(input),
      ...this.buildGenerationMetadata(input),
      size,
      files,
      atlas: atlasPath,
      prompt: prompts.join("\n\n---\n\n"),
      exportTargets: input.exportTargets,
      createdAt: nowIso()
    };
    await writeJsonFile(metadataPath, metadata);
    logs.push(`生成元数据: ${metadataPath}`);

    const asset = this.createAsset(input, {
      id: runId,
      project,
      files,
      metadataPath: toRelative(project.path, metadataPath),
      atlasPath,
      prompt: metadata.prompt
    });

    await this.persistResult(project, input, asset, logs, files, [atlasPath, atlasMetadataPath].filter(Boolean) as string[]);

    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      atlasPath,
      logs
    };
  }

  private async generateCharacter(project: Project, input: GenerateAssetInput): Promise<GeneratedAssetResult> {
    const logs: string[] = [];
    const runId = randomUUID();
    const assetName = sanitizeFileName(input.name || "character");
    const storageName = this.storageName(assetName, runId);
    const frameSize = parseSize(input.size);
    const animations = input.animations.length
      ? input.animations
      : [
          { name: "待机", frames: 4, fps: 6, loop: true },
          { name: "行走", frames: 4, fps: 8, loop: true },
          { name: "攻击", frames: 4, fps: 10, loop: false }
        ];
    const versionCount = Math.max(input.count, 1);
    const columns = Math.max(...animations.map((animation) => animation.frames), 1);
    const rows = Math.max(animations.length, 1);
    const sheetSize = {
      width: frameSize.width * columns,
      height: frameSize.height * rows
    };
    const sheetSizeText = `${sheetSize.width}x${sheetSize.height}`;
    const frames: GeneratedFrame[] = [];
    const prompts: string[] = [];
    const sourceSheets: string[] = [];
    const sheetPaths: string[] = [];
    const sheetMetadataPaths: string[] = [];
    const diagnostics: FrameDiagnostic[] = [];
    const referenceImages = this.resolveReferenceImages(project, input);
    const maskImagePath = this.resolveMaskImagePath(project, input);
    const referenceGuidance = this.buildReferenceGuidance(input);

    const isCharacterI2I = input.generationMode === "image-to-image" && input.referenceImages.some((ref) => ref.sourceAssetId);
    const sourceAsset = isCharacterI2I ? this.findAssetById(project, input.referenceImages.find((ref) => ref.sourceAssetId)!.sourceAssetId!) : undefined;
    const originalPrompt = sourceAsset?.prompt ?? "";
    const originalSourceSheets = this.findSourceSheetPaths(sourceAsset, project);
    const resolvedReferences = isCharacterI2I && originalSourceSheets.length > 0
      ? originalSourceSheets.map((sheetPath) => ({ filePath: sheetPath, role: "subject" as ReferenceImageRole, path: sheetPath }))
      : referenceImages;

    for (let versionIndex = 0; versionIndex < versionCount; versionIndex += 1) {
      const versionLabel = `v${String(versionIndex + 1).padStart(2, "0")}`;
      const versionOutputName = versionCount > 1 ? `${storageName}_${versionLabel}` : storageName;
      const versionDirectory = path.join(project.path, "sprites", "characters", storageName, versionLabel);

      // 方法1：先生成基础角色立绘，再逐帧以该立绘作为参考图做图生图，保证动作帧身份一致。
      const baseFileName = `character_${storageName}_${versionLabel}_base.png`;
      const basePath = path.join(versionDirectory, baseFileName);
      const rawBasePath = path.join(project.path, "generated", "raw", runId, baseFileName);
      const basePrompt = this.buildBaseCharacterPrompt(input, project, referenceGuidance);
      prompts.push(basePrompt);

      try {
        const baseImage = await this.generateWithRetry(basePrompt, input.size, input.transparentBackground, input, resolvedReferences, maskImagePath);
        await fs.ensureDir(path.dirname(rawBasePath));
        await fs.writeFile(rawBasePath, baseImage);
        await fs.ensureDir(path.dirname(basePath));
        await fs.writeFile(basePath, baseImage);
        sourceSheets.push(toRelative(project.path, basePath));
        logs.push(`生成基础角色立绘: ${basePath}`);

        const frameReference: ResolvedReferenceImage[] = [
          { filePath: basePath, path: basePath, role: "subject" as ReferenceImageRole }
        ];

        const frameBuffers: Buffer[] = [];
        const frameMeta: Array<{
          animation: GenerateAssetInput["animations"][number];
          frameIndex: number;
          fileName: string;
          processedPath: string;
        }> = [];

        for (let rowIndex = 0; rowIndex < animations.length; rowIndex += 1) {
          const animation = animations[rowIndex];
          for (let frameIndex = 0; frameIndex < animation.frames; frameIndex += 1) {
            const fileName = `character_${storageName}_${versionLabel}_${animation.name}_${String(frameIndex).padStart(2, "0")}.png`;
            const processedPath = path.join(versionDirectory, fileName);
            const framePrompt = this.buildCharacterFramePrompt(input, animations, animation, frameIndex);
            prompts.push(framePrompt);

            const frameImage = await this.generateWithRetry(framePrompt, input.size, input.transparentBackground, input, frameReference, maskImagePath);
            frameBuffers.push(frameImage);
            frameMeta.push({ animation, frameIndex, fileName, processedPath });
          }
        }

        const processedFrameBuffers = await this.imageService.normalizeFramesConsistently(
          frameBuffers,
          {
            width: frameSize.width,
            height: frameSize.height,
            transparentBackground: input.transparentBackground,
            trim: false,
            anchor: "center",
            padding: 0,
            removeEdgeArtifacts: true
          }
        );

        const versionFrames: GeneratedFrame[] = [];
        for (let index = 0; index < frameMeta.length; index += 1) {
          const meta = frameMeta[index];
          await fs.ensureDir(path.dirname(meta.processedPath));
          await fs.writeFile(meta.processedPath, processedFrameBuffers[index]);

          const frame: GeneratedFrame = {
            absolutePath: meta.processedPath,
            relativePath: toRelative(project.path, meta.processedPath),
            name: meta.fileName,
            animation: meta.animation.name,
            frameIndex: meta.frameIndex
          };
          frames.push(frame);
          versionFrames.push(frame);

          const diagnostic = await this.inspectCharacterFrame(meta.processedPath, frameSize);
          diagnostics.push({ ...diagnostic, file: frame.relativePath });
          if (diagnostic.warnings.length > 0) {
            logs.push(`角色帧诊断 ${frame.relativePath}: ${diagnostic.warnings.join("；")}`);
          }
        }

        if (input.makeSpriteSheet && versionFrames.length > 0) {
          const sheet = await this.spriteSheetService.createSpriteSheet({
            projectPath: project.path,
            outputName: versionOutputName,
            frames: versionFrames.map((frame) => ({
              filePath: frame.absolutePath,
              name: frame.name,
              animation: frame.animation,
              frameIndex: frame.frameIndex
            })),
            animations,
            size: input.size
          });
          sheetPaths.push(sheet.sheetPath);
          sheetMetadataPaths.push(sheet.metadataPath);
          logs.push(`生成精灵表: ${path.join(project.path, sheet.sheetPath)}`);
        }
      } catch (error) {
        logs.push(`角色版本失败 ${versionLabel}: ${this.formatError(error)}`);
      }
    }

    if (frames.length === 0) {
      throw new Error(`角色序列帧生成失败，没有成功输出。日志：${logs.join(" | ")}`);
    }

    const sheetPath = sheetPaths[0];
    const files = frames.map((frame) => frame.relativePath);
    const metadataPath = path.join(project.path, "sprites", "characters", storageName, `${storageName}_metadata.json`);
    await writeJsonFile(metadataPath, {
      name: input.name,
      type: "character",
      style: project.style,
      detailPrompt: this.resolveDetailPrompt(input),
      ...this.buildGenerationMetadata(input),
      generationStrategy: "character-frame-reference",
      characterVersions: versionCount,
      sheetGrid: {
        columns,
        rows,
        frameSize,
        sheetSize
      },
      sourceSheets,
      diagnostics,
      size: frameSize,
      files,
      sheet: sheetPath,
      sheets: sheetPaths,
      sheetMetadata: sheetMetadataPaths[0],
      sheetMetadataFiles: sheetMetadataPaths,
      animations,
      prompt: prompts.join("\n\n---\n\n"),
      exportTargets: input.exportTargets,
      createdAt: nowIso()
    });

    const asset = this.createAsset(input, {
      id: runId,
      project,
      files: [...files, ...sourceSheets, ...sheetPaths].filter(Boolean) as string[],
      metadataPath: toRelative(project.path, metadataPath),
      sheetPath,
      prompt: prompts.join("\n\n---\n\n")
    });

    await this.persistResult(
      project,
      input,
      asset,
      logs,
      files,
      [...sourceSheets, ...sheetPaths, ...sheetMetadataPaths, toRelative(project.path, metadataPath)].filter(Boolean) as string[]
    );

    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      sheetPath,
      logs
    };
  }

  private buildCharacterSheetGuidance(
    input: GenerateAssetInput,
    animations: GenerateAssetInput["animations"],
    columns: number,
    rows: number
  ): string {
    const rowPlan = animations
      .map((animation, index) => `第 ${index + 1} 行：${animation.name}，从左到右 ${animation.frames} 帧。`)
      .join(" ");

    return [
      "请生成一张完整的角色动作表，不要生成单张角色插图。",
      `固定网格布局为 ${columns} 列 x ${rows} 行，每个格子是一帧。`,
      rowPlan,
      this.buildAnimationContinuityGuidance(animations),
      "整张图必须是清晰的游戏精灵动作表：每格边界在构图上严格等宽等高，但不要画可见网格线。",
      "Keep 15-20% transparent safe padding inside every cell; no body part, weapon, cape, projectile, or magic effect may touch or cross a cell edge.",
      "If the provider canvas is not exactly the grid aspect ratio, keep the whole grid centered with equal transparent outer margins and mathematically even rows and columns.",
      `角色视角：${this.characterViewLabel(input.characterView)}。`,
      `严格遵守角色名称和素材描述：${input.name || "角色"}；${input.description || "按用户描述"}。不得替换职业、性别、物种、主装备或体型；描述是人形角色时，不要改成动物、怪物、吉祥物或抽象生物。`,
      "所有格子必须是同一个角色：同一脸型、发型、服装、道具、身高比例、色板和轮廓。",
      "每个格子只允许出现一个角色姿势，角色要居中，脚底基线一致，大小一致。",
      "不要文字、不要标签、不要边框、不要网格线、不要额外装饰、不要多个角色。",
      "不要把整套小图压进某一个格子；整张输出本身就是动作表。"
    ]
      .filter(Boolean)
      .join(" ");
  }

  private buildAnimationContinuityGuidance(animations: GenerateAssetInput["animations"]): string {
    const rowRules = animations.map((animation) => {
      const name = animation.name.toLowerCase();
      if (name.includes("走") || name.includes("walk") || name.includes("run") || name.includes("跑")) {
        return `${animation.name} 行必须是连续步行动画：从左到右依次为左脚接触、过渡、右脚接触、过渡；双脚和武器位置必须逐帧推进，不要每帧都保持同一只脚在前。`;
      }
      if (name.includes("攻") || name.includes("attack") || name.includes("slash") || name.includes("hit")) {
        return `${animation.name} 行必须是连续攻击动画：从左到右依次为蓄力、挥出、命中/最大伸展、收招；武器轨迹必须逐帧推进，不要生成互不相干的姿势。`;
      }
      if (name.includes("待") || name.includes("idle")) {
        return `${animation.name} 行必须是连续待机循环：只做轻微呼吸、重心或手臂变化，不要突然改变体型、朝向或装备。`;
      }
      return `${animation.name} 行必须表现同一个动作时间线的连续关键帧，相邻帧只做渐进变化。`;
    });

    return [
      "动画连续性硬约束：每一行都是同一动作的时间序列，不是独立姿势合集。",
      "同一行从左到右必须能直接播放成循环或一次性动作；角色朝向、身高、脚底基线、装备和轮廓比例保持一致。",
      ...rowRules
    ].join(" ");
  }

  /**
   * 方法1 - 基础角色立绘提示词：生成一张干净的单帧角色正面站姿立绘，
   * 作为后续逐帧图生图的身份参考锚。
   */
  private buildBaseCharacterPrompt(
    input: GenerateAssetInput,
    project: Project,
    referenceGuidance: string
  ): string {
    return this.aiService.buildPrompt({
      assetType: "角色基础立绘",
      name: input.name || "角色",
      description: input.description,
      style: this.buildStylePrompt(project, input),
      size: input.size,
      transparentBackground: input.transparentBackground,
      extra: [
        "只生成一个角色的单张正面站姿立绘，不要生成动作表、不要生成网格、不要生成多帧。",
        `角色视角：${this.characterViewLabel(input.characterView)}。`,
        `严格遵守角色名称和素材描述：${input.name || "角色"}；${input.description || "按用户描述"}。不得替换职业、性别、物种、主装备或体型；描述是人形角色时，不要改成动物、怪物、吉祥物或抽象生物。`,
        "角色居中、全身可见、脚底靠近画布底部、留 15-20% 安全区不要贴边。",
        "不要文字、不要标签、不要边框、不要网格线、不要多个角色、不要装饰。",
        referenceGuidance
      ].filter(Boolean).join(" ")
    });
  }

  /**
   * 方法1 - 逐帧动作提示词：为指定动画的指定帧序号生成单帧图，
   * 配合基础立绘参考图做图生图以保证身份一致。
   */
  private buildCharacterFramePrompt(
    input: GenerateAssetInput,
    animations: GenerateAssetInput["animations"],
    animation: GenerateAssetInput["animations"][number],
    frameIndex: number
  ): string {
    const totalFrames = animation.frames;
    const progress = totalFrames > 1 ? `${frameIndex + 1}/${totalFrames}` : "1/1";
    const name = animation.name.toLowerCase();

    let poseDesc = "";
    if (name.includes("待") || name.includes("idle")) {
      poseDesc = `待机呼吸动画第 ${progress} 帧：身体仅做轻微起伏或重心微移，不要改变朝向、体型或装备。`;
    } else if (name.includes("走") || name.includes("walk") || name.includes("run") || name.includes("跑")) {
      const steps = ["左脚接触地面", "过渡姿态", "右脚接触地面", "过渡姿态"];
      poseDesc = `行走动画第 ${progress} 帧：${steps[frameIndex % steps.length]}，双脚和武器位置必须逐帧推进。`;
    } else if (name.includes("攻") || name.includes("attack") || name.includes("slash") || name.includes("hit")) {
      const phases = ["蓄力准备", "挥出攻击", "命中/最大伸展", "收招回位"];
      poseDesc = `攻击动画第 ${progress} 帧：${phases[frameIndex % phases.length]}，武器轨迹必须逐帧推进。`;
    } else {
      poseDesc = `${animation.name} 动画第 ${progress} 帧：表现该动作时间线上的一个连续关键帧。`;
    }

    return [
      `基于参考图中的角色，生成其「${animation.name}」动作的第 ${frameIndex + 1} 帧（共 ${totalFrames} 帧）。`,
      poseDesc,
      "必须保持与参考图完全一致的角色身份：同一脸型、发型、服装、道具、身高比例、色板和轮廓。",
      `角色视角：${this.characterViewLabel(input.characterView)}。`,
      "角色居中、脚底基线一致、大小一致，留 15-20% 安全区不要贴边。",
      "只生成这一帧，不要生成多帧、不要生成动作表、不要生成网格。",
      "不要文字、不要标签、不要边框、不要多个角色。"
    ].filter(Boolean).join(" ");
  }

  private async normalizeCharacterSheet(input: Buffer, size: { width: number; height: number }, grid: CharacterSheetGrid): Promise<Buffer> {
    const sheet = grid.transparentBackground
      ? await this.imageService.removeBackground(input)
      : await sharp(input).ensureAlpha().png().toBuffer();
    const crop = await this.detectCharacterSheetCrop(sheet, grid.columns, grid.rows);
    let pipeline = sharp(sheet).ensureAlpha();

    if (crop) {
      pipeline = pipeline.extract(crop);
    }

    const normalized = await pipeline
      .resize({
        width: size.width,
        height: size.height,
        fit: "fill",
        kernel: sharp.kernel.nearest
      })
      .png()
      .toBuffer();

    const minimumForegroundPixels = Math.max(32, Math.floor(size.width * size.height * 0.002));
    if (await this.countVisibleAlphaPixels(normalized) >= minimumForegroundPixels) {
      return normalized;
    }

    return sharp(input)
      .ensureAlpha()
      .resize({
        width: size.width,
        height: size.height,
        fit: "fill",
        kernel: sharp.kernel.nearest
      })
      .png()
      .toBuffer();
  }

  private async countVisibleAlphaPixels(input: Buffer, threshold = 12): Promise<number> {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const totalPixels = info.width * info.height;
    let alphaPixels = 0;

    for (let index = 0; index < totalPixels; index += 1) {
      if (data[index * channels + 3] > threshold) {
        alphaPixels += 1;
      }
    }

    return alphaPixels;
  }

  private async detectCharacterSheetCrop(sheet: Buffer, columns: number, rows: number): Promise<SheetCropRect | undefined> {
    const { data, info } = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const totalPixels = info.width * info.height;
    const xWeights = new Float64Array(info.width);
    const yWeights = new Float64Array(info.height);
    let foregroundPixels = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;

    for (let index = 0; index < totalPixels; index += 1) {
      const alpha = data[index * channels + 3];
      if (alpha <= 12) continue;

      const x = index % info.width;
      const y = Math.floor(index / info.width);
      xWeights[x] += 1;
      yWeights[y] += 1;
      foregroundPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    const minimumForegroundPixels = Math.max(32, Math.floor(totalPixels * 0.002));
    if (foregroundPixels < minimumForegroundPixels || maxX < minX || maxY < minY) {
      return undefined;
    }

    const safeColumns = Math.max(1, columns);
    const safeRows = Math.max(1, rows);
    const xBounds = this.inferGridAxisBounds(xWeights, safeColumns, minX, maxX);
    const yBounds = this.inferGridAxisBounds(yWeights, safeRows, minY, maxY);
    const targetAspect = safeColumns / safeRows;
    const rect = this.expandRectToAspect({
      left: xBounds?.start ?? minX,
      top: yBounds?.start ?? minY,
      right: xBounds?.end ?? maxX + 1,
      bottom: yBounds?.end ?? maxY + 1
    }, targetAspect, info.width, info.height);

    return this.toIntegerCropRect(rect, info.width, info.height);
  }

  private inferGridAxisBounds(weights: Float64Array, expectedCells: number, foregroundMin: number, foregroundMax: number): { start: number; end: number } | undefined {
    const clusters = this.weightedKMeans1D(weights, expectedCells, foregroundMin, foregroundMax);
    if (!clusters) return undefined;

    const meaningfulWeight = Math.max(1, clusters.totalWeight / Math.max(expectedCells * 12, 1));
    const meaningfulClusters = clusters.totals.filter((weight) => weight >= meaningfulWeight).length;
    if (meaningfulClusters < expectedCells) {
      return undefined;
    }

    const gaps: number[] = [];
    for (let index = 1; index < clusters.centers.length; index += 1) {
      gaps.push(clusters.centers[index] - clusters.centers[index - 1]);
    }

    const medianGap = this.median(gaps);
    if (!medianGap || medianGap <= 0) {
      return undefined;
    }

    const hasUnstableGap = gaps.some((gap) => gap < medianGap * 0.45 || gap > medianGap * 1.8);
    if (hasUnstableGap) {
      return undefined;
    }

    const start = Math.min(clusters.centers[0] - medianGap / 2, foregroundMin);
    const end = Math.max(clusters.centers[clusters.centers.length - 1] + medianGap / 2, foregroundMax + 1);
    return { start, end };
  }

  private weightedKMeans1D(
    weights: Float64Array,
    expectedClusters: number,
    min: number,
    max: number
  ): { centers: number[]; totals: number[]; totalWeight: number } | undefined {
    if (expectedClusters <= 0 || max < min) return undefined;

    let totalWeight = 0;
    for (let value = min; value <= max; value += 1) {
      totalWeight += weights[value];
    }
    if (totalWeight <= 0) return undefined;

    const span = max - min + 1;
    const centers = Array.from({ length: expectedClusters }, (_, index) => min + ((index + 0.5) * span) / expectedClusters);

    for (let iteration = 0; iteration < 30; iteration += 1) {
      const sums = new Array<number>(expectedClusters).fill(0);
      const totals = new Array<number>(expectedClusters).fill(0);

      for (let value = min; value <= max; value += 1) {
        const weight = weights[value];
        if (weight <= 0) continue;
        const clusterIndex = this.closestCenterIndex(value, centers);
        sums[clusterIndex] += value * weight;
        totals[clusterIndex] += weight;
      }

      let changed = false;
      for (let index = 0; index < expectedClusters; index += 1) {
        if (totals[index] <= 0) continue;
        const nextCenter = sums[index] / totals[index];
        if (Math.abs(nextCenter - centers[index]) > 0.25) {
          changed = true;
        }
        centers[index] = nextCenter;
      }
      centers.sort((a, b) => a - b);
      if (!changed) break;
    }

    const finalTotals = new Array<number>(expectedClusters).fill(0);
    for (let value = min; value <= max; value += 1) {
      const weight = weights[value];
      if (weight <= 0) continue;
      finalTotals[this.closestCenterIndex(value, centers)] += weight;
    }

    return { centers, totals: finalTotals, totalWeight };
  }

  private closestCenterIndex(value: number, centers: number[]): number {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < centers.length; index += 1) {
      const distance = Math.abs(value - centers[index]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  private median(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private expandRectToAspect(rect: FloatRect, aspect: number, imageWidth: number, imageHeight: number): FloatRect {
    let { left, top, right, bottom } = rect;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    if (width / height < aspect) {
      const targetWidth = height * aspect;
      const offset = (targetWidth - width) / 2;
      left -= offset;
      right += offset;
    } else {
      const targetHeight = width / aspect;
      const offset = (targetHeight - height) / 2;
      top -= offset;
      bottom += offset;
    }

    if (left < 0) {
      right -= left;
      left = 0;
    }
    if (top < 0) {
      bottom -= top;
      top = 0;
    }
    if (right > imageWidth) {
      left -= right - imageWidth;
      right = imageWidth;
    }
    if (bottom > imageHeight) {
      top -= bottom - imageHeight;
      bottom = imageHeight;
    }

    return {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(imageWidth, right),
      bottom: Math.min(imageHeight, bottom)
    };
  }

  private toIntegerCropRect(rect: FloatRect, imageWidth: number, imageHeight: number): SheetCropRect | undefined {
    const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(rect.left)));
    const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(rect.top)));
    const right = Math.max(left + 1, Math.min(imageWidth, Math.ceil(rect.right)));
    const bottom = Math.max(top + 1, Math.min(imageHeight, Math.ceil(rect.bottom)));
    const width = right - left;
    const height = bottom - top;

    if (width < 2 || height < 2) {
      return undefined;
    }

    return { left, top, width, height };
  }

  private async extractCharacterFrame(
    sheet: Buffer,
    args: {
      columns: number;
      rows: number;
      rowIndex: number;
      frameIndex: number;
      frameSize: { width: number; height: number };
    }
  ): Promise<Buffer> {
    const metadata = await sharp(sheet).metadata();
    const width = metadata.width ?? args.frameSize.width * args.columns;
    const height = metadata.height ?? args.frameSize.height * args.rows;
    const cellWidth = width / args.columns;
    const cellHeight = height / args.rows;
    const left = Math.max(0, Math.floor(args.frameIndex * cellWidth));
    const top = Math.max(0, Math.floor(args.rowIndex * cellHeight));
    const right = Math.min(width, Math.ceil((args.frameIndex + 1) * cellWidth));
    const bottom = Math.min(height, Math.ceil((args.rowIndex + 1) * cellHeight));

    return sharp(sheet)
      .ensureAlpha()
      .extract({
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
      })
      .png()
      .toBuffer();
  }

  private async inspectCharacterFrame(filePath: string, expectedSize: { width: number; height: number }): Promise<Omit<FrameDiagnostic, "file">> {
    const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const total = info.width * info.height;
    const mask = new Uint8Array(total);
    let alphaPixels = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;

    for (let index = 0; index < total; index += 1) {
      const alpha = data[index * channels + 3];
      if (alpha > 12) {
        mask[index] = 1;
        alphaPixels += 1;
        const x = index % info.width;
        const y = Math.floor(index / info.width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    const alphaRatio = total > 0 ? alphaPixels / total : 0;
    const warnings: string[] = [];
    if (alphaPixels === 0) {
      warnings.push("空白帧");
    }
    if (alphaRatio > 0 && alphaRatio < 0.015) {
      warnings.push("主体过小，疑似整套图被压缩进单帧或生成失败");
    }
    if (alphaRatio > 0.78) {
      warnings.push("透明区域过少，疑似背景未清理或整格被填满");
    }

    const bboxWidth = maxX >= minX ? maxX - minX + 1 : 0;
    const bboxHeight = maxY >= minY ? maxY - minY + 1 : 0;
    const edgeMargin = Math.max(1, Math.floor(Math.min(expectedSize.width, expectedSize.height) * 0.03));
    if (alphaPixels > 0 && (minX <= edgeMargin || minY <= edgeMargin || maxX >= info.width - 1 - edgeMargin || maxY >= info.height - 1 - edgeMargin)) {
      warnings.push("主体贴近帧边缘，可能存在切割残缺");
    }
    if (bboxWidth > expectedSize.width * 0.94 && bboxHeight > expectedSize.height * 0.94 && alphaRatio > 0.45) {
      warnings.push("主体占满整格，疑似多状态套图或背景占用");
    }

    const largeComponents = this.countLargeAlphaComponents(mask, info.width, info.height, Math.max(32, Math.floor(total * 0.055)));
    if (largeComponents > 2) {
      warnings.push("检测到多个分离主体，疑似一格多角色");
    }

    return {
      alphaRatio: Number(alphaRatio.toFixed(4)),
      largeComponents,
      warnings
    };
  }

  private countLargeAlphaComponents(mask: Uint8Array, width: number, height: number, minPixels: number): number {
    const visited = new Uint8Array(mask.length);
    const stack: number[] = [];
    let largeComponents = 0;

    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || visited[start]) continue;

      let size = 0;
      visited[start] = 1;
      stack.push(start);

      while (stack.length > 0) {
        const index = stack.pop() as number;
        size += 1;
        const x = index % width;
        const y = Math.floor(index / width);
        const neighbors = [
          x > 0 ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          y > 0 ? index - width : -1,
          y < height - 1 ? index + width : -1
        ];

        for (const next of neighbors) {
          if (next < 0 || !mask[next] || visited[next]) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }

      if (size >= minPixels) {
        largeComponents += 1;
      }
    }

    return largeComponents;
  }

  private async generateTileset(project: Project, input: GenerateAssetInput): Promise<GeneratedAssetResult> {
    const logs: string[] = [];
    const runId = randomUUID();
    const assetName = sanitizeFileName(input.name || input.tileTheme || "瓦片集");
    const storageName = this.storageName(assetName, runId);
    const size = parseSize(input.size);
    const tileTypes = input.tileTypes.length ? input.tileTypes : ["地板", "墙体", "转角", "边缘", "门", "水面"];
    const tiles: Array<{ filePath: string; type: string }> = [];
    const files: string[] = [];
    const prompts: string[] = [];
    const referenceImages = this.resolveReferenceImages(project, input);
    const maskImagePath = this.resolveMaskImagePath(project, input);
    const referenceGuidance = this.buildReferenceGuidance(input);

    for (let index = 0; index < tileTypes.length; index += 1) {
      const tileType = tileTypes[index];
      const tileSlug = sanitizeFileName(tileType);
      const fileName = `tileset_${storageName}_${tileSlug}_${String(index).padStart(2, "0")}.png`;
      const rawPath = path.join(project.path, "generated", "raw", runId, fileName);
      const processedPath = path.join(project.path, "tilesets", storageName, fileName);
      const prompt = this.aiService.buildPrompt({
        assetType: "瓦片集瓦片",
        name: tileType,
        description: `${input.tileTheme || input.description} ${tileType}`,
        style: this.buildStylePrompt(project, input),
        size: input.size,
        transparentBackground: false,
        extra: [
          "俯视角瓦片。不要透视镜头。铺满整个瓦片画布。",
          input.tileSeamless ? "边缘应尽量可重复、可平铺。" : "",
          `该瓦片属于同一组「${assetName}」瓦片集。`,
          referenceGuidance
        ].join(" ")
      });
      prompts.push(prompt);

      try {
        const image = await this.generateWithRetry(prompt, input.size, false, input, referenceImages, maskImagePath);
        await fs.ensureDir(path.dirname(rawPath));
        await fs.writeFile(rawPath, image);
        await this.imageService.saveProcessedImage(image, processedPath, {
          width: size.width,
          height: size.height,
          transparentBackground: false,
          trim: false
        });

        tiles.push({ filePath: processedPath, type: tileType });
        files.push(toRelative(project.path, processedPath));
        logs.push(`生成瓦片: ${processedPath}`);
      } catch (error) {
        logs.push(`瓦片失败 ${tileType}: ${this.formatError(error)}`);
      }
    }

    if (tiles.length === 0) {
      throw new Error(`瓦片集生成失败，没有成功输出。日志：${logs.join(" | ")}`);
    }

    const tileset = await this.tileSetService.composeTileSet({
      projectPath: project.path,
      name: storageName,
      tiles,
      size: input.size,
      theme: input.tileTheme,
      seamless: input.tileSeamless
    });
    await this.appendGenerationMetadata(path.join(project.path, tileset.metadataPath), input);
    logs.push(`生成瓦片集: ${path.join(project.path, tileset.tilesetPath)}`);
    logs.push(`生成 Tiled 地图文件: ${path.join(project.path, tileset.tmxPath)}`);

    const asset = this.createAsset(input, {
      id: runId,
      project,
      files: [...files, tileset.tilesetPath, tileset.previewPath, tileset.tmxPath],
      metadataPath: tileset.metadataPath,
      prompt: prompts.join("\n\n---\n\n")
    });

    await this.persistResult(
      project,
      input,
      asset,
      logs,
      files,
      [tileset.tilesetPath, tileset.metadataPath, tileset.previewPath, tileset.tmxPath]
    );

    return {
      asset,
      files,
      metadataPath: tileset.metadataPath,
      previewPath: tileset.previewPath,
      tmxPath: tileset.tmxPath,
      logs
    };
  }

  private async generateGeneric(project: Project, input: GenerateAssetInput): Promise<GeneratedAssetResult> {
    const logs: string[] = [];
    const runId = randomUUID();
    const assetName = sanitizeFileName(input.name || input.assetType);
    const storageName = this.storageName(assetName, runId);
    const size = parseSize(input.size);
    const files: string[] = [];
    const absoluteFiles: string[] = [];
    const prompts: string[] = [];
    const referenceImages = this.resolveReferenceImages(project, input);
    const maskImagePath = this.resolveMaskImagePath(project, input);
    const referenceGuidance = this.buildReferenceGuidance(input);

    for (let index = 0; index < Math.max(input.count, 1); index += 1) {
      const fileName = `${input.assetType}_${assetName}_${String(index).padStart(2, "0")}.png`;
      const rawPath = path.join(project.path, "generated", "raw", runId, fileName);
      const processedPath = path.join(project.path, "generated", "processed", storageName, fileName);
      const prompt = this.aiService.buildPrompt({
        assetType: this.assetTypeLabel(input.assetType),
        name: input.name,
        description: input.description,
        style: this.buildStylePrompt(project, input),
        size: input.size,
        transparentBackground: input.transparentBackground,
        extra: ["可直接复用的游戏二维素材。", this.buildSingleSubjectGuidance(input), referenceGuidance].filter(Boolean).join(" ")
      });
      prompts.push(prompt);

      try {
        const image = await this.generateWithRetry(prompt, input.size, input.transparentBackground, input, referenceImages, maskImagePath);
        await fs.ensureDir(path.dirname(rawPath));
        await fs.writeFile(rawPath, image);
        await this.imageService.saveProcessedImage(image, processedPath, {
          width: size.width,
          height: size.height,
          transparentBackground: input.transparentBackground,
          trim: true,
          isolateSubject: this.shouldIsolateSingleSubject(input)
        });
        files.push(toRelative(project.path, processedPath));
        absoluteFiles.push(processedPath);
        logs.push(`生成素材: ${processedPath}`);
      } catch (error) {
        logs.push(`素材失败 #${index}: ${this.formatError(error)}`);
      }
    }

    if (files.length === 0) {
      throw new Error(`素材生成失败，没有成功输出。日志：${logs.join(" | ")}`);
    }

    let atlasPath: string | undefined;
    if (input.makeAtlas && absoluteFiles.length > 1) {
      const atlas = await this.atlasService.pack({
        projectPath: project.path,
        name: storageName,
        files: absoluteFiles
      });
      atlasPath = atlas.atlasPath;
      logs.push(`生成图集: ${path.join(project.path, atlasPath)}`);
    }

    const metadataPath = path.join(project.path, "generated", "processed", storageName, `${storageName}_metadata.json`);
    await writeJsonFile(metadataPath, {
      name: input.name,
      type: input.assetType,
      style: project.style,
      detailPrompt: this.resolveDetailPrompt(input),
      ...this.buildGenerationMetadata(input),
      size,
      files,
      atlas: atlasPath,
      prompt: prompts.join("\n\n---\n\n"),
      exportTargets: input.exportTargets,
      createdAt: nowIso()
    });

    const asset = this.createAsset(input, {
      id: runId,
      project,
      files,
      metadataPath: toRelative(project.path, metadataPath),
      atlasPath,
      prompt: prompts.join("\n\n---\n\n")
    });

    await this.persistResult(project, input, asset, logs, files, [atlasPath].filter(Boolean) as string[]);

    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      atlasPath,
      logs
    };
  }

  private async generateWithRetry(
    prompt: string,
    size: string,
    transparentBackground: boolean,
    input: GenerateAssetInput,
    referenceImages: ResolvedReferenceImage[],
    maskImagePath?: string
  ): Promise<Buffer> {
    const settings = await this.settingsService.getSettings();
    if (settings.aiProvider === "local-draft") {
      return this.aiService.generateImage({
        prompt,
        size,
        transparentBackground,
        settings,
        referenceImages,
        maskImagePath,
        editIntent: input.editIntent,
        referenceStrength: input.referenceStrength
      });
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.aiService.generateImage({
          prompt,
          size,
          transparentBackground,
          settings,
          referenceImages,
          maskImagePath,
          editIntent: input.editIntent,
          referenceStrength: input.referenceStrength
        });
      } catch (error) {
        lastError = error;
        if (!this.isRetriableImageError(error)) {
          throw error;
        }

        if (attempt < 4) {
          await this.sleep(this.isRateLimitError(error) ? 8000 * attempt : 3000 * attempt);
        }
      }
    }

    if (this.isRateLimitError(lastError)) {
      throw new Error(`图片生成接口连续限流，已重试 4 次但没有成功；不会生成本地假图。最后错误：${this.formatError(lastError)}`);
    }

    if (this.isTransientImageError(lastError)) {
      throw new Error(`图片生成请求连续网络失败，已重试 4 次但没有成功。最后错误：${this.formatError(lastError)}`);
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private resolveIconNames(input: GenerateAssetInput): string[] {
    if (input.iconItems.length > 0) {
      return input.iconItems.slice(0, Math.max(input.count, 1));
    }

    return Array.from({ length: Math.max(input.count, 1) }, (_, index) => `${input.name || "icon"} ${index + 1}`);
  }

  private storageName(assetName: string, runId: string): string {
    return `${assetName}_${runId.slice(0, 8)}`;
  }

  private isRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("HTTP 429") || message.toLowerCase().includes("too many requests");
  }

  private isRetriableImageError(error: unknown): boolean {
    return this.isRateLimitError(error) || this.isTransientImageError(error);
  }

  private isTransientImageError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return (
      lower.includes("fetch failed") ||
      lower.includes("network") ||
      lower.includes("timeout") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("und_err_connect_timeout") ||
      message.includes("HTTP 502") ||
      message.includes("HTTP 503") ||
      message.includes("HTTP 504")
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private formatError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.replace(/\s+/g, " ").trim();
    return normalized.length > 320 ? `${normalized.slice(0, 320)}...` : normalized;
  }

  private createAsset(
    input: GenerateAssetInput,
    args: {
      id: string;
      project: Project;
      files: string[];
      metadataPath?: string;
      atlasPath?: string;
      sheetPath?: string;
      prompt: string;
    }
  ): Asset {
    const size = parseSize(input.size);
    const timestamp = nowIso();

    return {
      id: args.id,
      name: input.name,
      type: input.assetType,
      description: input.description,
      style: this.resolveAssetStyle(args.project, input),
      size,
      files: args.files,
      metadataPath: args.metadataPath,
      atlasPath: args.atlasPath,
      sheetPath: args.sheetPath,
      generationMode: input.generationMode ?? "text-to-image",
      referenceImages: input.generationMode === "image-to-image" ? input.referenceImages : undefined,
      maskImagePath: input.generationMode === "image-to-image" ? input.maskImagePath : undefined,
      prompt: args.prompt,
      exportTargets: input.exportTargets,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private async persistResult(
    project: Project,
    input: GenerateAssetInput,
    asset: Asset,
    logs: string[],
    files: string[],
    extraFiles: string[]
  ): Promise<void> {
    await this.projectService.addAssets(project.path, [asset]);

    const outputFiles = [...files, ...extraFiles].filter(Boolean);
    const historyRecord: GenerationHistoryRecord = {
      id: asset.id,
      createdAt: asset.createdAt,
      assetType: input.assetType,
      prompt: asset.prompt,
      parameters: input,
      style: asset.style,
      outputFiles,
      exportTargets: input.exportTargets,
      favorite: false,
      exported: false
    };

    await this.historyService.append(project.path, historyRecord);
    logs.push(`保存历史记录: ${path.join(project.path, "history", `${asset.id}.json`)}`);
  }

  private findAssetById(project: Project, assetId: string): Asset | undefined {
    return project.assets.find((asset) => asset.id === assetId);
  }

  private findSourceSheetPaths(asset: Asset | undefined, project: Project): string[] {
    if (!asset) return [];
    const sheets = asset.files.filter((file) => file.includes("source_sheet"));
    if (sheets.length > 0) return sheets.map((f) => resolveProjectPath(project.path, f));
    if (asset.sheetPath) return [resolveProjectPath(project.path, asset.sheetPath)];
    if (asset.files.length > 0) return [resolveProjectPath(project.path, asset.files[0])];
    return [];
  }

  private buildCharacterI2IPrompt(
    originalPrompt: string,
    input: GenerateAssetInput,
    project: Project,
    animations: GenerateAssetInput["animations"],
    columns: number,
    rows: number,
    versionIndex: number,
    versionCount: number
  ): string {
    const versionLabel = `v${String(versionIndex + 1).padStart(2, "0")}`;
    const mergedDescription = input.description
      ? `修改要求：${input.description}。来自用户的新描述，必须覆盖原描述中可能冲突的部分。`
      : "";

    return [
      originalPrompt,
      "======== 以上是原始生成提示词 ========",
      mergedDescription,
      `版本：${versionCount > 1 ? `${input.name} ${versionLabel}` : input.name}`,
      `角色视角：${this.characterViewLabel(input.characterView)}。`,
      this.buildCharacterSheetGuidance(input, animations, columns, rows),
      "请基于原始角色设计进行修改调整，保持角色身份、服装、色板一致，只改变指定的部分。"
    ].filter(Boolean).join("\n");
  }

  private validateInput(input: GenerateAssetInput): void {
    const mode = input.generationMode ?? "text-to-image";
    if (mode !== "image-to-image") {
      return;
    }

    if (!input.referenceImages?.length) {
      throw new Error("图生图模式需要至少一张参考图。");
    }

    if (input.referenceImages.length > 4) {
      throw new Error("图生图 v1 最多支持 4 张参考图。");
    }

    if (input.editIntent === "inpaint" && !input.maskImagePath) {
      throw new Error("局部替换模式需要提供蒙版 PNG。");
    }
  }

  private resolveReferenceImages(project: Project, input: GenerateAssetInput): ResolvedReferenceImage[] {
    if ((input.generationMode ?? "text-to-image") !== "image-to-image") {
      return [];
    }

    return input.referenceImages.map((reference) => ({
      ...reference,
      filePath: resolveProjectPath(project.path, reference.path)
    }));
  }

  private resolveMaskImagePath(project: Project, input: GenerateAssetInput): string | undefined {
    if ((input.generationMode ?? "text-to-image") !== "image-to-image" || !input.maskImagePath) {
      return undefined;
    }

    return resolveProjectPath(project.path, input.maskImagePath);
  }

  private buildReferenceGuidance(input: GenerateAssetInput): string {
    if ((input.generationMode ?? "text-to-image") !== "image-to-image") {
      return "";
    }

    const roleLabels: Record<ReferenceImageRole, string> = {
      subject: "保持主体身份和轮廓",
      style: "匹配视觉风格、线条语言和渲染方式",
      composition: "遵循构图和镜头安排",
      palette: "复用色板和材质气质"
    };
    const intentLabels: Record<GenerateAssetInput["editIntent"], string> = {
      "preserve-subject": "保留参考图主体，并重绘成可用于游戏工程的素材。",
      "preserve-style": "创建一个遵循参考风格的新素材。",
      "preserve-composition": "创建一个遵循参考构图的新素材。",
      "same-series": "创建一个与参考素材属于同系列的变体。",
      inpaint: "只编辑蒙版区域，其余区域保持视觉稳定。"
    };
    const strengthLabels: Record<GenerateAssetInput["referenceStrength"], string> = {
      low: "宽松参考输入图。",
      medium: "在提示词要求和参考图保留之间保持平衡。",
      high: "尽量高保真保留参考图细节。"
    };

    const roles = input.referenceImages
      .map((reference, index) => `第 ${index + 1} 张参考图（${this.referenceRoleLabel(reference.role)}）：${roleLabels[reference.role]}。`)
      .join(" ");

    return [
      "使用提供的输入参考图。",
      intentLabels[input.editIntent],
      strengthLabels[input.referenceStrength],
      roles
    ]
      .filter(Boolean)
      .join(" ");
  }

  private buildGenerationMetadata(input: GenerateAssetInput): Record<string, unknown> {
    const generationMode = input.generationMode ?? "text-to-image";
    if (generationMode !== "image-to-image") {
      return { generationMode };
    }

    return {
      generationMode,
      editIntent: input.editIntent,
      referenceStrength: input.referenceStrength,
      referenceImages: input.referenceImages,
      maskImagePath: input.maskImagePath
    };
  }

  private async appendGenerationMetadata(metadataPath: string, input: GenerateAssetInput): Promise<void> {
    try {
      const metadata = await fs.readJson(metadataPath);
      await writeJsonFile(metadataPath, {
        ...metadata,
        ...this.buildGenerationMetadata(input)
      });
    } catch {
      await writeJsonFile(metadataPath, this.buildGenerationMetadata(input));
    }
  }

  private buildSingleSubjectGuidance(input: GenerateAssetInput): string {
    if (!this.shouldIsolateSingleSubject(input)) {
      return "";
    }

    return [
      "单主体硬约束：画面只能有一个完整主体，居中，占据主要区域。",
      "不要生成多个候选、大小对比版本、进化形态、变体展示、同屏多个生物或多个道具。",
      "不要画背景、地面、投影、边框、文字、标签或参考小图。",
      "如果需要精英变体细节，把细节合并到同一个主体上，不要额外画第二个怪物。"
    ].join(" ");
  }

  private shouldIsolateSingleSubject(input: GenerateAssetInput): boolean {
    return input.assetType === "enemy" || input.assetType === "icon" || input.assetType === "item";
  }

  private buildStylePrompt(project: Project, input: GenerateAssetInput): string {
    const detailPrompt = this.resolveDetailPrompt(input);
    const styleName = project.style.trim();
    const styleDescription = project.styleDescription.trim();
    const parts = [
      styleName ? `主要美术风格：${styleName}` : "",
      styleDescription && styleDescription !== styleName ? `风格说明：${styleDescription}` : "",
      this.buildStyleHardConstraints(project, input),
      detailPrompt ? `对象细节：${detailPrompt}` : ""
    ];
    return parts.filter(Boolean).join("\n");
  }

  private buildStyleHardConstraints(project: Project, input: GenerateAssetInput): string {
    const styleText = `${project.style} ${project.styleDescription}`.toLowerCase();
    const constraints: string[] = [];

    if (styleText.includes("像素") || styleText.includes("pixel") || styleText.includes("16-bit") || styleText.includes("16bit")) {
      constraints.push(
        "严格像素美术硬约束：低分辨率游戏精灵、硬边方块像素、清晰像素轮廓、有限色板、无抗锯齿、无写实绘画、无3D渲染、无照片质感、无柔焦阴影。"
      );
      if (input.assetType === "character") {
        constraints.push("角色必须像可直接放入 2D 游戏的 16-bit 角色 sprite，不要生成写实怪物插画或概念图。");
      }
    }

    return constraints.join("\n");
  }

  private resolveAssetStyle(project: Project, input: GenerateAssetInput): string {
    const detailPrompt = this.resolveDetailPrompt(input);
    return detailPrompt ? `${project.style} | ${detailPrompt}` : project.style;
  }

  private characterViewLabel(value: string): string {
    const labels: Record<string, string> = {
      "side-view": "侧视角",
      "top-down": "俯视角",
      "four-direction": "四方向",
      "eight-direction": "八方向"
    };
    return labels[value] ?? value;
  }

  private referenceRoleLabel(value: ReferenceImageRole): string {
    const labels: Record<ReferenceImageRole, string> = {
      subject: "主体参考",
      style: "风格参考",
      composition: "构图参考",
      palette: "色板参考"
    };
    return labels[value];
  }

  private assetTypeLabel(value: GenerateAssetInput["assetType"]): string {
    const labels: Record<GenerateAssetInput["assetType"], string> = {
      character: "角色",
      enemy: "怪物",
      icon: "图标",
      item: "道具",
      ui: "界面元素",
      tileset: "瓦片集",
      background: "背景",
      effect: "特效"
    };
    return labels[value];
  }

  private resolveDetailPrompt(input: GenerateAssetInput): string {
    const legacyStyle = (input as GenerateAssetInput & { style?: string }).style;
    return (input.detailPrompt || legacyStyle || "").trim();
  }

}
