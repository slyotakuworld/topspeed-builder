import { useTranslation } from "react-i18next";
import i18n, { switchLanguage } from "./i18n";
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Boxes,
  Check,
  Download,
  FolderOpen,
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
  { value: "pixel", label: "generate.style.pixel", text: "像素画风（pixel art）：边缘清晰，轮廓干净，色板克制，无模糊渐变" },
  { value: "chibi", label: "generate.style.chibi", text: "Q版画风：大头小身比例，圆润可爱，线条简洁明快" },
  { value: "cartoon", label: "generate.style.cartoon", text: "卡通画风：明快色彩，清晰描边，扁平干净的卡通渲染" },
  { value: "retro16", label: "generate.style.retro16", text: "16位复古游戏美术：细腻渐变与抖动阴影，清晰轮廓，像素颗粒感" },
  { value: "realistic", label: "generate.style.realistic", text: "写实画风：厚涂质感，光影自然，注重体积与细节" }
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
/* 画布尺寸：下拉预设，选「自定义」时才手填 */
const sizeOptions: SelectOption[] = ["512x512", "1024x1024", "1024x1536", "1536x1024"];
const sizeCustomValue = "custom";
const sizeSelectOptions: SelectOption[] = [...sizeOptions, { value: sizeCustomValue, label: "generate.sizeCustom" }];
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
  { value: "icon", label: "assetType.icon" },
  { value: "item", label: "assetType.item" },
  { value: "character", label: "assetType.character" },
  { value: "enemy", label: "assetType.enemy" },
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

