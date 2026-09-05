import { useTranslation } from "react-i18next";
import i18n, { switchLanguage } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Boxes,
  Brush,
  Check,
  Clapperboard,
  Download,
  FolderOpen,
  Gauge,
  History,
  Home,
  Image,
  Loader2,
  Package,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Wand2
} from "lucide-react";
import type {
  AnimationConfig,
  AppSettings,
  Asset,
  AssetType,
  CreateProjectInput,
  EditIntent,
  ExportTarget,
  GenerateAssetInput,
  GeneratedAssetResult,
  GenerationMode,
  GenerationHistoryRecord,
  ImportedReferenceImage,
  IpcResponse,
  Project,
  ReferenceImageInput,
  ReferenceImageRole,
  ReferenceStrength,
  RecentProject,
  StyleTemplate
} from "@shared/types";

type Page = "home" | "project" | "generate" | "preview" | "export" | "history" | "settings";
type DetailTemplate = { id: string; name: string; prompt: string; meta: string };
type ReferenceDraft = ReferenceImageInput & Partial<Pick<ImportedReferenceImage, "width" | "height" | "bytes" | "hash" | "thumbnailPath" | "dataUrl">>;
type SelectOption = string | { value: string; label: string };
type QueueStatus = "queued" | "running" | "done" | "failed";

interface GenerationQueueItem {
  id: string;
  input: GenerateAssetInput;
  status: QueueStatus;
  createdAt: string;
  files?: number;
  metadataPath?: string;
  error?: string;
}

const exportTargets: ExportTarget[] = ["unity", "godot", "tiled", "phaser", "cocos", "common"];
const exportTargetLabels: Record<ExportTarget, string> = {
  unity: "Unity",
  godot: "Godot",
  tiled: "Tiled",
  phaser: "Phaser",
  cocos: "Cocos",
  common: "Common"
};
const gameTypeOptions: SelectOption[] = [
  { value: "RPG", label: "角色扮演" },
  "平台跳跃",
  "俯视角",
  "横版动作",
  "卡牌",
  "塔防",
  "其他"
];
const backgroundOptions: SelectOption[] = [
  { value: "transparent", label: "background.transparent" },
  { value: "solid", label: "background.solid" },
  { value: "custom", label: "background.custom" }
];
const characterViewOptions: SelectOption[] = [
  { value: "side-view", label: "view.side-view" },
  { value: "top-down", label: "view.top-down" },
  { value: "four-direction", label: "view.four-direction" },
  { value: "eight-direction", label: "view.eight-direction" }
];
const providerOptions: SelectOption[] = [
  { value: "openai", label: "provider.openai" },
  { value: "custom", label: "provider.custom" },
  { value: "local-draft", label: "provider.local-draft" }
];
const apiFormatOptions: SelectOption[] = [
  { value: "openai-image", label: "apiFormat.openai-image" },
  { value: "openai-chat", label: "apiFormat.openai-chat" }
];
const qualityOptions: SelectOption[] = [
  { value: "low", label: "quality.low" },
  { value: "medium", label: "quality.medium" },
  { value: "high", label: "quality.high" }
];
const generationModes: Array<{ value: GenerationMode; label: string }> = [
  { value: "text-to-image", label: "mode.text-to-image" },
  { value: "image-to-image", label: "mode.image-to-image" }
];
const referenceRoles: Array<{ value: ReferenceImageRole; label: string }> = [
  { value: "subject", label: "role.subject" },
  { value: "style", label: "role.style" },
  { value: "composition", label: "role.composition" },
  { value: "palette", label: "role.palette" }
];
const editIntentOptions: Array<{ value: EditIntent; label: string }> = [
  { value: "preserve-subject", label: "intent.preserve-subject" },
  { value: "preserve-style", label: "intent.preserve-style" },
  { value: "preserve-composition", label: "intent.preserve-composition" },
  { value: "same-series", label: "intent.same-series" },
  { value: "inpaint", label: "intent.inpaint" }
];
const editIntentLabels = Object.fromEntries(editIntentOptions.map((option) => [option.value, option.label])) as Record<EditIntent, string>;
const referenceStrengthOptions: Array<{ value: ReferenceStrength; label: string }> = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" }
];
const referenceStrengthLabels = Object.fromEntries(referenceStrengthOptions.map((option) => [option.value, option.label])) as Record<ReferenceStrength, string>;
const assetTypes: Array<{ value: AssetType; label: string }> = [
  { value: "icon", label: "assetType.icon" },
  { value: "item", label: "assetType.item" },
  { value: "character", label: "assetType.character" },
  { value: "enemy", label: "assetType.enemy" },
  { value: "tileset", label: "assetType.tileset" },
  { value: "ui", label: "assetType.ui" },
  { value: "background", label: "assetType.background" },
  { value: "effect", label: "assetType.effect" }
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
    { id: "character-consistent", name: "身份一致", prompt: "每一帧保持同一角色身份，服装、比例、色板和视角一致", meta: "角色 · 序列帧" },
    { id: "character-action", name: "动作清晰", prompt: "动作姿态明确，四肢分离可读，重心平衡，无运动模糊", meta: "角色 · 动作" },
    { id: "character-rpg", name: "角色站姿", prompt: "紧凑的角色精灵站姿，姿态英勇，武器可见，待机轮廓干净", meta: "角色 · 战斗" }
  ],
  enemy: [
    { id: "enemy-threat", name: "威胁轮廓", prompt: "敌对生物轮廓，形状夸张且可读，有明确弱点，不要可爱表情", meta: "怪物 · 识别" },
    { id: "enemy-slime", name: "软体怪", prompt: "凝胶状身体，简单面部，可挤压的圆润形体，边缘半透明高光", meta: "怪物 · 软体" },
    { id: "enemy-boss", name: "精英单位", prompt: "更大的精英变体细节，甲壳或护甲板，更强轮廓，攻击提示可读", meta: "怪物 · 精英" }
  ],
  tileset: [
    { id: "tile-seam", name: "拼接边缘", prompt: "边缘可平铺，图案可重复，边界不穿过独特地标，铺满整个瓦片", meta: "瓦片集 · 拼接" },
    { id: "tile-wear", name: "地表磨损", prompt: "细微裂缝、缺角和小幅表面变化，俯视光照一致", meta: "瓦片集 · 地表" },
    { id: "tile-modular", name: "模块套件", prompt: "模块化地牢结构，地面与墙体视觉语言匹配，尺度线索一致", meta: "瓦片集 · 模块" }
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
    { id: "effect-impact", name: "命中特效", prompt: "短促命中爆发，中心点清晰，径向粒子，透明背景", meta: "特效 · 打击" },
    { id: "effect-loop", name: "循环粒子", prompt: "适合循环的粒子形状，能量流向一致，无明显开头或结尾", meta: "特效 · 循环" },
    { id: "effect-magic", name: "魔法光效", prompt: "奥术发光粒子，法术核心可读，外层柔和辉光，透明边缘干净", meta: "特效 · 魔法" }
  ]
};

