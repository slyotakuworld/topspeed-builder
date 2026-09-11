import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import sharp from "sharp";
import type { Raw } from "sharp";
import type {
  Asset,
  AssetType,
  FreeCutData,
  GenerateAssetInput,
  GeneratedAssetResult,
  GridAutoCell,
  GridDraft,
  GridSliceOptions,
  ManualRegion,
  Project,
  ReferenceImageInput,
  ReferenceImageRole,
  ReferenceStrength
} from "@shared/types";
import { AIGenerationService } from "./aiService";
import { GenerationHistoryService } from "./generationHistoryService";
import { ImageProcessingService } from "./imageService";
import { ProjectService } from "./projectService";
import { SettingsService } from "./settingsService";
import { nowIso, resolveProjectPath, sanitizeFileName, toRelative, writeJsonFile } from "./utils";

interface ResolvedReferenceImage extends ReferenceImageInput {
  filePath: string;
}

const MAX_CELLS = 36;

export class GenerationService {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly projectService: ProjectService,
    private readonly aiService: AIGenerationService,
    private readonly imageService: ImageProcessingService,
    private readonly historyService: GenerationHistoryService
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

    // 透明背景：模型若未真输出透明通道（宽松网关忽略 background 参数时产物为纯色底），
    // 在草稿落盘前就本地抠掉均匀底色，保证预览与切分结果都是透明 PNG。
    const gridBuffer = input.transparentBackground
      ? await this.imageService.removeBackground(buffer)
      : buffer;

    const gridPath = path.join(project.path, "generated", "raw", runId, "grid.png");
    await fs.ensureDir(path.dirname(gridPath));
    await fs.writeFile(gridPath, gridBuffer);
    // 顺手落一张 160px 缩略图：历史时间轴展示时只读小文件，避免日后冷解码整张大图卡住界面
    await this.historyService.writeThumbnailFromBuffer(project.path, runId, gridBuffer);
    logs.push(`保存网格大图: ${gridPath}`);
    if (input.transparentBackground) {
      logs.push("透明背景：已对网格大图执行背景移除，素材将输出为透明 PNG。");
    }

    const metadata = await sharp(gridBuffer).metadata();
    const width = metadata.width ?? 1024;
    const height = metadata.height ?? 1024;

    // 内容感知切分预检：尝试按实际内容定位每格（透明图走 alpha，不透明均匀底色自动识别）；
    // 成功则前端可预览绿色定位框，失败记录一条日志（切分时仍会再试一次并自动退回等分）。只在多格时启用。
    let autoCells: GridAutoCell[] | undefined;
    if (count > 1) {
      autoCells = (await this.imageService.detectAutoCells(gridBuffer, count)) ?? undefined;
      logs.push(
        !autoCells || autoCells.length === 0
          ? "内容感知切分：未能在图中稳定分离出每个素材（间距过小、边缘粘连或底色不均），切分将退回等分网格。"
          : autoCells.length === count
            ? `内容感知切分：检测到 ${count} 个素材的实际位置，切分将按内容边界对齐而非等分。`
            : autoCells.length < count
              ? `内容感知切分：画面实际只有 ${autoCells.length} 个素材（设定 ${count} 个，少 ${count - autoCells.length} 个），将按实际数量切分且不补空槽。`
              : `内容感知切分：画面实际有 ${autoCells.length} 个素材（设定 ${count} 个，多 ${autoCells.length - count} 个），将按画面实际数量切分。`
      );
    }

    // 每次生成都落一条草稿历史：崩溃重启后也能找回并继续切分
    await this.historyService.upsert(project.path, {
      runId,
      status: "draft",
      createdAt: nowIso(),
      input,
      grid: {
        cols: grid.cols,
        rows: grid.rows,
        width,
        height,
        count,
        gridImagePath: toRelative(project.path, gridPath),
        autoCells: autoCells && autoCells.length > 0 ? autoCells : undefined
      },
      prompt,
      logs: [...logs]
    });