function App(): JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState<Page>("home");
  const [project, setProject] = useState<Project | null>(null);
  const [homeProjects, setHomeProjects] = useState<RecentProject[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [queuedReference, setQueuedReference] = useState<ReferenceDraft | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

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

  async function runTask<T>(label: string, task: () => Promise<T>, success?: (result: T) => string): Promise<T | null> {
    setBusy(label);
    setMessage("");
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
        {page === "generate" && project && (
          <GeneratePage
            project={project}
            settings={settings}
            runTask={runTask}
            queuedReference={queuedReference}
            onQueuedReferenceConsumed={() => setQueuedReference(null)}
            onCommitted={async () => {
              await refreshProject(project.path);
            }}
          />
        )}
        {page === "assets" && project && (
          <AssetsPage
            project={project}
            exportDirectory={settings.defaultExportDirectory}
            runTask={runTask}
            refreshProject={refreshProject}
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
  const [customSize, setCustomSize] = useState("");
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
  const [sliceShiftX, setSliceShiftX] = useState(0);
  const [sliceShiftY, setSliceShiftY] = useState(0);
  const [sliceShrink, setSliceShrink] = useState(8);

  // 美术风格：预设直出，自定义才需填风格描述
  const selectedStyleText =
    stylePreset === styleCustomValue
      ? customStyle.trim()
      : stylePresets.find((preset) => preset.value === stylePreset)?.text ?? "";
  const styleReady = stylePreset !== styleCustomValue || customStyle.trim().length > 0;
  const styleOptions = useMemo<SelectOption[]>(
    () => [...stylePresetOptions, { value: styleCustomValue, label: "generate.style.custom" }],
    []
  );

  useEffect(() => {
    setDraft(null);
    setGridDataUrl("");
  }, [props.project.path]);

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
    window.topspeedBuilder.readImageDataUrl(props.project.path, draft.gridImagePath).then((result) => {
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
      size: sizePreset === sizeCustomValue ? customSize.trim() || "1024x1024" : sizePreset,
      count,
      cellNames: splitLines(cellNamesText),
      quality,
      style: selectedStyleText,
      transparentBackground,
      trimEdges
    };
  }

  async function generateDraft(): Promise<void> {
    if (!styleReady) return;
    setDraft(null);
    const nextDraft = await props.runTask(
      t("busy.generateGrid"),
      () => unwrap(window.topspeedBuilder.generateGrid(buildInput()))
    );
    if (nextDraft) {
      setDraft(nextDraft);
    }
  }

  async function commitDraft(): Promise<void> {
    if (!draft) return;
    const options: GridSliceOptions = {
      cols: sliceCols,
      rows: sliceRows,
      shiftX: sliceShiftX,
      shiftY: sliceShiftY,
      shrinkPercent: sliceShrink
    };
    const result = await props.runTask(
      t("busy.commitSlice"),
      () => unwrap(window.topspeedBuilder.commitSlice(buildInput(), draft, options)),
      (committed) => t("generate.commitDone", { count: committed.files.length })
    );
    if (result) {
      setDraft(null);
      await props.onCommitted();
    }
  }

  const previewLines = draft
    ? {
        vertical: Array.from({ length: Math.max(1, sliceCols) - 1 }, (_, i) => (i + 1) / sliceCols),
        horizontal: Array.from({ length: Math.max(1, sliceRows) - 1 }, (_, i) => (i + 1) / sliceRows)
      }
    : null;

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
            <TextArea label={t("generate.styleCustom")} value={customStyle} onChange={setCustomStyle} />
            {!styleReady && <div className="inlineWarning">{t("generate.styleCustomEmpty")}</div>}
          </>
        )}

        <div className="formGrid three">
          <SelectInput
            label={t("generate.size")}
            value={sizePreset}
            options={sizeSelectOptions}
            onChange={(next) => setSizePreset(String(next))}
          />
          <NumberInput label={t("generate.count")} value={count} min={1} max={36} onChange={setCount} />
          <SelectInput
            label={t("generate.quality")}
            value={quality}
            options={qualityOptions}
            onChange={(next) => setQuality(next as GenerationQuality)}
          />
        </div>
        {sizePreset === sizeCustomValue && (
          <TextInput label={t("generate.sizeCustom")} value={customSize} onChange={setCustomSize} />
        )}
        <TextArea label={t("generate.desc")} value={description} onChange={setDescription} />

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
        <TextArea label={t("generate.detailPrompt")} value={detailPrompt} onChange={handleDetailPromptChange} />
        <TextArea label={t("generate.cellNames")} value={cellNamesText} onChange={setCellNamesText} />
      </section>

      <section className="panel">
        <PanelTitle icon={Archive} title={t("generate.draft")} />
        {!draft ? (
          <>
            <EmptyState text={t("generate.draftEmpty")} />
            <button className="primaryButton" disabled={!styleReady} onClick={() => void generateDraft()}>
              <Sparkles size={18} />
              {t("generate.genGrid")}
            </button>
          </>
        ) : (
          <>
            <div className="formGrid">
              <NumberInput label={t("generate.sliceCols")} value={sliceCols} min={1} max={24} onChange={setSliceCols} />
              <NumberInput label={t("generate.sliceRows")} value={sliceRows} min={1} max={24} onChange={setSliceRows} />
              <NumberInput label={t("generate.sliceShiftX")} value={sliceShiftX} min={-256} max={256} onChange={setSliceShiftX} />
              <NumberInput label={t("generate.sliceShiftY")} value={sliceShiftY} min={-256} max={256} onChange={setSliceShiftY} />
              <NumberInput label={t("generate.sliceShrink")} value={sliceShrink} min={0} max={30} onChange={setSliceShrink} />
            </div>
            <div className="inlineNote compactNote">
              {t("generate.sliceHint")}
            </div>
            {gridDataUrl && previewLines && (
              <div className="gridStage">
                <img src={gridDataUrl} alt={t("generate.draft")} />
                {previewLines.vertical.map((position) => (
                  <span key={`v-${position}`} className="gridLine vertical" style={{ left: `${position * 100}%` }} />
                ))}
                {previewLines.horizontal.map((position) => (
                  <span key={`h-${position}`} className="gridLine horizontal" style={{ top: `${position * 100}%` }} />
                ))}
              </div>
            )}
            <div className="assetActions">
              <button className="primaryButton" onClick={() => void commitDraft()}>
                <Check size={18} />
                {t("generate.commit")}
              </button>
              <button className="ghostButton" onClick={() => void generateDraft()}>
                <RefreshCw size={16} />
                {t("generate.regenGrid")}
              </button>
              <button className="ghostButton" onClick={() => setDraft(null)}>
                <Trash2 size={16} />
                {t("generate.discard")}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
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
            onDelete={async () => { await props.refreshProject(); }}
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
        <TextInput label={t("settings.apiBaseUrl")} value={draft.apiBaseUrl} onChange={(apiBaseUrl) => setDraft({ ...draft, apiBaseUrl })} />
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

function DeckToggle(props: { label: string; value: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <label className="field">
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
  }
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

async function unwrap<T>(request: Promise<IpcResponse<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) {
    throw new Error(result.error ?? "未知错误");
  }
  return result.data as T;
}

export default App;
