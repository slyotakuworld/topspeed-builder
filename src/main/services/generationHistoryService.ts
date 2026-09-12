import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import sharp from "sharp";
import type { GenerateAssetInput, GenerationHistoryEntry } from "@shared/types";
import { readJsonFile, withFileLock } from "./utils";

/** 每个项目历史记录上限：超出后丢弃最旧的记录（仅删台账，不删磁盘文件） */
export const HISTORY_LIMIT = 200;

/** 项目级缩略图后台补生成的单飞标记：同一项目同时只允许一条补生成链 */
const prewarmInflight = new Set<string>();
/** 已完成补生成的项目：避免每次 list() 都重复扫描全部 runId */
const prewarmDone = new Set<string>();

/**
 * 生成历史台账：持久化在 <project>/history.json。
 * 每次「生成网格大图」写一条 draft；确认切分入库后用同一 runId 原地更新为 committed。
 * 独立文件 + 原子写，闪退后记录不丢；与 project.json 解耦，避免并发锁互相等待。
 */
export class GenerationHistoryService {
  async list(projectPath: string): Promise<GenerationHistoryEntry[]> {
    const entries = await readJsonFile<GenerationHistoryEntry[]>(this.historyPath(projectPath), []);
    const result = Array.isArray(entries)
      ? entries.filter((entry) => entry && typeof entry.runId === "string")
      : [];
    // 历史一载入就触发后台补缩略图：已存在的直接跳过，缺失的逐个低温生成（见 prewarmThumbnails），
    // 让侧栏 rail 在用户看到历史时全部命中磁盘小文件，不再冷解码整张网格大图。
    void this.prewarmThumbnails(
      projectPath,
      result.map((entry) => entry.runId)
    );
    return result;
  }

  async get(projectPath: string, runId: string): Promise<GenerationHistoryEntry | undefined> {
    const entries = await this.list(projectPath);
    return entries.find((entry) => entry.runId === runId);
  }

  async upsert(projectPath: string, entry: GenerationHistoryEntry): Promise<void> {
    const filePath = this.historyPath(projectPath);
    await withFileLock(filePath, async () => {
      const entries = await readJsonFile<GenerationHistoryEntry[]>(filePath, []);
      const next = [entry, ...(Array.isArray(entries) ? entries : []).filter((item) => item?.runId !== entry.runId)];
      await this.writeHistory(filePath, next.slice(0, HISTORY_LIMIT));
    });
  }

  /**
   * 「手动保存」当前素材生成配置/草稿：
   * - 传入 runId 且台账里能找到该记录（无论草稿或已入库批次）→ 原地更新参数快照 input，其余字段保留；
   * - 找不到或未传 runId → 新建一条「仅配置」草稿记录（grid.gridImagePath 为空 = 尚未生成网格大图），
   *   返回新 runId 供调用方记住锚点，下次再保存即走“更新”分支，避免重复新建。
   */
  async saveSnapshot(projectPath: string, runId: string | null, input: GenerateAssetInput): Promise<{ runId: string }> {
    const filePath = this.historyPath(projectPath);
    const now = new Date().toISOString();
    if (runId) {
      const entries = await readJsonFile<GenerationHistoryEntry[]>(filePath, []);
      if (Array.isArray(entries) && entries.some((item) => item?.runId === runId)) {
        await withFileLock(filePath, async () => {
          const current = await readJsonFile<GenerationHistoryEntry[]>(filePath, []);
          const target = (Array.isArray(current) ? current : []).find((item) => item?.runId === runId);
          if (!target) return;
          target.input = input;
          target.logs = [...(Array.isArray(target.logs) ? target.logs : []), `手动保存参数快照 @ ${now}`];
          await this.writeHistory(filePath, current);
        });
        return { runId };
      }
    }

    // 无记录 → 新建“仅配置”草稿：占位 grid 字段，count 沿用表单数值以便侧栏展示
    const nextRunId = runId && this.isSafeRunId(runId) ? runId : randomUUID();
    const count = Math.max(1, Math.min(36, Math.round(input.count) || 1));
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const entry: GenerationHistoryEntry = {
      runId: nextRunId,
      status: "draft",
      name: input.name || input.assetType,
      createdAt: now,
      input,
      grid: { cols, rows, width: 0, height: 0, count, gridImagePath: "" },
      prompt: "",
      logs: ["手动保存的配置草稿（尚未生成网格大图）。"]
    };
    await this.upsert(projectPath, entry);
    return { runId: nextRunId };
  }