    return {
      runId,
      gridImagePath: toRelative(project.path, gridPath),
      width,
      height,
      cols: grid.cols,
      rows: grid.rows,
      count,
      prompt,
      logs,
      autoCells
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

    const cols = this.clampInt(options.cols || draft.cols, 1, 4);
    const rows = this.clampInt(options.rows || draft.rows, 1, 4);
    const count = this.effectiveCount(input);
    const shrinkPercent = this.clampInt(options.shrinkPercent ?? 8, 0, 30);
    const shiftX = this.clampInt(options.shiftX ?? 0, -1024, 1024);
    const shiftY = this.clampInt(options.shiftY ?? 0, -1024, 1024);

    const buffer = await fs.readFile(gridPath);
    const image = sharp(buffer).ensureAlpha();
    const info = await image.metadata();
    const width = info.width ?? draft.width;
    const height = info.height ?? draft.height;

    // 内容感知切分：多格时按真实内容定位每格（透明图走 alpha，不透明图自动识别均匀底色），
    // 检测结果与期望数一致才启用，否则退回等分网格。cutBoxes 同时用于统一逐格切割。
    const useAuto = options.useAuto !== false && count > 1;
    const autoResult = useAuto
      ? await this.imageService.detectAutoCellsWithMask(buffer, count)
      : null;
    const autoCells: GridAutoCell[] | null = autoResult?.cells ?? null;
    // 逐格蒙版标签：每个内容像素标记其所属素材分组，用于裁图时把落入本格但属于邻格的碎片置透明
    const sliceLabelMask: Int32Array | null = autoResult?.labelMask ?? null;
    let sliceCount: number;
    let cutBoxes: Array<{ left: number; top: number; width: number; height: number }>;
    let cellW = 0;
    let cellH = 0;
    let lastRowCols = cols;
    let equalMode = false;

    if (autoCells && autoCells.length > 0) {
      // 按实际检测到的数量切：画面只画了 15 个（设定 16）就切 15 个，绝不拿 count 去补空槽——
      // 否则最后一格会切到越界的 undefined 或一段空白，也就是过去"第 16 张是空图"的来源。
      sliceCount = autoCells.length;
      cutBoxes = autoCells;
      if (sliceCount === count) {
        logs.push(`内容感知切分：检测到 ${sliceCount} 个素材的实际位置，按内容边界切割（忽略等分网格）。`);
      } else if (sliceCount < count) {
        logs.push(
          `内容感知切分：画面实际只检测到 ${sliceCount} 个素材（设定 ${count} 个，少 ${count - sliceCount} 个），已按实际数量切割且未补空槽；如需 ${count} 个请重新生成大图。`
        );
      } else {
        logs.push(
          `内容感知切分：画面实际检测到 ${sliceCount} 个素材（设定 ${count} 个，多 ${sliceCount - count} 个），已按画面实际数量切割，多出的素材一并保留。`
        );
      }
    } else {
      equalMode = true;
      // 等分兜底：整张按 cols×rows 的固定列槽切分，只取前 sliceCount 个槽位。
      // 末行不满时 AI 被提示"靠左填列槽、右侧留白"，因此槽位切割始终与画面一致。
      const gridSlots = cols * rows;
      sliceCount = Math.min(count, gridSlots);
      lastRowCols = this.clampInt(
        sliceCount - (rows - 1) * cols,
        1,
        cols
      );
      const stepX = width / cols;
      const stepY = height / rows;
      cellW = Math.floor(stepX);
      cellH = Math.floor(stepY);
      if (cellW < 4 || cellH < 4) {
        throw new Error(`网格过大（${cols}×${rows}），单格小于 4px，无法切分。`);
      }
      const inset = Math.floor((Math.min(cellW, cellH) * shrinkPercent) / 200);
      cutBoxes = [];
      for (let slot = 0; slot < sliceCount; slot += 1) {
        const row = Math.floor(slot / cols);
        const col = slot % cols;
        const startX = Math.round(shiftX + col * stepX + inset);
        const endX = Math.round(shiftX + (col + 1) * stepX - inset);
        const startY = Math.round(shiftY + row * stepY + inset);
        const endY = Math.round(shiftY + (row + 1) * stepY - inset);
        cutBoxes.push({ left: startX, top: startY, width: endX - startX, height: endY - startY });
      }
      logs.push(`等分网格切分：${cols}×${rows} 列槽，共切 ${sliceCount} 个。`);
    }

    const assetName = sanitizeFileName(input.name || input.assetType);
    const storageName = this.storageName(assetName, draft.runId);
    const outputDirectory = path.join(project.path, "sprites", storageName);
    const files: string[] = [];
    const absoluteFiles: string[] = [];
    const names: string[] = [];
    const cropResults: Array<{ index: number; name: string; width: number; height: number }> = [];

    for (let index = 0; index < cutBoxes.length; index += 1) {
      const box = cutBoxes[index];
      const startX = this.clampInt(Math.round(box.left), 0, width - 1);
      const endX = this.clampInt(Math.round(box.left + box.width), startX + 1, width);
      const startY = this.clampInt(Math.round(box.top), 0, height - 1);
      const endY = this.clampInt(Math.round(box.top + box.height), startY + 1, height);

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

        // 逐格蒙版裁切：把框内"属于其他素材（或邻格碎片）"的像素置透明，消除切图互相夹带碎片。
        // 仅在内容感知模式下生效（sliceLabelMask 由 detectAutoCellsWithMask 提供，等分模式为 null）。
        if (sliceLabelMask) {
          cellBuffer = await this.applyCellMask(
            cellBuffer,
            sliceLabelMask,
            startX,
            startY,
            endX - startX,
            endY - startY,
            index,
            width,
            height
          );
        }

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

    const maxCellW = cropResults.reduce((max, item) => Math.max(max, item.width), 0);
    const maxCellH = cropResults.reduce((max, item) => Math.max(max, item.height), 0);
    // 内容切分每格尺寸由内容决定（可能各不相同）；等分模式统一为网格单元尺寸
    const size = equalMode
      ? { width: cellW, height: cellH }
      : { width: Math.max(1, maxCellW), height: Math.max(1, maxCellH) };
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
        lastRowCols,
        count: sliceCount,
        imageWidth: width,
        imageHeight: height,
        shiftX,
        shiftY,
        shrinkPercent,
        mode: equalMode ? "equal" : "auto"
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

    await this.persistResult(project, asset, logs, files);

    // 入库成功：把同一 runId 的草稿记录原地更新为已入库（保留原始生成时间与生成日志）
    const previousHistory = await this.historyService.get(project.path, draft.runId);
    await this.historyService.upsert(project.path, {
      runId: draft.runId,
      status: "committed",
      createdAt: previousHistory?.createdAt ?? nowIso(),
      committedAt: nowIso(),
      input,
      grid: {
        cols,
        rows,
        width,
        height,
        count: sliceCount,
        gridImagePath: draft.gridImagePath,
        autoCells: autoCells && autoCells.length > 0 ? autoCells : undefined
      },
      prompt: draft.prompt,
      logs: [...(previousHistory?.logs ?? []), ...logs],
      slice: { cols, rows, lastRowCols, shiftX, shiftY, shrinkPercent, useAuto: !equalMode },
      assetId: asset.id,
      files: [...files],
      metadataPath: asset.metadataPath
    });

    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      gridImagePath: draft.gridImagePath,
      logs
    };
  }

