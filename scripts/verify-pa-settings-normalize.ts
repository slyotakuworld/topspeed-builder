/**
 * 验证 SettingsService 对 promptAssistant 的规整逻辑：
 *  1) 旧配置里遗留的废弃键（stylePresetMode）不会被读出；
 *  2) 保存后废弃键从 settings.json 中彻底消失；
 *  3) fields 逐键合并默认值，缺键不丢默认；
 *  4) 地址 / 模型等字符串被 trim；
 *  5) 出图配置与提示词助手配置互不覆盖（同一文件两个子键）。
 *
 * 运行：npx esbuild scripts/verify-pa-settings-normalize.ts --bundle --platform=node \
 *        --format=cjs --outfile=build/tmp-verify-pa-norm.cjs && node build/tmp-verify-pa-norm.cjs
 */
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/main/services/settingsService";
import type { AppSettings, PromptAssistantSettings } from "../src/shared/types";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} - ${name}`);
  if (!cond) failed += 1;
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tsb-pa-norm-"));
  const file = path.join(dir, "settings.json");

  // 模拟旧版本落盘的配置：含废弃键 stylePresetMode、带空白、fields 只有部分键
  await fs.writeJson(file, {
    // 出图配置故意混入首尾空白：旧版本不 trim，会原样发出并被上游判为「非法模型 ID」→ 400
    apiKey: "  img-key  ",
    apiBaseUrl: " http://image.example/v1 ",
    model: "  image-model  ",
    availableModels: ["image-model", "  空格模型  ", 42],
    promptAssistant: {
      baseUrl: "  http://192.168.1.10:8788/v1  ",
      apiKey: " pa-key ",
      model: "  魔搭社区-免费/deepseek-ai/DeepSeek-V4-Flash-0731  ",
      availableModels: ["a/b", "  c/d  ", 123, null],
      fields: { description: true, style: false },
      stylePresetMode: "auto"
    }
  });

  const svc = new SettingsService(dir);

  const pa = await svc.getPromptAssistant();
  check("读出的 baseUrl 已 trim", pa.baseUrl === "http://192.168.1.10:8788/v1");
  check("读出的 apiKey 已 trim", pa.apiKey === "pa-key");
  check("读出的 model 已 trim 且无重复前缀", pa.model === "魔搭社区-免费/deepseek-ai/DeepSeek-V4-Flash-0731");
  check("availableModels 过滤非字符串并 trim", JSON.stringify(pa.availableModels) === JSON.stringify(["a/b", "c/d"]));
  check("fields 缺键回落默认（detailPrompt/cellNames 为 true）", pa.fields.detailPrompt === true && pa.fields.cellNames === true);
  check("fields 显式 false 被保留（style=false）", pa.fields.style === false);
  check("废弃键 stylePresetMode 未出现在读出结果", !("stylePresetMode" in (pa as unknown as Record<string, unknown>)));

  // 保存一次，废弃键应落盘后被清除
  await svc.savePromptAssistant(pa);
  const onDisk = (await fs.readJson(file)) as { promptAssistant: Record<string, unknown> };
  check("保存后 settings.json 中不再有 stylePresetMode", !("stylePresetMode" in onDisk.promptAssistant));
  check("保存后 promptAssistant 键集合完全确定", JSON.stringify(Object.keys(onDisk.promptAssistant).sort()) === JSON.stringify(["apiKey", "availableModels", "baseUrl", "fields", "model"]));

  // 出图配置与 PA 配置互不覆盖
  const appSettings = (await svc.getSettings()) as AppSettings;
  check("出图配置 model 已 trim（首尾空白被去掉）", appSettings.model === "image-model");
  check("出图配置 apiKey 已 trim", appSettings.apiKey === "img-key");
  check("出图配置 apiBaseUrl 已 trim", appSettings.apiBaseUrl === "http://image.example/v1");
  check(
    "出图 availableModels 过滤非字符串并 trim",
    JSON.stringify(appSettings.availableModels) === JSON.stringify(["image-model", "空格模型"])
  );
  const nextApp: AppSettings = { ...appSettings, defaultImageSize: "128x128" };
  await svc.saveSettings(nextApp);
  const after = (await fs.readJson(file)) as { promptAssistant?: Record<string, unknown>; defaultImageSize?: string };
  check("保存出图配置不会冲掉 promptAssistant", !!after.promptAssistant && after.promptAssistant.model === "魔搭社区-免费/deepseek-ai/DeepSeek-V4-Flash-0731");
  check("保存出图配置本身生效", after.defaultImageSize === "128x128");

  // 空/脏输入兜底
  const dirty = await svc.savePromptAssistant({} as PromptAssistantSettings);
  check("空输入兜底为默认值", dirty.baseUrl === "" && dirty.model === "" && dirty.fields.description === true);

  await fs.remove(dir);

  console.log(results.join("\n"));
  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`} (${results.length} checks)`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
