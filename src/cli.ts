import fs from "fs-extra";
import path from "node:path";
import { runGeneration } from "./main/runGeneration";
import { createServices } from "./main/services/factory";
import { getUserDataDir } from "./main/services/utils";
import type {
  AssetType,
  GenerateAssetInput,
  GridSliceOptions,
  ReferenceImageInput,
  ReferenceImageRole,
  ReferenceStrength
} from "@shared/types";

const ASSET_TYPES: AssetType[] = [
  "character",
  "enemy",
  "icon",
  "item",
  "ui",
  "background",
  "effect",
  "other"
];

interface CliFlags {
  project?: string;
  json?: string;
  name?: string;
  description?: string;
  type?: string;
  count?: number;
  size?: string;
  style?: string;
  quality?: string;
  detail?: string;
  cellNames?: string[];
  transparent?: boolean;
  trim?: boolean;
  references?: Array<{ path: string; role: ReferenceImageRole }>;
  slice?: Partial<GridSliceOptions>;
  printJson?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { references: [], slice: {} };
  const slice = flags.slice!;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--json":
        flags.json = next();
        break;
      case "--project":
        flags.project = next();
        break;
      case "--name":
        flags.name = next();
        break;
      case "--description":
        flags.description = next();
        break;
      case "--type":
        flags.type = next();
        break;
      case "--count":
        flags.count = Number(next());
        break;
      case "--size":
        flags.size = next();
        break;
      case "--style":
        flags.style = next();
        break;
      case "--quality":
        flags.quality = next();
        break;
      case "--detail":
        flags.detail = next();
        break;
      case "--cell-names":
        flags.cellNames = next()
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--no-transparent":
        flags.transparent = false;
        break;
      case "--no-trim":
        flags.trim = false;
        break;
      case "--reference":
        flags.references!.push(parseReference(next()));
        break;
      case "--slice-cols":
        slice.cols = Number(next());
        break;
      case "--slice-rows":
        slice.rows = Number(next());
        break;
      case "--slice-last-row-cols":
        slice.lastRowCols = Number(next());
        break;
      case "--slice-shift-x":
        slice.shiftX = Number(next());
        break;
      case "--slice-shift-y":
        slice.shiftY = Number(next());
        break;
      case "--slice-shrink":
        slice.shrinkPercent = Number(next());
        break;
      case "--slice-use-auto":
        slice.useAuto = next() !== "false";
        break;
      case "--print-json":
        flags.printJson = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return flags;
}

function parseReference(value: string): { path: string; role: ReferenceImageRole } {
  const [p, role] = value.split(":");
  const valid: ReferenceImageRole[] = ["subject", "style", "composition", "palette"];
  const r = (role as ReferenceImageRole) ?? "style";
  if (!valid.includes(r)) throw new Error(`参考图作用必须是 ${valid.join("/")}： ${value}`);
  return { path: p, role: r };
}

function printHelp(): void {
  console.log(`Topspeed Builder CLI —— 快捷出图（生成网格大图 + 智能对齐切分入库）

用法：
  node cli.cjs [--json input.json] [常用参数...]

常用参数（与 --json 字段同名，会覆盖 json 中的值）：
  --project <dir>        项目目录（必填，除非 --json 提供）
  --name <text>          批次名 / 输出前缀
  --description <text>   整体描述
  --type <type>          素材类型: ${ASSET_TYPES.join("/")}
  --count <n>            素材数量 1-36
  --size <WxH>           画布尺寸，如 1024x1024
  --style <text>         美术风格描述
  --quality <q>          low/medium/high
  --detail <text>        细节提示词
  --cell-names <a,b,c>   素材名称清单（逗号分隔）
  --reference <path[:role]>   参考图（可重复；role=subject/style/composition/palette）
  --no-transparent       关闭透明背景
  --no-trim              关闭边缘裁剪
  --slice-cols/--slice-rows/--slice-use-auto/--slice-shift-x/--slice-shift-y/--slice-shrink <n>
  --print-json           仅把结果 JSON 打到 stdout（日志走 stderr）
  -h, --help             显示本帮助

--json 文件结构（全部 GenerateAssetInput 字段 + 可选 slice 字段）：
  {
    "projectPath": "/abs/project",
    "assetType": "other",
    "name": "batch",
    "description": "...",
    "detailPrompt": "...",
    "referenceImages": [{ "path": "/abs/img.png", "role": "style" }],
    "referenceStrength": "medium",
    "size": "1024x1024",
    "count": 4,
    "cellNames": ["a","b","c","d"],
    "quality": "high",
    "style": "",
    "transparentBackground": true,
    "trimEdges": true,
    "slice": { "useAuto": true }
  }

示例：
  node cli.cjs --project /abs/project --name heroes --type character --count 6 \\
    --description "赛博朋克英雄图标" --size 1024x1024 --cell-names 剑士,法师,弓手,盗贼,牧师,骑士
`);
}

