import path from "node:path";
import fs from "fs-extra";
import type { AppSettings, PromptAssistantSettings } from "@shared/types";
import { DEFAULT_PROMPT_ASSISTANT_FIELDS } from "@shared/types";
import { getUserDataDir, withFileLock, writeJsonFile } from "./utils";

export class SettingsService {
  private readonly settingsPath: string;

  constructor(userDataDir?: string) {
    this.settingsPath = path.join(userDataDir ?? getUserDataDir(), "settings.json");
  }

  async getSettings(): Promise<AppSettings> {
    const defaults = await this.getDefaultSettings();
    return this.normalizeAppSettings({ ...defaults, ...(await this.readSavedSettings()) });
  }

  /**
   * 保存出图设置。注意：settings.json 里还并存着 promptAssistant 等其它子键，
   * 因此必须「读旧文件 → 合并后再写」，否则整文件覆盖会把提示词助手配置冲掉。
   */
  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    await withFileLock(this.settingsPath, async () => {
      const raw = await this.readRawSettings();
      await writeJsonFile(this.settingsPath, { ...raw, ...this.normalizeAppSettings(settings) });
    });
    return this.getSettings();
  }

  /**
   * 出图配置规整：apiKey / apiBaseUrl / model 统一 trim。
   * 首尾空白会让上游把模型名判为「不是合法的模型 ID」直接 400，
   * 这类脏值一旦落盘就会长期生效，所以在读写两端都收口（与 normalizePromptAssistant 同口径）。
   */
  private normalizeAppSettings(settings: AppSettings): AppSettings {
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    return {
      ...settings,
      apiKey: str(settings.apiKey),
      apiBaseUrl: str(settings.apiBaseUrl),
      model: str(settings.model),
      availableModels: Array.isArray(settings.availableModels)
        ? settings.availableModels.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
        : []
    };
  }

  /** 提示词助手配置：独立于出图模型，单独持久化在 settings.json 的 promptAssistant 子键 */
  async getPromptAssistant(): Promise<PromptAssistantSettings> {
    const raw = await this.readRawSettings();
    return this.normalizePromptAssistant(raw.promptAssistant as Partial<PromptAssistantSettings> | undefined);
  }

  async savePromptAssistant(data: PromptAssistantSettings): Promise<PromptAssistantSettings> {
    await withFileLock(this.settingsPath, async () => {
      const raw = await this.readRawSettings();
      // 只写「已知字段」：历史版本留下的废弃键（如 stylePresetMode）在下次保存时被自然清除
      raw.promptAssistant = this.normalizePromptAssistant(data);
      await writeJsonFile(this.settingsPath, raw);
    });
    return this.getPromptAssistant();
  }

  private defaultPromptAssistant(): PromptAssistantSettings {
    return { baseUrl: "", apiKey: "", model: "", availableModels: [], fields: { ...DEFAULT_PROMPT_ASSISTANT_FIELDS } };
  }

  /**
   * 把磁盘上的 promptAssistant 规整为一个「字段完全确定」的对象：
   *  - 逐键挑取，未知/废弃键一律丢弃（避免旧配置残留污染新结构）；
   *  - fields 逐键合并默认值，避免旧配置缺键导致 undefined；
   *  - 字符串统一 trim，防止手输/粘贴带首尾空白导致模型名或地址失配。
   */
  private normalizePromptAssistant(saved?: Partial<PromptAssistantSettings>): PromptAssistantSettings {
    const base = this.defaultPromptAssistant();
    const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v.trim() : fallback);
    return {
      baseUrl: str(saved?.baseUrl, base.baseUrl),
      apiKey: str(saved?.apiKey, base.apiKey),
      model: str(saved?.model, base.model),
      availableModels: Array.isArray(saved?.availableModels)
        ? saved.availableModels.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
        : base.availableModels,
      fields: { ...DEFAULT_PROMPT_ASSISTANT_FIELDS, ...(saved?.fields ?? {}) }
    };
  }

  private async readRawSettings(): Promise<Record<string, unknown>> {
    try {
      if (!(await fs.pathExists(this.settingsPath))) return {};
      const parsed = JSON.parse(await fs.readFile(this.settingsPath, "utf8"));
      return (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async getDefaultSettings(): Promise<AppSettings> {
    return {
      apiKey: "",
      apiBaseUrl: "",
      model: "",
      availableModels: [],
      defaultProjectRoot: "",
      defaultExportDirectory: ""
    };
  }

  private async readSavedSettings(): Promise<Partial<AppSettings>> {
    try {
      if (!(await fs.pathExists(this.settingsPath))) {
        return {};
      }

      const raw = await fs.readFile(this.settingsPath, "utf8");
      try {
        return JSON.parse(raw) as Partial<AppSettings>;
      } catch {
        return this.readLooseSettings(raw);
      }
    } catch {
      return {};
    }
  }

  private readLooseSettings(raw: string): Partial<AppSettings> {
    const output: Partial<AppSettings> = {};

    this.readLooseString(raw, output, "apiKey");
    this.readLooseString(raw, output, "apiBaseUrl");
    this.readLooseString(raw, output, "model");
    this.readLooseArray(raw, output, "availableModels");
    this.readLooseString(raw, output, "defaultProjectRoot");
    this.readLooseString(raw, output, "defaultExportDirectory");

    return output;
  }

  private readLooseString<K extends keyof AppSettings>(raw: string, output: Partial<AppSettings>, key: K): void {
    const match = raw.match(new RegExp(`"${String(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (match) {
      output[key] = this.decodeLooseJsonString(match[1]) as AppSettings[K];
    }
  }

  private readLooseArray<K extends keyof AppSettings>(raw: string, output: Partial<AppSettings>, key: K): void {
    const match = raw.match(new RegExp(`"${String(key)}"\\s*:\\s*(\\[[^\\]]*\\])`));
    if (!match) return;
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (Array.isArray(parsed)) {
        output[key] = parsed.filter((item): item is string => typeof item === "string") as AppSettings[K];
      }
    } catch {
      // 损坏的数组字面量忽略，回落到默认空数组
    }
  }

  private decodeLooseJsonString(value: string): string {
    const repaired = value.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    try {
      return JSON.parse(`"${repaired}"`) as string;
    } catch {
      return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
}