const defaultAnimations: AnimationConfig[] = [
  { name: "待机", frames: 4, fps: 6, loop: true },
  { name: "行走", frames: 4, fps: 8, loop: true },
  { name: "攻击", frames: 4, fps: 10, loop: false }
];

const defaultSettings: AppSettings = {
  aiProvider: "openai",
  customApiFormat: "openai-image",
  apiKey: "",
  apiBaseUrl: "https://api.openai.com/v1/images/generations",
  model: "gpt-image-1.5",
  availableModels: [],
  defaultProjectRoot: "",
  defaultExportDirectory: "",
  defaultImageSize: "64x64",
  defaultGenerationCount: 1,
  savePromptHistory: true,
  autoTransparent: true,
  autoTrim: true,
  autoPackAtlas: true,
  generationQuality: "low"
};

function App(): JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState<Page>("home");
  const [project, setProject] = useState<Project | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [history, setHistory] = useState<GenerationHistoryRecord[]>([]);
  const [queuedReference, setQueuedReference] = useState<ReferenceDraft | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [queueItems, setQueueItems] = useState<GenerationQueueItem[]>([]);
  const [queueConcurrency, setQueueConcurrency] = useState(1);
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueMessage, setQueueMessage] = useState("");
  const queueStopRequested = useRef(false);

  useEffect(() => {
    void refreshInitialState();
  }, []);

  useEffect(() => {
    if (project) {
      void refreshHistory(project.path);
    }
  }, [project?.path]);

  const navItems = useMemo(
    () => [
      { page: "home" as Page, label: t("nav.home"), icon: Home, enabled: true },
      { page: "project" as Page, label: t("nav.project"), icon: Gauge, enabled: Boolean(project) },
      { page: "generate" as Page, label: t("nav.generate"), icon: Wand2, enabled: Boolean(project) },
      { page: "preview" as Page, label: t("nav.preview"), icon: Image, enabled: Boolean(project) },
      { page: "export" as Page, label: t("nav.export"), icon: Download, enabled: Boolean(project) },
      { page: "history" as Page, label: t("nav.history"), icon: History, enabled: Boolean(project) },
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
      if (!window.topspeedBuilder) {
        setMessage("浏览器预览模式：桌面通信未连接；桌面应用中会启用本地文件、智能生成和导出服务。");
        return;
      }

      const [nextSettings, nextRecent] = await Promise.all([
        unwrap(window.topspeedBuilder.getSettings()),
        unwrap(window.topspeedBuilder.getRecentProjects())
      ]);
      setSettings(nextSettings);
      setRecentProjects(nextRecent);
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

  async function refreshHistory(projectPath: string): Promise<void> {
    if (!window.topspeedBuilder) return;
    const nextHistory = await unwrap(window.topspeedBuilder.getHistory(projectPath));
    setHistory(nextHistory);
  }

  async function runTask<T>(label: string, task: () => Promise<T>, success?: (result: T) => string): Promise<T | null> {
    setBusy(label);
    setMessage("");
    try {
      const result = await task();
      setMessage(success?.(result) ?? t("message.completed"));
      return result;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function refreshGeneratedProjectData(projectPath = project?.path): Promise<void> {
    if (!projectPath) return;
    await refreshProject(projectPath);
    await refreshHistory(projectPath);
  }

  function addQueueItem(input: GenerateAssetInput, displayName: string): void {
    const taskInput = snapshotGenerateInput(input);
    setQueueItems((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        input: taskInput,
        status: "queued",
        createdAt: new Date().toISOString()
      }
    ]);
    setQueueMessage(t("generate.queueAdded", { name: displayName || taskInput.name || t(assetTypeLabel(taskInput.assetType)) }));
  }

  function patchQueueItem(id: string, patch: Partial<GenerationQueueItem>): void {
    setQueueItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeQueueItem(id: string): void {
    setQueueItems((current) => current.filter((item) => item.id !== id));
  }

  function retryQueueItem(id: string): void {
    patchQueueItem(id, { status: "queued", files: undefined, metadataPath: undefined, error: undefined });
  }

  function clearFinishedQueueItems(): void {
    setQueueItems((current) => current.filter((item) => item.status !== "done"));
  }

  function clearAllQueueItems(): void {
    if (queueRunning) return;
    setQueueItems([]);
    setQueueMessage("");
  }

  function pauseQueue(): void {
    queueStopRequested.current = true;
    setQueueMessage(t("generate.queuePausing"));
  }

  async function runQueue(): Promise<void> {
    if (queueRunning) return;
    if (!window.topspeedBuilder) {
      setQueueMessage(t("message.browserMode"));
      return;
    }

    const pending = queueItems.filter((item) => item.status === "queued");
    if (pending.length === 0) {
      setQueueMessage(t("generate.queueEmpty"));
      return;
    }

    queueStopRequested.current = false;
    setQueueRunning(true);
    setQueueMessage(t("generate.queueRunning", { count: pending.length, concurrency: queueConcurrency }));

    let done = 0;
    let failed = 0;
    const touchedProjectPaths = new Set<string>();
    const nextItems = [...pending];
    const workers = Array.from({ length: Math.min(Math.max(queueConcurrency, 1), nextItems.length) }, async () => {
      while (!queueStopRequested.current) {
        const item = nextItems.shift();
        if (!item) return;

        patchQueueItem(item.id, { status: "running", error: undefined, files: undefined, metadataPath: undefined });
        try {
          const result: GeneratedAssetResult = await unwrap(window.topspeedBuilder.generateAssets(item.input));
          done += 1;
          touchedProjectPaths.add(item.input.projectPath);
          patchQueueItem(item.id, {
            status: "done",
            files: result.files.length,
            metadataPath: result.metadataPath
          });
        } catch (error) {
          failed += 1;
          patchQueueItem(item.id, {
            status: "failed",
            error: formatQueueError(error)
          });
        }
      }
    });

    try {
      await Promise.all(workers);
      if (done > 0 && project?.path && touchedProjectPaths.has(project.path)) {
        await refreshGeneratedProjectData(project.path);
      }
      setQueueMessage(
        queueStopRequested.current
          ? t("generate.queuePaused", { done, failed })
          : t("generate.queueDone", { done, failed })
      );
    } finally {
      queueStopRequested.current = false;
      setQueueRunning(false);
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
                onClick={() => setPage(item.page)}
                title={item.label}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

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

        {message && <div className={message.includes("失败") || message.includes("错误") ? "notice error" : "notice"}>{message}</div>}

        {page === "home" && (
          <HomePage
            settings={settings}
            recentProjects={recentProjects}
            runTask={runTask}
            setProject={setProject}
            setPage={setPage}
            reloadRecent={refreshInitialState}
          />
        )}
        {page === "project" && project && (
          <ProjectPage
            project={project}
            runTask={runTask}
            onSaved={(nextProject) => {
              setProject(nextProject);
            }}
          />
        )}
        {page === "generate" && project && (
          <GeneratePage
            project={project}
            settings={settings}
            runTask={runTask}
            queuedReference={queuedReference}
            queueItems={queueItems}
            queueConcurrency={queueConcurrency}
            queueRunning={queueRunning}
            queueMessage={queueMessage}
            onQueuedReferenceConsumed={() => setQueuedReference(null)}
            onQueueAdd={addQueueItem}
            onQueueRun={runQueue}
            onQueuePause={pauseQueue}
            onQueueConcurrencyChange={setQueueConcurrency}
            onQueueRetry={retryQueueItem}
            onQueueRemove={removeQueueItem}
            onQueueClearDone={clearFinishedQueueItems}
            onQueueClearAll={clearAllQueueItems}
          />
        )}
        {page === "preview" && project && (
          <PreviewPage
            project={project}
            runTask={runTask}
            refreshProject={refreshProject}
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
        {page === "export" && project && <ExportPage project={project} runTask={runTask} />}
        {page === "history" && project && <HistoryPage project={project} history={history} />}
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
    </main>
  );
}

function HomePage(props: {
  settings: AppSettings;
  recentProjects: RecentProject[];
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  setProject: (project: Project) => void;
  setPage: (page: Page) => void;
  reloadRecent: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState<CreateProjectInput>({
    name: "演示角色资源",
    parentDirectory: props.settings.defaultProjectRoot,
    gameType: "RPG",
    style: "十六位像素风",
    defaultResolution: "32x32",
    defaultBackground: "transparent",
    exportTargets: ["unity", "godot", "tiled", "common"]
  });

  useEffect(() => {
    setInput((current) => ({ ...current, parentDirectory: props.settings.defaultProjectRoot }));
  }, [props.settings.defaultProjectRoot]);

  return (
    <div className="pageGrid two">
      <section className="panel">
        <PanelTitle icon={Plus} title={t("home.new.title")} subtitle={t("home.new.subtitle")} />
        <div className="formGrid">
          <TextInput label={t("field.projectName")} value={input.name} onChange={(name) => setInput({ ...input, name })} />
          <TextInput label={t("field.parentDir")} value={input.parentDirectory ?? ""} onChange={(parentDirectory) => setInput({ ...input, parentDirectory })} />
          <button
            className="ghostButton"
            onClick={async () => {
              const directory = await props.runTask(t("field.chooseDir"), () => unwrap(window.topspeedBuilder.chooseProjectRoot()));
              if (directory) setInput({ ...input, parentDirectory: directory });
            }}
          >
            <FolderOpen size={16} />
            {t("field.chooseDir")}
          </button>
          <SelectInput
            label={t("field.gameType")}
            value={input.gameType}
            options={gameTypeOptions.slice(0, 6)}
            onChange={(gameType) => setInput({ ...input, gameType })}
          />
          <SelectInput
            label={t("field.defaultSize")}
            value={input.defaultResolution}
            options={["16x16", "32x32", "64x64", "128x128"]}
            onChange={(defaultResolution) => setInput({ ...input, defaultResolution })}
          />
          <TextInput label={t("field.artStyle")} value={input.style} onChange={(style) => setInput({ ...input, style })} />
          <TargetPicker value={input.exportTargets} onChange={(exportTargets) => setInput({ ...input, exportTargets })} />
        </div>
        <button
          className="primaryButton"
          onClick={async () => {
            const project = await props.runTask(
              t("busy.createProject"),
              () => unwrap(window.topspeedBuilder.createProject(input)),
              (created) => `${t("message.created")}: ${created.path}`
            );
            if (project) {
              props.setProject(project);
              props.setPage("project");
              await props.reloadRecent();
            }
          }}
        >
          <Plus size={18} />
          {t("home.new.create")}
        </button>
      </section>

      <section className="panel">
        <PanelTitle icon={FolderOpen} title={t("home.open.title")} subtitle={t("home.open.subtitle")} />
        <button
          className="primaryButton secondary"
          onClick={async () => {
            const project = await props.runTask(t("busy.openProject"), () => unwrap(window.topspeedBuilder.openProjectDialog()));
            if (project) {
              props.setProject(project);
              props.setPage("generate");
              await props.reloadRecent();
            }
          }}
        >
          <FolderOpen size={18} />
          {t("home.open.button")}
        </button>
        <div className="recentList">
          {props.recentProjects.length === 0 && <EmptyState text={t("home.open.empty")} />}
          {props.recentProjects.map((item) => (
            <article key={item.path} className="recentItem">
              <div>
                <strong>{item.name}</strong>
                <span>{gameTypeLabelT(t, item.gameType)} · {item.style}</span>
                <small>{item.path}</small>
              </div>
              <div className="rowActions">
                <button
                  title={t("home.open.open")}
                  onClick={async () => {
                    const project = await props.runTask(t("busy.openRecent"), () => unwrap(window.topspeedBuilder.openProjectPath(item.path)));
                    if (project) {
                      props.setProject(project);
                      props.setPage("generate");
                    }
                  }}
                >
                  <Play size={15} />
                </button>
                <button
                  title={t("home.open.remove")}
                  onClick={async () => {
                    await props.runTask(t("busy.removeRecent"), () => unwrap(window.topspeedBuilder.removeRecentProject(item.path)));
                    await props.reloadRecent();
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProjectPage(props: {
  project: Project;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  onSaved: (project: Project) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Project>(props.project);
  const [newTemplate, setNewTemplate] = useState({ name: "赛博朋克霓虹风", description: "赛博朋克霓虹二维游戏美术，轮廓干净" });

  useEffect(() => setDraft(props.project), [props.project]);

  function addTemplate(): void {
    const template: StyleTemplate = {
      id: crypto.randomUUID(),
      name: newTemplate.name,
      description: newTemplate.description,
      lineWeight: "轮廓一致",
      lighting: "单主光",
      cameraView: "项目默认视角"
    };
    setDraft({ ...draft, styleTemplates: [template, ...draft.styleTemplates] });
  }

  function applyTemplate(template: StyleTemplate): void {
    setDraft({ ...draft, style: template.name, styleDescription: template.description });
  }

  return (
    <section className="panel wide">
      <PanelTitle icon={Gauge} title={t("project.title")} subtitle={t("project.subtitle")} />
      <div className="formGrid three">
        <TextInput label={t("field.projectName")} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
        <SelectInput
          label={t("field.gameType")}
          value={draft.gameType}
          options={gameTypeOptions}
          onChange={(gameType) => setDraft({ ...draft, gameType })}
        />
        <SelectInput
          label={t("field.defaultSize")}
          value={draft.defaultResolution}
          options={["16x16", "32x32", "64x64", "128x128"]}
          onChange={(defaultResolution) => setDraft({ ...draft, defaultResolution })}
        />
        <TextInput label={t("field.artStyle")} value={draft.style} onChange={(style) => setDraft({ ...draft, style })} />
        <SelectInput
          label={t("field.defaultBg")}
          value={draft.defaultBackground}
          options={backgroundOptions}
          onChange={(defaultBackground) => setDraft({ ...draft, defaultBackground: defaultBackground as Project["defaultBackground"] })}
        />
        <TextInput label={t("field.projectPath")} value={draft.path} disabled onChange={() => undefined} />
      </div>
      <TextArea label={t("project.styleDesc")} value={draft.styleDescription} onChange={(styleDescription) => setDraft({ ...draft, styleDescription })} />
      <TargetPicker value={draft.exportTargets} onChange={(exportTargets) => setDraft({ ...draft, exportTargets })} />

      <div className="panelTitle" style={{ border: "none", padding: "12px 0 0", marginTop: 4 }}>
        <div className="panelIcon"><Brush size={18} /></div>
        <div><h2>{t("style.templateTitle")}</h2><p>{t("style.templateSubtitle")}</p></div>
      </div>

      <div className="templateGrid">
        {draft.styleTemplates.length === 0 && <EmptyState text={t("style.empty")} />}
        {draft.styleTemplates.map((template) => (
          <article
            key={template.id}
            className="templateItem templateItemAction"
            role="button"
            tabIndex={0}
            title={t("style.templateTitle")}
            onClick={() => applyTemplate(template)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                applyTemplate(template);
              }
            }}
          >
            <button
              className="templateDelete"
              title={t("home.open.remove")}
              onClick={(event) => {
                event.stopPropagation();
                setDraft({ ...draft, styleTemplates: draft.styleTemplates.filter((item) => item.id !== template.id) });
              }}
            >
              <Trash2 size={13} />
            </button>
            <strong>{template.name}</strong>
            <span>{template.description}</span>
            <small>{template.lineWeight ?? "—"} · {template.lighting ?? "—"} · {template.cameraView ?? "—"}</small>
            <small className="templateHint">{t("preview.locate")}</small>
          </article>
        ))}
      </div>

      <div className="formGrid">
        <TextInput label={t("style.templateName")} value={newTemplate.name} onChange={(name) => setNewTemplate({ ...newTemplate, name })} />
        <TextInput label={t("style.templateDesc")} value={newTemplate.description} onChange={(description) => setNewTemplate({ ...newTemplate, description })} />
        <button className="ghostButton" style={{ alignSelf: "end" }} onClick={addTemplate}>
          <Plus size={16} />
          {t("style.addTemplate")}
        </button>
      </div>

      <button
        className="primaryButton"
        onClick={async () => {
          const saved = await props.runTask(t("busy.saveProject"), () => unwrap(window.topspeedBuilder.saveProject(draft)));
          if (saved) props.onSaved(saved);
        }}
      >
        <Save size={18} />
        {t("project.save")}
      </button>
    </section>
  );
}

function GeneratePage(props: {
  project: Project;
  settings: AppSettings;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  queuedReference: ReferenceDraft | null;
  queueItems: GenerationQueueItem[];
  queueConcurrency: number;
  queueRunning: boolean;
  queueMessage: string;
  onQueuedReferenceConsumed: () => void;
  onQueueAdd: (input: GenerateAssetInput, displayName: string) => void;
  onQueueRun: () => void;
  onQueuePause: () => void;
  onQueueConcurrencyChange: (value: number) => void;
  onQueueRetry: (id: string) => void;
  onQueueRemove: (id: string) => void;
  onQueueClearDone: () => void;
  onQueueClearAll: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const defaultPresets = useMemo(() => presetsFor("icon", props.project.defaultResolution), []);
  const [generationMode, setGenerationMode] = useState<GenerationMode>("text-to-image");
  const [assetType, setAssetType] = useState<AssetType>("icon");
  const detailTemplates = useMemo(() => objectDetailTemplates[assetType], [assetType]);
  const [name, setName] = useState(defaultPresets.name);
  const [description, setDescription] = useState(defaultPresets.description);
  const [detailPrompt, setDetailPrompt] = useState("");
  const [selectedDetailTemplateIds, setSelectedDetailTemplateIds] = useState<string[]>([]);
  const [referenceImages, setReferenceImages] = useState<ReferenceDraft[]>([]);
  const [editIntent, setEditIntent] = useState<EditIntent>("preserve-subject");
  const [referenceStrength, setReferenceStrength] = useState<ReferenceStrength>("medium");
  const [maskImage, setMaskImage] = useState<ReferenceDraft | null>(null);
  const [size, setSize] = useState(defaultPresets.size);
  const [count, setCount] = useState(props.settings.defaultGenerationCount);
  const [transparentBackground, setTransparentBackground] = useState(defaultPresets.transparentBackground);
  const [targets, setTargets] = useState<ExportTarget[]>(props.project.exportTargets);

  const [makeAtlas, setMakeAtlas] = useState(props.settings.autoPackAtlas);
  const [characterView, setCharacterView] = useState("side-view");
  const [animations, setAnimations] = useState<AnimationConfig[]>(defaultAnimations);
  const characterFrameTotal = useMemo(() => animations.reduce((sum, animation) => sum + Math.max(animation.frames, 0), 0), [animations]);
  const [makeSpriteSheet, setMakeSpriteSheet] = useState(true);
  const [tileTheme, setTileTheme] = useState("地牢");
  const [tileTypesText, setTileTypesText] = useState("地板\n墙体\n内角\n外角\n门\n水池\n裂缝\n宝箱");
  const [tileSeamless, setTileSeamless] = useState(true);
  const [makeTiled, setMakeTiled] = useState(true);

  useEffect(() => {
    const queued = props.queuedReference;
    if (!queued) return;

    setGenerationMode("image-to-image");
    setEditIntent("preserve-subject");
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

  function handleAssetTypeChange(newType: AssetType): void {
    setAssetType(newType);
    const { name: n, description: d, size: s, transparentBackground: t } = presetsFor(newType, props.project.defaultResolution);
    setName(n);
    setDescription(d);
    setDetailPrompt("");
    setSelectedDetailTemplateIds([]);
    setSize(s);
    setTransparentBackground(t);
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

  const input: GenerateAssetInput = {
    projectPath: props.project.path,
    generationMode,
    assetType,
    name,
    description,
    detailPrompt,
    referenceImages: generationMode === "image-to-image" ? referenceImages.map(toReferenceInput) : [],
    editIntent,
    referenceStrength,
    maskImagePath: generationMode === "image-to-image" && editIntent === "inpaint" ? maskImage?.path : undefined,
    size,
    count,
    transparentBackground,
    exportTargets: targets,
    iconItems: [],
    makeAtlas,
    characterView,
    animations,
    makeSpriteSheet,
    tileTheme,
    tileTypes: splitLines(tileTypesText),
    tileSeamless,
    makeTiled
  };

  return (
    <div className="pageGrid generation">
      <section className="panel">
        <PanelTitle icon={Wand2} title={t("generate.title")} subtitle={t("generate.subtitle", { provider: t(providerLabel(props.settings.aiProvider)), model: props.settings.model })} />
        {props.settings.aiProvider === "local-draft" && (
          <div className="inlineWarning">
            {t("generate.draftWarning")}
          </div>
        )}
        <div className="typeRail">
          {assetTypes.map((type) => (
            <button key={type.value} className={assetType === type.value ? "selected" : ""} onClick={() => handleAssetTypeChange(type.value)}>
              {t(type.label)}
            </button>
          ))}
        </div>

        <div className="modeRail">
          {generationModes.map((mode) => (
            <button
              key={mode.value}
              type="button"
              className={generationMode === mode.value ? "selected" : ""}
              onClick={() => setGenerationMode(mode.value)}
            >
              {t(mode.label)}
            </button>
          ))}
        </div>

        <div className="inlineNote">
          {t("generate.templateHint")}
        </div>
        {generationMode === "image-to-image" && (
          <ReferenceImagePanel
            project={props.project}
            value={referenceImages}
            maskImage={maskImage}
            editIntent={editIntent}
            referenceStrength={referenceStrength}
            runTask={props.runTask}
            onChange={setReferenceImages}
            onMaskChange={setMaskImage}
            onEditIntentChange={setEditIntent}
            onReferenceStrengthChange={setReferenceStrength}
          />
        )}
        <div className="formGrid">
          <TextInput label={t("generate.name")} value={name} onChange={setName} />
          <TextInput label={t("generate.size")} value={size} onChange={setSize} />
          <NumberInput
            label={assetType === "character" ? t("generate.characterVersions") : t("generate.count")}
            value={count}
            min={1}
            max={assetType === "character" ? 8 : 64}
            onChange={setCount}
          />
        </div>
        <TextArea label={t("generate.desc")} value={description} onChange={setDescription} />
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
        <TextArea label={t("generate.detailPrompt")} value={detailPrompt} onChange={handleDetailPromptChange} />
        <Toggle label={t("generate.transparent")} value={transparentBackground} onChange={setTransparentBackground} />
        <TargetPicker value={targets} onChange={setTargets} />

        {(assetType === "icon" || assetType === "item" || assetType === "ui") && (
          <div className="subPanel">
            <Toggle label={t("generate.makeAtlas")} value={makeAtlas} onChange={setMakeAtlas} />
          </div>
        )}

        {assetType === "character" && (
          <div className="subPanel">
            <div className="inlineNote compactNote">
              {t("generate.characterSheetPlan", {
                versions: count,
                frames: characterFrameTotal,
                calls: Math.max(count, 0) * (characterFrameTotal + 1)
              })}
            </div>
            <SelectInput
              label={t("generate.characterView")}
              value={characterView}
              options={characterViewOptions}
              onChange={setCharacterView}
            />
            <AnimationEditor value={animations} onChange={setAnimations} />
            <Toggle label={t("generate.makeSheet")} value={makeSpriteSheet} onChange={setMakeSpriteSheet} />
          </div>
        )}

        {assetType === "tileset" && (
          <div className="subPanel">
            <TextInput label={t("generate.tileTheme")} value={tileTheme} onChange={setTileTheme} />
            <TextArea label={t("generate.tileTypes")} value={tileTypesText} onChange={setTileTypesText} />
            <Toggle label={t("generate.tileSeamless")} value={tileSeamless} onChange={setTileSeamless} />
            <Toggle label={t("generate.makeTiled")} value={makeTiled} onChange={setMakeTiled} />
          </div>
        )}

      </section>

      <section className="panel">
        <PanelTitle icon={Archive} title={t("generate.execute")} subtitle={t("generate.executeSubtitle")} />
        <TaskSummary input={input} />
        <QueuePanel
          items={props.queueItems}
          concurrency={props.queueConcurrency}
          running={props.queueRunning}
          message={props.queueMessage}
          canAdd={!(generationMode === "image-to-image" && referenceImages.length === 0)}
          onAdd={() => props.onQueueAdd(input, input.name || t(assetTypeLabel(input.assetType)))}
          onRun={props.onQueueRun}
          onPause={props.onQueuePause}
          onConcurrencyChange={props.onQueueConcurrencyChange}
          onRetry={props.onQueueRetry}
          onRemove={props.onQueueRemove}
          onClearDone={props.onQueueClearDone}
          onClearAll={props.onQueueClearAll}
        />
      </section>
    </div>
  );
}

function TaskSummary(props: { input: GenerateAssetInput }): JSX.Element {
  const { t } = useTranslation();
  const input = props.input;
  const yesNo = (val: boolean) => val ? t("quality.high") : t("quality.low");
  const characterFrameTotal = input.animations.reduce((sum, animation) => sum + Math.max(animation.frames, 0), 0);
  const lines = [
    ["mode", input.generationMode === "image-to-image" ? t("mode.image-to-image") : t("mode.text-to-image")],
    ["type", t("assetType." + input.assetType)],
    ["name", input.name || "—"],
    ["size", input.size],
    [input.assetType === "character" ? "characterVersions" : "count", `${input.count}`],
    ["transparent", yesNo(input.transparentBackground)],
    ["targets", input.exportTargets.map((et) => t("target." + et)).join(", ") || "—"],
    ["atlas", yesNo(input.makeAtlas)],
    ["sheet", yesNo(input.makeSpriteSheet)],
    ["tiled", yesNo(input.makeTiled)]
  ];

  if (input.assetType === "character") {
    lines.splice(5, 0, ["framesPerVersion", `${characterFrameTotal}`]);
  }

  if (input.generationMode === "image-to-image") {
    lines.push(["refs", `${input.referenceImages.length}`]);
    lines.push(["intent", t("intent." + input.editIntent)]);
    lines.push(["strength", t("strength." + input.referenceStrength)]);
    lines.push(["mask", input.maskImagePath ? "✓" : "—"]);
  }

  return (
    <div className="taskSummary">
      {lines.map(([key, value]) => (
        <div key={key}>
          <span>{t("summary." + key)}</span>
          <strong>{value}</strong>
        </div>
      ))}
      <section>
        <span>{t("generate.desc")}</span>
        <p>{input.description || "—"}</p>
      </section>
      {input.detailPrompt && (
        <section>
          <span>{t("summary.detail")}</span>
          <p>{input.detailPrompt}</p>
        </section>
      )}
      {input.generationMode === "image-to-image" && input.referenceImages.length > 0 && (
        <section>
          <span>{t("summary.refRoles")}</span>
          <p>
            {input.referenceImages
              .map((image, index) => `${t("summary.refN", { n: index + 1 })}：${t("role." + image.role)}`)
              .join("；")}
          </p>
        </section>
      )}
    </div>
  );
}

function QueuePanel(props: {
  items: GenerationQueueItem[];
  concurrency: number;
  running: boolean;
  message: string;
  canAdd: boolean;
  onAdd: () => void;
  onRun: () => void;
  onPause: () => void;
  onConcurrencyChange: (value: number) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onClearDone: () => void;
  onClearAll: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const queued = props.items.filter((item) => item.status === "queued").length;
  const done = props.items.filter((item) => item.status === "done").length;
  const failed = props.items.filter((item) => item.status === "failed").length;

  return (
    <div className="queuePanel">
      <div className="queueHeader">
        <div>
          <strong>{t("generate.queueTitle")}</strong>
          <span>{t("generate.queueSubtitle", { total: props.items.length, queued, done, failed })}</span>
        </div>
        <div className="queueConcurrency">
          <span className="queueConcurrencyLabel" title={t("generate.queueConcurrency")}>{t("generate.queueConcurrency")}</span>
          {[1, 2, 3].map((value) => (
            <button
              key={value}
              type="button"
              className={props.concurrency === value ? "selected" : ""}
              disabled={props.running}
              onClick={() => props.onConcurrencyChange(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="queueActions">
        <button type="button" className="ghostButton" disabled={!props.canAdd} onClick={props.onAdd}>
          <Plus size={15} />
          {t("generate.queueAdd")}
        </button>
        <button type="button" className="ghostButton" disabled={props.running || queued === 0} onClick={props.onRun}>
          <Play size={15} />
          {t("generate.queueStart")}
        </button>
        <button type="button" className="ghostButton" disabled={!props.running} onClick={props.onPause}>
          <Pause size={15} />
          {t("generate.queuePause")}
        </button>
        <button type="button" className="ghostButton" disabled={props.running || done === 0} onClick={props.onClearDone}>
          <Check size={15} />
          {t("generate.queueClearDone")}
        </button>
        <button type="button" className="ghostButton" disabled={props.running || props.items.length === 0} onClick={props.onClearAll}>
          <Trash2 size={15} />
          {t("generate.queueClearAll")}
        </button>
      </div>

      {props.message && <div className="queueMessage">{props.message}</div>}

      <div className="queueList">
        {props.items.length === 0 && <EmptyState text={t("generate.queueEmptyState")} />}
        {props.items.map((item, index) => (
          <article key={item.id} className={`queueItem ${item.status}`}>
            <div className="queueItemMain">
              <small>{String(index + 1).padStart(2, "0")} · {t("assetType." + item.input.assetType)}</small>
              <strong>{item.input.name || "—"}</strong>
              <span>{item.input.size} · {item.input.count} · {item.input.generationMode === "image-to-image" ? t("mode.image-to-image") : t("mode.text-to-image")}</span>
              {item.status === "done" && <em>{t("generate.queueResult", { count: item.files ?? 0 })}</em>}
              {item.error && <code>{item.error}</code>}
            </div>
            <div className="queueItemActions">
              <span>{t("generate.queueStatus." + item.status)}</span>
              {item.status === "running" && <Loader2 size={14} className="spin" />}
              {item.status === "failed" && (
                <button type="button" onClick={() => props.onRetry(item.id)}>
                  <RefreshCw size={14} />
                </button>
              )}
              {!props.running && item.status !== "running" && (
                <button type="button" onClick={() => props.onRemove(item.id)}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ReferenceImagePanel(props: {
  project: Project;
  value: ReferenceDraft[];
  maskImage: ReferenceDraft | null;
  editIntent: EditIntent;
  referenceStrength: ReferenceStrength;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  onChange: (value: ReferenceDraft[]) => void;
  onMaskChange: (value: ReferenceDraft | null) => void;
  onEditIntentChange: (value: EditIntent) => void;
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

  async function importMask(): Promise<void> {
    const imported = await props.runTask(
      t("busy.importMask"),
      () => unwrap(window.topspeedBuilder.chooseMaskImage(props.project.path)),
      () => t("message.maskImported")
    );
    if (imported) props.onMaskChange(imported);
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
          <button className="ghostButton" type="button" onClick={importReferences} disabled={props.value.length >= 4}>
            <Plus size={15} />
            {t("generate.importRef")}
          </button>
          <button className="ghostButton" type="button" onClick={() => props.onChange([])} disabled={props.value.length === 0}>
            <Trash2 size={15} />
            {t("generate.clear")}
          </button>
        </div>
      </div>

      <div className="formGrid">
        <SelectInput
          label={t("generate.editIntent")}
          value={props.editIntent}
          options={editIntentOptions}
          onChange={(value) => props.onEditIntentChange(value as EditIntent)}
        />
        <SelectInput
          label={t("generate.refStrength")}
          value={props.referenceStrength}
          options={referenceStrengthOptions}
          onChange={(value) => props.onReferenceStrengthChange(value as ReferenceStrength)}
        />
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

      {props.editIntent === "inpaint" && (
        <div className="maskPanel">
          <div>
            <strong>{t("generate.mask")}</strong>
            <span>{props.maskImage ? props.maskImage.name ?? props.maskImage.path : t("generate.maskHint")}</span>
          </div>
          <button className="ghostButton" type="button" onClick={importMask}>
            <Brush size={15} />
            {t("generate.selectMask")}
          </button>
          {props.maskImage && (
            <button className="miniClearButton" type="button" onClick={() => props.onMaskChange(null)}>
              {t("generate.removeMask")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewPage(props: {
  project: Project;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  refreshProject: () => Promise<Project | null>;
  onUseAsReference: (asset: Asset, filePath: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="panel wide">
      <PanelTitle icon={Image} title={t("preview.title")} subtitle={t("preview.subtitle", { count: props.project.assets.length })} />
      <div className="assetGrid">
        {props.project.assets.length === 0 && <EmptyState text={t("preview.empty")} />}
        {props.project.assets.map((asset) => (
          <AssetCard
            key={asset.id}
            project={props.project}
            asset={asset}
            runTask={props.runTask}
            onUseAsReference={props.onUseAsReference}
            onDelete={async () => { await props.refreshProject(); }}
          />
        ))}
      </div>
      <button className="ghostButton" onClick={() => props.refreshProject()}>
        <RefreshCw size={16} />
        {t("preview.refresh")}
      </button>
    </section>
  );
}

function ExportPage(props: {
  project: Project;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
}): JSX.Element {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<ExportTarget[]>(props.project.exportTargets);
  const [includeZip, setIncludeZip] = useState(true);

  return (
    <section className="panel wide">
      <PanelTitle icon={Package} title={t("export.title")} subtitle={t("export.subtitle")} />
      <TargetPicker value={targets} onChange={setTargets} />
      <Toggle label={t("export.includeZip")} value={includeZip} onChange={setIncludeZip} />
      <button
        className="primaryButton"
        onClick={async () => {
          const result = await props.runTask(
            t("busy.exportAssets"),
            () => unwrap(window.topspeedBuilder.exportProject({ projectPath: props.project.path, targets, includeZip })),
            (exported) => t("export.done", { count: exported.files.length, dir: exported.exportRoot })
          );
          if (result) {
            await window.topspeedBuilder.openPath(result.exportRoot);
          }
        }}
      >
        <Download size={18} />
        {t("export.button")}
      </button>
    </section>
  );
}

function HistoryPage(props: { project: Project; history: GenerationHistoryRecord[] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="panel wide">
      <PanelTitle icon={History} title={t("history.title")} subtitle={t("history.subtitle", { count: props.history.length })} />
      <div className="historyList">
        {props.history.length === 0 && <EmptyState text={t("history.empty")} />}
        {props.history.map((record) => (
          <article key={record.id} className="historyItem">
            <div>
              <strong>{record.parameters.name || record.assetType}</strong>
              <span>
                {t("assetType." + record.assetType)} · {record.parameters.generationMode === "image-to-image" ? t("mode.image-to-image") : t("mode.text-to-image")} ·{" "}
                {new Date(record.createdAt).toLocaleString()}
              </span>
              <small>{record.outputFiles.join(" · ")}</small>
            </div>
            <code>{record.prompt.slice(0, 240)}</code>
          </article>
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

  return (
    <section className="panel wide">
      <PanelTitle icon={Settings} title={t("settings.title")} subtitle={t("settings.subtitle")} />
      <div className="formGrid three">
        <SelectInput
          label={t("settings.aiProvider")}
          value={draft.aiProvider}
          options={providerOptions}
          onChange={(aiProvider) => setDraft({ ...draft, aiProvider: aiProvider as AppSettings["aiProvider"] })}
        />
        {draft.aiProvider === "custom" && (
          <SelectInput
            label={t("settings.customApiFormat")}
            value={draft.customApiFormat}
            options={apiFormatOptions}
            onChange={(customApiFormat) => setDraft({ ...draft, customApiFormat: customApiFormat as AppSettings["customApiFormat"] })}
          />
        )}
        <TextInput label={t("settings.apiBaseUrl")} value={draft.apiBaseUrl} onChange={(apiBaseUrl) => setDraft({ ...draft, apiBaseUrl })} />
        <TextInput label={t("settings.apiKey")} value={draft.apiKey} type="password" onChange={(apiKey) => setDraft({ ...draft, apiKey })} />
        <SelectInput
          label={t("settings.quality")}
          value={draft.generationQuality}
          options={qualityOptions}
          onChange={(generationQuality) => setDraft({ ...draft, generationQuality: generationQuality as AppSettings["generationQuality"] })}
        />
        <TextInput label={t("settings.defaultProjectDir")} value={draft.defaultProjectRoot} onChange={(defaultProjectRoot) => setDraft({ ...draft, defaultProjectRoot })} />
        <TextInput label={t("settings.defaultExportDir")} value={draft.defaultExportDirectory} onChange={(defaultExportDirectory) => setDraft({ ...draft, defaultExportDirectory })} />
        <TextInput label={t("settings.defaultImageSize")} value={draft.defaultImageSize} onChange={(defaultImageSize) => setDraft({ ...draft, defaultImageSize })} />
        <NumberInput
          label={t("settings.defaultGenCount")}
          value={draft.defaultGenerationCount}
          min={1}
          max={64}
          onChange={(defaultGenerationCount) => setDraft({ ...draft, defaultGenerationCount })}
        />
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
          disabled={fetchingModels || draft.aiProvider === "local-draft"}
          onClick={fetchModels}
        >
          {fetchingModels ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          <span>{fetchingModels ? t("settings.fetchingModels") : t("settings.fetchModels")}</span>
        </button>
        <button
          className="primaryButton"
          style={{ marginBottom: 0, whiteSpace: "nowrap" }}
          disabled={testing || draft.aiProvider === "local-draft"}
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
      <div className="toggleRow">
        <Toggle label={t("settings.savePromptHistory")} value={draft.savePromptHistory} onChange={(savePromptHistory) => setDraft({ ...draft, savePromptHistory })} />
        <Toggle label={t("settings.autoTransparent")} value={draft.autoTransparent} onChange={(autoTransparent) => setDraft({ ...draft, autoTransparent })} />
        <Toggle label={t("settings.autoTrim")} value={draft.autoTrim} onChange={(autoTrim) => setDraft({ ...draft, autoTrim })} />
        <Toggle label={t("settings.autoPackAtlas")} value={draft.autoPackAtlas} onChange={(autoPackAtlas) => setDraft({ ...draft, autoPackAtlas })} />
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

function selectPreviewFile(asset: Asset): string | undefined {
  const pngFiles = asset.files.filter((file) => file.toLowerCase().endsWith(".png"));
  if (asset.type === "character") {
    return asset.sheetPath ?? pngFiles.find((file) => file.includes("source_sheet")) ?? pngFiles[0];
  }
  return pngFiles[0] ?? asset.atlasPath;
}

function AssetCard(props: {
  project: Project;
  asset: Asset;
  runTask: <T>(label: string, task: () => Promise<T>, success?: (result: T) => string) => Promise<T | null>;
  onUseAsReference?: (asset: Asset, filePath: string) => void;
  onDelete?: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const pngFile = selectPreviewFile(props.asset);
  const [dataUrl, setDataUrl] = useState("");

  useEffect(() => {
    let alive = true;
    setDataUrl("");
    if (pngFile) {
      window.topspeedBuilder.readImageDataUrl(props.project.path, pngFile).then((result) => {
        if (alive && result.ok && result.data) setDataUrl(result.data);
        if (alive && (!result.ok || !result.data)) setDataUrl("");
      });
    }
    return () => {
      alive = false;
    };
  }, [pngFile, props.project.path]);

  return (
    <article className="assetCard">
      <div className="assetPreview">{dataUrl ? <img src={dataUrl} alt={props.asset.name} /> : <Boxes size={42} />}</div>
      <div className="assetBody">
        <strong>{props.asset.name}</strong>
        <span>{t("assetType." + props.asset.type)} · {props.asset.size.width}x{props.asset.size.height}</span>
        <small>{props.asset.files.length} {t("preview.files")}</small>
      </div>
      <div className="assetActions">
        {props.asset.generationMode === "image-to-image" && <Pill>参考图</Pill>}
        {props.asset.sheetPath && <Pill>精灵表</Pill>}
        {props.asset.atlasPath && <Pill>图集</Pill>}
        {props.asset.metadataPath && <Pill>元数据</Pill>}
      </div>
      {props.asset.exportTargets && props.asset.exportTargets.length > 0 && (
        <div className="assetActions" style={{ gap: 4 }}>
          {props.asset.exportTargets.map((target) => (
            <span key={target} className="pill" style={{ borderColor: "rgba(0,212,255,0.25)", color: "var(--cyan)", background: "var(--cyan-dim)" }}>{t("target." + target)}</span>
          ))}
        </div>
      )}
      <div className="assetActions" style={{ marginTop: "auto" }}>
        {pngFile && props.onUseAsReference && (
          <button className="ghostButton" onClick={() => props.onUseAsReference?.(props.asset, pngFile)}>
            <Image size={15} />
            参考
          </button>
        )}
        <button
          className="ghostButton"
          onClick={() => {
            const file = props.asset.metadataPath ?? pngFile;
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

function AnimationEditor(props: { value: AnimationConfig[]; onChange: (value: AnimationConfig[]) => void }): JSX.Element {
  const { t } = useTranslation();

  function update(index: number, patch: Partial<AnimationConfig>): void {
    props.onChange(props.value.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number): void {
    props.onChange(props.value.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <div className="animationEditor">
      <label>{t("generate.animFrames")}</label>
      <p className="animationHelp">{t("generate.animHelp")}</p>
      <div className="animationHeader" aria-hidden="true">
        <span>{t("generate.animName")}</span>
        <span>{t("generate.animFrameCount")}</span>
        <span>{t("generate.animFps")}</span>
        <span>{t("generate.animLoop")}</span>
        <span />
      </div>
      {props.value.map((animation, index) => (
        <div key={`${animation.name}-${index}`} className="animationRow">
          <input
            aria-label={t("generate.animName")}
            title={t("generate.animName")}
            value={animation.name}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <input
            type="number"
            min={1}
            max={12}
            aria-label={t("generate.animFrameCountHint")}
            title={t("generate.animFrameCountHint")}
            value={animation.frames}
            onChange={(event) => update(index, { frames: Number(event.target.value) })}
          />
          <input
            type="number"
            min={1}
            max={30}
            aria-label={t("generate.animFpsHint")}
            title={t("generate.animFpsHint")}
            value={animation.fps}
            onChange={(event) => update(index, { fps: Number(event.target.value) })}
          />
          <button type="button" title={t("generate.animLoopHint")} onClick={() => update(index, { loop: !animation.loop })}>
            {animation.loop ? t("generate.loop") : t("generate.once")}
          </button>
          <button
            type="button"
            className="animDelete"
            title={t("generate.removeAnim")}
            aria-label={t("generate.removeAnim")}
            disabled={props.value.length <= 1}
            onClick={() => remove(index)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        className="ghostButton"
        type="button"
        onClick={() => props.onChange([...props.value, { name: "受击", frames: 4, fps: 8, loop: false }])}
      >
        <Plus size={15} />
        {t("generate.addAnim")}
      </button>
    </div>
  );
}

function PanelTitle(props: { icon: typeof Home; title: string; subtitle: string }): JSX.Element {
  const Icon = props.icon;
  return (
    <div className="panelTitle">
      <div className="panelIcon">
        <Icon size={18} />
      </div>
      <div>
        <h2>{props.title}</h2>
        <p>{props.subtitle}</p>
      </div>
    </div>
  );
}

function TextInput(props: {
  label: string;
  value: string;
  type?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function NumberInput(props: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }): JSX.Element {
  return (
    <label className="field">
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

function TextArea(props: { label: string; value: string; onChange: (value: string) => void }): JSX.Element {
  return (
    <label className="field full">
      <span>{props.label}</span>
      <textarea value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

function SelectInput(props: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <label className="field">
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

function Toggle(props: { label: string; value: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <button className={props.value ? "toggle on" : "toggle"} onClick={() => props.onChange(!props.value)}>
      <span>{props.label}</span>
      <i />
    </button>
  );
}

function TargetPicker(props: { value: ExportTarget[]; onChange: (value: ExportTarget[]) => void }): JSX.Element {
  const { t } = useTranslation();
  function toggle(target: ExportTarget): void {
    props.onChange(props.value.includes(target) ? props.value.filter((item) => item !== target) : [...props.value, target]);
  }

  return (
    <div className="targetPicker">
      <span>{t("targetPicker.label")}</span>
      <div>
        {exportTargets.map((target) => (
          <button key={target} className={props.value.includes(target) ? "selected" : ""} onClick={() => toggle(target)}>
            {t("target." + target)}
          </button>
        ))}
      </div>
    </div>
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
    project: "项目配置",
    generate: "素材生成",
    preview: "素材预览",
    export: "资源导出",
    history: "历史记录",
    settings: "应用设置"
  };
  return labels[page];
}

function presetsFor(type: AssetType, defaultSize: string): { name: string; description: string; size: string; transparentBackground: boolean } {
  switch (type) {
    case "character":
      return { name: "骑士", description: "银色盔甲骑士，手持短剑", size: "64x64", transparentBackground: true };
    case "tileset":
      return { name: "地牢", description: "石质地牢模块化瓦片集", size: "32x32", transparentBackground: false };
    case "icon":
      return { name: "角色扮演道具", description: "中世纪背包图标，轮廓清晰易识别", size: defaultSize, transparentBackground: true };
    case "item":
      return { name: "角色扮演道具", description: "中世纪背包道具，轮廓清晰易识别", size: defaultSize, transparentBackground: true };
    case "enemy":
      return { name: "史莱姆", description: "小型地牢软体怪，轮廓清晰", size: defaultSize, transparentBackground: true };
    case "ui":
      return { name: "界面面板", description: "游戏界面面板元素，干净扁平风格", size: defaultSize, transparentBackground: true };
    case "background":
      return { name: "森林背景", description: "横版卷轴森林背景层", size: "128x128", transparentBackground: false };
    case "effect":
      return { name: "火焰特效", description: "火焰爆炸粒子精灵表", size: "64x64", transparentBackground: true };
  }
}

function splitLines(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function snapshotGenerateInput(source: GenerateAssetInput): GenerateAssetInput {
  return {
    ...source,
    referenceImages: source.referenceImages.map((reference) => ({ ...reference })),
    exportTargets: [...source.exportTargets],
    iconItems: [...source.iconItems],
    animations: source.animations.map((animation) => ({ ...animation })),
    tileTypes: [...source.tileTypes]
  };
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

function providerLabel(provider: AppSettings["aiProvider"]): string {
  const found = providerOptions.find((option) => selectOptionValue(option) === provider);
  return found ? selectOptionLabel(found) : provider;
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

function formatQueueError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
}

async function unwrap<T>(request: Promise<IpcResponse<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) {
    throw new Error(result.error ?? "未知错误");
  }
  return result.data as T;
}

export default App;
