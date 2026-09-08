import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import sharp from "sharp";
import type {
  Asset,
  AssetType,
  GenerateAssetInput,
  GeneratedAssetResult,
  GridDraft,
  GridSliceOptions,
  Project,
  ReferenceImageInput,
  ReferenceImageRole,
  ReferenceStrength
} from "@shared/types";
import { AIGenerationService } from "./aiService";
import { ImageProcessingService } from "./imageService";
import { ProjectService } from "./projectService";
import { SettingsService } from "./settingsService";
import { nowIso, parseSize, resolveProjectPath, sanitizeFileName, toRelative, writeJsonFile } from "./utils";

interface ResolvedReferenceImage extends ReferenceImageInput {
  filePath: string;
}

const MAX_CELLS = 36;

export class GenerationService {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly projectService: ProjectService,
    private readonly aiService: AIGenerationService,
    private readonly imageService: ImageProcessingService
  ) {}

  /** 第一阶段：让 AI 生成“一张含 count 个素材的网格大图”草稿，不写库 */
  async generateGrid(input: GenerateAssetInput): Promise<GridDraft> {
    const project = await this.projectService.openProjectPath(input.projectPath);
    const count = this.effectiveCount(input);
    const logs: string[] = [];
    const runId = randomUUID();
    const grid = this.autoGrid(count);
    const prompt = this.buildGridPrompt(project, input, grid.cols, grid.rows, count);
    const referenceImages = this.resolveReferenceImages(project, input);
    const hasReference = referenceImages.length > 0;

    const buffer = await this.generateWithRetry(
      prompt,
      input.size || "1024x1024",
      input.transparentBackground,
      input,
      referenceImages,
      hasReference ? "preserve-style" : undefined
    );

    const gridPath = path.join(project.path, "generated", "raw", runId, "grid.png");
    await fs.ensureDir(path.dirname(gridPath));
    await fs.writeFile(gridPath, buffer);
    logs.push(`保存网格大图: ${gridPath}`);

    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 1024;
    const height = metadata.height ?? 1024;

    return {
      runId,
      gridImagePath: toRelative(project.path, gridPath),
      width,
      height,
      cols: grid.cols,
      rows: grid.rows,
      count,
      prompt,
      logs
    };
  }

  /** 第二阶段：按确认后的网格参数切分大图，产出 N 个独立 PNG 并写入项目 */
  async commitSlice(
    input: GenerateAssetInput,
    draft: GridDraft,
    options: GridSliceOptions
  ): Promise<GeneratedAssetResult> {
    const project = await this.projectService.openProjectPath(input.projectPath);
    const logs: string[] = [];
    const gridPath = resolveProjectPath(project.path, draft.gridImagePath);
    if (!(await fs.pathExists(gridPath))) {
      throw new Error(`网格大图不存在，请重新生成：${gridPath}`);
    }

    const cols = this.clampInt(options.cols || draft.cols, 1, 24);
    const rows = this.clampInt(options.rows || draft.rows, 1, 24);
    const count = this.effectiveCount(input);
    const sliceCount = Math.min(count, cols * rows);
    const shrinkPercent = this.clampInt(options.shrinkPercent ?? 8, 0, 30);
    const shiftX = this.clampInt(options.shiftX ?? 0, -1024, 1024);
    const shiftY = this.clampInt(options.shiftY ?? 0, -1024, 1024);

    const buffer = await fs.readFile(gridPath);
    const image = sharp(buffer).ensureAlpha();
    const info = await image.metadata();
    const width = info.width ?? draft.width;
    const height = info.height ?? draft.height;
    const stepX = width / cols;
    const stepY = height / rows;
    const cellW = Math.floor(stepX);
    const cellH = Math.floor(stepY);
    if (cellW < 4 || cellH < 4) {
      throw new Error(`网格过大（${cols}×${rows}），单格小于 4px，无法切分。`);
    }

    const inset = Math.floor((Math.min(cellW, cellH) * shrinkPercent) / 200);

    const assetName = sanitizeFileName(input.name || input.assetType);
    const storageName = this.storageName(assetName, draft.runId);
    const outputDirectory = path.join(project.path, "sprites", storageName);
    const files: string[] = [];
    const absoluteFiles: string[] = [];
    const names: string[] = [];
    const cropResults: Array<{ index: number; name: string; width: number; height: number }> = [];

    for (let index = 0; index < sliceCount; index += 1) {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const startX = this.clampInt(Math.round(shiftX + col * stepX + inset), 0, width - 1);
      const endX = this.clampInt(Math.round(shiftX + (col + 1) * stepX - inset), startX + 1, width);
      const startY = this.clampInt(Math.round(shiftY + row * stepY + inset), 0, height - 1);
      const endY = this.clampInt(Math.round(shiftY + (row + 1) * stepY - inset), startY + 1, height);

      try {
        let cellBuffer = await image
          .clone()
          .extract({
            left: startX,
            top: startY,
            width: endX - startX,
            height: endY - startY
          })
          .png()
          .toBuffer();

        if (input.transparentBackground) {
          cellBuffer = await this.imageService.removeBackground(cellBuffer);
        }
        if (input.trimEdges) {
          cellBuffer = await this.imageService.trimToContent(cellBuffer);
        }

        const cellName = input.cellNames?.[index]?.trim() || `${input.name || "asset"} ${index + 1}`;
        const slug = sanitizeFileName(cellName);
        const fileName = `${String(index + 1).padStart(2, "0")}_${slug}.png`;
        const outputPath = path.join(outputDirectory, fileName);
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, cellBuffer);

        const cellMeta = await sharp(cellBuffer).metadata();
        names.push(cellName);
        cropResults.push({
          index,
          name: cellName,
          width: cellMeta.width ?? 0,
          height: cellMeta.height ?? 0
        });
        files.push(toRelative(project.path, outputPath));
        absoluteFiles.push(outputPath);
        logs.push(`切分素材 ${index + 1}/${sliceCount}: ${outputPath}`);
      } catch (error) {
        logs.push(`切分失败 #${index}: ${this.formatError(error)}`);
      }
    }

    if (files.length === 0) {
      throw new Error(`网格切分失败，没有成功输出。日志：${logs.join(" | ")}`);
    }

    const size = { width: cellW, height: cellH };
    const metadataPath = path.join(outputDirectory, `${storageName}_metadata.json`);
    await writeJsonFile(metadataPath, {
      name: input.name,
      type: input.assetType,
      style: this.resolveBatchStyle(project, input),
      description: input.description,
      detailPrompt: (input.detailPrompt || "").trim(),
      size,
      grid: {
        cols,
        rows,
        count: sliceCount,
        imageWidth: width,
        imageHeight: height,
        shiftX,
        shiftY,
        shrinkPercent
      },
      files,
      cells: cropResults,
      prompt: draft.prompt,
      createdAt: nowIso()
    });

    const asset = this.createAsset(input, {
      id: draft.runId,
      project,
      files,
      metadataPath: toRelative(project.path, metadataPath),
      size,
      prompt: draft.prompt
    });

    await this.persistResult(project, input, asset, logs, files);

    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      gridImagePath: draft.gridImagePath,
      logs
    };
  }

  // ---- 网格布局与提示词 ----

  private autoGrid(count: number): { cols: number; rows: number } {
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    return { cols, rows };
  }

  private buildGridPrompt(
    project: Project,
    input: GenerateAssetInput,
    cols: number,
    rows: number,
    count: number
  ): string {
    const nouns = this.assetTypeNouns(input.assetType);
    // 单张模式：整张画布就是一件独立作品，不按网格排列多个素材
    const singleShot = count === 1;
    const isIllustration = input.assetType === "other";
    const names = (input.cellNames || []).map((name) => name.trim()).filter(Boolean);
    const namesLine =
      names.length > 0 && !singleShot
        ? `Cell contents in row-major order (row 1 from left to right, then row 2, ...): ${names.join(", ")}.`
        : "";
    const description = (input.description || "").trim();
    const descriptionLine = description ? `Overall content description: ${description}.` : "";
    const header = singleShot
      ? isIllustration
        ? "Generate ONE full-canvas 2D game illustration: the entire canvas is one finished piece of artwork."
        : `Generate ONE 2D game ${nouns.singular}: the whole canvas holds a single complete ${nouns.singular}, centered with a small safe margin.`
      : `Generate one large 2D game art sheet containing ${count} independent ${nouns.plural}, evenly arranged into a ${cols} x ${rows} grid (filled row by row from left to right).`;
    const layoutRule = singleShot
      ? "Composition rule: keep the described content as the focus of the whole image, with a balanced, complete composition and a small safe margin at the borders; do NOT draw grid lines and do NOT split the canvas into multiple separate assets."
      : "Grid rules: exactly one complete subject per cell, centered and well separated from its cell borders; subjects must not overlap or touch each other; do NOT draw grid lines or borders; do NOT repeat or duplicate any subject; keep the art style, color palette and lighting consistent across the whole image.";

    return [
      header,
      namesLine,
      descriptionLine,
      this.buildStylePrompt(project, input),
      this.buildBackgroundRule(input, singleShot),
      layoutRule,
      `Final canvas size: ${input.size || "1024x1024"}.`,
      this.buildReferenceGuidance(input)
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * 背景规则：
   * - 透明背景模式 → 强制干净纯色背景，方便后续抠图；
   * - 单张整图（插画类）且非透明 → 保留内容所需环境/场景，不再强制纯色；
   * - 多素材网格且非透明 → 仍需干净纯色底，保证每个格子可读。
   */
  private buildBackgroundRule(input: GenerateAssetInput, singleShot: boolean): string {
    if (input.transparentBackground) {
      return "Background: use one clean, uniform solid-color background that is easy to remove later; no ground shadows, no text, no watermark.";
    }
    if (singleShot) {
      return "Background: keep the natural environment or scenery that fits the described content; no text and no watermark.";
    }
    return "Background: use one clean, uniform solid-color background for every cell; no ground shadows, no text, no watermark.";
  }

  private buildStylePrompt(project: Project, input: GenerateAssetInput): string {
    const detailPrompt = this.resolveDetailPrompt(input);
    // 本次出图风格优先；为空时回退项目旧字段，兼容历史项目
    const batchStyle = (input.style ?? "").trim();
    const styleName = batchStyle || project.style.trim();
    const styleDescription = batchStyle ? "" : project.styleDescription.trim();
    return [
      styleName ? `Art style: ${styleName}` : "",
      styleDescription && styleDescription !== styleName ? `Style notes: ${styleDescription}` : "",
      // 对象细节模板内容保留原始语言（中文），仅用英文句引导
      detailPrompt ? `Additional subject detail notes: ${detailPrompt}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildReferenceGuidance(input: GenerateAssetInput): string {
    if (!input.referenceImages?.length) {
      return "";
    }
    const roleMeaning: Record<ReferenceImageRole, string> = {
      subject: "defines the identity and appearance of the main subject(s)",
      style: "defines the overall visual style",
      composition: "defines the layout and composition direction",
      palette: "defines the color palette"
    };
    const strengthMeaning: Record<ReferenceStrength, string> = {
      low: "Treat the reference images loosely and follow the text prompt first.",
      medium: "Balance the text prompt and the reference images.",
      high: "Stay as faithful as possible to the reference images' details and style."
    };
    const roles = input.referenceImages
      .map(
        (reference, index) =>
          `Reference image ${index + 1} (${this.referenceRoleLabel(reference.role)}): ${roleMeaning[reference.role]}.`
      )
      .join(" ");
    return [
      "Use the attached reference images to unify the whole output:",
      strengthMeaning[input.referenceStrength],
      roles
    ].join(" ");
  }

  private resolveReferenceImages(project: Project, input: GenerateAssetInput): ResolvedReferenceImage[] {
    return (input.referenceImages || []).map((reference) => ({
      ...reference,
      filePath: resolveProjectPath(project.path, reference.path)
    }));
  }

  // ---- AI 调用 ----

  private async generateWithRetry(
    prompt: string,
    size: string,
    transparentBackground: boolean,
    input: GenerateAssetInput,
    referenceImages: ResolvedReferenceImage[],
    editIntent: "preserve-style" | undefined
  ): Promise<Buffer> {
    const settings = await this.settingsService.getSettings();
    let lastError: unknown;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.aiService.generateImage({
          prompt,
          size,
          transparentBackground,
          settings,
          quality: input.quality,
          referenceImages,
          editIntent,
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
      throw new Error(`图片生成接口连续限流，已重试 4 次但没有成功。最后错误：${this.formatError(lastError)}`);
    }
    if (this.isTransientImageError(lastError)) {
      throw new Error(`图片生成请求连续网络失败，已重试 4 次但没有成功。最后错误：${this.formatError(lastError)}`);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // ---- 落库 ----

  private async persistResult(
    project: Project,
    input: GenerateAssetInput,
    asset: Asset,
    logs: string[],
    files: string[]
  ): Promise<void> {
    await this.projectService.addAssets(project.path, [asset]);
    logs.push(`已入库素材批次: ${asset.name}（${files.length} 张）`);
  }

  private createAsset(
    input: GenerateAssetInput,
    args: {
      id: string;
      project: Project;
      files: string[];
      metadataPath?: string;
      size: { width: number; height: number };
      prompt: string;
    }
  ): Asset {
    const timestamp = nowIso();
    const references =
      input.referenceImages && input.referenceImages.length > 0 ? input.referenceImages : undefined;
    return {
      id: args.id,
      name: input.name || input.assetType,
      type: input.assetType,
      description: input.description,
      style: this.resolveAssetStyle(args.project, input),
      size: args.size,
      files: args.files,
      metadataPath: args.metadataPath,
      referenceImages: references,
      prompt: args.prompt,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private resolveBatchStyle(project: Project, input: GenerateAssetInput): string {
    return (input.style ?? "").trim() || project.style;
  }

  private resolveAssetStyle(project: Project, input: GenerateAssetInput): string {
    const detailPrompt = this.resolveDetailPrompt(input);
    const style = this.resolveBatchStyle(project, input);
    return detailPrompt ? `${style} | ${detailPrompt}` : style;
  }

  // ---- 标签与小工具 ----

  private normalizeCount(value: number): number {
    return this.clampInt(Math.round(Number(value) || 1), 1, MAX_CELLS);
  }

  /** 单张/插画类型固定输出 1 张，其余类型使用表单数量 */
  private effectiveCount(input: GenerateAssetInput): number {
    return input.assetType === "other" ? 1 : this.normalizeCount(input.count);
  }

  private clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
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
    // 客户端等待超时（请求发出后长时间无响应被本地中止）：服务端只是慢，重试 4 次会额外等 20+ 分钟，
    // 对用户毫无价值 → 不视为可重试错误，直接上抛清晰提示。
    const isClientWaitTimeout =
      lower.includes("超时或已中止") ||
      lower.includes("aborted due to timeout") ||
      lower.includes("headers timeout") ||
      lower.includes("body timeout") ||
      lower.includes("等待 300 秒无响应");
    if (isClientWaitTimeout) {
      return false;
    }
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

  private resolveDetailPrompt(input: GenerateAssetInput): string {
    return (input.detailPrompt || "").trim();
  }

  private referenceRoleLabel(value: ReferenceImageRole): string {
    const labels: Record<ReferenceImageRole, string> = {
      subject: "subject reference",
      style: "style reference",
      composition: "composition reference",
      palette: "palette reference"
    };
    return labels[value];
  }

  private assetTypeNouns(value: AssetType): { singular: string; plural: string } {
    const labels: Record<AssetType, { singular: string; plural: string }> = {
      character: { singular: "character", plural: "characters" },
      enemy: { singular: "enemy", plural: "enemies" },
      icon: { singular: "icon", plural: "icons" },
      item: { singular: "item", plural: "items" },
      ui: { singular: "UI element", plural: "UI elements" },
      background: { singular: "background", plural: "backgrounds" },
      effect: { singular: "effect", plural: "effects" },
      other: { singular: "illustration", plural: "illustrations" }
    };
    return labels[value];
  }
}
