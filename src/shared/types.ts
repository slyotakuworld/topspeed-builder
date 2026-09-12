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

/** 内置美术风格预设（value 与生成时传入的 style 一致；text 为发送给绘图模型的英文风格描述） */
export interface StylePreset {
  value: string;
  /** i18n 文案 key，renderer 用它做下拉展示 */
  label: string;
  text: string;
}
export const STYLE_PRESETS: StylePreset[] = [
  { value: "pixel", label: "generate.style.pixel", text: "Pixel art: crisp hard pixel edges, clean readable silhouette, restrained color palette, no blur, no soft gradients." },
  { value: "chibi", label: "generate.style.chibi", text: "Chibi art: big head with small body, rounded and cute shapes, clean simple lines, soft color blocking." },
  { value: "cartoon", label: "generate.style.cartoon", text: "Cartoon style: bright flat colors, bold clean outlines, simple readable shapes, flat cel-like shading." },
  { value: "anime", label: "generate.style.anime", text: "Japanese anime cel style: clean cel shading, saturated colors, neat lineart, expressive stylized faces." },
  { value: "retro16", label: "generate.style.retro16", text: "16-bit retro game art: dithered shading, subtle gradients, clear outlines, visible chunky pixels, vibrant palette." },
  { value: "flat", label: "generate.style.flat", text: "Flat vector design: solid color areas, minimal clean shapes, no gradients, no textures, no outlines." },
  { value: "lowpoly", label: "generate.style.lowpoly", text: "Low-poly style: faceted geometric surfaces, flat-shaded facets, stylized lighting, crisp silhouettes." },
  { value: "ink", label: "generate.style.ink", text: "Chinese ink wash (shui-mo) style: expressive brush strokes, ink gradation, soft paper texture, elegant negative space." },
  { value: "realistic", label: "generate.style.realistic", text: "Realistic painted game concept art: rich painterly texture, natural lighting and material shading, strong volume and fine detail, clearly a hand-painted illustration rather than a photograph." }
];
/** 提示词助手：四个生成字段的独立开关（决定生成哪些字段、回填哪些字段） */
export interface PromptAssistantFields {
  /** 整体描述 */
  description: boolean;
  /** 对象细节提示词 */
  detailPrompt: boolean;
  /** 素材名称清单 */
  cellNames: boolean;
  /** 美术风格（自定义描述 / 内置预设） */
  style: boolean;
}
export const DEFAULT_PROMPT_ASSISTANT_FIELDS: PromptAssistantFields = {
  description: true,
  detailPrompt: true,
  cellNames: true,
  style: true
};
export const PROMPT_ASSISTANT_FIELD_KEYS: Array<keyof PromptAssistantFields> = [
  "description",
  "detailPrompt",
  "cellNames",
  "style"
];

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

/**
 * 提示词助手配置：完全独立于出图模型（AppSettings），走单独的 API / Key。
 * 用于调用 LLM（OpenAI 兼容 /v1/chat/completions）生成生图所需的提示词文本。
 */
export interface PromptAssistantSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  availableModels: string[];
  /** 四个生成字段的开关，默认全开；关闭的字段不生成、也不回填 */
  fields: PromptAssistantFields;
}

/** 提示词助手：用户给出的输入（不再单独要主题/类型/数量，而是复用当前素材生成参数） */
export interface PromptAssistantInput {
  /** 用户的自然语言描述：结合当前已有的素材生成参数，描述想要的风格 / 效果 / 对象等 */
  naturalLanguage: string;
  /** 现有素材生成参数：类型（如 icon / enemy / character…），作为生成约束 */
  assetType: string;
  /** 现有素材生成参数：数量，用于约束 cellNames 的数量 */
  count: number;
  /** 可选：当前已有的整体描述，作为补充上下文 */
  currentDescription?: string;
  /** 可选：当前已有的自定义风格描述，作为补充上下文 */
  currentStyle?: string;
  /** 可选：本次要生成的字段开关（缺省=全开） */
  fields?: PromptAssistantFields;
}

/** 提示词助手：LLM 生成的四个提示词字段 */
export interface PromptAssistantResult {
  /** 对整张图要出现的内容做整体描述 */
  description: string;
  /** 细节提示词：造型 / 配色 / 材质 / 光影等可追加的细节要求 */
  detailPrompt: string;
  /** 素材名称清单（顺序即网格顺序） */
  cellNames: string[];
  /** 美术风格自定义描述 */
  style: string;
  /**
   * 是否成功从模型输出中解析出结构化 JSON。
   * false 表示模型未按要求返回 JSON，调用方应展示 raw 原始文本，
   * 由用户手动复制粘贴到对应输入框。
   */
  parsed: boolean;
  /** 模型原始输出（无论是否解析成功都带回，用于解析失败时的复制粘贴兜底） */
  raw: string;
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
 * 素材库记录的三种状态（由历史记录字段推导，不额外落盘）：
 * - empty  ：只有配置快照，还没有任何图（例如「新建出图」后仅保存历史记录）
 * - grid   ：已有网格整图，但尚未切图入库
 * - sliced ：已切图入库，有独立素材文件
 */
export type LibraryAssetState = "empty" | "grid" | "sliced";

/** 由历史记录推导素材库状态：有切图文件 → sliced；否则有整图 → grid；都没有 → empty */
export function resolveLibraryAssetState(entry: {
  grid?: { gridImagePath?: string } | null;
  files?: string[] | null;
}): LibraryAssetState {
  if (Array.isArray(entry.files) && entry.files.length > 0) return "sliced";
  return entry.grid?.gridImagePath ? "grid" : "empty";
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
  /**
   * 素材库 / 历史记录共用的显示名：两处是同一个名字，重命名任一处都会同步。
   * 缺省回退到 input.name（批次名）。
   */
  name?: string;
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