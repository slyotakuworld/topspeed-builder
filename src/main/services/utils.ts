import path from "node:path";
import fs from "fs-extra";

const fileLocks = new Map<string, Promise<void>>();

export const PROJECT_DIRECTORIES = [
  "generated/raw",
  "generated/processed",
  "sprites/characters",
  "sprites/enemies",
  "icons/items",
  "icons/skills",
  "icons/ui",
  "tilesets",
  "sheets",
  "atlas",
  "exports",
  "history",
  "references/images",
  "references/masks",
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

export function parseSize(size: string): { width: number; height: number } {
  const match = size.match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) {
    return { width: 64, height: 64 };
  }

  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
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
