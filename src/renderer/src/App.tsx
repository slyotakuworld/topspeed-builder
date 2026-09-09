import { useTranslation } from "react-i18next";
import i18n, { switchLanguage } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Boxes,
  Check,
  Download,
  FileText,
  FolderOpen,
  History,
  Home,
  Image,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
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
  CreateProjectInput,
  GenerateAssetInput,
  GeneratedAssetResult,
  GenerationHistoryEntry,
  GenerationQuality,
  GridDraft,
  GridSliceOptions,
  ImportedReferenceImage,
  IpcResponse,
  Project,
  RecentProject,
  ReferenceImageInput,
  ReferenceImageRole,
  ReferenceStrength
} from "@shared/types";

type Page = "home" | "generate" | "assets" | "settings";
type DetailTemplate = { id: string; name: string; prompt: string; meta: string };
type ReferenceDraft = ReferenceImageInput & Partial<Pick<ImportedReferenceImage, "width" | "height" | "bytes" | "hash" | "thumbnailPath" | "dataUrl">>;
type SelectOption = string | { value: string; label: string };
const gameTypeOptions: SelectOption[] = [
  { value: "RPG", label: "角色扮演" },
  "平台跳跃",
  "俯视角",
  "横版动作",
  "卡牌",
  "塔防",
  "其他"
];
const stylePresets: Array<{ value: string; label: string; text: string }> = [
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
const countPresets = [1, 2, 3, 4, 6, 8, 9, 12, 16, 20, 24, 30, 36];
const countOptions: SelectOption[] = countPresets.map((value) => ({ value: String(value), label: String(value) }));
/** 等分兜底切分的 列/行 下拉（上限 16，实际只取前「数量」个槽位） */
const sliceAxisOptions: SelectOption[] = Array.from({ length: 16 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1)
}));
/** 历史里可能存在非预设的数量（旧版输入框产物），恢复时吸附到最接近的预设 */
function nearestCountPreset(value: number): number {
  const numeric = Number.isFinite(value) ? Math.round(value) : 1;
  const clamped = Math.min(36, Math.max(1, numeric));
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
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" }
];
const referenceStrengthLabels = Object.fromEntries(referenceStrengthOptions.map((option) => [option.value, option.label])) as Record<ReferenceStrength, string>;
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

  async function refreshHomeProjects(): Promise<void> {
    try {
      const bridge = window.topspeedBuilder;
      if (bridge && typeof bridge.listDiscoverableProjects === "function") {
        setHomeProjects(await unwrap(bridge.listDiscoverableProjects()));
      }
    } catch (error) {
      // 静默失败：仅刷新失败时忽略
      void error;
    }
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
      <aside className="sidebar">
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

        <SidebarHistoryRail
          projectPath={project?.path ?? null}
          entries={historyEntries}
          selectedRunId={activeRunId}
          onOpen={openHistoryEntry}
          onRemove={(entry) => void removeHistoryEntry(entry)}
        />

        <div className="projectDock">
          <span>当前项目</span>
          <strong>{project?.name ?? t("project.dock.empty")}</strong>
          <small>{project?.path ?? t("project.dock.hint")}</small>
        </div>
        <button
          className="ghostButton"
          style={{ fontSize: 11, minHeight: 32, justifyContent: "center" }}
          onClick={() => switchLanguage(i18n.language === "zh" ? "en" : "zh")}
        >{t("lang.switch")}</button>
        <div className="sidebarStamp" title={`${t("buildStamp.tip")} ${__APP_BUILD_TS__}`}>
          rev {__APP_BUILD_TS__}
          {import.meta.env.DEV ? " · dev" : ""}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p>{pageLabel(page)}</p>
            <h1>{project ? project.name : t("brand.name")}</h1>
          </div>
          <div className="statusStrip">
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
          </div>
        </header>

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
            exportDirectory={settings.defaultExportDirectory}
            runTask={runTask}
            refreshProject={refreshProject}
            onHistoryChanged={() => void refreshHistory(project.path)}
            onOpenSettings={() => setPage("settings")}
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

  /** 丢弃当前网格草稿/载入提示，回到空白结果区 */
  function discardDraft(): void {
    setDraft(null);
    setGridDataUrl("");
    setRestoredCommitted(null);
    setConfigLoaded(false);
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
                  title={selected ? t("generate.detailRemove") : t("generate.detailAdd")}
                  onClick={() => handleDetailTemplateToggle(template)}
                >
                  <strong>{template.name}</strong>
                  <span>{template.prompt}</span>
                  <small>{template.meta}</small>
                  <em>{selected ? t("generate.detailSelected") : t("generate.detailAdd")}</em>
                </button>
              );
            })}
          </div>
        </div>
        <BufferedTextArea label={t("generate.detailPrompt")} value={detailPrompt} onChange={handleDetailPromptChange} />
        {!isSingleShot && <BufferedTextArea label={t("generate.cellNames")} value={cellNamesText} onChange={setCellNamesText} />}
      </section>

      <section className="panel resultPanel">
        <PanelTitle icon={Archive} title={t("generate.draft")} />
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

            {/* 操作行：确认切分入库 / 手动保存 / 重新生成 / 放弃 */}
            <div className="assetActions sliceActions">
              <button className="primaryButton" onClick={() => void commitDraft()}>
                <Check size={18} />
                {t("generate.commit")}
              </button>
              <button className="ghostButton" type="button" title={t("generate.saveHistory")} onClick={() => void saveSnapshot()}>
                <Save size={16} />
                {t("generate.saveDraft")}
              </button>
              <button className="ghostButton" onClick={() => void generateDraft()}>
                <RefreshCw size={16} />
                {t("generate.regenGrid")}
              </button>
              <button className="ghostButton" onClick={discardDraft}>
                <Trash2 size={16} />
                {t("generate.discard")}
              </button>
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
                    {t("generate.autoDetected", { count: autoPreviewCells.length })}
                  </div>
                ) : autoActive ? (
                  <div className="inlineNote compactNote">{t("generate.autoFallback")}</div>
                ) : (
                  <div className="inlineNote compactNote">{t("generate.sliceHint")}</div>
                )}
              </div>
            )}

            {/* 本批次产出的图片/文字信息：始终放列表最下面 */}
            {restoredCommitted && (
              <div className="genHistoryBlock committedPreview">
                <div className="genHistoryFilesHead">
                  <strong>{t("history.restoredFiles", { count: restoredCommitted.files.length })}</strong>
                  {restoredCommitted.files.length > 0 ? (
                    <button
                      className="miniClearButton"
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
                      <FolderOpen size={13} />
                      {t("history.locate")}
                    </button>
                  ) : null}
                </div>
                {restoredCommitted.files.length > 0 ? (
                  <div className="genHistoryFiles">
                    {restoredCommitted.files.slice(0, 12).map((file) => (
                      <code key={file} title={file}>
                        {file.split("/").pop()}
                      </code>
                    ))}
                    {restoredCommitted.files.length > 12 ? <code>+{restoredCommitted.files.length - 12}</code> : null}
                  </div>
                ) : null}
                <div className="inlineNote compactNote">
                  {restoredCommitted.kind === "committed" ? t("history.committedHint") : t("history.restoredHint")}
                </div>
              </div>
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
}): JSX.Element {
  const { t } = useTranslation();
  const [visibleCount, setVisibleCount] = useState(RAIL_PAGE);
  // 历史载入后先让出 1.2s 给界面交互（用户此刻往往正要输入），随后才开始懒加载缩略图
  const [thumbsReady, setThumbsReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const projectPath = props.projectPath;

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
                    <strong>{entry.input.name || t(`assetType.${entry.input.assetType}`)}</strong>
                    <small>{formatTimestamp(entry.createdAt)}</small>
                  </span>
                </button>
                <button
                  className="historyRailDelete"
                  type="button"
                  title={t("history.remove")}
                  onClick={() => props.onRemove(entry)}
                >
                  <Trash2 size={13} />
                </button>
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

function ReferenceImagePanel(props: {
  project: Project;
  value: ReferenceDraft[];
  referenceStrength: ReferenceStrength;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  onChange: (value: ReferenceDraft[]) => void;
  onReferenceStrengthChange: (value: ReferenceStrength) => void;
}): JSX.Element {
  const { t } = useTranslation();
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

  return (
    <div className="referencePanel">
      <div className="referenceHeader">
        <div>
          <strong>{t("generate.refImages")}</strong>
          <span>{props.value.length}/4 · {t("generate.refHint")}</span>
        </div>
        <div className="referenceActions">
          <label className="strengthControl">
            <span>{t("generate.refStrength")}</span>
            <select
              value={props.referenceStrength}
              aria-label={t("generate.refStrength")}
              onChange={(event) => props.onReferenceStrengthChange(event.target.value as ReferenceStrength)}
            >
              {referenceStrengthOptions.map((option) => (
                <option key={selectOptionValue(option)} value={selectOptionValue(option)}>
                  {selectOptionLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <button className="ghostButton" type="button" onClick={importReferences} disabled={props.value.length >= 4}>
            <Plus size={15} />
            {t("generate.importRef")}
          </button>
        </div>
      </div>

      {props.value.length === 0 ? (
        <EmptyState text={t("generate.noRefs")} />
      ) : (
        <div className="referenceGrid">
          {props.value.map((image) => (
            <article key={image.path} className="referenceCard">
              <div className="referenceThumb">
                {image.dataUrl ? <img src={image.dataUrl} alt={image.name ?? image.path} /> : <Image size={34} />}
              </div>
              <div className="referenceMeta">
                <strong>{image.name ?? image.path.split(/[\\/]/).pop()}</strong>
                <small>{image.width && image.height ? `${image.width}x${image.height}` : "项目素材"}</small>
                <select value={image.role} onChange={(event) => updateRole(image.path, event.target.value as ReferenceImageRole)}>
                  {referenceRoles.map((role) => (
                    <option key={role.value} value={role.value}>
                      {t(role.label)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="referenceRemove"
                type="button"
                title="移除参考图"
                onClick={() => props.onChange(props.value.filter((item) => item.path !== image.path))}
              >
                <Trash2 size={13} />
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function AssetsPage(props: {
  project: Project;
  exportDirectory: string;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  refreshProject: () => Promise<Project | null>;
  onOpenSettings: () => void;
  onUseAsReference: (asset: Asset, filePath: string) => void;
  onHistoryChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const canCopy = Boolean(props.exportDirectory.trim());

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

  return (
    <section className="panel wide">
      <PanelTitle icon={Image} title={t("assets.title")} subtitle={t("assets.subtitle", { count: props.project.assets.length })} />
      {!canCopy && (
        <div className="inlineNote">
          {t("assets.noDirHint")}
        </div>
      )}
      <div className="assetActions">
        <button className="ghostButton" onClick={() => void props.refreshProject()}>
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
        {props.project.assets.length === 0 && <EmptyState text={t("assets.empty")} />}
        {props.project.assets.map((asset) => (
          <AssetCard
            key={asset.id}
            project={props.project}
            asset={asset}
            runTask={props.runTask}
            onUseAsReference={props.onUseAsReference}
            onDelete={async () => { await props.refreshProject(); props.onHistoryChanged(); }}
          />
        ))}
      </div>
    </section>
  );
}

function SettingsPage(props: {
  settings: AppSettings;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  onSaved: (settings: AppSettings) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AppSettings>(props.settings);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [dirFeedback, setDirFeedback] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  useEffect(() => setDraft(props.settings), [props.settings]);

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
        setTestResult({ ok: res.data.ok, detail: res.data.detail });
      } else {
        setTestResult({ ok: false, detail: res.error ?? "检测请求失败" });
      }
    } catch (e) {
      setTestResult({ ok: false, detail: String(e) });
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
        setDraft((current) => ({
          ...current,
          availableModels: models,
          model: current.model && models.includes(current.model) ? current.model : (models[0] ?? current.model ?? "")
        }));
        setTestResult({ ok: true, detail: t("settings.modelsFetched", { count: models.length }) });
      } else {
        setTestResult({ ok: false, detail: res.error ?? t("settings.fetchModelsFail") });
      }
    } catch (error) {
      setTestResult({ ok: false, detail: error instanceof Error ? error.message : String(error) });
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
        <TextInput label={t("settings.apiKey")} value={draft.apiKey} type="password" onChange={(apiKey) => setDraft({ ...draft, apiKey })} />
        <button
          className="ghostButton"
          disabled={fetchingModels}
          onClick={fetchModels}
        >
          {fetchingModels ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          <span>{fetchingModels ? t("settings.fetchingModels") : t("settings.fetchModels")}</span>
        </button>
      </div>
      <div className="modelActionBlock">
        <label className="field">
          <span>{t("settings.model")}</span>
          <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {modelOptions.length === 0 && <option value="">{t("settings.modelPlaceholder")}</option>}
            {modelOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <button
          className="ghostButton"
          style={{ whiteSpace: "nowrap" }}
          disabled={testing}
          onClick={runTest}
        >
          {testing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          <span>{testing ? t("settings.testing") : t("settings.testConnection")}</span>
        </button>
        {testResult && (
          <span style={{ padding: "6px 0", fontSize: 13, color: testResult.ok ? "#4ade80" : "#f87171", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {testResult.ok ? `${t("settings.testOk")} · ${testResult.detail}` : `${t("settings.testFail")}: ${testResult.detail}`}
          </span>
        )}
      </div>
      <button
        className="primaryButton"
        onClick={async () => {
          const saved = await props.runTask(t("settings.save"), () => unwrap(window.topspeedBuilder.saveSettings(draft)));
          if (saved) props.onSaved(saved);
        }}
      >
        <Save size={18} />
        {t("settings.save")}
      </button>
    </section>
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

function selectPreviewFile(asset: Asset): string {
  const pngFiles = asset.files.filter((file) => file.toLowerCase().endsWith(".png"));
  return pngFiles[0] ?? asset.files[0] ?? "";
}

function AssetCard(props: {
  project: Project;
  asset: Asset;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  onUseAsReference?: (asset: Asset, filePath: string) => void;
  onDelete?: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const pngFiles = props.asset.files.filter((file) => file.toLowerCase().endsWith(".png")).slice(0, 24);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const previewFile = pngFiles[activeIndex % Math.max(pngFiles.length, 1)] ?? "";

  useEffect(() => {
    let alive = true;
    setThumbnails([]);
    setActiveIndex(0);
    if (pngFiles.length === 0) {
      return () => { alive = false; };
    }
    Promise.all(
      pngFiles.map((file) =>
        window.topspeedBuilder.readImageDataUrl(props.project.path, file).then((result) => (result.ok && result.data ? result.data : ""))
      )
    ).then((urls) => {
      if (alive) setThumbnails(urls);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.project.path, props.asset.id]);

  const activeThumbnail = thumbnails[activeIndex % Math.max(thumbnails.length, 1)] ?? "";
  const firstFile = pngFiles[0] ?? props.asset.metadataPath;

  return (
    <article className="assetCard">
      <div className="assetPreview">{activeThumbnail ? <img src={activeThumbnail} alt={props.asset.name} /> : <Boxes size={42} />}</div>
      {pngFiles.length > 1 && (
        <div className="assetThumbs">
          {thumbnails.map((url, index) => (
            <button
              key={pngFiles[index]}
              type="button"
              className={index === activeIndex ? "active" : ""}
              title={pngFiles[index]}
              onClick={() => setActiveIndex(index)}
            >
              {url ? <img src={url} alt="" /> : null}
            </button>
          ))}
        </div>
      )}
      <div className="assetBody">
        <strong>{props.asset.name}</strong>
        <span>{t("assetType." + props.asset.type)} · {props.asset.files.length} {t("preview.files")}</span>
        <small>{props.asset.createdAt ? new Date(props.asset.createdAt).toLocaleString() : ""}</small>
      </div>
      <div className="assetActions" style={{ marginTop: "auto" }}>
        {firstFile && props.onUseAsReference && (
          <button className="ghostButton" onClick={() => props.onUseAsReference?.(props.asset, firstFile)}>
            <Image size={15} />
            参考
          </button>
        )}
        <button
          className="ghostButton"
          onClick={() => {
            const file = props.asset.metadataPath ?? previewFile;
            if (file) {
              void props.runTask(t("busy.locateFile"), () => unwrap(window.topspeedBuilder.showProjectItemInFolder(props.project.path, file)));
            }
          }}
        >
          <FolderOpen size={15} />
          {t("preview.locate")}
        </button>
        <button
          className="ghostButton"
          style={{ borderColor: "rgba(255,45,149,0.3)", color: "var(--magenta)" }}
          onClick={async () => {
            if (!window.confirm(t("preview.deleteConfirm", { name: props.asset.name }))) return;
            const result = await props.runTask(
              t("busy.deleteAsset"),
              () => unwrap(window.topspeedBuilder.deleteAsset(props.project.path, props.asset.id)),
              () => t("preview.deleteDone")
            );
            if (result && props.onDelete) await props.onDelete();
          }}
        >
          <Trash2 size={15} />
          删除
        </button>
      </div>
    </article>
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
    <label className="field">
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

/**
 * 本地缓冲数字输入：文本型输入（inputMode=numeric，无原生 number 输入框的怪癖），
 * 仅在“停在合法区间内”或“失焦”时提交并夹取到 [min, max]，保证边删边打不跳字。
 */
function BufferedNumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  className?: string;
  onChange: (value: number) => void;
  flushDelay?: number;
}): JSX.Element {
  const flushDelay = props.flushDelay ?? 240;
  const [text, setText] = useState(String(props.value));
  const propsRef = useRef(props);
  propsRef.current = props;
  const textRef = useRef(text);
  textRef.current = text;
  const lastEditRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  const clearTimer = (): void => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const clamp = (num: number): number =>
    Math.min(propsRef.current.max, Math.max(propsRef.current.min, Math.round(num)));

  // 仅在合法区间内提交；非法中间态（如宽高输入 “1” 尚未凑成 1024）保持本地输入不打断
  const tryCommit = (): void => {
    const raw = textRef.current.trim();
    if (raw === "") return;
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    const { min, max, value, onChange } = propsRef.current;
    if (num < min || num > max) return;
    const rounded = Math.round(num);
    if (rounded !== value) onChange(rounded);
    const normalized = String(rounded);
    if (normalized !== raw) setText(normalized);
  };

  // 失焦强制提交并夹取到合法区间（空值回到最小值）
  const commitOnBlur = (): void => {
    clearTimer();
    const raw = textRef.current.trim();
    const { min, value, onChange } = propsRef.current;
    if (raw === "") {
      if (value !== min) onChange(min);
      setText(String(min));
      return;
    }
    const num = Number(raw);
    const target = Number.isFinite(num) ? clamp(num) : value;
    if (target !== value) onChange(target);
    if (String(target) !== raw) setText(String(target));
  };

  // 外部值变化且用户空闲 → 采纳
  useEffect(() => {
    const expected = String(props.value);
    if (expected === text) return;
    if (Date.now() - lastEditRef.current < 500) return;
    clearTimer();
    setText(expected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  // 卸载前尽力提交有效输入
  useEffect(
    () => () => {
      clearTimer();
      const raw = textRef.current.trim();
      if (raw === "") return;
      const num = Number(raw);
      if (!Number.isFinite(num)) return;
      const target = clamp(num);
      if (target !== propsRef.current.value) propsRef.current.onChange(target);
    },
    []
  );

  return (
    <label className={["field", props.className].filter(Boolean).join(" ")}>
      <span>{props.label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        onBlur={commitOnBlur}
        onChange={(event) => {
          const next = event.target.value.replace(/\D/g, "");
          setText(next);
          lastEditRef.current = Date.now();
          clearTimer();
          timerRef.current = window.setTimeout(tryCommit, flushDelay);
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

function Pill(props: { children: string }): JSX.Element {
  return <span className="pill">{props.children}</span>;
}

function EmptyState(props: { text: string }): JSX.Element {
  return <div className="emptyState">{props.text}</div>;
}

function pageLabel(page: Page): string {
  const labels: Record<Page, string> = {
    home: "项目首页",
    generate: "素材生成",
    assets: "素材库",
    settings: "应用设置"
  };
  return labels[page];
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

function gameTypeLabel(gameType: string): string {
  const found = gameTypeOptions.find((option) => selectOptionValue(option) === gameType);
  return found ? selectOptionLabel(found) : gameType;
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
