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
    return {
      ...defaults,
      ...(await this.readSavedSettings())
    };
  }

  /**
   * 保存出图设置。注意：settings.json 里还并存着 promptAssistant 等其它子键，
   * 因此必须「读旧文件 → 合并后再写」，否则整文件覆盖会把提示词助手配置冲掉。
   */
  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    await withFileLock(this.settingsPath, async () => {
      const raw = await this.readRawSettings();
      await writeJsonFile(this.settingsPath, { ...raw, ...settings });
    });
    return this.getSettings();
  }

  /** 提示词助手配置：独立于出图模型，单独持久化在 settings.json 的 promptAssistant 子键 */
  async getPromptAssistant(): Promise<PromptAssistantSettings> {
    const raw = await this.readRawSettings();
    const saved = (raw.promptAssistant as Partial<PromptAssistantSettings>) ?? {};
    // fields 需逐键合并：旧配置可能只有部分字段，整对象覆盖会丢默认值
    return { ...this.defaultPromptAssistant(), ...saved, fields: { ...DEFAULT_PROMPT_ASSISTANT_FIELDS, ...(saved.fields ?? {}) } };
  }

  async savePromptAssistant(data: PromptAssistantSettings): Promise<PromptAssistantSettings> {
    await withFileLock(this.settingsPath, async () => {
      const raw = await this.readRawSettings();
      raw.promptAssistant = { ...this.defaultPromptAssistant(), ...data, fields: { ...DEFAULT_PROMPT_ASSISTANT_FIELDS, ...(data.fields ?? {}) } };
      await writeJsonFile(this.settingsPath, raw);
    });
    return this.getPromptAssistant();
  }

  private defaultPromptAssistant(): PromptAssistantSettings {
    return { baseUrl: "", apiKey: "", model: "", availableModels: [], fields: { ...DEFAULT_PROMPT_ASSISTANT_FIELDS } };
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
