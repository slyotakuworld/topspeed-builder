// 临时验证：保存出图设置(saveSettings) 后，promptAssistant 子键是否仍保留。
// 通过 esbuild stdin 内联打包真实 SettingsService（不污染 src），在临时目录跑，跑完清理。
import { build } from "esbuild";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = process.cwd();

const entry = `
import { SettingsService } from "./src/main/services/settingsService";

export async function run(dir) {
  const svc = new SettingsService(dir);
  // 1) 先配提示词助手
  await svc.savePromptAssistant({ baseUrl: "http://assistant.local/v1", apiKey: "assist-key", model: "assist-model", availableModels: ["assist-model"] });
  // 2) 再保存出图设置（关键：不能冲掉上一步的 promptAssistant）
  await svc.saveSettings({
    apiKey: "image-key",
    apiBaseUrl: "http://image.local/v1",
    model: "image-model",
    availableModels: ["image-model"],
    defaultProjectRoot: "",
    defaultExportDirectory: ""
  });
  // 3) 校验两者并存
  const pa = await svc.getPromptAssistant();
  const st = await svc.getSettings();
  return {
    paBaseUrl: pa.baseUrl,
    paApiKey: pa.apiKey,
    paModel: pa.model,
    imageApiKey: st.apiKey,
    imageBaseUrl: st.apiBaseUrl
  };
}
`;

const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "verify-entry.ts" },
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  packages: "external",
  absWorkingDir: root,
  write: false,
  logLevel: "silent"
});

// 临时配置目录（被验证对象）；产物写到项目内，便于解析 node_modules
const dir = mkdtempSync(resolve(tmpdir(), "ts-verify-"));
const outFile = resolve(root, "build/extra/__verify-settings-merge.mjs");
writeFileSync(outFile, bundled.outputFiles[0].text);

try {
  const mod = await import(`file://${outFile.replace(/\\/g, "/")}`);
  const r = await mod.run(dir);

  const settingsJsonPath = resolve(dir, "settings.json");
  const raw = JSON.parse(readFileSync(settingsJsonPath, "utf8"));

  const checks = [
    ["promptAssistant 子键仍在文件里", Boolean(raw.promptAssistant)],
    ["助手 baseUrl 未被冲掉", r.paBaseUrl === "http://assistant.local/v1"],
    ["助手 apiKey 未被冲掉", r.paApiKey === "assist-key"],
    ["助手 model 未被冲掉", r.paModel === "assist-model"],
    ["出图 apiKey 已写入", r.imageApiKey === "image-key"],
    ["出图 apiBaseUrl 已写入", r.imageBaseUrl === "http://image.local/v1"]
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) ok = false;
  }
  console.log("settings.json:", JSON.stringify(raw));
  console.log("RESULT:", ok ? "OK" : "FAILED");
  if (!ok) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outFile, { force: true });
}
