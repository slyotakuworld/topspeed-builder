import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import type { GenerateAssetInput, GridSliceOptions } from "@shared/types";
import type { Services } from "./services/factory";
import { sanitizeFileName } from "./services/utils";
import { runGeneration } from "./runGeneration";

export interface StandaloneRunResult {
  /** 本次批次输出目录（<输出目录>/<批次名>） */
  batchDir: string;
  /** 网格大图绝对路径 */
  gridImagePath: string;
  /** 切分产出的独立素材文件（绝对路径） */
  files: string[];
  /** 切分使用的实际网格参数 */
  cols: number;
  rows: number;
  count: number;
  /** 合并的日志 */
  logs: string[];
}

/**
 * CLI / MCP 的「无项目直出」管线：出图 → 切分 → 把图片搬到调用方指定的输出目录。
 *
 * 复用 GUI 的生成与切分核心逻辑：先在一个系统临时目录里以临时项目身份跑一遍
 * runGeneration（历史 / 素材库簿记全部落在临时目录），成功后仅把
 * 网格大图、切分素材与 metadata 搬到 <输出目录>/<批次名>/，临时目录整目录删除。
 * 调用方的输出目录里只有图片产物，没有任何 Topspeed Builder 项目文件。
 */
export async function runStandaloneGeneration(
  services: Services,
  input: GenerateAssetInput,
  outputDir: string,
  sliceOverride?: Partial<GridSliceOptions>
): Promise<StandaloneRunResult> {
  const absoluteOut = path.resolve(outputDir);
  const batchName = sanitizeFileName(input.name || "batch");
  const batchDir = path.join(absoluteOut, batchName);
  const tempProject = path.join(os.tmpdir(), `topspeed-run-${randomUUID()}`);

  try {
    await services.projectService.ensureProjectAt(tempProject);
    const result = await runGeneration(services, { ...input, projectPath: tempProject }, sliceOverride);

    await fs.ensureDir(batchDir);

    // 网格大图统一改名为 grid.png，方便消费方固定取用
    const gridImagePath = path.join(batchDir, "grid.png");
    await fs.move(result.gridImagePath, gridImagePath, { overwrite: true });

    // 切分素材逐个搬入（文件名已带 01_ 前缀 + 名称 slug，直接平铺即可）
    const files: string[] = [];
    for (const file of result.files) {
      const destination = path.join(batchDir, path.basename(file));
      await fs.move(file, destination, { overwrite: true });
      files.push(destination);
    }

    // 顺带把 metadata（prompt / 网格参数 / 每格尺寸）一并搬出，供 AI / 脚本消费
    const spritesDir = path.dirname(result.files[0] ?? "");
    let metadataPath: string | null = null;
    if (spritesDir) {
      const metadataSource = (await fs.readdir(spritesDir)).find((name) => name.endsWith("_metadata.json"));
      if (metadataSource) {
        metadataPath = path.join(batchDir, "metadata.json");
        await fs.move(path.join(spritesDir, metadataSource), metadataPath, { overwrite: true });
      }
    }

    return {
      batchDir,
      gridImagePath,
      files,
      cols: result.cols,
      rows: result.rows,
      count: result.count,
      logs: [...result.logs, metadataPath ? `metadata：${metadataPath}` : ""].filter(Boolean)
    };
  } finally {
    // 无论成败都清掉临时项目，输出目录里不会残留任何项目簿记文件
    await fs.remove(tempProject);
  }
}
