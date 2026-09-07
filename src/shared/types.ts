export type AssetType =
  | "character"
  | "enemy"
  | "icon"
  | "item"
  | "ui"
  | "background"
  | "effect";

export type GenerationQuality = "low" | "medium" | "high";
export type ReferenceImageRole = "subject" | "style" | "composition" | "palette";
export type ReferenceStrength = "low" | "medium" | "high";

export interface Size {
  width: number;
  height: number;
}

export interface ReferenceImageInput {
  path: string;
  role: ReferenceImageRole;
  sourceAssetId?: string;
  name?: string;
}

export interface ImportedReferenceImage extends ReferenceImageInput {
  width: number;
  height: number;
  mime: string;
  bytes: number;
  hash: string;
  thumbnailPath?: string;
  dataUrl: string;
}

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  description: string;
  style: string;
  size: Size;
  files: string[];
  metadataPath?: string;
  referenceImages?: ReferenceImageInput[];
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface StyleTemplate {
  id: string;
  name: string;
  description: string;
  seed?: string;
  lineWeight?: string;
  lighting?: string;
  cameraView?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  gameType: string;
  style: string;
  styleDescription: string;
  assets: Asset[];
  styleTemplates: StyleTemplate[];
  createdAt: string;
  updatedAt: string;
}

export interface RecentProject {
  id: string;
  name: string;
  path: string;
  gameType: string;
  style: string;
  updatedAt: string;
}

export interface AppSettings {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  availableModels: string[];
  defaultProjectRoot: string;
  defaultExportDirectory: string;
}

export interface CreateProjectInput {
  name: string;
}

/**
 * 一次生成 = 让 AI 画一张包含多个独立素材的大图（自动网格），
 * 再由工具按网格裁成多个独立 PNG。
 */
export interface GenerateAssetInput {
  projectPath: string;
  assetType: AssetType;
  /** 批次名 / 输出前缀（不带序号） */
  name: string;
  /** 对整张图要出现的内容做整体描述 */
  description: string;
  detailPrompt: string;
  /** 参考图：仅作为统一风格/角色/色板的参考 */
  referenceImages: ReferenceImageInput[];
  referenceStrength: ReferenceStrength;
  /** 整张大图画布，格式如 1024x1024 */
  size: string;
  /** 网格内素材数量（自动推导列×行） */
  count: number;
  /** 可选：按网格顺序（行优先）给每个素材命名，长度可与 count 不同 */
  cellNames: string[];
  quality: GenerationQuality;
  /** 本次出图使用的美术风格文本（生成页预设或自定义描述）；为空时回退项目旧风格字段 */
  style: string;
  transparentBackground: boolean;
  trimEdges: boolean;
}

/** generate:grid 产出的“大图草稿”，等待用户在界面确认切分参数后提交 */
export interface GridDraft {
  runId: string;
  gridImagePath: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  count: number;
  prompt: string;
  logs: string[];
}

export interface GridSliceOptions {
  cols: number;
  rows: number;
  /** 相对默认网格整体水平偏移（像素） */
  shiftX?: number;
  /** 相对默认网格整体垂直偏移（像素） */
  shiftY?: number;
  /** 每格安全边距（每侧占短边的百分比，0-30），用于裁掉格子边缘干扰 */
  shrinkPercent?: number;
}

export interface GeneratedAssetResult {
  asset: Asset;
  files: string[];
  metadataPath?: string;
  gridImagePath?: string;
  logs: string[];
}

export interface IpcResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