function coerceInput(base: Partial<GenerateAssetInput>, flags: CliFlags): GenerateAssetInput {
  const input: GenerateAssetInput = {
    projectPath: flags.project ?? base.projectPath ?? "",
    assetType: (flags.type as AssetType) ?? base.assetType ?? "other",
    name: flags.name ?? base.name ?? "",
    description: flags.description ?? base.description ?? "",
    detailPrompt: flags.detail ?? base.detailPrompt ?? "",
    referenceImages: (flags.references && flags.references.length
      ? flags.references.map((r) => ({ path: r.path, role: r.role }) as ReferenceImageInput)
      : (base.referenceImages ?? [])) as ReferenceImageInput[],
    referenceStrength: (flags.quality ? ("medium" as ReferenceStrength) : undefined) ?? base.referenceStrength ?? "medium",
    size: flags.size ?? base.size ?? "1024x1024",
    count: flags.count ?? base.count ?? 0,
    cellNames: flags.cellNames ?? base.cellNames ?? [],
    quality: (flags.quality as GenerateAssetInput["quality"]) ?? base.quality ?? "high",
    style: flags.style ?? base.style ?? "",
    transparentBackground: flags.transparent ?? base.transparentBackground ?? true,
    trimEdges: flags.trim ?? base.trimEdges ?? true
  };
  if (!input.projectPath) throw new Error("缺少项目目录：请用 --project 或 --json 提供 projectPath");
  if (!input.name) throw new Error("缺少批次名：请用 --name 或 --json 提供 name");
  if (!input.description) throw new Error("缺少整体描述：请用 --description 或 --json 提供 description");
  if (!input.count || input.count < 1) throw new Error("缺少素材数量 count（1-36）");
  if (!ASSET_TYPES.includes(input.assetType)) throw new Error(`未知 assetType：${input.assetType}`);
  return input;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  // 先明确告知读的是哪份配置（默认与 GUI 共享同一个 userData 目录），便于确认是否复用了 GUI 里配置的出图 API
  const settingsPath = path.join(getUserDataDir(), "settings.json");
  const hasSettings = await fs.pathExists(settingsPath);
  console.error(
    `[config] 出图配置：${settingsPath}${
      hasSettings ? "" : "（未找到，将使用空配置；请在 GUI 设置页配置出图 API，或用 TOPSPEED_USER_DATA 指定目录）"
    }`
  );

  let base: Partial<GenerateAssetInput> = {};
  if (flags.json) {
    const raw = await fs.readJson(flags.json);
    base = raw as Partial<GenerateAssetInput>;
    // --json 内可带 slice 覆盖
    if (raw.slice && typeof raw.slice === "object") {
      flags.slice = { ...(flags.slice ?? {}), ...(raw.slice as Partial<GridSliceOptions>) };
    }
    if (!flags.project && raw.projectPath) flags.project = raw.projectPath;
  }

  const input = coerceInput(base, flags);
  const sliceOverride = flags.slice && Object.keys(flags.slice).length ? flags.slice : undefined;

  const services = createServices();
  const result = await runGeneration(services, input, sliceOverride);

  const payload = {
    runId: result.runId,
    assetId: result.assetId,
    assetName: result.assetName,
    gridImagePath: result.gridImagePath,
    cols: result.cols,
    rows: result.rows,
    count: result.count,
    files: result.files
  };

  if (flags.printJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`✅ 已生成并切分入库：${result.assetName}（${result.count} 个素材，${result.cols}x${result.rows} 网格）`);
    console.log(`网格大图：${result.gridImagePath}`);
    console.log(`素材文件（${result.files.length}）：`);
    for (const f of result.files) console.log(`  - ${f}`);
  }
  // 日志走 stderr，避免污染 stdout 管道
  for (const l of result.logs) console.error(`[log] ${l}`);
}

void main().catch((err) => {
  console.error(`❌ 出图失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