  /**
   * 重命名某条记录：素材库与历史记录共用同一个名字，改名后两处同时生效。
   * 名字只用于展示，不改动磁盘上的素材文件名，避免破坏已导出的引用。
   */
  async rename(projectPath: string, runId: string, name: string): Promise<GenerationHistoryEntry | undefined> {
    const nextName = name.trim().slice(0, 80);
    if (!nextName) return undefined;
    const filePath = this.historyPath(projectPath);
    let renamed: GenerationHistoryEntry | undefined;
    await withFileLock(filePath, async () => {
      const entries = await readJsonFile<GenerationHistoryEntry[]>(filePath, []);
      if (!Array.isArray(entries)) return;
      renamed = entries.find((item) => item?.runId === runId);
      if (!renamed) return;
      renamed.name = nextName;
      await this.writeHistory(filePath, entries);
    });
    return renamed;
  }

  /** 删除某条记录；若该记录只是未入库草稿，一并清理其网格大图目录 */
  async remove(projectPath: string, runId: string): Promise<boolean> {
    const filePath = this.historyPath(projectPath);
    await withFileLock(filePath, async () => {
      const entries = await readJsonFile<GenerationHistoryEntry[]>(filePath, []);
      if (!Array.isArray(entries)) {
        await this.writeHistory(filePath, []);
        return;
      }
      const target = entries.find((entry) => entry?.runId === runId);
      await this.writeHistory(
        filePath,
        entries.filter((entry) => entry?.runId !== runId)
      );
      if (target?.status === "draft" && this.isSafeRunId(runId)) {
        try {
          await fs.remove(path.join(projectPath, "generated", "raw", runId));
        } catch {
          // 目录可能已被手动清理，忽略
        }
      }
      await this.removeThumbnailCache(projectPath, runId);
    });
    return true;
  }

  /** 素材库中删除了某批次素材时，同步清掉对应已入库历史记录与其网格大图目录 */
  async removeByAsset(projectPath: string, assetId: string): Promise<void> {
    if (!assetId) return;
    const filePath = this.historyPath(projectPath);
    await withFileLock(filePath, async () => {
      const entries = await readJsonFile<GenerationHistoryEntry[]>(filePath, []);
      if (!Array.isArray(entries)) {
        await this.writeHistory(filePath, []);
        return;
      }
      const removed = entries.filter((entry) => entry?.assetId === assetId);
      await this.writeHistory(
        filePath,
        entries.filter((entry) => entry?.assetId !== assetId)
      );
      for (const entry of removed) {
        if (entry && this.isSafeRunId(entry.runId)) {
          try {
            await fs.remove(path.join(projectPath, "generated", "raw", entry.runId));
          } catch {
            // 目录可能已被手动清理，忽略
          }
          await this.removeThumbnailCache(projectPath, entry.runId);
        }
      }
    });
  }

  private historyPath(projectPath: string): string {
    return path.join(projectPath, "history.json");
  }

  private thumbPath(projectPath: string, runId: string): string {
    return path.join(projectPath, "generated", "thumbs", `${runId}.png`);
  }

  /** 生成/入库时用内存里的网格大图直接产出 160px 缩略图并落盘。
   *  这样历史列表日后展示时只读小文件；失败不影响主流程。 */
  async writeThumbnailFromBuffer(projectPath: string, runId: string, buffer: Buffer): Promise<void> {
    if (!this.isSafeRunId(runId)) return;
    try {
      const thumbPath = this.thumbPath(projectPath, runId);
      await fs.ensureDir(path.dirname(thumbPath));
      await sharp(buffer, { failOn: "none" })
        .rotate()
        .resize(160, 160, { fit: "inside" })
        .png()
        .toFile(thumbPath);
    } catch {
      // 缩略图失败不影响生成主流程
    }
  }

