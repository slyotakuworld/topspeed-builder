import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  AssetType,
  GenerateAssetInput,
  GridSliceOptions,
  ReferenceImageInput,
  ReferenceImageRole,
  ReferenceStrength
} from "@shared/types";
import { runStandaloneGeneration } from "../main/runStandalone";
import type { Services } from "../main/services/factory";
import {
  ASSET_TYPE_VALUES as ASSET_TYPES,
  REFERENCE_ROLE_VALUES as REFERENCE_ROLES,
  REFERENCE_STRENGTH_VALUES as REFERENCE_STRENGTHS
} from "@shared/types";

/**
 * generate_sprites 工具的入参 JSON Schema（MCP 客户端据此渲染表单 / 校验）。
 * 刻意使用纯 JSON Schema 而非 zod：避免与 MCP SDK 内部自带的 zod 实例产生类型冲突。
 */
const GENERATE_SPRITES_SCHEMA = {
  type: "object",
  properties: {
    projectPath: {
      type: "string",
      description:
        "输出目录的绝对路径（自动创建，不需要是任何项目目录）：网格大图存为 <输出目录>/<批次名>/grid.png，切分素材平铺在同目录下"
    },
    assetType: {
      type: "string",
      enum: ASSET_TYPES,
      default: "other",
      description: "素材类型：character/enemy/icon/item/ui/background/effect/other"
    },
    name: { type: "string", description: "批次名 / 输出文件名前缀（不带序号）" },
    description: { type: "string", description: "对整张图要出现的内容做整体描述" },
    detailPrompt: {
      type: "string",
      default: "",
      description: "细节提示词：造型 / 配色 / 材质 / 光影等可追加的细节要求"
    },
    referenceImages: {
      type: "array",
      default: [],
      description: "参考图清单（仅作统一风格 / 角色 / 色板参考）",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "本地参考图绝对路径" },
          role: { type: "string", enum: REFERENCE_ROLES, default: "style" },
          sourceAssetId: { type: "string" },
          name: { type: "string" }
        },
        required: ["path"]
      }
    },
    referenceStrength: {
      type: "string",
      enum: REFERENCE_STRENGTHS,
      default: "medium",
      description: "参考图强度：low/medium/high"
    },
    size: { type: "string", default: "1024x1024", description: "整张大图画布，格式如 1024x1024" },
    count: { type: "integer", minimum: 1, maximum: 36, description: "网格内素材数量（1-36）" },
    cellNames: {
      type: "array",
      items: { type: "string" },
      default: [],
      description: "按网格顺序（行优先）给每个素材命名，长度可与 count 不同"
    },
    quality: { type: "string", enum: ["low", "medium", "high"], default: "high", description: "生成质量" },
    style: { type: "string", default: "", description: "美术风格文本（预设或自定义描述）；为空时回退项目风格" },
    transparentBackground: { type: "boolean", default: true, description: "透明背景出图（默认 true）" },
    trimEdges: { type: "boolean", default: true, description: "裁掉格子边缘干扰（默认 true）" },
    slice: {
      type: "object",
      description: "切分参数覆盖（缺省：智能对齐 + 自动推导网格）",
      properties: {
        cols: { type: "integer", description: "列数（缺省按 count 自动推导）" },
        rows: { type: "integer", description: "行数（缺省按 count 自动推导）" },
        lastRowCols: { type: "integer", description: "末行实际格数（1-cols）" },
        shiftX: { type: "integer", description: "相对默认网格整体水平偏移（像素）" },
        shiftY: { type: "integer", description: "相对默认网格整体垂直偏移（像素）" },
        shrinkPercent: { type: "number", description: "每格安全边距占短边百分比 0-30" },
        useAuto: { type: "boolean", description: "是否启用内容感知智能对齐（默认 true）" }
      }
    }
  },
  required: ["projectPath", "name", "description", "count"],
  additionalProperties: false
} as const;

