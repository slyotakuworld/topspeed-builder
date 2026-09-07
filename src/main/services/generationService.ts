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
    const count = this.normalizeCount(input.count);
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
    const count = this.normalizeCount(input.count);
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
    const label = this.assetTypeLabel(input.assetType);
    const names = (input.cellNames || []).map((name) => name.trim()).filter(Boolean);
    const namesLine =
      names.length > 0
        ? `网格内容按行优先顺序（第 1 行从左到右、然后第 2 行……）分别为：${names.join("、")}。`
        : "";
    const background = input.transparentBackground
      ? "使用干净的单色背景（便于后续抠图），不要地面阴影、不要文字、不要水印。"
      : "使用干净的单色游戏素材背景，不要地面阴影、不要文字、不要水印。";

    return [
      `生成一张二维游戏美术大图，共 ${count} 个独立${label}，均匀排列成 ${cols} 列 × ${rows} 行。`,
      namesLine,
      `整体内容描述：${input.description || "无"}。`,
      this.buildStylePrompt(project, input),
      background,
      `最终画布尺寸：${input.size || "1024x1024"}。`,
      "网格硬约束：每个格子内只放一个完整主体并居中、保留安全边距；不同主体互不重叠、互不接触；不要画网格分割线或边框；不要重复绘制同一个素材；整张图内美术风格、色板与光影必须保持一致。",
      this.buildReferenceGuidance(input)
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildStylePrompt(project: Project, input: GenerateAssetInput): string {
    const detailPrompt = this.resolveDetailPrompt(input);
    // 本次出图风格优先；为空时回退项目旧字段，兼容历史项目
    const batchStyle = (input.style ?? "").trim();
    const styleName = batchStyle || project.style.trim();
    const styleDescription = batchStyle ? "" : project.styleDescription.trim();
    return [
      styleName ? `主要美术风格：${styleName}` : "",
      styleDescription && styleDescription !== styleName ? `风格说明：${styleDescription}` : "",
      detailPrompt ? `对象细节：${detailPrompt}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildReferenceGuidance(input: GenerateAssetInput): string {
    if (!input.referenceImages?.length) {
      return "";
    }
    const roleLabels: Record<ReferenceImageRole, string> = {
      subject: "参考图主体是整套素材的统一身份模板",
      style: "参考图定义了整套素材的视觉风格",
      composition: "参考图定义了整套素材的构图方式",
      palette: "参考图定义了整套素材的色板"
    };
    const strengthLabels: Record<ReferenceStrength, string> = {
      low: "宽松参考输入图，主要听从文字提示。",
      medium: "在文字提示与参考图之间保持平衡。",
      high: "尽量高保真保留参考图细节与风格。"
    };
    const roles = input.referenceImages
      .map((reference, index) => `第 ${index + 1} 张参考图（${this.referenceRoleLabel(reference.role)}）：${roleLabels[reference.role]}。`)
      .join(" ");
    return [
      "使用随请求提供的参考图来统一网格内所有素材：",
      strengthLabels[input.referenceStrength],
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
      subject: "主体参考",
      style: "风格参考",
      composition: "构图参考",
      palette: "色板参考"
    };
    return labels[value];
  }

  private assetTypeLabel(value: AssetType): string {
    const labels: Record<AssetType, string> = {
      character: "角色",
      enemy: "怪物",
      icon: "图标",
      item: "道具",
      ui: "界面元素",
      background: "背景",
      effect: "特效"
    };
    return labels[value];
  }
}
