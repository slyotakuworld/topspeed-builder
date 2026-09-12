import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { GenerationHistoryService } from "../src/main/services/generationHistoryService";
import { resolveLibraryAssetState } from "../src/shared/types";
import type { GenerateAssetInput } from "../src/shared/types";

const results: string[] = [];
let failed = 0;
function check(label: string, ok: boolean): void {
  if (!ok) failed += 1;
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

function makeInput(overrides: Partial<GenerateAssetInput> = {}): GenerateAssetInput {
  return {
    projectPath: "",
    assetType: "icon",
    name: "英雄图标",
    description: "赛博朋克风格图标",
    detailPrompt: "",
    referenceImages: [],
    referenceStrength: "medium",
    size: "1024x1024",
    count: 4,
    cellNames: [],
    quality: "high",
    style: "",
    transparentBackground: true,
    trimEdges: true,
    ...overrides
  };
}

async function main(): Promise<void> {
  // 1) 三态推导
  check("gridImagePath 为空 → empty", resolveLibraryAssetState({ grid: { gridImagePath: "" } }) === "empty");
  check("无 grid 字段 → empty", resolveLibraryAssetState({}) === "empty");
  check(
    "有整图无 files → grid",
    resolveLibraryAssetState({ grid: { gridImagePath: "generated/raw/a/grid.png" } }) === "grid"
  );
  check(
    "有整图且 files 非空 → sliced",
    resolveLibraryAssetState({
      grid: { gridImagePath: "generated/raw/a/grid.png" },
      files: ["sprites/a/01_x.png"]
    }) === "sliced"
  );
  check("files 为空数组 → grid（未切图）", resolveLibraryAssetState({ grid: { gridImagePath: "g.png" }, files: [] }) === "grid");

  // 2) 真实服务：saveSnapshot 落 name
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tsb-lib-"));
  try {
    const svc = new GenerationHistoryService();
    const created = await svc.saveSnapshot(dir, null, makeInput());
    const entries = await svc.list(dir);
    check("saveSnapshot 新建记录成功", entries.length === 1 && entries[0].runId === created.runId);
    check("新建记录 name = 批次名", entries[0].name === "英雄图标");
    check("新建记录状态为 empty（无整图）", resolveLibraryAssetState(entries[0]) === "empty");

    // 3) 重命名
    const renamed = await svc.rename(dir, created.runId, "  主角图标集  ");
    check("重命名成功并 trim", renamed?.name === "主角图标集");
    const afterRename = await svc.get(dir, created.runId);
    check("重命名已落盘", afterRename?.name === "主角图标集");
    check("未指定 runId 的重命名返回 undefined", (await svc.rename(dir, "not-exist-runid", "x")) === undefined);
    check("空白名字被拒绝", (await svc.rename(dir, created.runId, "   ")) === undefined);
    check("被拒后名字未被改动", (await svc.get(dir, created.runId))?.name === "主角图标集");

    // 4) 同 runId 再次 saveSnapshot（更新分支）不应清掉名称
    await svc.saveSnapshot(dir, created.runId, makeInput({ name: "改过的批次名", count: 6 }));
    const afterUpdate = await svc.get(dir, created.runId);
    check("更新分支保留重命名后的 name", afterUpdate?.name === "主角图标集");
    check("更新分支写入了新 input", afterUpdate?.input.count === 6);
    check("记录条数未增加", (await svc.list(dir)).length === 1);

    // 5) 长名字截断到 80
    const longName = "长".repeat(120);
    const longRenamed = await svc.rename(dir, created.runId, longName);
    check("超长名字截断到 80", longRenamed?.name.length === 80);

    // 6) 删除
    await svc.remove(dir, created.runId);
    check("删除后列表为空", (await svc.list(dir)).length === 0);
  } finally {
    await fs.remove(dir);
  }

  console.log(results.join("\n"));
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
