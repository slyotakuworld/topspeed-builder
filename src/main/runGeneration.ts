import path from "node:path";
import type { GenerateAssetInput, GridSliceOptions } from "@shared/types";
import type { Services } from "./services/factory";

export interface RunGenerationResult {
  /** 本次生成 runId（与历史记录、网格大图目录对应） */
  runId: string;
  /** 网格大图绝对路径 */
  gridImagePath: string;
  /** 入库的素材批次 id */
  assetId: string;
  /** 入库的素材批次名 */
  assetName: string;
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
 * 一次性出图 + 切分入库：先生成网格大图草稿，再默认走「智能对齐」切分（useAuto:true），
 * 把大图按内容边界切成多个独立 PNG 并写入项目。GUI / MCP / CLI 共用。
 *
 * @param sliceOverride 可选：覆盖默认切分参数（如手动指定 cols/rows、关闭智能对齐）。
 *                      默认行为：沿用生成时推导的网格（cols/rows），并开启内容感知智能对齐。
 */
export async function runGeneration(
  services: Services,
  input: GenerateAssetInput,
  sliceOverride?: Partial<GridSliceOptions>
): Promise<RunGenerationResult> {
  // CLI / MCP 场景下 --project 可以是任意目录：不存在或还不是项目时就地初始化（GUI 不受影响，传的都是已有项目）
  await services.projectService.ensureProjectAt(input.projectPath);

  const draft = await services.generationService.generateGrid(input);

  const slice: GridSliceOptions = {
    cols: draft.cols,
    rows: draft.rows,
    // 默认智能对齐（内容感知切分）；sliceOverride 显式传 useAuto:false 才关闭
    useAuto: true,
    ...(sliceOverride ?? {})
  };

  const result = await services.generationService.commitSlice(input, draft, slice);
  const projectPath = input.projectPath;

  return {
    runId: draft.runId,
    gridImagePath: path.resolve(projectPath, draft.gridImagePath),
    assetId: result.asset.id,
    assetName: result.asset.name,
    files: (result.files ?? []).map((file) => path.resolve(projectPath, file)),
    cols: slice.cols ?? draft.cols,
    rows: slice.rows ?? draft.rows,
    count: draft.count,
    logs: [...draft.logs, ...result.logs]
  };
}