/** 把 MCP 传入的宽松参数规整为 GenerateAssetInput（补默认值 + 校验必填） */
function normalizeInput(raw: Record<string, unknown>): GenerateAssetInput {
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  const projectPath = str(raw.projectPath);
  const name = str(raw.name);
  const description = str(raw.description);
  const count = num(raw.count) ?? 0;

  if (!projectPath) throw new Error("缺少 projectPath：项目目录绝对路径");
  if (!name) throw new Error("缺少 name：批次名 / 输出前缀");
  if (!description) throw new Error("缺少 description：整体描述");
  if (count < 1 || count > 36) throw new Error(`count 需在 1-36 之间，收到 ${count || "空"}`);

  const assetTypeRaw = str(raw.assetType, "other") as AssetType;
  const assetType = ASSET_TYPES.includes(assetTypeRaw) ? assetTypeRaw : "other";

  const referenceStrengthRaw = str(raw.referenceStrength, "medium") as ReferenceStrength;
  const referenceStrength = REFERENCE_STRENGTHS.includes(referenceStrengthRaw) ? referenceStrengthRaw : "medium";

  const qualityRaw = str(raw.quality, "high");
  const quality: GenerateAssetInput["quality"] = (["low", "medium", "high"] as const).includes(
    qualityRaw as GenerateAssetInput["quality"]
  )
    ? (qualityRaw as GenerateAssetInput["quality"])
    : "high";

  const referenceImages: ReferenceImageInput[] = Array.isArray(raw.referenceImages)
    ? raw.referenceImages
        .map((item): ReferenceImageInput | null => {
          if (!item || typeof item !== "object") return null;
          const obj = item as Record<string, unknown>;
          const p = str(obj.path);
          if (!p) return null;
          const roleRaw = str(obj.role, "style") as ReferenceImageRole;
          const role = REFERENCE_ROLES.includes(roleRaw) ? roleRaw : "style";
          return {
            path: p,
            role,
            sourceAssetId: typeof obj.sourceAssetId === "string" ? obj.sourceAssetId : undefined,
            name: typeof obj.name === "string" ? obj.name : undefined
          };
        })
        .filter((x): x is ReferenceImageInput => x !== null)
    : [];

  return {
    projectPath,
    assetType,
    name,
    description,
    detailPrompt: str(raw.detailPrompt, ""),
    referenceImages,
    referenceStrength,
    size: str(raw.size, "1024x1024") || "1024x1024",
    count,
    cellNames: Array.isArray(raw.cellNames) ? raw.cellNames.filter((x): x is string => typeof x === "string") : [],
    quality,
    style: str(raw.style, ""),
    transparentBackground: bool(raw.transparentBackground, true),
    trimEdges: bool(raw.trimEdges, true)
  };
}

/** 把 MCP 的 slice 覆盖规整为 GridSliceOptions（仅保留显式提供的字段） */
function normalizeSlice(raw: unknown): Partial<GridSliceOptions> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const out: Partial<GridSliceOptions> = {};
  if (typeof obj.cols === "number") out.cols = obj.cols;
  if (typeof obj.rows === "number") out.rows = obj.rows;
  if (typeof obj.lastRowCols === "number") out.lastRowCols = obj.lastRowCols;
  if (typeof obj.shiftX === "number") out.shiftX = obj.shiftX;
  if (typeof obj.shiftY === "number") out.shiftY = obj.shiftY;
  if (typeof obj.shrinkPercent === "number") out.shrinkPercent = obj.shrinkPercent;
  if (typeof obj.useAuto === "boolean") out.useAuto = obj.useAuto;
  return Object.keys(out).length ? out : undefined;
}

/**
 * 构建 MCP server（不绑定传输层）。GUI 主进程与独立 mcp 脚本共用同一实例工厂，
 * 保证出图 / 切图逻辑与桌面端完全一致。
 *
 * 暴露的工具：generate_sprites —— 给定完整出图参数（含可选切图参数），
 * 生成网格大图并按智能对齐切分入库，返回素材文件清单、网格大图路径与日志。
 */
export function createMcpServer(services: Services): Server {
  const server = new Server(
    { name: "topspeed-builder", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "generate_sprites",
        description:
          "让 AI 画一张包含多个素材的网格大图，再按网格（默认内容感知「智能对齐」）切成多个独立 PNG 并写入项目。" +
          "参数为全套出图设置；切图默认走智能对齐，可通过 slice 字段手动覆盖网格与对齐方式。",
        inputSchema: GENERATE_SPRITES_SCHEMA as unknown as { type: "object"; [k: string]: unknown }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "generate_sprites") {
      throw new Error(`未知工具：${request.params.name}`);
    }
    const raw = (request.params.arguments ?? {}) as Record<string, unknown>;
    const input = normalizeInput(raw);
    const sliceOverride = normalizeSlice(raw.slice);

    const result = await runStandaloneGeneration(services, input, input.projectPath, sliceOverride);

    const payload = {
      batchDir: result.batchDir,
      gridImagePath: result.gridImagePath,
      cols: result.cols,
      rows: result.rows,
      count: result.count,
      files: result.files,
      logs: result.logs
    };

    return {
      content: [
        {
          type: "text",
          text:
            `已生成并切分：${input.name}（${result.count} 个素材，${result.cols}x${result.rows} 网格）\n` +
            `输出目录：${result.batchDir}\n` +
            `网格大图：${result.gridImagePath}\n` +
            `素材文件（${result.files.length}）：\n${result.files.map((f) => `- ${f}`).join("\n")}\n\n` +
            `日志：\n${result.logs.map((l) => `- ${l}`).join("\n")}`
        },
        { type: "text", text: JSON.stringify(payload, null, 2) }
      ]
    };
  });

  return server;
}
