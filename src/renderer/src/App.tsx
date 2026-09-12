import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import i18n, { switchLanguage } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  Download,
  FileText,
  FolderOpen,
  History,
  Home,
  Image,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import type {
  AppSettings,
  Asset,
  AssetType,
  GenerateAssetInput,
  GenerationHistoryEntry,
  GenerationQuality,
  GridDraft,
  GridSliceOptions,
  ImportedReferenceImage,
  IpcResponse,
  LibraryAssetState,
  Project,
  PromptAssistantResult,
  PromptAssistantSettings,
  RecentProject,
  ReferenceImageInput,
  ReferenceImageRole,
  ReferenceStrength,
  PromptAssistantFields
} from "@shared/types";
import {
  STYLE_PRESETS,
  DEFAULT_PROMPT_ASSISTANT_FIELDS,
  PROMPT_ASSISTANT_FIELD_KEYS,
  resolveLibraryAssetState
} from "@shared/types";
import FreeCutModal from "./FreeCutModal";

type Page = "home" | "generate" | "assets" | "settings";
type DetailTemplate = { id: string; name: string; prompt: string; meta: string };
type ReferenceDraft = ReferenceImageInput & Partial<Pick<ImportedReferenceImage, "width" | "height" | "bytes" | "hash" | "thumbnailPath" | "dataUrl">>;
type SelectOption = string | { value: string; label: string };

/**
 * 素材库的一条记录。数据源是「生成历史台账」——所以没有图、只有整图、已切图三种状态
 * 天然都被覆盖；另把项目里没有对应历史的老素材（历史台账早于该功能）作为孤儿条目并入，
 * 保证旧项目不丢素材。entry 为空即孤儿条目。
 */
type LibraryItem = {
  runId: string;
  entry: GenerationHistoryEntry | null;
  name: string;
  assetType: AssetType;
  state: LibraryAssetState;
  createdAt: string;
  count: number;
  gridImagePath: string;
  files: string[];
  metadataPath?: string;
  assetId?: string;
  description: string;
};
// label 一律用 i18n key（其它选项数组同款写法），value 保持原值不动——value 是要传给 AI 的，
// 改了会改变生成结果、也会让历史里的旧值匹配不上。
const gameTypeOptions: SelectOption[] = [
  { value: "RPG", label: "gameType.rpg" },
  { value: "平台跳跃", label: "gameType.platform" },
  { value: "俯视角", label: "gameType.topdown" },
  { value: "横版动作", label: "gameType.sideScroll" },
  { value: "卡牌", label: "gameType.card" },
  { value: "塔防", label: "gameType.towerDefense" },
  { value: "其他", label: "gameType.other" }
];
const stylePresets = STYLE_PRESETS;
const styleCustomValue = "custom";
const stylePresetOptions: SelectOption[] = stylePresets.map((preset) => ({
  value: preset.value,
  label: preset.label
}));
const qualityOptions: SelectOption[] = [
  { value: "low", label: "quality.low" },
  { value: "medium", label: "quality.medium" },
  { value: "high", label: "quality.high" }
];
const defaultQuality: GenerationQuality = "low";
/* 画布尺寸：下拉预设，选「自定义」时才手填宽高；选项文案含常见用途备注 */
const sizeOptions: SelectOption[] = [
  { value: "512x512", label: "sizePreset.s512" },
  { value: "1024x1024", label: "sizePreset.s1024" },
  { value: "1024x1536", label: "sizePreset.s1024x1536" },
  { value: "1536x1024", label: "sizePreset.s1536x1024" },
  { value: "1024x1792", label: "sizePreset.s1024x1792" },
  { value: "1792x1024", label: "sizePreset.s1792x1024" }
];
const sizeCustomValue = "custom";
const sizeSelectOptions: SelectOption[] = [...sizeOptions, { value: sizeCustomValue, label: "generate.sizeCustom" }];
/** 数量下拉：常用组合（AI 会按数量自动排布 列×行，覆盖常见素材批次） */
const countPresets = [1, 2, 3, 4, 6, 8, 9, 12, 16];
const countOptions: SelectOption[] = countPresets.map((value) => ({ value: String(value), label: String(value) }));
/** 等分兜底切分的 列/行 下拉（非智能对齐模式上限 4） */
const sliceAxisOptions: SelectOption[] = Array.from({ length: 4 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1)
}));
/** 历史里可能存在非预设的数量（旧版输入框产物），恢复时吸附到最接近的预设 */
function nearestCountPreset(value: number): number {
  const numeric = Number.isFinite(value) ? Math.round(value) : 1;
  const clamped = Math.min(16, Math.max(1, numeric));
  let best = countPresets[0];
  for (const candidate of countPresets) {
    if (Math.abs(candidate - clamped) < Math.abs(best - clamped)) best = candidate;
  }
  return best;
}
const referenceRoles: Array<{ value: ReferenceImageRole; label: string }> = [
  { value: "subject", label: "role.subject" },
  { value: "style", label: "role.style" },
  { value: "composition", label: "role.composition" },
  { value: "palette", label: "role.palette" }
];
const referenceStrengthOptions: Array<{ value: ReferenceStrength; label: string }> = [
  { value: "low", label: "strength.low" },
  { value: "medium", label: "strength.medium" },
  { value: "high", label: "strength.high" }
];
const assetTypes: Array<{ value: AssetType; label: string }> = [
  { value: "character", label: "assetType.character" },
  { value: "enemy", label: "assetType.enemy" },
  { value: "item", label: "assetType.item" },
  { value: "icon", label: "assetType.icon" },
  { value: "ui", label: "assetType.ui" },
  { value: "effect", label: "assetType.effect" },
  { value: "background", label: "assetType.background" },
  { value: "other", label: "assetType.other" }
];

const objectDetailTemplates: Record<AssetType, DetailTemplate[]> = {
  icon: [
    { id: "icon-readable", name: "高可读轮廓", prompt: "单个居中物体，轮廓粗清晰，正面视角，无文字，无多余道具", meta: "图标 · 背包识别" },
    { id: "icon-material", name: "材质重点", prompt: "材质特征明确，边缘精致，小面积高光，在小尺寸下仍可辨识", meta: "图标 · 材质" },
    { id: "icon-rare", name: "稀有道具感", prompt: "高级收藏品质，形状紧凑，轻微发光，轮廓干净，背景无杂物", meta: "图标 · 品质" }
  ],
  item: [
    { id: "item-held", name: "可持握道具", prompt: "手持道具比例，有清晰握持区域，游戏内轮廓实用，单独物体", meta: "道具 · 使用感" },
    { id: "item-worn", name: "旧化边缘", prompt: "边缘磨损，有划痕和小凹痕，材质旧化可读但不过度杂乱", meta: "道具 · 质感" },
    { id: "item-quest", name: "任务物品", prompt: "任务物品形状独特，有可识别的焦点细节，略带仪式感结构", meta: "道具 · 叙事" }
  ],
  character: [
    { id: "character-portrait", name: "立绘站姿", prompt: "清晰站姿，重心平衡，轮廓可读，符合游戏精灵比例", meta: "角色 · 站姿" },
    { id: "character-armor", name: "盔甲材质", prompt: "金属/布料材质分明，边缘精致，色板克制", meta: "角色 · 材质" },
    { id: "character-rpg", name: "职业主题", prompt: "职业特征明显的造型，武器或标志物可见，待机轮廓干净", meta: "角色 · 辨识" }
  ],
  enemy: [
    { id: "enemy-threat", name: "威胁轮廓", prompt: "敌对生物轮廓，形状夸张且可读，有明确弱点，不要可爱表情", meta: "怪物 · 识别" },
    { id: "enemy-slime", name: "软体怪", prompt: "凝胶状身体，简单面部，可挤压的圆润形体，边缘半透明高光", meta: "怪物 · 软体" },
    { id: "enemy-boss", name: "精英单位", prompt: "更大的精英变体细节，甲壳或护甲板，更强轮廓，攻击提示可读", meta: "怪物 · 精英" }
  ],
  ui: [
    { id: "ui-panel", name: "面板控件", prompt: "干净的界面面板部件，边缘适合九宫格切片，斜面可读，无文字标签", meta: "界面 · 面板" },
    { id: "ui-button", name: "按钮状态", prompt: "游戏按钮元素，按下状态几何结构清晰，中心高光，无内嵌文字", meta: "界面 · 控件" },
    { id: "ui-hud", name: "状态栏元件", prompt: "紧凑的状态栏元素，有强图标槽，高对比边框，透明背景", meta: "界面 · 状态栏" }
  ],
  background: [
    { id: "bg-parallax", name: "视差层", prompt: "横版卷轴视差层，前景与背景层次分明，无角色", meta: "背景 · 横版" },
    { id: "bg-loop", name: "循环背景", prompt: "可水平循环的背景，地标柔和重复，地平线一致", meta: "背景 · 循环" },
    { id: "bg-atmosphere", name: "气氛光", prompt: "环境气氛光，深度层次可读，不干扰玩法的背景", meta: "背景 · 气氛" }
  ],
  effect: [
    { id: "effect-impact", name: "命中爆发", prompt: "短促命中爆发，中心点清晰，径向粒子，透明背景", meta: "特效 · 打击" },
    { id: "effect-burst", name: "能量爆发", prompt: "能量流向一致、形状简洁的单体爆发形态", meta: "特效 · 能量" },
    { id: "effect-magic", name: "魔法光效", prompt: "奥术发光粒子，法术核心可读，外层柔和辉光", meta: "特效 · 魔法" }
  ],
  other: [
    { id: "other-scene", name: "氛围场景", prompt: "完整的场景或插画画面，空间层次与氛围清晰，主体与背景分明", meta: "插画 · 场景" },
    { id: "other-poster", name: "主视觉", prompt: "海报式单幅构图，视觉焦点明确，画面干净，有冲击力", meta: "插画 · 主视觉" },
    { id: "other-charart", name: "完整立绘", prompt: "人物全身完整立绘，姿态自然，细节充分，画面自成一幅作品", meta: "插画 · 立绘" }
  ]
};

const defaultSettings: AppSettings = {
  apiKey: "",
  apiBaseUrl: "",
  model: "",
  availableModels: [],
  defaultProjectRoot: "",
  defaultExportDirectory: ""
};

// ---- 运行时性能采样：长任务/链路计时单向上报，主进程写入 <userData>/perf-log.txt ----
let perfLastLogAt = 0;
function perfLog(line: string): void {
  const now = Date.now();
  if (now - perfLastLogAt < 300) return; // 全局节流，避免日志本身造成卡顿
  perfLastLogAt = now;
  try {
    window.topspeedBuilder?.perfLog?.(line);
  } catch {
    // 桥接未就绪时静默
  }
}
if (typeof window !== "undefined" && typeof PerformanceObserver !== "undefined") {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 80) {
          perfLog(`longtask ${Math.round(entry.duration)}ms @t=${Math.round(entry.startTime)}ms`);
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // 不支持 longtask 的环境忽略
  }
}