  /**
   * 逐格蒙版裁切：把单格裁图里"非本格内容"的像素置透明。
   * labelMask 与大图同尺寸，每个内容像素标记所属素材分组（0=背景，i+1=第 i 格）。
   * 本格裁图框内若落入其他素材的像素（如 A 的武器尖飘进 B 的框、或 B 的碎片落在 A 的框），
   * 这些像素的标签 ≠ 本格 → 置 alpha=0，使结果只保留本格素材、不再夹带邻格碎片。
   * 只在边界处动刀、不改任何本格内容，故不丢素材。
   */
  private async applyCellMask(
    cellBuffer: Buffer,
    labelMask: Int32Array,
    startX: number,
    startY: number,
    cellW: number,
    cellH: number,
    groupIndex: number,
    imgW: number,
    imgH: number
  ): Promise<Buffer> {
    const { data, info } = await sharp(cellBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const want = groupIndex + 1;

    // 先扫描本格框内的标签归属比例。若属于自己标签的像素极少（<5%），
    // 说明该格主体内容与邻格在掩码里被判定为同一连通块（例如上下两格角色相连）。
    // 此时强行置透明会把本格主体误删成 1×2 碎片，必须回退到矩形裁切。
    let selfPixels = 0;
    let totalContentPixels = 0;
    for (let y = 0; y < cellH; y += 1) {
      const gy = startY + y;
      if (gy < 0 || gy >= imgH) continue;
      const rowBase = gy * imgW;
      for (let x = 0; x < cellW; x += 1) {
        const gx = startX + x;
        if (gx < 0 || gx >= imgW) continue;
        const label = labelMask[rowBase + gx];
        if (label !== 0) {
          totalContentPixels += 1;
          if (label === want) selfPixels += 1;
        }
      }
    }
    if (totalContentPixels > 0 && selfPixels / totalContentPixels < 0.05) {
      return cellBuffer;
    }

    for (let y = 0; y < cellH; y += 1) {
      const gy = startY + y;
      if (gy < 0 || gy >= imgH) continue;
      const rowBase = gy * imgW;
      const localRow = y * cellW * channels;
      for (let x = 0; x < cellW; x += 1) {
        const gx = startX + x;
        if (gx < 0 || gx >= imgW) continue;
        const label = labelMask[rowBase + gx];
        if (label !== 0 && label !== want) {
          data[localRow + x * channels + 3] = 0;
        }
      }
    }
    return sharp(data, { raw: { width: cellW, height: cellH, channels: channels as Raw["channels"] } })
      .png()
      .toBuffer();
  }

  // ---- 自由切图：独立于智能对齐与正常导出，按用户手绘多边形切分 ----

  /** 自由切图侧车缓存路径：与网格大图同目录，文件名固定 freecut.json */
  private freeCutSidecarPath(projectPath: string, gridImagePath: string): string {
    const absolute = resolveProjectPath(projectPath, gridImagePath);
    return path.join(path.dirname(absolute), "freecut.json");
  }

  /** 从智能对齐检测结果初始化自由切图数据：每个包围盒转成 4 顶点多边形 */
  private autoCellsToFreeCut(runId: string, cells: GridAutoCell[] | null): FreeCutData {
    const regions: ManualRegion[] = (cells ?? []).map((cell) => ({
      id: randomUUID(),
      points: [
        { x: cell.left, y: cell.top },
        { x: cell.left + cell.width, y: cell.top },
        { x: cell.left + cell.width, y: cell.top + cell.height },
        { x: cell.left, y: cell.top + cell.height }
      ]
    }));
    return { runId, regions, source: "auto", updatedAt: nowIso() };
  }

  /**
   * 载入某 run 的自由切图数据。
   * 已有缓存则返回缓存；否则回退到智能对齐检测（detectAutoCells）把结果转成多边形作为初始数据，
   * 实现「第一次打开默认就是智能对齐的切图数据」。
   */
  async loadFreeCut(
    projectPath: string,
    gridImagePath: string,
    count: number,
    runId: string
  ): Promise<FreeCutData> {
    const sidecar = this.freeCutSidecarPath(projectPath, gridImagePath);
    if (await fs.pathExists(sidecar)) {
      try {
        const cached = await fs.readJson(sidecar);
        if (cached && Array.isArray(cached.regions)) return cached as FreeCutData;
      } catch {
        // 损坏则忽略，走下方重新检测
      }
    }
    const buffer = await fs.readFile(resolveProjectPath(projectPath, gridImagePath));
    const cells = count > 1 ? await this.imageService.detectAutoCells(buffer, count) : null;
    return this.autoCellsToFreeCut(runId, cells);
  }

  /** 保存自由切图数据到侧车缓存（覆盖写） */
  async saveFreeCut(projectPath: string, gridImagePath: string, data: FreeCutData): Promise<void> {
    const sidecar = this.freeCutSidecarPath(projectPath, gridImagePath);
    await fs.ensureDir(path.dirname(sidecar));
    await fs.writeJson(sidecar, { ...data, updatedAt: nowIso() }, { spaces: 2 });
  }

  /** 还原成智能对齐数据：重新跑检测、覆盖缓存并返回 */
  async restoreFreeCut(
    projectPath: string,
    gridImagePath: string,
    count: number,
    runId: string
  ): Promise<FreeCutData> {
    const buffer = await fs.readFile(resolveProjectPath(projectPath, gridImagePath));
    const cells = count > 1 ? await this.imageService.detectAutoCells(buffer, count) : null;
    const data = this.autoCellsToFreeCut(runId, cells);
    await this.saveFreeCut(projectPath, gridImagePath, data);
    return data;
  }

  /**
   * 按用户多边形区域切分并导出精灵 PNG（与正常导出独立，仅在本界面调用）。
   * 每个区域：取顶点 bbox 从大图裁出，再用多边形蒙版把框外像素置透明，最后走透明/trim 与正常切图一致。
   */
  async sliceManualRegions(
    input: GenerateAssetInput,
    gridImagePath: string,
    runId: string,
    regions: ManualRegion[]
  ): Promise<GeneratedAssetResult> {
    const project = await this.projectService.openProjectPath(input.projectPath);
    const absoluteGrid = resolveProjectPath(input.projectPath, gridImagePath);
    if (!(await fs.pathExists(absoluteGrid))) {
      throw new Error(`网格大图不存在，请重新生成：${gridImagePath}`);
    }
    const buffer = await fs.readFile(absoluteGrid);
    const image = sharp(buffer).ensureAlpha();
    const info = await image.metadata();
    const width = info.width ?? 0;
    const height = info.height ?? 0;
    const logs: string[] = [];

    const assetName = sanitizeFileName(input.name || input.assetType);
    const storageName = this.storageName(assetName, runId);
    const outputDirectory = path.join(project.path, "sprites", storageName);
    const files: string[] = [];
    const cropResults: Array<{ index: number; name: string; width: number; height: number }> = [];

    const validRegions = regions.filter(
      (region) => Array.isArray(region.points) && region.points.length >= 3
    );

    for (let index = 0; index < validRegions.length; index += 1) {
      const region = validRegions[index];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of region.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const startX = this.clampInt(Math.round(minX), 0, width - 1);
      const endX = this.clampInt(Math.round(maxX), startX + 1, width);
      const startY = this.clampInt(Math.round(minY), 0, height - 1);
      const endY = this.clampInt(Math.round(maxY), startY + 1, height);
      const cellW = endX - startX;
      const cellH = endY - startY;
      if (cellW < 2 || cellH < 2) {
        logs.push(`自由切图跳过 #${index + 1}：区域过小。`);
        continue;
      }
      try {
        let cellBuffer = await image
          .clone()
          .extract({ left: startX, top: startY, width: cellW, height: cellH })
          .png()
          .toBuffer();
        const localPoints = region.points.map((p) => ({ x: p.x - startX, y: p.y - startY }));
        cellBuffer = await this.applyPolygonMask(cellBuffer, localPoints, cellW, cellH);
        if (input.transparentBackground) {
          cellBuffer = await this.imageService.removeBackground(cellBuffer);
        }
        if (input.trimEdges) {
          cellBuffer = await this.imageService.trimToContent(cellBuffer);
        }
        const cellName =
          region.name?.trim() ||
          input.cellNames?.[index]?.trim() ||
          `${input.name || "asset"} ${index + 1}`;
        const slug = sanitizeFileName(cellName);
        const fileName = `${String(index + 1).padStart(2, "0")}_${slug}.png`;
        const outputPath = path.join(outputDirectory, fileName);
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, cellBuffer);
        const cellMeta = await sharp(cellBuffer).metadata();
        cropResults.push({ index, name: cellName, width: cellMeta.width ?? 0, height: cellMeta.height ?? 0 });
        files.push(toRelative(project.path, outputPath));
        logs.push(`自由切图素材 ${index + 1}/${validRegions.length}: ${outputPath}`);
      } catch (error) {
        logs.push(`自由切图失败 #${index + 1}: ${this.formatError(error)}`);
      }
    }

    if (files.length === 0) {
      throw new Error(`自由切图失败，没有成功输出。日志：${logs.join(" | ")}`);
    }

    const maxCellW = cropResults.reduce((max, item) => Math.max(max, item.width), 0);
    const maxCellH = cropResults.reduce((max, item) => Math.max(max, item.height), 0);
    const size = { width: Math.max(1, maxCellW), height: Math.max(1, maxCellH) };
    const metadataPath = path.join(outputDirectory, `${storageName}_metadata.json`);
    const previousHistory = await this.historyService.get(project.path, runId);
    const prompt = previousHistory?.prompt ?? input.description ?? input.detailPrompt ?? "";
    await writeJsonFile(metadataPath, {
      name: input.name,
      type: input.assetType,
      style: this.resolveBatchStyle(project, input),
      description: input.description,
      detailPrompt: (input.detailPrompt || "").trim(),
      size,
      grid: {
        cols: 0,
        rows: 0,
        lastRowCols: 0,
        count: validRegions.length,
        imageWidth: width,
        imageHeight: height,
        shiftX: 0,
        shiftY: 0,
        shrinkPercent: 0,
        mode: "freecut"
      },
      files,
      cells: cropResults,
      prompt,
      createdAt: nowIso()
    });

    const asset = this.createAsset(input, {
      id: runId,
      project,
      files,
      metadataPath: toRelative(project.path, metadataPath),
      size,
      prompt
    });

    await this.persistResult(project, asset, logs, files);

    await this.historyService.upsert(project.path, {
      runId,
      status: "committed",
      createdAt: previousHistory?.createdAt ?? nowIso(),
      committedAt: nowIso(),
      input,
      grid: {
        cols: 0,
        rows: 0,
        width,
        height,
        count: validRegions.length,
        gridImagePath,
        autoCells: undefined
      },
      prompt,
      logs: [...(previousHistory?.logs ?? []), ...logs],
      slice: { cols: 0, rows: 0, lastRowCols: 0, shiftX: 0, shiftY: 0, shrinkPercent: 0, useAuto: false },
      assetId: asset.id,
      files: [...files],
      metadataPath: asset.metadataPath
    });

    return {
      asset,
      files,
      metadataPath: asset.metadataPath,
      gridImagePath,
      logs
    };
  }

