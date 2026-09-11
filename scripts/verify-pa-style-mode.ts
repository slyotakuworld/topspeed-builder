import { PromptAssistantService } from "../src/main/services/promptAssistantService";
import type {
  PromptAssistantSettings,
  PromptAssistantInput,
  PromptAssistantResult,
  PromptAssistantFields
} from "../src/shared/types";
import { DEFAULT_PROMPT_ASSISTANT_FIELDS } from "../src/shared/types";

/** 取本次请求真正发出的 system prompt（lastBody 是 stringify 后的 JSON，内层引号被转义，不能直接 includes 带引号的片段） */
function lastSystem(): string {
  const parsed = JSON.parse(lastBody) as { messages: Array<{ role: string; content: string }> };
  return parsed.messages[0].content;
}

let lastBody = "";
(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
  lastBody = init.body;
  const content = (globalThis as unknown as { __CANON__: string }).__CANON__;
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }] })
  };
};

const base: PromptAssistantSettings = {
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "",
  model: "m",
  availableModels: [],
  fields: { ...DEFAULT_PROMPT_ASSISTANT_FIELDS }
};
const input: PromptAssistantInput = { naturalLanguage: "赛博朋克敌人", assetType: "enemy", count: 4 };

const svc = new PromptAssistantService();
const results: string[] = [];
const check = (name: string, cond: boolean) => {
  results.push(`${cond ? "PASS" : "FAIL"} - ${name}`);
};

function run(content: string, fields?: PromptAssistantFields): Promise<PromptAssistantResult> {
  (globalThis as unknown as { __CANON__: string }).__CANON__ = content;
  const settings = { ...base, fields: fields ? { ...fields } : { ...DEFAULT_PROMPT_ASSISTANT_FIELDS } };
  return svc.generate(settings, { ...input, fields: settings.fields });
}

async function main(): Promise<void> {
  // 1) 全开：四个字段都在 prompt 里，且解析正常
  let r = await run('{"description":"d","detailPrompt":"dp","cellNames":["a","b"],"style":"s"}');
  check("全开：四字段解析正确", r.description === "d" && r.detailPrompt === "dp" && r.cellNames.length === 2 && r.style === "s");
  check("全开：prompt 含全部四字段", ['"description"', '"detailPrompt"', '"cellNames"', '"style"'].every((k) => lastSystem().includes(k)));
  check("已移除：prompt 不含 stylePreset 指令", !lastSystem().includes("stylePreset"));

  // 2) 字段开关：只开 style -> prompt 只含 style
  await run('{"style":"s"}', { description: false, detailPrompt: false, cellNames: false, style: true });
  check("只开 style：prompt 含 style", lastSystem().includes('"style"'));
  check("只开 style：prompt 不含 description", !lastSystem().includes('"description"'));
  check("只开 style：prompt 不含 detailPrompt", !lastSystem().includes('"detailPrompt"'));
  check("只开 style：prompt 不含 cellNames", !lastSystem().includes('"cellNames"'));

  // 3) 字段开关：只开 cellNames
  r = await run('{"cellNames":["a"]}', { description: false, detailPrompt: false, cellNames: true, style: false });
  check("只开 cellNames：prompt 含 cellNames", lastSystem().includes('"cellNames"'));
  check("只开 cellNames：prompt 不含 style", !lastSystem().includes('"style"'));
  check("只开 cellNames：解析出 1 个名称", r.cellNames.length === 1);

  // 4) 只开 description
  await run('{"description":"d"}', { description: true, detailPrompt: false, cellNames: false, style: false });
  check("只开 description：prompt 含 description", lastSystem().includes('"description"'));
  check("只开 description：prompt 不含 cellNames", !lastSystem().includes('"cellNames"'));

  // 5) 全关 -> 兜底为全开（不产出空 JSON 模板）
  await run('{"description":"d"}', { description: false, detailPrompt: false, cellNames: false, style: false });
  check("全关：兜底为全开（含 description）", lastSystem().includes('"description"'));

  // 6) 模型未按 JSON 返回 -> parsed=false + raw 回传（复制粘贴兜底）
  r = await run("这不是 JSON，只是一段解释文字");
  check("非 JSON：parsed=false 且带回 raw", r.parsed === false && r.raw.includes("这不是 JSON"));

  // 7) cellNames 缺省时按 count 兜底命名
  r = await run('{"description":"d"}');
  check("cellNames 缺省：按 count=4 生成 素材1..4", r.cellNames.length === 4 && r.cellNames[0] === "素材1");

  console.log(results.join("\n"));
  console.log(results.every((x) => x.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
}

void main();
