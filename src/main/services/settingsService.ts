import path from "node:path";
import { app } from "electron";
import fs from "fs-extra";
import type { AppSettings } from "@shared/types";
import { writeJsonFile } from "./utils";

export class SettingsService {
  private readonly settingsPath: string;

  constructor() {
    this.settingsPath = path.join(app.getPath("userData"), "settings.json");
  }

  async getSettings(): Promise<AppSettings> {
    const defaults = await this.getDefaultSettings();
    return {
      ...defaults,
      ...(await this.readSavedSettings())
    };
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    await writeJsonFile(this.settingsPath, settings);
    return this.getSettings();
  }

  private async getDefaultSettings(): Promise<AppSettings> {
    const projectRoot = path.join(app.getPath("documents"), "Topspeed Builder Projects");
    await fs.ensureDir(projectRoot);

    return {
      aiProvider: "openai",
      customApiFormat: "openai-image",
      apiKey: "",
      apiBaseUrl: "https://api.openai.com/v1/images/generations",
      model: "gpt-image-1.5",
      availableModels: [],
      defaultProjectRoot: projectRoot,
      defaultExportDirectory: "",
      defaultImageSize: "64x64",
      defaultGenerationCount: 1,
      savePromptHistory: true,
      autoTransparent: true,
      autoTrim: true,
      autoPackAtlas: true,
      generationQuality: "low"
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

    this.readLooseString(raw, output, "aiProvider");
    this.readLooseString(raw, output, "customApiFormat");
    this.readLooseString(raw, output, "apiKey");
    this.readLooseString(raw, output, "apiBaseUrl");
    this.readLooseString(raw, output, "model");
    this.readLooseArray(raw, output, "availableModels");
    this.readLooseString(raw, output, "defaultProjectRoot");
    this.readLooseString(raw, output, "defaultExportDirectory");
    this.readLooseString(raw, output, "defaultImageSize");
    this.readLooseString(raw, output, "generationQuality");

    this.readLooseNumber(raw, output, "defaultGenerationCount");

    this.readLooseBoolean(raw, output, "savePromptHistory");
    this.readLooseBoolean(raw, output, "autoTransparent");
    this.readLooseBoolean(raw, output, "autoTrim");
    this.readLooseBoolean(raw, output, "autoPackAtlas");

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

  private readLooseNumber<K extends keyof AppSettings>(raw: string, output: Partial<AppSettings>, key: K): void {
    const match = raw.match(new RegExp(`"${String(key)}"\\s*:\\s*(\\d+)`));
    if (match) {
      output[key] = Number(match[1]) as AppSettings[K];
    }
  }

  private readLooseBoolean<K extends keyof AppSettings>(raw: string, output: Partial<AppSettings>, key: K): void {
    const match = raw.match(new RegExp(`"${String(key)}"\\s*:\\s*(true|false)`));
    if (match) {
      output[key] = (match[1] === "true") as AppSettings[K];
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
