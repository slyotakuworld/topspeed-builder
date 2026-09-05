import path from "node:path";
import fs from "fs-extra";
import type { GenerationHistoryRecord } from "@shared/types";
import { readJsonFile, withFileLock, writeJsonFile } from "./utils";

export class HistoryService {
  async append(projectPath: string, record: GenerationHistoryRecord): Promise<void> {
    await withFileLock(this.historyPath(projectPath), async () => {
      const history = await this.getHistory(projectPath);
      const next = [record, ...history].slice(0, 200);
      await writeJsonFile(this.historyPath(projectPath), next);
      await writeJsonFile(path.join(projectPath, "history", `${record.id}.json`), record);
    });
  }

  async getHistory(projectPath: string): Promise<GenerationHistoryRecord[]> {
    await fs.ensureDir(path.join(projectPath, "history"));
    return readJsonFile<GenerationHistoryRecord[]>(this.historyPath(projectPath), []);
  }

  private historyPath(projectPath: string): string {
    return path.join(projectPath, "history", "history.json");
  }
}
