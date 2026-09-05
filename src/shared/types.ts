export type AssetType =
  | "character"
  | "enemy"
  | "icon"
  | "item"
  | "ui"
  | "tileset"
  | "background"
  | "effect";

export type ExportTarget = "unity" | "godot" | "tiled" | "phaser" | "cocos" | "common";
export type GenerationMode = "text-to-image" | "image-to-image";
export type ReferenceImageRole = "subject" | "style" | "composition" | "palette";
export type EditIntent = "preserve-subject" | "preserve-style" | "preserve-composition" | "same-series" | "inpaint";
export type ReferenceStrength = "low" | "medium" | "high";

export interface Size {
  width: number;
  height: number;
}

export interface AnimationConfig {
  name: string;
  frames: number;
  fps: number;
  loop: boolean;
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
  atlasPath?: string;
  sheetPath?: string;
  generationMode?: GenerationMode;
  referenceImages?: ReferenceImageInput[];
  maskImagePath?: string;
  prompt: string;
  exportTargets: ExportTarget[];
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
  defaultResolution: string;
  defaultBackground: "transparent" | "solid" | "custom";
  exportTargets: ExportTarget[];
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

export type AIProvider = "openai" | "custom" | "local-draft";
export type CustomApiFormat = "openai-image" | "openai-chat";

export interface AppSettings {
  aiProvider: AIProvider;
  customApiFormat: CustomApiFormat;
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  availableModels: string[];
  defaultProjectRoot: string;
  defaultExportDirectory: string;
  defaultImageSize: string;
  defaultGenerationCount: number;
  savePromptHistory: boolean;
  autoTransparent: boolean;
  autoTrim: boolean;
  autoPackAtlas: boolean;
  generationQuality: "low" | "medium" | "high";
}

export interface CreateProjectInput {
  name: string;
  parentDirectory?: string;
  gameType: string;
  style: string;
  defaultResolution: string;
  defaultBackground: Project["defaultBackground"];
  exportTargets: ExportTarget[];
}

export interface GenerateAssetInput {
  projectPath: string;
  generationMode: GenerationMode;
  assetType: AssetType;
  name: string;
  description: string;
  detailPrompt: string;
  referenceImages: ReferenceImageInput[];
  editIntent: EditIntent;
  referenceStrength: ReferenceStrength;
  maskImagePath?: string;
  size: string;
  count: number;
  transparentBackground: boolean;
  exportTargets: ExportTarget[];
  iconItems: string[];
  makeAtlas: boolean;
  characterView: string;
  animations: AnimationConfig[];
  makeSpriteSheet: boolean;
  tileTheme: string;
  tileTypes: string[];
  tileSeamless: boolean;
  makeTiled: boolean;
}

export interface GeneratedAssetResult {
  asset: Asset;
  files: string[];
  metadataPath?: string;
  atlasPath?: string;
  sheetPath?: string;
  previewPath?: string;
  tmxPath?: string;
  logs: string[];
}

export interface GenerationHistoryRecord {
  id: string;
  createdAt: string;
  assetType: AssetType;
  prompt: string;
  parameters: GenerateAssetInput;
  style: string;
  outputFiles: string[];
  exportTargets: ExportTarget[];
  favorite: boolean;
  exported: boolean;
}

export interface ExportProjectInput {
  projectPath: string;
  targets: ExportTarget[];
  includeZip: boolean;
}

export interface ExportProjectResult {
  exportRoot: string;
  targets: string[];
  files: string[];
  zipPath?: string;
}

export interface SpriteSheetMetadata {
  character?: string;
  frameSize: Size;
  sheet: string;
  frames: Array<{
    name: string;
    animation: string;
    index: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
  animations: Record<string, { frames: number[]; fps: number; loop: boolean }>;
}

export interface AtlasMetadata {
  meta: {
    image: string;
    size: { w: number; h: number };
    padding: number;
  };
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
}

export interface IpcResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
