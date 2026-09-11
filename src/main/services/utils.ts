import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const fileLocks = new Map<string, Promise<void>>();

export const PROJECT_DIRECTORIES = [
  "generated/raw",
  "sprites",
  "references/images",
  "references/thumbnails"
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeFileName(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
    .replace(/^_+|_+$/g, "");

  return cleaned || "asset";
}


export function toRelative(projectPath: string, filePath: string): string {
  return path.relative(projectPath, filePath).replace(/\\/g, "/");
}

export function resolveProjectPath(projectPath: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
}

export async function ensureProjectDirectories(projectPath: string): Promise<void> {
  await Promise.all(PROJECT_DIRECTORIES.map((dir) => fs.ensureDir(path.join(projectPath, dir))));
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    if (!(await fs.pathExists(filePath))) {
      return fallback;
    }

    return (await fs.readJson(filePath)) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, data, { spaces: 2 });
}

export async function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLowerCase();
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => next);
  fileLocks.set(key, current);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (fileLocks.get(key) === current) {
      fileLocks.delete(key);
    }
  }
}

export function uniqueByPath<T extends { path: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const item of items) {
    const key = path.normalize(item.path).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(item);
    }
  }

  return output;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

export function safeJoinInside(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(root, ...segments);

  if (!target.startsWith(resolvedRoot)) {
    throw new Error(`拒绝访问项目目录外的路径：${target}`);
  }

  return target;
}

/** Electron 的 app.getName() 取 package.json 的 productName / name；本项目顶层无 productName，故为 name */
export const APP_DIR_NAME = "topspeed-builder";

/**
 * 复刻 Electron `app.getPath("userData")` 的平台路径（不依赖 electron 模块）。
 * CLI / MCP 等独立进程据此定位 GUI 写入的 settings.json。
 *  - win32 : %APPDATA%\<appName>
 *  - darwin: ~/Library/Application Support/<appName>
 *  - linux : $XDG_CONFIG_HOME(默认 ~/.config)/<appName>
 */
function platformUserDataDir(appName: string): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, appName);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, appName);
}

/**
 * 用户数据目录（settings.json 等落盘位置）。优先级：
 *  1. env.TOPSPEED_USER_DATA —— 显式覆盖（CLI / MCP / 测试可指定）。
 *  2. Electron 运行时 —— app.getPath("userData")，与 GUI 完全一致。
 *  3. 独立 Node 进程 —— 复刻 Electron userData 的平台路径；若该目录无 settings.json
 *     而旧版回退目录 ~/.topspeed-builder 有，则兼容读取旧位置。
 * 用动态 require 而非顶层 import "electron"，避免独立进程加载 electron 模块失败。
 */
export function getUserDataDir(): string {
  const override = process.env.TOPSPEED_USER_DATA;
  if (override) return override;

  try {
    const req = (globalThis as { require?: NodeRequire }).require;
    if (req && typeof process !== "undefined" && (process as { versions?: { electron?: string } }).versions?.electron) {
      const electronMod = req("electron") as { app?: { getPath: (name: string) => string } };
      if (electronMod?.app) {
        return electronMod.app.getPath("userData");
      }
    }
  } catch {
    /* 非 Electron 环境，走下方平台路径 */
  }

  const candidates = [
    platformUserDataDir(APP_DIR_NAME),
    // 打包产物若把 productName 作为应用名，userData 目录会带空格；一并兼容
    platformUserDataDir("Topspeed Builder"),
    path.join(os.homedir(), ".topspeed-builder")
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "settings.json"))) return dir;
    } catch {
      /* 忽略不可访问的候选目录 */
    }
  }
  return candidates[0];
}
