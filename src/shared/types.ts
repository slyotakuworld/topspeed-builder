export type AssetType =
  | "character"
  | "enemy"
  | "icon"
  | "item"
  | "ui"
  | "background"
  | "effect"
  | "other";

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

/** 内容感知切分检测出的单格内容区域（像素坐标） */
export interface GridAutoCell {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 自由切图：一个由多边形顶点定义的裁剪区域（像素坐标，相对于网格大图）。
 * 矩形即 4 顶点多边形（左上→右上→右下→左下），与多边形统一用点集表示，
 * 支持「定点精修」——拖动任意顶点即可微调形状，无需重新勾线。
 */
export interface ManualRegion {
  id: string;
  /** 多边形顶点，按勾画顺序闭合（首尾自动连线） */
  points: Array<{ x: number; y: number }>;
  /** 可选：该区域的素材名（用于导出文件名），缺省回退到序号或表单 cellNames */
  name?: string;
}

/** 自由切图缓存：与某次生成 run 绑定，独立存储，不覆盖智能对齐、也不影响正常切分导出 */
export interface FreeCutData {
  runId: string;
  regions: ManualRegion[];
  /** 数据来源：auto = 由智能对齐检测结果初始化；manual = 用户手动编辑 / 新建 */
  source: "auto" | "manual";
  updatedAt: string;
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
  /** 内容感知切分：生成透明网格后按实际内容检测到的每格区域（供预览与自动切分）；检测失败或非透明时为 undefined */
  autoCells?: GridAutoCell[];
}

export interface GridSliceOptions {
  cols: number;
  rows: number;
  /** 末行实际格数（1..cols）。AI 图最后一行不足满格时会整行均分铺开，
   *  指定后该行按自身格数等分行宽切割；缺省 = cols（与旧行为一致，整张按 cols 等分）。 */
  lastRowCols?: number;
  /** 相对默认网格整体水平偏移（像素） */
  shiftX?: number;
  /** 相对默认网格整体垂直偏移（像素） */
  shiftY?: number;
  /** 每格安全边距（每侧占短边的百分比，0-30），用于裁掉格子边缘干扰 */
  shrinkPercent?: number;
  /** 内容感知切分（默认开启）：按实际内容定位每格切割，不再假设等分；仅在透明背景生成且检测成功时生效，失败自动退回等分 */
  useAuto?: boolean;
}

export interface GeneratedAssetResult {
  asset: Asset;
  files: string[];
  metadataPath?: string;
  gridImagePath?: string;
  logs: string[];
}

/** 切分入库实际使用的网格参数（供历史记录展示/回看） */
export interface HistorySliceOptions {
  cols: number;
  rows: number;
  lastRowCols: number;
  shiftX: number;
  shiftY: number;
  shrinkPercent: number;
  /** 本次切分是否使用了内容感知自动切分 */
  useAuto?: boolean;
}

/**
 * 一次「生成」的历史记录：点「生成网格大图」即落一条 draft，
 * 确认切分入库后由服务端原地更新为 committed（同一 runId）。
 * 持久化于项目目录 history.json，重启后仍可查看/续做草稿。
 */
export interface GenerationHistoryEntry {
  runId: string;
  /** draft = 只生成了网格大图草稿；committed = 已切分入库 */
  status: "draft" | "committed";
  createdAt: string;
  committedAt?: string;
  /** 生成时的完整表单快照：用于历史回看、以及载入草稿后继续切分 */
  input: GenerateAssetInput;
  grid: {
    cols: number;
    rows: number;
    width: number;
    height: number;
    count: number;
    /** 相对项目路径，如 generated/raw/<runId>/grid.png */
    gridImagePath: string;
    /** 内容感知切分：生成/入库时按实际内容检测到的每格区域（若成功），
     *  持久化后历史恢复草稿可直接复现绿框预览，保证预览与切分结果一致 */
    autoCells?: GridAutoCell[];
  };
  prompt: string;
  logs: string[];
  /** 已入库批次：实际切分参数 */
  slice?: HistorySliceOptions;
  assetId?: string;
  /** 已入库批次：切出的素材文件（相对项目路径） */
  files?: string[];
  metadataPath?: string;
}

export interface IpcResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