function App(): JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState<Page>("home");
  const [project, setProject] = useState<Project | null>(null);
  const [homeProjects, setHomeProjects] = useState<RecentProject[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [queuedReference, setQueuedReference] = useState<ReferenceDraft | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  // 全局生成历史（供侧栏时间轴与生成页共用），随当前项目切换
  const [historyEntries, setHistoryEntries] = useState<GenerationHistoryEntry[]>([]);
  // 侧栏点选历史后的载入请求：seq 递增驱动生成页回填
  const [pendingRestore, setPendingRestore] = useState<{ entry: GenerationHistoryEntry; seq: number } | null>(null);
  // 侧栏历史"选中态"：当前生成页里正打开着哪条历史（由其草稿 runId 自下而上回传）
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // 生成页会话号：点击「素材生成」导航即自增并重建生成页 → 全新空白生成界面
  const [generateSessionKey, setGenerateSessionKey] = useState(0);

  useEffect(() => {
    void refreshInitialState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navItems = useMemo(
    () => [
      { page: "home" as Page, label: t("nav.home"), icon: Home, enabled: true },
      { page: "generate" as Page, label: t("nav.generate"), icon: Wand2, enabled: Boolean(project) },
      { page: "assets" as Page, label: t("nav.assets"), icon: Image, enabled: Boolean(project) },
      { page: "settings" as Page, label: t("nav.settings"), icon: Settings, enabled: true }
    ],
    [project, i18n.language]
  );

  async function unwrap<T>(request: Promise<IpcResponse<T>>): Promise<T> {
    const result = await request;
    if (!result.ok) {
      throw new Error(result.error ?? "未知错误");
    }
    return result.data as T;
  }

  async function refreshInitialState(): Promise<void> {
    try {
      const bridge = window.topspeedBuilder;
      if (!bridge) {
        setMessage("浏览器预览模式：桌面通信未连接；桌面应用中会启用本地文件、智能生成服务。");
        return;
      }
      if (typeof bridge.listDiscoverableProjects !== "function") {
        setMessage(t("message.staleBridge"));
        return;
      }

      const [nextSettings, nextProjects] = await Promise.all([
        unwrap(bridge.getSettings()),
        unwrap(bridge.listDiscoverableProjects())
      ]);
      setSettings(nextSettings);
      setHomeProjects(nextProjects);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshProject(projectPath = project?.path): Promise<Project | null> {
    if (!window.topspeedBuilder) return null;
    if (!projectPath) return null;
    const nextProject = await unwrap(window.topspeedBuilder.openProjectPath(projectPath));
    setProject(nextProject);
    return nextProject;
  }

  // ---- 全局生成历史：刷新 / 载入 / 删除 ----
  async function refreshHistory(projectPath = project?.path): Promise<void> {
    const bridge = window.topspeedBuilder;
    if (!bridge || !projectPath || typeof bridge.listGenerationHistory !== "function") return;
    const perfStart = performance.now();
    try {
      const entries = await unwrap(bridge.listGenerationHistory(projectPath));
      setHistoryEntries(entries);
      perfLog(`history:list ok entries=${entries.length} ${Math.round(performance.now() - perfStart)}ms`);
    } catch {
      perfLog(`history:list failed ${Math.round(performance.now() - perfStart)}ms`);
    }
  }

  // 切换/打开项目时同步刷新侧栏历史，并清空恢复请求与选中态
  useEffect(() => {
    setPendingRestore(null);
    setActiveRunId(null);
    void refreshHistory(project?.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path]);

  /** 重建生成页会话：丢弃当前草稿/参数，回到全新空白生成界面（素材生成导航点击时使用） */
  function resetGenerateSession(): void {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setPendingRestore(null);
    setActiveRunId(null);
    setGenerateSessionKey((current) => current + 1);
  }

  function handleNavClick(page: Page): void {
    // 「素材生成」导航 = 开一个全新生成界面（离开历史选中态/清掉当前草稿）
    if (page === "generate") {
      resetGenerateSession();
      setPage("generate");
      return;
    }
    setPage(page);
  }

  function openHistoryEntry(entry: GenerationHistoryEntry): void {
    // 注意：这里刻意不用原生 window.confirm——Electron/Windows 下原生模态对话框返回时会扰动
    // 窗口焦点与输入法(IME)状态，随即开始的整页恢复又伴随大批次重渲染，容易造成"鼠标可点、
    // 所有输入框打字失灵"的假死。提示信息（如入库批次重切会覆盖同名文件）已直接展示在恢复后的
    // 结果区 inlineHint 里，不再用弹窗打断。打开前主动释放焦点，避免触发按钮残留 focus 影响输入。
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setPage("generate");
    setPendingRestore({ entry, seq: Date.now() });
  }

  async function removeHistoryEntry(entry: GenerationHistoryEntry): Promise<void> {
    const bridge = window.topspeedBuilder;
    const targetPath = project?.path;
    if (!bridge || !targetPath || typeof bridge.removeGenerationHistory !== "function") return;
    const hint =
      entry.status === "draft" ? t("history.removeDraftHint") : t("history.removeCommittedHint");
    if (!window.confirm(`${hint}\n${t("history.removeConfirm")}`)) return;
    const result = await bridge.removeGenerationHistory(targetPath, entry.runId);
    if (result.ok) {
      await refreshHistory(targetPath);
      // 若删除的正是生成页当前打开的草稿，其磁盘网格图已随删除清掉，把生成页重置为全新空态
      if (entry.status === "draft" && entry.runId === activeRunId) resetGenerateSession();
    }
  }

  /** 重命名历史记录：素材库与历史共用同一个名字，改名后两处一起刷新 */
  async function renameHistoryEntry(entry: GenerationHistoryEntry, name: string): Promise<void> {
    const bridge = window.topspeedBuilder;
    const targetPath = project?.path;
    if (!bridge || !targetPath || typeof bridge.renameGenerationHistory !== "function") return;
    const result = await bridge.renameGenerationHistory(targetPath, entry.runId, name);
    if (result.ok) {
      await refreshHistory(targetPath);
      await refreshProject(targetPath);
    }
  }

  async function runTask<T>(label: string, task: () => Promise<T>, success?: (result: T) => string): Promise<T | null> {
    setBusy(label);
    setMessage("");
    const perfStart = performance.now();
    try {
      const result = await task();
      const text = success?.(result) ?? t("message.completed");
      setMessage(text);
      // 成功提示自动消失（约 4s），错误提示保留便于阅读
      window.setTimeout(() => {
        setMessage((current) => (current === text ? "" : current));
      }, 4000);
      return result;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      const elapsed = performance.now() - perfStart;
      if (elapsed > 1500) perfLog(`busy "${label}" took ${Math.round(elapsed)}ms`);
      setBusy("");
    }
  }

  return (
    <main className="shell">
      {/* 顶栏：品牌 / 主导航 / 项目打开状态 / 语言切换 / 构建戳 / 运行状态。
          左侧栏只承载历史记录，不再放导航与项目信息 */}
      <header className="appbar">
        <div className="brand">
          <div className="brandMark">
            <Sparkles size={18} />
          </div>
          <div>
            <strong>{t("brand.name")}</strong>
            <span>{t("brand.tagline")}</span>
          </div>
        </div>

        <nav className="nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.page}
                className={page === item.page ? "active" : ""}
                disabled={!item.enabled}
                onClick={() => handleNavClick(item.page)}
                title={item.label}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="appbarRight">
          <div
            className={project ? "projectChip" : "projectChip empty"}
            title={project ? project.path : t("project.dock.hint")}
          >
            <FolderOpen size={15} />
            <span className="projectChipLabel">{t("project.dock.label")}</span>
            <strong>{project?.name ?? t("project.dock.empty")}</strong>
          </div>

          {busy ? (
            <span className="busy">
              <Loader2 size={15} className="spin" />
              {busy}
            </span>
          ) : (
            <span className="ready">
              <Check size={15} />
              {t("topbar.ready")}
            </span>
          )}

          <button
            className="ghostButton appbarLang"
            type="button"
            onClick={() => switchLanguage(i18n.language === "zh" ? "en" : "zh")}
          >
            {t("lang.switch")}
          </button>

          <div className="appbarStamp" title={`${t("buildStamp.tip")} ${__APP_BUILD_TS__}`}>
            rev {__APP_BUILD_TS__}
            {import.meta.env.DEV ? " · dev" : ""}
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <SidebarHistoryRail
          projectPath={project?.path ?? null}
          entries={historyEntries}
          selectedRunId={activeRunId}
          onOpen={openHistoryEntry}
          onRemove={(entry) => void removeHistoryEntry(entry)}
          onRename={renameHistoryEntry}
        />
      </aside>

      <section className="workspace">
        {message && (
          <div className={message.includes("失败") || message.includes("错误") ? "notice error" : "notice"}>
            <span>{message}</span>
            <button type="button" className="noticeClose" title={t("notice.dismiss")} onClick={() => setMessage("")}>
              <X size={14} />
            </button>
          </div>
        )}

        {page === "home" && (
          <HomePage
            settings={settings}
            projects={homeProjects}
            runTask={runTask}
            setProject={setProject}
            setPage={setPage}
            reloadHome={async () => {
              await refreshInitialState();
            }}
          />
        )}
        {project && (
          <div className="pageWrap" hidden={page !== "generate"}>
            {/* 常驻挂载：切换页面不销毁生成页状态；key=项目路径+会话号：
                切项目自动重置；点「素材生成」导航自增会话号 → 全新空白生成界面 */}
            <GeneratePage
              key={`${project.path}::${generateSessionKey}`}
              project={project}
              settings={settings}
              runTask={runTask}
              queuedReference={queuedReference}
              onQueuedReferenceConsumed={() => setQueuedReference(null)}
              onHistoryChanged={() => void refreshHistory(project.path)}
              pendingRestore={pendingRestore}
              onRestoreHandled={() => setPendingRestore(null)}
              onActiveRunChange={setActiveRunId}
              onCommitted={async () => {
                await refreshProject(project.path);
              }}
            />
          </div>
        )}
        {page === "assets" && project && (
          <AssetsPage
            project={project}
            historyEntries={historyEntries}
            exportDirectory={settings.defaultExportDirectory}
            runTask={runTask}
            refreshProject={refreshProject}
            refreshHistory={() => refreshHistory(project.path)}
            onOpenSettings={() => setPage("settings")}
            onOpenHistory={openHistoryEntry}
            onUseAsReference={(asset, filePath) => {
              setQueuedReference({
                path: filePath,
                role: "subject",
                sourceAssetId: asset.id,
                name: asset.name
              });
              setPage("generate");
            }}
          />
        )}
        {page === "settings" && (
          <SettingsPage
            settings={settings}
            runTask={runTask}
            onSaved={(nextSettings) => {
              setSettings(nextSettings);
            }}
          />
        )}
      </section>

      {busy && (
        <div className="busyOverlay" role="status" aria-live="polite">
          <div className="busyCard">
            <Loader2 size={26} className="spin" />
            <strong>{busy}</strong>
            <span>{t("topbar.busyHint")}</span>
          </div>
        </div>
      )}
    </main>
  );
}

function HomePage(props: {
  settings: AppSettings;
  projects: RecentProject[];
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  setProject: (project: Project) => void;
  setPage: (page: Page) => void;
  reloadHome: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const hasRoot = Boolean(props.settings.defaultProjectRoot.trim());
  const canCreate = Boolean(name.trim() && hasRoot);

  // 默认项目目录变化（或进入首页）时重新拉取目录下项目列表
  useEffect(() => {
    void props.reloadHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.settings.defaultProjectRoot]);

  const openProject = async (projectPath: string): Promise<void> => {
    const project = await props.runTask(t("busy.openRecent"), () => unwrap(window.topspeedBuilder.openProjectPath(projectPath)));
    if (project) {
      props.setProject(project);
      props.setPage("generate");
      await props.reloadHome();
    }
  };

  const createProject = async (): Promise<void> => {
    if (!canCreate) return;
    const project = await props.runTask(
      t("busy.createProject"),
      () => unwrap(window.topspeedBuilder.createProject({ name: name.trim() })),
      (created) => `${t("message.created")}: ${created.path}`
    );
    if (project) {
      setName("");
      props.setProject(project);
      props.setPage("generate");
      await props.reloadHome();
    }
  };

  return (
    <div className="pageGrid two">
      <section className="panel">
        <PanelTitle icon={Plus} title={t("home.new.title")} />
        {!hasRoot && (
          <div className="inlineWarning">
            {t("home.new.noRootHint")}
          </div>
        )}
        <form
          className="newProjectForm"
          onSubmit={(event) => {
            event.preventDefault();
            void createProject();
          }}
        >
          <TextInput label={t("field.projectName")} value={name} onChange={setName} />
          <button className="primaryButton" type="submit" disabled={!canCreate}>
            <Plus size={18} />
            {t("home.new.create")}
          </button>
        </form>
      </section>

      <section className="panel">
        <PanelTitle icon={FolderOpen} title={t("home.open.title")} />
        {!hasRoot ? (
          <div className="inlineWarning">
            {t("home.open.noRootHint")}
          </div>
        ) : props.projects.length === 0 ? (
          <EmptyState text={t("home.open.rootEmpty")} />
        ) : (
          <div className="recentList">
            {props.projects.map((item) => (
              <article key={item.path} className="recentItem">
                <div>
                  <strong>{item.name}</strong>
                  <span>{gameTypeLabelT(t, item.gameType)} · {item.style}</span>
                  <small>{item.path}</small>
                </div>
                <div className="rowActions">
                  <button title={t("home.open.open")} onClick={() => void openProject(item.path)}>
                    <Play size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function GeneratePage(props: {
  project: Project;
  settings: AppSettings;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  queuedReference: ReferenceDraft | null;
  onQueuedReferenceConsumed: () => void;
  onCommitted: () => Promise<void>;
  /** 生成或入库成功后通知外层刷新全局历史 */
  onHistoryChanged: () => void;
  /** 侧栏历史时间轴的载入请求：seq 递增保证重复点同一条也能触发；一次性，处理后立即通知外层清空 */
  pendingRestore: { entry: GenerationHistoryEntry; seq: number } | null;
  /** 历史载入请求已被生成页消费（无论是否应用），外层应清空 pendingRestore，避免切项目后残留误回填 */
  onRestoreHandled: () => void;
  /** 生成页当前打开的草稿 runId 变化时上报（null=无草稿），外层据此驱动侧栏历史"选中态" */
  onActiveRunChange: (runId: string | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const defaultPresets = useMemo(() => presetsFor("icon"), []);
  const [assetType, setAssetType] = useState<AssetType>("icon");
  const detailTemplates = useMemo(() => objectDetailTemplates[assetType], [assetType]);
  const [description, setDescription] = useState(defaultPresets.description);
  const [detailPrompt, setDetailPrompt] = useState("");
  const [selectedDetailTemplateIds, setSelectedDetailTemplateIds] = useState<string[]>([]);
  const [referenceImages, setReferenceImages] = useState<ReferenceDraft[]>([]);
  const [referenceStrength, setReferenceStrength] = useState<ReferenceStrength>("medium");
  const [sizePreset, setSizePreset] = useState(defaultPresets.size);
  const [customSizeW, setCustomSizeW] = useState(1024);
  const [customSizeH, setCustomSizeH] = useState(1024);
  const [count, setCount] = useState(defaultPresets.count);
  const [cellNamesText, setCellNamesText] = useState("");
  const [quality, setQuality] = useState<GenerationQuality>(defaultQuality);
  const [transparentBackground, setTransparentBackground] = useState(defaultPresets.transparentBackground);
  const [trimEdges, setTrimEdges] = useState(true);
  const [stylePreset, setStylePreset] = useState(stylePresets[0].value);
  const [customStyle, setCustomStyle] = useState("");

  const [draft, setDraft] = useState<GridDraft | null>(null);
  const [gridDataUrl, setGridDataUrl] = useState("");
  const [freeCutOpen, setFreeCutOpen] = useState(false);
  const [paOpen, setPaOpen] = useState(false);
  const [sliceCols, setSliceCols] = useState(0);
  const [sliceRows, setSliceRows] = useState(0);
  // 内容感知切分（默认开启；仅多格 + 透明背景时生效，检测失败自动退回等分）
  const [autoAlign, setAutoAlign] = useState(true);

  // 生成结果回看：kind=committed 表示刚确认切分入库的产出；kind=restored 表示从历史载入的已入库批次
  const [restoredCommitted, setRestoredCommitted] = useState<{ files: string[]; kind: "committed" | "restored" } | null>(
    null
  );
  // 从历史载入了一条「仅配置」记录（尚未生成网格大图）时置位，提示参数已回填
  const [configLoaded, setConfigLoaded] = useState(false);
  // 「手动保存」锚点：未出图时记住最近一次保存/载入的纯配置 runId，再次保存走“更新”而非重复新建
  const configRunIdRef = useRef<string | null>(null);

  // 美术风格：预设直出，自定义才需填风格描述
  const selectedStyleText =
    stylePreset === styleCustomValue
      ? customStyle.trim()
      : stylePresets.find((preset) => preset.value === stylePreset)?.text ?? "";
  const styleReady = stylePreset !== styleCustomValue || customStyle.trim().length > 0;
  // 「其它」= 单张整图输出（插画/单幅作品），数量锁定 1
  const isSingleShot = assetType === "other";
  // 智能切分在多格下可用：透明图按 alpha、不透明图自动识别均匀底色，均按真实内容边界切分
  const autoAlignSupported = !isSingleShot;
  const autoActive = autoAlignSupported && autoAlign;
  const autoPreviewCells = autoActive && draft?.autoCells && draft.autoCells.length > 0 ? draft.autoCells : null;
  // 画面实际素材数可能与设定值不符（例如设定 16 实为 15，或设定 8 画了 9），提示要如实反映
  const autoExpectedCount = draft?.count ?? 0;
  // > 0 多画了，< 0 少画了
  const autoCountDiff = autoPreviewCells && autoExpectedCount > 0 ? autoPreviewCells.length - autoExpectedCount : 0;
  const styleOptions = useMemo<SelectOption[]>(
    () => [...stylePresetOptions, { value: styleCustomValue, label: "generate.style.custom" }],
    []
  );

  useEffect(() => {
    setDraft(null);
    setGridDataUrl("");
  }, [props.project.path]);

  // 当前打开的草稿变化 → 上报 runId 给外层驱动侧栏历史"选中态"（恢复/新生成/丢弃都会经过这里）
  useEffect(() => {
    props.onActiveRunChange(draft ? draft.runId : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.runId]);

  useEffect(() => {
    const queued = props.queuedReference;
    if (!queued) return;

    setReferenceImages((current) => {
      if (current.some((item) => item.path === queued.path)) {
        return current;
      }
      return [...current, queued].slice(0, 4);
    });

    if (window.topspeedBuilder) {
      window.topspeedBuilder.readImageDataUrl(props.project.path, queued.path).then((result) => {
        if (!result.ok || !result.data) return;
        setReferenceImages((current) =>
          current.map((item) => (item.path === queued.path ? { ...item, dataUrl: result.data } : item))
        );
      });
    }
    props.onQueuedReferenceConsumed();
  }, [props.queuedReference, props.project.path]);

  useEffect(() => {
    if (!draft) {
      setGridDataUrl("");
      return;
    }
    setSliceCols(draft.cols);
    setSliceRows(draft.rows);
    let alive = true;
    const perfStart = performance.now();
    window.topspeedBuilder.readImageDataUrl(props.project.path, draft.gridImagePath).then((result) => {
      const ms = Math.round(performance.now() - perfStart);
      if (ms > 250) perfLog(`grid dataUrl ${draft.gridImagePath.split("/").pop()} ${ms}ms`);
      if (alive && result.ok && result.data) setGridDataUrl(result.data);
    });
    return () => {
      alive = false;
    };
  }, [draft, props.project.path]);

  function handleAssetTypeChange(newType: AssetType): void {
    setAssetType(newType);
    const preset = presetsFor(newType);
    setDescription(preset.description);
    setDetailPrompt("");
    setSelectedDetailTemplateIds([]);
    setSizePreset(preset.size);
    const presetMatch = preset.size.match(/^(\d+)x(\d+)$/);
    if (presetMatch) {
      setCustomSizeW(Number(presetMatch[1]));
      setCustomSizeH(Number(presetMatch[2]));
    }
    setCount(preset.count);
    setTransparentBackground(preset.transparentBackground);
  }

  function composeDetailPrompt(ids: string[]): string {
    return ids
      .map((id) => detailTemplates.find((template) => template.id === id)?.prompt)
      .filter(Boolean)
      .join("\n");
  }

  function handleDetailTemplateToggle(template: DetailTemplate): void {
    const nextIds = selectedDetailTemplateIds.includes(template.id)
      ? selectedDetailTemplateIds.filter((id) => id !== template.id)
      : [...selectedDetailTemplateIds, template.id];

    setSelectedDetailTemplateIds(nextIds);
    setDetailPrompt(composeDetailPrompt(nextIds));
  }

  function handleDetailPromptChange(value: string): void {
    setDetailPrompt(value);
    setSelectedDetailTemplateIds([]);
  }

  function clearDetailPrompt(): void {
    setDetailPrompt("");
    setSelectedDetailTemplateIds([]);
  }

  function buildInput(): GenerateAssetInput {
    return {
      projectPath: props.project.path,
      assetType,
      name: t(assetTypeLabel(assetType)),
      description,
      detailPrompt,
      referenceImages: referenceImages.map(toReferenceInput),
      referenceStrength,
      size: sizePreset === sizeCustomValue ? `${clampBoxSize(customSizeW)}x${clampBoxSize(customSizeH)}` : sizePreset,
      count: isSingleShot ? 1 : count,
      cellNames: isSingleShot ? [] : splitLines(cellNamesText),
      quality,
      style: selectedStyleText,
      transparentBackground,
      trimEdges
    };
  }

  async function generateDraft(): Promise<void> {
    if (!styleReady) return;
    setDraft(null);
    setGridDataUrl("");
    setRestoredCommitted(null);
    setConfigLoaded(false);
    const nextDraft = await props.runTask(
      t("busy.generateGrid"),
      () => unwrap(window.topspeedBuilder.generateGrid(buildInput()))
    );
    if (nextDraft) {
      setDraft(nextDraft);
      props.onHistoryChanged();
    }
  }

  /**
   * 「手动保存」：把当前表单参数快照写入历史记录。
   * 有网格草稿 → 更新该批次（draft/committed）的参数快照；
   * 无草稿（纯配置）→ 有记忆锚点则原地更新，没有则新建一条「仅配置」记录并记住 runId。
   */
  async function saveSnapshot(): Promise<void> {
    const targetRunId = draft?.runId ?? configRunIdRef.current;
    const result = await props.runTask(
      t("busy.saveSnapshot"),
      () => unwrap(window.topspeedBuilder.saveHistorySnapshot(props.project.path, targetRunId, buildInput())),
      () => t("generate.saveDone")
    );
    if (result) {
      if (!draft) configRunIdRef.current = result.runId;
      props.onHistoryChanged();
    }
  }

  async function commitDraft(): Promise<void> {
    if (!draft) return;
    const options: GridSliceOptions = {
      cols: sliceCols,
      rows: sliceRows,
      // 偏移/安全边距参数已从界面移除；等分兜底沿用“零偏移 + 非单张缩边 4%”的旧默认，保证切出尺寸与过往一致
      shiftX: 0,
      shiftY: 0,
      shrinkPercent: draft.count === 1 ? 0 : 8,
      useAuto: autoActive
    };
    const result = await props.runTask(
      t("busy.commitSlice"),
      () => unwrap(window.topspeedBuilder.commitSlice(buildInput(), draft, options)),
      (committed) => t("generate.commitDone", { count: committed.files.length })
    );
    if (result) {
      // 保持切分时的状态：草稿、网格图、切分参数全部保留，仅把该批次的产出文件列入结果区回看
      setRestoredCommitted({ kind: "committed", files: result.files });
      await props.onCommitted();
      props.onHistoryChanged();
    }
  }

  // ---- 历史载入（数据由 App 层统一持有，经 pendingRestore 下发） ----
  function stylePresetFromText(styleText: string): void {
    if (!styleText || !styleText.trim()) {
      setStylePreset(stylePresets[0].value);
      return;
    }
    const preset = stylePresets.find((item) => item.text === styleText);
    if (preset) {
      setStylePreset(preset.value);
      return;
    }
    setStylePreset(styleCustomValue);
    setCustomStyle(styleText);
  }

  function sizePresetFromText(sizeText: string): void {
    if (sizeOptions.some((option) => selectOptionValue(option) === sizeText)) {
      setSizePreset(sizeText);
      return;
    }
    setSizePreset(sizeCustomValue);
    const parsed = sizeText ? sizeText.match(/(\d+)\s*x\s*(\d+)/i) : null;
    if (parsed) {
      setCustomSizeW(clampBoxSize(Number(parsed[1])));
      setCustomSizeH(clampBoxSize(Number(parsed[2])));
    }
  }

  /** 把历史草稿的完整参数回填到表单，并载入网格大图继续切分入库 */
  function restoreFromHistory(entry: GenerationHistoryEntry): void {
    const input = entry.input;
    handleAssetTypeChange(input.assetType ?? "icon");
    setDescription(input.description ?? "");
    setDetailPrompt(input.detailPrompt ?? "");
    setSelectedDetailTemplateIds([]);
    sizePresetFromText(input.size || "1024x1024");
    setCount(input.assetType === "other" ? 1 : nearestCountPreset(input.count || 1));
    setCellNamesText((input.cellNames || []).join("\n"));
    setQuality(input.quality || defaultQuality);
    setTransparentBackground(Boolean(input.transparentBackground));
    setTrimEdges(Boolean(input.trimEdges));
    setReferenceStrength(input.referenceStrength || "medium");
    const refs = (input.referenceImages || []).slice(0, 4);
    setReferenceImages(
      refs.map((item) => ({ path: item.path, role: item.role, sourceAssetId: item.sourceAssetId, name: item.name }))
    );
    refs.forEach((item) => {
      window.topspeedBuilder?.readImageDataUrl(props.project.path, item.path).then((result) => {
        if (!result.ok || !result.data) return;
        setReferenceImages((current) =>
          current.map((ref) => (ref.path === item.path ? { ...ref, dataUrl: result.data as string } : ref))
        );
      });
    });
    stylePresetFromText(input.style || "");
    const hasGridImage = Boolean(entry.grid.gridImagePath);
    if (hasGridImage) {
      // 载入网格草稿（切片参数由 draft 回填，可继续微调后入库）
      const restoredAutoCells =
        Array.isArray(entry.grid.autoCells) && entry.grid.autoCells.length > 0 ? entry.grid.autoCells : undefined;
      // 该批次入库时若明确走了等分（useAuto=false），恢复时关闭智能切分，避免提交时行为与当时不一致
      setAutoAlign(entry.slice?.useAuto === false ? false : true);
      setConfigLoaded(false);
      configRunIdRef.current = null;
      setDraft({
        runId: entry.runId,
        gridImagePath: entry.grid.gridImagePath,
        width: entry.grid.width,
        height: entry.grid.height,
        cols: entry.grid.cols,
        rows: entry.grid.rows,
        count: entry.grid.count,
        prompt: entry.prompt,
        logs: entry.logs || [],
        autoCells: restoredAutoCells
      });
      // 载入历史后要用当前算法对这张已有大图重新检测一次：历史里存的是入库当时的结果，
      // 算法升级后可能已不准确；而切分时 commitSlice 一定会重算，预览必须与它一致，
      // 否则会出现"绿框是旧的、切出来是新的"。无需重新生成大图。
      //
      // 但这件事是整幅图（1024–2048px）的纯 JS 像素运算，主进程单次要跑一两秒；
      // 而「点开一条历史」紧接着的动作往往就是改参数、打字，所以这里刻意延后 600ms 再发起：
      // 先让参数回填与首屏渲染落地，界面暂用历史里存的结果（通常已足够准）。
      // 主进程侧的重检测循环也做了时间片让出（见 imageService.breathe），不会再一口气堵死输入。
      if (redetectTimerRef.current !== null) window.clearTimeout(redetectTimerRef.current);
      redetectTimerRef.current = window.setTimeout(() => {
        redetectTimerRef.current = null;
        void window.topspeedBuilder
          .detectAutoCells(props.project.path, entry.grid.gridImagePath, entry.grid.count)
          .then((result) => {
            if (!result.ok) return;
            const cells = result.data && result.data.length > 0 ? result.data : undefined;
            setDraft((current) => (current && current.runId === entry.runId ? { ...current, autoCells: cells } : current));
          })
          .catch(() => undefined);
      }, 600);
    } else {
      // 「仅配置」快照：只回填参数，锚定该记录（再点保存 = 原地更新），提示用户可继续生成
      setDraft(null);
      setGridDataUrl("");
      setRestoredCommitted(null);
      setAutoAlign(true);
      configRunIdRef.current = entry.runId;
      setConfigLoaded(true);
    }
  }

  // 侧栏点选历史条目后，App 下发载入请求：seq 变化即触发一次回填。
  // 该请求是一次性的：无论是否应用，处理完立即通知外层清空，杜绝"先加载历史再切项目"时残留请求
  // 在下一个项目里被当成当前项目的历史回填（跨项目串设置/串参数）。
  const handledRestoreSeq = useRef(0);
  /** 历史恢复后的延迟重检测定时器句柄（见 restoreFromHistory 里的说明） */
  const redetectTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (redetectTimerRef.current !== null) window.clearTimeout(redetectTimerRef.current);
    };
  }, []);
  useEffect(() => {
    const request = props.pendingRestore;
    if (!request || request.seq === handledRestoreSeq.current) return;
    handledRestoreSeq.current = request.seq;
    props.onRestoreHandled();
    const entry = request.entry;
    // 防御：请求所属项目与当前项目不一致（切项目瞬间的历史残留）时不应用
    if (entry.input?.projectPath && entry.input.projectPath !== props.project.path) return;
    restoreFromHistory(entry);
    setRestoredCommitted(
      entry.status === "committed" ? { files: entry.files || [], kind: "restored" } : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingRestore]);

  // 等分参考线（仅非智能切分时显示）：整幅按 sliceCols×sliceRows 均匀分格
  const equalLines = draft
    ? {
        vertical: Array.from({ length: Math.max(1, sliceCols) - 1 }, (_, i) => (i + 1) / sliceCols),
        horizontal: Array.from({ length: Math.max(1, sliceRows) - 1 }, (_, i) => (i + 1) / sliceRows)
      }
    : null;
  const draftWidth = draft?.width ?? 0;
  const draftHeight = draft?.height ?? 0;

  return (
    <div className="pageGrid generation">
      <section className="panel">
        <PanelTitle icon={Wand2} title={t("generate.title")} />
        <div className="topDeck">
          <SelectInput
            label={t("generate.assetType")}
            value={assetType}
            options={assetTypes}
            onChange={(next) => handleAssetTypeChange(next as AssetType)}
          />
          <SelectInput
            label={t("generate.style")}
            value={stylePreset}
            options={styleOptions}
            onChange={(next) => setStylePreset(String(next))}
          />
          <DeckToggle label={t("generate.transparent")} value={transparentBackground} onChange={setTransparentBackground} />
          <DeckToggle label={t("generate.trimEdges")} value={trimEdges} onChange={setTrimEdges} />
        </div>
        {stylePreset === styleCustomValue && (
          <>
            <BufferedTextArea label={t("generate.styleCustom")} value={customStyle} onChange={setCustomStyle} />
            {!styleReady && <div className="inlineWarning">{t("generate.styleCustomEmpty")}</div>}
          </>
        )}

        {/* 尺寸整行独占：完整展示预设用途说明；数量与生成质量用紧凑小控件，弱化视觉权重 */}
        <div className="formGrid">
          <SelectInput
            className="full sizeSelect"
            label={t("generate.size")}
            value={sizePreset}
            options={sizeSelectOptions}
            onChange={(next) => {
              const value = String(next);
              setSizePreset(value);
              // 记住预设数值：切到「自定义」时作为宽高初值
              if (value !== sizeCustomValue) {
                const match = value.match(/^(\d+)x(\d+)$/);
                if (match) {
                  setCustomSizeW(Number(match[1]));
                  setCustomSizeH(Number(match[2]));
                }
              }
            }}
          />
        </div>
        {sizePreset === sizeCustomValue && (
          <div className="formGrid">
            <NumberInput label={t("generate.sizeWidth")} value={customSizeW} min={256} max={2048} onChange={setCustomSizeW} />
            <NumberInput label={t("generate.sizeHeight")} value={customSizeH} min={256} max={2048} onChange={setCustomSizeH} />
          </div>
        )}
        <div className="formGrid gapSm">
          {isSingleShot ? (
            <label className="field slim">
              <span>{t("generate.count")}</span>
              <select value={1} disabled aria-label={t("generate.count")}>
                <option value={1}>1</option>
              </select>
            </label>
          ) : (
            <SelectInput
              className="slim"
              label={t("generate.count")}
              value={String(count)}
              options={countOptions}
              onChange={(next) => setCount(Number(next))}
            />
          )}
          <SelectInput
            className="slim"
            label={t("generate.quality")}
            value={quality}
            options={qualityOptions}
            onChange={(next) => setQuality(next as GenerationQuality)}
          />
        </div>
        {isSingleShot && <div className="inlineNote compactNote">{t("generate.otherHint")}</div>}
        <BufferedTextArea label={t("generate.desc")} value={description} onChange={setDescription} />

        <ReferenceImagePanel
          project={props.project}
          value={referenceImages}
          referenceStrength={referenceStrength}
          runTask={props.runTask}
          onChange={setReferenceImages}
          onReferenceStrengthChange={setReferenceStrength}
        />
        <div className="detailTemplateBlock">
          <div className="detailTemplateHeader">
            <div>
              <strong>{t("generate.detailTemplate")}</strong>
              <span>{t("generate.detailTemplateHint")}</span>
            </div>
            {detailPrompt && (
              <button className="miniClearButton" type="button" onClick={clearDetailPrompt}>
                {t("generate.clear")}
              </button>
            )}
          </div>
          <div className="detailTemplateGrid">
            {detailTemplates.map((template) => {
              const selected = selectedDetailTemplateIds.includes(template.id);
              return (
                <button
                  key={template.id}
                  type="button"
                  aria-pressed={selected}
                  className={selected ? "detailTemplateCard selected" : "detailTemplateCard"}
                  // 卡片只展示标题，具体内容挂到悬停提示里，需要时看得到、平时不占高度
                  title={template.prompt}
                  onClick={() => handleDetailTemplateToggle(template)}
                >
                  <strong>{template.name}</strong>
                </button>
              );
            })}
          </div>
        </div>
        <BufferedTextArea label={t("generate.detailPrompt")} value={detailPrompt} onChange={handleDetailPromptChange} />
        {!isSingleShot && <BufferedTextArea label={t("generate.cellNames")} value={cellNamesText} onChange={setCellNamesText} />}
      </section>

      <section className="panel resultPanel">
        <div className="panelTitleRow">
          <PanelTitle icon={Archive} title={t("generate.draft")} />
          <button className="ghostButton panelTitleAction" onClick={() => void generateDraft()}>
            <RefreshCw size={16} />
            {t("generate.regenGrid")}
          </button>
        </div>
        {draft ? (
          <>
            {/* 网格大图预览：置顶，先看结果再操作 */}
            {gridDataUrl && (
              <div className="gridStage">
                <img src={gridDataUrl} alt={t("generate.draft")} />
                {autoPreviewCells ? (
                  autoPreviewCells.map((cell, cellIndex) => (
                    <span
                      key={`cell-${cellIndex}`}
                      className="autoBox"
                      style={{
                        left: `${(cell.left / draftWidth) * 100}%`,
                        top: `${(cell.top / draftHeight) * 100}%`,
                        width: `${(cell.width / draftWidth) * 100}%`,
                        height: `${(cell.height / draftHeight) * 100}%`
                      }}
                    />
                  ))
                ) : !autoPreviewCells && equalLines ? (
                  <>
                    {equalLines.vertical.map((position) => (
                      <span key={`v-${position}`} className="gridLine vertical" style={{ left: `${position * 100}%` }} />
                    ))}
                    {equalLines.horizontal.map((position) => (
                      <span key={`h-${position}`} className="gridLine horizontal" style={{ top: `${position * 100}%` }} />
                    ))}
                  </>
                ) : null}
              </div>
            )}

            {/* 操作行：确认切分入库 / 手动保存 / 在文件夹中显示 */}
            <div className="assetActions sliceActions">
              <button className="primaryButton" onClick={() => void commitDraft()}>
                <Check size={18} />
                {t("generate.commit")}
              </button>
              <button className="ghostButton" type="button" title={t("generate.saveHistory")} onClick={() => void saveSnapshot()}>
                <Save size={16} />
                {t("generate.saveDraft")}
              </button>
              {restoredCommitted && restoredCommitted.files.length > 0 && (
                <button
                  className="ghostButton"
                  type="button"
                  onClick={() =>
                    void props.runTask(t("busy.locateFile"), () =>
                      unwrap(
                        window.topspeedBuilder.showProjectItemInFolder(
                          props.project.path,
                          restoredCommitted.files[0]
                        )
                      )
                    )
                  }
                >
                  <FolderOpen size={16} />
                  {t("history.locate")}
                </button>
              )}
            </div>

            {/* 出图后切分参数：智能对齐开关 + 等分兜底列/行，紧凑单行，不再整行撑满 */}
            {autoAlignSupported && (
              <div className="slicePanel">
                <div className="sliceToolsRow">
                  <DeckToggle
                    className="autoToggle"
                    label={t("generate.autoAlign")}
                    value={autoAlign}
                    onChange={setAutoAlign}
                  />
                  {autoAlign && (
                    <button
                      type="button"
                      className="ghostButton freeCutEntry"
                      disabled={!draft}
                      title={draft ? t("freecut.title") : ""}
                      onClick={() => draft && setFreeCutOpen(true)}
                    >
                      <Scissors size={14} />
                      {t("freecut.title")}
                    </button>
                  )}
                  {!autoPreviewCells && (
                    <>
                      <SelectInput
                        className="axisSelect"
                        label={t("generate.sliceCols")}
                        value={String(sliceCols)}
                        options={sliceAxisOptions}
                        onChange={(next) => setSliceCols(Number(next))}
                      />
                      <SelectInput
                        className="axisSelect"
                        label={t("generate.sliceRows")}
                        value={String(sliceRows)}
                        options={sliceAxisOptions}
                        onChange={(next) => setSliceRows(Number(next))}
                      />
                    </>
                  )}
                </div>
                {autoPreviewCells ? (
                  <div className="inlineNote compactNote">
                    {autoCountDiff < 0
                      ? t("generate.autoDetectedPartial", {
                          count: autoPreviewCells.length,
                          expected: autoExpectedCount
                        })
                      : autoCountDiff > 0
                        ? t("generate.autoDetectedExtra", {
                            count: autoPreviewCells.length,
                            expected: autoExpectedCount
                          })
                        : t("generate.autoDetected", { count: autoPreviewCells.length })}
                  </div>
                ) : autoActive ? (
                  <div className="inlineNote compactNote">{t("generate.autoFallback")}</div>
                ) : (
                  <div className="inlineNote compactNote">{t("generate.sliceHint")}</div>
                )}
              </div>
            )}

            {freeCutOpen && draft && (
              <FreeCutModal
                projectPath={props.project.path}
                gridImagePath={draft.gridImagePath}
                runId={draft.runId}
                count={draft.count}
                input={buildInput()}
                gridDataUrl={gridDataUrl}
                onClose={() => setFreeCutOpen(false)}
                onExported={(result) => {
                  setRestoredCommitted({ kind: "committed", files: result.files });
                  void props.onCommitted();
                  props.onHistoryChanged();
                }}
              />
            )}
          </>
        ) : (
          <>
            <EmptyState text={t("generate.draftEmpty")} />
            {configLoaded && <div className="inlineNote compactNote">{t("generate.configLoadedHint")}</div>}
            <div className="assetActions">
              <button className="primaryButton" disabled={!styleReady} onClick={() => void generateDraft()}>
                <Sparkles size={18} />
                {t("generate.genGrid")}
              </button>
              <button className="ghostButton" type="button" title={t("generate.saveHistory")} onClick={() => void saveSnapshot()}>
                <Save size={16} />
                {t("generate.saveConfig")}
              </button>
            </div>
          </>
        )}

        {/* 提示词助手：悬浮气泡 + 二级弹窗（不再内嵌在素材生成面板里） */}
        <button
          type="button"
          className="paBubble"
          title={t("generate.paBubble")}
          aria-label={t("generate.paBubble")}
          onClick={() => setPaOpen(true)}
        >
          <Sparkles size={20} />
        </button>
        {paOpen && (
          <PromptAssistantDialog
            assetType={assetType}
            assetTypeLabelText={t(assetTypeLabel(assetType))}
            count={isSingleShot ? 1 : count}
            currentDescription={description}
            currentStyle={selectedStyleText}
            onClose={() => setPaOpen(false)}
            onApply={(r, fields) => {
              if (fields.description) setDescription(r.description);
              if (fields.detailPrompt) setDetailPrompt(r.detailPrompt);
              if (fields.cellNames) setCellNamesText(r.cellNames.join("\n"));
              if (fields.style) {
                // 勾选美术风格 = 生成自定义风格描述：写入自定义风格框并切到「自定义风格」
                setCustomStyle(r.style);
                setStylePreset(styleCustomValue);
              }
              setPaOpen(false);
            }}
          />
        )}
      </section>
    </div>
  );
}

// 缩略图懒加载：module 级缓存（上限 160 张，超出丢最旧），仅可视区附近才请求，避免一次拉几十张原图
const railThumbCache = new Map<string, string>();
const railThumbPending = new Set<string>();

// 缩略图请求节流：历史一载入就同时出现几十个可视缩略图，冷缓存时每条都需在主进程解码整张网格大图。
// 若立即全部发 IPC，主进程/渲染进程会出现数秒尖峰，Windows 上输入法打字会随之卡顿/掉字。
// 因此：并发上限压低 + 请求放在空闲回调执行 + 历史载入后延迟 1.2s 再开始取图，把交互让给用户。
const RAIL_THUMB_MAX_CONCURRENT = 2;
const railThumbQueue: Array<() => Promise<void>> = [];
let railThumbRunning = 0;
// 用户活跃截止时间：一旦用户在打字或点按，暂停取图队列（性能上优先保证输入跟手）
let railThumbPauseUntil = 0;
function markRailThumbUserActive(): void {
  railThumbPauseUntil = performance.now() + 900;
}
if (typeof document !== "undefined" && typeof window !== "undefined") {
  document.addEventListener("keydown", markRailThumbUserActive, { capture: true, passive: true });
  document.addEventListener("pointerdown", markRailThumbUserActive, { capture: true, passive: true });
}

function enqueueRailThumb(job: () => Promise<void>): void {
  railThumbQueue.push(job);
  pumpRailThumbQueue();
}

function pumpRailThumbQueue(): void {
  if (railThumbRunning >= RAIL_THUMB_MAX_CONCURRENT) return;
  // 用户在打字/操作期间不取图：延后重试，绝不抢占输入
  const remaining = railThumbPauseUntil - performance.now();
  if (remaining > 0) {
    window.setTimeout(() => {
      if (railThumbQueue.length > 0) pumpRailThumbQueue();
    }, Math.min(remaining, 300));
    return;
  }
  while (railThumbRunning < RAIL_THUMB_MAX_CONCURRENT && railThumbQueue.length > 0) {
    const job = railThumbQueue.shift() as () => Promise<void>;
    railThumbRunning += 1;
    Promise.resolve()
      .then(job)
      .finally(() => {
        railThumbRunning -= 1;
        pumpRailThumbQueue();
      });
  }
}

/** 空闲时再执行：浏览器空闲回调不可用时退回 setTimeout，绝不抢占输入/交互 */
function runWhenIdle(task: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => task(), { timeout: 600 });
  } else {
    window.setTimeout(task, 120);
  }
}

/** 读取一张缩略图 dataUrl；命中内存缓存立即返回，否则入队按并发上限取图 */
function loadRailThumbData(projectPath: string, runId: string): Promise<string | null> {
  const cacheKey = `${projectPath}::${runId}`;
  const hit = railThumbCache.get(cacheKey);
  if (hit) return Promise.resolve(hit);
  if (railThumbPending.has(cacheKey)) return Promise.resolve(null);
  return new Promise((resolve) => {
    enqueueRailThumb(
      () =>
        new Promise<void>((done) => {
          const cached = railThumbCache.get(cacheKey);
          if (cached) {
            resolve(cached);
            done();
            return;
          }
          if (railThumbPending.has(cacheKey)) {
            resolve(null);
            done();
            return;
          }
          railThumbPending.add(cacheKey);
          const bridge = window.topspeedBuilder;
          if (!bridge || typeof bridge.readImageThumbnail !== "function") {
            railThumbPending.delete(cacheKey);
            resolve(null);
            done();
            return;
          }
          const perfStart = performance.now();
          bridge
            .readImageThumbnail(projectPath, runId)
            .then((result) => {
              const ms = Math.round(performance.now() - perfStart);
              if (ms > 300) perfLog(`thumb ${runId.slice(0, 8)} ${ms}ms`);
              if (result.ok && result.data) {
                railThumbCache.set(cacheKey, result.data);
                while (railThumbCache.size > 160) {
                  const firstKey = railThumbCache.keys().next().value;
                  if (firstKey !== undefined) railThumbCache.delete(firstKey);
                }
                resolve(result.data);
              } else {
                resolve(null);
              }
            })
            .catch(() => resolve(null))
            .finally(() => {
              railThumbPending.delete(cacheKey);
              done();
            });
        })
    );
  });
}

// 侧栏历史时间轴：只渲染可视附近的一批，滚近底部再补——避免一次挂载数百条导致界面卡顿
const RAIL_PAGE = 18;

function SidebarHistoryRail(props: {
  projectPath: string | null;
  entries: GenerationHistoryEntry[];
  selectedRunId: string | null;
  onOpen: (entry: GenerationHistoryEntry) => void;
  onRemove: (entry: GenerationHistoryEntry) => void;
  onRename: (entry: GenerationHistoryEntry, name: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const [visibleCount, setVisibleCount] = useState(RAIL_PAGE);
  const [renamingRunId, setRenamingRunId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // 历史载入后先让出 1.2s 给界面交互（用户此刻往往正要输入），随后才开始懒加载缩略图
  const [thumbsReady, setThumbsReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const projectPath = props.projectPath;

  function startRename(entry: GenerationHistoryEntry): void {
    setRenameDraft(entry.name || entry.input.name || "");
    setRenamingRunId(entry.runId);
  }

  async function submitRename(entry: GenerationHistoryEntry): Promise<void> {
    const next = renameDraft.trim();
    setRenamingRunId(null);
    if (!next || next === (entry.name || entry.input.name || "")) return;
    await props.onRename(entry, next);
  }

  // 项目切换或历史条数变化时回到只渲染开头一批，并重新进入“缩略图冷却期”
  useEffect(() => {
    setVisibleCount(RAIL_PAGE);
    setThumbsReady(false);
    const timer = window.setTimeout(() => setThumbsReady(true), 1200);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    return () => window.clearTimeout(timer);
  }, [projectPath, props.entries.length]);

  const shown = props.entries.slice(0, Math.max(RAIL_PAGE, visibleCount));

  return (
    <div className="historyRail">
      <div className="historyRailHead">
        <History size={13} />
        <span>{t("history.title")}</span>
        {props.projectPath && props.entries.length > 0 ? <small>{props.entries.length}</small> : null}
      </div>
      <div
        className="historyRailList"
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (node.scrollHeight - node.scrollTop - node.clientHeight < 240) {
            setVisibleCount((current) => Math.min(current + RAIL_PAGE, props.entries.length));
          }
        }}
      >
        {!projectPath ? (
          <p className="historyRailEmpty">{t("history.railNoProject")}</p>
        ) : props.entries.length === 0 ? (
          <p className="historyRailEmpty">{t("history.empty")}</p>
        ) : (
          shown.map((entry) => {
            const selected = entry.runId === props.selectedRunId;
            return (
              <div key={entry.runId} className={selected ? "historyRailItem selected" : "historyRailItem"}>
                {renamingRunId === entry.runId ? (
                  <div className="historyRailHit renaming">
                    <RailThumb
                      projectPath={projectPath}
                      runId={entry.runId}
                      enabled={thumbsReady}
                      hasImage={Boolean(entry.grid && entry.grid.gridImagePath)}
                    />
                    <span className="historyRailMeta">
                      <span className="historyRailMetaLine">
                        <i className={`railStatus ${entry.status === "committed" ? "committed" : "draft"}`} />
                        <em>{entry.status === "committed" ? t("history.statusCommitted") : t("history.statusDraft")}</em>
                        <small>{entry.grid.count} {t("history.unit")}</small>
                      </span>
                      <input
                        className="historyRailRenameInput"
                        autoFocus
                        value={renameDraft}
                        maxLength={80}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void submitRename(entry);
                          if (event.key === "Escape") setRenamingRunId(null);
                        }}
                      />
                      <small>{formatTimestamp(entry.createdAt)}</small>
                    </span>
                  </div>
                ) : (
                  <button
                    className="historyRailHit"
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => props.onOpen(entry)}
                  >
                    <RailThumb
                      projectPath={projectPath}
                      runId={entry.runId}
                      enabled={thumbsReady}
                      hasImage={Boolean(entry.grid && entry.grid.gridImagePath)}
                    />
                    <span className="historyRailMeta">
                      <span className="historyRailMetaLine">
                        <i className={`railStatus ${entry.status === "committed" ? "committed" : "draft"}`} />
                        <em>{entry.status === "committed" ? t("history.statusCommitted") : t("history.statusDraft")}</em>
                        <small>{entry.grid.count} {t("history.unit")}</small>
                      </span>
                      <strong>{entry.name || entry.input.name || t(`assetType.${entry.input.assetType}`)}</strong>
                      <small>{formatTimestamp(entry.createdAt)}</small>
                    </span>
                  </button>
                )}
                {renamingRunId === entry.runId ? (
                  <>
                    <button
                      className="historyRailDelete confirm"
                      type="button"
                      title={t("history.renameSave")}
                      onClick={() => void submitRename(entry)}
                    >
                      <Check size={13} />
                    </button>
                    <button
                      className="historyRailDelete"
                      type="button"
                      title={t("history.renameCancel")}
                      onClick={() => setRenamingRunId(null)}
                    >
                      <X size={13} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="historyRailDelete rename"
                      type="button"
                      title={t("history.rename")}
                      onClick={() => startRename(entry)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="historyRailDelete"
                      type="button"
                      title={t("history.remove")}
                      onClick={() => props.onRemove(entry)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function RailThumb(props: {
  projectPath: string;
  runId: string;
  enabled: boolean;
  /** false = 该记录只有配置快照、没有网格大图（不请求缩略图，直接显示占位图标） */
  hasImage?: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const cacheKey = `${props.projectPath}::${props.runId}`;
  const hasImage = props.hasImage !== false;
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const mountedRef = useRef(true);
  const [src, setSrc] = useState(() => railThumbCache.get(cacheKey) ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // enabled=false 时（历史刚载入的冷却期）什么都不做，把 CPU/主进程让给交互；无大图的配置快照也不取图
  useEffect(() => {
    if (!props.enabled || !hasImage || src) return;
    const node = boxRef.current;
    if (!node) return;
    const loadNow = (): void => {
      runWhenIdle(() => {
        if (!mountedRef.current) return;
        void loadRailThumbData(props.projectPath, props.runId).then((data) => {
          if (!mountedRef.current) return;
          if (data) setSrc(data);
          else setFailed(true);
        });
      });
    };
    if (typeof IntersectionObserver === "undefined") {
      loadNow();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((item) => item.isIntersecting)) {
          observer.disconnect();
          loadNow();
        }
      },
      { rootMargin: "120px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, src, props.enabled, hasImage]);

  return (
    <span className="historyRailThumb" ref={boxRef}>
      {src ? (
        <img src={src} alt="" loading="lazy" />
      ) : !hasImage ? (
        <span className="historyRailThumbPh" title={t("history.configOnly")}>
          <FileText size={14} />
        </span>
      ) : (
        <span className="historyRailThumbPh" title={t("history.loading")}>
          {failed ? <Trash2 size={13} /> : <Image size={14} />}
        </span>
      )}
    </span>
  );
}

/**
 * 通用图片放大预览：恒定在窗口正中，点图片以外的任何区域或按 Esc 关闭。参考图与素材库共用。
 *
 * 必须用 portal 挂到 document.body：卡片有自己的 `transform`（hover 位移），而 transform
 * 会给后代 `position: fixed` 生成新的包含块 —— 灯箱若留在卡片内部，就会锚定到卡片上；
 * 鼠标一动 hover 状态反复切换，灯箱就在「卡片上」和「窗口中央」之间来回跳。挂到 body 后
 * 与卡片、overflow、transform 全部解耦，位置唯一且可控。
 */
function ImageLightbox(props: {
  src: string;
  name: string;
  meta?: string;
  onClose: () => void;
}): JSX.Element {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 打开期间锁住底层滚动，滚轮不会把背后的列表也滚走
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return createPortal(
    // 点击遮罩关闭；点图片本身不关闭（stopPropagation 只加在 img 上）
    <div className="imageLightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="imageLightboxInner">
        <img src={props.src} alt={props.name} draggable={false} onClick={(event) => event.stopPropagation()} />
        <div className="imageLightboxCap">
          <strong>{props.name}</strong>
          {props.meta && <small>{props.meta}</small>}
        </div>
      </div>
    </div>,
    document.body
  );
}

function ReferenceImagePanel(props: {
  project: Project;
  value: ReferenceDraft[];
  referenceStrength: ReferenceStrength;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  onChange: (value: ReferenceDraft[]) => void;
  onReferenceStrengthChange: (value: ReferenceStrength) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ReferenceDraft | null>(null);

  const fileNameOf = (image: ReferenceDraft): string =>
    image.name ?? image.path.split(/[\\/]/).pop() ?? image.path;

  async function importReferences(): Promise<void> {
    const imported = await props.runTask(
      t("busy.importRef"),
      () => unwrap(window.topspeedBuilder.chooseReferenceImages(props.project.path)),
      (result) => t("message.importedRef", { count: result.length })
    );
    if (!imported) return;

    const merged = [...props.value];
    for (const image of imported) {
      if (merged.length >= 4) break;
      if (!merged.some((item) => item.path === image.path)) {
        merged.push(image);
      }
    }
    props.onChange(merged);
  }

  function updateRole(pathValue: string, role: ReferenceImageRole): void {
    props.onChange(props.value.map((image) => (image.path === pathValue ? { ...image, role } : image)));
  }

  const previewMeta = preview
    ? [
        preview.width && preview.height ? `${preview.width} × ${preview.height}` : "",
        preview.bytes ? `${Math.max(1, Math.round(preview.bytes / 1024))} KB` : ""
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="referencePanel">
      <div className="referenceHeader">
        <div className="referenceTitleRow">
          <strong>{t("generate.refImages")}</strong>
          <span className="referenceCount">{props.value.length}/4</span>
        </div>
        <div className="referenceActions">
          <button className="ghostButton" type="button" onClick={importReferences} disabled={props.value.length >= 4}>
            <Plus size={15} />
            {t("generate.importRef")}
          </button>
          <label className="strengthControl">
            <span>{t("generate.refStrength")}</span>
            <select
              value={props.referenceStrength}
              aria-label={t("generate.refStrength")}
              onChange={(event) => props.onReferenceStrengthChange(event.target.value as ReferenceStrength)}
            >
              {referenceStrengthOptions.map((option) => (
                <option key={selectOptionValue(option)} value={selectOptionValue(option)}>
                  {t(selectOptionLabel(option))}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* 未导入任何参考图时只保留上方菜单行，不占用额外高度 */}
      {props.value.length > 0 && (
        <div className="referenceGrid">
          {props.value.map((image) => (
            <article key={image.path} className="referenceCard">
              <div
                className="referenceThumb"
                title={t("generate.refPreviewHint")}
                onDoubleClick={() => {
                  if (image.dataUrl) setPreview(image);
                }}
              >
                {image.dataUrl ? (
                  <img src={image.dataUrl} alt={fileNameOf(image)} draggable={false} />
                ) : (
                  <Image size={22} />
                )}
                <button
                  className="referenceRemove"
                  type="button"
                  title={t("generate.removeRef")}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onChange(props.value.filter((item) => item.path !== image.path));
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <strong className="referenceName" title={fileNameOf(image)}>{fileNameOf(image)}</strong>
              <select
                aria-label={t("generate.refRole", { name: fileNameOf(image) })}
                value={image.role}
                onChange={(event) => updateRole(image.path, event.target.value as ReferenceImageRole)}
              >
                {referenceRoles.map((role) => (
                  <option key={role.value} value={role.value}>
                    {t(role.label)}
                  </option>
                ))}
              </select>
            </article>
          ))}
        </div>
      )}

      {preview && preview.dataUrl && (
        <ImageLightbox
          src={preview.dataUrl}
          name={fileNameOf(preview)}
          meta={previewMeta}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function AssetsPage(props: {
  project: Project;
  historyEntries: GenerationHistoryEntry[];
  exportDirectory: string;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  refreshProject: () => Promise<Project | null>;
  refreshHistory: () => Promise<void>;
  onOpenSettings: () => void;
  onUseAsReference: (asset: Asset, filePath: string) => void;
  onOpenHistory: (entry: GenerationHistoryEntry) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const canCopy = Boolean(props.exportDirectory.trim());

  const items: LibraryItem[] = useMemo(() => {
    const untitled = t("assets.untitled");
    const knownRunIds = new Set(props.historyEntries.map((entry) => entry.runId));
    const fromHistory: LibraryItem[] = props.historyEntries.map((entry) => ({
      runId: entry.runId,
      entry,
      name: entry.name || entry.input?.name || untitled,
      assetType: (entry.input?.assetType ?? "other") as AssetType,
      state: resolveLibraryAssetState(entry),
      createdAt: entry.createdAt,
      count: entry.grid?.count ?? entry.input?.count ?? 0,
      gridImagePath: entry.grid?.gridImagePath ?? "",
      files: entry.files ?? [],
      metadataPath: entry.metadataPath,
      assetId: entry.assetId,
      description: entry.input?.description ?? ""
    }));
    // 兼容历史台账早于本次改版的老项目：有素材但没历史记录的批次照常展示
    const orphans: LibraryItem[] = props.project.assets
      .filter((asset) => !knownRunIds.has(asset.id))
      .map((asset) => ({
        runId: asset.id,
        entry: null,
        name: asset.name,
        assetType: asset.type,
        state: "sliced" as LibraryAssetState,
        createdAt: asset.createdAt,
        count: asset.files.length,
        gridImagePath: "",
        files: asset.files,
        metadataPath: asset.metadataPath,
        assetId: asset.id,
        description: asset.description
      }));
    return [...fromHistory, ...orphans].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }, [props.historyEntries, props.project.assets, t]);

  async function copyAll(): Promise<void> {
    const targetDirectory = await props.runTask(
      t("busy.copyPng"),
      () => unwrap(window.topspeedBuilder.copyPng(props.project.path)),
      (directory) => t("assets.copied", { dir: directory })
    );
    if (targetDirectory) {
      await window.topspeedBuilder.openPath(targetDirectory);
    }
  }

  async function rename(item: LibraryItem, name: string): Promise<void> {
    const bridge = window.topspeedBuilder;
    const result = item.entry
      ? await bridge.renameGenerationHistory(props.project.path, item.runId, name)
      : await bridge.renameAsset(props.project.path, item.runId, name);
    if (result.ok) {
      await props.refreshHistory();
      await props.refreshProject();
    }
  }

  async function remove(item: LibraryItem): Promise<void> {
    const hint =
      item.state === "sliced"
        ? t("assets.removeSlicedHint")
        : item.state === "grid"
          ? t("assets.removeGridHint")
          : t("assets.removeEmptyHint");
    if (!window.confirm(`${hint}\n${t("history.removeConfirm")}`)) return;
    const result = await window.topspeedBuilder.removeGenerationHistory(props.project.path, item.runId);
    if (result.ok) {
      await props.refreshHistory();
      await props.refreshProject();
    }
  }

  return (
    <section className="panel wide">
      <PanelTitle
        icon={Image}
        title={t("assets.title")}
        subtitle={t("assets.subtitle", { count: items.length })}
      />
      {!canCopy && (
        <div className="inlineNote">
          {t("assets.noDirHint")}
        </div>
      )}
      <div className="assetActions">
        <button
          className="ghostButton"
          onClick={() => void props.refreshProject().then(() => props.refreshHistory())}
        >
          <RefreshCw size={16} />
          {t("preview.refresh")}
        </button>
        <button className="ghostButton" disabled={!canCopy || props.project.assets.length === 0} onClick={() => void copyAll()}>
          <Download size={16} />
          {t("assets.copy")}
        </button>
        {!canCopy && (
          <button className="ghostButton" onClick={props.onOpenSettings}>
            <Settings size={16} />
            {t("nav.settings")}
          </button>
        )}
      </div>
      <div className="assetGrid">
        {items.length === 0 && <EmptyState text={t("assets.empty")} />}
        {items.map((item) => (
          <LibraryCard
            key={item.runId}
            project={props.project}
            item={item}
            onUseAsReference={props.onUseAsReference}
            onOpenHistory={props.onOpenHistory}
            onRename={(name) => rename(item, name)}
            onDelete={() => remove(item)}
          />
        ))}
      </div>
    </section>
  );
}

/** 素材库卡片：按状态（无图 / 有整图未切图 / 已切图）渲染不同主体；缩略图双击放大查看细节 */
function LibraryCard(props: {
  project: Project;
  item: LibraryItem;
  onUseAsReference: (asset: Asset, filePath: string) => void;
  onOpenHistory: (entry: GenerationHistoryEntry) => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const { item } = props;
  /** 切图列表：文件路径 + 缩略图 dataUrl，顺序与 item.files 一致 */
  const [slices, setSlices] = useState<{ file: string; url: string }[]>([]);
  /** 当前选中的切图下标 —— 「参考」「定位」都作用于它，双击则放大它 */
  const [selectedSlice, setSelectedSlice] = useState(0);
  const [gridThumb, setGridThumb] = useState("");
  const [lightbox, setLightbox] = useState<{ file: string; src: string; name: string; meta: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(item.name);
  const [saving, setSaving] = useState(false);
  /** 卡片是否已进入视野：缩略图必须「看得见才加载」，否则一屏几十条记录会瞬间压垮渲染进程 */
  const cardRef = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    setNameDraft(item.name);
  }, [item.name]);

  useEffect(() => {
    if (inView) return;
    const node = cardRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    // 提前 240px 就开始加载，滚动时不至于看到空白格
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView]);

  useEffect(() => {
    if (!inView) return;
    let alive = true;
    const bridge = window.topspeedBuilder;
    setSlices([]);
    setSelectedSlice(0);
    setGridThumb("");

    if (item.state === "grid" && item.gridImagePath) {
      // 卡片只用 160px 缓存缩略图；需要看细节时再取大图
      bridge
        .readImageThumbnail(props.project.path, item.runId)
        .then((result) => {
          if (alive && result.ok && result.data) setGridThumb(result.data);
        })
        .catch(() => undefined);
      return () => {
        alive = false;
      };
    }

    if (item.state === "sliced") {
      // 不再截断：生成上限 16 张时 4×4 一屏放得下，截到 12 会整整少一行。
      // 但必须走 160px 缩略图通道 —— 一屏十几条记录 × 16 张 = 几百张图，
      // 按 1024px 读回会让渲染主线程连续解大图，直接饿死键盘 / 输入法事件。
      const pngFiles = item.files.filter((file) => file.toLowerCase().endsWith(".png"));
      Promise.all(
        pngFiles.map((file) =>
          bridge
            .readImageThumbnailDataUrl(props.project.path, file, 160)
            .then((result) => (result.ok && result.data ? result.data : ""))
        )
      )
        .then((urls) => {
          if (alive) setSlices(pngFiles.map((file, index) => ({ file, url: urls[index] ?? "" })));
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [inView, props.project.path, item.runId, item.state, item.gridImagePath, item.files.length]);

  const asset = item.assetId ? props.project.assets.find((entry) => entry.id === item.assetId) : undefined;
  const firstFile = item.files.find((file) => file.toLowerCase().endsWith(".png")) ?? "";
  /** 选中下标越界保护（删除切图 / 记录刷新后下标可能失效） */
  const activeIndex = slices.length === 0 ? 0 : Math.min(selectedSlice, slices.length - 1);
  const activeSlice = slices[activeIndex];
  // 一屏最多铺 16 张（4 列 × 4 行）；超出的数量压在最后一格角标上
  const visibleSlices = slices.slice(0, 16);
  const hiddenSlices = slices.length - visibleSlices.length;

  async function openGridPreview(): Promise<void> {
    if (!item.gridImagePath) return;
    const result = await window.topspeedBuilder.readImageDataUrl(props.project.path, item.gridImagePath);
    if (result.ok && result.data) {
      setLightbox({
        file: item.gridImagePath,
        src: result.data,
        name: item.name,
        meta: t("assets.metaGrid", { count: item.count })
      });
    }
  }

  async function openSlicePreview(index: number): Promise<void> {
    const slice = slices[index];
    if (!slice) return;
    const meta = t("assets.metaSlice", { index: index + 1, count: slices.length });
    // 先用 160px 缩略图秒开，再按需取 1024px 预览替换（只看细节时才付解码代价）
    setLightbox({ file: slice.file, src: slice.url, name: item.name, meta });
    const result = await window.topspeedBuilder.readImageDataUrl(props.project.path, slice.file);
    if (result.ok && result.data) {
      setLightbox((current) =>
        current && current.file === slice.file ? { ...current, src: result.data as string } : current
      );
    }
  }

  async function saveName(): Promise<void> {
    const next = nameDraft.trim();
    if (!next || next === item.name) {
      setEditing(false);
      setNameDraft(item.name);
      return;
    }
    setSaving(true);
    try {
      await props.onRename(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="assetCard libraryCard" ref={cardRef}>
      <div className="libraryHead">
        <span className={`libraryBadge ${item.state}`}>{t(`assets.state.${item.state}`)}</span>
        {editing ? (
          <div className="libraryRenameRow">
            <input
              autoFocus
              value={nameDraft}
              maxLength={80}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveName();
                if (event.key === "Escape") {
                  setEditing(false);
                  setNameDraft(item.name);
                }
              }}
            />
            <button className="ghostButton" type="button" disabled={saving} onClick={() => void saveName()}>
              <Check size={14} />
            </button>
            <button
              className="ghostButton"
              type="button"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setNameDraft(item.name);
              }}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="libraryTitleRow">
            <strong title={item.name}>{item.name}</strong>
            <button
              className="libraryIconButton"
              type="button"
              title={t("assets.rename")}
              onClick={() => setEditing(true)}
            >
              <Pencil size={13} />
            </button>
          </div>
        )}
      </div>

      <div className="libraryMedia">
        {item.state === "empty" ? (
          <div className="libraryPlaceholder">
            <FileText size={30} />
            <span>{t("assets.state.emptyHint")}</span>
            {item.description && <small>{item.description}</small>}
          </div>
        ) : item.state === "grid" ? (
          <button
            className="libraryThumb solo"
            type="button"
            title={t("assets.previewHint")}
            onDoubleClick={() => void openGridPreview()}
          >
            {gridThumb ? <img src={gridThumb} alt={item.name} draggable={false} /> : <Loader2 size={20} className="spin" />}
          </button>
        ) : (
          <div className="libraryThumbGrid">
            {visibleSlices.length === 0
              ? Array.from({ length: 4 }, (_, index) => (
                  <span key={index} className="libraryThumb grid">
                    <Loader2 size={13} className="spin" />
                  </span>
                ))
              : visibleSlices.map((slice, index) => (
                  <button
                    key={`${item.runId}-${slice.file}`}
                    className={`libraryThumb grid${index === activeIndex ? " selected" : ""}`}
                    type="button"
                    aria-pressed={index === activeIndex}
                    title={t("assets.selectHint")}
                    onClick={() => setSelectedSlice(index)}
                    onDoubleClick={() => void openSlicePreview(index)}
                  >
                    {slice.url ? <img src={slice.url} alt="" draggable={false} /> : <Image size={14} />}
                    {index === activeIndex && <span className="libraryThumbIndex">{index + 1}</span>}
                    {hiddenSlices > 0 && index === visibleSlices.length - 1 && (
                      <span className="libraryThumbMore">+{hiddenSlices}</span>
                    )}
                  </button>
                ))}
          </div>
        )}
      </div>

      <div className="assetBody">
        <span>
          {t("assetType." + item.assetType)} · {item.count} {t("history.unit")}
          {item.state === "sliced" && slices.length > 0 && ` · ${t("assets.selectedIndex", { index: activeIndex + 1 })}`}
        </span>
        <small>{formatTimestamp(item.createdAt)}</small>
      </div>

      <div className="assetActions">
        {item.entry && (
          <button className="ghostButton" onClick={() => props.onOpenHistory(item.entry!)}>
            <History size={15} />
            {t("assets.openHistory")}
          </button>
        )}
        {item.gridImagePath && item.state !== "grid" && (
          <button className="ghostButton" onClick={() => void openGridPreview()}>
            <Image size={15} />
            {t("assets.viewGrid")}
          </button>
        )}
        {activeSlice && asset && (
          <button
            className="ghostButton"
            title={t("assets.useAsReferenceHint", { index: activeIndex + 1, count: slices.length })}
            onClick={() => props.onUseAsReference(asset, activeSlice.file)}
          >
            <Image size={15} />
            {t("assets.useAsReference")}
          </button>
        )}
        <button
          className="ghostButton"
          title={t("preview.locate")}
          onClick={() => {
            // 已切图时优先定位「当前选中的那一张」，否则回到记录级文件（metadata / 首图）
            const file = item.state === "sliced" && activeSlice ? activeSlice.file : item.metadataPath ?? firstFile;
            if (file) {
              void window.topspeedBuilder
                .showProjectItemInFolder(props.project.path, file)
                .catch(() => undefined);
            }
          }}
        >
          <FolderOpen size={15} />
          {t("preview.locate")}
        </button>
        <button
          className="ghostButton danger"
          onClick={() => void props.onDelete()}
        >
          <Trash2 size={15} />
          {t("assets.remove")}
        </button>
      </div>

      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          name={lightbox.name}
          meta={lightbox.meta}
          onClose={() => setLightbox(null)}
        />
      )}
    </article>
  );
}

/**
 * 设置页「拉取模型 / 检测连接」共用的反馈槽位：固定在「检测连接」按钮后方。
 * 定宽 + 单行省略，长报错不会换行、也不会把设置面板撑宽；悬停 title 看完整内容。
 */
/** 设置页「拉取模型 / 检测连接」的反馈：文案由触发操作自行组装，组件只负责渲染 */
type ModelActionFeedback = { ok: boolean; text: string };

function ModelActionStatus(props: { feedback: ModelActionFeedback | null }): JSX.Element | null {
  if (!props.feedback) return null;
  return (
    <span className={`modelStatus ${props.feedback.ok ? "ok" : "fail"}`} title={props.feedback.text}>
      {props.feedback.text}
    </span>
  );
}

function SettingsPage(props: {
  settings: AppSettings;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  onSaved: (settings: AppSettings) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AppSettings>(props.settings);
  const [testResult, setTestResult] = useState<ModelActionFeedback | null>(null);
  const [dirFeedback, setDirFeedback] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  // 提示词助手配置与出图配置分开存储（settings.json 的 promptAssistant 子键），
  // 但共用底部同一个「保存」按钮，避免出现两个保存入口、改了不知道哪个生效。
  const [paDraft, setPaDraft] = useState<PromptAssistantSettings | null>(null);
  useEffect(() => setDraft(props.settings), [props.settings]);
  useEffect(() => {
    window.topspeedBuilder.getPromptAssistant().then((res) => {
      if (res.ok && res.data) setPaDraft(res.data);
    }).catch(() => undefined);
  }, []);

  const modelOptions = useMemo(() => {
    const known = new Set(draft.availableModels);
    const options = [...draft.availableModels];
    if (draft.model && !known.has(draft.model)) {
      options.push(draft.model);
    }
    return options;
  }, [draft.availableModels, draft.model]);

  const runTest = async () => {
    if (!window.topspeedBuilder) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.topspeedBuilder.testConnection(draft);
      if (res.ok && res.data) {
        setTestResult(
          res.data.ok
            ? { ok: true, text: `${t("settings.testOk")} · ${t("settings.testPass")}` }
            : { ok: false, text: `${t("settings.testFail")}: ${res.data.detail}` }
        );
      } else {
        setTestResult({ ok: false, text: `${t("settings.testFail")}: ${res.error ?? "检测请求失败"}` });
      }
    } catch (e) {
      setTestResult({ ok: false, text: `${t("settings.testFail")}: ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const fetchModels = async () => {
    if (!window.topspeedBuilder) return;
    setFetchingModels(true);
    setTestResult(null);
    try {
      const res = await window.topspeedBuilder.fetchModels(draft);
      if (res.ok && res.data) {
        const models = res.data;
        // 同提示词助手：拉取列表不改动已选模型，只在原本未选时才取第一项
        setDraft((current) => ({ ...current, availableModels: models, model: current.model || models[0] || "" }));
        setTestResult({ ok: true, text: t("settings.modelsFetched", { count: models.length }) });
      } else {
        setTestResult({ ok: false, text: `${t("settings.fetchModelsFail")}${res.error ? `: ${res.error}` : ""}` });
      }
    } catch (error) {
      setTestResult({ ok: false, text: `${t("settings.fetchModelsFail")}: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setFetchingModels(false);
    }
  };

  const pickDirectory = async (field: "defaultProjectRoot" | "defaultExportDirectory"): Promise<void> => {
    const bridge = window.topspeedBuilder;
    if (!bridge || typeof bridge.chooseDirectory !== "function") {
      setDirFeedback({ ok: false, detail: t("settings.dirPickerNoIpc") });
      return;
    }
    setDirFeedback(null);
    const title = field === "defaultProjectRoot" ? t("settings.pickProjectDir") : t("settings.pickExportDir");
    try {
      const result = await bridge.chooseDirectory(title, draft[field] || "");
      if (result.ok && result.data) {
        // 路径已回填到输入框，这里无需额外的成功提示
        setDraft((current) => ({ ...current, [field]: result.data }));
      } else if (result.error) {
        setDirFeedback({ ok: false, detail: result.error });
      }
    } catch (error) {
      setDirFeedback({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section className="panel wide">
      <PanelTitle icon={Settings} title={t("settings.title")} />
      <div className="formGrid">
        <DirectoryPicker
          label={t("settings.defaultProjectDir")}
          value={draft.defaultProjectRoot}
          onChange={(defaultProjectRoot) => setDraft({ ...draft, defaultProjectRoot })}
          onPick={() => void pickDirectory("defaultProjectRoot")}
        />
        <DirectoryPicker
          label={t("settings.defaultExportDir")}
          value={draft.defaultExportDirectory}
          onChange={(defaultExportDirectory) => setDraft({ ...draft, defaultExportDirectory })}
          onPick={() => void pickDirectory("defaultExportDirectory")}
        />
      </div>
      {dirFeedback && (
        <p
          style={{
            margin: "-8px 0 0",
            fontSize: 13,
            color: "#f87171",
            wordBreak: "break-all"
          }}
        >
          {t("settings.dirPickerFail")}: {dirFeedback.detail}
        </p>
      )}

      <div className="sectionRule" />

      <div className="inlineNote">
        {t("settings.imageEndpointHint")}
      </div>
      <div className="formGrid apiGrid">
        <TextInput
          label={t("settings.apiBaseUrl")}
          value={draft.apiBaseUrl}
          placeholder={t("settings.apiBaseUrlHint")}
          onChange={(apiBaseUrl) => setDraft({ ...draft, apiBaseUrl })}
        />
        <TextInput
          className="apiKeyField"
          label={t("settings.apiKey")}
          value={draft.apiKey}
          type="password"
          onChange={(apiKey) => setDraft({ ...draft, apiKey })}
        />
        {/* 与上一行共用第一列：模型下拉因此和 API 地址输入框严格等宽 */}
        <label className="field apiModelField">
          <span>{t("settings.model")}</span>
          <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {modelOptions.length === 0 && <option value="">{t("settings.modelPlaceholder")}</option>}
            {modelOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <div className="apiModelActions">
          <button className="ghostButton" disabled={fetchingModels} onClick={fetchModels}>
            {fetchingModels ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            <span>{fetchingModels ? t("settings.fetchingModels") : t("settings.fetchModels")}</span>
          </button>
          <button className="ghostButton" disabled={testing} onClick={runTest}>
            {testing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            <span>{testing ? t("settings.testing") : t("settings.testConnection")}</span>
          </button>
          <ModelActionStatus feedback={testResult} />
        </div>
      </div>
      <PromptAssistantSettingsBlock draft={paDraft} onChange={setPaDraft} />
      <button
        className="primaryButton"
        onClick={async () => {
          const saved = await props.runTask(t("settings.save"), async () => {
            const next = await unwrap(window.topspeedBuilder.saveSettings(draft));
            if (paDraft) await unwrap(window.topspeedBuilder.savePromptAssistant(paDraft));
            return next;
          });
          if (saved) props.onSaved(saved);
        }}
      >
        <Save size={18} />
        {t("settings.save")}
      </button>
    </section>
  );
}

/** 提示词助手配置区块：受控组件，草稿由设置页统一持有，与出图配置共用底部「保存」按钮 */
function PromptAssistantSettingsBlock(props: {
  draft: PromptAssistantSettings | null;
  onChange: (next: PromptAssistantSettings) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const draft = props.draft;
  const setDraft = props.onChange;
  const [testResult, setTestResult] = useState<ModelActionFeedback | null>(null);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);

  const modelOptions = useMemo(() => {
    const known = new Set(draft ? draft.availableModels : []);
    const options = draft ? [...draft.availableModels] : [];
    if (draft?.model && !known.has(draft.model)) options.push(draft.model);
    return options;
  }, [draft?.availableModels, draft?.model]);

  if (!draft) return <div className="sectionRule" />;

  const runTest = async () => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.topspeedBuilder.promptAssistantTest(draft);
      if (res.ok && res.data) {
        setTestResult(
          res.data.ok
            ? { ok: true, text: `${t("settings.testOk")} · ${t("settings.testPass")}` }
            : { ok: false, text: `${t("settings.testFail")}: ${res.data.detail}` }
        );
      } else {
        setTestResult({ ok: false, text: `${t("settings.testFail")}: ${res.error ?? "检测请求失败"}` });
      }
    } catch (e) {
      setTestResult({ ok: false, text: `${t("settings.testFail")}: ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setTestResult(null);
    try {
      const res = await window.topspeedBuilder.promptAssistantFetchModels(draft);
      if (res.ok && res.data) {
        const models = res.data;
        // 只刷新可选列表，不擅自改动已选模型：当前模型即使不在新列表中也保留，
        // 避免「拉取模型」这个看似只读的操作把用户选好的模型顶掉。
        setDraft({ ...draft, availableModels: models, model: draft.model || models[0] || "" });
        // 与出图模型的「拉取模型」保持一致的反馈文案
        setTestResult({ ok: true, text: t("settings.modelsFetched", { count: models.length }) });
      } else {
        setTestResult({ ok: false, text: `${t("settings.fetchModelsFail")}${res.error ? `: ${res.error}` : ""}` });
      }
    } catch (e) {
      setTestResult({ ok: false, text: `${t("settings.fetchModelsFail")}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <>
      <div className="sectionRule" />
      <div className="inlineNote">{t("settings.paHint")}</div>
      <div className="formGrid apiGrid">
        <TextInput
          label={t("settings.paApiBaseUrl")}
          value={draft.baseUrl}
          placeholder={t("settings.apiBaseUrlHint")}
          onChange={(baseUrl) => setDraft({ ...draft, baseUrl })}
        />
        <TextInput
          className="apiKeyField"
          label={t("settings.paApiKey")}
          value={draft.apiKey}
          type="password"
          onChange={(apiKey) => setDraft({ ...draft, apiKey })}
        />
        {/* 与出图区块同样的两行布局，模型下拉与 API 地址输入框等宽 */}
        <label className="field apiModelField">
          <span>{t("settings.paModel")}</span>
          <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {modelOptions.length === 0 && <option value="">{t("settings.modelPlaceholder")}</option>}
            {modelOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <div className="apiModelActions">
          <button className="ghostButton" disabled={fetchingModels} onClick={fetchModels}>
            {fetchingModels ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            <span>{fetchingModels ? t("settings.fetchingModels") : t("settings.fetchModels")}</span>
          </button>
          <button className="ghostButton" disabled={testing} onClick={runTest}>
            {testing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            <span>{testing ? t("settings.testing") : t("settings.testConnection")}</span>
          </button>
          <ModelActionStatus feedback={testResult} />
        </div>
      </div>
    </>
  );
}

/** 四个生成字段 -> i18n 文案 key */
const PA_FIELD_LABEL_KEYS: Record<keyof PromptAssistantFields, string> = {
  description: "generate.paFieldDescription",
  detailPrompt: "generate.paFieldDetailPrompt",
  cellNames: "generate.paFieldCellNames",
  style: "generate.paFieldStyle"
};

function PromptAssistantDialog(props: {
  assetType: AssetType;
  assetTypeLabelText: string;
  count: number;
  currentDescription: string;
  currentStyle: string;
  onApply: (result: PromptAssistantResult, fields: PromptAssistantFields) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [config, setConfig] = useState<PromptAssistantSettings | null>(null);
  const [natural, setNatural] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);
  const [rawOutput, setRawOutput] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.topspeedBuilder.getPromptAssistant().then((res) => {
      if (res.ok && res.data) setConfig(res.data);
    }).catch(() => undefined);
  }, []);

  const fields: PromptAssistantFields = config?.fields ?? DEFAULT_PROMPT_ASSISTANT_FIELDS;
  const anyFieldOn = PROMPT_ASSISTANT_FIELD_KEYS.some((key) => fields[key]);

  /** 改配置并即时持久化，下次打开保持选择 */
  const updateConfig = (patch: Partial<PromptAssistantSettings>): void => {
    if (!config) return;
    const next: PromptAssistantSettings = { ...config, ...patch };
    setConfig(next);
    void window.topspeedBuilder.savePromptAssistant(next).then((res) => {
      if (res.ok && res.data) setConfig(res.data);
    }).catch(() => undefined);
  };

  const toggleField = (key: keyof PromptAssistantFields): void => {
    updateConfig({ fields: { ...fields, [key]: !fields[key] } });
  };

  const run = async () => {
    setError("");
    setApplied(false);
    // 实时读取最新助手配置：弹窗为按需挂载，但设置页改完不会自动刷新，仍读一次最新
    let cfg = config;
    try {
      const latest = await window.topspeedBuilder.getPromptAssistant();
      if (latest.ok && latest.data) {
        cfg = latest.data;
        setConfig(latest.data);
      }
    } catch {
      /* 沿用已缓存配置 */
    }
    if (!cfg || !cfg.baseUrl.trim() || !cfg.model.trim()) {
      setError(t("generate.paConfigMissing"));
      return;
    }
    if (!natural.trim()) {
      setError(t("generate.paNaturalEmpty"));
      return;
    }
    if (!PROMPT_ASSISTANT_FIELD_KEYS.some((key) => (cfg.fields ?? DEFAULT_PROMPT_ASSISTANT_FIELDS)[key])) {
      setError(t("generate.paNoFields"));
      return;
    }
    setBusy(true);
    try {
      const res = await window.topspeedBuilder.promptAssistantGenerate(cfg, {
        naturalLanguage: natural.trim(),
        assetType: props.assetType,
        count: props.count > 0 ? props.count : 1,
        currentDescription: props.currentDescription,
        currentStyle: props.currentStyle,
        fields: cfg.fields ?? DEFAULT_PROMPT_ASSISTANT_FIELDS
      });
      if (res.ok && res.data) {
        if (res.data.parsed) {
          props.onApply(res.data, cfg.fields ?? DEFAULT_PROMPT_ASSISTANT_FIELDS);
          setApplied(true);
          setRawOutput("");
        } else {
          // 模型未按约定返回 JSON：展示原始文本，由用户手动复制粘贴到输入框
          setRawOutput(res.data.raw);
          setError(t("generate.paRawHint"));
        }
      } else {
        setError(res.error ?? t("generate.paNeedConfig"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyRaw = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(rawOutput);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="paDialogOverlay" onMouseDown={props.onClose}>
      <div className="paDialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="paDialogHead">
          <div className="paHeader">
            <strong>{t("generate.paTitle")}</strong>
            <span>{t("generate.paHint")}</span>
          </div>
          <button type="button" className="paDialogClose" aria-label={t("notice.dismiss")} onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        {!config && <div className="inlineNote compactNote">{t("generate.paNeedConfig")}</div>}
        <div className="paContext">
          {t("generate.paContext", { type: props.assetTypeLabelText, count: props.count > 0 ? props.count : 1 })}
        </div>
        <div className="paFields">
          <span className="paFieldsLabel">{t("generate.paFields")}</span>
          <div className="paFieldToggles">
            {PROMPT_ASSISTANT_FIELD_KEYS.map((key) => (
              <label key={key} className="checkboxField">
                <input type="checkbox" checked={fields[key]} onChange={() => toggleField(key)} />
                <span>{t(PA_FIELD_LABEL_KEYS[key])}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="paForm">
          <label className="field paNaturalField">
            <span>{t("generate.paNatural")}</span>
            <textarea
              className="paNatural"
              value={natural}
              placeholder={t("generate.paNaturalPlaceholder")}
              onChange={(event) => setNatural(event.target.value)}
            />
          </label>
          <button className="primaryButton" disabled={busy || !anyFieldOn} onClick={run}>
            {busy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
            <span>{busy ? t("generate.paGenerating") : t("generate.paGenerate")}</span>
          </button>
        </div>
        {!anyFieldOn && <div className="inlineNote" style={{ color: "#f87171" }}>{t("generate.paNoFields")}</div>}
        {applied && <div className="inlineNote" style={{ color: "#4ade80" }}>{t("generate.paApplied")}</div>}
        {rawOutput && (
          <div className="paRawBox">
            <div className="paRawHead">
              <span>{t("generate.paRawHint")}</span>
              <button type="button" className="ghostButton" onClick={() => void copyRaw()}>
                {copied ? t("generate.paCopied") : t("generate.paCopy")}
              </button>
            </div>
            <textarea className="paRaw" readOnly value={rawOutput} />
          </div>
        )}
        {error && <div className="inlineNote paErrorBox" style={{ color: "#f87171" }}>{error}</div>}
      </div>
    </div>
  );
}

function DirectoryPicker(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onPick: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="dirPicker">
      <label className="field">
        <span>{props.label}</span>
        <input
          type="text"
          value={props.value}
          placeholder={t("field.notSet")}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </label>
      <button type="button" className="ghostButton" onClick={props.onPick}>
        <FolderOpen size={15} />
        {t("field.chooseDir")}
      </button>
    </div>
  );
}

function PanelTitle(props: { icon: typeof Home; title: string; subtitle?: string }): JSX.Element {
  const Icon = props.icon;
  return (
    <div className={props.subtitle ? "panelTitle" : "panelTitle center"}>
      <div className="panelIcon">
        <Icon size={18} />
      </div>
      <div>
        <h2>{props.title}</h2>
        {props.subtitle && <p>{props.subtitle}</p>}
      </div>
    </div>
  );
}

/** 本地缓冲单行文本输入：与 BufferedTextArea 同一策略，打字只更新本控件，停顿/失焦后同步父级 */
function TextInput(props: {
  label: string;
  value: string;
  type?: string;
  disabled?: boolean;
  placeholder?: string;
  /** 追加到 .field 上的类，用于在网格里指定列/跨列 */
  className?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const [local, setLocal] = useState(props.value);
  const propsRef = useRef(props);
  propsRef.current = props;
  const textRef = useRef(local);
  textRef.current = local;
  const lastEditRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  const clearTimer = (): void => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const flush = (): void => {
    clearTimer();
    const latest = textRef.current;
    if (latest !== propsRef.current.value) propsRef.current.onChange(latest);
  };

  useEffect(() => {
    if (props.value === local) return;
    if (Date.now() - lastEditRef.current < 400) return;
    clearTimer();
    setLocal(props.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  useEffect(
    () => () => {
      clearTimer();
      const latest = textRef.current;
      if (latest !== propsRef.current.value) propsRef.current.onChange(latest);
    },
    []
  );

  return (
    <label className={props.className ? `field ${props.className}` : "field"}>
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.disabled ? props.value : local}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onBlur={flush}
        onChange={(event) => {
          const next = event.target.value;
          setLocal(next);
          lastEditRef.current = Date.now();
          clearTimer();
          timerRef.current = window.setTimeout(flush, 160);
        }}
      />
    </label>
  );
}

function NumberInput(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  className?: string;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className={["field", props.className].filter(Boolean).join(" ")}>
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

/**
 * 本地缓冲文本域：解决“文本框无法顺畅输入”。
 * 传统受控写法每次按键都会让父组件整树重渲染——页面元素一多（大图预览/几百条历史/参考图…），
 * 按键事件就会积压、掉字甚至让 Windows 输入法断连。
 * 这里打字只更新本控件 state（毫秒级），停顿 flushDelay 或失焦后才把最终值同步给父组件，
 * 因此无论页面多重，打字都跟手。父组件值被外部改写（历史恢复/预设切换/切项目重置）且用户空闲时自动采纳。
 */
function BufferedTextArea(props: {
  label: string;
  value: string;
  className?: string;
  onChange: (value: string) => void;
  flushDelay?: number;
}): JSX.Element {
  const flushDelay = props.flushDelay ?? 160;
  const [local, setLocal] = useState(props.value);
  const propsRef = useRef(props);
  propsRef.current = props;
  const textRef = useRef(local);
  textRef.current = local;
  const lastEditRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  const clearTimer = (): void => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const flush = (): void => {
    clearTimer();
    const latest = textRef.current;
    if (latest !== propsRef.current.value) propsRef.current.onChange(latest);
  };

  // 外部值变化（历史恢复 / 预设切换 / 重置）且用户当前空闲 → 采纳外部值
  useEffect(() => {
    if (props.value === local) return;
    if (Date.now() - lastEditRef.current < 400) return;
    clearTimer();
    setLocal(props.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  // 卸载前把尚未同步的输入推给父组件，避免切页/切项目时丢字
  useEffect(
    () => () => {
      clearTimer();
      const latest = textRef.current;
      if (latest !== propsRef.current.value) propsRef.current.onChange(latest);
    },
    []
  );

  return (
    <label className={["field", "full", props.className].filter(Boolean).join(" ")}>
      <span>{props.label}</span>
      <textarea
        value={local}
        onBlur={flush}
        onChange={(event) => {
          const next = event.target.value;
          setLocal(next);
          lastEditRef.current = Date.now();
          clearTimer();
          timerRef.current = window.setTimeout(flush, flushDelay);
        }}
      />
    </label>
  );
}

function SelectInput(props: {
  label: string;
  value: string;
  options: SelectOption[];
  className?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <label className={["field", props.className].filter(Boolean).join(" ")}>
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => (
          <option key={selectOptionValue(option)} value={selectOptionValue(option)}>
            {t(selectOptionLabel(option))}
          </option>
        ))}
      </select>
    </label>
  );
}

function DeckToggle(props: {
  label: string;
  value: boolean;
  className?: string;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label className={["field", props.className].filter(Boolean).join(" ")}>
      <span>{props.label}</span>
      <button
        type="button"
        className={props.value ? "deckSwitch on" : "deckSwitch"}
        aria-pressed={props.value}
        title={props.label}
        onClick={() => props.onChange(!props.value)}
      >
        <i />
      </button>
    </label>
  );
}

function EmptyState(props: { text: string }): JSX.Element {
  return <div className="emptyState">{props.text}</div>;
}

function presetsFor(type: AssetType): { name: string; description: string; size: string; count: number; transparentBackground: boolean } {
  switch (type) {
    case "icon":
      return { name: "角色扮演道具", description: "中世纪背包道具，风格统一", size: "1024x1024", count: 8, transparentBackground: true };
    case "item":
      return { name: "角色扮演道具", description: "中世纪背包道具，风格统一", size: "1024x1024", count: 8, transparentBackground: true };
    case "character":
      return { name: "骑士", description: "银色盔甲骑士战士", size: "1024x1024", count: 4, transparentBackground: true };
    case "enemy":
      return { name: "怪物", description: "地牢怪物，轮廓清晰", size: "1024x1024", count: 6, transparentBackground: true };
    case "ui":
      return { name: "界面控件", description: "游戏界面控件元素，干净扁平风格", size: "1024x1024", count: 6, transparentBackground: true };
    case "background":
      return { name: "背景", description: "横版卷轴背景层，无角色", size: "1536x1024", count: 3, transparentBackground: false };
    case "effect":
      return { name: "特效", description: "游戏特效单体形态，风格统一", size: "1024x1024", count: 6, transparentBackground: true };
    case "other":
      return { name: "其它", description: "一整幅完整插画作品，画面内容见描述", size: "1024x1024", count: 1, transparentBackground: false };
  }
}

/** 自定义尺寸：非法或留空回退 1024，限制在 256–2048 之间 */
function clampBoxSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1024;
  return Math.min(2048, Math.max(256, Math.round(value)));
}

function splitLines(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toReferenceInput(image: ReferenceDraft): ReferenceImageInput {
  return {
    path: image.path,
    role: image.role,
    sourceAssetId: image.sourceAssetId,
    name: image.name
  };
}

function selectOptionValue(option: SelectOption): string {
  return typeof option === "string" ? option : option.value;
}

function selectOptionLabel(option: SelectOption): string {
  return typeof option === "string" ? option : option.label;
}

function assetTypeLabel(assetType: AssetType): string {
  const found = assetTypes.find((option) => option.value === assetType);
  return found ? found.label : assetType;
}

function gameTypeLabelT(t: (key: string) => string, gameType: string): string {
  const found = gameTypeOptions.find((option) => selectOptionValue(option) === gameType);
  return found ? t(selectOptionLabel(found)) : gameType;
}

function formatTimestamp(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

async function unwrap<T>(request: Promise<IpcResponse<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) {
    throw new Error(result.error ?? "未知错误");
  }
  return result.data as T;
}

export default App;