  /** 射线法判断点是否在多边形内（顶点为本地坐标） */
  private pointInPolygon(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x;
      const yi = poly[i].y;
      const xj = poly[j].x;
      const yj = poly[j].y;
      const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /** 多边形蒙版：把单格裁图里落在多边形外的像素置透明（多边形顶点已转成本地坐标） */
  private async applyPolygonMask(
    cellBuffer: Buffer,
    localPoints: Array<{ x: number; y: number }>,
    cW: number,
    cH: number
  ): Promise<Buffer> {
    const { data, info } = await sharp(cellBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    for (let y = 0; y < cH; y += 1) {
      for (let x = 0; x < cW; x += 1) {
        if (!this.pointInPolygon(x + 0.5, y + 0.5, localPoints)) {
          data[(y * cW + x) * channels + 3] = 0;
        }
      }
    }
    return sharp(data, { raw: { width: cW, height: cH, channels: channels as Raw["channels"] } })
      .png()
      .toBuffer();
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
    // 末行可能不满：引导 AI 把末行内容“靠左对齐进列槽、其余槽位留白”，
    // 这样无论内容感知切分还是等分列槽兜底都与画面一致。
    const lastRowCount = count - (rows - 1) * cols;
    const gridLayout =
      rows <= 1
        ? `arranged in ${cols} columns x 1 row, filled from left to right: place the ${count} items into the leftmost ${count} column slots and leave the remaining slots of the row EMPTY`
        : lastRowCount > 0
          ? `arranged in ${cols} columns x ${rows} rows, filled strictly row by row from left to right: the first ${rows - 1} rows each hold exactly ${cols} items aligned to the ${cols} column slots, and the final row holds only ${lastRowCount} items aligned to the LEFTMOST ${lastRowCount} column slots with the remaining slots of that row LEFT EMPTY`
          : `arranged in ${cols} columns x ${rows} rows, filled strictly row by row from left to right: the first ${rows} rows each hold exactly ${cols} items aligned to the ${cols} column slots (the final row is entirely EMPTY)`;
    const header = singleShot
      ? isIllustration
        ? "Generate ONE full-canvas 2D game illustration: the entire canvas is one finished piece of artwork."
        : `Generate ONE 2D game ${nouns.singular}: the whole canvas holds a single complete ${nouns.singular}, centered with a small safe margin.`
      : `Generate one large 2D game art sheet containing exactly ${count} independent ${nouns.plural}, ${gridLayout}. Do NOT add more than ${count} items.`;
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