  /**
   * 后台低温补齐缺失缩略图：单飞（同项目只跑一条链）+ 每条间隔 120ms，
   * 避免几十张 1024–2048px 网格大图同时解码打满 CPU（会拖垮 Windows 输入/输入法）。
   * 只处理历史里真实存在的条目；所有缺失项补完后本进程内不再重复扫描。
   */
  async prewarmThumbnails(projectPath: string, runIds: string[]): Promise<void> {
    if (prewarmInflight.has(projectPath) || prewarmDone.has(projectPath)) return;
    prewarmInflight.add(projectPath);
    try {
      // 起始静默期：历史刚载入的前 1.2s 不做任何解码，把 CPU 完全让给界面交互（用户此刻往往正要输入）
      await new Promise((resolve) => setTimeout(resolve, 1200));
      for (const runId of runIds) {
        if (!this.isSafeRunId(runId)) continue;
        const thumbPath = this.thumbPath(projectPath, runId);
        if (await fs.pathExists(thumbPath)) continue;
        // 网格大图按固定约定存放；找不到就跳过（交由按需路径兜底）
        const candidate = path.join(projectPath, "generated", "raw", runId, "grid.png");
        if (!(await fs.pathExists(candidate))) continue;
        try {
          await fs.ensureDir(path.dirname(thumbPath));
          await sharp(candidate, { failOn: "none" })
            .rotate()
            .resize(160, 160, { fit: "inside" })
            .png()
            .toFile(thumbPath);
        } catch {
          // 单条失败跳过，不中断整条链
        }
        // 给主进程/系统喘口气：用户此刻往往正要操作界面
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      prewarmDone.add(projectPath);
    } finally {
      prewarmInflight.delete(projectPath);
    }
  }

  /**
   * 生成某条历史记录的网格缩略图 dataUrl（~160px），供侧栏时间轴等密集场景使用，
   * 避免把整张大图 base64 化导致卡顿。缩略图首次生成后落盘缓存（<project>/generated/thumbs/<runId>.png），
   * 之后直接读小文件，不再每次对整张网格大图做解码缩放。文件不存在/读取失败时返回空字符串。
   */
  async thumbnailDataUrl(projectPath: string, runId: string): Promise<string> {
    if (!this.isSafeRunId(runId)) return "";
    try {
      // 优先直接读磁盘缓存，不再整读 history.json（历史列表一屏几十个缩略图，逐条整读台账会造成主进程 IO/GC 尖峰，
      // 叠加输入法/键盘事件依赖主进程，会表现为「切项目后文本框短暂无法输入」）。
      const thumbPath = path.join(projectPath, "generated", "thumbs", `${runId}.png`);
      if (await fs.pathExists(thumbPath)) {
        const buffer = await fs.readFile(thumbPath);
        return `data:image/png;base64,${buffer.toString("base64")}`;
      }
      // 缓存缺失：网格大图路径有固定约定，直接从 raw 目录取；取不到再退回读台账（兼容旧数据/自定义路径）
      const candidate = path.join(projectPath, "generated", "raw", runId, "grid.png");
      const absolute = (await fs.pathExists(candidate))
        ? candidate
        : await this.lookupGridImagePath(projectPath, runId);
      if (!absolute) return "";
      await fs.ensureDir(path.dirname(thumbPath));
      await sharp(absolute, { failOn: "none" })
        .rotate()
        .resize(160, 160, { fit: "inside" })
        .png()
        .toFile(thumbPath);
      const buffer = await fs.readFile(thumbPath);
      return `data:image/png;base64,${buffer.toString("base64")}`;
    } catch {
      return "";
    }
  }

  /** 仅当固定约定路径找不到时才读一次台账，取该条记录的 grid.gridImagePath */
  private async lookupGridImagePath(projectPath: string, runId: string): Promise<string | null> {
    try {
      const entry = await this.get(projectPath, runId);
      if (!entry) return null;
      return path.join(projectPath, entry.grid.gridImagePath);
    } catch {
      return null;
    }
  }

  /** 删除某条记录对应的缩略图缓存（失败静默，不影响台账删除） */
  private async removeThumbnailCache(projectPath: string, runId: string): Promise<void> {
    if (!this.isSafeRunId(runId)) return;
    try {
      await fs.remove(path.join(projectPath, "generated", "thumbs", `${runId}.png`));
    } catch {
      // 缓存文件可能不存在，忽略
    }
  }

  /** 先写临时文件再原子改名：避免中途崩溃留下半截 JSON，导致整份历史丢失 */
  private async writeHistory(filePath: string, data: GenerationHistoryEntry[]): Promise<void> {
    await fs.ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeJson(tempPath, data, { spaces: 2 });
    await fs.move(tempPath, filePath, { overwrite: true });
  }

  private isSafeRunId(value: string): boolean {
    // runId 来自 randomUUID，只允许字母数字与连字符，防路径穿越
    return /^[a-zA-Z0-9-]{8,64}$/.test(value);
  }
}
